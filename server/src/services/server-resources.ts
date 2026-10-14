import { execFile } from 'child_process';
import { cpus, hostname, loadavg, uptime } from 'os';
import { promisify } from 'util';
import { broadcastEphemeral } from './event-store.js';
import { readServerMemory } from './server-memory.js';

export const RESOURCE_SAMPLE_INTERVAL_MS = 5000;
const execFileAsync = promisify(execFile);

interface CpuSnapshot { idle: number; total: number }
let previousCpuSnapshot: CpuSnapshot | null = null;

function cpuSnapshot(): CpuSnapshot {
  return cpus().reduce((sample, cpu) => ({
    idle: sample.idle + cpu.times.idle,
    total: sample.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  }), { idle: 0, total: 0 });
}

async function readCpuUsagePercent(): Promise<number> {
  let before = previousCpuSnapshot;
  if (!before) {
    before = cpuSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const after = cpuSnapshot();
  previousCpuSnapshot = after;
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  return totalDelta <= 0 ? 0 : Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

async function readDiskUsage() {
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', process.cwd()], { encoding: 'utf8', timeout: 3000 });
    const columns = stdout.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
    if (columns.length < 6) return null;
    const totalBytes = Number(columns[1]) * 1024;
    const usedBytes = Number(columns[2]) * 1024;
    const availableBytes = Number(columns[3]) * 1024;
    if (![totalBytes, usedBytes, availableBytes].every(Number.isFinite) || totalBytes <= 0) return null;
    return {
      total_bytes: totalBytes, used_bytes: usedBytes, available_bytes: availableBytes,
      usage_percent: Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)),
      mount: columns.slice(5).join(' '),
    };
  } catch { return null; }
}

async function collectServerResources() {
  const [cpuUsagePercent, disk] = await Promise.all([readCpuUsagePercent(), readDiskUsage()]);
  return {
    sampled_at: new Date().toISOString(),
    hostname: hostname(),
    uptime_seconds: Math.floor(uptime()),
    cpu: { usage_percent: cpuUsagePercent, core_count: cpus().length, load_average_1m: loadavg()[0] ?? 0 },
    memory: readServerMemory(),
    disk,
  };
}

export type ServerResources = Awaited<ReturnType<typeof collectServerResources>>;
type ResourceListener = (resources: ServerResources) => void;

/** One server-wide sampler. Reads return the current snapshot; only the timer
 * (or the very first read) collects metrics, regardless of consumer count. */
export class ServerResourceSampler {
  private latest: ServerResources | null = null;
  private inFlight: Promise<ServerResources> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<ResourceListener>();

  constructor(private collect: () => Promise<ServerResources> = collectServerResources) {}

  getLatest(): ServerResources | null { return this.latest; }

  read(): Promise<ServerResources> {
    return this.latest ? Promise.resolve(this.latest) : this.sample();
  }

  subscribe(listener: ResourceListener): () => void {
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.sample().catch((error) => console.error('[SERVER RESOURCES] Sampling failed:', error));
    };
    this.timer = setInterval(tick, RESOURCE_SAMPLE_INTERVAL_MS);
    this.timer.unref();
    // A bootstrap read may already have supplied the first snapshot.
    if (!this.latest) tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => {});
    this.latest = null;
  }

  private sample(): Promise<ServerResources> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().then((resources) => {
      this.latest = resources;
      broadcastEphemeral({ type: 'server.resources', data: { server_resources: resources } });
      for (const listener of this.listeners) {
        try { listener(resources); } catch (error) { console.error('[SERVER RESOURCES] Listener failed:', error); }
      }
      return resources;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}

export const serverResourceSampler = new ServerResourceSampler();
