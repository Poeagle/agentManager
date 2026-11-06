import { shellSingleQuote } from '../shell.js';
import type { AgentCommandOptions } from '../types.js';
function codexTransport(command: string, socket?: string | null): string {
    const remote = socket && !/(?:^|\s)--remote(?:\s|=)/.test(command) ? ` --remote ${shellSingleQuote(`unix://${socket}`)}` : '';
    // Embedded TUI shares the user daemon: changing its feature flags blocks startup.
    return `${command}${remote}${socket ? ' --disable plugins' : ''}`;
}
function tomlBasicString(value: string): string {
    return `"${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')}"`;
}
export function codexIdentityFlags(bindingPath?: string): string {
    if (!bindingPath)
        return '';
    const script = [
        "const fs=require('fs');",
        'try{',
        "const raw=fs.readFileSync(0,'utf8');",
        'const input=raw?JSON.parse(raw):{};',
        "const id=typeof input.session_id==='string'?input.session_id:'';",
        "if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)){",
        'const target=process.argv[1];',
        "const tmp=target+'.'+process.pid+'.tmp';",
        "fs.writeFileSync(tmp,JSON.stringify({session_id:id,cwd:input.cwd||'',captured_at:new Date().toISOString()}));",
        'fs.renameSync(tmp,target);',
        '}',
        '}catch{}',
    ].join('');
    const hookCommand = `node -e ${shellSingleQuote(script)} ${shellSingleQuote(bindingPath)}`;
    const hookConfig = `hooks.SessionStart=[{matcher="startup|resume",hooks=[{type="command",command=${tomlBasicString(hookCommand)},timeout=5}]}]`;
    return ` --dangerously-bypass-hook-trust -c ${shellSingleQuote(hookConfig)}`;
}
export function codexPermissions(command: string) { return /(?:^|\s)(?:--dangerously-bypass-approvals-and-sandbox|--yolo)(?=\s|$)/.test(command) ? command : `${command} --dangerously-bypass-approvals-and-sandbox`; }
export function codexResources(command: string, instructions: string) { return `${command} -c ${shellSingleQuote(`developer_instructions=${tomlBasicString(instructions)}`)}`; }
export function codexCommand(options: AgentCommandOptions) {
    const { task, direct, command = 'codex', resumeId, assignId, bindingPath, streamSocket = process.env.AGENTMANAGER_CODEX_STREAM_SOCKET } = options;
    const base = command || 'codex';
    let cmd: string;
    if (resumeId)
        cmd = `${codexTransport(base, streamSocket)} resume${streamSocket ? '' : codexIdentityFlags(bindingPath)} --no-alt-screen ${shellSingleQuote(resumeId)}`;
    else if (assignId)
        cmd = `${codexTransport(base, streamSocket)} resume --no-alt-screen ${shellSingleQuote(assignId)}`;
    else
        cmd = `${codexTransport(base, streamSocket)}${codexIdentityFlags(bindingPath)} --no-alt-screen ${shellSingleQuote(task)}`;
    return direct ? `command bash -c ${shellSingleQuote(cmd)}` : cmd;
}
