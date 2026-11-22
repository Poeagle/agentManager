import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { agentDescriptors, agentForSession, getAgent } from './agents/index.js';
import { factId, factTime, consistentUsage } from './agents/session-fact-values.js';
import type {
  AgentSessionFactsPort, RequestDimensions, SessionAction, SessionActionState, SessionCacheDrop,
  SessionCoverageReason, SessionLifecycleFact, SessionMetadata, SessionMetadataDetails,
  SessionUsageIntervalPage, SessionUsageIntervalRow,
} from './agents/session-facts.js';
import type { AgentContext, AgentSession, AgentStatistics } from './agents/types.js';
import { activityContext, modelTotals, newProjection, projectProgress, projectSummary,
  SessionStatisticsProjection, type ProjectionSink, type SessionProjectionState } from './session-statistics-projection.js';
import { countRequest, emptyCounter, type StatisticsCounter } from './session-statistics-totals.js';

const RECORD_MAX = 16 * 1024 * 1024;
const CHUNK = 256 * 1024;
const BATCH = 8 * 1024 * 1024;
const RECORDS = 4000;
const CHECKPOINT_PROJECTION_VERSION = 9;
const checkpointVersion = (codec: AgentSessionFactsPort) => codec.revision * 100 + CHECKPOINT_PROJECTION_VERSION;

interface SourceRow {
  file_id: string;
  codec_version: number;
  offset: number;
  length: number;
  stamp: string;
  first_anchor: string;
  end_anchor: string;
  skipping: number;
  caught_up: number;
  revision: number;
  adapter_state: string;
  projection_state: string;
  summary: string;
}
interface CachedFile {
  path: string;
  context: AgentContext;
}
interface Source {
  key: string;
  id: string;
  agent: string;
  environment: string;
  owner: string | null;
  codec: AgentSessionFactsPort;
  db: Database.Database;
}

const json = JSON.stringify;
const readJson = <T>(value: string): T => JSON.parse(value) as T;

function sourceFor(context: AgentContext): Source | null {
  const adapter = agentForSession(context.session);
  const codec = adapter.statistics.facts;
  const id = context.nativeId;
  if (!id || !codec) return null;
  const agent = adapter.descriptor.id;
  const environment = context.session.agent_environment_id || 'native';
  try {
    return {key: factId(agent, environment, id), agent, id, environment, codec, db: getDb(), owner: context.session.created_by_user_id ?? null};
  } catch {
    // File-only consumers can use the adapter without a platform database.
    return null;
  }
}
const rowFor = (source: Source) => source.db.prepare(
  'SELECT * FROM session_statistics_sources WHERE source=?',
).get(source.key) as SourceRow | undefined;
const workKey = (source: Source) => json([source.db.name, source.key]);
const locks = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const backlog = new Map<string, CachedFile>();
let backfill: Promise<void> | undefined;
let stopping = false;
const inventory = new Map<string, AsyncIterator<CachedFile>>();

function notify(source: Source) {
  for (const changed of listeners.get(workKey(source)) ?? []) changed();
}

export function subscribeSessionFacts(context: AgentContext, changed: () => void) {
  const source = sourceFor(context);
  if (!source) return () => {};
  const key = workKey(source);
  const group = listeners.get(key) ?? new Set();
  listeners.set(key, group);
  group.add(changed);
  return () => {
    group.delete(changed);
    if (!group.size) listeners.delete(key);
  };
}

interface Batch {
  records: Array<{offset: number; bytes: Buffer; oversized?: boolean}>;
  end: number;
  skipping: boolean;
  caughtUp: boolean;
  incomplete: boolean;
}

