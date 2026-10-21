import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { z } from 'zod';
import { config as serverConfig } from '../../config.js';
import { getDb } from '../../db/index.js';

const configSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().trim().max(2048).default(''),
  model: z.string().trim().max(160).default(''),
  api_key: z.string().max(4096).optional(),
  clear_api_key: z.boolean().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).default(45000),
  max_tool_rounds: z.number().int().min(1).max(16).default(8),
  observation_interval_seconds: z.number().int().min(5).max(300).default(15),
  assessment_interval_seconds: z.number().int().min(30).max(1800).default(90),
  notification_interval_seconds: z.number().int().min(60).max(3600).default(300),
}).strict();

export type AiConfig = Omit<z.infer<typeof configSchema>, 'clear_api_key'> & { api_key: string };

function keyPath(): string { return join(dirname(serverConfig.dbPath), '.platform-ai.key'); }

function encryptionKey(): Buffer {
  let key: Buffer;
  try { key = readFileSync(keyPath()); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    const hasSecrets = getDb().prepare(`SELECT 1 FROM platform_ai_channels WHERE secrets != ''
      UNION ALL SELECT 1 FROM platform_ai_attachments WHERE source != ''
      UNION ALL SELECT 1 FROM settings WHERE key = 'platform_ai_api_key' AND value != '' LIMIT 1`).get();
    if (hasSecrets) throw new Error('Platform AI encryption key is missing; restore the key beside the database');
    key = randomBytes(32);
    try { writeFileSync(keyPath(), key, { flag: 'wx', mode: 0o600 }); }
    catch (writeError: any) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      key = readFileSync(keyPath());
    }
  }
  if (key.length !== 32) throw new Error('Invalid platform AI encryption key');
  return key;
}

export function sealSecret(value: string, purpose: string): string {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openSecret(value: string, purpose: string): string {
  if (!value) return '';
  const data = Buffer.from(value, 'base64');
  if (data.length < 29) throw new Error('Invalid encrypted platform AI secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function validateHttpUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('URL must use HTTP(S) without credentials or a fragment');
  }
  return url.toString();
}

export function readAiConfig(): AiConfig {
  const rows = getDb().prepare("SELECT key,value FROM settings WHERE key IN ('platform_ai_config','platform_ai_api_key')").all() as Array<{key: string; value: string}>;
  const values = new Map(rows.map(row => [row.key, row.value]));
  const config = configSchema.parse(JSON.parse(values.get('platform_ai_config') || '{}'));
  return { ...config, api_key: openSecret(values.get('platform_ai_api_key') || '', 'model-api-key') };
}

export function safeAiConfig() {
  const { api_key, ...config } = readAiConfig();
  return { ...config, api_key_configured: !!api_key };
}

export function updateAiConfig(input: unknown) {
  const patch = configSchema.partial().parse(input);
  const previous = readAiConfig();
  const next = configSchema.parse({ ...previous, ...patch });
  if (next.endpoint) next.endpoint = validateHttpUrl(next.endpoint);
  const apiKey = patch.clear_api_key ? '' : patch.api_key || previous.api_key;
  if (next.enabled && (!next.endpoint || !next.model || !apiKey)) {
    throw new Error('启用平台 AI 前，请配置模型地址、模型名称和 API Key');
  }
  const { api_key: _key, clear_api_key: _clear, ...publicConfig } = next;
  const sealed = sealSecret(apiKey, 'model-api-key');
  getDb().transaction(() => {
    const upsert = getDb().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    upsert.run('platform_ai_config', JSON.stringify(publicConfig));
    upsert.run('platform_ai_api_key', sealed);
  })();
  return safeAiConfig();
}

/** Never persist upstream error bodies: providers may echo authorization data. */
export function publicFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Platform AI operation failed';
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}
