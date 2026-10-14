// Increase libuv thread pool for async execFile / fs operations
process.env.UV_THREADPOOL_SIZE = '16';

// Enrich PATH for desktop-launched environments (task manager, dock, app menu).
// Interactive shells load nvm/fnm/volta via .bashrc/.zshrc, but desktop-launched
// processes inherit the bare session environment which typically lacks these.
import { enrichProcessPath } from './utils/enrich-path.js';
enrichProcessPath();

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { closeDb, initDb, getDb } from './db/index.js';
import { eventRoutes } from './routes/events.js';
import { sessionRoutes } from './routes/sessions.js';
import { taskRoutes } from './routes/tasks.js';
import { streamRoutes } from './routes/stream.js';
import { projectRoutes, initProjects } from './routes/projects.js';
import { terminalRoutes } from './routes/terminal.js';
import { fileRoutes } from './routes/files.js';
import { gitRoutes } from './routes/git.js';
import { agentRoutes } from './routes/agent.js';
import { settingsRoutes } from './routes/settings.js';
import { promptEnhancerRoutes } from './routes/prompt-enhancer.js';
import { skillsRoutes } from './routes/skills.js';
import { userStateRoutes } from './routes/user-state.js';
import { scheduledTaskRoutes } from './routes/scheduled-tasks.js';
import { startScheduledTaskScheduler, stopScheduledTaskScheduler } from './services/scheduled-task-runner.js';
import { memorySessionReaper } from './services/memory-session-reaper.js';
import { serverResourceSampler } from './services/server-resources.js';
import { sweepAllPastes } from './services/paste-cleanup.js';
import {
  killAllSessions,
  cleanupStaleRunningSessions,
  autoReconnectDetachedSessions,
  flushPendingPtyOutputWithRetry,
  getReconnectStatus,
  startPendingSessionWatchdog,
} from './services/session-manager.js';
import { shutdownCodexQuotaReader } from './services/codex-quota.js';
import { config } from './config.js';
import { authHook, isAdmin as isAdminUser } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { rbacRoutes } from './routes/rbac.js';
import { appendFile, writeFile } from 'fs/promises';
const timingLogPath = process.env.AGENTMANAGER_TIMING_LOG;
const tlog = (message: string) => {
  if (!timingLogPath) return;
  void appendFile(timingLogPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {});
};

const __dirname = dirname(fileURLToPath(import.meta.url));
let server: FastifyInstance | null = null;
let shuttingDown = false;

// Event loop lag detector — logs when the event loop is blocked for >100ms
let _lagLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - _lagLast - 50; // expected 50ms interval
  _lagLast = now;
  if (lag > 100) {
    tlog(`[LAG] Event loop blocked for ${lag}ms`);
  }
}, 50).unref();