async function readBatch(file: FileHandle, codec: AgentSessionFactsPort, start: number, size: number, skip: boolean): Promise<Batch> {
  const records: Batch['records'] = [];
  let position = start, end = start, lineStart = start, pieces: Buffer[] = [];
  let length = 0, limit = RECORD_MAX, header = Buffer.alloc(0);
  let stop = false;
  while (position < size && !stop && (position - start < BATCH || length > 0)) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
    const {bytesRead} = await file.read(chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    for (let i = 0; i < bytesRead;) {
      const newline = chunk.indexOf(10, i);
      const complete = newline >= 0 && newline < bytesRead;
      const next = complete ? newline + 1 : bytesRead;
      const fragment = chunk.subarray(i, complete ? newline : next);
      if (!skip) {
        if (header.length < 1024 && fragment.length) {
          header = Buffer.concat([header,fragment.subarray(0,1024-header.length)]);
          limit = Math.min(RECORD_MAX, codec.recordLimit?.(header) ?? 512 * 1024);
        }
        length += fragment.length;
        if (length > limit) {
          records.push({offset: lineStart, bytes: header, oversized: true});
          skip = true;
          pieces = [];
          length = 0;
        } else if (fragment.length) pieces.push(fragment);
      }
      if (complete) {
        if (!skip && length) records.push({offset: lineStart, bytes: pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length)});
        end = position + next;
        lineStart = end;
        skip = false;
        pieces = [];
        length = 0;
        header = Buffer.alloc(0);
        if (records.length >= RECORDS || end - start >= BATCH) { stop = true; break; }
      } else if (skip) end = position + next;
      i = next;
    }
    position += bytesRead;
  }
  const caughtUp = end >= size || !stop && position >= size;
  return {records, end, skipping: skip, caughtUp, incomplete: caughtUp && (end < size || skip)};
}

async function anchor(file: FileHandle, start: number, size: number) {
  if (!size) return '';
  const bytes = Buffer.alloc(size);
  const {bytesRead} = await file.read(bytes, 0, size, start);
  return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
}

function projectionSink(source: Source, revision: number, generation: string): ProjectionSink & { flush: () => void } {
  const {db, key} = source;
  const identity = db.prepare('INSERT OR IGNORE INTO session_statistics_identities VALUES(?,?)');
  const request = db.prepare(`INSERT INTO session_statistics_requests VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(source,request_id) DO UPDATE SET generation=excluded.generation, position=excluded.position,
      input_id=excluded.input_id, tool_calls=excluded.tool_calls, fact=excluded.fact
    WHERE generation!=excluded.generation`);
  const readItem = db.prepare('SELECT facts FROM session_statistics_items WHERE source=? AND item_id=?');
  const saveItem = db.prepare(`INSERT INTO session_statistics_items VALUES(?,?,?,?,?)
    ON CONFLICT(source,item_id) DO UPDATE SET facts=excluded.facts,revision=excluded.revision`);
  const event = db.prepare('INSERT OR IGNORE INTO session_statistics_events VALUES(?,?,?,?,?,NULL,?)');
  const anomaly = db.prepare('INSERT OR IGNORE INTO session_statistics_cache_drops VALUES(?,?,?,?,?,?)');
  const lookupModel = db.prepare('SELECT counter FROM session_statistics_models WHERE source=? AND dimensions=?');
  const saveModel = db.prepare('INSERT OR REPLACE INTO session_statistics_models VALUES(?,?,?)');
  const models = new Map<string, StatisticsCounter>();
  return {
    seen: (kind, id) => identity.run(key, kind + ':' + id).changes === 0,
    request: (fact, offset, inputId, tools) => !!request.run(key, fact.id, generation, offset, inputId, tools, json(fact)).changes,
    readItem(id) {
      const row = readItem.get(key, id) as {facts: string} | undefined;
      return row && readJson<AgentStatistics>(row.facts);
    },
    saveItem: stat => { saveItem.run(key, stat.message_id, stat.sequence, revision, json({...stat, revision})); },
    event: (fact, offset) => !!event.run(key, fact.id, fact.at, offset, 'native', json(fact)).changes,
    anomaly: (fact, offset) => {
      const anchor = fact.compaction_at ? 'compact:'+fact.compaction_at : fact.message_id ?? fact.current.input_id ?? '';
      anomaly.run(key, fact.id, anchor, fact.at, offset, json(fact));
    },
    model(fact, tools) {
      const dimensions = json(fact.dimensions);
      let counts = models.get(dimensions);
      if (!counts) {
        const row = lookupModel.get(key, dimensions) as {counter: string} | undefined;
        counts = row ? readJson<StatisticsCounter>(row.counter) : emptyCounter();
        models.set(dimensions, counts);
      }
      countRequest(counts, fact, tools);
      if (!consistentUsage(fact.tokens)) counts.gaps.missing_usage = (counts.gaps.missing_usage ?? 0) + 1;
    },
    flush() {
      for (const [dimensions, counter] of models) saveModel.run(key, dimensions, json(counter));
    },
  };
}

