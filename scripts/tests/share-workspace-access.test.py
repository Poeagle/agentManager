import importlib.util,os,pathlib,stat,tempfile,unittest
spec=importlib.util.spec_from_file_location('sharing',pathlib.Path(__file__).parents[1]/'share-workspace-access.py');sharing=importlib.util.module_from_spec(spec);spec.loader.exec_module(sharing)
class WorkspaceSharing(unittest.TestCase):
 def test_owner_and_peer_get_equal_rights_without_making_plain_files_executable(self):
  result=sharing.shared_acl('user::rw-\ngroup::---\nother::---\n',os.getuid(),[os.getuid(),424242],mode=0o600)
  self.assertIn('user::rw-',result);self.assertIn('user:424242:rw-',result);self.assertIn('other::---',result)
 def test_preserves_git_style_readonly_files_and_requires_equal_effective_permissions(self):
  result=sharing.shared_acl('user::r--\ngroup::r--\nother::r--\n',os.getuid(),[os.getuid(),424242],mode=0o444)
  self.assertIn('user::r--',result);self.assertIn('user:424242:r--',result)
  self.assertTrue(sharing.has_shared_access(result,os.getuid(),[os.getuid(),424242],4))
  self.assertFalse(sharing.has_shared_access('user::r--\nuser:424242:rw-\ngroup::---\nmask::rw-\nother::---\n',os.getuid(),[os.getuid(),424242],4))
 def test_mask_expansion_does_not_enable_old_other_user_rights(self):
  result=sharing.shared_acl('user::rw-\nuser:424243:rwx\ngroup::rwx\nmask::r--\nother::---\n',os.getuid(),[os.getuid(),424242],mode=0o640)
  self.assertIn('user:424243:r--',result);self.assertIn('group::r--',result);self.assertIn('user:424242:rw-',result)
 def test_apply_inherits_access_skips_outside_symlinks_and_restores_original_acls(self):
  with tempfile.TemporaryDirectory() as directory:
   base=pathlib.Path(directory);root=base/'workspace';root.mkdir();inside=root/'source.txt';inside.write_text('content');inside.chmod(0o600)
   outside=base/'private';outside.write_text('outside');outside.chmod(0o600);(root/'external').symlink_to(outside)
   acl=sharing.ACL();fd=sharing.open_entry(inside,inside.stat());before=acl.read(fd);os.close(fd)
   count,errors=sharing.apply(root,[os.getuid(),424242],base/'backup');self.assertEqual(errors,[]);self.assertEqual(count,2);self.assertEqual(sharing.audit(root,[os.getuid(),424242]),(2,0))
   fd=sharing.open_entry(inside,inside.stat());self.assertIn('user:424242:rw-',acl.read(fd));os.close(fd)
   fd=sharing.open_entry(root,root.stat());self.assertIn('user:424242:rwx',acl.read(fd,sharing.DEFAULT));os.close(fd)
   self.assertEqual(stat.S_IMODE(outside.stat().st_mode),0o600);self.assertEqual(inside.read_text(),'content')
   restored,errors=sharing.restore(base/'backup');self.assertEqual(errors,[]);self.assertEqual(restored,2)
   fd=sharing.open_entry(inside,inside.stat());self.assertEqual(acl.read(fd),before);os.close(fd)
if __name__=='__main__':unittest.main()
