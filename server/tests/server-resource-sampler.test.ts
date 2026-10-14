import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerResourceSampler, type ServerResources } from '../src/services/server-resources.js';

describe('shared server resource sampler', () => {
  let sampler: ServerResourceSampler;
  let collect: ReturnType<typeof vi.fn<() => Promise<ServerResources>>>;
  const resources = (): ServerResources => ({
    sampled_at: new Date().toISOString(), hostname: 'server', uptime_seconds: 100,
    cpu: { usage_percent: 20, core_count: 4, load_average_1m: 1 }, disk: null,
    memory: { total_bytes: 1000, used_bytes: 900, available_bytes: 100, usage_percent: 90 },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    collect = vi.fn(async () => resources());
    sampler = new ServerResourceSampler(collect);
  });
  afterEach(async () => { await sampler.stop(); vi.useRealTimers(); });

  it('shares one bootstrap collection and the same object across concurrent readers and subscribers', async () => {
    const header = vi.fn();
    const cleanup = vi.fn();
    sampler.subscribe(header);
    sampler.subscribe(cleanup);
    const samples = await Promise.all(Array.from({ length: 20 }, () => sampler.read()));
    expect(collect).toHaveBeenCalledTimes(1);
    for (const sample of samples) expect(sample).toBe(samples[0]);
    expect(header).toHaveBeenCalledExactlyOnceWith(samples[0]);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(samples[0]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await sampler.read()).toBe(samples[0]);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('collects only once every five seconds regardless of request timing or client count', async () => {
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = await sampler.read();
    await vi.advanceTimersByTimeAsync(2500);
    const monitor = await sampler.read();
    expect(monitor).toBe(first);
    sampler.start(); // duplicate startup cannot create a second timer
    await vi.advanceTimersByTimeAsync(2500);
    const second = await sampler.read();
    expect(second).not.toBe(first);
    expect(second.sampled_at).not.toBe(first.sampled_at);
    for (let i = 0; i < 10; i++) expect(await sampler.read()).toBe(second);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('continues sampling with no page open and stops sampling on shutdown', async () => {
    sampler.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(collect).toHaveBeenCalledTimes(4);
    await sampler.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(collect).toHaveBeenCalledTimes(4);
  });

  it('prevents overlapping slow collections and lets readers use the last complete sample', async () => {
    const first = await sampler.read();
    let complete!: (sample: ServerResources) => void;
    collect.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    sampler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(await sampler.read()).toBe(first);
    const newer = resources();
    complete(newer);
    await vi.advanceTimersByTimeAsync(0);
    expect(await sampler.read()).toBe(newer);
  });

  it('retains a successful sample after a failed collection and recovers on the next tick', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = await sampler.read();
    collect.mockRejectedValueOnce(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await sampler.read()).toBe(first);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await sampler.read()).not.toBe(first);
    expect(collect).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('sends the latest sample to new subscribers and removes stopped consumers', async () => {
    const first = await sampler.read();
    const listener = vi.fn();
    const unsubscribe = sampler.subscribe(listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
    unsubscribe();
    sampler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
