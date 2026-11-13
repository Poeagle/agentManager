import {conversationQuestionReply} from '../services/conversation-question-reply.js';
import {closeAccountTransports} from '../services/agents/codex/account-transport.js';
import {canControlEnvironment,assertEnvironmentUse,watchSessionEnvironment} from '../services/agents/environment-access.js';
import {AgentSubmissionError} from '../services/agents/submission.js';
import {sendAgentQuota} from '../services/agents/quota-response.js';
import {withTerminalInput} from '../services/agents/terminal-input.js';
import {observeAgentConversation} from '../services/agents/host.js';
import {readModelPreference,saveModelPreference,modelPreferenceSubmittedAt} from '../services/agents/model-preferences.js';
import {agentForSession,agentDescriptors,getAgent} from '../services/agents/index.js';
import {sessionAgentContext,readAgentRuntime,presentAgentSession} from '../services/agents/session.js';
import {nativeConversationId} from '../services/session-identity.js';
import {rememberConversationInput,linkConversationInputs,boundConversationInputs} from '../services/conversation-input-links.js';
import {FastifyPluginAsync} from 'fastify';
import {createRequire} from 'module';
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as { Terminal: any };
import {isSessionActive,writeToSession,querySessionOutputSince,getSession,getSessionSnapshot} from '../services/session-manager.js';
import {RESIZE_MARKER} from '../services/session-manager.js';
import {attachExistingSession} from '../services/session-attachment.js';
import {getTracker,getOrCreateTracker} from '../services/session-state.js';
import type {SessionState} from '../services/session-state.js';
import {getSessionUser,readSessionCookie,sessionCookieName,userCanUseSessionTool,isAdmin} from '../auth.js';
import {registerUserConnection} from '../services/user-connections.js';
import {requirePermission,userHasPermission} from '../services/rbac.js';
import {getDb} from '../db/index.js';
import {loadRecentAgentMessages,loadRecentPromptContext} from '../services/prompt-context.js';
import {sessionPresenter} from '../services/session-labels.js';
import {randomUUID} from 'crypto';
import {readConversation} from '../services/conversation-reader.js';
import {config} from '../config.js';

import {personalQuestionRuntime} from '../services/question-attention.js';
import {decorateConversationAttachments,rememberConversationAttachments,formatConversationInput,nativeConversationInput,validateConversationAttachments,validateConversationAnswerAttachments} from '../services/conversation-attachments.js';
import {observeConversationFile} from '../services/conversation-file-stream.js';
import {ConversationRetryManager} from '../services/conversation-retry.js';
import {ConversationProjection} from '../services/conversation-projection.js';


function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' {
  if (mode === 'terminal') return mode;
  return 'session';
}

function normalizeCliType(cliType: string | null | undefined): string {
  return getAgent(cliType||'claude').descriptor.id;
}

function canAccessAgentSession(userId: string, sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session) return false;
  return userCanUseSessionTool(userId, sessionId, normalizeCliType(session.cli_type), normalizeMode(session.mode));
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_QUIESCENCE = 2000;
const MAX_EXECUTE_INPUT_BYTES = 64 * 1024;
const MAX_WAIT_FOR_LENGTH = 512;
const MAX_EXECUTE_TIMEOUT = 120_000;
const MAX_EXECUTE_QUIESCENCE = 30_000;
const MAX_AGENT_MESSAGE_BYTES = 128 * 1024;
const pendingInputs = new Map<string, Promise<unknown>>();

interface ValidatedExecuteRequest {
  input: string;
  waitFor?: string;
  timeout: number;
  quiescenceMs: number;
  stripAnsi: boolean;
}

export function validateExecuteRequest(value: unknown): { ok: true; request: ValidatedExecuteRequest } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Request body must be an object' };
  const body = value as Record<string, unknown>;
  if (typeof body.input !== 'string') return { ok: false, error: 'input is required and must be a string' };
  if (Buffer.byteLength(body.input) > MAX_EXECUTE_INPUT_BYTES) return { ok: false, error: 'input is too large' };
  if (body.waitFor !== undefined && (typeof body.waitFor !== 'string' || body.waitFor.length > MAX_WAIT_FOR_LENGTH)) {
    return { ok: false, error: `waitFor must be a literal string of at most ${MAX_WAIT_FOR_LENGTH} characters` };
  }
  const timeout = body.timeout ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > MAX_EXECUTE_TIMEOUT) {
    return { ok: false, error: `timeout must be an integer between 100 and ${MAX_EXECUTE_TIMEOUT}` };
  }
  const quiescenceMs = body.quiescenceMs ?? DEFAULT_QUIESCENCE;
  if (!Number.isInteger(quiescenceMs) || (quiescenceMs as number) < 100 || (quiescenceMs as number) > MAX_EXECUTE_QUIESCENCE) {
    return { ok: false, error: `quiescenceMs must be an integer between 100 and ${MAX_EXECUTE_QUIESCENCE}` };
  }
  if (body.stripAnsi !== undefined && typeof body.stripAnsi !== 'boolean') {
    return { ok: false, error: 'stripAnsi must be a boolean' };
  }
  return {
    ok: true,
    request: {
      input: body.input,
      waitFor: typeof body.waitFor === 'string' && body.waitFor ? body.waitFor : undefined,
      timeout: timeout as number,
      quiescenceMs: quiescenceMs as number,
      stripAnsi: body.stripAnsi !== false,
    },
  };
}

/**
 * The single source of truth for the supported external Agent API surface.
 * The dashboard guide and its copyable prompt both render this response.
 */
