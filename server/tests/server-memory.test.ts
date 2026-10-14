import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { freemem, platform, totalmem } from 'os';
import { readServerMemory } from '../src/services/server-memory.js';

vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>(), readFileSync: vi.fn() }));
vi.mock('os', async (importOriginal) => ({ ...await importOriginal<typeof import('os')>(), freemem: vi.fn(), platform: vi.fn(), totalmem: vi.fn() }));

describe('server memory sampling', () => {
  beforeEach(() => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(totalmem).mockReturnValue(1000 * 1024);
    vi.mocked(freemem).mockReturnValue(50 * 1024);
    vi.mocked(readFileSync).mockReturnValue('MemTotal: 1000 kB\nMemFree: 50 kB\nMemAvailable: 200 kB\n');
  });

  it('uses Linux available memory so reclaimable caches do not cause premature cleanup', () => {
    expect(readServerMemory()).toEqual({
      total_bytes: 1000 * 1024, used_bytes: 800 * 1024, available_bytes: 200 * 1024, usage_percent: 80,
    });
  });

  it('uses portable free memory when procfs is unavailable or the platform is not Linux', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('no procfs'); });
    expect(readServerMemory().usage_percent).toBe(95);
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(readFileSync).mockClear();
    expect(readServerMemory().usage_percent).toBe(95);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('bounds inconsistent samples and handles zero total memory', () => {
    vi.mocked(readFileSync).mockReturnValue('MemAvailable: 2000 kB\n');
    expect(readServerMemory().usage_percent).toBe(0);
    vi.mocked(totalmem).mockReturnValue(0);
    expect(readServerMemory()).toEqual({ total_bytes: 0, used_bytes: 0, available_bytes: 0, usage_percent: 0 });
  });
});
