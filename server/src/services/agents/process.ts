import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
let clockTicksPerSecond: number | null = null;
function procChildren(pid: number): number[] {
    try {
        return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
            .trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
    }
    catch {
        return [];
    }
}
export function procTree(rootPid: number, limit = 128): number[] {
    const result: number[] = [];
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0 && result.length < limit) {
        const pid = queue.shift()!;
        if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid))
            continue;
        seen.add(pid);
        result.push(pid);
        queue.push(...procChildren(pid));
    }
    return result;
}
export function procArgs(pid: number): string[] {
    try {
        return readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
    }
    catch {
        return [];
    }
}
export function processStartedAt(pid: number): number | null {
    try {
        if (!clockTicksPerSecond) {
            clockTicksPerSecond = parseInt(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim(), 10) || 100;
        }
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0)
            return null;
        // Fields after comm start at proc field 3; starttime is field 22 => index 19.
        const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
        const startTicks = Number(fields[19]);
        const uptimeSeconds = Number(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
        if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds))
            return null;
        return Date.now() - (uptimeSeconds - startTicks / clockTicksPerSecond) * 1000;
    }
    catch {
        return null;
    }
}
