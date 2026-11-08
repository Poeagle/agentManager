import { getDb } from '../../db/index.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../../config.js';
import { shellSingleQuote } from './shell.js';

export interface StoredProvider {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  fields: Record<string, string | boolean | string[] | null>;
}

export interface StoredAgentManagement {
  defaults: Record<string, string | boolean | string[] | null>;
  providers: StoredProvider[];
}

const empty = (): StoredAgentManagement => ({ defaults: {}, providers: [] });
const key = (agentId: string) => `agent_management_${agentId}`;

function secretKeyPath(): string { return join(dirname(config.dbPath), '.agent-management.key'); }
function secretKey(): Buffer {
  try { const value = readFileSync(secretKeyPath()); if (value.length === 32) return value; }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const generated = randomBytes(32);
  mkdirSync(dirname(secretKeyPath()), { recursive: true, mode: 0o700 });
  try { writeFileSync(secretKeyPath(), generated, { flag: 'wx', mode: 0o600 }); return generated; }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readFileSync(secretKeyPath());
    if (existing.length !== 32) throw Error('Agent management encryption key is invalid');
    return existing;
  }
}

export function sealAgentSecret(value: string, purpose: string): string {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openAgentSecret(value: string, purpose: string): string {
  if (!value) return '';
  const data = Buffer.from(value, 'base64');
  if (data.length < 29) throw Error('Invalid encrypted Agent secret');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function readAgentManagement(agentId: string): StoredAgentManagement {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key(agentId)) as { value: string } | undefined;
    if (!row) return empty();
    const value = JSON.parse(row.value) as Partial<StoredAgentManagement>;
    return {
      defaults: value.defaults && typeof value.defaults === 'object' && !Array.isArray(value.defaults) ? value.defaults : {},
      providers: Array.isArray(value.providers) ? value.providers.filter(provider => provider && typeof provider.id === 'string') : [],
    };
  } catch {
    return empty();
  }
}

export function writeAgentManagement(agentId: string, value: StoredAgentManagement): void {
  getDb().prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key(agentId), JSON.stringify(value));
}

export function updateAgentManagement(
  agentId: string,
  mutate: (current: StoredAgentManagement) => StoredAgentManagement,
): StoredAgentManagement {
  const db = getDb();
  return db.transaction(() => {
    const next = mutate(readAgentManagement(agentId));
    writeAgentManagement(agentId, next);
    return next;
  })();
}

export function configuredAgentCommand(agentId: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(`session_${agentId}_command`) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Keep existing launch-command settings as the source of truth when present. */
export function managedLaunchCommand(agentId: string, fallback: string): string {
  const configured = configuredAgentCommand(agentId);
  if (configured?.trim()) return configured.trim();
  const stored = readAgentManagement(agentId).defaults.command;
  return typeof stored === 'string' && stored.trim() ? stored.trim() : fallback;
}

export function applyManagedCommandDefaults(agentId: string, command: string): string {
  const defaults = readAgentManagement(agentId).defaults;
  const model = typeof defaults.model === 'string' ? defaults.model.trim() : '';
  let result = command;
  if (model && !/(?:^|\s)(?:--model|-m)(?:\s|=)/.test(result)) {
    if (agentId === 'claude' || agentId === 'codex') result += ` --model ${shellSingleQuote(model)}`;
  }
  if (agentId === 'codex') {
    const effort = typeof defaults.effort === 'string' ? defaults.effort.trim() : '';
    if (effort && !/model_reasoning_effort/.test(result)) {
      result += ` -c ${shellSingleQuote(`model_reasoning_effort="${effort}"`)}`;
    }
  }
  return result;
}

export function managedModelPreference(agentId: string): { model: string; effort: string } | null {
  const defaults = readAgentManagement(agentId).defaults;
  const model = typeof defaults.model === 'string' ? defaults.model.trim() : '';
  if (!model) return null;
  return {
    model,
    effort: typeof defaults.effort === 'string' ? defaults.effort.trim() : '',
  };
}
