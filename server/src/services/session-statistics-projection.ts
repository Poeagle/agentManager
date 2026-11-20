import { consistentUsage, factId } from './agents/session-fact-values.js';
import type {
  NativeRequestFact, NativeSessionFact, RequestDimensions, SessionActivityContext, SessionCacheDrop, SessionCacheSample,
  SessionCoverageReason, SessionLifecycleFact, SessionMetadata, SessionModelTotals,
} from './agents/session-facts.js';
import type { AgentProgressSegment, AgentProgressStatistics, AgentStatistics } from './agents/types.js';
import { cacheDimensionChanges, cacheSample, detectCacheDrop } from './session-cache-drop.js';
import { copyCounter, countRequest, counterReasons, emptyCounter, recordedInterval, usageTotals, type StatisticsCounter } from './session-statistics-totals.js';

type Item = Extract<NativeSessionFact, { kind: 'item' }> & { offset: number };
type End = Extract<NativeSessionFact, { kind: 'end' }>;
interface Input { id: string; at: string | null; sampled: boolean; ambiguous: boolean }
interface Point { counter: StatisticsCounter; at: string | null; id?: string; offset?: number }
interface Progress {
  id: string;
  start_at: string | null;
  counter: StatisticsCounter;
  seen: boolean;
  last?: Item;
  completed?: Item;
  final?: Item;
  item_end?: Point;
  close?: {at: string | null; reason: 'input' | 'compact'};
}
interface Turn {
  id: string;
  start: Point;
  verified: boolean;
  input?: Input;
  inputCount: number;
  items: Item[];
  activeItems: string[];
  tools: string[];
  activeTools: string[];
  groupInput?: string;
  progress: Progress;
  heldProgress?: Progress;
  last?: Item;
  unknownTail?: {item: Item; point: Point; shared: number; beforeRequest: Point;
    beforeProgress?: StatisticsCounter; previousItem?: Point; previousCompleted?: Item};
  ended?: End;
  answered?: boolean;
  progressedAt?: Point;
}
export interface SessionProjectionState {
  total: StatisticsCounter;
  replacingSource?: boolean;
  first?: Point;
  item?: Point;
  progress?: Point;
  final?: Point;
  turn?: Turn;
  suspended: Turn[];
  previousInputSample?: SessionCacheSample;
  previousRequestSample?: SessionCacheSample;
  lastCompactionAt?: string | null;
  sampledCompactions: number;
  compactions: number;
  latest: NativeRequestFact | null;
  inputs: number;
  answers: number;
  anomalyCount: number;
  reasons: SessionCoverageReason[];
}
export interface ProjectionSink {
  seen(kind: 'input' | 'tool', id: string): boolean;
  request(request: NativeRequestFact, offset: number, inputId: string | null, tools: number): boolean;
  readItem(id: string): AgentStatistics | undefined;
  saveItem(statistics: AgentStatistics): void;
  event(fact: SessionLifecycleFact, offset: number): boolean;
  anomaly(drop: SessionCacheDrop, offset: number): void;
  model(request: NativeRequestFact, tools: number): void;
}

export function newProjection(): SessionProjectionState {
  return {total: emptyCounter(), suspended: [], sampledCompactions: 0, compactions: 0,
    latest: null, inputs: 0, answers: 0, anomalyCount: 0, reasons: []};
}
const elapsed = (start: string | null, end: string | null) => {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return value >= 0 ? value : null;
};
const newProgress = (offset:number, at:string|null):Progress =>
  ({id:String(offset),start_at:at,counter:emptyCounter(),seen:false});

export class SessionStatisticsProjection {
  constructor(readonly state: SessionProjectionState, private readonly sink: ProjectionSink) {}

  private point(at: string | null, id?: string, offset?: number): Point {
    return {counter: copyCounter(this.state.total), at, id, offset};
  }

  private gap(reason: SessionCoverageReason, usage = true,
    progress = this.state.turn?.heldProgress ?? this.state.turn?.progress ?? null) {
    const state = this.state;
    if (!state.reasons.includes(reason)) state.reasons.push(reason);
    if (usage) {
      state.total.gaps[reason] = (state.total.gaps[reason] ?? 0) + 1;
      if (progress) progress.counter.gaps[reason] = (progress.counter.gaps[reason] ?? 0) + 1;
      state.previousInputSample = undefined;
      state.previousRequestSample = undefined;
    }
  }

