export type CliType = 'claude' | 'codex';

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;
}

/** Add a per-launch hook that records Codex's native conversation UUID. */
export function codexIdentityFlags(bindingPath?: string): string {
  if (!bindingPath) return '';
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
  return ` --enable hooks --dangerously-bypass-hook-trust -c ${shellSingleQuote(hookConfig)}`;
}

export function buildSessionCommand(
  task: string,
  direct = false,
  sessionCmd = '',
  cliType: CliType = 'claude',
  resumeSessionId?: string,
  assignSessionId?: string,
  codexBindingPath?: string,
): string {
  // Resume never receives the old task, so recovery cannot submit it twice.
  if (resumeSessionId) {
    const baseCmd = sessionCmd || (cliType === 'codex' ? 'codex' : 'claude');
    const cmd = cliType === 'codex'
      ? `${baseCmd} resume${codexIdentityFlags(codexBindingPath)} --no-alt-screen ${shellSingleQuote(resumeSessionId)}`
      : `${baseCmd} --resume ${shellSingleQuote(resumeSessionId)}`;
    return direct ? `command bash -c ${shellSingleQuote(cmd)}` : cmd;
  }
  if (cliType === 'codex') {
    const baseCmd = sessionCmd || 'codex';
    const cmd = `${baseCmd}${codexIdentityFlags(codexBindingPath)} --no-alt-screen ${shellSingleQuote(task)}`;
    return direct ? `command bash -c ${shellSingleQuote(cmd)}` : cmd;
  }
  const baseCmd = sessionCmd || 'claude';
  const sid = assignSessionId ? ` --session-id ${assignSessionId}` : '';
  const cmd = `${baseCmd}${sid} ${shellSingleQuote(task)}`;
  return direct ? `command ${cmd}` : cmd;
}

export function buildAgentCommand(
  agentType: string,
  task: string,
  direct = false,
  sessionCmd = '',
  cliType: CliType = 'claude',
  assignSessionId?: string,
  codexBindingPath?: string,
): string {
  let cmd: string;
  if (cliType === 'codex') {
    const baseCmd = sessionCmd || 'codex';
    const prompt = task
      ? `You are a ${agentType} agent. ${task}`
      : `You are a ${agentType} agent. Ask me what I want you to do.`;
    cmd = `${baseCmd}${codexIdentityFlags(codexBindingPath)} --no-alt-screen ${shellSingleQuote(prompt)}`;
  } else {
    const baseCmd = sessionCmd || 'claude';
    const sid = assignSessionId ? ` --session-id ${assignSessionId}` : '';
    cmd = task
      ? `${baseCmd}${sid} --agent ${shellSingleQuote(agentType)} ${shellSingleQuote(task)}`
      : `${baseCmd}${sid} --agent ${shellSingleQuote(agentType)}`;
  }
  return direct ? `command bash -c ${shellSingleQuote(cmd)}` : cmd;
}
