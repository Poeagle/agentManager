import { FastifyPluginAsync } from 'fastify';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as { Terminal: any };
import { isSessionActive, writeToSession, querySessionOutputSince, getSession, getSessionSnapshot } from '../services/session-manager.js';
import { RESIZE_MARKER } from '../services/session-manager.js';
import { getTracker, getOrCreateTracker } from '../services/session-state.js';
import type { SessionState } from '../services/session-state.js';
import { getSessionUser,readSessionCookie, sessionCookieName, userCanUseSessionTool,isAdmin } from '../auth.js';
import { registerUserConnection } from '../services/user-connections.js';
import { requirePermission,userHasPermission } from '../services/rbac.js';
import { getDb } from '../db/index.js';
import { loadRecentAgentMessages, loadRecentPromptContext } from '../services/prompt-context.js';
import { sessionPresenter } from '../services/session-labels.js';
import {randomUUID} from 'crypto';
import {readConversation} from '../services/conversation-reader.js';
import {readCodexRuntime} from '../services/codex-runtime.js';
import {decorateConversationAttachments,rememberConversationAttachments,formatConversationInput,validateConversationAttachments} from '../services/conversation-attachments.js';
import {observeConversationFile} from '../services/conversation-file-stream.js';
import {observeCodexConversation,submitStreamingCodexInput} from '../services/conversation-stream.js';
import {readConversationControls,readModelPreference,validateModelPreference,saveModelPreference,applyCodexModelSettings} from '../services/conversation-controls.js';

function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' {
  if (mode === 'terminal') return mode;
  return 'session';
}

