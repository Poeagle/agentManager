import {Bot} from 'lucide-react';
import {ClaudeIcon,CodexIcon} from './CliIcons';
import {sessionAgent} from '../lib/agents';
import type {Session} from '../lib/api';
const icons:Record<string,typeof CodexIcon>={codex:CodexIcon,claude:ClaudeIcon};
export function AgentIcon({session,className}:{session:Partial<Session>;className?:string}){const agent=sessionAgent(session),Icon=icons[agent.presentation.icon]||Bot;return <Icon className={className} style={{color:agent.presentation.color}}/>;}