  private begin(id: string, at: string | null, offset: number, verified: boolean): Turn {
    const state = this.state;
    if (state.turn?.id === id && !state.turn.ended) return state.turn;
    if (state.turn) {
      if (!state.turn.ended) this.end(state.turn, {kind: 'end', at: null, turn_id: state.turn.id, outcome: 'unknown'}, offset);
      if (state.turn.items.length || state.turn.tools.length) state.suspended.push(state.turn);
      if (state.suspended.length > 8) {
        state.suspended.shift();
        this.gap('missing_usage');
      }
    }
    if (verified && !state.first) state.first = this.point(at);
    state.turn = {
      id, start: this.point(at), verified, inputCount: 0, items: [], activeItems: [], tools: [], activeTools: [],
      progress: newProgress(offset,at),
    };
    if (!verified) this.gap('missing_start');
    return state.turn;
  }

  private turn(id: string, offset: number, at: string | null): Turn {
    return this.state.turn?.id === id ? this.state.turn :
      this.state.suspended.find(turn => turn.id === id) ?? this.begin(id, at, offset, false);
  }

  private pushEvent(event: Omit<SessionLifecycleFact, 'evidence' | 'id'>, offset: number, id?: string) {
    const record = {...event, id: id ?? factId(offset, event.action, event.state), evidence: 'native' as const};
    const added = this.sink.event(record, offset);
    if (added && event.action === 'compact' && event.state === 'completed') {
      this.state.compactions++;
      this.state.lastCompactionAt = event.at;
      const turn = this.state.turn;
      if (turn && !turn.ended) this.cutProgress(turn,event.at,'compact',offset);
    }
  }

  private cutProgress(turn: Turn, at: string | null, reason: 'input' | 'compact', offset: number) {
    const pending = turn.items.length > 0 || turn.tools.length > 0 || turn.activeItems.length > 0;
    if (!turn.heldProgress) {
      this.closeProgress(turn,at,reason,pending);
      if (pending) turn.heldProgress = {...turn.progress,close:{at,reason}};
    }
    turn.progress = newProgress(offset,at);
  }

  private onInput(turn: Turn, fact: Extract<NativeSessionFact, {kind: 'input'}>, offset: number) {
    if (this.sink.seen('input', fact.id)) return;
    const state = this.state;
    const overlap = !!turn.input && !turn.ended;
    const pending = turn.items.length > 0 || turn.tools.length > 0 || turn.activeItems.length > 0;
    const context = activityContext(state);
    if (turn.input && !turn.input.sampled) state.previousInputSample = undefined;
    if (overlap) this.cutProgress(turn,fact.at,'input',offset);
    turn.input = {id: fact.id, at: fact.at, sampled: false, ambiguous: overlap && !pending};
    if (!pending) turn.groupInput = fact.id;
    turn.inputCount++;
    state.inputs++;
    this.pushEvent({action: 'input', state: 'accepted', at: fact.at, turn_id: turn.id,
      message_id: fact.id, client_id: fact.client_id, execution: context}, offset);
  }

  private item(turn: Turn, fact: Item) {
    turn.activeItems = turn.activeItems.filter(id => id !== fact.id);
    const waiting = turn.items.find(item => item.id === fact.id);
    if (waiting) {
      // A native item and its transcript echo share an ID.
      if (waiting.phase === 'unknown' && fact.phase !== 'unknown') waiting.phase = fact.phase;
      waiting.digest ??= fact.digest;
      return;
    }
    if (this.sink.readItem(fact.id)) return;
    if (turn.items.length === 2048) {
      this.gap('ambiguous_boundary');
      turn.items.shift();
    }
    turn.items.push(fact);
    turn.last = fact;
    const progress = turn.heldProgress ?? turn.progress;
    const progressId = fact.phase === 'final' ? undefined : progress.id;
    if (progressId) {
      progress.seen = true;
      progress.last = fact;
    }
    this.sink.saveItem({
      ...recordedInterval(this.state.total, turn.start.counter, 1, [], true),
      sequence: fact.offset, item_at: fact.at, message_id: fact.id, turn_id: fact.turn_id,
      progress_id: progressId,
      interval: recordedInterval(emptyCounter(), undefined, 1, turn.verified ? [] : ['missing_start'], true),
    });
    if (progressId) this.closeProgress(turn,progress.close?.at??null,progress.close?.reason??null,true,progress);
  }

