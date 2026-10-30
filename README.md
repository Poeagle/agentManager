# AgentManager

A self-hosted web dashboard for running and managing AI coding sessions with
**Claude Code** and **OpenAI Codex**. Launch AI sessions and interactive
terminals, watch their output stream live, and review and commit the changes
with built-in git — all from one place, with sessions that survive restarts.

## What it is

A single web UI on top of the Claude Code and Codex CLIs. It runs the CLIs for
you as persistent terminal sessions on the host machine, streams their output in
real time, and adds project management, git, a file explorer, and multi-user
access around them.

Key features:

- **AI coding sessions** — Launch Claude or Codex Sessions per project.
- **Persistent terminals** — Full terminals backed by tmux, managed directly
  in the browser. Sessions survive server restarts and reboots with full scrollback.
- **Git & files** — Side-by-side diffs, staged/unstaged changes, commit history,
  and a file explorer to review and commit what the agents changed.
- **Multi-user** — Username/password login with project/session access controls;
  each user sees only assigned projects and sessions.
- **Skills** — Browse and edit `SKILL.md`-format skills for Claude Code and Codex
  from a built-in Skills page.
- **Dual CLI** — Use Claude Code or Codex per session, each with its own command,
  icon, and settings.

## Why

Running AI coding agents in raw terminals means output you can't get back, dead
sessions when you disconnect, and no shared view across projects. AgentManager
keeps every session alive with tmux, streams it live, and puts projects, git,
files, and agents behind one UI you can reach from any browser on your network —
shared across a team if you want.

## How it works

AgentManager is a thin orchestration layer over the Claude Code and Codex CLIs:

- The **Fastify** server spawns each session as a local PTY inside tmux/dtach and
  streams it to the **React** dashboard over WebSocket. State lives in **SQLite**.
- The CLIs run **locally** on the machine hosting the server; the actual model
  inference happens in Anthropic's / OpenAI's cloud (the CLIs are API clients).
- Claude Code uses `CLAUDE.md` and Codex uses `AGENTS.md` for per-project
  instructions.

## Requirements

- **Node.js 20+**
- **Claude Code** — `npm install -g @anthropic-ai/claude-code`, then run `claude`
  once to sign in and accept the terms.
- **OpenAI Codex** *(optional)* — `npm install -g @openai/codex`
- **tmux** — for session persistence: `sudo apt install tmux`

### File and document previews

The project explorer supports PDF, Word (`doc`, `docx`, `odt`, `rtf`),
spreadsheets (`xls`, `xlsx`, `ods`, `csv`, `tsv`), presentations (`ppt`, `pptx`,
`odp`), draw.io (`drawio` and diagram XML), common images (PNG, JPEG, GIF,
WebP, SVG, BMP, ICO, AVIF), Markdown and UTF-8/UTF-16 text.
Documents are read-only; original files remain available for download.
Image previews offer zoom buttons, 100% original size and fit-to-window.
Use Ctrl/Command + mouse wheel to zoom around the pointer, double-click to
toggle original size and fit, and scroll to inspect enlarged details.
Text wraps visually without rewriting file contents. Spreadsheet previews use
sheet selection, row/column labels and multiline cells; display is limited to
100 sheets, 1000 rows and 100 columns per sheet.
Git diffs and file comparisons wrap long lines automatically. Paired rows
share their height and vertical scroll position, including the merge controls;
line numbers still refer to the original file lines.

The file explorer supports name and modification-time sorting (newest/oldest),
and remembers the choice per explorer. Refresh reloads the directory, expanded
subdirectories and the current clean file while retaining unsaved edits.
Drag local files or folders onto a directory or into the current path to upload;
folder hierarchy and empty directories are retained. Upload buttons provide the
same actions without dragging. Existing files are never overwritten silently;
progress and per-file failures are displayed. Individual files are limited to
50 MB; a folder drop accepts up to 5000 entries and 64 directory levels.

Office preview on the Linux server requires these optional system components:

```bash
sudo apt install libreoffice-writer libreoffice-calc libreoffice-impress bubblewrap util-linux fonts-noto-cjk
```

