import {clipped} from './agents/history-text.js';
import {getAgent,agentForSession,agentContext} from './agents/index.js';
import {access,open,readdir,stat} from 'fs/promises';
import {homedir} from 'os';
import {join} from 'path';
import {readAgentManagement} from './agents/management-store.js';


import {NATIVE_SESSION_ID_RE,type CliType} from './session-identity.js';

export interface PromptContextTurn {
  user: string;
  assistant: string;
}

export interface AgentTextMessage {
  role: 'user' | 'assistant';
  phase: 'user' | 'unknown' | 'commentary' | 'final';
  text: string;
  timestamp: string | null;
  task_reference?: string | null;
}

/** Compatibility wrapper. Native decoders live with their providers. */
export function decodeNativeAgentMessages(entries:Iterable<unknown>,kind:CliType,limit=8000){return getAgent(kind).history.file!.decode(entries,limit);}

export interface PromptContextSession {
  agent_environment_id?:string|null;
  agent_id?:string|null;native_session_id?:string|null;
  cli_type: CliType | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
  project_path: string | null;
}

export const MAX_PROMPT_CONTEXT_ROUNDS = 10;
export const MAX_PROMPT_CONTEXT_CHARS = 16_000;
const MAX_CONTEXT_MESSAGE_CHARS = 8_000;
const CONTEXT_TAIL_BUDGETS = [4, 32, 128].map((megabytes) => megabytes * 1024 * 1024);
const codexRolloutCache = new Map<string, string>();

function codexSessionRoots(): string[] {
  const roots = new Set<string>([process.env.CODEX_HOME || join(homedir(), '.codex')]);
  for (const provider of readAgentManagement('codex').providers) {
    const configured = provider.fields.codexHome;
    const home = typeof configured === 'string' && configured.trim()
      ? configured.trim()
      : join(homedir(), `.codex-${provider.id}`);
    roots.add(home === '~' ? homedir() : home.startsWith('~/') ? join(homedir(), home.slice(2)) : home);
  }
  return [...roots];
}

/** Keep newest complete turns within a fixed request budget. */
export function limitPromptContext(turns: PromptContextTurn[], rounds: number): PromptContextTurn[] {
  const wanted = Math.max(0, Math.min(MAX_PROMPT_CONTEXT_ROUNDS, Math.trunc(rounds)));
  if (wanted === 0) return [];

  const selected: PromptContextTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0 && selected.length < wanted; index--) {
    const turn = {
      user: clipped(turns[index].user.trim()),
      assistant: clipped(turns[index].assistant.trim()),
    };
    if (!turn.user || !turn.assistant) continue;
    const size = turn.user.length + turn.assistant.length;
    if (selected.length > 0 && used + size > MAX_PROMPT_CONTEXT_CHARS) break;
    if (selected.length === 0 && size > MAX_PROMPT_CONTEXT_CHARS) {
      const half = Math.floor(MAX_PROMPT_CONTEXT_CHARS / 2);
      turn.user = clipped(turn.user, half);
      turn.assistant = clipped(turn.assistant, MAX_PROMPT_CONTEXT_CHARS - turn.user.length);
    }
    selected.push(turn);
    used += turn.user.length + turn.assistant.length;
  }
  return selected.reverse();
}

/**
 * Claude logs tool results as user-role records too. Only text-bearing human
 * prompts are accepted, and only assistant messages explicitly ending a turn
 * become context conclusions.
 */
export {extractClaudePromptContext} from './agents/claude/prompt-context.js';
export {extractCodexPromptContext} from './agents/codex/prompt-context.js';

async function relevantTailEntries(filePath: string, kind: CliType, maxBytes: number): Promise<{ entries: unknown[]; reachedStart: boolean }> {
  const entries: unknown[] = [];
  const size = (await stat(filePath)).size;
  const length = Math.min(size, maxBytes);
  const offset = size - length;
  const buffer = Buffer.allocUnsafe(length);
  const file = await open(filePath, 'r');
  try {
    await file.read(buffer, 0, length, offset);
    const lines = buffer.toString('utf8').split('\n');
    // The first line begins before this tail window and may be a multi-megabyte
    // tool result. Discard it instead of attempting to parse a partial record.
    if (offset > 0) lines.shift();
    for (const line of lines) {
      const relevant=getAgent(kind).history.file!.relevant(line);
      if (!relevant) continue;
      try { entries.push(JSON.parse(line)); } catch { /* partial line while CLI is writing */ }
    }
  } finally {
    await file.close();
  }
  return { entries, reachedStart: offset === 0 };
}