async function scan(source: Source, context: AgentContext, path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error('Statistics source is not a file');
    const {db, id, key, codec} = source;
    const old = rowFor(source);
    const fileId = json([stat.dev, stat.ino]);
    const stamp = json([stat.mtimeMs, stat.ctimeMs]);
    const version = checkpointVersion(codec);
    const sameFile = old?.file_id === fileId && old.codec_version === version && old.length <= stat.size;
    const sameVersion = sameFile && old.stamp === stamp && old.length === stat.size;
    if (sameVersion && old.caught_up) return false;
    const canAppend = sameFile && (sameVersion || old.length < stat.size &&
      old.first_anchor === await anchor(handle, 0, Math.min(256, old.offset)) &&
      old.end_anchor === await anchor(handle, Math.max(0, old.offset - 256), Math.min(256, old.offset)));
    const start = canAppend ? old.offset : 0;
    const batch = await readBatch(handle, codec, start, stat.size, !!(canAppend && old.skipping));
    const first = await anchor(handle, 0, Math.min(256, batch.end));
    const end = await anchor(handle, Math.max(0, batch.end - 256), Math.min(256, batch.end));
    const check = await handle.stat();
    // The current snapshot excludes bytes appended during this read. A
    // truncation or same-length rewrite makes that snapshot unsafe to commit.
    if (check.size < stat.size || check.size === stat.size && check.mtimeMs !== stat.mtimeMs)
      return true;
    const state = canAppend ? readJson<SessionProjectionState>(old.projection_state) : newProjection();
    if (!canAppend && old) state.replacingSource = true;
    let adapterState: unknown = canAppend ? readJson(old.adapter_state) : null;
    const revision = Math.max(Date.now(), (rowFor(source)?.revision ?? 0) + 1);
    const prior = old ? readJson<SessionMetadata>(old.summary) : null;
    const generation = (canAppend ? prior?.generation : undefined) ?? factId('statistics', key, revision);
    const receiptTime = batch.records.length ? new Date().toISOString() : prior?.observed_at ?? null;
    const extras: SessionCoverageReason[] = batch.caughtUp ? [] : ['backfill'];
    if (batch.incomplete) extras.push('incomplete_record');
    db.transaction(() => {
      if (!canAppend) {
        // Keep already observed receipts for lifetime consumption. Mutable
        // view projections are rebuilt from the new source generation.
        if (old) {
          for (const table of ['items','identities','models','cache_drops'])
            db.prepare(`DELETE FROM session_statistics_${table} WHERE source=?`).run(key);
        } else {
          db.prepare('INSERT INTO session_statistics_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            key, source.agent, id, source.environment, version, fileId, 0, 0, '', '', '', 0, 0, revision, '{}', '{}', '{}',
          );
        }
        db.prepare("DELETE FROM session_statistics_events WHERE source=? AND evidence='native'").run(key);
      }
      const sink = projectionSink(source, revision, generation);
      const projection = new SessionStatisticsProjection(state, sink);
      for (const record of batch.records) {
        if (record.oversized) {
          for (const fact of codec.oversized?.(record.bytes, context) ?? [{kind: 'gap', reason: 'unreadable_record'}] as const)
            projection.accept(fact, record.offset);
          continue;
        }
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(record.bytes.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid record');
        } catch {
          projection.accept({kind: 'gap', reason: 'unreadable_record'}, record.offset);
          continue;
        }
        const decoded = codec.decode(parsed, {offset: record.offset, at: factTime(parsed.timestamp), context}, adapterState);
        adapterState = decoded.state;
        for (const fact of decoded.facts) projection.accept(fact, fact.source_offset ?? record.offset);
      }
      sink.flush();
      if (state.replacingSource && batch.caughtUp) {
        const missing = db.prepare('SELECT 1 FROM session_statistics_requests WHERE source=? AND generation!=? LIMIT 1')
          .get(key, generation);
        if (missing) state.reasons.push('source_replaced');
        delete state.replacingSource;
      }
      const summary = projectSummary(state, id, revision, receiptTime, extras);
      summary.generation = generation;
      db.prepare(`UPDATE session_statistics_sources
        SET codec_version=?,file_id=?,offset=?,length=?,stamp=?,first_anchor=?,end_anchor=?,skipping=?,
          caught_up=?,revision=?,adapter_state=?,projection_state=?,summary=? WHERE source=?`).run(
        version, fileId, batch.end, stat.size, stamp, first, end, Number(batch.skipping),
        Number(batch.caughtUp), revision, json(adapterState ?? null), json(state), json(summary), key,
      );
    })();
    notify(source);
    return !batch.caughtUp || check.size > stat.size;
  } finally {
    await handle.close();
  }
}