export function getAgentApiContract() {
  return {
    name: 'AgentManager Agent API',
    version:'3.6.0',
    updatedAt:'2026-11-12',
    scope: 'Supported external automation API for authentication, project discovery and management, session lifecycle/control, scheduled tasks, agent quota reads, and configured prompt enhancement. Internal dashboard, administration, filesystem, Git, settings, and UI-state routes are intentionally outside this contract.',
    description: 'Authenticated automation API for permitted AgentManager projects, sessions, scheduled tasks, and configured prompt enhancement. This response is the single source of truth used by the dashboard guide and its copyable prompt.',
    authentication: {
      type: 'HttpOnly session cookie or scoped API Key',
      cookieName: sessionCookieName(),
      loginEndpoint: '/api/auth/login',
      capabilitiesEndpoint: '/api/agent/capabilities',
      login: 'Use a platform API Key for supported HTTP routes, or POST /api/auth/login with { username, password } and store the returned cookie privately.',
      usage: 'For supported HTTP routes send Authorization: Bearer <API Key> or the session cookie. WebSocket handshakes require a browser session cookie; API Keys do not support WebSocket access.',
      errors: { 401: 'Missing, expired, or invalid login session.' },
      security: 'Keep API Keys, passwords and cookies in a private credential store. API Key grants and the account’s current permissions are both checked for each request.',
    },
    authorization: {
      platform: 'Platform functions use RBAC role grants. Agent API inspection requires agent_api read; execute/cancel and agent WebSocket connections require agent_api write. Project/tool permissions and session ownership are checked separately.',
      projects: 'GET /api/projects returns only visible projects plus tool_access flags for the authenticated user.',
      sessions: 'Members can create only permitted mode/CLI combinations and can control only their own sessions. Administrators can monitor and interact with permitted sessions, but DELETE /api/sessions/:id may kill only a session created by the logged-in user.',
      scheduledTasks: 'Scheduled tasks, their run history, and existing-session targets are always restricted to the logged-in user.',
      promptEnhancer: 'Prompt enhancement can target only a tab created by the logged-in user. Its LLM configuration and API key require platform settings write permission and are never exposed by this API.',
      createSession: 'The project must already be registered. Supply project_id and its matching project_path; project_path alone is resolved only when it exactly matches a registered project. Codex Engine access is checked against the current user, including per-user overrides.',
    },
    critical: [
      'AUTHENTICATE before reading capabilities or calling any other protected endpoint.',
      'ALWAYS read GET /api/agent/capabilities after authentication before creating or controlling sessions.',
      'NEVER read PTY output directly, scrape temp files, or parse raw terminal data.',
      'Use GET /api/sessions/:id/display for read-only monitoring and POST /api/sessions/:id/execute only when sending input.',
      'The display and execute response "output" fields contain clean rendered text — trust them.',
      'Use the state embedded in GET /api/sessions/:id/display (or GET /state) to check prompt type and choices before responding.',
      'The state "choices" array gives you exact option text for choice prompts — use it.',
      'DELETE /api/sessions/:id can kill only a session created by the logged-in user, including for administrators.',
      'Scheduled tasks can target only the logged-in user\'s open tabs or create a permitted new tab.',
      'Prompt enhancement operates only on a supplied draft and never reads native terminal input or another user\'s tab.',
    ],
    quickstart: [
      '1. Authenticate HTTP requests with a scoped API Key or POST /api/auth/login and persist the returned cookie securely',
      '2. GET /api/agent/capabilities — read this current contract',
      '3. GET /api/projects — select a visible project whose tool_access permits the desired mode and CLI',
      '4. POST /api/sessions — create a permitted session (returns session id)',
      '5. GET /api/sessions/:id/display — poll for rendered output + state (single call, cursor-based)',
      '6. POST /api/sessions/:id/execute — send input only when needed and receive clean rendered output',
      '7. Repeat 5-6 until done. Use ?since=cursor from the display response for incremental updates.',
    ],
    stateMachine: {
      states: {
        busy: 'Session is producing output. POST input can submit a follow-up immediately; the CLI controls how it handles the new message.',
        idle: 'No output for 2s and no prompt detected. Safe to send input.',
        waiting_for_input: 'A prompt was detected. Check promptType and choices for what is expected.',
      },
      transitions: [
        { from: 'busy', to: 'idle', trigger: 'No PTY output for quiescenceMs (default 2000ms) and no prompt pattern detected' },
        { from: 'busy', to: 'waiting_for_input', trigger: 'No PTY output for quiescenceMs and a prompt pattern was detected in output tail' },
        { from: 'idle', to: 'busy', trigger: 'New PTY output received' },
        { from: 'waiting_for_input', to: 'busy', trigger: 'New PTY output received (typically after input is sent)' },
      ],
    },
    promptTypes: {
      choice: 'Numbered option list (e.g. "1. Option A\\n2. Option B"). Respond with the number.',
      confirmation: 'Yes/No prompt (e.g. "(Y/n)"). Respond with y or n.',
      text: 'Free-form text prompt (trailing "> " or "? "). Respond with text.',
    },
    endpoints: [
      {
        category: 'Authentication',
        method: 'POST',
        path: '/api/auth/login',
        public: true,
        description: `Authenticate and set the HttpOnly ${sessionCookieName()} cookie. Use a cookie-capable client and keep the returned cookie private.`,
        request: {
          username: { type: 'string', required: true },
          password: { type: 'string', required: true },
        },
        response: { user: 'Authenticated user (password hash omitted)', setCookie: `${sessionCookieName()} (HttpOnly; SameSite=Lax)` },
        errors: { 400: 'Missing username/password', 401: 'Invalid username or password' },
      },
      {
        category: 'Authentication',
        method: 'GET',
        path: '/api/agent/capabilities',
        description: 'Return this current, versioned Agent API contract. The dashboard guide and Copy All output render this response.',
        response: { contract: 'The JSON object represented by this response.' },
      },
      {
        category: 'Projects',
        method: 'GET',
        path: '/api/projects',
        description: 'List projects visible to the authenticated user. Each project includes tool_access flags: can_session, can_terminal, and session_clients.',
        response: { projects: 'Project[] with tool_access' },
      },
      {
        category: 'Projects',
        method: 'GET',
        path: '/api/projects/:id',
        description: 'Read one visible registered project.',
        response: { project: 'Project' },
        errors: { 404: 'Project not found or not visible' },
      },
      {
        category: 'Projects',
        method: 'POST',
        path: '/api/projects',
        description: 'Register an existing project directory. Requires the projects_create write role grant.',
        request: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true, description: 'Existing directory path.' },
          description: { type: 'string', required: false },
        },
        errors: { 400: 'Invalid name/path', 403: 'Administrator only', 409: 'Path is already registered' },
      },
      {
        category: 'Projects',
        method: 'PATCH',
        path: '/api/projects/:id',
        description: 'Update project metadata. Project owner or administrator only.',
      },
      {
        category: 'Projects',
        method: 'DELETE',
        path: '/api/projects/:id',
        description: 'Stop its active sessions and remove the project registration. Project owner or administrator only; session history is retained.',
      },
      {
        category: 'Sessions',
        method: 'GET',
        path: '/api/sessions',
        description: 'List sessions visible to the authenticated user. Optional ?status=running filter.',
        response: { sessions: 'Session[]' },
      },
      {
        category: 'Sessions',
        method: 'GET',
        path: '/api/sessions/:id',
        description: 'Read one session visible to the authenticated user.',
        response: { session: 'Session' },
        errors: { 404: 'Session not found or not visible' },
      },
      {
        category: 'Sessions', method: 'GET', path: '/api/sessions/:id/controls',
        description: 'Read the accessible session model, runtime controls and available models. Optional ?refresh=true refreshes native data; model release date, context length, modalities and reference Credits are optional and may be unavailable. Reference Credits are not an invoice.',
        errors: { 400: 'Invalid refresh flag', 404: 'Session not found or not accessible', 409: 'Session has no native identity' },
      },
      {
        category: 'Sessions', method: 'PUT', path: '/api/sessions/:id/controls',
        description: 'Update the model for an owned, authorized session. An unloaded supported session can save a preference for recovery. Send JSON null to clear a pending preference.',
        request: { model: {type:'string',required:true}, effort: {type:'string',required:true}, provider: {type:'string',required:false}, service_tier: {type:'string',required:false} },
        errors: { 400: 'Unsupported model or parameters', 403: 'Session or Engine not permitted', 409: 'Session or model service cannot be changed', 503: 'Native update not confirmed' },
      },
      {
        category: 'Sessions',
        method: 'POST',
        path: '/api/sessions',
        description: 'Create a session in a registered project using a mode and CLI permitted by the authenticated user.',
        request: {
          project_id: { type: 'string', required: false, recommended: true, description: 'ID returned by GET /api/projects.' },
          project_path: { type: 'string', required: true, description: 'Must match the registered project path.' },
          task: { type: 'string', required: false, description: 'Required for Session mode; ignored for terminal mode.' },
          mode: { type: 'session | terminal', required: false, default: 'session' },
          cli_type: { type:'registered Agent ID', required: false, default: 'claude', description: 'Used by Session mode.' },
          environment_id: { type:'string', required:false, description:'Authorized Codex Engine ID for a new Codex session. If omitted, the default native environment must be authorized.' },
        },
        response: { ok: 'true', session: 'Created session; use session.id for control endpoints.' },
        errors: { 400: 'Missing required fields', 401: 'Not authenticated', 403: 'Project or requested tool combination is not permitted', 429: 'Active tab/session limit reached' },
      },
      {
        category: 'Sessions',
        method: 'DELETE',
        path: '/api/sessions/:id',
        description: 'Kill a running session. This is creator-only: even an administrator cannot kill another user\'s session through this endpoint.',
        response: { ok: 'true' },
        errors: { 404: 'Session is not owned by the logged-in user or is not running' },
      },
      {
        category: 'Sessions',
        method: 'POST',
        path: '/api/sessions/:id/resume',
        description: 'Resume an ended native conversation in its bound Engine while preserving the AgentManager session id. If another process owns its native writer, resume is rejected without switching accounts or interrupting the owner.',
        response: { ok: 'true', session: 'Resumed Session' },
      },
      {
        category: 'Session control',
        method: 'GET',
        path: '/api/sessions/:id/agent-messages',
        description: 'Read recent public user/assistant messages, including progress commentary and final replies, from this exact tab native conversation. Excludes tool calls, tool results and reasoning; terminal tabs with a bound agent are supported.',
        response: { messages: 'Array<{role,phase,text,timestamp}>; empty when native history is unavailable.', available: 'boolean', tab_name: 'Dashboard tab name', project_name: 'Project name' },
      },
      {
        category: 'Session control',
        method: 'GET',
        path: '/api/sessions/:id/completed-turn',
        description: 'Read the latest completed native user/final-answer pair for this exact session. A completed turn is not independent proof that all business acceptance criteria passed.',
        response: { turns: 'Array<{user: string, assistant: string}>; empty when native history is unavailable or the turn has not completed.' },
      },
      {
        category: 'Session control',
        method: 'GET',
        path: '/api/sessions/:id/display',
        description: 'Rendered terminal output + inline state for polling. Returns clean text (no ANSI), with cursor-based incremental fetching. No side effects — safe for periodic polling.',
        request: {
          lines: { type: 'number', required: false, default: 50, description: 'Max lines of rendered terminal text to return (from the end). Max 5000.' },
          since: { type: 'number', required: false, description: 'Cursor value from a previous response for incremental replay. Ended sessions may return their archived final snapshot; check outputSource and replace, rather than append, snapshot output.' },
          cols: { type: 'number', required: false, default: 120, description: 'Terminal column width for rendering.' },
          rows: { type: 'number', required: false, default: 40, description: 'Terminal row height for rendering.' },
        },
        response: {
          sessionId: 'string',
          tab_name: 'string — actual dashboard label when available',
          project_name: 'string',
          observed_at: 'ISO timestamp of this read',
          last_activity_at: 'ISO timestamp | null — activity is not proof of task progress',
          processState: 'busy | idle | waiting_for_input',
          promptType: 'choice | confirmation | text | null',
          choices: 'string[] | null',
          output: 'string — last N lines of clean rendered terminal text',
          outputSource: 'replay | snapshot — snapshot is the archived final screen after replay was removed; it may repeat even with since',
          cursor: 'number | null — pass back as ?since= for incremental polling',
          cursorReset: 'boolean — true only when retained replay proves the cursor moved backwards; resync without since. Empty polls preserve the supplied cursor.',
          truncated: 'boolean — true if output was trimmed or more data exists',
        },
      },
      {
        category: 'Session control',
        method: 'POST',
        path: '/api/sessions/:id/cancel',
        description: 'Cancel a pending execute wait. This does not interrupt the underlying CLI process or send Ctrl-C. Returns { ok: true } if one was cancelled, { ok: false } if none was pending.',
      },
      {
        category: 'Session control',
        method: 'GET',
        path: '/api/sessions/:id/state',
        description: 'Get current session state without side effects.',
        response: {
          sessionId: 'string',
          processState: 'busy | idle | waiting_for_input',
          lastActivity: 'number (epoch ms)',
          promptType: 'choice | confirmation | text | null',
          choices: 'string[] | null',
        },
      },
      {
        category: 'Session control',
        method: 'POST',
        path: '/api/sessions/:id/input',
        description: 'Submit a follow-up immediately, including while busy or another execute request is waiting. Uses bracketed paste plus Enter, like typing in the dashboard. Does not cancel the current operation, reset output, or wait for an agent reply. Session ownership and project write access are required.',
        request: {
          input: {type:'string',required:true,description:'Text, at most 64 KiB; may be empty when attachments are present.'},
          source: {type:'string',required:false,description:'Use conversation to submit directly to the bound native engine when available.'},
          client_id: {type:'string',required:false,description:'Client correlation ID for matching the native user-message echo.'},
          attachments: {type:'array',required:false,description:'Up to 8 {kind: image|file, name, path} references returned by this session’s paste-image/paste-file endpoints. Images total at most 10 MiB, each file at most 35 MiB, all attachments at most 50 MiB.'},
        },
        response: {id:'Session id',status:'submitted — handed to the terminal; not proof of agent acceptance or task completion'},
      },
      {
        category:'Session control',method:'POST',path:'/api/sessions/:id/conversation/stop',
        description:'Request interruption of the specified currently active native turn. Acceptance does not mean the turn has finished. A changed or inactive turn returns 409; only the session creator can stop it.',
        request:{turn_id:{type:'string',required:true,description:'Opaque active turn identifier from the conversation stream.'}},
        response:{status:'accepted — interruption requested; observe the stream for completion'},
      },
      {
        category: 'Session control',
        method: 'POST',
        path: '/api/sessions/:id/execute',
        description: 'Send input and get clean rendered output. Output is processed through a virtual terminal that handles all TUI cursor movements, screen redraws, and ANSI codes — you get readable text, not raw terminal data. Only one execute per session at a time (409 if busy).',
        request: {
          input: { type: 'string', required: true, description: 'Text to send (carriage return appended automatically). An empty string intentionally sends Enter.' },
          waitFor: { type: 'string', required: false, description: 'Literal text — resolve early when matched in output' },
          timeout: { type: 'number', required: false, default: 30000, description: 'Max ms to wait before returning with status "timeout"' },
          stripAnsi: { type: 'boolean', required: false, default: true, description: 'Render through virtual terminal for clean output (default true, always use true)' },
          quiescenceMs: { type: 'number', required: false, default: 2000, description: 'Ms of silence before considering output complete' },
        },
        response: {
          id: 'string (session id)',
          status: 'completed | timeout | pattern_matched',
          output: 'string — clean rendered text showing what changed on screen since input was sent',
          durationMs: 'number',
          state: '(current SessionState with promptType and choices)',
        },
        errors: {
          400: 'Missing or invalid input/waitFor',
          404: 'Session not found or not running',
          409: 'Session already processing an execute request',
        },
      },
      {
        category: 'Session control',
        method: 'GET',
        path: '/api/context',
        description: 'Return a concise, low-token summary of the logged-in user\'s active sessions.',
      },
      {
        category: 'Session control',
        method: 'WS',
        path: '/api/sessions/:id/conversation/stream',
        description: 'Cookie-authenticated conversation stream. Supported agents can emit progress_statistics with cumulative recorded token and tool counts since the previous conclusion; missing or incomplete data remains unknown or a lower bound. input_reconciliation carries journal-verified durable user messages, with native_client_id when terminal and browser identities differ.',
      },
      {
        category: 'Session control',
        method: 'WS',
        path: '/api/sessions/:id/agent',
        description: 'Real-time structured WebSocket. Receives state changes and clean output. Can send execute requests.',
        incomingMessages: [
          {
            type: 'execute',
            fields: { requestId: 'string', input: 'string', waitFor: 'string?', timeout: 'number?', quiescenceMs: 'number?', stripAnsi: 'boolean?' },
            description: 'Send input and receive execute_result when done.',
          },
          {
            type: 'get_state',
            fields: { requestId: 'string' },
            description: 'Request current state snapshot.',
          },
        ],
        outgoingMessages: [
          { type: 'connected', fields: { sessionId: 'string', state: 'SessionState' }, description: 'Sent on connection with current state.' },
          { type: 'state_change', fields: { sessionId: 'string', processState: 'string', promptType: 'string?', choices: 'string[]?' }, description: 'Sent when state transitions.' },
          { type: 'output', fields: { text: 'string' }, description: 'ANSI-stripped output chunks as they arrive.' },
          { type: 'execute_result', fields: { requestId: 'string', status: 'string', output: 'string', durationMs: 'number', state: 'SessionState' }, description: 'Result of an execute request.' },
          { type: 'state', fields: { requestId: 'string', '...': 'SessionState fields' }, description: 'Response to get_state.' },
        ],
      },
      {
        category: 'Prompt enhancement',
        method: 'POST',
        path: '/api/prompt-enhancer/enhance',
        description: 'Enhance one supplied draft with the administrator-configured OpenAI-compatible LLM. The session_id must belong to the logged-in user; this endpoint never reads terminal input and does not expose the model API key.',
        request: {
          session_id: { type: 'string', required: true, description: 'A session created by the logged-in user.' },
          prompt: { type: 'string', required: true, description: 'Draft text to enhance. Maximum 24,000 characters.' },
          mode: { type: 'base | lite | standard | expert | publish', required: false, description: 'Optional one-call mode override; otherwise the configured default is used.' },
          attachments: { type:'Array<{kind: image | file, name: string, path: string}>', required:false, description:'Up to eight previously uploaded session-project attachments. Images are sent as image inputs; text files include a bounded excerpt. Binary files remain attached but their content is not read by the enhancer.' },
        },
        response: { prompt: 'string — enhanced draft text; review before sending.', warnings: 'string[]? — file contents omitted or truncated; original attachments remain in the draft.', context: 'Recent complete conversation rounds used by the enhancer.' },
        errors: { 400: 'Invalid draft/mode, unconfigured enhancer, or model request failure', 403: 'Session does not belong to the logged-in user' },
      },
      {
        category: 'Scheduled tasks',
        method: 'GET',
        path: '/api/scheduled-tasks?project_id=:projectId',
        description: 'List scheduled tasks owned by the logged-in user, optionally filtered by an owned project.',
      },
      {
        category: 'Scheduled tasks',
        method: 'GET',
        path: '/api/scheduled-tasks/:id/runs',
        description: 'List the latest 50 runs for one scheduled task owned by the logged-in user.',
      },
      {
        category: 'Scheduled tasks',
        method: 'POST',
        path: '/api/scheduled-tasks',
        description: 'Create a periodic task targeting one of the user\'s open tabs or a permitted new tab.',
        request: {
          project_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          schedule_kind: { type: 'interval | daily | weekly | cron', required: true },
          schedule_value: { type: 'string', required: true },
          timezone: { type: 'IANA timezone string', required: true },
          target_type: { type: 'existing | new', required: true },
          target_session_id: { type: 'string | null', required: false, description: 'Required for an existing target and must be the user\'s open tab.' },
          new_mode: { type: 'session | terminal', required: false },
          new_cli_type: { type:'registered Agent ID', required: false },
          new_environment_id: { type:'string | null', required:false, description:'Authorized Codex Engine for a newly created Codex session.' },
          new_model_preference: { type:'{ model: string, effort: string, provider?: string, service_tier?: string } | null', required:false, description:'Selected model and parameters; checked against the Engine catalog again before each run.' },
          inactive_policy: { type: 'resume | fail', required: false, default: 'resume' },
          stop_at: { type: 'ISO timestamp | null', required: false },
          daily_stop_time: { type: 'HH:mm | null', required: false },
          daily_start_time: { type: 'HH:mm | null', required: false, description: 'Interval schedules only; set together with daily_end_time. The start is included and anchors each daily interval.' },
          daily_end_time: { type: 'HH:mm | null', required: false, description: 'Daily execution window end (exclusive); an earlier clock time means next day. Outside the window, sending pauses and automatically continues next window.' },
          start_conditions: { type: 'ConditionGroup | null', required: false, description: 'Recursive { operator: and|or, conditions: [Condition|ConditionGroup] }. Start leaves: time_after (HH:mm), time_range ({start,end}, end exclusive, overnight supported), weekday (workday=Mon–Fri or weekend=Sat/Sun), target_idle (boolean, existing target only). Up to 4 levels, 20 children/group, 50 total nodes.' },
          daily_stop_conditions: { type: 'ConditionGroup | null', required: false, description: 'Same recursive groups; also supports quota_below (remaining percent from a quota-capable agent), successes_today and failures_today (counts). Once true, pause sending until the next local day, then re-evaluate. Unknown state prevents dispatch; the session is not killed.' },
          condition_unmet_policy: { type: 'skip | wait', required: false, default: 'skip', description: 'skip: do not backfill when idle; check next fixed occurrence. wait is retained for API compatibility. Manual dispatch also obeys guards.' },
          max_successful_runs: { type: 'integer | null', required: false },
          quota_remaining_below: { type: 'integer 1..100 | null', required: false, description: 'Requires an agent with quota capability.' },
          max_consecutive_failures: { type: 'integer | null', required: false },
          stop_on_target_unavailable: { type: 'boolean', required: false, description: 'Existing target only.' },
          enabled: { type: 'boolean', required: false, default: true },
        },
      },
      {
        category: 'Scheduled tasks',
        method: 'PATCH',
        path: '/api/scheduled-tasks/:id',
        description: 'Update an owned scheduled task. Accepts any subset of the creation fields.',
      },
      {
        category: 'Scheduled tasks',
        method: 'DELETE',
        path: '/api/scheduled-tasks/:id',
        description: 'Delete a scheduled task owned by the logged-in user.',
      },
      {
        category: 'Scheduled tasks',
        method: 'POST',
        path: '/api/scheduled-tasks/:id/run',
        description: 'Run an owned scheduled task immediately and return its run record.',
      },
      {
        category: 'Scheduled tasks', method: 'GET', path: '/api/scheduled-tasks/codex-models?project_id=:projectId&environment_id=:environmentId',
        description: 'Read the selected authorized Codex Engine model catalog for a permitted project.',
      },
      {
        category: 'Agents', method: 'GET', path: '/api/codex/environments',
        description: 'List Codex Engines available to the current account. API Key requests also require platform settings read permission.',
      },
      {
        category:'Agents',method:'GET',path:'/api/agent/providers',
        description:'List registered agents with host type, presentation and supported feature capabilities.',
      },
      {
        category:'Agents',method:'GET',path:'/api/agent-quota/:agent',
        description:'Read the account quota of a registered agent with quota capability.',
      },
      {
        category:'Agents',method:'GET',path:'/api/scheduled-tasks/agent-quota?project_id=:projectId&agent_id=:agentId',
        description:'Read quota after checking project ownership and permission to use the selected agent.',
      },
      {
        category: 'Quota',
        method: 'GET',
        path: '/api/codex-quota',
        description: 'Read the current Codex weekly quota snapshot and detection time.',
      },
      {
        category: 'Quota',
        method: 'GET',
        path: '/api/scheduled-tasks/codex-quota?project_id=:projectId',
        description: 'Read Codex weekly quota after verifying the user owns the project and may use Codex there.',
      },
    ],
    tips: [
      'The output fields from display and execute are CLEAN TEXT — read them directly; do not strip ANSI or parse raw PTY data.',
      'POST /api/sessions/:id/input submits a follow-up immediately, including while busy or execute is pending. It does not interrupt work. Use execute only when you need to wait for output.',
      'For interactive prompts, read promptType and choices from state to decide what to send.',
      'Prefer explicit input. An empty input string is valid and intentionally sends Enter, which may accept a prompt default.',
      'Use literal waitFor text for commands with known output to get faster responses.',
      'Increase quiescenceMs for slow commands (e.g. builds, installs) to avoid premature completion.',
      'Use GET /api/sessions/:id/display for read-only monitoring — it returns rendered output + state in one call with cursor-based incremental polling.',
      'The display endpoint cursor is opaque — save it from the response and pass it back as ?since= to get only new content.',
    ],
    operationalGuidance: {
      responsiveness: {
        description: 'Agents controlling AgentManager sessions should run a periodic health check to avoid getting stuck on long-running commands or unresponsive sessions.',
        recommendation: 'Run a 30-second cron/interval that polls GET /api/sessions to check for stuck sessions and GET /api/sessions/:id/state for any session you are actively managing.',
        checkLogic: [
          'If an execute request has waited too long, POST /api/sessions/:id/cancel cancels that wait only; it does not interrupt the CLI process.',
          'If the underlying CLI process is intentionally running a long command, keep polling display. Use the normal terminal/session controls if a user-authorized interrupt is required.',
          'If a session you started is no longer in the sessions list or has status "failed", it crashed — check if it auto-resumed (status "running" with same id) or start a new one.',
          'Never let a single exec call block your main loop for more than 60 seconds. Use the timeout parameter (default 30s) and handle "timeout" status gracefully.',
        ],
      },
      execTimeouts: {
        description: 'Always set explicit timeouts on execute calls. Long-running shell commands can hang indefinitely.',
        defaults: { timeout: 30000, quiescenceMs: 2000 },
        forSlowCommands: { timeout: 120000, quiescenceMs: 5000 },
      },
      crashRecovery: {
        description: 'AgentManager automatically resumes crashed native sessions that have a captured native conversation ID.',
        agentAction: 'After a server restart, poll GET /api/sessions?status=running to discover auto-resumed sessions. Your session IDs remain stable.',
      },
    },
  } as const;
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onClose',async()=>{await closeAccountTransports();});
  app.addHook('onClose',async()=>{for(const descriptor of agentDescriptors())await getAgent(descriptor.id).stream.shutdown?.();});
  const retryAgent=(nativeId:string)=>{
    const rows=getDb().prepare('SELECT * FROM sessions WHERE native_session_id=? OR codex_session_id=? OR claude_session_id=?').all(nativeId,nativeId,nativeId) as import('../services/session-manager.js').Session[];
    const providers=new Set(rows.map(row=>agentForSession(row).descriptor.id));if(providers.size!==1||!rows.length)throw Error('重试目标不明确');
    const session=rows[0];return {adapter:agentForSession(session),context:sessionAgentContext(session)};
  };
  const retries=new ConversationRetryManager(getDb(),{inspect:native=>retryAgent(native).adapter.retry.inspect(native),start:(native,failed,client)=>retryAgent(native).adapter.retry.start(native,failed,client),observe:(native,emit,onFailure)=>{const {adapter,context}=retryAgent(native);return adapter.stream.observe({...context,streamFormat:'state'},emit,onFailure);},allowed:(id,userId,nativeId)=>{
    const session=getSession(id);
    return !!session&&agentForSession(session).descriptor.capabilities.retry&&nativeConversationId(session)===nativeId&&session.status==='running'&&canAccessAgentSession(userId,id)&&userHasPermission(userId,'agent_api','write');
  }});
  app.addHook('onClose',async()=>retries.close());
  app.addHook('onListen',async()=>{for(const session of getDb().prepare("SELECT * FROM sessions WHERE status='running' AND created_by_user_id IS NOT NULL").all() as import('../services/session-manager.js').Session[])if(agentForSession(session).descriptor.capabilities.retry&&nativeConversationId(session))retries.monitor(session.id,session.created_by_user_id!,nativeConversationId(session)!);});
  app.addHook('onListen',async()=>{
    void import('../services/agents/codex/environments.js').then(({restoreActiveTerminalTransports})=>restoreActiveTerminalTransports()).catch(()=>{});
    if(!config.manageCodexEngines)return;
    try{
      const {initializeManagedCodexEngines}=await import('../services/agents/codex/management.js');
      await initializeManagedCodexEngines();
    }catch(error){
      app.log.error({err:error},'Codex Engine 初始化失败');
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    requirePermission(req, reply, 'agent_api', req.method === 'GET' && !req.routeOptions.url?.endsWith('/agent') ? 'read' : 'write');
  });
  app.get('/agent/capabilities', async () => ({...getAgentApiContract(),agents:agentDescriptors()}));
  app.get('/agent/providers',async()=>({agents:agentDescriptors()}));
  app.get('/agent-management',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','read'))return;
    const agents=agentDescriptors();
    const management=await Promise.all(agents.map(async agent=>({
      agent,
      state:await getAgent(agent.id).management.inspect(false).catch(error=>({error:error instanceof Error?error.message:'无法读取 Agent 配置'})),
    })));
    return {agents:management};
  });
  app.get<{Params:{agentId:string}}>('/agent-management/:agentId',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','read'))return;
    try{return {state:await getAgent(req.params.agentId).management.inspect(false)};}
    catch(error){return reply.code(error instanceof Error&&(error as any).statusCode||400).send({error:error instanceof Error?error.message:'无法读取 Agent 配置'});}
  });
  app.post<{Params:{agentId:string};Body:{refresh?:boolean;all?:boolean;providerId?:string;endpoint?:string;apiKey?:string}}>('/agent-management/:agentId/detect-models',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{
      const agent=getAgent(req.params.agentId);
      if(agent.management.detectModels) return {models:await agent.management.detectModels(req.body)};
      if(agent.descriptor.id==='codex'){
        const {readCodexModels}=await import('../services/agents/codex/controls.js');
        return {models:await readCodexModels(req.body?.refresh===true)};
      }
      return reply.code(409).send({error:'当前 Agent 不支持独立模型探测'});
    }catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'模型探测失败'});}
  });
  app.get<{Params:{agentId:string}}>('/agent-management/:agentId/model-configs',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','read'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      return {models:management.readModelConfigs?await management.readModelConfigs():[]};
    }catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'读取模型配置失败'});}
  });
  app.put<{Params:{agentId:string};Body:{models:Array<{provider?:string;model:string;contextWindow?:number|null;maxContextWindow?:number|null;effectiveContextWindowPercent?:number|null;supportsImages?:boolean}>}}>('/agent-management/:agentId/model-configs',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      if(!management.updateModelConfigs)return reply.code(409).send({error:'当前 Agent 不支持模型参数配置'});
      return {models:await management.updateModelConfigs(req.body?.models||[])};
    }catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'保存模型配置失败'});}
  });
  app.put<{Params:{agentId:string};Body:{values?:Record<string,string>;clear?:string[];restart?:boolean}}>('/agent-management/:agentId/environment',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      if(!management.updateEnvironment)return reply.code(409).send({error:'当前 Agent 不支持环境变量配置'});
      const environment=await management.updateEnvironment(req.body||{});
      if(req.body?.restart===true){const {restartAgentManagerForEnvironment}=await import('../services/agents/environment-store.js');restartAgentManagerForEnvironment();}
      return {environment};
    }catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'保存环境变量失败'});}
  });
  app.put<{Params:{agentId:string};Body:{models?:string[];defaultModel?:string|null;restart?:boolean}}>('/agent-management/:agentId/selected-models',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      if(!management.saveSelectedModels)return reply.code(409).send({error:'当前 Agent 不支持保存模型选择'});
      const environment=await management.saveSelectedModels(req.body?.models||[],req.body?.defaultModel||null);
      if(req.body?.restart===true){const {restartAgentManagerForEnvironment}=await import('../services/agents/environment-store.js');restartAgentManagerForEnvironment();}
      return {environment};
    }catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'保存模型选择失败'});}
  });
  app.put<{Params:{agentId:string};Body:{defaults?:Record<string,string|boolean|string[]|null>}}>('/agent-management/:agentId',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{return {state:await getAgent(req.params.agentId).management.update({defaults:req.body?.defaults})};}
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'保存 Agent 设置失败'});}
  });
  app.post<{Params:{agentId:string};Body:{action:string}}>('/agent-management/:agentId/action',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{return {state:await getAgent(req.params.agentId).management.action(req.body?.action)};}
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'Agent 操作失败'});}
  });
  app.post<{Params:{agentId:string};Body:{id?:string;name?:string;kind?:string;enabled?:boolean;apiKey?:string;fields?:Record<string,string|boolean|string[]|null>}}>('/agent-management/:agentId/providers',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{return {state:await getAgent(req.params.agentId).management.createProvider(req.body||{})};}
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'添加 Provider 失败'});}
  });
  app.put<{Params:{agentId:string;providerId:string};Body:{name?:string;kind?:string;enabled?:boolean;apiKey?:string;fields?:Record<string,string|boolean|string[]|null>}}>('/agent-management/:agentId/providers/:providerId',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{return {state:await getAgent(req.params.agentId).management.updateProvider(req.params.providerId,req.body||{})};}
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'保存 Provider 失败'});}
  });
  app.get<{Params:{agentId:string;providerId:string}}>('/agent-management/:agentId/providers/:providerId',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','read'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      const provider=management.inspectProvider
        ? await management.inspectProvider(req.params.providerId)
        : (await management.inspect(false)).providers.find(item=>item.id===req.params.providerId)||null;
      return provider?{provider}:reply.code(404).send({error:'Provider 不存在'});
    }catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'读取 Provider 状态失败'});}
  });
  app.put<{Params:{agentId:string;providerId:string};Body:{name?:string;kind?:string;enabled?:boolean;apiKey?:string;fields?:Record<string,string|boolean|string[]|null>}}>('/agent-management/:agentId/providers/:providerId/update-stream',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    reply.hijack();
    reply.raw.writeHead(200,{
      'Content-Type':'application/x-ndjson; charset=utf-8',
      'Cache-Control':'no-store, no-transform',
      'X-Accel-Buffering':'no',
    });
    let closed=false;
    reply.raw.once('close',()=>{closed=true;});
    const send=(event:Record<string,unknown>)=>{if(!closed)reply.raw.write(`${JSON.stringify(event)}\n`);};
    send({type:'progress',stage:'start',message:'开始保存 Provider 配置',progress:0});
    try{
      const management=getAgent(req.params.agentId).management;
      await management.updateProvider(req.params.providerId,req.body||{},progress=>send({type:'progress',...progress}));
      const provider=management.inspectProvider
        ? await management.inspectProvider(req.params.providerId)
        : (await management.inspect(false)).providers.find(item=>item.id===req.params.providerId)||null;
      if(!provider)throw Object.assign(Error('Provider 状态在保存后不可用'),{statusCode:404});
      send({type:'complete',provider});
    }catch(error){
      send({type:'error',error:error instanceof Error?error.message:'保存 Provider 失败',status:(error as any)?.statusCode||400});
    }finally{
      closed=true;
      reply.raw.end();
    }
  });
  app.delete<{Params:{agentId:string;providerId:string}}>('/agent-management/:agentId/providers/:providerId',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{return {state:await getAgent(req.params.agentId).management.deleteProvider(req.params.providerId)};}
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'删除 Provider 失败'});}
  });
  app.post<{Params:{agentId:string;providerId:string};Body:{action:string}}>('/agent-management/:agentId/providers/:providerId/action',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{return {state:await getAgent(req.params.agentId).management.providerAction(req.params.providerId,req.body?.action)};}
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'Provider 操作失败'});}
  });
  app.post<{Params:{agentId:string;providerId:string};Body:{action:string}}>('/agent-management/:agentId/providers/:providerId/action-stream',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    const action=req.body?.action;
    if(!['start','stop','restart','enable','disable','test'].includes(action))return reply.code(400).send({error:'不支持的 Engine 操作'});
    reply.hijack();
    reply.raw.writeHead(200,{
      'Content-Type':'application/x-ndjson; charset=utf-8',
      'Cache-Control':'no-store, no-transform',
      'X-Accel-Buffering':'no',
    });
    let closed=false;
    reply.raw.once('close',()=>{closed=true;});
    const send=(event:Record<string,unknown>)=>{if(!closed)reply.raw.write(`${JSON.stringify(event)}\n`);};
    send({type:'progress',stage:'start',message:'开始执行 Engine 操作',progress:0});
    try{
      const management=getAgent(req.params.agentId).management;
      await management.providerAction(req.params.providerId,action,progress=>send({type:'progress',...progress}));
      const provider=management.inspectProvider
        ? await management.inspectProvider(req.params.providerId)
        : (await management.inspect(false)).providers.find(item=>item.id===req.params.providerId)||null;
      if(!provider)throw Object.assign(Error('Engine 状态在操作后不可用'),{statusCode:404});
      send({type:'complete',provider});
    }catch(error){
      send({type:'error',error:error instanceof Error?error.message:'Engine 操作失败',status:(error as any)?.statusCode||400});
    }finally{
      closed=true;
      reply.raw.end();
    }
  });
  app.post<{Params:{agentId:string};Body:{path:string;revealSensitive?:boolean}}>('/agent-management/:agentId/config-file',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','read'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      if(!management.readConfigFile)return reply.code(409).send({error:'当前 Agent 不支持配置文件编辑'});
      return {file:await management.readConfigFile({path:req.body.path,content:'',revealSensitive:req.body.revealSensitive===true})};
    }
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'读取配置文件失败'});}
  });
  app.put<{Params:{agentId:string};Body:{path:string;content:string;expectedContent?:string|null}}>('/agent-management/:agentId/config-file',async(req,reply)=>{
    if(!requirePermission(req,reply,'settings','write'))return;
    try{
      const management=getAgent(req.params.agentId).management;
      if(!management.writeConfigFile)return reply.code(409).send({error:'当前 Agent 不支持配置文件编辑'});
      return {file:await management.writeConfigFile(req.body)};
    }
    catch(error){return reply.code((error as any)?.statusCode||400).send({error:error instanceof Error?error.message:'保存配置文件失败'});}
  });
  app.get<{Params:{agent:string}}>('/agent/providers/:agent/quota',async(req,reply)=>{if(!isAdmin(req.user!.id))return reply.code(403).send({error:'无权读取主机账号额度'});return sendAgentQuota(reply,()=>getAgent(req.params.agent).quota.read());});

  app.get<{Params:{id:string};Querystring:{refresh?:string}}>('/sessions/:id/context-breakdown',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(!requirePermission(req,reply,'agent_api','read'))return;
    if(req.query.refresh!==undefined&&req.query.refresh!=='true')return reply.code(400).send({error:'Invalid refresh flag'});
    const adapter=agentForSession(session),context=sessionAgentContext(session,{actorUserId:req.user!.id,force:req.query.refresh==='true'});
    if(!context.nativeId||!adapter.telemetry.contextBreakdown)return reply.code(409).send({error:'当前会话不支持上下文分类统计'});
    reply.header('Cache-Control','private, no-store');
    try{return {context:await adapter.telemetry.contextBreakdown(context)};}
    catch(error){return reply.code(Number((error as {statusCode?:number}).statusCode)||503).send({error:error instanceof Error?error.message:'上下文分类暂不可用'});}
  });
  app.get<{Params:{id:string};Querystring:{refresh?:string}}>('/sessions/:id/controls',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    const adapter=agentForSession(session),context=sessionAgentContext(session);if(!context.nativeId)return reply.code(409).send({error:'当前会话尚未绑定原生会话'});
    const shared=session.agent_environment_id?canControlEnvironment(session.agent_environment_id,req.user!.id):req.user!.role==='admin'&&(!session.created_by_user_id||isAdmin(session.created_by_user_id));
    if(req.query.refresh!==undefined&&req.query.refresh!=='true')return reply.code(400).send({error:'Invalid refresh flag'});
    const data=await adapter.controls.read({...context,actorUserId:req.user!.id,sharedAccess:shared,force:req.query.refresh==='true'});
    let pending=readModelPreference(req.user!.id,session.id);const submittedAt=modelPreferenceSubmittedAt(req.user!.id,session.id);
    if(pending&&adapter.controls.confirmed?.(context,pending,data,submittedAt||'')){saveModelPreference(req.user!.id,session.id,null);pending=null;}
    const owned=!session.created_by_user_id||session.created_by_user_id===req.user!.id;
    return reply.header('Cache-Control','private, no-store').send({...data,agent:adapter.descriptor,can_edit_features:Object.fromEntries(Object.entries(adapter.descriptor.capabilities).map(([feature,supported])=>[feature,supported&&shared&&owned&&(['model','effort','newConversation'].includes(feature)?data.models.length>0&&(data.supports_model_recovery||data.loaded):data.loaded)&&userHasPermission(req.user!.id,'agent_api','write')])),pending,pending_status:pending?(submittedAt?'submitted':'saved'):null,
      can_edit:adapter.descriptor.capabilities.model&&shared&&owned&&data.models.length>0&&(data.supports_model_recovery||data.loaded)&&userHasPermission(req.user!.id,'agent_api','write')});
  });
  app.put<{Params:{id:string};Body:unknown}>('/sessions/:id/controls',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if((session.agent_environment_id?!canControlEnvironment(session.agent_environment_id,req.user!.id):req.user!.role!=='admin')||session.created_by_user_id&&session.created_by_user_id!==req.user!.id)return reply.code(403).send({error:'只能修改自己的会话设置'});
    const adapter=agentForSession(session),context=sessionAgentContext(session,{sharedAccess:true});
    if(!context.nativeId||!adapter.descriptor.capabilities.model)return reply.code(409).send({error:'当前会话不可修改，请先恢复会话'});
    if(req.body===null){saveModelPreference(req.user!.id,session.id,null);return {ok:true,pending:null};}
    try {
      const data=await adapter.controls.read(context);
      const value=await adapter.controls.validate(context,req.body);
      if(adapter.descriptor.id==='codex'&&value.provider&&value.provider!==data.provider)assertEnvironmentUse('codex','provider:'+value.provider,req.user!.id);
      if(value.provider&&data.provider&&value.provider!==data.provider)return reply.code(409).send({error:'切换模型服务需要确认新开会话，原会话已保留'});
      if(!data.loaded&&!data.supports_model_recovery)return reply.code(409).send({error:'当前 Agent 尚不支持保存恢复模型，请先恢复会话'});
      if(!data.loaded){saveModelPreference(req.user!.id,session.id,value);return {ok:true,pending:value,pending_status:'saved'};}
      try {const applied=await adapter.controls.apply(context,value);const pending=applied.pending===true?value:null;saveModelPreference(req.user!.id,session.id,pending,pending?new Date().toISOString():undefined);return {ok:true,...applied,pending,pending_status:pending?'submitted':null};}
      catch(error){return reply.code(503).send({error:error instanceof Error?error.message:'设置失败，请刷新确认'});}
    }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'设置失败，请重试'});}
  });

  app.delete<{Params:{id:string;client:string}}>('/sessions/:id/queue/:client',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(session.created_by_user_id&&session.created_by_user_id!==req.user!.id)return reply.code(403).send({error:'只能取消自己会话的排队输入'});
    const adapter=agentForSession(session),context=sessionAgentContext(session);
    if(!context.nativeId||!adapter.descriptor.capabilities.cancelQueuedInput||!adapter.input.cancelQueued)return reply.code(409).send({error:'此 Agent 不支持取消排队输入'});
    if(!req.params.client||req.params.client.length>200)return reply.code(400).send({error:'Invalid queued input identity'});
    try{await adapter.input.cancelQueued(context,req.params.client);return {ok:true};}
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'取消排队失败，请刷新队列'});}
  });

  app.post<{Params:{id:string};Body:{input?:unknown;source?:unknown;client_id?:unknown;attachments?:unknown}}>('/sessions/:id/input', async (req, reply) => {
    const {id} = req.params;
    if (!canAccessAgentSession(req.user!.id,id)) return reply.code(404).send({error:'Session not found'});
    const input = req.body?.input;
    if (typeof input !== 'string' || (!input.trim() && !(Array.isArray(req.body?.attachments) && req.body.attachments.length)) || Buffer.byteLength(input) > MAX_EXECUTE_INPUT_BYTES) return reply.code(400).send({error:'input must be text of at most 64 KiB, with text or at least one attachment'});
    const clientId=req.body?.client_id;
    if(clientId!==undefined && (typeof clientId!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clientId))) return reply.code(400).send({error:'Invalid client_id'});
    let attachments;try{attachments=await validateConversationAttachments(id,req.body?.attachments);}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'附件不可用'});}
    const target=getSession(id);if(req.body?.source==='conversation'&&attachments.length&&target&&!agentForSession(target).descriptor.capabilities.attachments)return reply.code(409).send({error:'此 Agent 不支持附件',submission:'rejected'});
    // The server can restart after the browser's last ready snapshot. Reattach
    // the existing wrapper before submission; never replay an ambiguous send.
    // Native input has its own connection and must not wait for a terminal
    // client attachment. PTY reattachment is only needed by the fallback below.
    const nativeCandidate=req.body?.source==='conversation'&&!!target&&!!nativeConversationId(target);
    if(!nativeCandidate&&!await attachExistingSession(id))return reply.code(409).send({error:'会话连接尚未就绪，请重新连接；进程已退出时需恢复会话。',submission:'rejected'});
    const current=getSession(id);if(current&&nativeConversationId(current))retries.cancel(id,nativeConversationId(current)!,'new_input');
    const preparedInput=formatConversationInput(input,attachments,true);
    const attachmentClientId=typeof clientId==='string'?clientId:randomUUID();
    // Serialize only the brief paste/Enter pair, never the agent's execution.
    // A second caller must not paste its text before the first caller's Enter.
    const prior = pendingInputs.get(id) || Promise.resolve();
    const submission = prior.catch(() => {}).then(async () => {
      const session=getSession(id);
      if(req.body?.source==='conversation'&&session&&nativeConversationId(session)) {
        if(attachments.length)rememberConversationAttachments(id,attachmentClientId,input,attachments,true);
        if(typeof clientId==='string'){
          const project=session.project_id?getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined:undefined;
          const raw=nativeConversationInput(input,attachments)[0].text,visible=conversationQuestionReply(raw)?.text??raw;
          await rememberConversationInput(id,{...session,cli_type:session.cli_type||'claude',codex_session_id:session.codex_session_id||null,claude_session_id:session.claude_session_id||null,project_path:project?.path||null},clientId,visible).catch(()=>{});
        }
        const adapter=agentForSession(session),native=await adapter.input.submit(sessionAgentContext(session),input,typeof clientId==='string'?clientId:attachments.length?attachmentClientId:undefined,attachments);
        if(native)return native==='queued'?'queued':'submitted';if(adapter.descriptor.sessionHost==='managed')throw Object.assign(Error('Agent 服务未接受输入，消息尚未提交'),{submission:'rejected'});
      }
      if(nativeCandidate&&!await attachExistingSession(id))throw new AgentSubmissionError('消息尚未发送：终端连接未就绪，请重连后重试','rejected');
      if(attachments.length)rememberConversationAttachments(id,attachmentClientId,input,attachments,false);
      if(req.body?.source==='conversation'&&typeof clientId==='string'&&session){
        const project=session.project_id?getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined:undefined;
        const raw=nativeConversationInput(input,attachments)[0].text,visible=conversationQuestionReply(raw)?.text??raw;
        await rememberConversationInput(id,{...session,cli_type:session.cli_type||'claude',codex_session_id:session.codex_session_id||null,claude_session_id:session.claude_session_id||null,project_path:project?.path||null},clientId,preparedInput,visible).catch(()=>{});
      }
      await withTerminalInput(id,async()=>{
      if (!writeToSession(id,preparedInput,true)) throw new AgentSubmissionError('消息尚未发送：终端未接收输入，请重连后重试','rejected');
      await new Promise(resolve => setTimeout(resolve,50));
      if (!writeToSession(id,'\r',false)) throw new Error('Input was pasted but submission could not be confirmed');
      });
      if(req.body?.source==='conversation'&&session)void agentForSession(session).input.afterTerminalSubmit(sessionAgentContext(session)).catch(()=>{});
    });
    pendingInputs.set(id,submission);
    try {
      const status=await submission;
      return reply.code(202).send({id,status:status==='queued'?'queued':'submitted'});
    } catch(error) {
      if(error instanceof Error&&(error as Error&{submission?:string}).submission==='rejected')return reply.code(409).send({error:error.message,submission:'rejected'});
      req.log.warn({session_id:id,submission:'unknown'},'Agent input dispatched without a confirmed receipt');
      return reply.code(503).send({error:'消息接收结果暂未确认，连接恢复后会自动核对；请勿重复提交',submission:'unknown'});
    } finally {
      if (pendingInputs.get(id) === submission) pendingInputs.delete(id);
    }
  });

  app.post<{Params:{id:string}}>('/sessions/:id/streaming/enable',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||session.created_by_user_id!==req.user!.id||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(!requirePermission(req,reply,'agent_api','write'))return reply;
    if(!await agentForSession(session).stream.enable?.(sessionAgentContext(session)))return reply.code(409).send({error:'此会话暂不支持接入实时输出'});
    return {ok:true,scheduled:true};
  });

  /* ----------------------------------------------------------------
     POST /sessions/:id/execute — Send input and wait for response
     ---------------------------------------------------------------- */
  app.post<{
    Params: { id: string };
    Body: {
      input: string;
      waitFor?: string;
      timeout?: number;
      stripAnsi?: boolean;
      quiescenceMs?: number;
    };
  }>('/sessions/:id/execute', async (req, reply) => {
    const { id } = req.params;
    const body = req.body;

    if (!canAccessAgentSession(req.user!.id, id)) {
      return reply.status(404).send({ error: 'Session not found or not running' });
    }
    if (!isSessionActive(id)) {
      return reply.status(404).send({ error: 'Session not found or not running' });
    }

    const tracker = getTracker(id);
    if (!tracker) {
      return reply.status(404).send({ error: 'Session tracker not found' });
    }

    if (tracker.hasPendingExecute) {
      return reply.status(409).send({ error: 'Session already processing an execute request' });
    }

    const validated = validateExecuteRequest(body);
    if (!validated.ok) return reply.status(400).send({ error: validated.error });
    const executeRequest = validated.request;

    // Set up execute listener before writing input
    const execution = tracker.execute({
      ...executeRequest,
    });
    await execution.ready;

    // Reset output buffer and write input to PTY
    tracker.resetOutputBuffer();
    writeToSession(id, executeRequest.input);
    setTimeout(() => writeToSession(id, '\r'), 50);

    const result = await execution.result;

    return {
      id,
      status: result.status,
      output: result.output,
      durationMs: result.durationMs,
      state: result.state,
    };
  });

  /* ----------------------------------------------------------------
     POST /sessions/:id/cancel — Cancel a stuck execute request
     ---------------------------------------------------------------- */
  app.post<{
    Params: { id: string };
  }>('/sessions/:id/cancel', async (req, reply) => {
    const { id } = req.params;

    if (!canAccessAgentSession(req.user!.id, id)) {
      return reply.status(404).send({ error: 'Session tracker not found' });
    }

    const tracker = getTracker(id);
    if (!tracker) {
      return reply.status(404).send({ error: 'Session tracker not found' });
    }
    const cancelled = tracker.cancelExecute();
    return { ok: cancelled };
  });

  /* ----------------------------------------------------------------
     GET /sessions/:id/state — Current session state
     ---------------------------------------------------------------- */
  app.get<{
    Params: { id: string };
  }>('/sessions/:id/state', async (req, reply) => {
    const { id } = req.params;

    if (!canAccessAgentSession(req.user!.id, id)) {
      return reply.status(404).send({ error: 'Session not found or not running' });
    }
    if (!isSessionActive(id)) {
      return reply.status(404).send({ error: 'Session not found or not running' });
    }

    const tracker = getTracker(id);
    if (!tracker) {
      return reply.status(404).send({ error: 'Session tracker not found' });
    }

    return tracker.state;
  });

  app.post<{Params:{id:string};Body:{turn_id?:unknown}}>('/sessions/:id/conversation/stop',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||session.created_by_user_id!==req.user!.id||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(!['running','detached'].includes(session.status))return reply.code(409).send({error:'会话当前未运行'});
    const turnId=req.body?.turn_id;
    if(typeof turnId!=='string'||!turnId.trim()||turnId.length>512||/[\x00-\x1f\x7f]/.test(turnId))return reply.code(400).send({error:'Invalid turn_id'});
    const adapter=agentForSession(session);
    if(!adapter.descriptor.capabilities.stopTurn)return reply.code(409).send({error:'此 Agent 不支持停止当前执行'});
    if(!nativeConversationId(session))return reply.code(409).send({error:'当前会话尚未绑定原生会话'});
    try {
      const accepted=await adapter.lifecycle.stopTurn(sessionAgentContext(session,{actorUserId:req.user!.id}),turnId);
      if(!accepted)return reply.code(409).send({error:'该执行已结束或已切换，请刷新状态'});
      if(nativeConversationId(session))retries.cancel(session.id,nativeConversationId(session)!,'interrupted');
      return reply.code(202).send({status:'accepted'});
    } catch (error) {
      if(error instanceof Error&&(error as Error&{statusCode?:number}).statusCode===409)return reply.code(409).send({error:error.message});
      return reply.code(503).send({error:'停止结果暂未确认，请等待会话状态更新'});
    }
  });

  app.post<{Params:{id:string}}>('/sessions/:id/conversation/retry/cancel',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(nativeConversationId(session))retries.cancel(session.id,nativeConversationId(session)!);
    return {ok:true};
  });

  app.get<{Params:{id:string};Querystring:{protocol?:string}}>('/sessions/:id/conversation/stream',{websocket:true},(socket,req)=>{
    const id=req.params.id;
    if(!req.user || !canAccessAgentSession(req.user.id,id)) {socket.close(1008,'Session not found');return;}
    if(!registerUserConnection(req.user.id,readSessionCookie(req),socket)) return;
    const stopEnvironmentWatch=watchSessionEnvironment(id,req.user.id,()=>socket.close(1008,'Codex environment access changed'));socket.once('close',stopEnvironmentWatch);
    const session=getSession(id);
    if(!session||!nativeConversationId(session)||!agentForSession(session).descriptor.capabilities.stream) {
      socket.send(JSON.stringify({type:'unavailable',reason:'等待原生实时会话连接'}));socket.close(1000);return;
    }
    const adapter=agentForSession(session),context=sessionAgentContext(session),nativeId=nativeConversationId(session)!;
    const projection=new ConversationProjection();
    let stopFile:(()=>void)|undefined;
    const startFileFallback=()=>{if(!stopFile)stopFile=observeConversationFile({...session,cli_type:adapter.descriptor.id,project_path:context.projectPath},send);};
    const stopFileFallback=()=>{stopFile?.();stopFile=undefined;};
    let lastUsageFingerprint:string|undefined;
    const send=(frame:any)=>{
      if(!canAccessAgentSession(req.user!.id,id)) {socket.close(1008);return;}
      if(frame.type==='snapshot'||frame.type==='patch')stopFileFallback();
      else if(frame.type==='unavailable')startFileFallback();
      if(frame.type==='history'||frame.type==='snapshot'||frame.type==='patch'){
        frame=projection.accept(frame);
        if(!frame)return;
      }
      // File observers share native state; reminder preferences belong to the
      // connected user and must be projected on every replay/reconnect too.
      if(frame.type==='history'&&frame.runtime)frame={...frame,runtime:personalQuestionRuntime(frame.runtime,req.user!.id)};
      if(frame.type==='usage') {
        const fingerprint=JSON.stringify([frame.native_id,frame.usage]);
        // Tagged events form a contiguous delivery sequence. Dropping a native
        // duplicate here makes the browser reconnect as if text had been lost.
        if(fingerprint===lastUsageFingerprint&&!frame.stream_id)return;
        lastUsageFingerprint=fingerprint;
      }
      if(socket.readyState===1 && socket.bufferedAmount<1024*1024) socket.send(JSON.stringify(frame.type==='patch'?{...frame,upserts:decorateConversationAttachments(id,linkConversationInputs(id,nativeId,frame.upserts))}:['snapshot','history','queue'].includes(frame.type)?{...frame,messages:decorateConversationAttachments(id,linkConversationInputs(id,nativeId,frame.messages))}:frame));
      else if(socket.readyState===1) socket.close(1013,'Slow conversation client');
    };
    if(adapter.descriptor.capabilities.retry)retries.monitor(id,req.user!.id,nativeId);
    const stopRetry=adapter.descriptor.capabilities.retry?retries.subscribe(id,nativeId,send):()=>{};
    const stopProgress=adapter.history.file?observeConversationFile({...session,cli_type:adapter.descriptor.id,project_path:context.projectPath},frame=>{
      if(frame.type==='progress_statistics')send(frame);
      else if(frame.type==='history'){
        const messages=boundConversationInputs(id,nativeId,frame.messages);
        if(messages.length)send({type:'input_reconciliation',native_id:nativeId,messages:decorateConversationAttachments(id,messages)});
      }
    }):()=>{};
    const stop=observeAgentConversation(session,frame=>{
      send(frame);
      if(frame.type==='unavailable'&&frame.reconnect&&socket.readyState===1)socket.close(1012,'Native connection lost');
    },(turnId,error,willRetry)=>retries.failure(id,req.user!.id,nativeId,turnId,error,willRetry),req.query.protocol==='2'?'incremental':'snapshot');
    socket.on('message',async bytes=>{
      let frame:any;try{const raw=bytes.toString();if(Buffer.byteLength(raw)>64*1024){socket.close(1009,'Interaction response too large');return;}frame=JSON.parse(raw);}catch{return;}
      if(frame?.type!=='interaction_response'||typeof frame.request_id!=='string')return;
      let error:string|undefined;
      try {
        const authorize=()=>{if(getSessionUser(readSessionCookie(req)||'')?.id!==req.user!.id||!canAccessAgentSession(req.user!.id,id)||!userHasPermission(req.user!.id,'agent_api','write'))throw new Error('当前账号没有处理该会话交互的权限');};
        authorize();let answer=frame.answer;
        if(frame.attachments!==undefined){
          if(!adapter.descriptor.capabilities.attachments)throw Error('此 Agent 不支持附件');
          const attachments=await validateConversationAnswerAttachments(id,frame.attachments);authorize();
          if(!answer||typeof answer!=='object'||Array.isArray(answer))throw Error('回答格式无效');answer={...answer,attachments};
        }
        await stop.respond(frame.request_id,answer);
      }catch(failure){error=failure instanceof Error?failure.message:'交互提交失败';}
      if(socket.readyState===1)socket.send(JSON.stringify({type:'interaction_result',request_id:frame.request_id,ok:!error,...(error?{error}:{})}));
    });
    let alive=true;socket.on('pong',()=>{alive=true;});
    const heartbeat=setInterval(()=>{if(socket.readyState!==1)return;if(!alive){socket.terminate();return;}alive=false;socket.ping();socket.send(JSON.stringify({type:'heartbeat'}));},25000);
    socket.once('close',()=>{clearInterval(heartbeat);stopFileFallback();stopProgress();stop();stopRetry();});
  });

  app.get<{Params:{id:string};Querystring:{after?:string;before?:string;limit?:string}}>('/sessions/:id/conversation',async(req,reply)=>{
    const id=req.params.id;
    if(!canAccessAgentSession(req.user!.id,id)) return reply.code(404).send({error:'Session not found'});
    if(req.query.after && req.query.before) return reply.code(400).send({error:'只能选择一种分页方向'});
    if([req.query.after,req.query.before].some(cursor=>cursor && !/^[a-f0-9]{32}$/.test(cursor))) return reply.code(400).send({error:'分页标识无效'});
    const session=getSession(id);
    if(!session) return reply.code(404).send({error:'Session not found'});
    const project=session.project_id ? getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined : undefined;
    const page=await readConversation({...session,cli_type:session.cli_type||'claude',codex_session_id:session.codex_session_id,claude_session_id:session.claude_session_id,project_path:project?.path||null},
      {after:req.query.after,before:req.query.before,limit:Number(req.query.limit)||40});
    const state=getTracker(id)?.state;
    const runtime=personalQuestionRuntime(await readAgentRuntime(session),req.user!.id);
    return reply.header('Cache-Control','private, no-store').send({...page,...presentAgentSession(session),messages:decorateConversationAttachments(id,linkConversationInputs(id,nativeConversationId(session),page.messages)),session_id:id,session_status:session.status,session_active:isSessionActive(id),
      native_id:nativeConversationId(session),runtime,
      interaction:state ? {processState:state.processState,promptType:state.promptType,isPermission:state.isPermission,choices:state.choices} : null});
  });

  app.get<{Params: {id: string}}>('/sessions/:id/agent-messages', async (req, reply) => {
    if (!canAccessAgentSession(req.user!.id, req.params.id)) return reply.status(404).send({error: 'Session not found'});
    const session = getSession(req.params.id);
    if (!session) return reply.status(404).send({error: 'Session not found'});
    const project = session.project_id ? getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path: string} | undefined : undefined;
    const messages = await loadRecentAgentMessages({...session,cli_type: session.cli_type || 'claude', codex_session_id: session.codex_session_id || null,
      claude_session_id: session.claude_session_id || null, project_path: project?.path || null});
    return {session_id: session.id, ...sessionPresenter(req.user!.id)(session), messages, available: messages.length > 0};
  });

  app.get<{Params: {id: string}}>('/sessions/:id/completed-turn', async (req, reply) => {
    if (!canAccessAgentSession(req.user!.id, req.params.id)) return reply.status(404).send({ error: 'Session not found' });
    const session = getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    const project = session.project_id ? getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path: string} | undefined : undefined;
    const turns = await loadRecentPromptContext({
      ...session,cli_type: session.cli_type || 'claude',
      codex_session_id: session.codex_session_id || null,
      claude_session_id: session.claude_session_id || null,
      project_path: project?.path || null,
    }, 1);
    return { turns };
  });

  /* ----------------------------------------------------------------
     GET /sessions/:id/display — Rendered output + state for polling
     Returns clean terminal text (last N lines or incremental via cursor),
     plus inline session state so bots don't need two round-trips.
     ---------------------------------------------------------------- */
  app.get<{
    Params: { id: string };
    Querystring: { lines?: string; since?: string; cols?: string; rows?: string };
  }>('/sessions/:id/display', async (req, reply) => {
    const { id } = req.params;

    if (!canAccessAgentSession(req.user!.id, id)) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const session = getSession(id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const lines = Math.min(parseInt(req.query.lines || '50', 10) || 50, 5000);
    const since = req.query.since ? parseInt(req.query.since, 10) : undefined;
    const cols = Math.min(parseInt(req.query.cols || '120', 10) || 120, 300);
    const rows = Math.min(parseInt(req.query.rows || '40', 10) || 40, 200);

    // Fetch chunks — either incremental (since cursor) or tail (last N * ~10 chunks)
    // We over-fetch chunks then trim the rendered output to `lines` lines
    const chunkLimit = since != null ? 50000 : lines * 10;
    const result = querySessionOutputSince(id, { since, limit: chunkLimit });
    // Replay is archived and deleted when a session exits. Keep final failures
    // observable through the same authorized, clean-text monitoring endpoint.
    const snapshot = result.chunks.length === 0 && ['completed', 'failed', 'cancelled'].includes(session.status)
      ? getSessionSnapshot(id) : null;
    const chunks = snapshot ? [{seq: result.latestSeq, data: snapshot.rendered}] : result.chunks;

    // Determine initial terminal dimensions from first resize marker or defaults
    let initCols = snapshot?.cols || cols;
    let initRows = snapshot?.rows || rows;
    for (const chunk of chunks) {
      if (chunk.data.startsWith(RESIZE_MARKER)) {
        const parts = chunk.data.slice(RESIZE_MARKER.length).split(',');
        initCols = parseInt(parts[0], 10) || cols;
        initRows = parseInt(parts[1], 10) || rows;
        break;
      }
    }

    // Render through headless terminal for clean output
    const term = new HeadlessTerminal({
      cols: initCols, rows: initRows, scrollback: 200000, allowProposedApi: true,
    });

    const rendered = await new Promise<string>((resolve) => {
      let idx = 0;
      const MAX_BATCH = 512 * 1024;

      function processNext() {
        let batchData = '';
        while (idx < chunks.length) {
          const chunk = chunks[idx];
          if (chunk.data.startsWith(RESIZE_MARKER)) {
            if (batchData) { term.write(batchData); batchData = ''; }
            const parts = chunk.data.slice(RESIZE_MARKER.length).split(',');
            const newCols = parseInt(parts[0], 10);
            const newRows = parseInt(parts[1], 10);
            if (newCols > 0 && newRows > 0) term.resize(newCols, newRows);
            idx++;
            continue;
          }
          batchData += chunk.data;
          idx++;
          if (batchData.length >= MAX_BATCH) {
            term.write(batchData, () => processNext());
            return;
          }
        }
        term.write(batchData, () => finalize());
      }

      function finalize() {
        // SerializeAddon emits an ANSI replay stream, not clean text. Read the
        // rendered terminal cells so automation does not receive cursor codes.
        const buffer = term.buffer.active;
        const screenLines: string[] = [];
        for (let index = 0; index < buffer.length; index++) screenLines.push(buffer.getLine(index)?.translateToString(true) || '');
        const raw = screenLines.join('\n');
        term.dispose();

        // Clean up: collapse blank lines, strip ANSI remnants from line content check
        const isBlank = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
        const allLines = raw.split('\n');
        const collapsed: string[] = [];
        let blankRun = 0;
        for (const line of allLines) {
          if (isBlank(line)) {
            blankRun++;
            if (blankRun <= 1) collapsed.push('');
          } else {
            blankRun = 0;
            collapsed.push(line);
          }
        }
        while (collapsed.length > 0 && collapsed[0] === '') collapsed.shift();
        while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();

        // Trim to requested line count (from the end)
        const trimmed = collapsed.length > lines ? collapsed.slice(-lines) : collapsed;
        resolve(trimmed.join('\n'));
      }

      processNext();
    });

    // Get state from tracker if session is active, otherwise infer from DB
    const tracker = getTracker(id);
    const processState = tracker ? tracker.state.processState
      : (session.status === 'running' ? 'busy' : 'idle');
    const promptType = tracker?.state.promptType ?? null;
    const choices = tracker?.state.choices ?? null;

    return {
      sessionId: id,
      ...sessionPresenter(req.user!.id)(session),
      observed_at: new Date().toISOString(),
      last_activity_at: tracker?.state.lastActivity ? new Date(tracker.state.lastActivity).toISOString() : null,
      processState,
      promptType,
      choices,
      output: rendered,
      outputSource: snapshot ? 'snapshot' : 'replay',
      cursor: result.latestSeq,
      cursorReset: result.cursorReset || false,
      truncated: result.hasMore || rendered.split('\n').length < (result.chunks.length > 0 ? lines : 0),
    };
  });

  /* ----------------------------------------------------------------
     WS /sessions/:id/agent — Structured agent WebSocket
     ---------------------------------------------------------------- */
  app.get<{
    Params: { id: string };
  }>('/sessions/:id/agent', { websocket: true, preValidation: async (req,reply) => {
    if(req.headers.upgrade?.toLowerCase() !== 'websocket') {
      if(!requirePermission(req,reply,'agent_api','write'))return reply;
      return canAccessAgentSession(req.user!.id,req.params.id)
      ? reply.code(426).header('Upgrade','websocket').send({error:'WebSocket upgrade required'})
      : reply.code(404).send({error:'Session not found'});
    }
  } }, (socket, req) => {
    const { id } = req.params;

    if (!registerUserConnection(req.user!.id, readSessionCookie(req), socket)) return;

    if (!canAccessAgentSession(req.user!.id, id)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
      socket.close();
      return;
    }
    if (!isSessionActive(id)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
      socket.close();
      return;
    }

    const tracker = getOrCreateTracker(id);

    // Send current state on connect
    socket.send(JSON.stringify({
      type: 'connected',
      sessionId: id,
      state: tracker.state,
    }));

    // Subscribe to state changes
    const unsubState = tracker.onStateChange((state: SessionState) => {
      try {
        socket.send(JSON.stringify({ type: 'state_change', ...state }));
      } catch { /* ignore */ }
    });

    // Subscribe to clean output
    const unsubOutput = tracker.onCleanOutput((text: string) => {
      try {
        socket.send(JSON.stringify({ type: 'output', text }));
      } catch { /* ignore */ }
    });

    // Handle incoming messages
    socket.on('message', async (raw: Buffer | string) => {
      if (Buffer.byteLength(raw) > MAX_AGENT_MESSAGE_BYTES) {
        try { socket.close(1009, 'Agent message is too large'); } catch { /* already closed */ }
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'execute': {
            if (tracker.hasPendingExecute) {
              socket.send(JSON.stringify({
                type: 'execute_result',
                requestId: msg.requestId,
                error: 'Session already processing an execute request',
              }));
              return;
            }

            const validated = validateExecuteRequest(msg);
            if (!validated.ok) {
              socket.send(JSON.stringify({
                type: 'execute_result',
                requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, 128) : undefined,
                error: validated.error,
              }));
              return;
            }
            const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 128) : undefined;

            const execution = tracker.execute({
              ...validated.request,
            });

            try {
              await execution.ready;
              tracker.resetOutputBuffer();
              writeToSession(id, validated.request.input);
              setTimeout(() => writeToSession(id, '\r'), 50);
              const result = await execution.result;
              socket.send(JSON.stringify({
                type: 'execute_result',
                requestId,
                ...result,
              }));
            } catch (err: any) {
              socket.send(JSON.stringify({
                type: 'execute_result',
                requestId,
                error: err.message,
              }));
            }
            break;
          }

          case 'get_state': {
            socket.send(JSON.stringify({
              type: 'state',
              requestId: msg.requestId,
              ...tracker.state,
            }));
            break;
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    // Cleanup on close
    socket.on('close', () => {
      unsubState();
      unsubOutput();
    });
  });
};
