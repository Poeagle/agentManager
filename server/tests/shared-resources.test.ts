import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { authHook, createSession, createUser } from '../src/auth.js';
import { sharedResourceRoutes } from '../src/routes/shared-resources.js';
import { fileRoutes } from '../src/routes/files.js';
import { getDb } from '../src/db/index.js';
import { deleteSharedResources, getSharedResources, sharedResourceLaunch, type SharedResourcesInput } from '../src/services/shared-resources/store.js';
import { withSharedResourceInstructions, buildSessionCommand } from '../src/services/cli-command.js';
import { createTestDatabase } from './helpers/database.js';

describe('shared .env file and separate usage instructions', () => {
  let cleanup: () => void, app: FastifyInstance, root: string, project: string, other: string;
  let owner: string, member: string, cookie: string, memberCookie: string;
  let input: SharedResourcesInput;
  const content = 'CONFLUENCE_EMAIL=user@example.test\nCONFLUENCE_TOKEN=private-shared-token\n';
  const headers = (cookie: string) => ({ cookie });
  beforeEach(async () => {
    const db = createTestDatabase(); cleanup = db.cleanup;
    root = join(db.dir, 'workspace'); project = join(root, 'project'); other = join(root, 'other');
    mkdirSync(project, { recursive: true }); mkdirSync(other);
    owner = createUser({ username: 'owner', password: 'password1', role: 'admin' }).id;
    member = createUser({ username: 'member', password: 'password2' }).id;
    cookie = `agentmanager_session=${createSession(owner)}`; memberCookie = `agentmanager_session=${createSession(member)}`;
    getDb().prepare('INSERT INTO projects (id,name,path,owner_id) VALUES (?,?,?,?)').run('project', 'Project', project, owner);
    getDb().prepare('INSERT INTO projects (id,name,path,owner_id) VALUES (?,?,?,?)').run('other', 'Other', other, owner);
    getDb().prepare('INSERT INTO project_user_access (project_id,user_id) VALUES (?,?)').run('project', member);
    input = { directory: root, scope_path: root, env_file: join(root, '.env'), instructions: '用本地程序读取 CONFLUENCE_EMAIL 和 CONFLUENCE_TOKEN，通过 Basic 认证访问 Jira 和 Confluence。', enabled: true, revision: 0 };
    app = Fastify({ logger: false }); app.addHook('onRequest', authHook);
    await app.register(sharedResourceRoutes, { prefix: '/api' }); await app.register(fileRoutes, { prefix: '/api' });
  });
  afterEach(async () => { await app.close(); cleanup(); });
  async function put(payload: unknown, token = cookie) { return app.inject({ method: 'PUT', url: '/api/me/shared-resources', headers: headers(token), payload }); }
  async function open(token = cookie) { return app.inject({ method: 'POST', url: '/api/me/shared-resources/env/open', headers: headers(token) }); }
  async function save(content: string, expected_hash: string | null, revision = 1) { return app.inject({ method: 'PUT', url: '/api/me/shared-resources/env', headers: headers(cookie), payload: { content, expected_hash, revision } }); }

  it('keeps .env contents out of metadata and context, revealing them only through the explicit file editor', async () => {
    writeFileSync(input.env_file, content, { mode: 0o600 });
    const response = await put(input);
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().resources).toMatchObject({ env_file: input.env_file, instructions: input.instructions, env_exists: true });
    expect(response.body).not.toContain('private-shared-token');
    const opened = await open();
    expect(opened.statusCode).toBe(200); expect(opened.headers['cache-control']).toBe('no-store');
    expect(opened.json().content).toBe(content); expect(opened.json().hash).toHaveLength(64);
    const launch = sharedResourceLaunch(owner, project)!;
    expect(launch.instructions).toContain(input.env_file); expect(launch.instructions).toContain(input.instructions);
    expect(launch.instructions).not.toContain('private-shared-token'); expect(launch.instructions).not.toContain('user@example');
  });

  it('creates and edits the real file, preserving contents on conflicting edits and keeping mode 600', async () => {
    await put(input);
    const missing = (await open()).json(); expect(missing).toMatchObject({ exists: false, content: '', hash: null });
    expect((await save(content, null)).statusCode).toBe(200);
    expect(readFileSync(input.env_file, 'utf8')).toBe(content); expect(statSync(input.env_file).mode & 0o777).toBe(0o600);
    const hash = (await open()).json().hash;
    writeFileSync(input.env_file, 'EXTERNAL=changed\n');
    expect((await save('REPLACED=bad\n', hash)).statusCode).toBe(409);
    expect(readFileSync(input.env_file, 'utf8')).toBe('EXTERNAL=changed\n');
    const fresh = (await open()).json().hash;
    expect((await save('NEW_VALUE=updated\n', fresh)).statusCode).toBe(200);
    expect(readFileSync(input.env_file, 'utf8')).toBe('NEW_VALUE=updated\n');
  });

  it('scopes settings and editor by account and rejects another account claiming the same file', async () => {
    await put(input); writeFileSync(input.env_file, content);
    const otherUser = await app.inject({ url: `/api/me/shared-resources?user_id=${owner}`, headers: headers(memberCookie) });
    expect(otherUser.json().resources).toMatchObject({ revision: 0, env_file: '' });
    expect((await open(memberCookie)).statusCode).toBe(400);
    expect((await put(input, memberCookie)).statusCode).toBe(403);
    const memberFile = join(project, '.member.env');
    expect((await put({ ...input, directory:project, scope_path:project, env_file: memberFile }, memberCookie)).statusCode).toBe(200);
    expect((await open(memberCookie)).json().path).toBe(memberFile);
    expect((await put({ ...input, env_file: join(other, '.env'), revision: 1 }, memberCookie)).statusCode).toBe(403);
    expect((await put({ ...input, user_id: owner }, memberCookie)).statusCode).toBe(400);
    for (const token of [cookie, memberCookie]) {
      const read = await app.inject({ url: `/api/files/read?path=${encodeURIComponent(input.env_file)}`, headers: headers(token) });
      expect(read.statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/me/shared-resources/env/open' })).statusCode).toBe(401);
  });

  it('uses canonical project scope, excludes other users and supports CLI startup/resume without an extra user prompt', async () => {
    await put({ ...input, scope_path: project });
    const launch = sharedResourceLaunch(owner, project)!;
    expect(sharedResourceLaunch(member, project)).toBeUndefined(); expect(sharedResourceLaunch(owner, other)).toBeUndefined();
    symlinkSync(other, join(project, 'escape'));
    expect(sharedResourceLaunch(owner, join(project, 'escape'))).toBeUndefined();
    const sibling = join(root, 'project-extra'); mkdirSync(sibling);
    expect(sharedResourceLaunch(owner, sibling)).toBeUndefined();
    for (const cli of ['claude', 'codex'] as const) {
      const command = withSharedResourceInstructions(cli, cli, launch.instructions);
      expect(command).toContain(cli === 'codex' ? 'developer_instructions=' : '--append-system-prompt');
      expect(buildSessionCommand('old task', false, command, cli, 'native-id')).not.toContain('old task');
    }
    expect((await put({ ...input, enabled: false, revision: 1 })).statusCode).toBe(200);
    expect(sharedResourceLaunch(owner, project)).toBeUndefined();
  });

  it('changes the selected file without deleting existing files and detects stale configuration', async () => {
    await put(input); writeFileSync(input.env_file, content);
    const nextFile = join(root, '.next.env');
    expect((await put({ ...input, env_file: nextFile, revision: 1 })).statusCode).toBe(200);
    expect((await save('OLD=wrong\n', null, 1)).statusCode).toBe(409);
    expect((await open()).json().path).toBe(nextFile);
    expect((await put({ ...input, revision: 1 })).statusCode).toBe(409);
    deleteSharedResources(owner);
    expect(readFileSync(input.env_file, 'utf8')).toBe(content); expect(getSharedResources(owner).revision).toBe(0);
  });

  it('rejects symlink escapes, invalid files and content without exposing credentials in errors', async () => {
    expect((await put({ ...input, env_file: '/etc/passwd' })).statusCode).toBe(400);
    expect((await put({ ...input, directory: '/' })).statusCode).toBe(400);
    symlinkSync(join(other, '.env'), input.env_file);
    expect((await put(input)).statusCode).toBe(400);
  });
  it('derives scope and .env from the directory, creates without overwriting, and enforces current project authorization',async()=>{
    expect((await put({directory:root,instructions:'使用本地环境变量',enabled:true,revision:0},memberCookie)).statusCode).toBe(403);
    const response=await put({directory:project,instructions:'使用本地环境变量',enabled:true,revision:0},memberCookie);
    expect(response.statusCode).toBe(200);expect(response.json().resources).toMatchObject({directory:project,scope_path:project,env_file:join(project,'.env'),env_exists:false});
    expect(sharedResourceLaunch(member,project)).toBeDefined();expect(sharedResourceLaunch(member,other)).toBeUndefined();
    const created=await app.inject({method:'POST',url:'/api/me/shared-resources/env/create',headers:headers(memberCookie)});expect(created.statusCode).toBe(200);expect(created.json()).toMatchObject({exists:true,content:''});expect(statSync(join(project,'.env')).mode&0o777).toBe(0o600);
    expect((await app.inject({method:'POST',url:'/api/me/shared-resources/env/create',headers:headers(memberCookie)})).statusCode).toBe(409);
    getDb().prepare('DELETE FROM project_user_access WHERE project_id=? AND user_id=?').run('project',member);
    expect(sharedResourceLaunch(member,project)).toBeUndefined();expect((await open(memberCookie)).statusCode).toBe(403);
  });
  it('preserves old scope and file on read, then migrates only on a new-format save',async()=>{
    const old=join(root,'.old.env');writeFileSync(old,content);expect((await put({...input,scope_path:project,env_file:old})).statusCode).toBe(200);
    expect(getSharedResources(owner)).toMatchObject({scope_path:project,env_file:old});expect(sharedResourceLaunch(owner,other)).toBeUndefined();
    const saved=await put({directory:root,instructions:input.instructions,enabled:true,revision:1});expect(saved.statusCode).toBe(200);expect(saved.json().resources).toMatchObject({scope_path:root,env_file:join(root,'.env')});expect(readFileSync(old,'utf8')).toBe(content);
  });
  it('restricts directory browsing to authorized paths',async()=>{
    const browse=await app.inject({url:`/api/me/shared-resources/browse?path=${encodeURIComponent(root)}`,headers:headers(memberCookie)});expect(browse.statusCode).toBe(200);expect(browse.json().dirs.map((d:any)=>d.name)).toContain('project');expect(browse.json().dirs.map((d:any)=>d.name)).not.toContain('other');
    expect((await app.inject({url:`/api/me/shared-resources/browse?path=${encodeURIComponent(other)}`,headers:headers(memberCookie)})).statusCode).toBe(403);
  });
  it('revalidates .env at creation when the path changes into a symlink',async()=>{
    expect((await put({directory:root,instructions:'',enabled:true,revision:0})).statusCode).toBe(200);
    const outside=join(other,'credential');writeFileSync(outside,'UNCHANGED');symlinkSync(outside,join(root,'.env'));
    const created=await app.inject({method:'POST',url:'/api/me/shared-resources/env/create',headers:headers(cookie)});expect(created.statusCode).toBe(400);expect(readFileSync(outside,'utf8')).toBe('UNCHANGED');
  });
});
