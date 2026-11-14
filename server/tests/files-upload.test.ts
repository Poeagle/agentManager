import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import {execFileSync} from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import {projectUploadDirectory} from '../src/services/attachment-storage.js';
import { getDb } from '../src/db/index.js';
import { fileRoutes } from '../src/routes/files.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let cookie: string;
let project: string;
let outside: string;

beforeEach(async () => {
  const database = createTestDatabase();
  cleanup = database.cleanup;
  project = join(database.dir, 'project');
  outside = join(database.dir, 'outside');
  mkdirSync(join(project, 'reports'), { recursive: true });
  mkdirSync(outside);
  const user = createUser({ username: 'owner', password: 'password1' });
  cookie = `agentmanager_session=${createSession(user.id)}`;
  getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
    .run('project-1', 'Project', project, user.id);
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(fileRoutes, { prefix: '/api' });
});

afterEach(async () => {
  await app.close();
  cleanup();
});

function upload(path: string, filename: string, payload = Buffer.from([0, 1, 255, 128])) {
  return app.inject({
    method: 'POST',
    url: `/api/files/upload?path=${encodeURIComponent(path)}&filename=${encodeURIComponent(filename)}`,
    headers: { cookie, 'content-type': 'application/octet-stream' },
    payload,
  });
}

function destination(directory:string,name:string){return join(projectUploadDirectory(project),relative(project,directory),name);}

