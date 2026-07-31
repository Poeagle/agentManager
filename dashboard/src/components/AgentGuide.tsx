import { useState } from 'react';
import { Bot, X, Copy, Check, Play } from 'lucide-react';

export function AgentGuideButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors hover:bg-white/10"
        style={{ color: 'var(--text-secondary)' }}
        title="Agent Integration Guide"
      >
        <Bot className="w-4 h-4" />
        <span className="hidden sm:inline">Agent API</span>
      </button>

      {open && <AgentGuideModal onClose={() => setOpen(false)} />}
    </>
  );
}

interface AgentGuideModalProps {
  onClose: () => void;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  task?: string;
  additionalInstructions?: string;
}

export function AgentGuideModal({ onClose, projectId, projectName, projectPath, task, additionalInstructions }: AgentGuideModalProps) {
  // The dashboard and API are served from the same origin in production and
  // through Vite's /api proxy in development. Respect reverse proxies and the
  // configured server port instead of assuming the historical default :42010.
  const baseUrl = window.location.origin;
  const [copiedAll, setCopiedAll] = useState(false);
  const hasContext = !!(projectName && projectPath);

  const copyFullGuide = () => {
    const text = hasContext
      ? generateContextualGuide(baseUrl, projectName!, projectPath!, task, additionalInstructions, projectId)
      : generatePlainTextGuide(baseUrl);
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {hasContext ? `Run ${projectName} with OpenClaw` : 'Agent Integration Guide'}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyFullGuide}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: copiedAll ? 'var(--success)' : 'var(--bg-tertiary)',
                color: copiedAll ? 'white' : 'var(--text-secondary)',
              }}
              title="Copy entire guide as plain text (for pasting into agent prompts)"
            >
              {copiedAll ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedAll ? 'Copied!' : 'Copy All'}
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Project context banner */}
          {hasContext && (
            <div
              className="rounded-lg border p-4 space-y-2"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--accent)', borderWidth: '1px' }}
            >
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--accent)' }}>
                <Play className="w-4 h-4" />
                Ready to Run
              </div>
              <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
                <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>Project:</span> {projectName}</div>
                {projectId && <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>ID:</span> <code className="text-xs font-mono">{projectId}</code></div>}
                <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>Path:</span> <code className="text-xs font-mono">{projectPath}</code></div>
                {task && <div><span className="font-medium" style={{ color: 'var(--text-primary)' }}>Task:</span> {task}</div>}
                {additionalInstructions && (
                  <div>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Additional Instructions:</span>
                    <pre className="text-xs mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{additionalInstructions}</pre>
                  </div>
                )}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Click "Copy All" to copy the full command with project details, then paste it to OpenClaw.
              </p>
            </div>
          )}

          {/* Intro */}
          <Section title="Overview">
            <p>
              External bot agents (like OpenClaw) can fully control AgentManager sessions via the REST API.
              Create permitted sessions, send commands, read output, and respond to prompts — all programmatically.
            </p>
          </Section>

          {/* Authentication */}
          <Section title="Authentication Required">
            <p>
              Agent API requests use the same <code>agentmanager_session</code> login cookie as the dashboard.
              Browser requests on this origin already include it. External clients must log in once and keep the
              returned cookie for every REST request and WebSocket handshake.
            </p>
            <CodeBlock text={`# Store the HttpOnly login cookie without printing it
umask 077
curl --fail --silent --show-error \\
  -c ./agentmanager.cookies \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' \\
  ${baseUrl}/api/auth/login

# Reuse it on every subsequent API request
curl --fail --silent --show-error \\
  -b ./agentmanager.cookies \\
  ${baseUrl}/api/agent/capabilities`} />
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              Keep the cookie file private and never paste real credentials or cookie values into an agent prompt.
              Unauthenticated requests return <code>401</code>.
            </p>
          </Section>

          {/* Capabilities endpoint */}
          <Section title="Self-Describing API">
            <p>
              The capabilities endpoint returns the current agent-control contract, state machine, prompt types, and operational guidance.
              After authentication, point your agent here first:
            </p>
            <CodeBlock text={`GET ${baseUrl}/api/agent/capabilities`} />
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              This is the single source of truth for the agent-control contract. It includes the core integration endpoints,
              request/response schemas, error codes, and tips.
            </p>
          </Section>

          {/* Quick start */}
          <Section title="Quick Start">
            <ol className="list-decimal list-inside space-y-2">
              <li>
                <strong>Authenticate</strong> and persist the returned session cookie, as shown above.
              </li>
              <li>
                <strong>List accessible projects</strong> and select one whose <code>tool_access</code> permits the requested mode and CLI:
                <CodeBlock text={`GET ${baseUrl}/api/projects`} />
              </li>
              <li>
                <strong>Create a session</strong> in that registered project:
                <CodeBlock text={`POST ${baseUrl}/api/sessions
Content-Type: application/json

{
  "project_id": "project-id-from-step-2",
  "project_path": "/path/to/project",
  "task": "Fix the login bug",
  "mode": "session",
  "cli_type": "codex"
}`} />
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <code>mode</code> is <code>session</code>, <code>agent</code>, or <code>terminal</code>.
                  Agent mode also requires <code>agent_type</code>; interactive modes support <code>cli_type</code> values
                  <code> claude</code> and <code>codex</code>.
                </p>
              </li>
              <li>
                <strong>Poll for output + state</strong> with a single call (no side effects):
                <CodeBlock text={`GET ${baseUrl}/api/sessions/:id/display?lines=100

# Returns rendered terminal text + inline state:
{
  "sessionId": "...",
  "processState": "idle",
  "promptType": "choice",
  "choices": ["Option A", "Option B"],
  "output": "...last 100 lines of clean terminal text...",
  "cursor": 1234,
  "truncated": false
}`} />
              </li>
              <li>
                <strong>Poll incrementally</strong> — pass the <code>cursor</code> from previous response to only get new content:
                <CodeBlock text={`GET ${baseUrl}/api/sessions/:id/display?lines=100&since=1234`} />
              </li>
              <li>
                <strong>Send input</strong> when the session needs it (<code>waiting_for_input</code> or <code>idle</code>):
                <CodeBlock text={`POST ${baseUrl}/api/sessions/:id/execute
Content-Type: application/json

{
  "input": "your response or command",
  "timeout": 60000,
  "quiescenceMs": 5000
}`} />
              </li>
              <li>
                <strong>Repeat the polling and input steps</strong> until the task is complete.
              </li>
            </ol>
          </Section>

          {/* Key rules */}
          <Section title="Critical Rules">
            <ul className="space-y-1.5">
              <Rule>Authenticate first, then read <code>/api/agent/capabilities</code> before creating or controlling sessions.</Rule>
              <Rule>Only projects, sessions, modes, and CLIs granted to the logged-in user are visible or controllable.</Rule>
              <Rule>Use <code>GET /sessions/:id/display</code> for read-only monitoring — output + state in one call with cursor-based incremental polling.</Rule>
              <Rule>Use <code>POST /sessions/:id/execute</code> to send input and get the response.</Rule>
              <Rule>Send input only to answer a prompt or issue a command. Prefer explicit responses; an empty string intentionally sends Enter and may accept a prompt default.</Rule>
              <Rule>NEVER read PTY output directly, scrape temp files, or parse raw terminal data.</Rule>
              <Rule>Check <code>processState</code> before sending input — if <code>busy</code>, wait.</Rule>
              <Rule>When <code>promptType</code> is <code>choice</code>, use the <code>choices</code> array to pick the right option number.</Rule>
              <Rule>Use <code>timeout: 60000</code> and <code>quiescenceMs: 5000</code> for interactive coding sessions.</Rule>
            </ul>
          </Section>

          {/* Reading output */}
          <Section title="Reading Output (Display vs Execute)">
            <p>
              <strong><code>GET /sessions/:id/display</code></strong> — Read-only. Returns the last N lines of rendered terminal text
              plus inline state (processState, promptType, choices) in a single call. Use the <code>cursor</code> value
              for incremental polling — pass it back as <code>?since=cursor</code> to only get new content.
              This is the <strong>recommended way to monitor</strong> what a session is doing.
            </p>
            <p className="mt-2">
              <strong><code>POST /sessions/:id/execute</code></strong> — Send input and get output. Only returns
              <strong> new output generated after your input</strong>. Use this when you need to interact, not just observe.
              Prefer meaningful text (e.g. <code>"Ready"</code>); an empty string deliberately sends Enter.
            </p>
          </Section>

          {/* WebSocket */}
          <Section title="Real-Time WebSocket (Optional)">
            <p>
              For lower latency, connect via WebSocket instead of polling:
            </p>
            <CodeBlock text={`WS ${baseUrl.replace('http', 'ws')}/api/sessions/:id/agent`} />
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              The WebSocket handshake must carry the login cookie. It supports <code>execute</code> and <code>get_state</code>
              messages and pushes <code>state_change</code> and <code>output</code> events in real-time.
            </p>
          </Section>

          {/* All endpoints summary */}
          <Section title="Integration Endpoints">
            <div className="space-y-1 font-mono text-xs">
              <EndpointRow method="POST" path="/api/auth/login" desc="Login and set session cookie (public)" />
              <EndpointRow method="GET" path="/api/projects" desc="List accessible projects + tool access" />
              <EndpointRow method="POST" path="/api/projects" desc="Add a project (admin only)" />
              <EndpointRow method="DELETE" path="/api/projects/:id" desc="Remove a project (owner/admin)" />
              <EndpointRow method="GET" path="/api/sessions" desc="List accessible sessions" />
              <EndpointRow method="POST" path="/api/sessions" desc="Create a permitted session" />
              <EndpointRow method="DELETE" path="/api/sessions/:id" desc="Kill a session" />
              <EndpointRow method="GET" path="/api/sessions/:id/state" desc="Get session state" />
              <EndpointRow method="GET" path="/api/sessions/:id/display" desc="Rendered output + state (polling)" />
              <EndpointRow method="POST" path="/api/sessions/:id/execute" desc="Send input, get output" />
              <EndpointRow method="POST" path="/api/sessions/:id/cancel" desc="Cancel pending execute wait (not the CLI)" />
              <EndpointRow method="GET" path="/api/agent/capabilities" desc="Agent control contract (self-describing)" />
              <EndpointRow method="GET" path="/api/context" desc="Concise session summary (low tokens)" />
              <EndpointRow method="WS" path="/api/sessions/:id/agent" desc="Real-time agent WebSocket" />
            </div>
          </Section>

          {/* Example bot loop */}
          <Section title="Example Agent Loop">
            <CodeBlock text={`// Minimal agent control loop
const BASE = "${baseUrl}/api";

// This browser-oriented example reuses the dashboard's HttpOnly login cookie.
// External runtimes must use an equivalent cookie jar after POST /auth/login.
async function api(path, init = {}) {
  const response = await fetch(\`\${BASE}\${path}\`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers }
  });
  if (!response.ok) throw new Error(\`API \${response.status}: \${await response.text()}\`);
  return response.json();
}

// 1. Authenticate first, then read capabilities
const caps = await api("/agent/capabilities");

// 2. Select a permitted project, then create a session
const { projects } = await api("/projects");
const project = projects.find(p =>
  p.tool_access?.can_session && (p.tool_access.can_codex || p.tool_access.can_claude)
);
if (!project) throw new Error("No project permits interactive sessions");
const cliType = project.tool_access.can_codex ? "codex" : "claude";

const { session } = await api("/sessions", {
  method: "POST",
  body: JSON.stringify({
    project_id: project.id,
    project_path: project.path,
    task: "Fix the auth middleware",
    mode: "session",
    cli_type: cliType
  })
});

// 3. Poll display endpoint for output + state (single call)
let cursor = null;
async function pollDisplay(id) {
  const path = cursor
    ? \`/sessions/\${id}/display?lines=100&since=\${cursor}\`
    : \`/sessions/\${id}/display?lines=100\`;
  const data = await api(path);
  cursor = data.cursor; // save for next incremental poll
  return data;
}

// 4. Wait for session to be ready, reading output along the way
let display;
while (true) {
  display = await pollDisplay(session.id);
  if (display.output) console.log(display.output);
  if (display.processState !== "busy") break;
  await new Promise(r => setTimeout(r, 2000));
}

// 5. Interact when session needs input
while (true) {
  if (display.processState === "waiting_for_input" || display.processState === "idle") {
    const input = decideInput(display); // your logic using output + promptType + choices

    const result = await api(\`/sessions/\${session.id}/execute\`, {
      method: "POST",
      body: JSON.stringify({ input, timeout: 60000, quiescenceMs: 5000 })
    });
    console.log(result.output);
  }

  // Poll for new output
  await new Promise(r => setTimeout(r, 2000));
  display = await pollDisplay(session.id);
  if (display.output) console.log(display.output);
}`} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      <div className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {children}
      </div>
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group mt-2 mb-2">
      <pre
        className="text-xs font-mono p-3 rounded-lg overflow-x-auto"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      >
        {text}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        title="Copy"
      >
        {copied ? <Check className="w-3 h-3" style={{ color: 'var(--success)' }} /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-sm flex gap-2" style={{ color: 'var(--text-secondary)' }}>
      <span style={{ color: 'var(--accent)' }}>*</span>
      <span>{children}</span>
    </li>
  );
}

