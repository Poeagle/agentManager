import { getDb } from '../db/index.js';
import { getSetting } from '../routes/settings.js';
import { agentForSession } from './agents/index.js';
import { readAgentRuntime, sessionAgentContext } from './agents/session.js';
import { nativeConversationId } from './session-identity.js';
import { insertEvent } from './event-store.js';
import { MEMORY_REAPER_DEFAULTS, memoryCleanupSettingError } from './memory-session-reaper-config.js';
import { RESOURCE_SAMPLE_INTERVAL_MS, serverResourceSampler, type ServerResources } from './server-resources.js';
import { getTracker } from './session-state.js';
import { captureFinalSnapshot, flushPendingPtyOutputWithRetry, isSessionActive, killSession, type Session } from './session-manager.js';

function cleanupSettings() {
  const settings = Object.fromEntries(Object.keys(MEMORY_REAPER_DEFAULTS).map((key) => [key, getSetting(key)]));
  return {
    enabled: settings.memory_cleanup_enabled === 'true' && !memoryCleanupSettingError(settings),
    threshold: Number(settings.memory_cleanup_threshold_percent),
    idleMs: Number(settings.memory_cleanup_idle_minutes) * 60_000,
  };
}

const PRESSURE_CONFIRM_MS = 30_000;

function idleActivity(session: Session, idleMs: number): number | null {
  const tracker = getTracker(session.id);
  if (!tracker || tracker.hasPendingExecute || !isSessionActive(session.id)) return null;
  const { processState, lastActivity } = tracker.state;
  return processState === 'idle' && Date.now() - lastActivity >= idleMs ? lastActivity : null;
}

function idleCandidates(idleMs: number) {
  const sessions = getDb().prepare(`
    SELECT * FROM sessions WHERE status = 'running' AND mode IS NOT 'terminal' AND project_id IS NOT NULL
  `).all() as Session[];
  return sessions.flatMap(session => {
    const lastActivity = idleActivity(session, idleMs);
    if (lastActivity === null) return [];
    try {
      const { descriptor } = agentForSession(session);
      return descriptor.sessionHost === 'terminal' && descriptor.capabilities.resume && nativeConversationId(session)
        ? [{ session, lastActivity }] : [];
    } catch { return []; }
  }).sort((a, b) => a.lastActivity - b.lastActivity || a.session.id.localeCompare(b.session.id));
}

async function nativeIdle(session: Session, idleMs: number): Promise<boolean> {
  try {
    const { input } = agentForSession(session);
    const runtime = await readAgentRuntime(session);
    return runtime.state === 'idle' && !runtime.compaction && !runtime.pending_question_count
      && !runtime.pending_questions?.length && !runtime.queued_answer_count
      && Date.now() - Date.parse(runtime.last_activity_at ?? '') >= idleMs
      && !await input.hasQueuedFollowUp?.(sessionAgentContext(session));
  } catch { return false; }
}

/** A shared host can stay near the threshold because of other processes.
 * Confirm sustained pressure and reclaim once until memory stays healthy. */
export class MemorySessionReaper {
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<string | null> | null = null;
  private stopped = false;
  private pressure: { above: boolean; since: number; last: number; threshold: number } | null = null;
  private reclaimed = false;

  start(): void {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = serverResourceSampler.subscribe((resources) => {
      void this.check(resources).catch((error) => console.error('[MEMORY CLEANUP] Check failed:', error));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.inFlight?.catch(() => {});
  }

  check(resources?: ServerResources): Promise<string | null> {
    if (this.stopped || this.inFlight) return Promise.resolve(null);
    this.inFlight = this.reap(resources).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async reap(resources?: ServerResources): Promise<string | null> {
    const settings = cleanupSettings();
    if (!settings.enabled) { this.pressure = null; return null; }
    const sample = resources ?? await serverResourceSampler.read();
    if (this.stopped || !this.observePressure(sample, settings.threshold)) return null;

    // A quiet terminal may still be running a turn or awaiting a response.
    let oldest: ReturnType<typeof idleCandidates>[number] | undefined;
    for (const entry of idleCandidates(settings.idleMs)) {
      if (this.stopped) return null;
      if (await nativeIdle(entry.session, settings.idleMs)) { oldest = entry; break; }
    }
    if (!oldest || this.stopped) return null;
    const candidate = oldest;
    const { id, project_id } = candidate.session;

    if (!(await flushPendingPtyOutputWithRetry())) return null;
    if (this.stopped || !(await captureFinalSnapshot(id))) return null;
    if (!await nativeIdle(candidate.session, settings.idleMs)) return null;

    const current = cleanupSettings();
    const latest = serverResourceSampler.getLatest() ?? sample;
    if (this.stopped || !current.enabled || current.threshold !== settings.threshold
      || current.idleMs !== settings.idleMs || !this.observePressure(latest, current.threshold)) return null;
    const idleMs = Date.now() - candidate.lastActivity;
    const eligible = () => {
      const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
      return !!row && row.status === 'running'
        && row.agent_environment_id === candidate.session.agent_environment_id
        && nativeConversationId(row) === nativeConversationId(candidate.session)
        && idleActivity(row, current.idleMs) === candidate.lastActivity;
    };
    if (!(await killSession(id, { ifIdle: eligible }))) return null;
    this.reclaimed = true;

    const stopped = getDb().prepare("SELECT completed_at FROM sessions WHERE id = ? AND status = 'cancelled'").get(id) as
      { completed_at: string | null } | undefined;
    if (stopped?.completed_at) insertEvent({
      session_id: id,
      project_id: project_id ?? undefined,
      type: 'session.memory_cleanup',
      data: {
        reason: 'memory_pressure',
        memory_usage_percent: latest.memory.usage_percent,
        threshold_percent: current.threshold,
        idle_ms: idleMs,
        sampled_at: latest.sampled_at,
      },
    }, stopped.completed_at);
    console.log(`[MEMORY CLEANUP] Paused ${id}: memory ${latest.memory.usage_percent.toFixed(1)}%, idle ${Math.floor(idleMs / 60_000)}m`);
    return id;
  }

  private observePressure(sample: ServerResources, threshold: number): boolean {
    if (!this.isFresh(sample) || sample.memory.reliable === false || !Number.isFinite(sample.memory.usage_percent)) {
      this.pressure = null;
      return false;
    }
    const at = Date.parse(sample.sampled_at);
    const above = sample.memory.usage_percent >= threshold;
    const previous = this.pressure;
    if (previous && at < previous.last) return false;
    const continuous = previous?.above === above && previous.threshold === threshold
      && at - previous.last <= RESOURCE_SAMPLE_INTERVAL_MS * 2;
    const since = continuous ? previous.since : at;
    this.pressure = { above, since, last: at, threshold };
    if (at - since < PRESSURE_CONFIRM_MS) return false;
    if (!above) this.reclaimed = false;
    return above && !this.reclaimed;
  }

  private isFresh(resources: ServerResources): boolean {
    const age = Date.now() - Date.parse(resources.sampled_at);
    return Number.isFinite(age) && age >= 0 && age <= RESOURCE_SAMPLE_INTERVAL_MS * 2;
  }
}

export const memorySessionReaper = new MemorySessionReaper();
