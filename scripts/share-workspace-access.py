#!/usr/bin/env python3
"""Share the workspace with two Unix users using backed-up POSIX ACLs.

Default is a read-only audit. --apply changes permissions, never ownership or
file content. Symlinks and special files are skipped. Run --restore BACKUP to
restore the recorded ACLs. Explicit chmod(0600) and moves from outside can still
restrict future files; rerun the audit after such operations.
"""
import argparse, ctypes, gzip, json, os, pathlib, pwd, stat, time

ROOT = pathlib.Path('/home/xlli/ymchen')
ACCESS, DEFAULT = 0x8000, 0x4000

class ACL:
    def __init__(self):
        self.lib = ctypes.CDLL('libacl.so.1', use_errno=True)
        for name, arguments, result in [
            ('acl_get_fd', [ctypes.c_int], ctypes.c_void_p),
            ('acl_set_fd', [ctypes.c_int, ctypes.c_void_p], ctypes.c_int),
            ('acl_get_file', [ctypes.c_char_p, ctypes.c_int], ctypes.c_void_p),
            ('acl_set_file', [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p], ctypes.c_int),
            ('acl_delete_def_file', [ctypes.c_char_p], ctypes.c_int),
            ('acl_to_text', [ctypes.c_void_p, ctypes.c_void_p], ctypes.c_void_p),
            ('acl_from_text', [ctypes.c_char_p], ctypes.c_void_p),
            ('acl_free', [ctypes.c_void_p], ctypes.c_int),
        ]:
            function = getattr(self.lib, name); function.argtypes = arguments; function.restype = result

    def text(self, value):
        if not value: raise OSError(ctypes.get_errno(), 'Unable to read ACL')
        text = self.lib.acl_to_text(value, None)
        try:
            if not text: raise OSError(ctypes.get_errno(), 'Unable to serialize ACL')
            return ctypes.string_at(text).decode()
        finally:
            if text: self.lib.acl_free(text)
            self.lib.acl_free(value)

    def read(self, fd, kind=ACCESS):
        return self.text(self.lib.acl_get_fd(fd) if kind == ACCESS else self.lib.acl_get_file(f'/proc/self/fd/{fd}'.encode(), kind))

    def write(self, fd, text, kind=ACCESS):
        target = f'/proc/self/fd/{fd}'.encode()
        if kind == DEFAULT and not text.strip():
            if self.lib.acl_delete_def_file(target): raise OSError(ctypes.get_errno(), 'Unable to remove default ACL')
            return
        value = self.lib.acl_from_text(text.encode())
        if not value: raise OSError(ctypes.get_errno(), 'Invalid ACL')
        try:
            result = self.lib.acl_set_fd(fd, value) if kind == ACCESS else self.lib.acl_set_file(target, kind, value)
            if result: raise OSError(ctypes.get_errno(), 'Unable to update ACL')
        finally: self.lib.acl_free(value)


def bits(value):
    return sum(flag for character, flag in zip(value, [4, 2, 1]) if character != '-')


def permissions(value):
    return ''.join(character if value & flag else '-' for character, flag in [('r', 4), ('w', 2), ('x', 1)])


def parse_acl(text):
    entries = {}
    for line in text.splitlines():
        line = line.split('#')[0].strip()
        if not line: continue
        kind, who, value = line.split(':')
        if kind == 'user' and who and not who.isdigit(): who = str(pwd.getpwnam(who).pw_uid)
        entries[(kind, who)] = bits(value)
    return entries


def shared_acl(text, owner, users, directory=False, mode=0o600, default=False):
    entries = parse_acl(text)
    if not entries:
        entries = {('user', ''): (mode >> 6) & 7, ('group', ''): (mode >> 3) & 7, ('other', ''): mode & 7}
    old_mask = entries.get(('mask', ''), 7)
    # Expanding the mask must not activate previously masked rights of others.
    for key in list(entries):
        if key[0] == 'group' or key[0] == 'user' and key[1]: entries[key] &= old_mask
    needed = 7 if directory or default else (mode >> 6) & 7
    for uid in users: entries[('user', str(uid))] = needed
    if default or owner in users: entries[('user', '')] = needed
    mask = needed
    for key, value in entries.items():
        if key[0] == 'group' or key[0] == 'user' and key[1]: mask |= value
    entries[('mask', '')] = mask
    return ''.join(f'{kind}:{who}:{permissions(value)}\n' for (kind, who), value in entries.items())


def walk(root):
    stack = [root]
    while stack:
        path = stack.pop()
        try: info = path.lstat()
        except FileNotFoundError: continue
        if stat.S_ISLNK(info.st_mode): continue
        if stat.S_ISDIR(info.st_mode):
            yield path, info
            with os.scandir(path) as entries: stack.extend(pathlib.Path(item.path) for item in entries)
        elif stat.S_ISREG(info.st_mode): yield path, info


