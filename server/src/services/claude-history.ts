/**
 * Reads a project's session history straight from Claude Code's own on-disk
 * conversation logs (`~/.claude/projects/<encoded-path>/<uuid>.jsonl`), keyed by
 * project PATH. This is the complete history (every Claude run in that dir,
 * across AgentManager dev/prod DBs), and every entry is resumable via its uuid.
 *
 * Files can be huge (tens of MB), so metadata is extracted from the file HEAD
 * only — never a full read. Last-activity comes from mtime, size from stat.
 */
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ClaudeHistoryItem {
  uuid: string;
  title: string;
  startTime: string | null; // ISO timestamp of the first entry
  lastActivity: number;     // file mtime (epoch ms)
  sizeBytes: number;
  model: string | null;
}

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const HEAD_BYTES = 64 * 1024;

/** Claude encodes the cwd into the dir name by replacing every non-alphanumeric
 *  char with '-' (so `/home/u/dolphindb_manager` → `-home-u-dolphindb-manager`). */
function encodeDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function readHeadLines(filePath: string): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** The cwd recorded inside a jsonl — ground truth of the project path. */
function readCwd(filePath: string): string | null {
  for (const line of readHeadLines(filePath)) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.cwd) return o.cwd as string; } catch { /* truncated/non-json */ }
  }
  return null;
}

/** Locate the Claude log dir for a project path (direct encode, else scan+match cwd). */
export function resolveClaudeDir(projectPath: string): string | null {
  const direct = join(PROJECTS_ROOT, encodeDir(projectPath));
  if (existsSync(direct)) return direct;
  // Fallback for any encoding edge case: match by the cwd recorded inside.
  try {
    for (const name of readdirSync(PROJECTS_ROOT)) {
      const dir = join(PROJECTS_ROOT, name);
      let firstJsonl: string | undefined;
      try { firstJsonl = readdirSync(dir).find((f) => f.endsWith('.jsonl') && !f.includes('-topic-')); } catch { continue; }
      if (firstJsonl && readCwd(join(dir, firstJsonl)) === projectPath) return dir;
    }
  } catch { /* projects root may not exist */ }
  return null;
}

function parseHead(filePath: string): { title: string | null; startTime: string | null; model: string | null } {
  let title: string | null = null;
  let startTime: string | null = null;
  let model: string | null = null;
  for (const line of readHeadLines(filePath)) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; } // last buffered line may be truncated
    if (!startTime && o.timestamp) startTime = o.timestamp;
    if (!model && o.message?.model) model = o.message.model;
    if (!title && o.type === 'user' && o.message) {
      const c = o.message.content;
      let txt = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join(' ') : '';
      txt = (txt || '').trim();
      // Skip system/command/caveat wrappers — keep the first real user prompt.
      if (txt && !txt.startsWith('<') && !txt.startsWith('Caveat')) title = txt.replace(/\s+/g, ' ').slice(0, 120);
    }
    if (title && startTime && model) break;
  }
  return { title, startTime, model };
}

/** List a project's Claude conversation logs (head-parsed metadata, newest first). */
export function listClaudeSessions(projectPath: string): ClaudeHistoryItem[] {
  const dir = resolveClaudeDir(projectPath);
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('-topic-')); } catch { return []; }

  const items: ClaudeHistoryItem[] = [];
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.size) continue; // skip empty/aborted files
    const { title, startTime, model } = parseHead(full);
    items.push({
      uuid: name.replace(/\.jsonl$/, ''),
      title: title || '(无标题)',
      startTime,
      lastActivity: st.mtimeMs,
      sizeBytes: st.size,
      model,
    });
  }
  items.sort((a, b) => b.lastActivity - a.lastActivity);
  return items;
}

/** Delete one conversation log file. Returns true if a file was removed. */
export function deleteClaudeSession(projectPath: string, uuid: string): boolean {
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,}$/.test(uuid)) return false; // guard against path traversal
  const dir = resolveClaudeDir(projectPath);
  if (!dir) return false;
  const f = join(dir, `${uuid}.jsonl`);
  if (!existsSync(f)) return false;
  try { unlinkSync(f); return true; } catch { return false; }
}