async function start() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  });
  server = app;

  if (timingLogPath) await writeFile(timingLogPath, '').catch(() => {});

  // Initialize database, load projects from user config, and clean up orphaned sessions
  let t = Date.now();
  initDb();
  tlog(`[STARTUP] initDb: ${Date.now() - t}ms`);

  // Override port from settings DB if not set via env var
  if (!process.env.PORT) {
    try {
      const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('server_port') as { value: string } | undefined;
      if (row?.value) {
        const parsed = parseInt(row.value, 10);
        if (parsed > 0 && parsed < 65536) config.port = parsed;
      }
    } catch {}
  }

  t = Date.now();
  await initProjects();
  tlog(`[STARTUP] initProjects: ${Date.now() - t}ms`);
  t = Date.now();
  await cleanupStaleRunningSessions();
  tlog(`[STARTUP] cleanupStale: ${Date.now() - t}ms`);
  sweepAllPastes();
  setInterval(sweepAllPastes, 12 * 60 * 60 * 1000).unref();
  // Auto-reconnect detached sessions in background — don't block server startup.
  // Sessions become available as their workers connect.
  autoReconnectDetachedSessions().catch((err) => {
    console.error('Auto-reconnect failed:', err);
  });
  // Watchdog: auto-fail sessions stuck in "pending" for >90s (e.g. browser closed
  // before WebSocket connected, or spawn command hangs on registry check/npm install)
  startPendingSessionWatchdog();
  startScheduledTaskScheduler();
  serverResourceSampler.start();
  memorySessionReaper.start();

  // Plugins
  await app.register(cors, {
    origin: config.isDev ? true : false,
  });
  await app.register(fastifyWebsocket);

  // Auth: gate every /api/* behind login (public allowlist lives in authHook).
  app.addHook('onRequest', authHook);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(rbacRoutes, { prefix: '/api' });

  // REST API routes
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(streamRoutes, { prefix: '/api' });
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(terminalRoutes, { prefix: '/api' });
  await app.register(fileRoutes, { prefix: '/api' });
  await app.register(gitRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(promptEnhancerRoutes, { prefix: '/api' });
  await app.register(skillsRoutes, { prefix: '/api' });
  await app.register(userStateRoutes, { prefix: '/api' });
  await app.register(scheduledTaskRoutes, { prefix: '/api' });

  // Version check via GitHub releases — used by dashboard and desktop app
  // Supports ?channel=stable|beta|alpha query param (default: stable)
  // - stable: prefer newest non-prerelease; fall back to newest prerelease if no stable exists
  // - beta: newest prerelease
  // - alpha: newest release of any kind
  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ai-genius-automations/agentmanager/releases?per_page=20';
  const _versionCache = new Map<string, { version: string; name: string; url: string; prerelease: boolean; checkedAt: number }>();

  interface GitHubRelease {
    tag_name?: string;
    name?: string;
    html_url?: string;
    prerelease?: boolean;
    draft?: boolean;
  }

  app.get('/api/version-check', async (req, reply) => {
    const requestedChannel = (req.query as Record<string, string>).channel || 'stable';
    if (!['stable', 'beta', 'canary'].includes(requestedChannel)) {
      return reply.code(400).send({ error: 'channel must be stable, beta, or canary' });
    }
    const channel = requestedChannel;
    try {
      const now = Date.now();
      const cached = _versionCache.get(channel);
      if (cached && (now - cached.checkedAt) < 300_000) {
        return { current: serverVersion, latest: cached.version, name: cached.name, url: cached.url, prerelease: cached.prerelease, channel, updateAvailable: cached.version !== '' && cached.version !== serverVersion };
      }

      const resp = await fetch(GITHUB_RELEASES_URL, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'AgentManager' },
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        const fallback = cached;
        return {
          current: serverVersion,
          latest: fallback?.version || '',
          name: fallback?.name || '',
          url: fallback?.url || '',
          prerelease: fallback?.prerelease || false,
          channel,
          updateAvailable: !!fallback?.version && fallback.version !== serverVersion,
          unavailable: true,
        };
      }

      const releases = (await resp.json() as GitHubRelease[]).filter(r => !r.draft);

      let pick: GitHubRelease | undefined;
      if (channel === 'stable') {
        // Prefer first non-prerelease; fall back to newest prerelease if no stable exists
        pick = releases.find(r => !r.prerelease) || releases[0];
      } else if (channel === 'beta') {
        pick = releases.find(r => r.prerelease) || releases[0];
      } else {
        // alpha/canary — newest of any kind
        pick = releases[0];
      }

      const latestVersion = (pick?.tag_name || '').replace(/^v/, '');
      const entry = { version: latestVersion, name: pick?.name || '', url: pick?.html_url || '', prerelease: pick?.prerelease || false, checkedAt: now };
      _versionCache.set(channel, entry);

      return {
        current: serverVersion,
        latest: latestVersion,
        name: entry.name,
        url: entry.url,
        prerelease: entry.prerelease,
        channel,
        updateAvailable: latestVersion !== '' && latestVersion !== serverVersion,
      };
    } catch {
      const fallback = _versionCache.get(channel);
      return {
        current: serverVersion,
        latest: fallback?.version || '',
        name: fallback?.name || '',
        url: fallback?.url || '',
        prerelease: fallback?.prerelease || false,
        channel,
        updateAvailable: !!fallback?.version && fallback.version !== serverVersion,
        unavailable: true,
      };
    }
  });

  // Return the update command — the dashboard handles copy-to-clipboard.
  app.get('/api/update-command', async () => {
    return {
      command: 'npx -y agentmanager@latest',
    };
  });

  // Health check — read version from package.json
  let serverVersion = '0.0.0';
  try {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
    serverVersion = pkg.version || '0.0.0';
  } catch {}

  app.get('/api/health', { logLevel: 'silent' }, async () => {
    const reconnect = getReconnectStatus();
    return {
      name: 'agentmanager',
      version: serverVersion,
      status: 'running',
      uptime: process.uptime(),
      reconnecting: reconnect.reconnecting,
      reconnectTotal: reconnect.total,
      reconnectDone: reconnect.done,
    };
  });

  // Restart server — exits the process so the parent (CLI/systemd/Electron) can relaunch
  app.post('/api/restart', async (req, reply) => {
    if (!isAdminUser(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    setTimeout(() => { void shutdown(0); }, 500);
    return { ok: true, message: 'Server restarting...' };
  });

  // Network info — returns local IP addresses for the settings UI hint
  app.get('/api/network-info', async () => {
    const { networkInterfaces } = await import('os');
    const nets = networkInterfaces();
    const addresses: string[] = [];
    for (const iface of Object.values(nets)) {
      if (!iface) continue;
      for (const net of iface) {
        if (!net.internal && net.family === 'IPv4') {
          addresses.push(net.address);
        }
      }
    }
    return { addresses, port: config.port };
  });

  // Serve dashboard in production
  if (!config.isDev) {
    const dashboardPath = resolve(__dirname, '../../dashboard/dist');
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
      cacheControl: false,
    });

    // No-cache for index.html so Electron always picks up new builds
    app.addHook('onSend', async (_req, reply, payload) => {
      const ct = reply.getHeader('content-type');
      if (typeof ct === 'string' && ct.includes('text/html')) {
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      return payload;
    });

    // SPA fallback
    app.setNotFoundHandler(async (_req, reply) => {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.sendFile('index.html');
    });
  }

  // Start
  t = Date.now();
  await app.listen({ port: config.port, host: config.host });
  tlog(`[STARTUP] listen: ${Date.now() - t}ms`);
  tlog(`[STARTUP] server ready, accepting connections`);
  console.log(`\n🌊 AgentManager running at http://localhost:${config.port}`);
  console.log(`   API: http://localhost:${config.port}/api`);
  if (config.isDev) {
    console.log(`   Dashboard: http://localhost:42011 (Vite dev server)`);
  }
}

