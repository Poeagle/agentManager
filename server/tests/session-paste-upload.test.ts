import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import {userInfo} from 'os';
import {execFileSync} from 'child_process';
import {projectAttachmentDirectory} from '../src/services/attachment-storage.js';
import {fileRoutes} from '../src/routes/files.js';
import {sweepAllPastes} from '../src/services/paste-cleanup.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { prunePastesDir } from '../src/services/paste-cleanup.js';
import { createTestDatabase } from './helpers/database.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWv8AAAAASUVORK5CYII=', 'base64');

describe('session clipboard uploads', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let project: string;
  let ownerCookie: string;
  let otherCookie: string;

  beforeEach(async () => {
    const database = createTestDatabase();
    cleanup = database.cleanup;
    project = join(database.dir, 'project');
    mkdirSync(project);
    const owner = createUser({ username: 'paste-owner', password: 'password1' });
    const other = createUser({ username: 'paste-other', password: 'password2' });
    ownerCookie = `agentmanager_session=${createSession(owner.id)}`;
    otherCookie = `agentmanager_session=${createSession(other.id)}`;
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', project, owner.id);
    getDb().prepare(`INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('paste-session', 'project-1', 'Work', 'running', 'session', 'codex', ?)`).run(owner.id);
    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(sessionRoutes, { prefix: '/api' });
    await app.register(fileRoutes, { prefix: '/api' });
  });

  afterEach(async () => { await app.close(); cleanup(); });

  const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
  function upload(kind: 'image' | 'file', body: object, cookie = ownerCookie) {
    return app.inject({ method: 'POST', url: `/api/sessions/paste-session/paste-${kind}`, headers: { cookie }, payload: body });
  }

  it.skipIf(process.getuid?.()===0).each(['image','file'] as const)('identifies the actual service user when the platform attachment directory denies %s uploads',async kind=>{
    const directory=projectAttachmentDirectory(project,true);chmodSync(directory,0o500);
    try {
      const response=await upload(kind,kind==='image'?{dataUrl:dataUrl('image/png',png)}:{dataUrl:dataUrl('text/plain',Buffer.from('hello')),filename:'notes.txt'});
      expect(response.statusCode).toBe(500);expect(response.json().error).toContain('平台运行用户 '+userInfo().username);expect(response.json().error).toContain(directory);expect(response.json().error).toContain('目录读写权限');
    }finally{chmodSync(directory,0o700);}
  });

  it('saves pasted screenshots outside the project with unique names', async () => {
    const first = await upload('image', { dataUrl: dataUrl('image/png', png) });
    const second = await upload('image', { dataUrl: dataUrl('image/png', png) });
    expect(first.statusCode,first.body).toBe(200);
    expect(second.statusCode).toBe(200);
    const paths = [first.json().path, second.json().path] as string[];
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) {
      expect(relative(projectAttachmentDirectory(project), path)).toMatch(/^paste-[\w-]+\.png$/);
      expect(path.startsWith(project + '/')).toBe(false);
      expect(readFileSync(path)).toEqual(png);
    }
    expect(readdirSync(project)).toEqual([]);
  });

  it('rejects inaccessible sessions and invalid or oversized images', async () => {
    expect((await upload('image', { dataUrl: dataUrl('image/png', png) }, otherCookie)).statusCode).toBe(404);
    expect((await upload('image', { dataUrl: dataUrl('image/jpeg', png) })).statusCode).toBe(400);
    expect((await upload('image', { dataUrl: 'data:image/png;base64,%%%%' })).statusCode).toBe(400);
    const oversized = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload('image', { dataUrl: dataUrl('image/png', oversized) })).statusCode).toBe(413);
    expect(existsSync(join(project, '.agentmanager', 'pastes'))).toBe(false);
  });

  it('saves arbitrary pasted files with safe unique names', async () => {
    const body = { dataUrl: dataUrl('text/plain', Buffer.from('hello')), filename: '../notes.txt' };
    const response = await upload('file', body);
    expect(response.statusCode).toBe(200);
    expect(response.json().path).toMatch(/paste-[\w-]+-notes\.txt$/);
    expect(readFileSync(response.json().path, 'utf8')).toBe('hello');
    expect(readdirSync(projectAttachmentDirectory(project))).toHaveLength(1);
  });

  it('accepts a 100 MB file including its base64 request overhead', async () => {
    const bytes = Buffer.alloc(100 * 1024 * 1024, 42);
    const response = await upload('file', { dataUrl: dataUrl('application/zip', bytes), filename: 'large.zip' });
    expect(response.statusCode).toBe(200);
    expect(statSync(response.json().path).size).toBe(bytes.length);
    expect(readFileSync(response.json().path).equals(bytes)).toBe(true);
  }, 30_000);

  it('rejects files above 100 MB without saving them', async () => {
    const response = await upload('file', {
      dataUrl: dataUrl('application/zip', Buffer.alloc(100 * 1024 * 1024 + 1)), filename: 'too-large.zip',
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('File too large (max 100 MB)');
    expect(existsSync(join(project, '.agentmanager', 'pastes'))).toBe(false);
  }, 30_000);

  it.each(['', 'ignored', 'tracked'])('keeps Git status and existing manager files unchanged (%s)', async mode => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'safe.directory=' + project, '-C', project, ...args], {encoding:'utf8'});
    git('init', '--quiet');
    if (mode) {
      mkdirSync(join(project,'.agentmanager'));
      writeFileSync(join(project,'.agentmanager','.gitignore'),mode==='ignored'?'*\n':'!pastes/\n');
      writeFileSync(join(project,'.agentmanager','keep.txt'),'existing');
      if(mode==='tracked')git('add','.agentmanager');
    }
    const before=git('status','--porcelain','--untracked-files=all');
    const names=readdirSync(project);
    for(const kind of ['image','file'] as const) {
      const response=await upload(kind,kind==='image'?{dataUrl:dataUrl('image/png',png)}:{dataUrl:dataUrl('text/plain',Buffer.from('hello')),filename:'note.txt'});
      expect(response.statusCode).toBe(200);
    }
    expect(git('status','--porcelain','--untracked-files=all')).toBe(before);
    expect(readdirSync(project)).toEqual(names);
    if(mode)expect(readFileSync(join(project,'.agentmanager','.gitignore'),'utf8')).toBe(mode==='ignored'?'*\n':'!pastes/\n');
  });

  it('does not touch project-local symlinks during uploads or cleanup', async () => {
    const outside=join(project,'..','outside');mkdirSync(outside);
    symlinkSync(outside,join(project,'.agentmanager'));
    expect((await upload('image',{dataUrl:dataUrl('image/png',png)})).statusCode).toBe(200);
    sweepAllPastes();
    expect(readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.getuid?.()===0)('uploads successfully without write access to the project',async()=>{
    chmodSync(project,0o500);
    try {
      expect((await upload('image',{dataUrl:dataUrl('image/png',png)})).statusCode).toBe(200);
      expect(readdirSync(project)).toEqual([]);
    }finally{chmodSync(project,0o700);}
  });

  it('scopes external attachment preview, download and validation to its project',async()=>{
    const result=await upload('image',{dataUrl:dataUrl('image/png',png)}),path=result.json().path;
    for(const endpoint of ['read','preview','stat','export']) {
      const url='/api/files/'+endpoint+'?'+new URLSearchParams({path,project_id:'project-1'});
      expect((await app.inject({url,headers:{cookie:ownerCookie}})).statusCode).toBe(200);
      expect((await app.inject({url,headers:{cookie:otherCookie}})).statusCode).toBe(403);
      expect((await app.inject({url:url.replace('project-1','other-project'),headers:{cookie:ownerCookie}})).statusCode).toBe(403);
    }
    const url='/api/files/read?'+new URLSearchParams({path});
    expect((await app.inject({url,headers:{cookie:ownerCookie}})).statusCode).toBe(200);
    expect((await app.inject({url,headers:{cookie:otherCookie}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/files/delete?project_id=project-1',headers:{cookie:ownerCookie},payload:{path}})).statusCode).toBe(403);
  });

  it('prunes old pasted files while keeping unrelated files', () => {
    const dir = join(project, '.agentmanager', 'pastes');
    mkdirSync(dir, { recursive: true });
    const oldPaste = join(dir, 'paste-old.png');
    const unrelated = join(dir, 'notes.txt');
    writeFileSync(oldPaste, png);
    writeFileSync(unrelated, 'keep');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldPaste, old, old);
    prunePastesDir(dir);
    expect(existsSync(oldPaste)).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
  });
});
