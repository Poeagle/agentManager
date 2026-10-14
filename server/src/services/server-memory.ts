import { readFileSync } from 'fs';
import { freemem, platform, totalmem } from 'os';

/** Count reclaimable Linux caches as available, just like the resource monitor. */
export function readServerMemory() {
  const total = totalmem();
  let available = freemem();
  if (platform() === 'linux') {
    try {
      const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (match) available = Number(match[1]) * 1024;
    } catch { /* use the portable free-memory value */ }
  }
  available = Math.min(total, Math.max(0, available));
  const used = total - available;
  return {
    total_bytes: total,
    used_bytes: used,
    available_bytes: available,
    usage_percent: total > 0 ? (used / total) * 100 : 0,
  };
}