Conversion uses an isolated temporary profile and filesystem, no network,
untrusted macros disabled, a 30-second timeout and at most two concurrent
converters. Unprivileged user namespaces must be available for bubblewrap;
there is no unsandboxed fallback. Missing components produce a clear message.
Server fonts determine Office conversion fidelity; install CJK fonts for Chinese
documents to avoid missing glyphs, and the original fonts when exact layout matters.
PDF/image preview does not require LibreOffice; PDF rendering uses the browser's
built-in viewer. The bundled [draw.io viewer](dashboard/src/vendor/drawio/README.md)
runs offline in a sandboxed iframe; remote images, fonts and math resources are
not fetched. Limits: 20 MB Office, 50 MB PDF/image and 5 MB text/diagram files.

### Scheduled task conditions

Scheduled tasks use a compact project-level table. Select a task name to open
its settings, complete prompt, runtime status and recent execution records.
The editor is ordered as configuration, prompt, then an execution-record table.
Start and daily-stop conditions support nested AND/OR groups, including time
ranges, weekday/weekend (Mon–Fri/Sat–Sun, not a holiday calendar), and existing
target idle state. Daily-stop groups also support Codex quota and daily send
counts. A matched daily-stop group pauses sending for the rest of that local
day; the task stays enabled and conditions are checked again the next day.
At a scheduled occurrence, unmet or unknown conditions skip that occurrence;
becoming idle later does not backfill it. Fixed intervals remain anchored to
planned occurrences rather than scheduler tick latency. The record table
distinguishes successful prompt dispatch, failure and skipped checks; success
means the prompt was sent, not that the Agent's work completed.
Existing legacy daily windows remain compatible. Optional permanent cutoff
limits are kept separate from daily pauses.

## Run from source

```bash
git clone https://github.com/Poeagle/agentManager.git
cd agentManager

# build
cd server && npm install && npm run build && cd ..
cd dashboard && npm install && npm run build && cd ..

# start (dashboard + API on http://localhost:42010)
cd server && npm start
```

Open http://localhost:42010 — on first launch you'll be asked to create the admin
account. Add a project folder, then launch sessions from the project card.

### Dev mode (hot reload)

```bash
npm run dev                  # server :42010 + dashboard with hot reload
bash scripts/dev-isolated.sh # or an isolated instance on separate ports + db
```

The API is loopback-only by default. Vite's development UI listens on all
interfaces, but remote browsers cannot use the API unless you explicitly set
`AGENTMANAGER_ALLOW_LAN=true` (and protect the host with a firewall or reverse
proxy). The isolated command uses the same dashboard port by default.

### Platform AI and external channels

The optional platform AI can answer project/status questions, dispatch work to
Codex or Claude without a browser, manage scheduled tasks, and monitor each
work session before sending progress notifications. Configure its model,
WeCom/QQ/WeChat public-account/Webhook channels and external user bindings in
**平台 AI**. It is disabled by default.

Use `npm run dev:platform-ai` in a feature worktree for separate database,
ports and terminal resources. See [platform AI setup and architecture](docs/platform-ai.md)
for channel requirements, task completion evidence and recovery semantics.

### Session recovery and quota polling

Server startup reconnects surviving tmux/dtach sessions. Sessions whose processes
have exited retain their history and native conversation IDs; use **Resume** in
the dashboard to start them again. Restoring browser tabs does not start AI CLIs.

Codex tab activity and status use the exact bound native rollout conversation.
Native task, message and tool events advance its activity clock; terminal redraws,
tab changes and reconnects do not. Status distinguishes running, waiting for input,
turn ended, interrupted and unknown. A finished turn is not proof of business task
completion. Missing native logs or an unconfirmed running Codex process show an
unknown state instead of inferring activity from the terminal. Visible dashboards
refresh native status approximately every five seconds.

Codex sessions launched by AgentManager use `--disable plugins`.
Plugin-provided skills, MCP integrations and hooks are unavailable in these
sessions. Existing processes keep their original settings until restarted;
standalone Codex and VS Code are unaffected.

The quota indicator refreshes every five minutes while visible and shares a
five-minute server cache across browsers. Manual refresh uses the same dedicated
Codex reader. That reader disables plugins, apps and analytics, and backs off
on failure while displaying the last successful quota as stale.

## Testing

The repository includes isolated server and dashboard tests, coverage gates,
and Playwright browser tests. The E2E runner uses a repository-local test HOME
and SQLite database, so it cannot touch normal AgentManager sessions.

```bash
npm test              # unit + integration
npm run test:coverage # enforced coverage
npm run test:e2e      # Chromium
npm run test:all      # coverage + build + E2E
```

See [docs/testing.md](docs/testing.md) for architecture and authoring guidance.

## Configuration

