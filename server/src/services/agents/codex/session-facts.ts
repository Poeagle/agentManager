import { createHash } from 'node:crypto';
import { readFilePrefix } from '../file-prefix.js';
import { statisticsFiles } from '../statistics-inventory.js';
import { basename, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { AgentSessionFactsPort, NativeFactLocation, NativeRequestFact, NativeSessionFact, RequestDimensions } from '../session-facts.js';
import { consistentUsage, factId, factString, factTime, nativeItemId, parsedUsage, recordType } from '../session-fact-values.js';
import { recordedPricingSettings } from './statistics-settings.js';
import { codexMessagePhase } from './text.js';
import { costSnapshot, emptyCostTotals, recordCost } from './statistics-cost.js';

interface Input {
  id: string;
  digest: string | null;
  turn: string;
  at: string | null;
  source: 'response_item' | 'item_completed' | 'user_message';
  clientId?: string;
}
interface CodexFactsState {
  dimensions: RequestDimensions;
  turn: string | null;
  started: boolean;
  inherited: boolean;
  forkAfter: string | null;
  forkOrdinal: number | null;
  previousTotal: ReturnType<typeof parsedUsage>;
  primarySinceCount: boolean;
  recentReceipts: string[];
  requestContexts: Array<{turn: string; dimensions: RequestDimensions}>;
  lastInput?: Input;
  pendingInput?: Input;
}

const tools = new Set(['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call', 'local_shell_call']);
const textDigest = (value: unknown) => typeof value === 'string' && value.trim() ? factId(value.trim()) : null;
const itemText = (content: unknown, types: string[]) => Array.isArray(content)
  ? content.filter(block => types.includes(block?.type) && typeof block.text === 'string')
    .map(block => block.text.trim()).filter(Boolean).join('\n')
  : '';

export const codexSessionFacts: AgentSessionFactsPort = {
  revision: 2,
  async *discover() {
    const { allCodexEnvironments } = await import('./environments.js');
    const { localHome } = await import('./account-files.js');
    const environments = allCodexEnvironments().filter(environment => environment.enabled && environment.kind !== 'account');
    const homes = await Promise.all(environments.map(async environment => ({
      environment, root: await realpath(localHome(environment)).catch(() => null),
    })));
    for (const {environment, root} of homes) {
      if (!root || homes.filter(candidate => candidate.root === root).length !== 1) continue;
      for (const directory of ['sessions','archived_sessions']) {
        for await (const path of statisticsFiles(join(root,directory), 5)) {
          const id = /^rollout-.*?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(basename(path))?.[1];
          if (!id) continue;
          // A paged fork is projected from its authorized flattened mirror.
          const sample = readFilePrefix(path, 4096);
          if (sample.split('\n',1)[0].includes('"history_base"')) continue;
          yield {path, context: {session: {agent_id:'codex', agent_environment_id:environment.id}, nativeId:id, projectPath:null}};
        }
      }
    }
  },
  async preserveAccountUsage(context) {
    if (!context.nativeId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context.nativeId)) return;
    const { initAccountUsage, collectAccountUsage } = await import('./account-usage.js');
    initAccountUsage();
    await collectAccountUsage(context.session.agent_environment_id || 'native', {nativeId: context.nativeId});
  },
  recordLimit: header => {
    const kind = recordType(header);
    const prefix = header.toString();
    return kind === 'session_meta' || kind === 'turn_context' || kind === 'compacted' ||
      (kind === 'response_item' && /"role"\s*:\s*"user"/.test(prefix)) ||
      (kind === 'event_msg' && /"(?:UserMessage|user_message)"/.test(prefix))
      ? 16 * 1024 * 1024 : 512 * 1024;
  },
  oversized: (header, context) => {
    const kind = recordType(header);
    if (kind === 'compacted') return [{kind: 'lifecycle', event: {action: 'compact', state: 'completed', at: recordTimestamp(header)}}];
    if (kind === 'response_item' && /"(?:function_call_output|custom_tool_call_output|reasoning)"/.test(header.toString())) return [];
    return [{kind: 'gap', reason: 'unreadable_record', affectsUsage: !!context.nativeId}];
  },
  decode(record, location, previous) {
    const { at, offset, context } = location;
    const payload = record.payload;
    const kind = record.type;
    const type = kind === 'event_msg' ? payload?.type : null;
    const environment = context.session.agent_environment_id || 'native';
    const state = previous as CodexFactsState | null ?? {
      dimensions: {model: null, speed: 'default', environment, account: null},
      turn: null, started: false, inherited: false, forkAfter: null, forkOrdinal: null,
      previousTotal: null, primarySinceCount: false, recentReceipts: [], requestContexts: [],
    };
    const facts: NativeSessionFact[] = [];
    const result = () => ({state, facts});
    if ((kind === 'event_msg' || kind === 'response_item' || kind === 'token_usage_record' ||
      kind === 'session_meta' || kind === 'turn_context') && (!payload || typeof payload !== 'object')) {
      facts.push({kind: 'gap', reason: 'unreadable_record'});
      return result();
    }
    const declaredTurn = factString(payload?.turn_id);
    const responseTurn = factString(payload?.internal_chat_message_metadata_passthrough?.turn_id);
    // A response echo can carry a model-side ID while the lifecycle and usage
    // records still identify the same active app-server turn.
    const turn = (declaredTurn === context.nativeId ? null : declaredTurn) ??
      (kind === 'response_item' && state.started ? state.turn : null) ??
      (responseTurn === context.nativeId ? null : responseTurn) ?? state.turn;
    if (kind === 'session_meta') {
      const id = factString(payload.id);
      const inherited = !!id && !!context.nativeId && id !== context.nativeId;
      state.inherited = inherited;
      state.forkAfter = payload.forked_from_id ? factTime(payload.timestamp) ?? at : null;
      state.forkOrdinal = Number.isSafeInteger(payload.forked_from_ordinal_exclusive) ? payload.forked_from_ordinal_exclusive : null;
      const nextDimensions = {
        model: null, speed: 'default', environment: inherited ? null : environment,
        account: factString(payload.creator_account_id) ? 'acct-' + factId(payload.creator_account_id).slice(0, 10) : null,
      };
      if (state.dimensions.account && nextDimensions.account && state.dimensions.account !== nextDimensions.account)
        facts.push({kind: 'lifecycle', event: {action: 'account', state: 'completed', at, dimensions: nextDimensions}});
      state.dimensions = nextDimensions;
      if (!inherited) facts.push({kind: 'lifecycle', id: factId('create', id), event: {
        action: 'create', state: 'completed', at: factTime(payload.timestamp) ?? at,
        related_native_id: factString(payload.history_base?.thread_id ?? payload.forked_from_id) ?? undefined,
      }});
    }
    const settings = recordedPricingSettings(record);
    if (settings) {
      const next = {...state.dimensions};
      if (Object.hasOwn(settings, 'model')) next.model = factString(settings.model, 120);
      if (Object.hasOwn(settings, 'service_tier')) next.speed = factString(settings.service_tier, 120) ?? 'default';
      for (const [dimension, action] of [['model', 'model'], ['speed', 'speed']] as const) {
        if (state.dimensions[dimension] !== null && next[dimension] !== null && next[dimension] !== state.dimensions[dimension])
          facts.push({kind: 'lifecycle', event: {action, state: 'completed', at, turn_id: turn, dimensions: next}});
      }
      state.dimensions = next;
    }

    if (type === 'task_started' && turn) {
      flushInput(state, facts);
      state.turn = turn;
      state.started = true;
      state.lastInput = undefined;
      facts.push({kind: 'start', turn_id: turn, at});
      return result();
    }
    if (kind === 'turn_context' && turn && turn !== state.turn) {
      state.turn = turn;
      state.started = false;
      state.lastInput = undefined;
    }

    const item = type === 'item_completed' ? payload.item : kind === 'response_item' ? payload : null;
    if (turn && type === 'item_started' && payload.item?.type === 'AgentMessage') {
      const id = factString(payload.item.id);
      if (id) facts.push({kind: 'item_start', id: nativeItemId('assistant', id), turn_id: turn});
      return result();
    }
    const userItem = item?.type === 'UserMessage' || item?.type === 'message' && item?.role === 'user';
    if (turn && (type === 'user_message' || userItem && (state.started || type === 'item_completed'))) {
      const source = userItem ? kind === 'response_item' ? 'response_item' : 'item_completed' : 'user_message';
      const native = factString(userItem ? item.id : payload.item_id);
      const input: Input = {
        id: native ? nativeItemId('user', native) : createHash('sha256').update(offset+':user').digest('hex').slice(0,32),
        digest: textDigest(userItem ? itemText(item.content, ['text', 'Text', 'input_text']) : payload.message),
        turn, at, source,
        clientId: factString(item?.client_id ?? item?.clientId ?? payload.client_id) ?? undefined,
      };
      const other = state.pendingInput ?? state.lastInput;
      const echo = other?.turn === turn && (other.id === input.id ||
        other.source !== input.source && other.digest !== null && other.digest === input.digest);
      if (echo && state.pendingInput && native) {
        state.pendingInput = undefined;
        pushInput(state, facts, input);
      } else if (!echo) {
        flushInput(state, facts);
        if (source === 'user_message' && !native) state.pendingInput = input;
        else pushInput(state, facts, input);
      } else if (echo && input.clientId && other && !other.clientId) {
        other.clientId = input.clientId;
        facts.push({kind: 'lifecycle', id: factId('input-proof', other.id), event: {
          action: 'input', state: 'accepted', message_id: other.id, client_id: input.clientId, at: other.at, turn_id: turn,
        }});
      }
      return result();
    }
    const assistant = item?.type === 'AgentMessage' || item?.type === 'message' && item?.role === 'assistant';
    if (turn && assistant) {
      flushInput(state, facts);
      captureRequestContext(state, turn);
      const native = factString(item.id);
      const digest = textDigest(itemText(item.content, ['text', 'Text', 'output_text']));
      const phase = codexMessagePhase(item.phase, item.delivery);
      const final = phase === 'final' && !item.questions?.length && !!digest;
      if (digest || native) facts.push({
        kind: 'item', id: native ? nativeItemId('assistant', native) : factId('item', context.nativeId, offset),
        turn_id: turn, at, phase: final ? 'final' : phase === 'commentary' || (item.phase && item.phase !== 'unknown') ? 'progress' : 'unknown',
        ...(digest ? {digest} : {}),
      });
      return result();
    }
    if (turn && kind === 'response_item' && tools.has(payload.type)) {
      flushInput(state, facts);
      captureRequestContext(state, turn);
      facts.push({kind: 'tool', id: factString(payload.call_id ?? payload.id) ?? factId('tool', offset), turn_id: turn});
      return result();
    }
    if (turn && kind === 'response_item' && typeof payload.type === 'string' && payload.type.endsWith('_call_output')) {
      const id = factString(payload.call_id);
      if (id) facts.push({kind: 'tool_end', id, turn_id: turn});
      return result();
    }

    if (kind === 'token_usage_record') {
      flushInput(state, facts);
      const id = factString(payload.response_id);
      if (!id) facts.push({kind: 'gap', reason: 'missing_usage'});
      else {
        if (state.recentReceipts.includes(id)) return result();
        state.recentReceipts.push(id);
        if (state.recentReceipts.length>64)state.recentReceipts.shift();
        state.primarySinceCount = true;
        const tokens = parsedUsage(payload.usage);
        facts.push({kind: 'request', request: receipt(id, tokens, 'request', turn, location, state, record.ordinal, payload)});
      }
    }
    if (type === 'token_count' && payload.info) {
      flushInput(state, facts);
      const total = parsedUsage(payload.info.total_token_usage);
      const previous = state.previousTotal;
      const echo = state.primarySinceCount;
      state.previousTotal = total ?? previous;
      state.primarySinceCount = false;
      if (echo || total && JSON.stringify(total) === JSON.stringify(previous)) return result();
      const last = parsedUsage(payload.info.last_token_usage);
      if (!total || !last) facts.push({kind: 'gap', reason: 'missing_usage'});
      else {
        const mismatch = previous && Object.keys(total).some(key => {
          const field = key as keyof typeof total;
          return total[field] !== null && previous[field] !== null && last[field] !== null &&
            total[field]! - previous[field]! !== last[field];
        });
        // A cumulative jump does not prove how many requests are missing.
        if (mismatch) facts.push({kind: 'gap', reason: 'counter_mismatch'});
        facts.push({kind: 'request', request: receipt(
          factId('legacy', turn ?? at ?? offset, total), last, 'legacy', turn, location, state, record.ordinal, payload,
        )});
      }
    }
    if (kind === 'compacted' || type === 'context_compacted') {
      const action = kind === 'compacted' ? 'completed' : 'accepted';
      const compactionRequest = kind === 'compacted' ? factString(payload?.compaction_response_id) : null;
      facts.push({kind: 'lifecycle', id: compactionRequest ?? factString(payload?.window_id) ?? undefined,
        ...(compactionRequest ? {related_request_id: compactionRequest} : {}),
        event: {action: 'compact', state: action, at, turn_id: turn}});
    }
    if (turn && (type === 'task_complete' || type === 'turn_aborted')) {
      flushInput(state, facts);
      const outcome = type === 'turn_aborted' ? 'interrupted' : payload.error ? 'unknown' : 'completed';
      const digest = textDigest(payload.last_agent_message);
      facts.push({kind: 'end', turn_id: turn, at, outcome, ...(digest ? {final_digest: digest} : {})});
      state.started = false;
      state.turn = null;
      state.lastInput = undefined;
    }
    return result();
  },
};

