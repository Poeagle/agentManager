import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn }));

type Service = typeof import('../src/services/codex-quota.js');
let service: Service;
let children: FakeCodex[];
class FakeCodex extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null; signalCode: string | null = null;
  messages: any[] = [];
  replyQuota = true;
  kill = vi.fn(() => { this.signalCode = 'SIGTERM'; queueMicrotask(() => this.emit('close', null)); return true; });
  constructor() {
    super();
    this.stdin.on('data', (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      if (message.method === 'initialize') queueMicrotask(() => this.respond(message.id, {}));
      if (message.method === 'account/rateLimits/read' && this.replyQuota) {
        queueMicrotask(() => this.respond(message.id, { rateLimits: { secondary: {
          usedPercent: 36, windowDurationMins: 10080, resetsAt: 200,
        } } }));
      }
    });
  }
  respond(id: number, result: unknown) { this.stdout.write(JSON.stringify({ id, result }) + '\n'); }
  get reads() { return this.messages.filter((m) => m.method === 'account/rateLimits/read'); }
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); children = []; spawn.mockReset();
  spawn.mockImplementation(() => { const child = new FakeCodex(); children.push(child); return child; });
  service = await import('../src/services/codex-quota.js');
});
afterEach(async () => { service.shutdownCodexQuotaReader(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

describe('shared Codex quota reader', () => {
  it('coalesces clients, caches for five minutes and reuses one initialized process', async () => {
    const [a, b] = await Promise.all([service.readCodexWeeklyQuota(), service.readCodexWeeklyQuota()]);
    expect(a).toEqual(b); expect(a.remainingPercent).toBe(64);
    expect(spawn).toHaveBeenCalledOnce(); expect(children[0].reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299_999); await service.readCodexWeeklyQuota();
    expect(children[0].reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await service.readCodexWeeklyQuota();
    expect(children[0].reads).toHaveLength(2); expect(spawn).toHaveBeenCalledOnce();
    expect(children[0].messages.filter(m => m.method === 'initialize')).toHaveLength(1);
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['plugins', 'apps', 'analytics.enabled=false']));
  });
  it('manual refresh bypasses cached data without recreating the process', async () => {
    await service.readCodexWeeklyQuota();
    await service.readCodexWeeklyQuota({ force: true });
    expect(children[0].reads).toHaveLength(2); expect(spawn).toHaveBeenCalledOnce();
  });
  it('returns last successful data on timeout and applies backoff even to force refresh', async () => {
    const fresh = await service.readCodexWeeklyQuota(); children[0].replyQuota = false;
    const reading = service.readCodexWeeklyQuota({ force: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reading).toEqual({ ...fresh, stale: true });
    expect(children[0].kill).toHaveBeenCalledOnce();
    await service.readCodexWeeklyQuota({ force: true }); expect(spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await service.readCodexWeeklyQuota({ force: true })).stale).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('does not repeatedly spawn when the CLI cannot start', async () => {
    spawn.mockImplementationOnce(() => {
      const child = new FakeCodex(); children.push(child);
      queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child;
    });
    await expect(service.readCodexWeeklyQuota()).rejects.toThrow();
    await expect(service.readCodexWeeklyQuota({ force: true })).rejects.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
  });
  it('ignores notifications and matches responses by ID', async () => {
    await service.readCodexWeeklyQuota(); const child = children[0]; child.replyQuota = false;
    const reading = service.readCodexWeeklyQuota({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"method":"account/rateLimits/updated","params":{}}\n');
    child.respond(-1, {});
    child.respond(child.reads.at(-1).id, { rateLimits: { secondary: { usedPercent: 7, windowDurationMins: 10080 } } });
    expect((await reading).remainingPercent).toBe(93);
  });
  it('keeps cached quota when an idle child exits, then starts one replacement when needed', async () => {
    await service.readCodexWeeklyQuota(); children[0].exitCode = 1; children[0].emit('close', 1);
    await service.readCodexWeeklyQuota(); expect(spawn).toHaveBeenCalledOnce();
    await service.readCodexWeeklyQuota({ force: true }); expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('closes the child on shutdown', async () => {
    await service.readCodexWeeklyQuota(); service.shutdownCodexQuotaReader();
    expect(children[0].kill).toHaveBeenCalledOnce();
  });
});
