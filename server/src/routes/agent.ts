import { FastifyPluginAsync } from 'fastify';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as { Terminal: any };
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: any };
import { isSessionActive, writeToSession, querySessionOutputSince, getSession } from '../services/session-manager.js';
import { RESIZE_MARKER } from '../services/session-manager.js';
import { getTracker, getOrCreateTracker } from '../services/session-state.js';
import type { SessionState } from '../services/session-state.js';
import { userCanUseSessionTool } from '../auth.js';

function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' | 'agent' {
  if (mode === 'terminal' || mode === 'agent') return mode;
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

export const agentRoutes: FastifyPluginAsync = async (app) => {

  /* ----------------------------------------------------------------
     GET /agent/capabilities — Self-describing API for agent discovery
     ---------------------------------------------------------------- */
  app.get('/agent/capabilities', async () => ({
    name: 'AgentManager Agent API',
    version: '1.2.0',
    description: 'Authenticated, structured control layer for permitted AgentManager sessions. The display and execute endpoints return clean, readable output rendered through a virtual terminal — no ANSI artifacts or TUI garbage.',
    authentication: {
      type: 'HttpOnly session cookie',
      cookieName: 'agentmanager_session',
      login: 'POST /api/auth/login with { username, password }; persist the Set-Cookie response in a private cookie jar.',
      usage: 'Send the cookie on every protected REST request and WebSocket handshake. Same-origin browser requests use credentials: "include".',
      errors: { 401: 'Missing, expired, or invalid login session.' },
      security: 'Never put credentials or cookie values in an agent prompt, logs, or source control.',
    },
    authorization: {
      projects: 'GET /api/projects returns only visible projects plus tool_access flags for the authenticated user.',
      sessions: 'Members can create only permitted mode/CLI combinations and can control only sessions they created. Admins can access all projects and sessions.',
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
        busy: 'Session is producing output. Wait before sending input.',
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
        method: 'POST',
        path: '/api/auth/login',
        public: true,
        description: 'Authenticate and set the HttpOnly agentmanager_session cookie. Use a cookie-capable client and keep the returned cookie private.',
        request: {
          username: { type: 'string', required: true },
          password: { type: 'string', required: true },
        },
        response: { user: 'Authenticated user (password hash omitted)', setCookie: 'agentmanager_session (HttpOnly; SameSite=Lax)' },
        errors: { 400: 'Missing username/password', 401: 'Invalid username or password' },
      },
      {
        method: 'GET',
        path: '/api/projects',
        description: 'List projects visible to the authenticated user. Each project includes tool_access flags: can_session, can_agent, can_terminal, can_claude, and can_codex.',
        response: { projects: 'Project[] with tool_access' },
      },
      {
        method: 'GET',
        path: '/api/sessions',
        description: 'List sessions visible to the authenticated user. Optional ?status=running filter.',
        response: { sessions: 'Session[]' },
      },
      {
        method: 'POST',
        path: '/api/sessions',
        description: 'Create a session in a registered project using a mode and CLI permitted by the authenticated user.',
        request: {
          project_id: { type: 'string', required: false, recommended: true, description: 'ID returned by GET /api/projects.' },
          project_path: { type: 'string', required: true, description: 'Must match the registered project path.' },
          task: { type: 'string', required: false, description: 'Required for session and agent modes; ignored for terminal mode.' },
          mode: { type: 'session | agent | terminal', required: false, default: 'session' },
          cli_type: { type: 'claude | codex', required: false, default: 'claude', description: 'Used by session and agent modes.' },
          agent_type: { type: 'string', required: false, description: 'Required when mode is agent.' },
        },
        response: { ok: 'true', session: 'Created session; use session.id for control endpoints.' },
        errors: { 400: 'Missing required fields', 401: 'Not authenticated', 403: 'Project or requested tool combination is not permitted', 429: 'Active tab/session limit reached' },
      },
      {
        method: 'GET',
        path: '/api/sessions/:id/display',
        description: 'Rendered terminal output + inline state for polling. Returns clean text (no ANSI), with cursor-based incremental fetching. No side effects — safe for periodic polling.',
        request: {
          lines: { type: 'number', required: false, default: 50, description: 'Max lines of rendered terminal text to return (from the end). Max 5000.' },
          since: { type: 'number', required: false, description: 'Cursor value from a previous response. Only returns output produced after this point. Omit for initial fetch.' },
          cols: { type: 'number', required: false, default: 120, description: 'Terminal column width for rendering.' },
          rows: { type: 'number', required: false, default: 40, description: 'Terminal row height for rendering.' },
        },
        response: {
          sessionId: 'string',
          processState: 'busy | idle | waiting_for_input',
          promptType: 'choice | confirmation | text | null',
          choices: 'string[] | null',
          output: 'string — last N lines of clean rendered terminal text',
          cursor: 'number | null — pass back as ?since= for incremental polling',
          truncated: 'boolean — true if output was trimmed or more data exists',
        },
      },
      {
        method: 'POST',
        path: '/api/sessions/:id/cancel',
        description: 'Cancel a pending execute wait. This does not interrupt the underlying CLI process or send Ctrl-C. Returns { ok: true } if one was cancelled, { ok: false } if none was pending.',
      },
      {
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
        method: 'POST',
        path: '/api/sessions/:id/execute',
        description: 'Send input and get clean rendered output. Output is processed through a virtual terminal that handles all TUI cursor movements, screen redraws, and ANSI codes — you get readable text, not raw terminal data. Only one execute per session at a time (409 if busy).',
        request: {
          input: { type: 'string', required: true, description: 'Text to send (carriage return appended automatically). An empty string intentionally sends Enter.' },
          waitFor: { type: 'string', required: false, description: 'Regex pattern — resolve early when matched in output' },
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
    ],
    tips: [
      'The output fields from display and execute are CLEAN TEXT — read them directly; do not strip ANSI or parse raw PTY data.',
      'Always check state before sending input. If state is "busy", wait for idle or waiting_for_input.',
      'For interactive prompts, read promptType and choices from state to decide what to send.',
      'Prefer explicit input. An empty input string is valid and intentionally sends Enter, which may accept a prompt default.',
      'Use waitFor regex for commands with known output patterns to get faster responses.',
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
  }));

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
    const body = req.body as any;

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

    const input = body.input;
    if (typeof input !== 'string') {
      return reply.status(400).send({ error: 'input is required and must be a string' });
    }

    let waitFor: RegExp | undefined;
    if (body.waitFor) {
      try {
        waitFor = new RegExp(body.waitFor);
      } catch {
        return reply.status(400).send({ error: 'Invalid waitFor regex' });
      }
    }

    const timeout = body.timeout ?? DEFAULT_TIMEOUT;
    const quiescenceMs = body.quiescenceMs ?? DEFAULT_QUIESCENCE;
    const stripAnsi = body.stripAnsi !== false; // default true

    // Set up execute listener before writing input
    const executePromise = tracker.execute({
      input,
      waitFor,
      timeout,
      quiescenceMs,
      stripAnsi,
    });

    // Reset output buffer and write input to PTY
    tracker.resetOutputBuffer();
    writeToSession(id, input);
    setTimeout(() => writeToSession(id, '\r'), 50);

    const result = await executePromise;

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

    // Determine initial terminal dimensions from first resize marker or defaults
    let initCols = cols;
    let initRows = rows;
    for (const chunk of result.chunks) {
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
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);

    const rendered = await new Promise<string>((resolve) => {
      let idx = 0;
      const MAX_BATCH = 512 * 1024;

      function processNext() {
        let batchData = '';
        while (idx < result.chunks.length) {
          const chunk = result.chunks[idx];
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
        const raw = serializeAddon.serialize();
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
      processState,
      promptType,
      choices,
      output: rendered,
      cursor: result.latestSeq,
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

            let waitFor: RegExp | undefined;
            if (msg.waitFor) {
              try { waitFor = new RegExp(msg.waitFor); } catch {
                socket.send(JSON.stringify({
                  type: 'execute_result',
                  requestId: msg.requestId,
                  error: 'Invalid waitFor regex',
                }));
                return;
              }
            }

            const executePromise = tracker.execute({
              input: msg.input,
              waitFor,
              timeout: msg.timeout ?? DEFAULT_TIMEOUT,
              quiescenceMs: msg.quiescenceMs ?? DEFAULT_QUIESCENCE,
              stripAnsi: msg.stripAnsi !== false,
            });

            tracker.resetOutputBuffer();
            writeToSession(id, msg.input);
            setTimeout(() => writeToSession(id, '\r'), 50);

            try {
              const result = await executePromise;
              socket.send(JSON.stringify({
                type: 'execute_result',
                requestId: msg.requestId,
                ...result,
              }));
            } catch (err: any) {
              socket.send(JSON.stringify({
                type: 'execute_result',
                requestId: msg.requestId,
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