function generatePlainTextGuide(baseUrl: string): string {
  return `# AgentManager Agent Integration Guide

## Overview
External bot agents can fully control AgentManager sessions via the REST API.
Create permitted sessions, send commands, read output, and respond to prompts — all programmatically.
Base URL: ${baseUrl}

## Authentication (REQUIRED FIRST)
All Agent API endpoints require the HttpOnly agentmanager_session login cookie.
Log in once with a private cookie jar, then reuse that jar for every REST request and WebSocket handshake:

umask 077
curl --fail --silent --show-error \\
  -c ./agentmanager.cookies \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' \\
  ${baseUrl}/api/auth/login

Never paste real credentials or cookie values into an agent prompt. If the client has no authenticated cookie, stop and ask the user to establish one. A missing or expired cookie returns HTTP 401.

## Self-Describing API
After authentication, read the current contract before doing anything else:

curl --fail --silent --show-error \\
  -b ./agentmanager.cookies \\
  ${baseUrl}/api/agent/capabilities

This is the source of truth for the agent control endpoints, request/response schemas, state machine, prompt types, errors, and operational guidance.

## Quick Start

Every request below must reuse the authenticated cookie.

1. List projects visible to the logged-in user. Check tool_access for the requested mode and CLI:
   GET ${baseUrl}/api/projects

2. Create a session in a registered, permitted project:
   POST ${baseUrl}/api/sessions
   Content-Type: application/json
   {"project_id":"project-id","project_path":"/path/to/project","task":"Fix the login bug","mode":"session","cli_type":"codex"}

   mode: session | agent | terminal
   cli_type: claude | codex (for session/agent modes)
   agent mode additionally requires agent_type.

3. Poll for output + state (single call, no side effects):
   GET ${baseUrl}/api/sessions/:id/display?lines=100
   Returns: { sessionId, processState, promptType, choices, output: "rendered text", cursor: 1234, truncated: false }

4. Poll incrementally — pass cursor from the previous response to get only new content:
   GET ${baseUrl}/api/sessions/:id/display?lines=100&since=1234

5. Send input when processState is "idle" or "waiting_for_input":
   POST ${baseUrl}/api/sessions/:id/execute
   Content-Type: application/json
   {"input": "your response", "timeout": 60000, "quiescenceMs": 5000}

6. Repeat steps 3-5 until the task is complete.

## Critical Rules
- Authenticate first, then read /api/agent/capabilities before creating or controlling sessions.
- Only projects, sessions, modes, and CLIs granted to the logged-in user are visible or controllable. Members can control only their own sessions.
- Use GET /api/sessions/:id/display for read-only monitoring — output + state in one call with cursor-based incremental polling.
- Use POST /api/sessions/:id/execute to send input and get the response.
- Send input only to answer a prompt or issue a command. Prefer explicit responses; input "" intentionally sends Enter and may accept a prompt default.
- NEVER read PTY output directly, scrape temp files, or parse raw terminal data.
- Check processState before sending input — if "busy", wait.
- When promptType is "choice", use the choices array to pick the right option number.
- Use timeout: 60000 and quiescenceMs: 5000 for interactive coding sessions.

## Reading Output (Display vs Execute)
GET /sessions/:id/display — Read-only. Returns the last N lines of rendered terminal text plus inline state (processState, promptType, choices) in a single call. Use the cursor value for incremental polling — pass it back as ?since=cursor to only get new content. This is the RECOMMENDED way to monitor what a session is doing.

POST /sessions/:id/execute — Send input and get output. Only returns NEW output generated AFTER your input. Use this when you need to interact, not just observe.

## Real-Time WebSocket (Optional)
For lower latency, connect via WebSocket instead of polling:
WS ${baseUrl.replace('http', 'ws')}/api/sessions/:id/agent
The handshake must include the login cookie. Supports "execute" and "get_state" messages and pushes "state_change" and "output" events.

## Integration Endpoints
POST   /api/auth/login            — Login and set session cookie (public)
GET    /api/projects              — List accessible projects + tool access
POST   /api/projects              — Add a project (admin only)
DELETE /api/projects/:id          — Remove a project (owner/admin)
GET    /api/sessions              — List accessible sessions
POST   /api/sessions              — Create a permitted session
DELETE /api/sessions/:id          — Kill a session
GET    /api/sessions/:id/state    — Get session state
GET    /api/sessions/:id/display  — Rendered output + state (polling)
POST   /api/sessions/:id/execute  — Send input, get output
POST   /api/sessions/:id/cancel   — Cancel a pending execute wait (does not stop the CLI process)
GET    /api/agent/capabilities    — Agent control contract (self-describing)
GET    /api/context               — Concise session summary (low tokens)
WS     /api/sessions/:id/agent    — Real-time agent WebSocket
`;
}

