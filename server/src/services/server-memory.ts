import {readFile} from 'fs/promises';
import {execFile} from 'child_process';
import {freemem, platform, totalmem} from 'os';
const execute = (file:string, args:string[], options:import('child_process').ExecFileOptionsWithStringEncoding) => new Promise<{stdout:string}>((resolve,reject) => {
  execFile(file,args,options,(error,stdout) => error ? reject(error) : resolve({stdout}));
});

/** vm_stat prints free_count minus speculative_count, so both displayed queues
 * are disjoint. Purgeable pages overlap other queues and must not be added.
 * Source: apple-oss-distributions/system_cmds/vm_stat/vm_stat.c snapshot(). */
export function darwinAvailableBytes(output: string): number | null {
  const page = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  const queues = ['free', 'inactive', 'speculative'].map(name =>
    Number(output.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'm'))?.[1]));
  if (!Number.isSafeInteger(page) || page <= 0 || queues.some(n => !Number.isSafeInteger(n) || n < 0)) return null;
  const bytes = queues.reduce((a,b) => a+b, 0) * page;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** Called only by the coalesced five-second host sampler. Collection failures
 * retain a display estimate but cannot authorize automatic session cleanup. */
export async function readServerMemory() {
  const total = totalmem();
  let available = freemem(), reliable = false;
  try {
    if (platform() === 'linux') {
      const match = (await readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (match) { available = Number(match[1])*1024; reliable = true; }
    } else if (platform() === 'darwin') {
      const {stdout} = await execute('/usr/bin/vm_stat', [], {encoding:'utf8', timeout:1500, maxBuffer:64*1024, env:{...process.env, LC_ALL:'C'}});
      const bytes = darwinAvailableBytes(stdout);
      if (bytes !== null) { available = bytes; reliable = true; }
    }
  } catch { /* Portable free-memory estimate; never use it to terminate work. */ }
  available = Math.min(total, Math.max(0, available));
  const used = total-available;
  return {total_bytes:total, used_bytes:used, available_bytes:available,
    usage_percent:total > 0 ? used/total*100 : 0, reliable:reliable && total > 0};
}
