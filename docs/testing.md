# Testing

AgentManager uses three isolated test layers. None of them reads or writes the
normal `~/.agentmanager` or `~/.agentmanager-dev` databases.

## Commands

```bash
npm test                 # server + dashboard unit/integration tests
npm run test:coverage    # same tests with enforced coverage thresholds
npm run test:e2e         # Chromium end-to-end tests
npm run test:all         # coverage + production builds + E2E
npm run test:regression:conversation  # targeted Claude and Codex conversation regressions
```

Use `npm --prefix server run test:watch` or
`npm --prefix dashboard run test:watch` while developing one package.

Coverage reports include the full production TypeScript source (apart from
generated agent data and the browser entrypoint), including currently untested
files. The enforced percentages are repository-wide regression floors, not a
claim that only a hand-picked subset has high coverage.

The first local E2E run may require:

```bash
npx playwright install chromium
```

## Layers

- `server/tests`: Vitest unit and Fastify route integration tests. Each suite
  creates a unique SQLite database under the OS temporary directory and closes
  it after the test.
- `dashboard/tests`: Vitest + jsdom + Testing Library tests for UI behavior,
  API payloads, themes and keyboard interaction.
- `e2e`: Playwright runs the real Fastify and Vite applications against
  `.test-data/e2e`. The runner supplies a fake HOME, disables tmux/dtach, uses
  ports 43110/43111, and deletes only that test directory before startup. Uploaded attachments use a separate, temporary directory outside the repository, which the runner removes on shutdown.

## Session recovery coverage

The initial critical suite verifies:

- Claude/Codex process recognition and native UUID parsing;
- rejection of ambiguous Claude log matches and Codex rollout identities;
- SQLite migration and durable app-session to native-conversation storage;
- authenticated, per-user tab state persistence;
- automatic-resume API payloads and circuit-breaker signaling;
- full browser restoration of project and terminal tabs after localStorage is
  cleared twice.

Tests that require real Claude/OpenAI credentials are intentionally excluded
from CI. Runtime CLI behavior is represented by deterministic identity fixtures;
credentialed smoke tests remain an optional manual pre-release check.

## Adding tests

Keep tests deterministic and isolated. Never point a test at a developer DB,
reuse the production ports, or depend on an installed/authenticated AI CLI.
Bug fixes should add a regression test at the lowest useful layer, plus an E2E
case only when the behavior crosses server/browser boundaries.

E2E accepts `E2E_API_PORT` / `E2E_UI_PORT` overrides. Its Vite optimizer cache is
kept under the worktree's `dashboard/.test-data/node_modules/`, separated by UI
port. This also isolates worktrees that share dependency directories by symlink;
sharing their optimizer cache can load two React runtimes in lazy editors.
On loaded hosts, `npm --prefix dashboard run test:coverage -- --maxWorkers=2`
limits concurrency while running the complete component suite and thresholds.

## WeCom outbound screenshot coverage

`platform-ai-outbound-images.test.ts` uses temporary project/report files to cover local Markdown links, code examples, file permissions, private-resource denial, symlink escapes, bounded reads, type checks, count limits and content fingerprints. `platform-ai-wecom.test.ts` connects the official SDK to a local WebSocket peer and validates upload init/chunk/finish bytes, text-before-image ordering, worker recovery, media reuse/expiry, partial failures, and permission/binding revocation before send. All test files, sockets, sessions and databases are isolated and released. Real-account sends remain a separately authorized manual smoke test; fixture coverage does not claim real-client rendering.