function queue(source: Source, file: CachedFile) {
  if (stopping) return;
  const key = workKey(source);
  if (backlog.size < 128 || backlog.has(key)) backlog.set(key, file);
  if (backfill) return;
  backfill = (async () => {
    while (backlog.size) {
      await new Promise<void>(resolve => setImmediate(resolve));
      const entry = backlog.entries().next().value;
      if (!entry) break;
      const [id, queued] = entry;
      backlog.delete(id);
      await updateSessionFacts(queued.context, queued.path).catch(() => {});
    }
  })().finally(() => { backfill = undefined; });
}

/** Only the reader of this native binding or the shared collector advances its
 * checkpoint. Observer updates, request facts and aggregates commit together. */
export async function updateSessionFacts(context: AgentContext, path: string, background = true): Promise<boolean> {
  const source = sourceFor(context);
  if (!source) return false;
  const key = workKey(source);
  const existing = locks.get(key);
  if (existing) { await existing; return true; }
  const work = scan(source, context, path).then(more => {
    if (more && background) queue(source, {context, path});
  });
  locks.set(key, work);
  try {
    await work;
    return true;
  } finally {
    if (locks.get(key) === work) locks.delete(key);
  }
}

export async function stopSessionStatistics() {
  stopping = true;
  backlog.clear();
  await Promise.allSettled([...locks.values(), ...(backfill ? [backfill] : [])]);
  backlog.clear();
  for (const iterator of inventory.values()) await iterator.return?.();
  inventory.clear();
  stopping = false;
}

/** Called by the existing background usage clock. One bounded sweep advances
 * shared checkpoints for sessions with no observers. */
export async function collectSessionStatisticsInventory(signal: AbortSignal) {
  const deadline = Date.now() + 15_000;
  for (const agent of agentDescriptors()) {
    const discover = getAgent(agent.id).statistics.facts?.discover;
    if (!discover || signal.aborted) continue;
    const traversal = inventory.get(agent.id) ?? discover()[Symbol.asyncIterator]();
    inventory.set(agent.id, traversal);
    for (let count = 0; count < 400 && Date.now() < deadline && !signal.aborted; count++) {
      const next = await traversal.next().catch(() => ({done:true,value:undefined} as const));
      if (next.done) { inventory.delete(agent.id); break; }
      await updateSessionFacts(next.value.context, next.value.path, false).catch(() => false);
    }
  }
}