def open_entry(path, info):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(info.st_mode) else 0))
    actual = os.fstat(fd)
    if (info.st_dev, info.st_ino) != (actual.st_dev, actual.st_ino): os.close(fd); raise OSError('Entry changed while applying ACL')
    return fd


def apply(root, users, backup):
    acl = ACL(); changed = 0; errors = []; seen = set()
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    (backup/'manifest.json').write_text(json.dumps({'root':str(root),'users':users,'created':time.time()}))
    with gzip.open(backup/'acls.jsonl.gz', 'wt') as records:
        for path, info in walk(root):
            identity = (info.st_dev, info.st_ino)
            if identity in seen: continue
            seen.add(identity)
            try:
                fd = open_entry(path, info)
                try:
                    directory = stat.S_ISDIR(info.st_mode)
                    old = acl.read(fd); old_default = acl.read(fd, DEFAULT) if directory else ''
                    desired = shared_acl(old, info.st_uid, users, directory, info.st_mode)
                    new_default = shared_acl(old_default, info.st_uid, users, True, info.st_mode, True) if directory else ''
                    # Flush each record before changing its inode, including on interruption.
                    records.write(json.dumps({'path':str(path.relative_to(root)),'device':info.st_dev,'inode':info.st_ino,'access':old,'default':old_default,'directory':directory})+'\n'); records.flush()
                    acl.write(fd, desired)
                    if directory: acl.write(fd, new_default, DEFAULT)
                    changed += 1
                    if changed % 25000 == 0: print('Updated ACLs:', changed, flush=True)
                finally: os.close(fd)
            except OSError as error:
                errors.append({'path':str(path),'error':str(error)})
    (backup/'result.json').write_text(json.dumps({'updated':changed,'errors':errors},indent=2))
    return changed, errors


def restore(backup):
    manifest = json.loads((backup/'manifest.json').read_text()); root = pathlib.Path(manifest['root']); acl = ACL(); restored = 0; errors = []
    with gzip.open(backup/'acls.jsonl.gz', 'rt') as records:
        for line in records:
            item = json.loads(line); path = root/item['path']
            try:
                info = path.lstat()
                if path.is_symlink() or (info.st_dev, info.st_ino) != (item['device'], item['inode']): raise OSError('Entry replaced; refusing to alter a different inode')
                fd = open_entry(path, info)
                try:
                    acl.write(fd, item['access'])
                    if item['directory']: acl.write(fd, item['default'], DEFAULT)
                    restored += 1
                finally: os.close(fd)
            except OSError as error: errors.append({'path':str(path),'error':str(error)})
    return restored, errors



def has_shared_access(text, owner, users, needed):
    entries = parse_acl(text); mask = entries.get(('mask', ''), 7)
    for uid in users:
        if uid == owner: actual = entries.get(('user', ''), 0)
        elif ('user', str(uid)) in entries: actual = entries[('user', str(uid))] & mask
        else: actual = entries.get(('other', ''), 0)
        if actual != needed: return False
    return True


def audit(root, users):
    acl = ACL(); count = 0; restricted = 0
    for path, info in walk(root):
        count += 1
        try:
            fd = open_entry(path, info)
            try:
                directory = stat.S_ISDIR(info.st_mode)
                needed = 7 if directory else (info.st_mode >> 6) & 7
                good = has_shared_access(acl.read(fd), info.st_uid, users, needed)
                if directory: good = good and has_shared_access(acl.read(fd, DEFAULT), -1, users, 7)
                if not good: restricted += 1
            finally: os.close(fd)
        except OSError: restricted += 1
    return count, restricted


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--apply',action='store_true'); parser.add_argument('--restore',type=pathlib.Path); args=parser.parse_args()
    if args.restore:
        count, errors = restore(args.restore); print('Restored:',count,'Errors:',len(errors)); return int(bool(errors))
    users = [pwd.getpwnam(name).pw_uid for name in ['xlli','ymchen']]
    if ROOT.is_symlink(): raise SystemExit('Refusing a symlinked workspace root')
    if not args.apply:
        count, restricted = audit(ROOT, users); print('Read-only audit:',ROOT,'entries:',count,'not fully shared:',restricted,'users:',users); return int(bool(restricted))
    base = pathlib.Path.home()/'.local/state/octoally-permission-backups'; base.mkdir(parents=True,exist_ok=True,mode=0o700)
    backup = base/(time.strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid()))
    count, errors = apply(ROOT,users,backup)
    print('Updated:',count,'Errors:',len(errors),'Backup:',backup,flush=True)
    for error in errors[:10]: print(error)
    return int(bool(errors))

if __name__ == '__main__': raise SystemExit(main())
