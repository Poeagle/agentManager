import { shellSingleQuote } from '../shell.js';
import type { AgentCommandOptions } from '../types.js';
export function claudePermissions(command: string) { return /(?:^|\s)--dangerously-skip-permissions(?=\s|$)/.test(command) ? command : `${command} --dangerously-skip-permissions`; }
export function claudeResources(command: string, instructions: string) { return `${command} --append-system-prompt ${shellSingleQuote(instructions)}`; }
export function claudeCommand(options: AgentCommandOptions) {
    const { task, direct, command = 'claude', resumeId, assignId } = options;
    const base = command || 'claude', cmd = resumeId ? `${base} --resume ${shellSingleQuote(resumeId)}` : `${base}${assignId ? ` --session-id ${assignId}` : ''}${task ? ` ${shellSingleQuote(task)}` : ''}`;
    return direct ? `command bash -c ${shellSingleQuote(cmd)}` : cmd;
}
