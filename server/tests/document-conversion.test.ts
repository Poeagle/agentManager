import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { previewOfficeDocument } from '../src/services/document-preview.js';
import { docxFixture, odpFixture, pptxFixture, xlsxFixture } from './helpers/office-fixtures.js';

const sandbox = existsSync('/usr/bin/bwrap') && existsSync('/usr/bin/prlimit') && existsSync('/usr/bin/libreoffice');
describe('real isolated Office conversion', () => {
  it.skipIf(!sandbox || !existsSync('/usr/lib/libreoffice/program/libsdlo.so'))('converts an OpenDocument presentation to PDF', async () => {
    const result = await previewOfficeDocument(odpFixture(), 'odp');
    expect(result.subarray(0, 5).toString()).toBe('%PDF-');
  }, 35_000);

  it.skipIf(!sandbox || !existsSync('/usr/lib/libreoffice/program/libsdlo.so'))('converts PowerPoint slides to PDF', async () => {
    const result = await previewOfficeDocument(pptxFixture(), 'pptx');
    expect(result.subarray(0, 5).toString()).toBe('%PDF-');
  }, 35_000);

  it.skipIf(!sandbox || !existsSync('/usr/lib/libreoffice/program/libswlo.so'))('converts DOCX to paginated PDF', async () => {
    const result = await previewOfficeDocument(docxFixture(), 'docx');
    expect(result.subarray(0, 5).toString()).toBe('%PDF-');
  }, 35_000);

  it.skipIf(!sandbox || !existsSync('/usr/lib/libreoffice/program/libsclo.so'))('converts XLSX sheets and values to HTML', async () => {
    const result = await previewOfficeDocument(xlsxFixture(), 'xlsx');
    expect(result.toString()).toContain('Revenue');
    expect(result.toString()).toContain('Costs');
    expect(result.toString()).toContain('42');
  }, 35_000);

  it('rejects unsupported formats before invoking a converter', async () => {
    await expect(previewOfficeDocument(Buffer.from('x'), 'exe')).rejects.toMatchObject({ statusCode: 415 });
  });
});
