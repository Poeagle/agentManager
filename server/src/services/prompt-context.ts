import { access, open, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { resolveClaudeDir } from './claude-history.js';
import { NATIVE_SESSION_ID_RE, type CliType } from './session-identity.js';

export interface PromptContextTurn {
  user: string;
  assistant: string;
}

export interface PromptContextSession {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function contentText(content: unknown, blockType: 'text' | 'input_text' | 'output_text'): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter((block) => block.type === blockType && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function clipped(text: string, limit = MAX_CONTEXT_MESSAGE_CHARS): string {
  if (text.length <= limit) return text;
  const marker = '\n…[上下文已截断]…\n';
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining * 0.6);
  return `${text.slice(0, head)}${marker}${text.slice(-(remaining - head))}`;
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
export function extractClaudePromptContext(entries: Iterable<unknown>, rounds: number): PromptContextTurn[] {
  const turns: PromptContextTurn[] = [];
  let user = '';
  let finalAnswer = '';
  let turnCompleted = false;

  const commit = () => {
    if (user && finalAnswer && turnCompleted) turns.push({ user, assistant: finalAnswer });
    user = '';
    finalAnswer = '';
    turnCompleted = false;
  };

  for (const value of entries) {
    if (!isRecord(value) || value.isSidechain === true || value.isMeta === true) continue;
    const message = isRecord(value.message) ? value.message : null;

    if (value.type === 'user' && message?.role === 'user') {
      const origin = isRecord(value.origin) ? value.origin : null;
      if (origin && typeof origin.kind === 'string' && origin.kind !== 'human') continue;
      const text = contentText(message.content, 'text');
      // Array-valued tool_result records contain no direct text blocks and are
      // ignored; a real next prompt closes the preceding completed turn.
      if (!text) continue;
      commit();
      user = text;
      continue;
    }

    if (value.type === 'assistant' && message?.role === 'assistant' && user) {
      const text = contentText(message.content, 'text');
      if (text) {
        finalAnswer = text;
        if (message.stop_reason === 'end_turn') turnCompleted = true;
      }
      continue;
    }

    if (value.type === 'system' && value.subtype === 'turn_duration' && user && finalAnswer) {
      turnCompleted = true;
      commit();
    }
  }
  commit();
  return limitPromptContext(turns, rounds);
}

/** Codex exposes the exact human prompt and exact final answer as turn events. */
export function extractCodexPromptContext(entries: Iterable<unknown>, rounds: number): PromptContextTurn[] {
  const turns: PromptContextTurn[] = [];
  let user = '';
  let finalAnswer = '';

  const commit = () => {
    if (user && finalAnswer) turns.push({ user, assistant: finalAnswer });
    user = '';
    finalAnswer = '';
  };

  for (const value of entries) {
    if (!isRecord(value) || !isRecord(value.payload)) continue;
    const payload = value.payload;

    if (value.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanText(payload.message);
      if (!text) continue;
      // A new human message means any preceding turn without a final answer was
      // interrupted; it must not leak commentary into enhancement context.
      commit();
      user = text;
      continue;
    }

    if (value.type === 'response_item' && payload.type === 'message'
      && payload.role === 'assistant' && payload.phase === 'final_answer' && user) {
      const text = contentText(payload.content, 'output_text');
      if (text) finalAnswer = text;
      continue;
    }

    if (value.type === 'event_msg' && payload.type === 'task_complete' && user) {
      const exactFinal = cleanText(payload.last_agent_message);
      if (exactFinal) finalAnswer = exactFinal;
      commit();
    }
  }
  // Newer Codex logs tag final_answer before the task_complete event is flushed.
  commit();
  return limitPromptContext(turns, rounds);
}

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
      const relevant = kind === 'claude'
        ? /"type"\s*:\s*"(?:user|assistant|system)"/.test(line)
        : /"type"\s*:\s*"(?:user_message|task_complete|message)"/.test(line);
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
    latest = kind === 'codex'
      ? extractCodexPromptContext(entries, rounds)
      : extractClaudePromptContext(entries, rounds);
    if (latest.length >= rounds || reachedStart) return latest;
  }
  return latest;
}

async function findCodexRollout(sessionId: string): Promise<string | null> {
  const cached = codexRolloutCache.get(sessionId);
  if (cached) {
    try {
      await access(cached);
      return cached;
    } catch {
      codexRolloutCache.delete(sessionId);
    }
  }
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  const suffix = `${sessionId}.jsonl`;
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (!match) return null;
  const path = join(match.parentPath, match.name);
  codexRolloutCache.set(sessionId, path);
  return path;
}

/** Resolve the tab's bound native history and return only completed user/final pairs. */
export async function loadRecentPromptContext(
  session: PromptContextSession,
  rounds: number,
): Promise<PromptContextTurn[]> {
  if (!Number.isInteger(rounds) || rounds <= 0) return [];
  try {
    if (session.cli_type === 'codex' && session.codex_session_id
      && NATIVE_SESSION_ID_RE.test(session.codex_session_id)) {
      const file = await findCodexRollout(session.codex_session_id);
      if (!file) return [];
      return loadPromptContextFromFile(file, 'codex', rounds);
    }

    if (session.claude_session_id && session.project_path
      && NATIVE_SESSION_ID_RE.test(session.claude_session_id)) {
      const dir = resolveClaudeDir(session.project_path);
      if (!dir) return [];
      return loadPromptContextFromFile(join(dir, `${session.claude_session_id}.jsonl`), 'claude', rounds);
    }
  } catch {
    // Missing, rotated, or concurrently-written history must never prevent the
    // user from enhancing the current draft without context.
  }
  return [];
}
