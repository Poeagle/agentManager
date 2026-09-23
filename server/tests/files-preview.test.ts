import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { fileRoutes } from '../src/routes/files.js';
import { DocumentPreviewError, previewOfficeDocument } from '../src/services/document-preview.js';
import { createTestDatabase } from './helpers/database.js';

vi.mock('../src/services/document-preview.js', async () => ({
  ...await vi.importActual('../src/services/document-preview.js'), previewOfficeDocument: vi.fn(),
}));

let app: FastifyInstance;
let cleanup: () => void;
let root: string;
let cookie: string;
const pdf = Buffer.from('%PDF-1.4\npreview test\n%%EOF');

beforeEach(async () => {
  vi.clearAllMocks();
  const database = createTestDatabase();
  cleanup = database.cleanup;
  root = join(database.dir, 'project');
  mkdirSync(root);
  const user = createUser({ username: 'admin', password: 'password1', role: 'admin' });
  cookie = `agentmanager_session=${createSession(user.id)}`;
  getDb().prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p1', 'Project', root);
  app = Fastify({ logger: false });
  app.addHook('onRequest', authHook);
  await app.register(fileRoutes, { prefix: '/api' });
  vi.mocked(previewOfficeDocument).mockResolvedValue(pdf);
});

afterEach(async () => { await app.close(); cleanup(); });
function request(route: string, file: string) {
  return app.inject({ method: 'GET', url: `/api/files/${route}?project_id=p1&path=${encodeURIComponent(file)}`, headers: { cookie } });
}

describe('document previews', () => {
  it.each([['pdf', 'pdf'], ['doc', 'word'], ['docx', 'word'], ['odt', 'word'], ['rtf', 'word'],
    ['xls', 'spreadsheet'], ['xlsx', 'spreadsheet'], ['ods', 'spreadsheet'],
    ['ppt', 'presentation'], ['pptx', 'presentation'], ['odp', 'presentation'],
    ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['gif', 'image'], ['webp', 'image'], ['svg', 'image']])('classifies %s without UTF-8 decoding', async (extension, kind) => {
    const path = join(root, `file.${extension}`);
    writeFileSync(path, Buffer.from([0, 255, 128, 1]));
    const response = await request('read', path);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ previewType: kind, content: '', size: 4 });
  });

  it('streams a PDF with the original bytes', async () => {
    const path = join(root, 'test.pdf');
    writeFileSync(path, pdf);
    const response = await request('preview', path);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.rawPayload.equals(pdf)).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('converts an authorized Office document and exposes converter errors as JSON', async () => {
    const path = join(root, 'test.docx');
    writeFileSync(path, 'docx fixture');
    expect((await request('preview', path)).rawPayload.equals(pdf)).toBe(true);
    expect(previewOfficeDocument).toHaveBeenCalledWith(Buffer.from('docx fixture'), 'docx');
    vi.mocked(previewOfficeDocument).mockRejectedValue(new DocumentPreviewError('缺少 Writer', 503));
    const response = await request('preview', path);
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().error).toBe('缺少 Writer');
  });

  it('returns spreadsheet HTML only under restrictive CSP', async () => {
    const path = join(root, 'table.xlsx');
    writeFileSync(path, 'xlsx');
    vi.mocked(previewOfficeDocument).mockResolvedValue(Buffer.from('<table><tr><td>42</td></tr></table>'));
    const response = await request('preview', path);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("sandbox; default-src 'none'");
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it.each(['drawio', 'xml'])('detects %s diagrams while preserving their XML', async extension => {
    const path = join(root, `flow.${extension}`);
    const xml = '<?xml version="1.0"?>\n<mxfile><diagram><mxGraphModel/></diagram></mxfile>';
    writeFileSync(path, xml);
    expect((await request('read', path)).json()).toMatchObject({ previewType: 'drawio', content: xml });
  });

  it('preserves text line breaks, CSV contents and UTF-16 text', async () => {
    const path = join(root, 'notes.txt');
    writeFileSync(path, Buffer.concat([Buffer.from([255, 254]), Buffer.from('第一行\r\n第二行', 'utf16le')]));
    expect((await request('read', path)).json()).toMatchObject({ previewType: 'text', content: '第一行\r\n第二行' });
    const csv = join(root, 'data.csv');
    writeFileSync(csv, 'name,value\n"multi\nline",42');
    expect((await request('read', csv)).json().previewType).toBe('csv');
  });

  it('rejects unsupported binary data instead of displaying NUL bytes', async () => {
    const path = join(root, 'archive.bin');
    writeFileSync(path, Buffer.from([0, 1, 2, 0]));
    expect((await request('read', path)).statusCode).toBe(415);
  });

  it('blocks traversal and symlink escapes before reading or converting, including for admins', async () => {
    const outside = join(root, '..', 'secret.docx');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'link.docx'));
    expect((await request('preview', outside)).statusCode).toBe(403);
    expect((await request('preview', join(root, 'link.docx'))).statusCode).toBe(403);
    expect(previewOfficeDocument).not.toHaveBeenCalled();
  });

  it('requires login for previews', async () => {
    cookie = '';
    expect((await request('preview', join(root, 'test.pdf'))).statusCode).toBe(401);
  });
});
