# AgentManager

A self-hosted web dashboard for running and managing AI coding sessions with
**Claude Code** and **OpenAI Codex**. Launch agent sessions and interactive
terminals, watch their output stream live, and review and commit the changes
with built-in git — all from one place, with sessions that survive restarts.

## What it is

A single web UI on top of the Claude Code and Codex CLIs. It runs the CLIs for
you as persistent terminal sessions on the host machine, streams their output in
real time, and adds project management, git, a file explorer, and multi-user
access around them.

Key features:

- **AI coding sessions** — Launch Claude Code or Codex sessions per project, or
  pick a built-in specialist agent (code review, debugging, security, testing,
  infra, and more) defined in `.claude/agents/*.md`.
- **Live monitoring** — An active-sessions grid streams every running session's
  output in real time over WebSocket.
- **Persistent terminals** — Full terminals backed by tmux. Pop a session out to
  your own terminal (`tmux attach`), work, then adopt it back. Sessions survive
  server restarts and reboots with full scrollback.
- **Git & files** — Side-by-side diffs, staged/unstaged changes, commit history,
  and a file explorer to review and commit what the agents changed.
- **Multi-user** — Username/password login with per-user content isolation; each
  user sees only their own projects and sessions.
- **Skills** — Browse and edit `SKILL.md`-format skills for Claude Code and Codex
  from a built-in Skills page.
- **In-app browser** — Open and test web pages alongside your sessions.
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

## Configuration

Optional — copy `.env.example` to `.env` in the project root:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `42010` | Server port |
| `DB_PATH` | `~/.agentmanager/agentmanager.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log verbosity (`trace`/`debug`/`info`/`warn`/`error`) |
| `AGENTMANAGER_USE_TMUX` | `true` | Use tmux for session persistence |
| `AGENTMANAGER_USE_DTACH` | `true` | Use dtach for detach/reattach |

## License

Apache 2.0 with Commons Clause — see [LICENSE](LICENSE).