export function readSessionMetadata(context: AgentContext, available = true): SessionMetadata | null {
  const source = sourceFor(context);
  if (!source) return null;
  const row = rowFor(source);
  let saved = row ? readJson<SessionMetadata>(row.summary) : projectSummary(newProjection(), source.id, 0, null,
    [available ? 'backfill' : 'source_unavailable']);
  // Older summaries marked every open turn pending, even after its receipt.
  if (row?.codec_version === checkpointVersion(source.codec) && saved.status === 'pending' && !saved.reasons.length) {
    const projection = readJson<SessionProjectionState>(row.projection_state);
    saved = {...projectSummary(projection, source.id, row.revision, saved.observed_at, []), generation: saved.generation};
  }
  if (available) {
    if (saved.status === 'pending' && !saved.reasons.length &&
        ['cancelled','failed','completed'].includes(context.session.status ?? ''))
      return {...saved, status:'partial', reasons:[...new Set([...saved.reasons,'ambiguous_boundary' as const])]};
    return saved;
  }
  if (saved.reasons.includes('source_unavailable')) return saved;
  return {...saved, status: saved.totals ? 'partial' : 'unavailable', reasons: [...saved.reasons, 'source_unavailable']};
}

export function readSessionProgress(context: AgentContext) {
  const source = sourceFor(context);
  const row = source && rowFor(source);
  if (!row || row.codec_version !== checkpointVersion(source.codec)) return null;
  const progress = projectProgress(readJson<SessionProjectionState>(row.projection_state));
  return progress && {...progress,revision:row.revision};
}

export function readSessionItemStatistics(context: AgentContext, items: Array<{id: string; offset: number}>): AgentStatistics[] {
  const source = sourceFor(context);
  if (!source || !items.length) return [];
  const lookup = source.db.prepare('SELECT facts FROM session_statistics_items WHERE source=? AND item_id=?');
  const byOffset = source.db.prepare("SELECT facts FROM session_statistics_items WHERE source=? AND position=? AND json_type(facts,'$.interval')='object' LIMIT 1");
  return items.flatMap(item => {
    const row = (lookup.get(source.key, item.id) ?? byOffset.get(source.key, item.offset)) as {facts: string} | undefined;
    return row ? [readJson<AgentStatistics>(row.facts)] : [];
  });
}

export function readChangedSessionStatistics(context: AgentContext, since: number): AgentStatistics[] {
  const source = sourceFor(context);
  if (!source) return [];
  const where = since ? ' AND revision>?' : '';
  return (source.db.prepare("SELECT facts FROM session_statistics_items WHERE source=? AND json_type(facts,'$.interval')='object'"+where+
    ' ORDER BY position DESC LIMIT 160').all(...(since ? [source.key, since] : [source.key])) as {facts: string}[])
    .reverse().map(row => readJson<AgentStatistics>(row.facts));
}

interface IntervalAnchor { position: number; item_id: string }
interface IntervalProjection extends IntervalAnchor {
  facts: string;
  kind: 'final' | 'progress' | 'item';
  segment_id: string | null;
  last_item: number | null;
}
export interface SessionUsagePageQuery {
  parent?: string;
  before?: [number, string, IntervalProjection['kind']];
}

const finalBoundary = "json_type(facts, '$.conclusion') = 'object'";
const upperBound = {position: Number.MAX_SAFE_INTEGER, item_id: ''};
const lowerBound = {position:-1, item_id:''};

function previousFinal(source: Source, before: IntervalAnchor): IntervalAnchor {
  return source.db.prepare(`SELECT position,item_id FROM session_statistics_items WHERE source=@source
    AND ${finalBoundary} AND (position,item_id) < (@position,@item_id) ORDER BY position DESC,item_id DESC LIMIT 1`)
    .get({source:source.key,...before}) as IntervalAnchor | undefined ?? lowerBound;
}

function intervalWithin(alias: string) {
  return `${alias}.source=@source AND (${alias}.position,${alias}.item_id) > (@low,@low_id)
    AND (${alias}.position,${alias}.item_id) <= (@high,@high_id)`;
}