Optional — copy `server/.env.example` to `server/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `42010` | Server port |
| `HOST` | `127.0.0.1` | Explicit listen address (overrides `AGENTMANAGER_ALLOW_LAN`) |
| `AGENTMANAGER_ALLOW_LAN` | `false` | Listen on all interfaces when `true` |
| `AGENTMANAGER_DB_PATH` | `~/.agentmanager/agentmanager.db` | SQLite database path |
| `AGENTMANAGER_HTTPS` | `false` | Mark login cookies `Secure`; enable behind HTTPS only |
| `AGENTMANAGER_HOOK_SECRET` | generated | Master secret used to authenticate project event hooks |
| `AGENTMANAGER_ALLOW_LEGACY_LOCAL_HOOKS` | `true` | Temporarily accept secretless hooks from loopback; set `false` after reinstalling hooks |
| `LOG_LEVEL` | `info` | Log verbosity (`trace`/`debug`/`info`/`warn`/`error`) |
| `AGENTMANAGER_USE_TMUX` | `true` | Use tmux for session persistence |
| `AGENTMANAGER_USE_DTACH` | `true` | Use dtach for detach/reattach |

Changing project access or registering a new project stops existing member
sessions so the operating-system sandbox can be rebuilt with the new policy.

Users with platform settings write permission can enable **automatic idle-session cleanup** in **平台管理 → 平台设置 →
Server**. It is disabled by default; the initial memory threshold is **85%** and
the minimum idle time is **10 minutes**. Saved changes take effect without a
restart. A single server sampler collects CPU, memory and disk every five
seconds. The header, monitoring page and idle-session cleanup all consume the
same timestamped snapshot. Samples are pushed to the dashboard over WebSocket;
REST reads return the cached snapshot without triggering another collection.
Memory uses available memory, including reclaimable Linux caches.
At or above the threshold it closes the longest-idle eligible session, then
samples again on the next check before closing another. Input and output reset
the idle time. Busy sessions, pending API executions, starting sessions and
processes without live activity tracking are skipped. Final-screen snapshots
and session records are retained for history and manual Resume.

### Platform management and roles

Project lists show **所属用户** alongside the project name, path, Git status and
launch actions. User, role and monitoring lists use compact tables; monitoring
expands with **+** from users to projects and sessions.

Open **平台管理** in the header. Its navigation groups personal account settings,
users, roles, project authorization, monitoring, platform settings, and the
Agent API guide. Entries and actions follow the current user's role permissions;
the server checks the same permissions for every management request.

| Built-in role | Platform permissions |
|---------------|----------------------|
| 平台管理员 | All platform features and authorization management |
| 普通成员 | Read platform settings; inspect and use Agent API |

Only administrator and member roles are initialized. Create custom roles as needed.
In **角色与权限**, click the row’s **+** to inspect its permissions, or create a custom role and select each feature's access level:
none, read, write, or delete where supported. Write includes read; delete includes
write and read. In **用户管理**, select an account, check its roles, and save the
assignment. Multiple roles combine at the highest granted level. Changes take
effect on subsequent API requests and refresh connected dashboards. Built-in
roles are fixed, roles with members cannot be deleted, and the last active
administrator cannot be removed or disabled.

Platform roles control management features. **项目授权** separately controls which
projects an account may access. Each project has two authorization columns:
**Session**, with a multi-select of available clients (currently Claude and Codex),
and **Terminal**, with independent shell access.
Delegated monitoring access does not grant an interactive terminal on another
user's session. Existing administrator/member accounts and project creation
permissions migrate automatically. Legacy Agent sessions and scheduled targets
become Sessions, while native conversation identities and history are retained.
Previously assigned extra default roles become custom roles; unused ones are removed.

Ended session tabs show **恢复会话** and **关闭会话** in the center of the terminal.
Close releases session resources and removes the saved tab; a cleanup failure
keeps the tab open with a retryable error. Conversation history remains available
through the existing history views.

### Security model

AgentManager runs local developer tools under the host account. On Linux,
member terminals require a systemd sandbox and hide other registered projects,
AgentManager state, host credentials, and shared temporary sockets. This is a
defense-in-depth boundary for a trusted team, not a substitute for separate OS
users or containers against hostile tenants. Administrators run unsandboxed by
design; grant access only to people trusted with the host and its configured AI
CLI credentials.

## License

Apache 2.0 with Commons Clause — see [LICENSE](LICENSE).