  private answer(turn: Turn, item: Item, point: Point, shared: number, late = false) {
    const state = this.state;
    const record = this.sink.readItem(item.id);
    if (!record) return;
    const start = state.final ?? state.first;
    const extra: SessionCoverageReason[] = [];
    if (!start) extra.push('missing_start');
    if (late) extra.push('ambiguous_boundary');
    this.sink.saveItem({...record, conclusion: {
      ...recordedInterval(point.counter, start?.counter, shared, extra),
      start_at: start?.at ?? null, end_at: item.at, elapsed_ms: elapsed(start?.at ?? null, item.at),
    }});
    if (!late) state.final = point;
    if (turn.inputCount && !turn.answered) {
      turn.answered = true;
      state.answers++;
    }
    (turn.heldProgress ?? turn.progress).final = item;
  }

  private closeProgress(turn: Turn, at: string | null, reason: AgentProgressSegment['end_reason'], pending: boolean, progress = turn.progress) {
    if (!progress.seen && !progress.counter.requests) return;
    const segment = progressSegment(progress,at,reason,pending,pending ? turn.tools.length : 0);
    for (const item of [progress.last, progress.final]) {
      if (!item) continue;
      const row = this.sink.readItem(item.id);
      if (row) this.sink.saveItem({...row, segment});
    }
    if (!progress.last && !progress.final && (segment.requests > 0 || segment.tool_calls > 0)) {
      this.sink.saveItem({...segment,sequence:Number(progress.id),message_id:factId('tool-progress',progress.id),
        turn_id:turn.id,segment});
    }
    const point = this.point(at, progress.last?.id, progress.last?.offset);
    turn.progressedAt = point;
    if (reason && !pending) this.state.progress = point;
  }

  private end(turn: Turn, end: End, offset: number) {
    if (turn.ended) return;
    const candidate = turn.unknownTail;
    if (end.outcome === 'completed' && end.final_digest && candidate?.item.digest === end.final_digest && candidate.item.id === turn.last?.id) {
      const progress=turn.heldProgress??turn.progress;
      if (candidate.beforeProgress && progress.last?.id === candidate.item.id) {
        progress.counter=candidate.beforeProgress;
        progress.last=candidate.previousCompleted;
        progress.completed=candidate.previousCompleted;
        progress.item_end=candidate.previousItem;
        progress.seen=!!progress.last||progress.counter.requests>0;
        const record=this.sink.readItem(candidate.item.id);
        if(record)this.sink.saveItem({...record,segment:undefined,progress_id:undefined,interval:recordedInterval(candidate.point.counter,
          candidate.beforeRequest.counter,1,turn.verified?[]:['missing_start'])});
      }
      this.answer(turn, candidate.item, candidate.point, candidate.shared);
    }
    turn.ended = end;
    const pending = turn.items.length > 0 || turn.tools.length > 0;
    // Retain unresolved groups so a receipt arriving after the abort can
    // update their records. Missing usage in stopped work is visible meanwhile.
    if (pending) {
      for (const item of turn.items) {
        const record = this.sink.readItem(item.id);
        if (!record) continue;
        this.sink.saveItem({...record, interval: recordedInterval(emptyCounter(),undefined,turn.items.length,['missing_usage'])});
      }
    }
    if (turn.heldProgress?.close) {
      const {at,reason} = turn.heldProgress.close;
      this.closeProgress(turn,at,reason,pending,turn.heldProgress);
    } else this.closeProgress(turn, end.at, end.outcome, pending);
    const context = activityContext(this.state, turn);
    if (end.outcome === 'interrupted')
      this.pushEvent({action: 'interrupt', state: 'completed', at: end.at, turn_id: turn.id, execution: context}, offset);
    else if (turn.input)
      this.pushEvent({action: 'input', state: end.outcome === 'completed' ? 'completed' : 'unknown',
        at: end.at, turn_id: turn.id, message_id: turn.input.id, execution: context}, offset);
    turn.activeTools = [];
    turn.activeItems = [];
    if (turn.input && !turn.input.sampled && !pending) this.state.previousInputSample = undefined;
    if (turn.input && !pending && turn.start.counter.requests === this.state.total.requests)
      this.gap('missing_usage');
  }

