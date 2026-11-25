import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db/index.js';
import { MemorySessionReaper } from '../src/services/memory-session-reaper.js';
import * as agentSession from '../src/services/agents/session.js';
import { agentForSession } from '../src/services/agents/index.js';
import * as sessionManager from '../src/services/session-manager.js';
import { serverResourceSampler, type ServerResources } from '../src/services/server-resources.js';
import { getOrCreateTracker, removeTracker, type ProcessState } from '../src/services/session-state.js';
import { createTestDatabase } from './helpers/database.js';

describe('memory-pressure session cleanup', () => {
  let cleanup: () => void;
  let reaper: MemorySessionReaper;
  let latest: ServerResources;
  let publish: (resources: ServerResources) => void;
  const tracked = new Set<string>();
  const now = Date.UTC(2026, 9, 13, 8);

  function setting(key: string, value: string) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  function resources(percent: number): ServerResources {
    return {
      sampled_at: new Date().toISOString(), hostname: 'test-host', uptime_seconds: 100,
      cpu: { usage_percent: 20, core_count: 4, load_average_1m: 1 }, disk: null,
      memory: { total_bytes: 1000, used_bytes: percent * 10, available_bytes: (100 - percent) * 10, usage_percent: percent },
    };
  }

  function session(id: string, idleMinutes: number, options: {
    status?: string; state?: ProcessState; executing?: boolean; tracked?: boolean;
    agent?: 'codex' | 'claude'; mode?: 'terminal' | 'session'; native?: boolean;
  } = {}) {
    const agent = options.agent ?? 'codex';
    getDb().prepare(`
      INSERT INTO sessions (id, task, status, mode, project_id, cli_type, agent_id, native_session_id)
      VALUES (?, ?, ?, ?, 'project', ?, ?, ?)
    `).run(id, id, options.status ?? 'running', options.mode ?? 'session', agent, agent, options.native === false ? null : id);
    const input = agentForSession({agent_id: agent}).input;
    if (input.hasQueuedFollowUp && !vi.isMockFunction(input.hasQueuedFollowUp)) {
      vi.spyOn(input, 'hasQueuedFollowUp').mockResolvedValue(false);
    }
    if (options.tracked === false) return;
    tracked.add(id);
    const tracker = getOrCreateTracker(id);
    vi.spyOn(tracker, 'state', 'get').mockReturnValue({
      sessionId: id, processState: options.state ?? 'idle', lastActivity: now - idleMinutes * 60_000,
      promptType: null, choices: null, isPermission: false,
    });
    vi.spyOn(tracker, 'hasPendingExecute', 'get').mockReturnValue(options.executing ?? false);
    return tracker;
  }

  async function confirmPressure(percent = 90) {
    for (let time = -30_000; time < 0; time += 5_000) {
      vi.setSystemTime(now + time);
      latest = resources(percent);
      expect(await reaper.check()).toBeNull();
    }
    vi.setSystemTime(now);
    latest = resources(percent);
  }

  beforeEach(() => {
    ({ cleanup } = createTestDatabase());
    vi.useFakeTimers();
    vi.setSystemTime(now);
    reaper = new MemorySessionReaper();
    getDb().prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Test project', '/mock/project')").run();
    setting('memory_cleanup_enabled', 'true');
    latest = resources(90);
    vi.spyOn(serverResourceSampler, 'read').mockImplementation(async () => latest);
    vi.spyOn(serverResourceSampler, 'getLatest').mockImplementation(() => latest);
    vi.spyOn(serverResourceSampler, 'subscribe').mockImplementation((listener) => {
      publish = listener;
      return () => { publish = () => {}; };
    });
    vi.spyOn(sessionManager, 'isSessionActive').mockReturnValue(true);
    vi.spyOn(sessionManager, 'flushPendingPtyOutputWithRetry').mockResolvedValue(true);
    vi.spyOn(sessionManager, 'captureFinalSnapshot').mockResolvedValue(true);
    vi.spyOn(agentSession, 'readAgentRuntime').mockImplementation(async (session) => ({
      source: 'fixture', session_id: session.native_session_id!, state: 'idle',
      last_activity_at: new Date(now - 120 * 60_000).toISOString(),
      observed_at: new Date().toISOString(), reason: 'fixture',
    }));
    vi.spyOn(sessionManager, 'killSession').mockImplementation(async (id, options) => {
      if (options?.ifIdle && !options.ifIdle()) return false;
      getDb().prepare("UPDATE sessions SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(id);
      return true;
    });
  });

  afterEach(async () => {
    await reaper.stop();
    for (const id of tracked) removeTracker(id);
    tracked.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    cleanup();
  });

  it('waits through a brief spike and limits a sustained pressure episode to one closure', async () => {
    session('oldest', 60);
    session('next', 40);
    expect(await reaper.check()).toBeNull();
    vi.setSystemTime(now + 5_000);
    latest = resources(84);
    expect(await reaper.check()).toBeNull();

    for (let time = 10_000; time <= 120_000; time += 5_000) {
      vi.setSystemTime(now + time);
      latest = resources(85.2);
      const reclaimed = await reaper.check();
      expect(reclaimed).toBe(time === 40_000 ? 'oldest' : null);
    }
    expect(sessionManager.killSession).toHaveBeenCalledExactlyOnceWith('oldest', { ifIdle: expect.any(Function) });

    for (let time = 125_000; time <= 185_000; time += 5_000) {
      vi.setSystemTime(now + time);
      latest = resources(time <= 155_000 ? 84 : 90);
      expect(await reaper.check()).toBeNull();
    }
    vi.setSystemTime(now + 190_000);
    latest = resources(90);
    expect(await reaper.check()).toBe('next');
  });

  it('leaves a terminal waiting for a reply open', async () => {
    session('waiting', 60, { state: 'waiting_for_input' });
    for (let time = 0; time <= 40_000; time += 5_000) {
      vi.setSystemTime(now + time);
      latest = resources(90);
      await reaper.check();
    }
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('never closes sessions using an unreliable memory fallback', async () => {
    session('oldest', 60); latest.memory.reliable = false;
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('pauses the longest-idle session, preserving its record and publishing the reason', async () => {
    session('newer', 20);
    session('oldest', 60);
    session('middle', 40, { state: 'waiting_for_input' });
    await confirmPressure();
    expect(await reaper.check()).toBe('oldest');
    expect(sessionManager.killSession).toHaveBeenCalledExactlyOnceWith('oldest', { ifIdle: expect.any(Function) });
    expect(sessionManager.captureFinalSnapshot).toHaveBeenCalledWith('oldest');
    expect(vi.mocked(sessionManager.captureFinalSnapshot).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(sessionManager.killSession).mock.invocationCallOrder[0]);
    expect(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('oldest')).toEqual({ status: 'cancelled' });
    const event = getDb().prepare('SELECT type, data FROM events WHERE session_id = ?').get('oldest') as { type: string; data: string };
    expect(event.type).toBe('session.memory_cleanup');
    expect(JSON.parse(event.data)).toMatchObject({ reason: 'memory_pressure', threshold_percent: 85, idle_ms: 60 * 60_000 });
    expect(await reaper.check()).toBeNull(); // never close twice using the same sample
    vi.setSystemTime(now + 5000);
    latest = resources(90);
    expect(await reaper.check()).toBeNull();
  });

  it('does nothing while disabled, below the threshold, or when stored configuration is invalid', async () => {
    session('oldest', 60);
    setting('memory_cleanup_enabled', 'false');
    expect(await reaper.check()).toBeNull();
    setting('memory_cleanup_enabled', 'true');
    latest = resources(84.99);
    expect(await reaper.check()).toBeNull();
    latest = resources(90);
    setting('memory_cleanup_threshold_percent', 'invalid');
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('triggers at the configured threshold and minimum idle time, stopping when memory drops', async () => {
    setting('memory_cleanup_threshold_percent', '90.5');
    setting('memory_cleanup_idle_minutes', '15');
    session('boundary', 15);
    session('also-idle', 15);
    await confirmPressure(90.5);
    expect(await reaper.check()).toBe('also-idle');
    vi.setSystemTime(now + 5000);
    latest = resources(90);
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).toHaveBeenCalledTimes(1);
  });

  it('skips busy, executing, recently active, starting, ended and unobserved sessions', async () => {
    session('busy', 60, { state: 'busy' });
    session('executing', 60, { executing: true });
    session('recent', 9);
    session('starting', 60, { status: 'launching' });
    session('pending', 60, { status: 'pending' });
    session('ended', 60, { status: 'cancelled' });
    session('released', 60, { status: 'released' });
    session('no-tracker', 60, { tracked: false });
    session('shell', 80, { mode: 'terminal' });
    session('no-native-id', 80, { native: false });
    await confirmPressure();
    session('reconnecting', 60, { status: 'detached' });
    vi.mocked(sessionManager.isSessionActive).mockImplementation((id) => id !== 'reconnecting');
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('requires native idle evidence for a terminal-hosted Agent', async () => {
    session('native-running', 90);
    session('native-question', 80);
    session('native-idle', 60);
    const readIdle = vi.mocked(agentSession.readAgentRuntime).getMockImplementation()!;
    vi.mocked(agentSession.readAgentRuntime).mockImplementation(async session => {
      const runtime = await readIdle(session);
      if (session.id === 'native-running') return { ...runtime, state: 'running' };
      if (session.id === 'native-question') return { ...runtime, pending_question_count: 1 };
      return runtime;
    });
    await confirmPressure();
    expect(await reaper.check()).toBe('native-idle');
    expect(sessionManager.killSession).toHaveBeenCalledExactlyOnceWith('native-idle', { ifIdle: expect.any(Function) });
  });

  it('leaves a managed Claude session outside terminal cleanup', async () => {
    session('managed', 60, { agent: 'claude' });
    await confirmPressure();
    expect(await reaper.check()).toBeNull();
    expect(agentSession.readAgentRuntime).not.toHaveBeenCalled();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('rechecks the native runtime after saving the final screen', async () => {
    const readIdle = vi.mocked(agentSession.readAgentRuntime).getMockImplementation()!;
    session('oldest', 60);
    await confirmPressure();
    vi.mocked(sessionManager.captureFinalSnapshot).mockImplementation(async () => {
      vi.mocked(agentSession.readAgentRuntime).mockImplementation(async session => ({
        ...await readIdle(session), state: 'running',
      }));
      return true;
    });
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('counts input without echoed output as new activity', async () => {
    await confirmPressure();
    const tracker = session('typing', 60)!;
    vi.spyOn(tracker, 'state', 'get').mockRestore();
    tracker.onData('ready');
    await vi.advanceTimersByTimeAsync(2000);
    vi.setSystemTime(now + 60 * 60_000);
    tracker.recordInput();
    latest = resources(90);
    expect(tracker.state.lastActivity).toBe(Date.now());
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it.each(['activity', 'busy', 'execute', 'disabled', 'threshold', 'idle-time', 'memory', 'ended'] as const)(
    'rechecks %s changes that occur while saving the final screen', async (change) => {
      const tracker = session('oldest', 60)!;
      await confirmPressure();
      vi.mocked(sessionManager.captureFinalSnapshot).mockImplementation(async () => {
        if (change === 'activity') vi.spyOn(tracker, 'state', 'get').mockReturnValue({ ...tracker.state, lastActivity: now });
        if (change === 'busy') vi.spyOn(tracker, 'state', 'get').mockReturnValue({ ...tracker.state, processState: 'busy' });
        if (change === 'execute') vi.spyOn(tracker, 'hasPendingExecute', 'get').mockReturnValue(true);
        if (change === 'disabled') setting('memory_cleanup_enabled', 'false');
        if (change === 'threshold') setting('memory_cleanup_threshold_percent', '95');
        if (change === 'idle-time') setting('memory_cleanup_idle_minutes', '120');
        if (change === 'memory') latest = resources(70);
        if (change === 'ended') getDb().prepare("UPDATE sessions SET status = 'completed' WHERE id = 'oldest'").run();
        return true;
      });
      expect(await reaper.check()).toBeNull();
      expect(getDb().prepare("SELECT status FROM sessions WHERE id = 'oldest'").get())
        .toEqual({ status: change === 'ended' ? 'completed' : 'running' });
      expect(getDb().prepare("SELECT id FROM events WHERE type = 'session.memory_cleanup'").get()).toBeUndefined();
    },
  );

  it('avoids overlapping checks and cancels a pending close on shutdown', async () => {
    session('oldest', 60);
    await confirmPressure();
    let finishSnapshot!: (ok: boolean) => void;
    vi.mocked(sessionManager.captureFinalSnapshot).mockImplementation(() => new Promise((resolve) => { finishSnapshot = resolve; }));
    const check = reaper.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(await reaper.check()).toBeNull();
    const stop = reaper.stop();
    finishSnapshot(true);
    expect(await check).toBeNull();
    await stop;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it('uses each published snapshot without resampling and applies new settings without restarting', async () => {
    session('oldest', 60);
    setting('memory_cleanup_enabled', 'false');
    reaper.start();
    publish(latest);
    await vi.advanceTimersByTimeAsync(0);
    setting('memory_cleanup_enabled', 'true');
    await vi.advanceTimersByTimeAsync(4999);
    expect(sessionManager.killSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (let sample = 0; sample <= 6; sample++) {
      if (sample > 0) await vi.advanceTimersByTimeAsync(5000);
      latest = resources(90);
      publish(latest);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sessionManager.killSession).toHaveBeenCalledExactlyOnceWith('oldest', { ifIdle: expect.any(Function) });
    expect(serverResourceSampler.read).not.toHaveBeenCalled();
    await reaper.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    publish(resources(90));
    expect(sessionManager.killSession).toHaveBeenCalledTimes(1);
  });

  it('does not close a session using an expired snapshot', async () => {
    session('oldest', 60);
    vi.setSystemTime(now + 10_001);
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

  it.each(['flush', 'snapshot'] as const)('retains the session if %s fails', async (failure) => {
    session('oldest', 60);
    await confirmPressure();
    if (failure === 'flush') vi.mocked(sessionManager.flushPendingPtyOutputWithRetry).mockResolvedValue(false);
    else vi.mocked(sessionManager.captureFinalSnapshot).mockResolvedValue(false);
    expect(await reaper.check()).toBeNull();
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });
});
