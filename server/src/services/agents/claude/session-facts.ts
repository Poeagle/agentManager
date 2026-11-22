import type { AgentSessionFactsPort, NativeRequestFact, NativeSessionFact } from '../session-facts.js';
import { factId, factString, nativeItemId, recordType } from '../session-fact-values.js';
import { statisticsFiles } from '../statistics-inventory.js';
import { NATIVE_SESSION_ID_RE } from '../native-identifiers.js';
import { getDb } from '../../../db/index.js';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { estimatePublicApiCost } from '../model-pricing.js';
import { readClaudeRuntimeProvider } from './providers.js';

interface Assistant {
  id: string;
  turn: string;
  at: string | null;
  offset: number;
  model: string | null;
  speed: string | null;
  tokens: NativeRequestFact['tokens'];
  cacheWrites?: readonly [number,number] | null;
  tools: string[];
  endedTools?: string[];
  visible: boolean;
  outcome?: 'completed' | 'unknown';
  incomplete?: boolean;
}
interface ClaudeFactsState {
  turn: string | null;
  created: boolean;
  model: string | null;
  speed: string | null;
  assistant?: Assistant;
  lastSettledAssistant?: string;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function claudeRequestUsage(usage: Record<string, unknown> | null | undefined): NativeRequestFact['tokens'] {
  if (!usage || typeof usage !== 'object') return null;
  const input = count(usage.input_tokens);
  const read = Object.hasOwn(usage, 'cache_read_input_tokens') ? count(usage.cache_read_input_tokens) : 0;
  const write = Object.hasOwn(usage, 'cache_creation_input_tokens') ? count(usage.cache_creation_input_tokens) : 0;
  const output = count(usage.output_tokens);
  const fullInput = input === null || read === null || write === null ? null : input + read + write;
  if (fullInput === null && output === null) return null;
  return {
    input_tokens: fullInput,
    cached_input_tokens: read,
    output_tokens: output,
    reasoning_output_tokens: null,
    total_tokens: fullInput === null || output === null ? null : fullInput + output,
  };
}

export const claudeSessionFacts: AgentSessionFactsPort = {
  revision: 5,
  async *discover() {
    const bindings = getDb().prepare(`SELECT DISTINCT COALESCE(native_session_id,claude_session_id) AS id,
      agent_environment_id AS environment FROM sessions WHERE COALESCE(agent_id,cli_type)='claude'
      AND COALESCE(native_session_id,claude_session_id) IS NOT NULL`).all() as Array<{id:string;environment:string|null}>;
    const byId = new Map(bindings.map(binding => [binding.id, binding.environment]));
    for await(const path of statisticsFiles(join(homedir(),'.claude','projects'), 1)){
      const id = basename(path,'.jsonl');
      if (!NATIVE_SESSION_ID_RE.test(id)) continue;
      yield {path, context: {session:{agent_id:'claude',agent_environment_id:byId.get(id)}, nativeId:id, projectPath:null}};
    }
  },
  recordLimit: header => recordType(header) === 'user' ? 16 * 1024 * 1024 : 512 * 1024,
  oversized: header => /"type"\s*:\s*"tool_result"/.test(header.toString()) ? [] : [
    {kind: 'gap', reason: 'unreadable_record'},
  ],
  decode(record, {at, offset, context}, prior) {
    const state = prior as ClaudeFactsState | null ?? {turn: null, created: false, model: null, speed: null};
    const facts: NativeSessionFact[] = [];
    const result = () => ({state, facts});
    const message = record.message;
    if (record.isSidechain === true || record.isMeta === true || message?.model === '<synthetic>') return result();
    if (record.type !== 'user' && record.type !== 'assistant' && record.type !== 'system' && record.type !== 'result') return result();

    function settle(phase: 'progress' | 'final' | 'unknown' = 'unknown') {
      const group = state.assistant;
      if (!group) return;
      delete state.assistant;
      state.lastSettledAssistant = group.id;
      if (group.outcome) phase = group.outcome === 'completed' ? 'final' : 'progress';
      const declared = factString(context.session.agent_environment_id);
      const dimensions = {model: group.model, speed: group.speed, environment: declared, account: null};
      if (state.model && group.model && state.model !== group.model)
        facts.push({kind: 'lifecycle', event: {action: 'model', state: 'completed', at: group.at, turn_id: group.turn, dimensions}});
      if (state.speed && group.speed && state.speed !== group.speed)
        facts.push({kind: 'lifecycle', event: {action: 'speed', state: 'completed', at: group.at, turn_id: group.turn, dimensions}});
      state.model = group.model;
      state.speed = group.speed;
      if (group.incomplete) facts.push({kind: 'gap', reason: 'missing_usage'});
      if (group.visible) facts.push({
        kind: 'item', id: nativeItemId('assistant', group.id), turn_id: group.turn, at: group.at,
        phase: phase === 'unknown' && group.tools.length ? 'progress' : phase, source_offset: group.offset,
      });
      for (const id of group.tools) facts.push({kind: 'tool', id, turn_id: group.turn});
      const provider=declared?readClaudeRuntimeProvider(context.session,context.environmentAccess):null;
      const official=provider&&/^https:\/\/api\.anthropic\.com\/*$/.test(provider.baseUrl);
      const estimate=official&&group.cacheWrites&&(!group.speed||group.speed==='standard')?estimatePublicApiCost('claude',group.model,group.at,group.tokens,group.cacheWrites):null;
      facts.push({kind: 'request', source_offset: group.offset, request: {
        id: group.id, at: group.at, turn_id: group.turn, tokens: group.tokens, dimensions, cost: official?{unit:'USD',basis:'api',amount:estimate?.amount??null,breakdown:estimate?.breakdown,complete:estimate!==null}:null, evidence: 'request',
      }});
      for (const id of group.endedTools ?? []) facts.push({kind: 'tool_end', id, turn_id: group.turn});
      if (group.outcome) {
        facts.push({kind: 'end', turn_id: group.turn, at: group.at, outcome: group.outcome});
        if (state.turn === group.turn) state.turn = null;
      }
    }

    const blocks: Array<Record<string, unknown>> = Array.isArray(message?.content)
      ? message.content.filter((block: unknown) => block && typeof block === 'object') : [];
    if (record.type === 'user') {
      if (message?.role !== 'user') return result();
      const toolResults = blocks.filter(block => block.type === 'tool_result');
      if (toolResults.length) {
        // Fast tools can return before Claude writes the remaining sibling blocks.
        // Keep collecting the same assistant ID until a new request begins.
        for (const block of toolResults) {
          const id = factString(block.tool_use_id);
          if (!id || !state.turn) continue;
          if (state.assistant?.tools.includes(id)) {
            const ended = state.assistant.endedTools ??= [];
            if (!ended.includes(id)) ended.push(id);
          } else facts.push({kind: 'tool_end', id, turn_id: state.turn});
        }
        return result();
      }
      const visible = typeof message.content === 'string' ? message.content :
        blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (/^\[Request interrupted by user(?: for tool use)?\]\s*$/.test(visible)) {
        settle();
        if (state.turn) facts.push({kind: 'end', turn_id: state.turn, at, outcome: 'interrupted'});
        state.turn = null;
        return result();
      }
      if (record.isCompactSummary || record.isVisibleInTranscriptOnly ||
        record.origin?.kind && record.origin.kind !== 'human' ||
        /^This session is being continued from a previous conversation that ran out of context\./i.test(visible)) return result();
      settle();
      const input = factString(record.uuid);
      if (!input) {
        facts.push({kind: 'gap', reason: 'missing_start'});
        return result();
      }
      if (!state.created) {
        state.created = true;
        facts.push({kind: 'lifecycle', id: factId('create', context.nativeId), event: {action: 'create', state: 'completed', at}});
      }
      state.turn = input;
      facts.push({kind: 'start', turn_id: input, at}, {kind: 'input', id: nativeItemId('user', input), turn_id: input, at});
      return result();
    }
    if (record.type === 'assistant' && message?.role === 'assistant') {
      const id = factString(message.id);
      if (!id) {
        facts.push({kind: 'gap', reason: 'missing_usage'});
        return result();
      }
      if (id === state.lastSettledAssistant) return result();
      if (state.assistant && state.assistant.id !== id) settle();
      const turn = state.turn ?? factString(record.parentUuid) ?? factId('turn', context.nativeId, offset);
      const tools = blocks.filter(block => block.type === 'tool_use' || block.type === 'server_tool_use');
      const visible = blocks.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim()) || tools.length > 0;
      const current = state.assistant ?? {id, turn, tokens: null, tools: [], visible: false, at, offset, model: null, speed: null};
      current.at = at ?? current.at;
      current.visible ||= visible;
      current.model = factString(message.model, 120) ?? current.model;
      current.speed = factString(message.usage?.service_tier ?? message.service_tier, 120) ?? current.speed;
      const usage=claudeRequestUsage(message.usage);
      if(usage){
        current.tokens=usage;
        const writes=message.usage.cache_creation_input_tokens??0;
        const short=count(message.usage.cache_creation?.ephemeral_5m_input_tokens);
        const long=count(message.usage.cache_creation?.ephemeral_1h_input_tokens);
        current.cacheWrites=writes===0?[0,0]:short!==null&&long!==null&&short+long===writes?[short,long]:null;
      }
      for (const block of tools) {
        const key = factString(block.id);
        if (!key) current.incomplete = true;
        else if (!current.tools.includes(key)) current.tools.push(key);
      }
      state.assistant = current;
      if (message.stop_reason === 'end_turn') current.outcome = 'completed';
      else if (message.stop_reason && message.stop_reason !== 'tool_use' && message.stop_reason !== 'pause_turn')
        current.outcome = 'unknown';
      // Claude copies the stop reason and usage onto each content block.
      // An initial thinking block can arrive before the visible final text.
      if (current.outcome && current.visible) settle();
      return result();
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      settle();
      facts.push({kind: 'lifecycle', id: factString(record.uuid) ?? undefined, event: {action: 'compact', state: 'completed', at, turn_id: state.turn}});
    }
    if (record.type === 'result' && state.turn) {
      const outcome = record.subtype === 'success' && !record.is_error ? 'completed' : 'unknown';
      settle(outcome === 'completed' && !state.assistant?.tools.length ? 'final' : 'unknown');
      if (state.turn) facts.push({kind: 'end', turn_id: state.turn, at, outcome});
      state.turn = null;
    }
    return result();
  },
};
