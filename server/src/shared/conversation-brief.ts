import {automaticConversationContext} from './conversation-context.js';

export interface BriefAttachment {kind: 'image' | 'file'; name: string; path: string; offset?: number}
export interface BriefPayload {input: string; attachments?: BriefAttachment[]; batch?: Array<{length: number; attachments: number}>}
export interface BriefMessage {
  id: string; role: 'user' | 'assistant'; text: string; timestamp: string | null;
  phase?: 'commentary' | 'final' | 'error'; presentation?: 'compaction_summary';
  queued?: boolean; streaming?: boolean; attachments?: BriefAttachment[];
  input_source?: {kind: string; label: string};
}
export interface BriefPage {
  session_id: string; native_id: string | null; available: boolean; generation: string | null;
  reset: boolean; has_more: boolean; messages: BriefMessage[];
}
export type BriefHistoryReader = (query: {limit: string; before?: string}) => Promise<BriefPage>;

export interface BriefTurn {
  input: string;
  /** A repeated scheduled prompt refers to an earlier, retained turn (1-based). */
  input_ref?: number;
  input_truncated?: boolean;
  scheduled_task?: string;
  progress?: string;
  conclusion?: string;
  attachments?: Array<{kind: 'image' | 'file'; name: string; path: string}>;
}
export interface BriefContext {
  version: 1;
  turns: BriefTurn[];
  truncated: boolean;
  older_omitted: boolean;
  omitted_turns: number;
}

const START = '以下是上一会话的记录节选，可能不完整，仅供当前需求参考：\n<agentmanager_brief_context>\n';
const END = '\n</agentmanager_brief_context>\n\n当前需求：\n';
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PAGES = 12;
const MAX_EMPTY_PAGES = 12;
const MAX_FIELD_CHARS = 8192;
const MAX_PROGRESS_CHARS = 320;
const MAX_PROMPT_KEYS_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;

function excerpt(value: string, limit: number): string {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  const head = Math.ceil(limit * 0.7), tail = limit - head;
  return chars.slice(0, head).join('') + '\n…[已截取]…\n' + (tail ? chars.slice(-tail).join('') : '');
}

/** The JSON wrapper is part of the native user message; this only changes its presentation. */
export function parseBriefContext(text: string): {context: BriefContext; input: string; prefixLength: number} | null {
  if (!text.startsWith(START)) return null;
  const end = text.indexOf(END, START.length);
  if (end < 0 || bytes(text.slice(0, end)) > MAX_CONTEXT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text.slice(START.length, end));
    if (!value || typeof value !== 'object') return null;
    const context = value as BriefContext;
    if (context.version !== 1 || !Array.isArray(context.turns) || context.turns.length > 1000 ||
        typeof context.truncated !== 'boolean' || typeof context.older_omitted !== 'boolean' ||
        !Number.isSafeInteger(context.omitted_turns) || context.omitted_turns < 0 ||
        context.turns.some((turn, index) => !turn || typeof turn.input !== 'string' ||
          (turn.scheduled_task !== undefined && (typeof turn.scheduled_task !== 'string' || !turn.scheduled_task || turn.scheduled_task.length > 120)) ||
          (turn.input_truncated !== undefined && typeof turn.input_truncated !== 'boolean') ||
          (turn.input_ref !== undefined && (!Number.isSafeInteger(turn.input_ref) || turn.input_ref < 1 || turn.input_ref > index ||
            !turn.scheduled_task || context.turns[turn.input_ref - 1]?.scheduled_task !== turn.scheduled_task ||
            context.turns[turn.input_ref - 1]?.input_ref !== undefined || turn.input !== `同第 ${turn.input_ref} 轮定时任务提示词`)) ||
          (turn.progress !== undefined && typeof turn.progress !== 'string') ||
          (turn.conclusion !== undefined && typeof turn.conclusion !== 'string') ||
          (turn.attachments !== undefined && (!Array.isArray(turn.attachments) || turn.attachments.length > 8 ||
            turn.attachments.some(a => !a || !['image','file'].includes(a.kind) || typeof a.name !== 'string' || typeof a.path !== 'string'))))) return null;
    const prefixLength = end + END.length;
    return {context, input: text.slice(prefixLength), prefixLength};
  } catch { return null; }
}

