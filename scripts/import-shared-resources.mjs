#!/usr/bin/env node
import { createHash, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { parse } = require('dotenv');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) options.set(process.argv[index], process.argv[index + 1]);
if (!['--db', '--username', '--source-project', '--directory'].every(key => options.get(key))) {
  console.error('用法：node scripts/import-shared-resources.mjs --db <数据库> --username <账号> --source-project <项目目录> --directory <共享目录>');
  process.exit(1);
}
process.env.AGENTMANAGER_DB_PATH = resolve(options.get('--db'));
const { initDb, getDb, closeDb } = await import('../server/dist/db/index.js');
const { saveSharedResources } = await import('../server/dist/services/shared-resources/store.js');
let createdFile;
try {
  initDb();
  const source = realpathSync(options.get('--source-project'));
  const directory = realpathSync(options.get('--directory'));
  const user = getDb().prepare('SELECT id FROM users WHERE username = ? AND disabled = 0').get(options.get('--username'));
  const project = getDb().prepare('SELECT owner_id FROM projects WHERE path = ?').get(source);
  if (!user || project?.owner_id !== user.id) throw Error('源项目必须归指定账号所有');
  const previous = getDb().prepare('SELECT * FROM user_shared_resources WHERE user_id = ?').get(user.id);
  if (previous?.env_file) throw Error('此账号已有凭据文件配置，未覆盖');
  const values = parse(readFileSync(join(source, '.env')));
  const jira = readFileSync(join(source, 'scripts/notify_jira.py'), 'utf8');
  const glab = readFileSync(join(source, 'scripts/glab'), 'utf8');
  const summary = readFileSync(join(source, 'scripts/notify_confluence.py'), 'utf8');
  values.ATLASSIAN_BASE_URL = new URL(/JIRA_BASE\s*=\s*["'](https:\/\/[^"']+)/.exec(jira)?.[1]).origin;
  values.GITLAB_HOST = /GITLAB_HOST=([A-Za-z0-9.-]+)/.exec(glab)?.[1] || '';
  values.DEEPSEEK_BASE_URL = /DEEPSEEK_BASE\s*=\s*["']([^"']+)/.exec(summary)?.[1] || '';
  values.DEEPSEEK_MODEL = /DEEPSEEK_MODEL\s*=\s*["']([^"']+)/.exec(summary)?.[1] || '';
  // Preserve edits made in the first version of the shared-resource page.
  if (previous) {
    const namespace = createHash('sha256').update(resolve(options.get('--db'))).digest('hex').slice(0, 16);
    const legacy = join(previous.directory, '.octoally-shared', namespace, user.id, 'resources.enc');
    if (existsSync(legacy)) {
      const envelope = JSON.parse(readFileSync(legacy, 'utf8'));
      const key = readFileSync(join(dirname(resolve(options.get('--db'))), 'shared-resource-keys', `${user.id}.key`));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const saved = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      for (const entry of saved.entries) if (!entry.key.endsWith('_GUIDE')) values[entry.key] = entry.value;
    }
  }
  const allowed = ['ATLASSIAN_BASE_URL','CONFLUENCE_EMAIL','CONFLUENCE_TOKEN','GITLAB_HOST','GITLAB_TOKEN','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL'];
  const selected = allowed.filter(key => values[key]);
  const content = '# 个人共享资源凭据；不要提交到项目仓库，也不要输出到会话中。\n' + selected.map(key => `${key}=${JSON.stringify(values[key])}`).join('\n') + '\n';
  const roundtrip = parse(content);
  if (selected.some(key => roundtrip[key] !== values[key])) throw Error('配置包含无法安全转换的值，未导入');
  const file = join(directory, '.env');
  if (existsSync(file)) throw Error('共享目录已存在 .env，未覆盖；请在平台选择该文件或另行迁移');
  const instructions = `需要访问公司资源时，先由本地程序按需读取上述 .env 文件；不要 cat 整个文件，不要打印 Token、密码、认证头或完整环境。提示词只说明用法，敏感值以文件为准。\n\nJira / Confluence：\n- ATLASSIAN_BASE_URL 是公司站点；CONFLUENCE_EMAIL 与 CONFLUENCE_TOKEN 是两个产品共用的邮箱和 API Token，使用 Basic 认证。\n- Jira REST 路径为 /rest/api/3。Confluence 可用 /wiki/api/v2/pages/<pageId>?body-format=storage 读取页面，旧接口为 /wiki/rest/api/content/<pageId>?expand=body.storage。\n- 收到 Jira / Confluence 链接时，用本地 HTTP 程序携带这组凭据访问 API。普通网页跳转登录页不表示 Token 无效，不要只尝试浏览器访问就判断无法读取。\n- Jira 项目键、Confluence 空间和页面 ID 从当前项目说明或用户链接取得。\n\nGitLab：\n- 使用 GITLAB_HOST 和 GITLAB_TOKEN，可调用 /api/v4（PRIVATE-TOKEN 请求头）或直接运行 glab，并通过该命令的环境变量传入。\n- 当前导入的 GITLAB_TOKEN 来自 ${source}，仅在该项目任务中使用；其他项目不要假定此 Token 有权限。\n- 原项目 scripts/glab 会自行读取旧的项目 .env；使用共享凭据时直接调用 glab。\n\nDeepSeek：\n- DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL 用于文档对账、摘要等辅助任务。\n\n只向本地程序提供当前任务需要的值。保存文件后，下次访问重新读取，不依赖旧的环境变量。已有账号访问能力不代表获得业务写操作授权。`;
  writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); createdFile = file;
  saveSharedResources(user.id, { directory, scope_path: previous?.scope_path || directory, env_file: file, instructions, enabled: previous ? !!previous.enabled : true, revision: previous?.revision || 0 });
  createdFile = undefined;
  console.log(JSON.stringify({ username: options.get('--username'), env_file: file, imported_keys: selected, source_unchanged: true }));
} catch (error) {
  if (createdFile) try { unlinkSync(createdFile); } catch { /* best-effort rollback of a newly created file */ }
  const safe = ['源项目必须','此账号已有','共享目录已存在','配置包含无法'].some(prefix => error instanceof Error && error.message.startsWith(prefix));
  console.error(safe ? error.message : '导入失败；未输出凭据，请检查账号和目录'); process.exitCode = 1;
} finally { closeDb(); }