function generateContextualGuide(baseUrl: string, projectName: string, projectPath: string, task?: string, additionalInstructions?: string, projectId?: string): string {
  const effectiveTask = task?.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE';
  // Build the full task string for the API call: task + additional instructions separated
  const fullTaskForApi = additionalInstructions
    ? `${effectiveTask}\n\n---\nAdditional Instructions:\n${additionalInstructions}`
    : effectiveTask;

  const instructionsSection = additionalInstructions
    ? `\n## Additional Instructions\n${additionalInstructions}\n`
    : '';

  const sessionRequest = {
    ...(projectId ? { project_id: projectId } : {}),
    project_path: projectPath,
    task: fullTaskForApi,
    mode: 'session',
    cli_type: 'claude',
  };

  return `# AgentManager Agent Command — ${projectName}

## Project Details
- **Project:** ${projectName}
- **Project ID:** ${projectId || 'Look up with GET /api/projects'}
- **Path:** ${projectPath}
- **Task:** ${effectiveTask}
- **Base URL:** ${baseUrl}
${instructionsSection}
## Authentication Prerequisite
All endpoints below require an agentmanager_session login cookie. Reuse a private, pre-provisioned cookie jar on every REST request and the WebSocket handshake. Never request or expose a password/cookie in chat. If no authenticated cookie is available or an endpoint returns HTTP 401, stop and ask the user to establish authentication.

## FIRST: Read Capabilities (after authentication)
GET ${baseUrl}/api/agent/capabilities

## Quick Start

1. Create a session for this project:
   POST ${baseUrl}/api/sessions
   Content-Type: application/json
   ${JSON.stringify(sessionRequest)}

2. Poll for output + state (single call, no side effects):
   GET ${baseUrl}/api/sessions/:id/display?lines=100
   Returns: { sessionId, processState, promptType, choices, output: "rendered text", cursor: 1234, truncated: false }

3. Poll incrementally — pass cursor from previous response to only get new content:
   GET ${baseUrl}/api/sessions/:id/display?lines=100&since=1234

4. Send input when the session needs it (processState is "idle" or "waiting_for_input"):
   POST ${baseUrl}/api/sessions/:id/execute
   Content-Type: application/json
   {"input": "your response or command", "timeout": 60000, "quiescenceMs": 5000}

5. Repeat steps 2-4 until the task is complete.

## Critical Rules
- Authenticate first, then read /api/agent/capabilities before creating or controlling sessions.
- The logged-in user must have session + Claude access to this project and may control only their own sessions (admins may control all).
- Use GET /api/sessions/:id/display for read-only monitoring — output + state in one call with cursor-based incremental polling.
- Use POST /api/sessions/:id/execute to send input and get the response.
- Send input only to answer a prompt or issue a command. Prefer explicit responses; input "" intentionally sends Enter and may accept a prompt default.
- NEVER read PTY output directly, scrape temp files, or parse raw terminal data.
- Check processState before sending input — if "busy", wait.
- When promptType is "choice", use the choices array to pick the right option number.
- Use timeout: 60000 and quiescenceMs: 5000 for interactive coding sessions.

## Reading Output (Display vs Execute)
GET /sessions/:id/display — Read-only. Returns the last N lines of rendered terminal text plus inline state. Use the cursor value for incremental polling. This is the RECOMMENDED way to monitor what a session is doing.
POST /sessions/:id/execute — Send input and get output. Only returns NEW output generated AFTER your input. Use this when you need to interact, not just observe.

## Integration Endpoints
POST   /api/auth/login            — Login and set session cookie (public)
GET    /api/projects              — List accessible projects + tool access
POST   /api/projects              — Add a project (admin only)
DELETE /api/projects/:id          — Remove a project (owner/admin)
GET    /api/sessions              — List accessible sessions
POST   /api/sessions              — Create a permitted session
DELETE /api/sessions/:id          — Kill a session
GET    /api/sessions/:id/state    — Get session state
GET    /api/sessions/:id/display  — Rendered output + state (polling)
POST   /api/sessions/:id/execute  — Send input, get output
POST   /api/sessions/:id/cancel   — Cancel a pending execute wait (does not stop the CLI process)
GET    /api/agent/capabilities    — Agent control contract (self-describing)
GET    /api/context               — Concise session summary (low tokens)
WS     /api/sessions/:id/agent    — Real-time agent WebSocket
`;
}

function EndpointRow({ method, path, desc }: { method: string; path: string; desc: string }) {
  const methodColor = method === 'POST' ? 'var(--success)' :
    method === 'DELETE' ? 'var(--error)' :
    method === 'WS' ? 'var(--accent)' : 'var(--text-secondary)';

  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-12 text-right font-bold shrink-0" style={{ color: methodColor }}>{method}</span>
      <span style={{ color: 'var(--text-primary)' }}>{path}</span>
      <span className="text-[10px] ml-auto" style={{ color: 'var(--text-secondary)' }}>{desc}</span>
    </div>
  );
}