export function prependBriefPayload(payload: BriefPayload, prefix: string): BriefPayload {
  const parsed = parseBriefContext(prefix);
  if (!parsed || parsed.input || parsed.prefixLength !== prefix.length) throw Error('保存的简要历史无法读取，请检查原会话。');
  if (bytes(prefix + payload.input) > MAX_INPUT_BYTES) throw Error('当前草稿过长，无法携带简要历史；请缩短草稿后重试。');
  return {
    input: prefix + payload.input,
    ...(payload.attachments ? {attachments: payload.attachments.map(item => ({...item, ...(item.offset === undefined ? {} : {offset: item.offset + prefix.length})}))} : {}),
    ...(payload.batch ? {batch: payload.batch.map((part, index) => index ? part : {...part, length: part.length + prefix.length})} : {}),
  };
}

type CollectedMessage = BriefMessage & {promptKey?: number; inputClipped?: boolean};
type CollectedTurn = BriefTurn & {promptKey?: number};

function historyTurns(messages: CollectedMessage[], promptKey: (label: string, input: string) => number | undefined,
  freshKey: () => number): {turns: CollectedTurn[]; truncated: boolean; olderOmitted: boolean} {
  const turns: CollectedTurn[] = [];
  let current: CollectedTurn | undefined, truncated = false, olderOmitted = false;
  for (const message of messages) {
    if (message.queued || message.streaming || message.phase === 'error') continue;
    if (message.role === 'user') {
      const prior = parseBriefContext(message.text);
      if (prior) {
        const previous: CollectedTurn[] = [];
        for (const turn of prior.context.turns) {
          const original = turn.input_ref ? previous[turn.input_ref - 1] : undefined;
          const input = original?.input ?? turn.input;
          const inputTruncated = original?.input_truncated || turn.input_truncated;
          const key = original?.promptKey ?? (turn.scheduled_task
            ? inputTruncated ? freshKey() : promptKey(turn.scheduled_task, input)
            : undefined);
          previous.push({input, ...(turn.scheduled_task ? {scheduled_task: turn.scheduled_task} : {}),
            ...(inputTruncated ? {input_truncated: true} : {}), ...(key === undefined ? {} : {promptKey: key}),
            ...(turn.progress ? {progress: turn.progress} : {}), ...(turn.conclusion ? {conclusion: turn.conclusion} : {}),
            ...(turn.attachments?.length ? {attachments: turn.attachments} : {})});
        }
        turns.push(...previous);
        truncated ||= prior.context.truncated;
        olderOmitted ||= prior.context.older_omitted || prior.context.omitted_turns > 0;
      }
      const input = prior ? prior.input : message.text;
      if (!prior && automaticConversationContext(input)) continue;
      const attachments = message.attachments?.slice(0, 8).map(({kind,name,path}) => ({
        kind, name: excerpt(name, 255), path: excerpt(path, 1024),
      }));
      if (!input.trim() && !attachments?.length) continue;
      const clipped = excerpt(input, MAX_FIELD_CHARS);
      truncated ||= clipped !== input;
      const label = message.input_source?.kind === 'scheduled' && message.input_source.label && message.input_source.label.length <= 120
        ? message.input_source.label : undefined;
      current = {input: clipped, ...(label ? {scheduled_task: label} : {}),
        ...(label && (message.inputClipped || clipped !== input) ? {input_truncated: true} : {}),
        ...(message.promptKey === undefined ? {} : {promptKey: message.promptKey}),
        ...(attachments?.length ? {attachments} : {})};
      turns.push(current);
    } else if (current && message.text.trim()) {
      if (message.phase !== 'final' || message.presentation === 'compaction_summary') {
        // Keep one short, visible progress message; tool output and thinking are not copied.
        current.progress = excerpt(message.text, MAX_PROGRESS_CHARS);
        truncated ||= current.progress !== message.text;
      } else {
        const clipped = excerpt(message.text, MAX_FIELD_CHARS);
        truncated ||= clipped !== message.text;
        current.conclusion = clipped;
      }
    }
  }
  return {turns, truncated, olderOmitted};
}