start().catch((err) => {
  console.error('Failed to start AgentManager:', err);
  void shutdown(1);
});

// Graceful shutdown: stop accepting work, persist output, detach workers,
// checkpoint, and close the database. Cleanup steps are isolated so one failure
// cannot skip the remaining steps.
async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n🌊 Shutting down AgentManager...');
  const forceExit = setTimeout(() => process.exit(exitCode || 1), 5000);
  forceExit.unref();
  const recordFailure = (step: string, error: unknown) => {
    console.error(`Shutdown ${step} failed:`, error);
    exitCode ||= 1;
  };

  // Start closing listeners first, then tear down the long-lived terminal
  // workers that may otherwise keep WebSocket requests open.
  const closeServer = server?.close().catch((error) => recordFailure('server close', error));
  try { await memorySessionReaper.stop(); } catch (error) { recordFailure('memory cleanup stop', error); }
  try { await serverResourceSampler.stop(); } catch (error) { recordFailure('resource sampler stop', error); }
  try {
    if (!(await flushPendingPtyOutputWithRetry())) {
      recordFailure('PTY flush', new Error('queued terminal output could not be persisted after retries'));
    }
  } catch (error) { recordFailure('PTY flush', error); }
  try { stopScheduledTaskScheduler(); } catch (error) { recordFailure('scheduler stop', error); }
  try { killAllSessions(); } catch (error) { recordFailure('session detach', error); }
  try { shutdownCodexQuotaReader(); } catch (error) { recordFailure('quota reader stop', error); }
  if (closeServer) await closeServer;
  try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch (error) { recordFailure('database checkpoint', error); }
  try { closeDb(); } catch (error) { recordFailure('database close', error); }

  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — cleaning up sessions:', err);
  void shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection — cleaning up sessions:', reason);
  void shutdown(1);
});
