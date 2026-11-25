import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { userCanUseSessionTool } from '../auth.js';
import { isRetiredEnvironment } from './agents/environment-access.js';
import { userHasPermission } from './rbac.js';
import { agentDocsLaunchInstructions } from '../shared/conversation-context.js';
import type { AgentSession } from './agents/types.js';

export const agentDocsRoot = new URL('../data/agent-skills/agent-docs/', import.meta.url);
export const agentDocsFollowUpLimit = 20;
export const agentDocsApiPath = '/api/agent-docs';
export const agentDocsLiveStates = ['running', 'pending', 'launching', 'detached', 'released'];
const audience = 'agent-docs:tab:v1';
let cachedSecret: { path: string; value: Buffer } | undefined;

function installationSecret() {
  const path = join(dirname(config.dbPath), '.agent-docs-secret');
  if (cachedSecret?.path === path) return cachedSecret.value;
  let secret: Buffer;
  try { secret = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    secret = randomBytes(32);
    try { writeFileSync(path, secret, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      secret = readFileSync(path);
    }
  }
  if (secret.length !== 32) throw new Error('Agent Docs 安装凭据无效');
  cachedSecret = { path, value: secret };
  return secret;
}

export function agentDocsAllowed(session: AgentSession, level: 'read' | 'write' = 'read') {
  const userId = session.created_by_user_id;
  return !!(session.id && session.project_id && userId && session.mode === 'session' &&
    !isRetiredEnvironment(session.agent_environment_id) && agentDocsLiveStates.includes(session.status || '') && userHasPermission(userId, 'agent_api', level) &&
    userCanUseSessionTool(userId, session.id, session.agent_id || session.cli_type || 'claude', 'session'));
}

function signature(session: AgentSession) {
  return createHmac('sha256', installationSecret())
    .update(JSON.stringify([audience, session.id, session.created_by_user_id, session.project_id]))
    .digest('base64url');
}

export function verifyAgentDocsToken(session: AgentSession, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !agentDocsAllowed(session)) return false;
  return timingSafeEqual(Buffer.from(signature(session)), Buffer.from(token));
}

/** Call only for a platform-owned Agent launch. The credential stays in process configuration. */
export function agentDocsLaunch(session: AgentSession) {
  if (!agentDocsAllowed(session)) return undefined;
  const root = fileURLToPath(agentDocsRoot);
  const ipv6Only = config.host.includes(':') && config.host !== '::';
  const host = ipv6Only ? '[::1]' : '127.0.0.1';
  return {
    instructions: agentDocsLaunchInstructions(`${root}SKILL.md`),
    environment: {
      AGENT_MANAGER_COLLABORATION_URL: `http://${host}:${config.port}${agentDocsApiPath}`,
      AGENT_MANAGER_COLLABORATION_SESSION: `ad1.${session.id}.${signature(session)}`,
    },
  };
}

interface HandoffInput { targetId: string; userId: string; clientId: string; label: string }
const handoffInput = new AsyncLocalStorage<HandoffInput>();

/** Attribute platform-routed input without accepting sender identity in public request data. */
export function withAgentDocsHandoff<T>(input: HandoffInput, submit: () => Promise<T>) {
  return handoffInput.run(input, submit);
}

export function agentDocsHandoff(targetId: string, userId: string, clientId: unknown) {
  const current = handoffInput.getStore();
  return current?.targetId === targetId && current.userId === userId && current.clientId === clientId ? current : undefined;
}