function makePrefix(turns: CollectedTurn[], inheritedTruncation: boolean, olderOmitted: boolean, draft: string): string {
  const budget = Math.min(MAX_CONTEXT_BYTES, MAX_INPUT_BYTES - bytes(draft));
  if (budget < 512) throw Error('当前草稿过长，无法携带简要历史；请缩短草稿后重试。');
  let omitted = 0;
  const render = (limit: number) => {
    let truncated = inheritedTruncation;
    const prompts = new Map<number, number>(), differences = new Map<number, number>();
    const candidates = turns.slice(omitted).map((turn, index) => {
      const input = excerpt(turn.input, limit), conclusion = turn.conclusion === undefined ? undefined : excerpt(turn.conclusion, limit);
      const progress = turn.progress === undefined ? undefined : excerpt(turn.progress, Math.min(limit, MAX_PROGRESS_CHARS));
      truncated ||= input !== turn.input || conclusion !== turn.conclusion || progress !== turn.progress;
      const attachments = turn.attachments?.map(item => {
        const name = excerpt(item.name, Math.max(32, limit)), path = excerpt(item.path, Math.max(64, limit * 2));
        truncated ||= name !== item.name || path !== item.path;
        return {...item,name,path};
      });
      const plain = {input, ...(progress ? {progress} : {}), ...(conclusion ? {conclusion} : {}), ...(attachments?.length ? {attachments} : {})};
      const key = turn.scheduled_task ? turn.promptKey : undefined;
      if (key === undefined) return {plain};
      const inputRef = prompts.get(key);
      if (inputRef === undefined) prompts.set(key, index + 1);
      const shared = {input: inputRef === undefined ? input : `同第 ${inputRef} 轮定时任务提示词`,
        ...(inputRef === undefined ? {} : {input_ref: inputRef}),
        scheduled_task: turn.scheduled_task,
        ...(inputRef === undefined && (turn.input_truncated || input !== turn.input) ? {input_truncated: true} : {}),
        ...(progress ? {progress} : {}), ...(conclusion ? {conclusion} : {}), ...(attachments?.length ? {attachments} : {})};
      differences.set(key, (differences.get(key) || 0) + bytes(JSON.stringify(shared)) - bytes(JSON.stringify(plain)));
      return {plain, shared, key};
    });
    // A reference and its provenance also consume input. Use them only when
    // the entire group becomes smaller, and keep every run in either form.
    const selected = candidates.map(item => item.key !== undefined && (differences.get(item.key) || 0) < 0 ? item.shared! : item.plain);
    const context: BriefContext = {version: 1, turns: selected, truncated, older_omitted: olderOmitted, omitted_turns: omitted};
    return START + JSON.stringify(context) + END;
  };
  if (bytes(render(32)) > budget) {
    let first = 0, last = turns.length;
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      omitted = middle;
      if (bytes(render(32)) <= budget) last = middle;
      else first = middle + 1;
    }
    omitted = first;
  }
  if (omitted === turns.length) throw Error('当前草稿过长，无法携带简要历史；请缩短草稿后重试。');
  let low = 32, high = MAX_FIELD_CHARS;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(render(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return render(low);
}

/** Read existing paginated history only. Never start an Agent turn to summarize. */
export async function prepareBriefSend(sessionId: string, nativeId: string, payload: BriefPayload, readPage: BriefHistoryReader): Promise<BriefPayload> {
  let before: string | undefined, generation: string | null | undefined, olderOmitted = false, collectedTruncation = false;
  const pages: CollectedMessage[][] = [], cursors = new Set<string>();
  // Compare the original text before clipping, with a bounded exact-match index.
  // When it fills, keep remaining prompts independently rather than guessing.
  const promptKeys = new Map<string, number>();
  let nextKey = 0, promptKeysBytes = 0;
  const freshKey = () => ++nextKey;
  const promptKey = (label: string, input: string): number | undefined => {
    // Scheduled task creation already caps prompts at 100,000 characters.
    if (input.length > 100_000) return undefined;
    const key = JSON.stringify([label, input]);
    const known = promptKeys.get(key);
    if (known !== undefined) return known;
    const size = bytes(key);
    if (promptKeysBytes + size > MAX_PROMPT_KEYS_BYTES) return undefined;
    const id = freshKey();
    promptKeys.set(key, id); promptKeysBytes += size;
    return id;
  };
  for (let pageNumber = 0, emptyPages = 0; pageNumber < MAX_PAGES;) {
    const page = await readPage({limit: '80', ...(before ? {before} : {})});
    if (!page.available || page.native_id !== nativeId || page.session_id !== sessionId)
      throw Error('无法读取原会话历史，简要压缩未执行，草稿已保留。');
    if (generation !== undefined && (page.reset || page.generation !== generation))
      throw Error('会话历史已变化，请重新发送后再试。');
    generation = page.generation;
    if (!page.messages.length) {
      if (!page.has_more) break;
      // The file reader scans a bounded slice per read. Tool-only slices can
      // advance that scan without yielding a message to use as a new cursor.
      if (++emptyPages > MAX_EMPTY_PAGES) throw Error('会话历史分页不完整，简要压缩未执行。');
      continue;
    }
    const next = page.messages[0].id;
    if (!next || cursors.has(next)) throw Error('会话历史分页不完整，简要压缩未执行。');
    pageNumber++;
    // Keep bounded excerpts in memory even when individual native messages are large.
    pages.push(page.messages.map(message => {
      const prior = parseBriefContext(message.text);
      const text = prior ? message.text : excerpt(message.text, MAX_FIELD_CHARS * 2);
      if (text !== message.text && (message.role === 'user' || message.phase !== 'commentary')) collectedTruncation = true;
      const attachments = message.attachments?.slice(0, 8).map(({kind,name,path}) => {
        const shortName=excerpt(name,255),shortPath=excerpt(path,1024);
        collectedTruncation ||= shortName!==name||shortPath!==path;
        return {kind,name:shortName,path:shortPath};
      });
      const label = message.role === 'user' && !prior && message.input_source?.kind === 'scheduled' &&
        message.input_source.label && message.input_source.label.length <= 120 ? message.input_source.label : undefined;
      const key = label ? promptKey(label, message.text) : undefined;
      return {id:message.id,role:message.role,timestamp:message.timestamp,text,phase:message.phase,
        presentation:message.presentation,queued:message.queued,streaming:message.streaming,attachments,
        ...(label ? {input_source:{kind:'scheduled',label}, inputClipped:text !== message.text} : {}),
        ...(key === undefined ? {} : {promptKey:key})};
    }));
    if (!page.has_more) break;
    cursors.add(next);
    before = next;
    if (pageNumber === MAX_PAGES) olderOmitted = true;
  }
  const history = historyTurns(pages.reverse().flat(), promptKey, freshKey);
  if (!history.turns.length) throw Error('没有可用的对话记录，简要压缩未执行。');
  const prefix = makePrefix(history.turns, history.truncated || collectedTruncation, olderOmitted || history.olderOmitted, payload.input);
  return prependBriefPayload(payload, prefix);
}