function normalizeCliType(cliType: string | null | undefined): 'claude' | 'codex' {
  return cliType === 'codex' ? 'codex' : 'claude';
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
const pendingInputs = new Map<string, Promise<void>>();

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
    version: '2.8.0',
    updatedAt: '2026-10-21',
    scope: 'Supported external automation API for authentication, project discovery and management, session lifecycle/control, scheduled tasks, Codex quota reads, and configured prompt enhancement. Internal dashboard, administration, filesystem, Git, settings, and UI-state routes are intentionally outside this contract.',
    description: 'Authenticated automation API for permitted AgentManager projects, sessions, scheduled tasks, and configured prompt enhancement. This response is the single source of truth used by the dashboard guide and its copyable prompt.',
    authentication: {
      type: 'HttpOnly session cookie',
      cookieName: sessionCookieName(),
      loginEndpoint: '/api/auth/login',
      capabilitiesEndpoint: '/api/agent/capabilities',
      login: 'POST /api/auth/login with { username, password }; persist the Set-Cookie response in a private cookie jar.',
      usage: 'Send the cookie on every protected REST request and WebSocket handshake. Same-origin browser requests use credentials: "include".',
      errors: { 401: 'Missing, expired, or invalid login session.' },
      security: 'Never put credentials or cookie values in an agent prompt, logs, or source control.',
    },
    authorization: {
      platform: 'Platform functions use RBAC role grants. Agent API inspection requires agent_api read; execute/cancel and agent WebSocket connections require agent_api write. Project/tool permissions and session ownership are checked separately.',
      projects: 'GET /api/projects returns only visible projects plus tool_access flags for the authenticated user.',
      sessions: 'Members can create only permitted mode/CLI combinations and can control only their own sessions. Administrators can monitor and interact with permitted sessions, but DELETE /api/sessions/:id may kill only a session created by the logged-in user.',
      scheduledTasks: 'Scheduled tasks, their run history, and existing-session targets are always restricted to the logged-in user.',
      promptEnhancer: 'Prompt enhancement can target only a tab created by the logged-in user. Its LLM configuration and API key require platform settings write permission and are never exposed by this API.',
      createSession: 'The project must already be registered. Supply project_id and its matching project_path; project_path alone is resolved only when it exactly matches a registered project.',
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
      '1. POST /api/auth/login — authenticate once and persist the returned cookie securely',
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
        category: 'Sessions',
        method: 'POST',
        path: '/api/sessions',
        description: 'Create a session in a registered project using a mode and CLI permitted by the authenticated user.',
        request: {
          project_id: { type: 'string', required: false, recommended: true, description: 'ID returned by GET /api/projects.' },
          project_path: { type: 'string', required: true, description: 'Must match the registered project path.' },
          task: { type: 'string', required: false, description: 'Required for Session mode; ignored for terminal mode.' },
          mode: { type: 'session | terminal', required: false, default: 'session' },
          cli_type: { type: 'claude | codex', required: false, default: 'claude', description: 'Used by Session mode.' },
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
        description: 'Resume an ended Claude or Codex conversation in place while preserving the AgentManager session id.',
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
          source: {type:'string',required:false,description:'Use conversation to submit directly to the bound live Codex engine when available.'},
          client_id: {type:'string',required:false,description:'Client correlation ID for matching the native user-message echo.'},
          attachments: {type:'array',required:false,description:'Up to 8 {kind: image|file, name, path} references returned by this session’s paste-image/paste-file endpoints. Images total at most 10 MiB, each file at most 35 MiB, all attachments at most 50 MiB.'},
        },
        response: {id:'Session id',status:'submitted — handed to the terminal; not proof of agent acceptance or task completion'},
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
        },
        response: { prompt: 'string — enhanced draft text; review it before sending to the terminal.' },
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
          new_cli_type: { type: 'claude | codex', required: false },
          inactive_policy: { type: 'resume | fail', required: false, default: 'resume' },
          stop_at: { type: 'ISO timestamp | null', required: false },
          daily_stop_time: { type: 'HH:mm | null', required: false },
          daily_start_time: { type: 'HH:mm | null', required: false, description: 'Interval schedules only; set together with daily_end_time. The start is included and anchors each daily interval.' },
          daily_end_time: { type: 'HH:mm | null', required: false, description: 'Daily execution window end (exclusive); an earlier clock time means next day. Outside the window, sending pauses and automatically continues next window.' },
          start_conditions: { type: 'ConditionGroup | null', required: false, description: 'Recursive { operator: and|or, conditions: [Condition|ConditionGroup] }. Start leaves: time_after (HH:mm), time_range ({start,end}, end exclusive, overnight supported), weekday (workday=Mon–Fri or weekend=Sat/Sun), target_idle (boolean, existing target only). Up to 4 levels, 20 children/group, 50 total nodes.' },
          daily_stop_conditions: { type: 'ConditionGroup | null', required: false, description: 'Same recursive groups; also supports quota_below (Codex remaining percent), successes_today and failures_today (counts). Once true, pause sending until the next local day, then re-evaluate. Unknown state prevents dispatch; the session is not killed.' },
          condition_unmet_policy: { type: 'skip | wait', required: false, default: 'skip', description: 'skip: do not backfill when idle; check next fixed occurrence. wait is retained for API compatibility. Manual dispatch also obeys guards.' },
          max_successful_runs: { type: 'integer | null', required: false },
          quota_remaining_below: { type: 'integer 1..100 | null', required: false, description: 'Codex Session/Agent only.' },
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
        description: 'AgentManager automatically resumes crashed Claude or Codex sessions that have a captured native conversation ID.',
        agentAction: 'After a server restart, poll GET /api/sessions?status=running to discover auto-resumed sessions. Your session IDs remain stable.',
      },
    },
  } as const;
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    requirePermission(req, reply, 'agent_api', req.method === 'GET' && !req.routeOptions.url?.endsWith('/agent') ? 'read' : 'write');
  });
  app.get('/agent/capabilities', async () => getAgentApiContract());

  app.get<{Params:{id:string};Querystring:{refresh?:string}}>('/sessions/:id/controls',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(session.cli_type!=='codex'||!session.codex_session_id)return reply.code(409).send({error:'当前会话未绑定 Codex'});
    const shared=req.user!.role==='admin'&&(!session.created_by_user_id||isAdmin(session.created_by_user_id));
    if(req.query.refresh!==undefined&&req.query.refresh!=='true')return reply.code(400).send({error:'Invalid refresh flag'});
    const data=await readConversationControls(session.codex_session_id,shared,req.query.refresh==='true');
    const owned=!session.created_by_user_id||session.created_by_user_id===req.user!.id;
    return reply.header('Cache-Control','private, no-store').send({...data,pending:readModelPreference(req.user!.id,session.id),
      can_edit:shared&&owned&&data.loaded&&data.models.length>0&&isSessionActive(session.id)&&userHasPermission(req.user!.id,'agent_api','write')});
  });
  app.put<{Params:{id:string};Body:unknown}>('/sessions/:id/controls',async(req,reply)=>{
    const session=getSession(req.params.id);
    if(!session||!canAccessAgentSession(req.user!.id,session.id))return reply.code(404).send({error:'Session not found'});
    if(req.user!.role!=='admin'||session.created_by_user_id&&session.created_by_user_id!==req.user!.id)return reply.code(403).send({error:'只能修改自己的会话设置'});
    if(session.cli_type!=='codex'||!session.codex_session_id||!isSessionActive(session.id))return reply.code(409).send({error:'当前会话不可修改，请先恢复会话'});
    if(req.body===null){saveModelPreference(req.user!.id,session.id,null);return {ok:true,pending:null};}
    try {
      const data=await readConversationControls(session.codex_session_id,true);
      if(!data.loaded)return reply.code(409).send({error:'此会话暂不支持在对话中切换，请在原始终端设置'});
      const value=await validateModelPreference(req.body);
      try {const applied=await applyCodexModelSettings(session.codex_session_id,value);saveModelPreference(req.user!.id,session.id,null);return {ok:true,pending:null,...applied};}
      catch(error){return reply.code(503).send({error:error instanceof Error?error.message:'设置失败，请刷新确认'});}
    }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'设置失败，请重试'});}
  });

  app.post<{Params:{id:string};Body:{input?:unknown;source?:unknown;client_id?:unknown;attachments?:unknown}}>('/sessions/:id/input', async (req, reply) => {
    const {id} = req.params;
    if (!canAccessAgentSession(req.user!.id,id) || !isSessionActive(id)) return reply.code(404).send({error:'Session not found or not running'});
    const input = req.body?.input;
    if (typeof input !== 'string' || (!input.trim() && !(Array.isArray(req.body?.attachments) && req.body.attachments.length)) || Buffer.byteLength(input) > MAX_EXECUTE_INPUT_BYTES) return reply.code(400).send({error:'input must be text of at most 64 KiB, with text or at least one attachment'});
    const clientId=req.body?.client_id;
    if(clientId!==undefined && (typeof clientId!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clientId))) return reply.code(400).send({error:'Invalid client_id'});
    let attachments;try{attachments=await validateConversationAttachments(id,req.body?.attachments);}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'附件不可用'});}
    const preparedInput=formatConversationInput(input,attachments,true);
    const attachmentClientId=typeof clientId==='string'?clientId:randomUUID();
    // Serialize only the brief paste/Enter pair, never the agent's execution.
    // A second caller must not paste its text before the first caller's Enter.
    const prior = pendingInputs.get(id) || Promise.resolve();
    const submission = prior.catch(() => {}).then(async () => {
      const session=getSession(id);
      if(req.body?.source==='conversation' && process.env.AGENTMANAGER_CODEX_STREAM_SOCKET && session?.cli_type==='codex' && session.codex_session_id) {
        if(attachments.length)rememberConversationAttachments(id,attachmentClientId,input,attachments,true);
        if(await (attachments.length?submitStreamingCodexInput(session.codex_session_id,input,attachmentClientId,attachments):clientId?submitStreamingCodexInput(session.codex_session_id,input,clientId):submitStreamingCodexInput(session.codex_session_id,input))) return;
      }
      if(attachments.length)rememberConversationAttachments(id,attachmentClientId,input,attachments,false);
      if (!writeToSession(id,preparedInput,true)) throw new Error('Session input is unavailable');
      await new Promise(resolve => setTimeout(resolve,50));
      if (!writeToSession(id,'\r',false)) throw new Error('Input was pasted but submission could not be confirmed');
    });
    pendingInputs.set(id,submission);
    try {
      await submission;
      return reply.code(202).send({id,status:'submitted'});
    } catch {
      return reply.code(503).send({error:'Input submission could not be confirmed; inspect the tab before retrying'});
    } finally {
      if (pendingInputs.get(id) === submission) pendingInputs.delete(id);
    }
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

  app.get<{Params:{id:string}}>('/sessions/:id/conversation/stream',{websocket:true},(socket,req)=>{
    const id=req.params.id;
    if(!req.user || !canAccessAgentSession(req.user.id,id)) {socket.close(1008,'Session not found');return;}
    if(!registerUserConnection(req.user.id,readSessionCookie(req),socket)) return;
    const session=getSession(id);
    if(session?.cli_type!=='codex'||!session.codex_session_id) {
      socket.send(JSON.stringify({type:'unavailable',reason:'等待原生实时会话连接'}));socket.close(1000);return;
    }
    const send=(frame:any)=>{
      if(!canAccessAgentSession(req.user!.id,id)) {socket.close(1008);return;}
      if(socket.readyState===1 && socket.bufferedAmount<1024*1024) socket.send(JSON.stringify(['snapshot','history'].includes(frame.type)?{...frame,messages:decorateConversationAttachments(id,frame.messages)}:frame));
      else if(socket.readyState===1) socket.close(1013,'Slow conversation client');
    };
    const stopFile=observeConversationFile({cli_type:'codex',codex_session_id:session.codex_session_id,claude_session_id:null,project_path:null},send);
    const stop=observeCodexConversation(session.codex_session_id,frame=>{
      send(frame);
      if(frame.type==='unavailable'&&frame.reconnect&&socket.readyState===1)socket.close(1012,'Native connection lost');
    });
    socket.on('message',bytes=>{
      let frame:any;try{const raw=bytes.toString();if(Buffer.byteLength(raw)>64*1024){socket.close(1009,'Interaction response too large');return;}frame=JSON.parse(raw);}catch{return;}
      if(frame?.type!=='interaction_response'||typeof frame.request_id!=='string')return;
      let error:string|undefined;
      try {
        if(getSessionUser(readSessionCookie(req)||'')?.id!==req.user!.id||!canAccessAgentSession(req.user!.id,id)||!userHasPermission(req.user!.id,'agent_api','write'))throw new Error('当前账号没有处理该会话交互的权限');
        stop.respond(frame.request_id,frame.answer);
      }catch(failure){error=failure instanceof Error?failure.message:'交互提交失败';}
      if(socket.readyState===1)socket.send(JSON.stringify({type:'interaction_result',request_id:frame.request_id,ok:!error,...(error?{error}:{})}));
    });
    const heartbeat=setInterval(()=>{if(socket.readyState===1) socket.ping();},25000);
    socket.once('close',()=>{clearInterval(heartbeat);stopFile?.();stop();});
  });

  app.get<{Params:{id:string};Querystring:{after?:string;before?:string;limit?:string}}>('/sessions/:id/conversation',async(req,reply)=>{
    const id=req.params.id;
    if(!canAccessAgentSession(req.user!.id,id)) return reply.code(404).send({error:'Session not found'});
    if(req.query.after && req.query.before) return reply.code(400).send({error:'只能选择一种分页方向'});
    if([req.query.after,req.query.before].some(cursor=>cursor && !/^[a-f0-9]{32}$/.test(cursor))) return reply.code(400).send({error:'分页标识无效'});
    const session=getSession(id);
    if(!session) return reply.code(404).send({error:'Session not found'});
    const project=session.project_id ? getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined : undefined;
    const page=await readConversation({cli_type:session.cli_type==='codex'?'codex':'claude',codex_session_id:session.codex_session_id,claude_session_id:session.claude_session_id,project_path:project?.path||null},
      {after:req.query.after,before:req.query.before,limit:Number(req.query.limit)||40});
    const state=getTracker(id)?.state;
    const runtime=session.cli_type==='codex' ? await readCodexRuntime(session.codex_session_id) : null;
    return reply.header('Cache-Control','private, no-store').send({...page,messages:decorateConversationAttachments(id,page.messages),session_id:id,session_status:session.status,session_active:isSessionActive(id),
      native_id:session.cli_type==='codex'?session.codex_session_id:session.claude_session_id,runtime,
      interaction:state ? {processState:state.processState,promptType:state.promptType,isPermission:state.isPermission,choices:state.choices} : null});
  });

  app.get<{Params: {id: string}}>('/sessions/:id/agent-messages', async (req, reply) => {
    if (!canAccessAgentSession(req.user!.id, req.params.id)) return reply.status(404).send({error: 'Session not found'});
    const session = getSession(req.params.id);
    if (!session) return reply.status(404).send({error: 'Session not found'});
    const project = session.project_id ? getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path: string} | undefined : undefined;
    const messages = await loadRecentAgentMessages({cli_type: session.cli_type === 'codex' ? 'codex' : 'claude', codex_session_id: session.codex_session_id || null,
      claude_session_id: session.claude_session_id || null, project_path: project?.path || null});
    return {session_id: session.id, ...sessionPresenter(req.user!.id)(session), messages, available: messages.length > 0};
  });

  app.get<{Params: {id: string}}>('/sessions/:id/completed-turn', async (req, reply) => {
    if (!canAccessAgentSession(req.user!.id, req.params.id)) return reply.status(404).send({ error: 'Session not found' });
    const session = getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    const project = session.project_id ? getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path: string} | undefined : undefined;
    const turns = await loadRecentPromptContext({
      cli_type: session.cli_type === 'codex' ? 'codex' : 'claude',
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
  }>('/sessions/:id/agent', { websocket: true }, (socket, req) => {
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
