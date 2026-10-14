import { TerminalSquare } from 'lucide-react';
import type { Project } from '../lib/api';
import { ClaudeIcon, CodexIcon } from './CliIcons';

export function projectOpenModes(project: Project) {
  const access = project.tool_access === null ? { can_session: false, can_terminal: false, session_clients: [] }
    : project.tool_access ?? { can_session: true, can_terminal: true, session_clients: ['claude', 'codex'] };
  return [
    ...(access.can_session ? [
      { id: 'claude' as const, label: 'Claude', mode: 'session' as const, cli: 'claude' as const, Icon: ClaudeIcon },
      { id: 'codex' as const, label: 'Codex', mode: 'session' as const, cli: 'codex' as const, Icon: CodexIcon },
    ].filter((option) => access.session_clients.includes(option.id)) : []),
    ...(access.can_terminal ? [{ id: 'terminal' as const, label: 'Terminal', mode: 'terminal' as const, cli: undefined, Icon: TerminalSquare }] : []),
  ];
}
