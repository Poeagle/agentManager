import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHook, createSession, createUser, userOwnsFilesystemPath } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { fileRoutes } from '../src/routes/files.js';
import { gitRoutes } from '../src/routes/git.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let ownerCookie: string;
let memberCookie: string;
let projectPath: string;
let markerPath: string;
let originalPath: string | undefined;
let originalCodeLog: string | undefined;

beforeEach(async () => {
  const database = createTestDatabase();
  cleanup = database.cleanup;
  projectPath = join(database.dir, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'plain.txt'), 'plain\n');
  const owner = createUser({ username: 'owner', password: 'password1', role: 'admin' });
  const member = createUser({ username: 'member', password: 'password1' });
  ownerCookie = `agentmanager_session=${createSession(owner.id)}`;
  memberCookie = `agentmanager_session=${createSession(member.id)}`;
  getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
    .run('project-1', 'Project', projectPath, owner.id);
  getDb().prepare('INSERT INTO project_user_access (project_id, user_id, granted_by) VALUES (?, ?, ?)')
    .run('project-1', member.id, owner.id);

  markerPath = join(process.cwd(), `agentmanager-command-injection-${process.pid}`);
  rmSync(markerPath, { force: true });
  originalPath = process.env.PATH;
  originalCodeLog = process.env.AGENTMANAGER_TEST_CODE_LOG;
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(fileRoutes, { prefix: '/api' });
  await app.register(gitRoutes, { prefix: '/api' });
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalCodeLog === undefined) delete process.env.AGENTMANAGER_TEST_CODE_LOG;
  else process.env.AGENTMANAGER_TEST_CODE_LOG = originalCodeLog;
  rmSync(markerPath, { force: true });
  await app.close();
  cleanup();
});

describe('command execution boundaries', () => {
  it('treats a nested registered project as its own authorization boundary', () => {
    const nested = join(projectPath, 'private-project');
    mkdirSync(nested);
    const owner = getDb().prepare('SELECT owner_id FROM projects WHERE id = ?').get('project-1') as { owner_id: string };
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('private-project', 'Private', nested, owner.owner_id);
    const member = getDb().prepare("SELECT id FROM users WHERE username = 'member'").get() as { id: string };

    expect(userOwnsFilesystemPath(member.id, join(nested, 'secret.txt'))).toBe(false);
  });

  it('passes malicious filenames to diff and VS Code as literal argv values', async () => {
    const markerName = markerPath.split('/').pop()!;
    const maliciousPath = join(projectPath, `probe-$(touch ${markerName}).txt`);
    writeFileSync(maliciousPath, 'changed\n');

    const diff = await app.inject({
      method: 'POST', url: '/api/files/diff', headers: { cookie: ownerCookie },
      payload: { pathA: maliciousPath, pathB: join(projectPath, 'plain.txt') },
    });
    expect(diff.statusCode).toBe(200);
    expect(existsSync(markerPath)).toBe(false);

    const deniedCreate = await app.inject({
      method: 'POST', url: '/api/git/create-repo', headers: { cookie: memberCookie },
      payload: { path: projectPath, name: 'member-repo' },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const fakeBin = join(projectPath, 'fake-bin');
    const codeLog = join(projectPath, 'code-argv.txt');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'code'), '#!/bin/sh\nprintf %s "$1" > "$AGENTMANAGER_TEST_CODE_LOG"\n');
    chmodSync(join(fakeBin, 'code'), 0o755);
    process.env.PATH = `${fakeBin}:${originalPath || ''}`;
    process.env.AGENTMANAGER_TEST_CODE_LOG = codeLog;

    const opened = await app.inject({
      method: 'POST', url: '/api/open-vscode', headers: { cookie: ownerCookie },
      payload: { path: maliciousPath },
    });
    expect(opened.statusCode).toBe(200);
    expect(readFileSync(codeLog, 'utf8')).toBe(maliciousPath);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('disables repository hooks for server-side git commits', async () => {
    execFileSync('git', ['init', '-q'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
    execFileSync('git', ['add', '--', 'plain.txt'], { cwd: projectPath });
    const hookPath = join(projectPath, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, `#!/bin/sh\n: > "${markerPath}"\n`);
    chmodSync(hookPath, 0o755);

    const committed = await app.inject({
      method: 'POST', url: '/api/git/commit', headers: { cookie: ownerCookie },
      payload: { path: projectPath, message: 'safe commit' },
    });
    expect(committed.statusCode).toBe(200);
    expect(existsSync(markerPath)).toBe(false);

    const maliciousRevision = await app.inject({
      method: 'GET',
      url: `/api/git/show?path=${encodeURIComponent(projectPath)}&hash=${encodeURIComponent(`--output=${markerPath}`)}`,
      headers: { cookie: ownerCookie },
    });
    expect(maliciousRevision.statusCode).toBe(500);
    expect(existsSync(markerPath)).toBe(false);
  });
});