describe('file upload API', () => {
  it('keeps a Git project unchanged when uploading folders and previews the central copy',async()=>{
    execFileSync('git',['init','--quiet',project]);
    writeFileSync(join(project,'tracked.txt'),'original');
    execFileSync('git',['-c','safe.directory='+project,'-C',project,'add','tracked.txt']);
    const gitStatus=()=>execFileSync('git',['-c','safe.directory='+project,'-C',project,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'});
    const before=gitStatus();
    const create=(relative_path:string)=>app.inject({method:'POST',url:'/api/files/upload-directory?project_id=project-1',headers:{cookie},payload:{path:project,relative_path}});
    const created=await create('folder/nested');expect(created.statusCode).toBe(200);
    const uploaded=await upload(created.json().path,'note.txt',Buffer.from('central content'));
    expect(uploaded.statusCode).toBe(200);expect(uploaded.json().path.startsWith(project+'/')).toBe(false);
    expect((await app.inject({url:'/api/files/read?'+new URLSearchParams({project_id:'project-1',path:uploaded.json().path}),headers:{cookie}})).json().content).toBe('central content');
    expect((await create('../escape')).statusCode).toBe(400);
    expect(gitStatus()).toBe(before);expect(existsSync(join(project,'folder'))).toBe(false);
    expect((await upload(project,'tracked.txt',Buffer.from('uploaded'))).statusCode).toBe(200);
    expect(readFileSync(join(project,'tracked.txt'),'utf8')).toBe('original');expect(gitStatus()).toBe(before);
  });
  it('creates folder hierarchies and empty directories without overwriting existing paths', async()=>{
    const create=(path:string)=>app.inject({method:'POST',url:'/api/files/directory?project_id=project-1',headers:{cookie},payload:{path}});
    const root=join(project,'资料');
    expect((await create(root)).json()).toEqual({ok:true,created:true});
    expect((await create(join(root,'空文件夹'))).statusCode).toBe(200);
    expect((await create(root)).json()).toEqual({ok:true,created:false});
    expect((await upload(root,'note.txt',Buffer.from('keep'))).statusCode).toBe(200);
    expect((await create(join(root,'note.txt'))).statusCode).toBe(200);
    expect(readFileSync(destination(root,'note.txt'),'utf8')).toBe('keep');
    expect((await create(outside+'/escape')).statusCode).toBe(403);
    symlinkSync(outside,join(project,'unsafe'));
    expect((await create(join(project,'unsafe','escape'))).statusCode).toBe(403);
  });

  it('returns actual filesystem modification times for sorting',async()=>{
    writeFileSync(join(project,'time.txt'),'data');
    const response=await app.inject({url:`/api/files?path=${encodeURIComponent(project)}`,headers:{cookie}});
    const entry=response.json().files.find((file:{name:string})=>file.name==='time.txt');
    expect(Number.isFinite(Date.parse(entry.modified_at))).toBe(true);
  });
  it('saves binary bytes with the original Unicode filename in platform storage outside the requested project', async () => {
    const payload = Buffer.from([0, 1, 255, 128]);
    const response = await upload(join(project, 'reports'), '报表 & 数据.png', payload);
    const target = destination(join(project,'reports'),'报表 & 数据.png');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, path: target, size: payload.length });
    expect(readFileSync(target)).toEqual(payload);
    expect(existsSync(join(project, '报表 & 数据.png'))).toBe(false);
  });

  it('accepts empty files and files larger than the default 1 MB parser limit', async () => {
    expect((await upload(project, 'empty.txt', Buffer.alloc(0))).statusCode).toBe(200);
    expect(readFileSync(destination(project,'empty.txt')).length).toBe(0);
    const payload = Buffer.alloc(2 * 1024 * 1024, 42);
    expect((await upload(project, 'data.bin', payload)).statusCode).toBe(200);
    expect(readFileSync(destination(project,'data.bin')).equals(payload)).toBe(true);
  });

  it('never overwrites existing files or directories', async () => {
    writeFileSync(join(project, 'keep.txt'), 'original');
    expect((await upload(project, 'keep.txt')).statusCode).toBe(200);
    expect((await upload(project, 'keep.txt')).statusCode).toBe(409);
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('original');
    expect((await upload(project, 'reports')).statusCode).toBe(200);
  });

  it('allows only one concurrent upload to create the same name', async () => {
    const responses = await Promise.all([upload(project, 'same.bin'), upload(project, 'same.bin')]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
  });

  it.each([['',400],['..',400],['.',400],['../escape.txt',400],['/absolute.txt',400],['sub/file.txt',400],['sub\\file.txt',400],['bad\0.txt',400]] as const)('rejects unsafe filename %j', async (filename,status) => {
    expect((await upload(project, filename)).statusCode).toBe(status);
  });

  it('rejects uploads outside assigned projects and symlink escapes', async () => {
    expect((await upload(outside, 'new.txt')).statusCode).toBe(403);
    symlinkSync(outside, join(project, 'escape'));
    expect((await upload(join(project, 'escape'), 'new.txt')).statusCode).toBe(403);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(project, 'secret-link'));
    expect((await upload(project, 'secret-link')).statusCode).toBe(200);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('does not follow an existing symlink within the project', async () => {
    writeFileSync(join(project, 'keep.txt'), 'original');
    symlinkSync(join(project, 'keep.txt'), join(project, 'link.txt'));
    expect((await upload(project, 'link.txt')).statusCode).toBe(200);
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('respects separately assigned nested project boundaries', async () => {
    getDb().prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run('nested', 'Private nested project', join(project, 'reports'));
    expect((await upload(join(project, 'reports'), 'private.txt')).statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    cookie = '';
    expect((await upload(project, 'new.txt')).statusCode).toBe(401);
  });

  it('rejects a missing path, nonexistent directory, or file used as a directory', async () => {
    expect((await upload('', 'new.txt')).statusCode).toBe(400);
    expect((await upload(join(project, 'missing'), 'new.txt')).statusCode).toBe(404);
    writeFileSync(join(project, 'file.txt'), 'not a directory');
    expect((await upload(join(project, 'file.txt'), 'new.txt')).statusCode).toBe(400);
  });

  it('enforces the 50 MB request limit before writing a file', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/files/upload?path=${encodeURIComponent(project)}&filename=huge.bin`,
      headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': String(50 * 1024 * 1024 + 1) },
      payload: Buffer.from('x'),
    });
    expect(response.statusCode).toBe(413);
    expect(existsSync(join(project, 'huge.bin'))).toBe(false);
  });
});
