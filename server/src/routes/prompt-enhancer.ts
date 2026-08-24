import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { isAdmin } from '../auth.js';

export const PROMPT_ENHANCER_MODES = ['base', 'lite', 'standard', 'expert', 'publish'] as const;
export type PromptEnhancerMode = typeof PROMPT_ENHANCER_MODES[number];

const PREFIX = 'prompt_enhancer_';
const MAX_PROMPT_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

interface PromptEnhancerConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  mode: PromptEnhancerMode;
  timeout_ms: number;
  api_key: string;
}

const DEFAULT_CONFIG: PromptEnhancerConfig = {
  enabled: false,
  endpoint: '',
  model: '',
  mode: 'standard',
  timeout_ms: DEFAULT_TIMEOUT_MS,
  api_key: '',
};

function settingKey(key: keyof PromptEnhancerConfig) {
  return `${PREFIX}${key}`;
}

function readConfig(): PromptEnhancerConfig {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'prompt_enhancer_%'").all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const parsedTimeout = Number(values.get(settingKey('timeout_ms')));
  const rawMode = values.get(settingKey('mode'));
  return {
    enabled: values.get(settingKey('enabled')) === 'true',
    endpoint: values.get(settingKey('endpoint'))?.trim() || '',
    model: values.get(settingKey('model'))?.trim() || '',
    mode: PROMPT_ENHANCER_MODES.includes(rawMode as PromptEnhancerMode)
      ? rawMode as PromptEnhancerMode
      : DEFAULT_CONFIG.mode,
    timeout_ms: Number.isInteger(parsedTimeout) && parsedTimeout >= 1_000 && parsedTimeout <= MAX_TIMEOUT_MS
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MS,
    api_key: values.get(settingKey('api_key')) || '',
  };
}

function safeConfig(config: PromptEnhancerConfig) {
  return {
    enabled: config.enabled,
    endpoint: config.endpoint,
    model: config.model,
    mode: config.mode,
    timeout_ms: config.timeout_ms,
    api_key_configured: config.api_key.length > 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseEndpoint(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error('LLM URL must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('LLM URL must use http or https');
  }
  if (parsed.username || parsed.password) throw new Error('LLM URL must not contain credentials');
  return parsed;
}

/** Accept either a complete OpenAI-compatible endpoint or a base URL. */
function completionUrl(input: string): string {
  const parsed = parseEndpoint(input);
  if (!parsed.pathname.endsWith('/chat/completions')) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/chat/completions`;
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function modelsUrl(input: string): string {
  const parsed = parseEndpoint(input);
  if (parsed.pathname.endsWith('/chat/completions')) {
    parsed.pathname = parsed.pathname.replace(/\/chat\/completions$/, '/models');
  } else {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/models`;
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function requireReadyConfig(): PromptEnhancerConfig {
  const config = readConfig();
  if (!config.enabled) throw new Error('Prompt enhancement is disabled by the administrator');
  if (!config.endpoint || !config.model || !config.api_key) {
    throw new Error('Prompt enhancement is not configured');
  }
  completionUrl(config.endpoint);
  return config;
}

function modeInstructions(mode: PromptEnhancerMode): string {
  switch (mode) {
    case 'base':
      return 'Improve clarity while preserving the original intent and level of detail. Do not add assumptions.';
    case 'lite':
      return 'Rewrite the request to be concise, explicit, and easy for an AI coding assistant to follow. Preserve the user intent.';
    case 'expert':
      return 'Turn the request into a rigorous execution brief. State objective, relevant constraints, implementation expectations, and verification criteria. Do not invent facts.';
    case 'publish':
      return 'Turn the request into a complete, actionable development specification with scope, requirements, acceptance criteria, and non-goals. Do not invent product facts.';
    case 'standard':
    default:
      return 'Rewrite the request into a structured, actionable prompt. Clarify the goal, constraints, expected output, and verification where the source provides enough information. Do not invent facts.';
  }
}

function buildMessages(prompt: string, mode: PromptEnhancerMode) {
  return [
    {
      role: 'system',
      content: [
        'You are a prompt editor for a software development workspace.',
        modeInstructions(mode),
        'Return only the enhanced prompt. Do not add explanations, headings about your own work, or markdown fences.',
        'Keep the original language unless the user explicitly asks to change it.',
      ].join(' '),
    },
    { role: 'user', content: prompt },
  ];
}

async function callModel(config: PromptEnhancerConfig, prompt: string, mode: PromptEnhancerMode): Promise<string> {
  const response = await fetch(completionUrl(config.endpoint), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: buildMessages(prompt, mode),
      temperature: 0.2,
      max_tokens: 4_000,
    }),
    signal: AbortSignal.timeout(config.timeout_ms),
  });

  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.slice(0, 300).replace(/\s+/g, ' ').trim();
    throw new Error(`LLM request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('LLM returned invalid JSON');
  }
  const content = isRecord(payload)
    && Array.isArray(payload.choices)
    && isRecord(payload.choices[0])
    && isRecord(payload.choices[0].message)
    && typeof payload.choices[0].message.content === 'string'
    ? payload.choices[0].message.content.trim()
    : '';
  if (!content) throw new Error('LLM returned an empty enhancement');
  if (content.length > MAX_PROMPT_CHARS) throw new Error('LLM enhancement is too large');
  return content;
}

async function discoverModels(endpoint: string, apiKey: string): Promise<string[]> {
  if (!endpoint || !apiKey) throw new Error('LLM URL and API Key must be configured before detecting models');
  const response = await fetch(modelsUrl(endpoint), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.slice(0, 300).replace(/\s+/g, ' ').trim();
    throw new Error(`Model discovery failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Model endpoint returned invalid JSON');
  }
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
  if (!data) throw new Error('Model endpoint did not return an OpenAI-compatible data list');
  const models = data
    .filter(isRecord)
    .map((item) => typeof item.id === 'string' ? item.id.trim() : '')
    .filter(Boolean)
    .filter((model, index, items) => items.indexOf(model) === index)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 200);
  if (!models.length) throw new Error('No selectable models were returned');
  return models;
}

