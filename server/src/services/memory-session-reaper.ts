import { getDb } from '../db/index.js';
import { getSetting } from '../routes/settings.js';
import { insertEvent } from './event-store.js';
import { MEMORY_REAPER_DEFAULTS, memoryCleanupSettingError } from './memory-session-reaper-config.js';
import { RESOURCE_SAMPLE_INTERVAL_MS, serverResourceSampler, type ServerResources } from './server-resources.js';
import { getTracker } from './session-state.js';
import { captureFinalSnapshot, flushPendingPtyOutputWithRetry, isSessionActive, killSession } from './session-manager.js';

function cleanupSettings() {
  const settings = Object.fromEntries(Object.keys(MEMORY_REAPER_DEFAULTS).map((key) => [key, getSetting(key)]));
  return {
    enabled: settings.memory_cleanup_enabled === 'true' && !memoryCleanupSettingError(settings),
    threshold: Number(settings.memory_cleanup_threshold_percent),
    idleMs: Number(settings.memory_cleanup_idle_minutes) * 60_000,
  };
}

interface Candidate {
  id: string;
  project_id: string | null;
  lastActivity: number;
}

function idleCandidates(idleMs: number): Candidate[] {
  const now = Date.now();
  const sessions = getDb().prepare(`
    SELECT id, project_id FROM sessions WHERE status IN ('running', 'detached')
  `).all() as { id: string; project_id: string | null }[];
  const candidates: Candidate[] = [];
  for (const session of sessions) {
    // Only close processes whose live activity we can observe. Released and
    // reconnecting processes have no reliable tracker and must be left alone.
    if (!isSessionActive(session.id)) continue;
    const tracker = getTracker(session.id);
    if (!tracker || tracker.hasPendingExecute) continue;
    const state = tracker.state;
    if (state.processState === 'busy' || now - state.lastActivity < idleMs) continue;
    candidates.push({ ...session, lastActivity: state.lastActivity });
  }
  return candidates.sort((a, b) => a.lastActivity - b.lastActivity || a.id.localeCompare(b.id));
}

/** Close at most one session per fresh sample, allowing process teardown and
 * memory reclamation to finish before deciding whether another is needed. */
export class MemorySessionReaper {
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<string | null> | null = null;
  private stopped = false;
  private lastCleanupSample: string | null = null;

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
    if (!settings.enabled) return null;
    const sample = resources ?? await serverResourceSampler.read();
    if (this.stopped || !this.isFresh(sample) || sample.sampled_at === this.lastCleanupSample
      || sample.memory.usage_percent < settings.threshold) return null;
    const candidate = idleCandidates(settings.idleMs)[0];
    if (!candidate) return null;

    // killSession clears replay. Persist the tail and retain the final screen
    // before closing so history and explicit Resume keep working.
    if (!(await flushPendingPtyOutputWithRetry())) return null;
    if (this.stopped || !(await captureFinalSnapshot(candidate.id))) return null;

    // Input, output, configuration and shutdown can change during the snapshot.
    // Recheck all conditions before sending the termination signal.
    if (this.stopped) return null;
    const current = cleanupSettings();
    if (!current.enabled) return null;
    const latest = serverResourceSampler.getLatest() ?? sample;
    const memory = latest.memory;
    if (!this.isFresh(latest) || latest.sampled_at === this.lastCleanupSample || memory.usage_percent < current.threshold) return null;
    const stillOldest = idleCandidates(current.idleMs)[0];
    if (stillOldest?.id !== candidate.id || stillOldest.lastActivity !== candidate.lastActivity) return null;
    const idleMs = Date.now() - candidate.lastActivity;
    if (!(await killSession(candidate.id))) return null;
    this.lastCleanupSample = latest.sampled_at;

    insertEvent({
      session_id: candidate.id,
      project_id: candidate.project_id ?? undefined,
      type: 'session.memory_cleanup',
      data: {
        reason: 'memory_pressure',
        memory_usage_percent: memory.usage_percent,
        threshold_percent: current.threshold,
        idle_ms: idleMs,
        sampled_at: latest.sampled_at,
      },
    });
    console.log(`[MEMORY CLEANUP] Closed ${candidate.id}: memory ${memory.usage_percent.toFixed(1)}%, idle ${Math.floor(idleMs / 60_000)}m`);
    return candidate.id;
  }

  private isFresh(resources: ServerResources): boolean {
    const age = Date.now() - Date.parse(resources.sampled_at);
    return Number.isFinite(age) && age >= 0 && age <= RESOURCE_SAMPLE_INTERVAL_MS * 2;
  }
}

export const memorySessionReaper = new MemorySessionReaper();
