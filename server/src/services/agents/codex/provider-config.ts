import { dirname, join } from 'path';
import { config } from '../../../config.js';
import { readAgentManagement } from '../management-store.js';
import type { CodexEngine } from './engine-context.js';

const runtimeSockets = new Map<string, string>();

export function managedCodexSocket(providerId: string): string {
  return join(dirname(config.dbPath), 'codex-providers', `${providerId}.sock`);
}

export function setManagedCodexRuntimeSocket(providerId: string, socket: string): void {
  runtimeSockets.set(providerId, socket);
}

export function clearManagedCodexRuntimeSocket(providerId: string): void {
  runtimeSockets.delete(providerId);
}

export function managedCodexRuntimeSocket(providerId: string): string | null {
  return runtimeSockets.get(providerId) || null;
}

export function managedCodexEngines(): CodexEngine[] {
  return readAgentManagement('codex').providers
    .filter(provider => provider.enabled)
    .map(provider => ({
      provider: provider.id,
      socket: runtimeSockets.get(provider.id) || managedCodexSocket(provider.id),
      models: Array.isArray(provider.fields.models)
        ? provider.fields.models.filter((model): model is string => typeof model === 'string')
        : [],
    }))
    .filter(engine => engine.models.length > 0);
}
