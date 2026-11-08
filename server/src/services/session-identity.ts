import {agentForSession,agentDescriptors} from './agents/index.js';
import {basename} from 'path';

export type CliType = string;

export interface NativeConversationFields {
  cli_type?: CliType | null;
  agent_id?:string|null;native_session_id?:string|null;
  claude_session_id?: string | null;
  codex_session_id?: string | null;
}

export {NATIVE_SESSION_ID_RE} from './agents/native-identifiers.js';
export {explicitClaudeSessionId,selectClaudeSessionCandidate,type ClaudeLogCandidate} from './agents/claude/identity-parsing.js';
export {codexSessionIdFromOpenTargets,codexRolloutCandidateFromPrefix,selectCodexRolloutCandidate,type CodexRolloutCandidate} from './agents/codex/identity-parsing.js';

export function nativeConversationId(session: NativeConversationFields): string | null {
  return session.native_session_id??agentForSession(session).identity.read(session);
}

/** Identify only the real top-level CLI executable, not similarly named args. */
export function cliTypeFromArgv(args: string[]): CliType | null {
  const command = basename(args[0] || '').toLowerCase();
  return agentDescriptors().find(agent=>agentForSession({agent_id:agent.id}).identity.matchesProcess?.(args)??agent.id===command)?.id??null;
}
