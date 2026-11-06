import {beforeEach, expect, it, vi} from 'vitest';
import {readFile} from 'fs/promises';
import {execFile} from 'child_process';
import {freemem, platform, totalmem} from 'os';
import {darwinAvailableBytes, readServerMemory} from '../src/services/server-memory.js';
vi.mock('fs/promises', async original => ({...await original<typeof import('fs/promises')>(), readFile:vi.fn()}));
vi.mock('os', async original => ({...await original<typeof import('os')>(),freemem:vi.fn(),platform:vi.fn(),totalmem:vi.fn()}));
vi.mock('child_process', () => ({execFile:vi.fn()}));
const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10693.\nPages inactive: 260544.\nPages speculative: 606.\nPages purgeable: 8241.\n';
beforeEach(() => {
  vi.mocked(platform).mockReturnValue('linux'); vi.mocked(totalmem).mockReturnValue(8*1024**3); vi.mocked(freemem).mockReturnValue(1024);
  vi.mocked(readFile).mockResolvedValue('MemAvailable: 200 kB\n');
});
it('counts Linux caches as available', async () => {
  expect(await readServerMemory()).toMatchObject({available_bytes:200*1024, reliable:true});
});
it('reads macOS page size and disjoint reclaimable queues without adding overlapping purgeable pages', async () => {
  vi.mocked(platform).mockReturnValue('darwin');
  vi.mocked(execFile).mockImplementation((...args:any[]) => {args.at(-1)(null,vm,'');return {} as any;});
  expect(darwinAvailableBytes(vm)).toBe((10693+260544+606)*16384);
  expect(await readServerMemory()).toMatchObject({available_bytes:(10693+260544+606)*16384,reliable:true});
  expect(darwinAvailableBytes(vm.replace('16384','4096'))).toBe((10693+260544+606)*4096);
});
it('rejects incomplete samples and marks portable fallback unsafe for cleanup', async () => {
  expect(darwinAvailableBytes('Pages free: 2.')).toBeNull();
  vi.mocked(readFile).mockRejectedValue(new Error('no procfs'));
  expect(await readServerMemory()).toMatchObject({available_bytes:1024,reliable:false});
  vi.mocked(platform).mockReturnValue('darwin');
  vi.mocked(execFile).mockImplementation((...args:any[]) => {args.at(-1)(new Error('timeout'));return {} as any;});
  expect(await readServerMemory()).toMatchObject({available_bytes:1024,reliable:false});
});
it('bounds inconsistent samples and handles zero total', async () => {
  vi.mocked(totalmem).mockReturnValue(0);
  expect(await readServerMemory()).toMatchObject({used_bytes:0,usage_percent:0,reliable:false});
});
