import {builtinAgentDescriptors} from '../lib/agents';
import { TerminalSquare,Bot,Globe } from 'lucide-react';
import type { Project } from '../lib/api';
import { ClaudeIcon, CodexIcon } from './CliIcons';

export type ProjectOpenMode = 'session' | 'terminal' | 'deepseek-harness';

export function projectOpenModes(project: Project, harnessUrl?: string) {
  const access = project.tool_access === null ? { can_session: false, can_terminal: false, session_clients: [] }
    : project.tool_access ?? { can_session: true, can_terminal: true, session_clients: ['claude', 'codex'] };
  return [
    ...(access.can_session?(project.agent_catalog??builtinAgentDescriptors()).filter(agent=>agent.capabilities.launch&&access.session_clients.includes(agent.id)).map(agent=>({id:agent.id,label:agent.label,mode:'session' as const,cli:agent.id,Icon:({claude:ClaudeIcon,codex:CodexIcon} as Record<string,typeof ClaudeIcon>)[agent.presentation.icon]||Bot})):[]),
    ...(harnessUrl && access.can_session ? [{id:'deepseek-harness',label:'DeepSeek Harness',mode:'deepseek-harness' as const,cli:undefined,Icon:Globe}] : []),
    ...(access.can_terminal ? [{ id: 'terminal' as const, label: 'Terminal', mode: 'terminal' as const, cli: undefined, Icon: TerminalSquare }] : []),
  ];
}