function updateConfig(input: Record<string, unknown>) {
  const current = readConfig();
  const next = { ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean');
    next.enabled = input.enabled;
  }
  if (input.endpoint !== undefined) {
    if (typeof input.endpoint !== 'string') throw new Error('endpoint must be a string');
    if (input.endpoint.trim()) parseEndpoint(input.endpoint);
    next.endpoint = input.endpoint.trim();
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || input.model.trim().length > 160) throw new Error('model must be a string up to 160 characters');
    next.model = input.model.trim();
  }
  if (input.mode !== undefined) {
    if (typeof input.mode !== 'string' || !PROMPT_ENHANCER_MODES.includes(input.mode as PromptEnhancerMode)) {
      throw new Error('invalid enhancement mode');
    }
    next.mode = input.mode as PromptEnhancerMode;
  }
  if (input.timeout_ms !== undefined) {
    const timeout = input.timeout_ms;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) {
      throw new Error(`timeout_ms must be an integer between 1000 and ${MAX_TIMEOUT_MS}`);
    }
    next.timeout_ms = timeout;
  }
  if (input.api_key !== undefined) {
    if (typeof input.api_key !== 'string' || input.api_key.length > 2_000) throw new Error('api_key must be a string up to 2000 characters');
    if (input.api_key.trim()) next.api_key = input.api_key.trim();
  }
  if (input.clear_api_key === true) next.api_key = '';

  const db = getDb();
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const transaction = db.transaction(() => {
    upsert.run(settingKey('enabled'), String(next.enabled));
    upsert.run(settingKey('endpoint'), next.endpoint);
    upsert.run(settingKey('model'), next.model);
    upsert.run(settingKey('mode'), next.mode);
    upsert.run(settingKey('timeout_ms'), String(next.timeout_ms));
    upsert.run(settingKey('api_key'), next.api_key);
  });
  transaction();
  return next;
}

export const promptEnhancerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/prompt-enhancer/config', async () => ({ config: safeConfig(readConfig()) }));

  app.put<{ Body: Record<string, unknown> }>('/prompt-enhancer/config', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    if (!isRecord(req.body)) return reply.status(400).send({ error: 'configuration object is required' });
    try {
      return { ok: true, config: safeConfig(updateConfig(req.body)) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Invalid configuration' });
    }
  });

  app.post('/prompt-enhancer/test', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    try {
      const config = requireReadyConfig();
      await callModel(config, 'Reply with the single word: ready', 'base');
      return { ok: true };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'LLM connection test failed' });
    }
  });

  app.post<{ Body: { endpoint?: unknown; api_key?: unknown } }>('/prompt-enhancer/models', async (req, reply) => {
    if (!isAdmin(req.user!.id)) return reply.status(403).send({ error: 'Admin only' });
    const body = req.body || {};
    if (body.endpoint !== undefined && typeof body.endpoint !== 'string') return reply.status(400).send({ error: 'endpoint must be a string' });
    if (body.api_key !== undefined && (typeof body.api_key !== 'string' || body.api_key.length > 2_000)) {
      return reply.status(400).send({ error: 'api_key must be a string up to 2000 characters' });
    }
    const saved = readConfig();
    const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim() : saved.endpoint;
    const apiKey = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : saved.api_key;
    try {
      return { models: await discoverModels(endpoint, apiKey) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Model discovery failed' });
    }
  });

  app.post<{ Body: { session_id?: unknown; prompt?: unknown; mode?: unknown } }>('/prompt-enhancer/enhance', async (req, reply) => {
    const { session_id: sessionId, prompt, mode } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId) return reply.status(400).send({ error: 'session_id is required' });
    if (typeof prompt !== 'string' || !prompt.trim()) return reply.status(400).send({ error: 'prompt is required' });
    if (prompt.length > MAX_PROMPT_CHARS) return reply.status(400).send({ error: `prompt must be at most ${MAX_PROMPT_CHARS} characters` });
    const session = getDb().prepare('SELECT created_by_user_id FROM sessions WHERE id = ?').get(sessionId) as { created_by_user_id: string | null } | undefined;
    if (!session || session.created_by_user_id !== req.user!.id) return reply.status(403).send({ error: 'You can only enhance prompts for your own tabs' });
    const selectedMode = mode === undefined ? undefined : mode;
    if (selectedMode !== undefined && (typeof selectedMode !== 'string' || !PROMPT_ENHANCER_MODES.includes(selectedMode as PromptEnhancerMode))) {
      return reply.status(400).send({ error: 'invalid enhancement mode' });
    }
    try {
      const config = requireReadyConfig();
      const enhanced = await callModel(config, prompt.trim(), (selectedMode as PromptEnhancerMode | undefined) || config.mode);
      return { prompt: enhanced };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Prompt enhancement failed' });
    }
  });
};