function intervalChildren(source: Source, parent: string) {
  const [kind, boundary, segment] = parent.split(':');
  const rootId = kind === 'final' ? boundary : kind === 'progress' ? boundary : 'open';
  const upper = rootId === 'open' ? upperBound :
    source.db.prepare(`SELECT position,item_id FROM session_statistics_items
      WHERE source=? AND item_id=? AND ${finalBoundary}`).get(source.key, rootId) as IntervalAnchor | undefined;
  if (!upper) return null;
  const lower = previousFinal(source, upper);
  const segmentId = (alias: string) => `json_extract(${alias}.facts, '$.segment.id')`;
  // Multiple Items can carry snapshots of a Progress. Choose the latest one.
  const progress = `WITH progress AS (
    SELECT i.position,i.item_id,i.facts,'progress' kind,${segmentId('i')} segment_id,
      (SELECT MAX(s.position) FROM session_statistics_items s WHERE ${intervalWithin('s')}
        AND json_extract(s.facts, '$.progress_id')=${segmentId('i')}) last_item
    FROM session_statistics_items i WHERE ${intervalWithin('i')} AND ${segmentId('i')} IS NOT NULL
      AND i.item_id=(SELECT s.item_id FROM session_statistics_items s WHERE s.source=i.source
        AND ${segmentId('s')}=${segmentId('i')} ORDER BY s.revision DESC,s.position DESC,s.item_id DESC LIMIT 1)
  )`;
  const member = "json_extract(i.facts, '$.progress_id')=p.segment_id";
  const items = `SELECT i.position,i.item_id,i.facts,'item' kind,NULL segment_id,NULL last_item
    FROM session_statistics_items i WHERE ${intervalWithin('i')} AND json_type(i.facts, '$.interval')='object'`;
  const select = kind === 'progress'
    ? `${items} AND EXISTS(SELECT 1 FROM progress p WHERE p.segment_id=@segment AND ${member})`
    : `SELECT p.position,p.item_id,p.facts,p.kind,p.segment_id,
      p.last_item FROM progress p
      UNION ALL ${items} AND NOT EXISTS(SELECT 1 FROM progress p WHERE ${member})`;
  return {progress, select, rootId, params:{
    low:lower.position,low_id:lower.item_id,high:upper.position,high_id:upper.item_id,
    ...(kind === 'progress' ? {segment} : {}),
  }};
}

export function readSessionUsageIntervals(context: AgentContext, {parent,before}:SessionUsagePageQuery={}): SessionUsageIntervalPage | null {
  const source = sourceFor(context);
  if (!source) return null;
  const saved = rowFor(source);
  const generation = saved ? readJson<SessionMetadata>(saved.summary).generation : undefined;
  const page = {native_id:source.id,generation,revision:saved?.revision ?? 0};
  if (saved?.codec_version !== checkpointVersion(source.codec)) return {...page,rows:[],next_before:null};
  const children = parent ? intervalChildren(source, parent) : null;
  if (parent && !children) return {...page, rows:[], next_before:null};
  const select = children?.select ?? `SELECT position,item_id,facts,'final' kind,NULL segment_id,NULL last_item
    FROM session_statistics_items WHERE source=@source AND ${finalBoundary}`;
  const cursor = before ? 'WHERE (position,item_id,kind) < (@cursor_position,@cursor_id,@cursor_kind)' : '';
  const results = source.db.prepare(`${children?.progress ?? ''} SELECT * FROM (${select}) ${cursor}
    ORDER BY position DESC,item_id DESC,kind DESC LIMIT 51`)
    .all({source:source.key,...children?.params,...(before ? {
      cursor_position:before[0],cursor_id:before[1],cursor_kind:before[2],
    } : {})}) as IntervalProjection[];
  const rows: SessionUsageIntervalRow[] = results.slice(0,50).map(row => {
    const stat = readJson<AgentStatistics>(row.facts);
    if (row.kind === 'progress') {
      const {id,end_at,start_at,last_request_at,elapsed_ms,end_reason,...usage} = stat.segment!;
      return {id:`progress:${children!.rootId}:${id}`,kind:row.kind,at:last_request_at ?? end_at ?? start_at,usage:{...usage,shared_messages:1},
        expandable:row.last_item!==null||!!usage.unassigned};
    }
    if (row.kind === 'final') {
      const {end_at,start_at,elapsed_ms,...usage} = stat.conclusion!;
      return {id:`final:${row.item_id}`,kind:row.kind,at:end_at,usage,expandable:true};
    }
    return {id:`item:${row.item_id}`,kind:row.kind,at:stat.item_at ?? stat.conclusion?.end_at ?? null,
      ...(stat.conclusion ? {phase:'final' as const} : {}),usage:stat.interval!,expandable:false};
  });
  if (!parent && !before) {
    const latest = results[0] ?? lowerBound;
    const open = source.db.prepare(`SELECT 1 FROM session_statistics_items WHERE source=@source
      AND (position,item_id) > (@position,@item_id) LIMIT 1`)
      .get({source:source.key,position:latest.position,item_id:latest.item_id});
    if (open) rows.unshift({id:'open',kind:'open',at:null,usage:null,expandable:true});
  }
  if (parent?.startsWith('progress:') && children && !before) {
    const row = source.db.prepare(`${children.progress} SELECT facts FROM progress WHERE segment_id=@segment`)
      .get({source:source.key,...children.params}) as {facts:string}|undefined;
    const tail = row && readJson<AgentStatistics>(row.facts).segment?.unassigned;
    if (tail) rows.unshift({id:parent+':unassigned',kind:'unassigned',at:null,usage:tail,expandable:false});
  }
  const last = results[49];
  return {...page,rows,next_before:results.length>50 ? json([last.position,last.item_id,last.kind]) : null};
}

