import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { skillsRoutes, unpackSkillArchive } from '../src/routes/skills.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let projectPath: string;

beforeEach(async () => {
  const testDb = createTestDatabase();
  cleanup = testDb.cleanup;
  projectPath = join(testDb.dir, 'project');
  mkdirSync(projectPath, { recursive: true });
  const owner = createUser({ username: 'owner', password: 'password1' });
  getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
    .run('project-1', 'Project', projectPath, owner.id);

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => { request.user = owner; });
  await app.register(skillsRoutes, { prefix: '/api' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  cleanup();
});

describe('Skill marketplace packages', () => {
  it('rejects path traversal and packages without a root SKILL.md', () => {
    const traversal = zipSync({ '../outside.txt': strToU8('unsafe'), 'SKILL.md': strToU8('# skill') });
    expect(() => unpackSkillArchive(traversal)).toThrow(/unsafe file path/);

    const missingManifest = zipSync({ 'README.md': strToU8('# readme') });
    expect(() => unpackSkillArchive(missingManifest)).toThrow(/root SKILL\.md/);
  });

  it('searches ClawHub and installs one verified snapshot into every selected agent target', async () => {
    const archive = zipSync({
      'SKILL.md': strToU8('---\nname: react-helper\ndescription: React help\n---\n\n# React helper\n'),
      'references/guide.md': strToU8('# Guide'),
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      if (url.pathname === '/api/v1/search') {
        return Response.json({
          results: [{
            id: 'clawhub:react-helper',
            source: 'clawhub',
            slug: 'react-helper',
            ownerHandle: 'acme',
            displayName: 'React Helper',
            summary: 'Helps with React.',
            downloads: 1234,
            install: { kind: 'clawhub', reference: 'acme/react-helper' },
            trust: { installability: 'installable' },
          }],
        });
      }
      if (url.pathname === '/api/v1/skills/react-helper/install') {
        return Response.json({ ok: true, slug: 'react-helper', installKind: 'archive', archive: { version: '1.0.0' } });
      }
      if (url.pathname === '/api/v1/download') {
        return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } });
      }
      return new Response('not found', { status: 404 });
    }));

    const search = await app.inject({
      method: 'GET',
      url: '/api/skills/marketplace/search?project_id=project-1&q=react',
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      skills: [{ slug: 'react-helper', installedTargets: [] }],
      installTargets: [
        { id: 'claude-code' },
        { id: 'codex' },
        { id: 'openclaw' },
      ],
    });

    const install = await app.inject({
      method: 'POST',
      url: '/api/skills/marketplace/install',
      payload: {
        project_id: 'project-1',
        provider: 'clawhub',
        slug: 'react-helper',
        ownerHandle: 'acme',
        targets: ['claude-code', 'codex', 'openclaw'],
      },
    });
    expect(install.statusCode).toBe(200);
    expect(install.json().installedTargets).toEqual(['claude-code', 'codex', 'openclaw']);

    const expectedFiles = [
      join(projectPath, '.claude', 'skills', 'react-helper', 'SKILL.md'),
      join(projectPath, '.agents', 'skills', 'react-helper', 'SKILL.md'),
      join(projectPath, 'skills', 'react-helper', 'SKILL.md'),
    ];
    for (const path of expectedFiles) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('name: react-helper');
    }
  });
});