  private sampleCache(turn: Turn | undefined, request: NativeRequestFact, offset: number) {
    const state = this.state;
    const input = turn?.groupInput === turn?.input?.id ? turn?.input : undefined;
    const firstInputSample = input && !input.sampled && !!(turn?.items.length || turn?.tools.length);
    const current = cacheSample(input, request);
    const previous = state.previousRequestSample;
    const compaction = state.compactions !== state.sampledCompactions ? {at: state.lastCompactionAt ?? null} : undefined;
    const structuralChange = previous && current && (compaction || cacheDimensionChanges(previous,current).length > 0);
    // A compression or settings change can occur between requests of one
    // input. Prefer the immediately adjacent receipts at that boundary.
    let drop: SessionCacheDrop | null = null;
    if (current && previous && structuralChange) {
      const distinctInputs = firstInputSample && !input.ambiguous && previous.input_id && previous.input_id !== current.input_id;
      drop = detectCacheDrop(previous,current,distinctInputs ? 'input' : 'request',compaction);
    } else if (current && firstInputSample && !input.ambiguous && state.previousInputSample) {
      drop = detectCacheDrop(state.previousInputSample,current,'input');
    }
    if (drop) {
      this.sink.anomaly(drop, offset);
      state.anomalyCount++;
    }
    if (firstInputSample) {
      input.sampled = true;
      state.previousInputSample = input.ambiguous ? undefined : current ?? undefined;
    }
    if (structuralChange && compaction && !firstInputSample) state.previousInputSample = undefined;
    state.previousRequestSample = current ?? undefined;
    state.sampledCompactions = state.compactions;
  }

  private request(request: NativeRequestFact, offset: number) {
    const state = this.state;
    // A duplicate receipt must not settle a second batch of tools or items.
    const candidate = request.turn_id === state.turn?.id ? state.turn :
      state.suspended.find(turn => turn.id === request.turn_id);
    const tools = candidate?.tools.length ?? 0;
    if (!this.sink.request(request, offset, candidate?.groupInput ?? null, tools)) return;
    const turn = candidate;
    if (!turn) this.gap(state.first ? 'ambiguous_boundary' : 'missing_start');
    const late = !!turn?.ended && state.turn !== turn && state.item?.offset != null &&
      turn.items.some(item => item.offset < state.item!.offset!);
    const beforeRequest = this.point(request.at);
    const items = turn?.items ?? [];
    const toolsInRequest = turn?.tools.length ?? 0;
    const progress = turn && (turn.heldProgress ?? turn.progress);
    const ownsProgress = !!progress && (!items.length || items.some(item=>item.phase!=='final'));
    if (late) this.gap('ambiguous_boundary',true,ownsProgress?progress!:null);
    const consistent = consistentUsage(request.tokens);
    if (!consistent) this.gap(!request.tokens || ['input_tokens','cached_input_tokens','output_tokens','total_tokens']
      .some(key=>request.tokens![key as keyof NonNullable<NativeRequestFact['tokens']>]==null) ? 'missing_usage' : 'counter_mismatch',
      true,ownsProgress?progress!:null);
    countRequest(state.total, request, toolsInRequest);
    this.sink.model(request, toolsInRequest);
    state.latest = request;
    if (!late) this.sampleCache(turn,request,offset);
    if (!turn) return;
    const input = turn.input;
    turn.tools = [];
    turn.items = [];
    turn.groupInput = input?.id;
    const last = items.at(-1);
    const point = this.point(last?.at ?? request.at, last?.id, last?.offset);
    const scope=progress!;
    const previousItem=scope.item_end,previousCompleted=scope.completed;
    const mayBecomeFinal=last?.phase==='unknown'&&items.length===1&&toolsInRequest===0;
    const beforeProgress=mayBecomeFinal?copyCounter(scope.counter):undefined;
    if(ownsProgress) countRequest(scope.counter,request,toolsInRequest);
    const interval = recordedInterval(ownsProgress?scope.counter:state.total,
      ownsProgress?previousItem?.counter:beforeRequest.counter,items.length,
      late ? ['ambiguous_boundary'] : turn.verified ? [] : ['missing_start']);
    const finals = items.filter(item => item.phase === 'final');
    const owner=items.find(item=>item.phase!=='final')??items[0];
    for (const item of items) {
      this.sink.saveItem({
        ...recordedInterval(state.total, turn.start.counter, 1, turn.verified ? [] : ['missing_start']),
        sequence: item.offset, item_at: item.at, turn_id: turn.id, message_id: item.id,
        progress_id: item.phase==='final' ? undefined : scope.id,
        interval: item===owner ? interval : {...recordedInterval(emptyCounter(),undefined,items.length),shared_reference:true},
      });
    }
    if (last && !late) state.item = point;
    if (last && ownsProgress) {
      scope.completed = items.filter(item=>item.phase!=='final').at(-1);
      scope.item_end = {counter:copyCounter(scope.counter),at:scope.completed?.at??null,
        id:scope.completed?.id,offset:scope.completed?.offset};
    }
    // Real items from a single native response share usage. Freeze one final
    // interval for the entire group before moving its boundary.
    const finalStart = state.final;
    for (const item of finals) {
      state.final = finalStart;
      this.answer(turn, item, this.point(item.at, item.id, item.offset), finals.length, late);
    }
    if (last?.phase === 'unknown') turn.unknownTail = {item:last,point,shared:items.length,beforeRequest,
      beforeProgress,previousItem,previousCompleted};
    else turn.unknownTail = undefined;
    if (turn.heldProgress?.close) {
      const {at, reason} = turn.heldProgress.close;
      this.closeProgress(turn, at, reason, late, turn.heldProgress);
      turn.heldProgress = undefined;
    } else if (ownsProgress || turn.progress.seen)
      this.closeProgress(turn, turn.ended?.at ?? null, turn.ended?.outcome ?? null, late);
    if (turn.ended) state.suspended = state.suspended.filter(candidate => candidate !== turn);
  }