export function readSessionCacheDrops(context: AgentContext, messageIds: string[], compactionTimes: string[] = [], inputIds: string[] = []): SessionCacheDrop[] {
  const source = sourceFor(context);
  if (!source) return [];
  const query = source.db.prepare('SELECT fact FROM session_statistics_cache_drops WHERE source=? AND input_id=?');
  const anchors = new Set([...messageIds,...compactionTimes.flatMap(at => {
    const timestamp = factTime(at);
    return timestamp ? ['compact:'+timestamp] : [];
  })]);
  const byInput = source.db.prepare(`SELECT fact FROM session_statistics_cache_drops WHERE source=?
    AND json_extract(fact, '$.current.input_id')=?`);
  const drops = new Map<string, SessionCacheDrop>();
  const rows = [...Array.from(anchors, id => query.all(source.key, id)),
    ...inputIds.map(id => byInput.all(source.key, id))].flat() as {fact: string}[];
  for (const row of rows) {
    const drop = readJson<SessionCacheDrop>(row.fact);
    drops.set(drop.id, drop);
  }
  return [...drops.values()];
}

export function readRecentSessionCacheDrops(context: AgentContext): SessionCacheDrop[] {
  const source = sourceFor(context);
  if (!source) return [];
  return (source.db.prepare('SELECT fact FROM session_statistics_cache_drops WHERE source=? ORDER BY occurred_at DESC,position DESC LIMIT 160')
    .all(source.key) as {fact: string}[]).map(row => readJson<SessionCacheDrop>(row.fact));
}

export function readSessionMetadataDetails(
  context: AgentContext, available: boolean, cursor: {event?: string; cache?: string} = {},
): SessionMetadataDetails | null {
  const source = sourceFor(context);
  const summary = readSessionMetadata(context, available);
  if (!source || !summary) return null;
  const {db, key} = source;
  const models = (db.prepare('SELECT dimensions,counter FROM session_statistics_models WHERE source=?').all(key) as Array<{
    dimensions: string; counter: string;
  }>).map(row => modelTotals(readJson<RequestDimensions>(row.dimensions), readJson(row.counter)))
    .sort((a, b) => b.requests - a.requests);

  const events = db.prepare(`SELECT id,fact FROM session_statistics_events e WHERE source=@source AND (evidence='native' OR owner_id IS @owner) AND (
    @id IS NULL OR (COALESCE(e.occurred_at,''),e.position,e.id) <
      (SELECT COALESCE(occurred_at,''),position,id FROM session_statistics_events WHERE source=@source AND id=@id)
    ) ORDER BY COALESCE(occurred_at,'') DESC, position DESC, id DESC LIMIT 51`).all({source: key, id: cursor.event ?? null, owner:source.owner}) as Array<{id: string; fact: string}>;
  const drops = db.prepare(`SELECT id,fact FROM session_statistics_cache_drops d WHERE source=@source AND (
    @id IS NULL OR (d.occurred_at,d.position,d.id) < (SELECT occurred_at,position,id FROM session_statistics_cache_drops WHERE source=@source AND id=@id)
    ) ORDER BY occurred_at DESC,position DESC,id DESC LIMIT 51`).all({source: key, id: cursor.cache ?? null}) as Array<{id: string; fact: string}>;
  return {
    summary, models, events: events.slice(0, 50).map(row => readJson(row.fact)),
    cache_drops: drops.slice(0, 50).map(row => readJson(row.fact)),
    next_event: events.length > 50 ? events[49].id : null,
    next_cache_drop: drops.length > 50 ? drops[49].id : null,
  };
}

