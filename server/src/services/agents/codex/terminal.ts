import { readdirSync, readlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../../../db/index.js';
import { procTree, processStartedAt } from '../process.js';
import { collectCodexRollouts } from './binding.js';
import { type CodexRolloutCandidate, codexSessionIdFromOpenTargets, selectCodexRolloutCandidate } from './identity-parsing.js';
const terminalCliRolloutScans = new Map<string, {
    pid: number;
    scannedAt: number;
}>();
function codexIdFromOpenRollout(cliPid: number): string | null {
    const targets: string[] = [];
    // The Codex TUI keeps its active rollout JSONL open. Search the CLI and its
    // descendants in case a release moves the writer into a child process.
    for (const pid of procTree(cliPid, 64)) {
        let fds: string[] = [];
        try {
            fds = readdirSync(`/proc/${pid}/fd`);
        }
        catch {
            continue;
        }
        for (const fd of fds) {
            try {
                targets.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
            }
            catch { /* fd closed during inspection */ }
        }
    }
    return codexSessionIdFromOpenTargets(targets);
}
/**
 * Fallback for Codex releases/process layouts that don't keep the rollout file
 * open. Search only the launch day's nearby directories, then require a unique
 * cwd + process-start match before binding the Terminal to a conversation.
 */
function codexIdFromProjectRollout(cliPid: number, projectPath: string, appSessionId: string): string | null {
    const now = Date.now();
    const previous = terminalCliRolloutScans.get(appSessionId);
    if (previous?.pid === cliPid && now - previous.scannedAt < 2000)
        return null;
    terminalCliRolloutScans.set(appSessionId, { pid: cliPid, scannedAt: now });
    const startedAt = processStartedAt(cliPid);
    if (!startedAt)
        return null;
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    const sessionRoot = join(codexHome, 'sessions');
    const rollouts: CodexRolloutCandidate[] = [];
    const visited = new Set<string>();
    for (const offset of [-24 * 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000]) {
        const date = new Date(startedAt + offset);
        const dir = join(sessionRoot, String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0'));
        if (visited.has(dir))
            continue;
        visited.add(dir);
        collectCodexRollouts(dir, rollouts);
    }
    if (rollouts.length === 0)
        return null;
    const used = new Set((getDb().prepare(`
      SELECT codex_session_id FROM sessions
      WHERE id != ? AND codex_session_id IS NOT NULL
    `).all(appSessionId) as Array<{
        codex_session_id: string;
    }>).map((row) => row.codex_session_id));
    return selectCodexRolloutCandidate(startedAt, projectPath, rollouts, used, '', 30000);
}
export function discoverCodexTerminal(context: import('../types.js').AgentContext, pid: number) { return codexIdFromOpenRollout(pid) || codexIdFromProjectRollout(pid, context.projectPath!, context.session.id!); }