  accept(fact: NativeSessionFact, offset: number) {
    if (fact.kind === 'gap') return this.gap(fact.reason, fact.affectsUsage !== false);
    if (fact.kind === 'lifecycle') return this.pushEvent(fact.event, offset, fact.id);
    if (fact.kind === 'request') return this.request(fact.request, offset);
    if (fact.kind === 'start') {
      this.begin(fact.turn_id, fact.at, offset, true);
      return;
    }
    // Tool result echoes must not create a turn or make a completed one active.
    if (fact.kind === 'tool_end') {
      const turn = [this.state.turn, ...this.state.suspended].find(value => value?.id === fact.turn_id);
      if (turn) turn.activeTools = turn.activeTools.filter(id => id !== fact.id);
      return;
    }
    if (fact.kind === 'item' && this.sink.readItem(fact.id) && !this.state.turn?.items.some(item => item.id === fact.id)) return;
    const turn = this.turn(fact.turn_id, offset, 'at' in fact ? fact.at : null);
    switch (fact.kind) {
      case 'input': this.onInput(turn, fact, offset); break;
      case 'item_start':
        if (!this.sink.readItem(fact.id) && !turn.activeItems.includes(fact.id) && turn.activeItems.length < 2048) turn.activeItems.push(fact.id);
        break;
      case 'item': this.item(turn, {...fact, offset}); break;
      case 'tool':
        if (!this.sink.seen('tool', factId(turn.id, fact.id))) {
          if (turn.tools.length === 4096 || turn.activeTools.length === 4096) { this.gap('ambiguous_boundary'); break; }
          turn.tools.push(fact.id);
          turn.activeTools.push(fact.id);
          (turn.heldProgress ?? turn.progress).seen = true;
        }
        break;
      case 'end': this.end(turn, fact, offset); break;
    }
  }
}