export function sessionFactsEnabled(context: AgentContext): boolean {
  return !!sourceFor(context);
}

type OperationFacts = Partial<Pick<SessionLifecycleFact, 'message_id' | 'client_id' | 'turn_id' | 'related_native_id' | 'dimensions'>>;
export function beginSessionAction(context: AgentContext, action: SessionAction, details: OperationFacts = {}) {
  const source = sourceFor(context);
  if (!source) return (_state: SessionActionState, _details?: OperationFacts) => {};
  const operationId = randomUUID();
  const binding = context.session;
  const append = (state: SessionActionState, more: OperationFacts = {}) => {
    const at = new Date().toISOString();
    const row = rowFor(source);
    const execution = row?.caught_up && state === 'requested'
      ? activityContext(readJson<SessionProjectionState>(row.projection_state)) : undefined;
    const fact: SessionLifecycleFact = {
      id: factId(operationId, state), at, action, state, evidence: 'platform',
      operation_id: operationId, platform_session_id: binding.id, ...details, ...more, ...(execution ? {execution} : {}),
    };
    insertPlatformFact(source, fact);
    notify(source);
  };
  append('requested');
  return append;
}

export function recordSessionBinding(session: AgentSession, nativeId: string, previous: string | null) {
  const source = sourceFor({session, projectPath: session.project_path ?? null, nativeId});
  if (!source || nativeId === previous) return;
  const at = new Date().toISOString();
  const fact: SessionLifecycleFact = {
    id: factId('bind', session.id, nativeId), at, action: previous ? 'resume' : 'create',
    state: 'accepted', evidence: 'platform', platform_session_id: session.id,
    ...(previous ? {related_native_id: previous} : {}),
  };
  insertPlatformFact(source, fact);
}

function insertPlatformFact(source: Source, fact: SessionLifecycleFact) {
  source.db.prepare(`INSERT OR IGNORE INTO session_statistics_events
    SELECT ?,?,?,COALESCE(MAX(position),0)+1,'platform',?,?
    FROM session_statistics_events WHERE source=? AND evidence='platform' AND occurred_at=?`).run(
    source.key, fact.id, fact.at, source.owner, json(fact), source.key, fact.at,
  );
  const row = rowFor(source);
  if (row) {
    const summary = readJson<SessionMetadata>(row.summary);
    summary.revision = Math.max(Date.now(), row.revision + 1);
    source.db.prepare('UPDATE session_statistics_sources SET revision=?,summary=? WHERE source=?')
      .run(summary.revision, json(summary), source.key);
  }
}

/** Stop/flush callers advance all complete records before they allow a native
 * history deletion. A missing source has no new records to publish. */
export async function flushSessionFactsBeforeDelete(context: AgentContext) {
  const source = sourceFor(context);
  if (!source) return;
  const path = await agentForSession(context.session).history.file?.locate(context);
  if (!path) return;
  const expiry = Date.now() + 30_000;
  const key = workKey(source);
  backlog.delete(key);
  for (;;) {
    try {
      await updateSessionFacts(context, path, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const row = rowFor(source);
    if (row?.caught_up) {
      const summary=readJson<SessionMetadata>(row.summary);
      if (summary.reasons.includes('incomplete_record')) throw Error('原生历史还有未写完的记录，用量已保存，原始历史已保留');
      return;
    }
    if (Date.now() >= expiry) throw Error('用量尚未持久化，原始历史已保留');
  }
}
