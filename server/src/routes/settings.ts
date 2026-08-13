import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { isAdmin } from '../auth.js';
import { withAllPermissions, type CliType } from '../services/cli-command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default values for all settings */
const DEFAULTS: Record<string, string> = {
  session_claude_command: 'claude --dangerously-skip-permissions',
  session_codex_command: 'codex --dangerously-bypass-approvals-and-sandbox',
  agent_claude_command: 'claude --dangerously-skip-permissions',
  agent_codex_command: 'codex --dangerously-bypass-approvals-and-sandbox',
  terminal_font_size: '12',
  app_font_size: '16',
  app_theme: 'midnight',           // UI theme id (see dashboard/src/lib/themes.ts)
  server_port: '42010',
  statusline_prompted: 'false',    // whether we've asked the user about statusline install
};

const COMMAND_TYPES: Record<string, CliType> = {
  session_claude_command: 'claude',
  session_codex_command: 'codex',
  agent_claude_command: 'claude',
  agent_codex_command: 'codex',
};

export function effectiveSettings(rows: { key: string; value: string }[]): Record<string, string> {
  const settings: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) settings[row.key] = row.value;
  for (const [key, cliType] of Object.entries(COMMAND_TYPES)) {
    settings[key] = withAllPermissions(settings[key] || cliType, cliType);
  }
  return settings;
}

export function getSetting(key: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? '';
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // Get all settings
  app.get('/settings', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return { settings: effectiveSettings(rows) };
  });

  // Update settings
  app.put<{
    Body: { settings: Record<string, string> };
  }>('/settings', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Settings are read-only for members' });
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return reply.status(400).send({ error: 'settings object is required' });
    }

    const db = getDb();
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    const allowed = new Set(Object.keys(DEFAULTS));
    for (const [key, value] of Object.entries(settings)) {
      if (!allowed.has(key)) continue;
      const stringValue = String(value);
      upsert.run(key, COMMAND_TYPES[key] ? withAllPermissions(stringValue, COMMAND_TYPES[key]) : stringValue);
    }

    // Return current state
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return { ok: true, settings: effectiveSettings(rows) };
  });

  const STATUSLINE_SCRIPT = 'agentmanager-statusline.sh';
  const STATUSLINE_MARKER = '// agentmanager-managed-statusline';

  function getGlobalSettingsPath(): string {
    return join(homedir(), '.claude', 'settings.json');
  }

  function getStatuslineScriptPath(): string {
    return join(homedir(), '.claude', STATUSLINE_SCRIPT);
  }

  function readGlobalSettings(): Record<string, any> {
    const p = getGlobalSettingsPath();
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
  }

  function writeGlobalSettings(settings: Record<string, any>): void {
    const p = getGlobalSettingsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  // Check if AgentManager statusline is installed
  app.get('/settings/statusline', async () => {
    const settings = readGlobalSettings();
    const scriptPath = getStatuslineScriptPath();
    const installed = !!(
      settings.statusLine?.command?.includes(STATUSLINE_SCRIPT) &&
      existsSync(scriptPath)
    );
    return { installed };
  });

  // Install AgentManager statusline to global ~/.claude/settings.json
  app.post('/settings/statusline/install', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    const scriptDest = getStatuslineScriptPath();
    const scriptSrc = join(__dirname, '..', 'data', 'statusline.sh');

    // Copy script
    mkdirSync(dirname(scriptDest), { recursive: true });
    writeFileSync(scriptDest, readFileSync(scriptSrc, 'utf-8'), { mode: 0o755 });

    // Update global settings.json
    const settings = readGlobalSettings();
    settings.statusLine = {
      type: 'command',
      command: scriptDest,
      _comment: STATUSLINE_MARKER,
    };
    writeGlobalSettings(settings);

    return { ok: true, scriptPath: scriptDest };
  });

  // Uninstall AgentManager statusline from global ~/.claude/settings.json
  app.post('/settings/statusline/uninstall', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    const scriptPath = getStatuslineScriptPath();
    const removed: string[] = [];

    // Remove script file
    if (existsSync(scriptPath)) {
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(scriptPath);
        removed.push('removed script');
      } catch { /* non-fatal */ }
    }

    // Remove statusLine from global settings
    const settings = readGlobalSettings();
    if (settings.statusLine) {
      delete settings.statusLine;
      writeGlobalSettings(settings);
      removed.push('removed statusLine config');
    }

    return { ok: true, removed };
  });
};