function receipt(
  id: string, tokens: NativeRequestFact['tokens'], evidence: NativeRequestFact['evidence'],
  turn: string | null, {at, context}: NativeFactLocation, state: CodexFactsState, ordinal: unknown, payload: Record<string, unknown>,
): NativeRequestFact {
  const inherited = state.inherited ||
    !!(at && state.forkAfter && at <= state.forkAfter) ||
    !!(state.forkOrdinal !== null && typeof ordinal === 'number' && ordinal < state.forkOrdinal);
  const requestContext = state.requestContexts.find(candidate=>candidate.turn===turn);
  const dimensions = {...(requestContext?.dimensions ?? state.dimensions)};
  if (requestContext) state.requestContexts = state.requestContexts.filter(candidate=>candidate!==requestContext);
  else if (turn && state.turn && turn!==state.turn) {
    dimensions.model = null;
    dimensions.speed = null;
  }
  if (inherited) dimensions.environment = null;
  if (Object.hasOwn(payload, 'model')) dimensions.model = factString(payload.model,120);
  if (Object.hasOwn(payload, 'service_tier')) dimensions.speed = factString(payload.service_tier,120) ?? 'default';
  const total = emptyCostTotals();
  const credits = !context.session.agent_environment_id?.startsWith('provider:');
  if (credits && tokens && consistentUsage(tokens)) recordCost(total, dimensions.model, dimensions.speed, tokens);
  return {id, turn_id: turn, at, tokens, evidence, dimensions, ...(inherited ? {inherited} : {}), cost: credits ? costSnapshot(total) : null};
}

function captureRequestContext(state: CodexFactsState, turn: string) {
  if(state.requestContexts.some(candidate=>candidate.turn===turn))return;
  state.requestContexts.push({turn,dimensions:{...state.dimensions}});
  if(state.requestContexts.length>8)state.requestContexts.shift();
}

function pushInput(state: CodexFactsState, facts: NativeSessionFact[], input: Input) {
  state.lastInput = input;
  facts.push({kind: 'input', id: input.id, turn_id: input.turn, at: input.at, client_id: input.clientId});
}
function flushInput(state: CodexFactsState, facts: NativeSessionFact[]) {
  if (state.pendingInput) pushInput(state, facts, state.pendingInput);
  state.pendingInput = undefined;
}
function recordTimestamp(header: Buffer) {
  return factTime(/"timestamp"\s*:\s*"([^"]+)"/.exec(header.toString())?.[1]);
}