function progressSegment(progress: Progress, at: string | null, reason: AgentProgressSegment['end_reason'], unresolved: boolean, pendingTools: number): AgentProgressSegment {
  const extra: SessionCoverageReason[] = [];
  if (unresolved && reason) extra.push('missing_usage');
  if (reason === 'unknown') extra.push('ambiguous_boundary');
  const pending = unresolved && !reason;
  const interval = includePendingTools(recordedInterval(progress.counter, undefined, 1, extra, pending),pendingTools);
  const tail = includePendingTools(recordedInterval(progress.counter,progress.item_end?.counter,1,extra,pending),pendingTools);
  const unassigned = tail.requests || tail.tool_calls ? tail : undefined;
  return {
    ...interval, id: progress.id, start_at: progress.start_at, end_at: at,
    end_reason: reason, elapsed_ms: elapsed(progress.start_at, at), ...(unassigned ? {unassigned} : {}),
  };
}

export function activityContext(state: SessionProjectionState, turn = state.turn): SessionActivityContext {
  return {
    turn_id: turn?.id ?? null, last_progress_id: state.progress?.id ?? null,
    last_item_id: turn?.last?.id ?? state.item?.id ?? null,
    active_item_ids: turn ? [...turn.activeItems] : [],
    active_tool_ids: turn ? [...turn.activeTools] : [],
  };
}

function includePendingTools<T extends {tool_calls:number;tool_rounds:number}>(interval: T, calls: number): T {
  // Tool IDs are already known before the response receipt. The open group
  // proves at least one round. Its final grouping remains pending.
  return calls ? {...interval, tool_calls:interval.tool_calls+calls, tool_rounds:interval.tool_rounds+1} : interval;
}

export function projectProgress(state: SessionProjectionState): AgentProgressStatistics | null {
  const turn = state.turn;
  if (!turn?.progress.counter) return null;
  const open = !turn.ended;
  const waiting = !turn.heldProgress && (turn.items.length > 0 || turn.tools.length > 0);
  const pendingTools = turn.heldProgress ? 0 : turn.tools.length;
  const from = state.final ?? state.first;
  const stepFrom = turn.progress.item_end;
  const segment = turn.ended && turn.progressedAt && state.progress?.id === turn.progressedAt.id
    ? undefined : progressSegment(turn.progress, turn.ended?.at ?? null, turn.ended?.outcome ?? null, waiting,pendingTools);
  return {
    ...includePendingTools(recordedInterval(state.total, from?.counter, 1, from ? [] : ['missing_start'], open && waiting), pendingTools),
    turn_id: turn.id,
    ...(segment ? {segment} : {}),
    ...(open ? {step: {
      ...includePendingTools(recordedInterval(turn.progress.counter, stepFrom?.counter, 1, turn.verified?[]:['missing_start'], waiting), pendingTools),
      segment_id: turn.progress.id, after_message_id: stepFrom?.id ?? null,
      after_sequence: stepFrom?.offset ?? null, start_at: stepFrom?.at ?? turn.progress.start_at,
    }} : {}),
  };
}

export function projectSummary(
  state: SessionProjectionState, nativeId: string, revision: number, observedAt: string | null,
  extra: SessionCoverageReason[],
): SessionMetadata {
  const waiting = !!state.turn && !state.turn.ended;
  const missing = [...state.suspended, ...(state.turn?.ended ? [state.turn] : [])]
    .some(turn => turn.items.length > 0 || turn.tools.length > 0);
  const reasons = [...new Set([...state.reasons, ...extra, ...(missing ? ['missing_usage' as const] : [])])];
  const hasSource = state.first || state.latest || state.inputs > 0 || observedAt;
  const pending = extra.includes('backfill') || (waiting && !reasons.length) || extra.includes('incomplete_record');
  const partial = reasons.some(reason => reason !== 'backfill' && reason !== 'incomplete_record');
  return {
    native_id: nativeId, revision, observed_at: observedAt,
    status: !hasSource && extra.includes('source_unavailable') ? 'unavailable' : partial ? 'partial' : pending ? 'pending' : 'complete',
    reasons, totals: hasSource ? usageTotals(state.total, undefined, reasons.length > 0 || waiting) : null,
    latest: state.latest, user_inputs: hasSource ? state.inputs : null, completed_turns: hasSource ? state.answers : null,
    cache_drop_count: state.anomalyCount,
  };
}

export function modelTotals(dimensions: RequestDimensions, counter: StatisticsCounter): SessionModelTotals {
  return {...dimensions, ...usageTotals(counter, undefined, counterReasons(counter).length > 0)};
}