export async function loadPromptContextFromFile(filePath: string, kind: CliType, rounds: number): Promise<PromptContextTurn[]> {
  let latest: PromptContextTurn[] = [];
  for (const budget of CONTEXT_TAIL_BUDGETS) {
    const { entries, reachedStart } = await relevantTailEntries(filePath, kind, budget);
    latest=getAgent(kind).history.file!.turns(entries,rounds);
    if (latest.length >= rounds || reachedStart) return latest;
  }
  return latest;
}

export async function findCodexRollout(sessionId: string): Promise<string | null> {
  // Explicit environment bindings must never fall back to another account's files.
  let environmentId:string|undefined;
  try {const {getDb}=await import('../db/index.js');environmentId=(getDb().prepare("SELECT agent_environment_id AS id FROM sessions WHERE (codex_session_id=? OR native_session_id=?) AND agent_environment_id LIKE 'account:%' LIMIT 1").get(sessionId,sessionId) as {id:string}|undefined)?.id;}catch{/* File-only readers have no application database. */}
  if(environmentId)return (await import('./agents/codex/account-files.js')).environmentRollout({nativeId:sessionId,session:{agent_environment_id:environmentId}});
  if (!NATIVE_SESSION_ID_RE.test(sessionId)) return null;
  const roots = codexSessionRoots().map(home => join(home, 'sessions'));
  const cacheKey = `${roots.join('|')}:${sessionId}`;
  const cached = codexRolloutCache.get(cacheKey);
  if (cached) {
    try {
      await access(cached);
      return cached;
    } catch {
      codexRolloutCache.delete(cacheKey);
    }
  }
  const suffix = `${sessionId}.jsonl`;
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
    if (!match) continue;
    const path = join(match.parentPath, match.name);
    codexRolloutCache.set(cacheKey, path);
    return path;
  }
  return null;
}

export async function loadRecentAgentMessages(session: PromptContextSession): Promise<AgentTextMessage[]> {
  try {
    const native=await nativeConversationFile(session);
    if(!native){const page=await agentForSession(session).history.read(agentContext(session),{limit:30});return (page?.messages||[]).map(message=>({role:message.role,phase:message.role==='user'?'user' as const:message.phase==='commentary'?'commentary' as const:'final' as const,text:message.text.slice(-MAX_PROMPT_CONTEXT_CHARS),timestamp:message.timestamp}));}
    const file=native.path,kind=native.kind;
    let messages: AgentTextMessage[] = [];
    for (const budget of CONTEXT_TAIL_BUDGETS) {
      const {entries,reachedStart} = await relevantTailEntries(file, kind, budget);
      messages = extractAgentMessages(entries, kind);
      if (messages.some(message => message.role === 'user') || reachedStart) break;
    }
    const selected: AgentTextMessage[] = [];
    let remaining = MAX_PROMPT_CONTEXT_CHARS;
    for (const message of messages.reverse()) {
      if (selected.length >= 30 || remaining <= 0) break;
      const text = message.text.slice(-remaining);
      selected.push({...message, text});
      remaining -= text.length;
    }
    return selected.reverse();
  } catch {
    return [];
  }
}

export async function nativeConversationFile(session:PromptContextSession):Promise<{path:string;kind:CliType}|null>{const adapter=agentForSession(session),context=agentContext(session);if(!context.nativeId)return null;const path=await adapter.history.file?.locate(context);return path?{path,kind:adapter.descriptor.id}:null;}

/** Resolve the tab's bound native history and return only completed user/final pairs. */
export async function loadRecentPromptContext(
  session: PromptContextSession,
  rounds: number,
): Promise<PromptContextTurn[]> {
  if (!Number.isInteger(rounds) || rounds <= 0) return [];
  try {
    const adapter=agentForSession(session),context=agentContext(session);if(adapter.history.context)return adapter.history.context(context,rounds);
    const native=await nativeConversationFile(session);if(native)return loadPromptContextFromFile(native.path,native.kind,rounds);
    const page=await adapter.history.read(context,{limit:Math.min(80,rounds*6)}),turns:PromptContextTurn[]=[];let user='';
    for(const message of page?.messages||[]){if(message.role==='user')user=message.text;else if(message.phase==='final'&&user){turns.push({user,assistant:message.text});user='';}}
    return limitPromptContext(turns,rounds);
  } catch {
    // Missing, rotated, or concurrently-written history must never prevent the
    // user from enhancing the current draft without context.
  }
  return [];
}

export function extractAgentMessages(entries:Iterable<unknown>,kind:CliType,messageLimit=8000):AgentTextMessage[]{return getAgent(kind).history.file!.decode(entries,messageLimit);}
