import { FastifyPluginAsync, type FastifyRequest } from 'fastify';
import { readdir, stat, lstat, readFile, writeFile, rm, rename, cp, open, realpath } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, resolve, extname, dirname, basename, relative, isAbsolute, sep } from 'path';
import { execFile } from 'child_process';
import { userOwnsFilesystemPath, userOwnsProject } from '../auth.js';
import { getDb } from '../db/index.js';
import { createDirectoryExport } from '../services/file-export-process.js';
import { DocumentPreviewError, previewOfficeDocument, OFFICE_EXTENSIONS, SPREADSHEET_EXTENSIONS } from '../services/document-preview.js';

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif' };

function filePreviewType(extension: string): string {
  if (extension === 'pdf') return 'pdf';
  if (IMAGE_TYPES[extension]) return 'image';
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (['ppt', 'pptx', 'odp'].includes(extension)) return 'presentation';
  if (OFFICE_EXTENSIONS.has(extension)) return 'word';
  if (['csv', 'tsv'].includes(extension)) return 'csv';
  return 'text';
}

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension: string;
}

function attachmentHeader(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

interface ProjectFileScope { root: string; realRoot: string }

function withinDirectory(path: string, root: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

async function withinProjectScope(path: string, scope: ProjectFileScope): Promise<boolean> {
  const absolute = resolve(path);
  if (!withinDirectory(absolute, scope.root)) return false;
  try {
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch (error: any) {
      if (error.code !== 'ENOENT') return false;
      // A new upload/rename target may not exist, but its directory must.
      canonical = join(await realpath(dirname(absolute)), basename(absolute));
    }
    return withinDirectory(canonical, scope.realRoot);
  } catch {
    return false;
  }
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  const projectScopes = new WeakMap<FastifyRequest, ProjectFileScope>();
  // Scoped to the file API; upload raw bytes without base64 expansion.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addHook('preHandler', async (req, reply) => {
    const query = (req.query || {}) as Record<string, unknown>;
    const body = (req.body || {}) as Record<string, unknown>;
    const paths = [query.path, body.path, body.pathA, body.pathB, body.src, body.destDir]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    // Project explorers carry their project id; the server, not the browser,
    // determines the root. Even administrators cannot escape this view's root.
    // Unscoped clients (e.g. the existing global skills viewer) keep their own access rules.
    if (query.project_id !== undefined) {
      if (typeof query.project_id !== 'string' || !userOwnsProject(req.user!.id, query.project_id)) {
        return reply.status(403).send({ error: 'Project access denied' });
      }
      const project = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(query.project_id) as { path: string } | undefined;
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      let scope: ProjectFileScope;
      try { scope = { root: resolve(project.path), realRoot: await realpath(project.path) }; }
      catch { return reply.status(404).send({ error: 'Project directory not found' }); }
      projectScopes.set(req, scope);
      const checkedPaths = [...paths];
      if (typeof body.path === 'string' && typeof body.newName === 'string') checkedPaths.push(join(dirname(resolve(body.path)), body.newName));
      if (typeof body.src === 'string' && typeof body.destDir === 'string') checkedPaths.push(join(body.destDir, basename(body.src)));
      if (typeof query.path === 'string' && typeof query.filename === 'string') checkedPaths.push(join(query.path, query.filename));
      for (const path of checkedPaths) {
        if (!(await withinProjectScope(path, scope))) {
          return reply.status(403).send({ error: '只能访问当前项目目录及其子目录' });
        }
      }
      const source = typeof body.path === 'string' ? body.path : body.src;
      if (typeof source === 'string' && resolve(source) === scope.root
        && ['/files/delete', '/files/rename', '/files/move'].some(route => req.routeOptions.url?.endsWith(route))) {
        return reply.status(403).send({ error: '不能删除、重命名或移动项目根目录' });
      }
    }
    if (paths.some((path) => !userOwnsFilesystemPath(req.user!.id, path))) {
      return reply.status(403).send({ error: 'Path is outside your assigned projects' });
    }
  });

  app.post<{
    Querystring: { path: string; filename: string };
    Body: Buffer;
  }>('/files/upload', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const { path: directory, filename } = req.query;
    if (typeof directory !== 'string' || !directory) {
      return reply.status(400).send({ error: 'Upload directory is required' });
    }
    if (typeof filename !== 'string' || !filename.trim() || filename === '.' || filename === '..'
      || /[\\/\x00-\x1f\x7f]/.test(filename)) {
      return reply.status(400).send({ error: 'Invalid filename' });
    }
    if (!Buffer.isBuffer(req.body)) {
      return reply.status(400).send({ error: 'Expected binary file content' });
    }

    try {
      const targetDirectory = await realpath(resolve(directory));
      if (!(await stat(targetDirectory)).isDirectory()) {
        return reply.status(400).send({ error: 'Upload path is not a directory' });
      }
      const target = join(targetDirectory, filename);
      if (!userOwnsFilesystemPath(req.user!.id, target)) {
        return reply.status(403).send({ error: 'Path is outside your assigned projects' });
      }
      // Exclusive creation also rejects existing symlinks and concurrent uploads.
      const handle = await open(target, 'wx', 0o600);
      try {
        await handle.writeFile(req.body);
      } catch (error) {
        await rm(target).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      return { ok: true, path: target, size: req.body.length };
    } catch (error: any) {
      if (error.code === 'EEXIST') return reply.status(409).send({ error: '同名文件已存在，未覆盖；请重命名后上传' });
      if (error.code === 'ENOENT') return reply.status(404).send({ error: 'Upload directory not found' });
      if (error.code === 'ENOTDIR') return reply.status(400).send({ error: 'Upload path is not a directory' });
      if (error.code === 'EACCES' || error.code === 'EPERM') return reply.status(403).send({ error: 'Permission denied' });
      return reply.status(500).send({ error: 'Failed to upload file' });
    }
  });

  // List directory contents
  app.get<{
    Querystring: { path: string; showHidden?: string };
  }>('/files', async (req, reply) => {
    const dirPath = req.query.path;
    if (!dirPath) return reply.status(400).send({ error: 'path query parameter is required' });
    const showHidden = req.query.showHidden === 'true';

    const resolved = resolve(dirPath);

    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const files: FileEntry[] = [];

      for (const entry of entries) {
        // Skip hidden files/dirs starting with . (unless showHidden)
        if (!showHidden && entry.name.startsWith('.')) continue;
        // Always skip .git internals and node_modules
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        try {
          const fullPath = join(resolved, entry.name);
          const scope = projectScopes.get(req);
          if (scope && !(await withinProjectScope(fullPath, scope))) continue;
          const stats = await stat(fullPath);
          files.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            extension: entry.isDirectory() ? '' : extname(entry.name).slice(1),
          });
        } catch {
          // Skip files we can't stat (permission errors, etc.)
        }
      }

      // Sort: directories first, then alphabetical
      files.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { path: resolved, files };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'Directory not found' });
      if (err.code === 'ENOTDIR') return reply.status(400).send({ error: 'Path is not a directory' });
      return reply.status(500).send({ error: 'Failed to read directory' });
    }
  });

  // Read file contents (for the file viewer)
  app.get<{
    Querystring: { path: string };
  }>('/files/read', async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.status(400).send({ error: 'path query parameter is required' });

    const resolved = resolve(filePath);

    try {
      const stats = await stat(resolved);
      if (!stats.isFile()) return reply.status(400).send({ error: 'Path is not a file' });
      const ext = extname(resolved).slice(1).toLowerCase();
      const kind = filePreviewType(ext);
      if (kind !== 'text' && kind !== 'csv') {
        return { path: resolved, content: '', extension: ext, size: stats.size, previewType: kind };
      }
      if (stats.size > 5 * 1024 * 1024) {
        return reply.status(413).send({ error: 'Text preview too large (max 5MB)' });
      }

      const bytes = await readFile(resolved);
      let content: string;
      try {
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
        content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        return reply.status(415).send({ error: '无法按 UTF-8 / UTF-16 文本读取此文件，请下载后查看' });
      }
      if (content.includes('\0')) {
        return reply.status(415).send({ error: '此二进制文件暂不支持预览，请下载后查看' });
      }
      const previewType = ext === 'drawio' || /^\s*(?:<\?xml[^>]*>\s*)?<(?:mxfile|mxGraphModel)(?:\s|>)/.test(content) ? 'drawio' : kind;

      return { path: resolved, content, extension: ext, size: stats.size, previewType };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'File not found' });
      return reply.status(500).send({ error: 'Failed to read file' });
    }
  });

  // Binary previews use the same project boundary and user authorization hook.
  app.get<{ Querystring: { path: string } }>('/files/preview', async (req, reply) => {
    if (!req.query.path) return reply.status(400).send({ error: 'path is required' });
    const path = resolve(req.query.path);
    const extension = extname(path).slice(1).toLowerCase();
    if (extension !== 'pdf' && !OFFICE_EXTENSIONS.has(extension) && !IMAGE_TYPES[extension]) return reply.status(415).send({ error: 'Unsupported document preview' });
    try {
      const info = await stat(path);
      if (!info.isFile()) return reply.status(400).send({ error: 'Path is not a file' });
      const office = OFFICE_EXTENSIONS.has(extension);
      if (info.size > (office ? 20 : 50) * 1024 * 1024) {
        return reply.status(413).send({ error: office ? 'Office 预览最大支持 20 MB' : '预览最大支持 50 MB' });
      }
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      const spreadsheet = SPREADSHEET_EXTENSIONS.has(extension);
      reply.header('Content-Type', IMAGE_TYPES[extension] || (spreadsheet ? 'text/html; charset=utf-8' : 'application/pdf'));
      reply.header('Content-Disposition', attachmentHeader(basename(path)));
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      if (!office) return reply.send(createReadStream(path));
      const document = await previewOfficeDocument(await readFile(path), extension);
      return reply.send(document);
    } catch (error: any) {
      reply.removeHeader('Content-Type');
      reply.removeHeader('Content-Disposition');
      if (error instanceof DocumentPreviewError) return reply.status(error.statusCode).send({ error: error.message });
      if (error.code === 'ENOENT') return reply.status(404).send({ error: 'File not found' });
      return reply.status(500).send({ error: 'Failed to preview document' });
    }
  });

  // Export a file as-is or stream a portable ZIP for a directory. Symlinks and
  // special files are intentionally skipped by streamDirectoryZip.
  app.get<{
    Querystring: { path: string };
  }>('/files/export', async (req, reply) => {
    const targetPath = req.query.path;
    if (!targetPath) return reply.status(400).send({ error: 'path query parameter is required' });

    const resolved = resolve(targetPath);
    let stats;
    try {
      stats = await lstat(resolved);
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'Path not found' });
      return reply.status(500).send({ error: 'Failed to inspect export path' });
    }

    if (stats.isFile()) {
      const fileName = basename(resolved);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', stats.size);
      reply.header('Content-Disposition', attachmentHeader(fileName));
      reply.header('Cache-Control', 'no-store');
      return reply.send(createReadStream(resolved));
    }

    if (!stats.isDirectory()) {
      return reply.status(400).send({ error: 'Only files and directories can be exported' });
    }

    const directoryName = basename(resolved) || 'export';
    const directoryExport = createDirectoryExport(resolved);
    const cancelExport = () => directoryExport.cancel();
    reply.raw.once('close', cancelExport);

    let exportReady;
    try {
      exportReady = await directoryExport.ready;
    } catch (error) {
      reply.raw.removeListener('close', cancelExport);
      if (reply.raw.destroyed) return reply;
      const message = error instanceof Error ? error.message : 'Failed to create directory export';
      return reply.status(500).send({ error: message });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', attachmentHeader(`${directoryName}.zip`));
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Export-Estimated-Size', exportReady.estimatedSize);
    reply.header('X-Export-Source-Bytes', exportReady.sourceBytes);
    reply.header('X-Export-Entry-Count', exportReady.entryCount);
    return reply.send(exportReady.stream);
  });

  // Write file contents
  app.put<{
    Body: { path: string; content: string; expectedContent?: string };
  }>('/files/write', async (req, reply) => {
    const { path: filePath, content, expectedContent } = req.body || {};
    if (!filePath) return reply.status(400).send({ error: 'path is required' });
    if (typeof content !== 'string') return reply.status(400).send({ error: 'content is required' });

    const resolved = resolve(filePath);

    try {
      // Verify file exists (won't create new files)
      await stat(resolved);
      if (expectedContent !== undefined) {
        if (typeof expectedContent !== 'string') return reply.status(400).send({ error: 'expectedContent must be a string' });
        const currentContent = await readFile(resolved, 'utf-8');
        if (currentContent !== expectedContent) {
          return reply.status(409).send({ error: 'File changed on disk; reload it before saving' });
        }
      }
      await writeFile(resolved, content, 'utf-8');
      const newStats = await stat(resolved);
      return { ok: true, size: newStats.size };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'File not found' });
      return reply.status(500).send({ error: 'Failed to write file' });
    }
  });

  // Diff two files (unified diff output)
  app.post<{
    Body: { pathA: string; pathB: string };
  }>('/files/diff', async (req, reply) => {
    const { pathA, pathB } = req.body || {};
    if (!pathA || !pathB) return reply.status(400).send({ error: 'pathA and pathB are required' });

    const resolvedA = resolve(pathA);
    const resolvedB = resolve(pathB);

    // Verify both files exist
    try { await stat(resolvedA); } catch { return reply.status(404).send({ error: `File not found: ${pathA}` }); }
    try { await stat(resolvedB); } catch { return reply.status(404).send({ error: `File not found: ${pathB}` }); }

    return new Promise((resolvePromise) => {
      // Use -U3 for 3-line context (default) and histogram algorithm for better hunk splitting.
      // git diff --no-index exits 1 when files differ — that's not an error.
      execFile(
        'git',
        ['diff', '--no-index', '-U1', '--diff-algorithm=histogram', '--', resolvedA, resolvedB],
        { maxBuffer: 5 * 1024 * 1024 },
        (err, stdout) => {
          // Exit code 1 = files differ (normal), 0 = identical
          if (err && err.code !== 1) {
            // Fallback to diff -u if git not available
            execFile(
              'diff',
              ['-u', resolvedA, resolvedB],
              { maxBuffer: 5 * 1024 * 1024 },
              (err2, stdout2) => {
                reply.send({ diff: stdout2 || '' });
                resolvePromise(undefined);
              }
            );
            return;
          }
          reply.send({ diff: stdout || '' });
          resolvePromise(undefined);
        }
      );
    });
  });

  // Delete a file or directory (recursive for directories)
  app.post<{
    Body: { path: string };
  }>('/files/delete', async (req, reply) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath) return reply.status(400).send({ error: 'path is required' });
    const resolved = resolve(targetPath);

    try {
      await stat(resolved);
    } catch {
      return reply.status(404).send({ error: 'Path not found' });
    }

    try {
      await rm(resolved, { recursive: true, force: false });
      return { ok: true };
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return reply.status(403).send({ error: 'Permission denied', detail: err.message });
      }
      return reply.status(500).send({ error: 'Failed to delete', detail: err.message });
    }
  });

  // Rename a file or directory in place (sibling rename only)
  app.post<{
    Body: { path: string; newName: string };
  }>('/files/rename', async (req, reply) => {
    const { path: targetPath, newName } = req.body || {};
    if (!targetPath) return reply.status(400).send({ error: 'path is required' });
    if (!newName || typeof newName !== 'string') return reply.status(400).send({ error: 'newName is required' });
    if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      return reply.status(400).send({ error: 'Invalid name (must not contain path separators)' });
    }

    const resolvedSrc = resolve(targetPath);
    const dest = join(dirname(resolvedSrc), newName);

    try {
      await stat(resolvedSrc);
    } catch {
      return reply.status(404).send({ error: 'Source not found' });
    }

    // Refuse if destination already exists (prevent silent overwrite)
    try {
      await stat(dest);
      return reply.status(409).send({ error: 'A file or folder with that name already exists' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return reply.status(500).send({ error: 'Failed to check destination', detail: err.message });
      }
    }

    try {
      await rename(resolvedSrc, dest);
      return { ok: true, path: dest };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to rename', detail: err.message });
    }
  });

  // Move a file or directory (cut + paste). Falls back to copy+delete across volumes.
  app.post<{
    Body: { src: string; destDir: string };
  }>('/files/move', async (req, reply) => {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return reply.status(400).send({ error: 'src and destDir are required' });

    const resolvedSrc = resolve(src);
    const resolvedDestDir = resolve(destDir);
    const dest = join(resolvedDestDir, basename(resolvedSrc));

    if (resolvedSrc === dest) {
      return reply.status(400).send({ error: 'Source and destination are the same' });
    }
    // Prevent moving a directory into itself or its descendants
    if (resolvedDestDir === resolvedSrc || resolvedDestDir.startsWith(resolvedSrc + '/')) {
      return reply.status(400).send({ error: 'Cannot move a folder into itself' });
    }

    try {
      await stat(resolvedSrc);
    } catch {
      return reply.status(404).send({ error: 'Source not found' });
    }
    try {
      const ds = await stat(resolvedDestDir);
      if (!ds.isDirectory()) return reply.status(400).send({ error: 'Destination is not a directory' });
    } catch {
      return reply.status(404).send({ error: 'Destination directory not found' });
    }
    try {
      await stat(dest);
      return reply.status(409).send({ error: 'A file or folder with that name already exists at the destination' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return reply.status(500).send({ error: 'Failed to check destination', detail: err.message });
      }
    }

    try {
      await rename(resolvedSrc, dest);
      return { ok: true, path: dest };
    } catch (err: any) {
      // Cross-device — fall back to copy + delete
      if (err.code === 'EXDEV') {
        try {
          await cp(resolvedSrc, dest, { recursive: true, errorOnExist: true, force: false });
          await rm(resolvedSrc, { recursive: true, force: false });
          return { ok: true, path: dest };
        } catch (err2: any) {
          return reply.status(500).send({ error: 'Failed to move across volumes', detail: err2.message });
        }
      }
      return reply.status(500).send({ error: 'Failed to move', detail: err.message });
    }
  });

  // Copy a file or directory (recursive). Refuses to overwrite existing destination.
  app.post<{
    Body: { src: string; destDir: string };
  }>('/files/copy', async (req, reply) => {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return reply.status(400).send({ error: 'src and destDir are required' });

    const resolvedSrc = resolve(src);
    const resolvedDestDir = resolve(destDir);
    const dest = join(resolvedDestDir, basename(resolvedSrc));

    if (resolvedSrc === dest) {
      return reply.status(400).send({ error: 'Source and destination are the same' });
    }
    // Prevent copying a directory into itself or its descendants
    if (resolvedDestDir === resolvedSrc || resolvedDestDir.startsWith(resolvedSrc + '/')) {
      return reply.status(400).send({ error: 'Cannot copy a folder into itself' });
    }

    try {
      await stat(resolvedSrc);
    } catch {
      return reply.status(404).send({ error: 'Source not found' });
    }
    try {
      const ds = await stat(resolvedDestDir);
      if (!ds.isDirectory()) return reply.status(400).send({ error: 'Destination is not a directory' });
    } catch {
      return reply.status(404).send({ error: 'Destination directory not found' });
    }
    try {
      await stat(dest);
      return reply.status(409).send({ error: 'A file or folder with that name already exists at the destination' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return reply.status(500).send({ error: 'Failed to check destination', detail: err.message });
      }
    }

    try {
      await cp(resolvedSrc, dest, { recursive: true, errorOnExist: true, force: false });
      return { ok: true, path: dest };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to copy', detail: err.message });
    }
  });

};
