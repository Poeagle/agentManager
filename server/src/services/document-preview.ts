import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);
let conversions = 0;

export class DocumentPreviewError extends Error {
  constructor(message: string, public statusCode: number, cause?: unknown) { super(message, { cause }); }
}

export const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods']);
export const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'ods']);

/** Convert locally, without exposing project files, credentials or the network to LibreOffice. */
export async function previewOfficeDocument(content: Buffer, extension: string): Promise<Buffer> {
  if (!OFFICE_EXTENSIONS.has(extension)) throw new DocumentPreviewError('不支持的 Office 格式', 415);
  if (content.length > 20 * 1024 * 1024) throw new DocumentPreviewError('Office 预览最大支持 20 MB', 413);
  if (!existsSync('/usr/bin/bwrap') || !existsSync('/usr/bin/libreoffice') || !existsSync('/usr/bin/prlimit')) {
    throw new DocumentPreviewError('服务器需安装 LibreOffice、bubblewrap 和 util-linux 才能预览 Office；可下载原文件查看', 503);
  }
  const component = SPREADSHEET_EXTENSIONS.has(extension) ? ['Calc', 'libsclo.so']
    : ['ppt', 'pptx', 'odp'].includes(extension) ? ['Impress', 'libsdlo.so'] : ['Writer', 'libswlo.so'];
  if (!existsSync(`/usr/lib/libreoffice/program/${component[1]}`)) {
    throw new DocumentPreviewError(`服务器缺少 LibreOffice ${component[0]} 组件，请安装后预览；也可下载原文件查看`, 503);
  }
  if (conversions >= 2) throw new DocumentPreviewError('文档转换繁忙，请稍后重新打开', 503);
  conversions++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'agentmanager-document-'));
    await mkdir(join(directory, 'output'));
    await mkdir(join(directory, 'profile', 'user'), { recursive: true });
    await writeFile(join(directory, `input.${extension}`), content, { mode: 0o600 });
    await writeFile(join(directory, 'profile', 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
      + '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'
      + '</oor:items>');
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin'];
    for (const path of ['/lib', '/lib64', '/etc/fonts', '/etc/libreoffice', '/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf']) {
      if (existsSync(path)) args.push('--ro-bind', path, path);
    }
    const spreadsheet = SPREADSHEET_EXTENSIONS.has(extension);
    const format = spreadsheet ? 'html:HTML (StarCalc)' : ['ppt', 'pptx', 'odp'].includes(extension) ? 'pdf:impress_pdf_Export' : 'pdf:writer_pdf_Export';
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', directory, '/work',
      '--chdir', '/work', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'XDG_CACHE_HOME', '/tmp/cache',
      '/usr/bin/prlimit', '--as=2147483648', '--cpu=25', '--fsize=52428800', '--',
      '/usr/bin/libreoffice', '-env:UserInstallation=file:///work/profile',
      '--headless', '--nologo', '--nodefault', '--norestore',
      '--convert-to', format, '--outdir', '/work/output', `/work/input.${extension}`);
    const output = await run('/usr/bin/bwrap', args, { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
    const result = await readFile(join(directory, 'output', spreadsheet ? 'input.html' : 'input.pdf'))
      .catch(() => { throw new Error(output.stderr || output.stdout || 'Converter produced no preview'); });
    if (!spreadsheet && !result.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF output');
    return result;
  } catch (error) {
    if (error instanceof DocumentPreviewError) throw error;
    throw new DocumentPreviewError('Office 预览失败：文件可能损坏、加密，或转换超时；可下载原文件查看', 422, error);
  } finally {
    conversions--;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
