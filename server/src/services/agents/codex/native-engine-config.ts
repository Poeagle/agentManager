import type { AgentProviderInput } from '../types.js';
import { readAgentManagement, updateAgentManagement } from '../management-store.js';
import { normalizeEngineArgs, normalizeEngineCommand } from './engine-command.js';

export interface NativeEngineConfig {
  command: string;
  extraArgs: string[];
}

export function nativeEngineConfig(): NativeEngineConfig {
  const defaults = readAgentManagement('codex').defaults;
  try {
    return {
      command: normalizeEngineCommand(defaults.nativeEngineCommand, 'codex'),
      extraArgs: normalizeEngineArgs(defaults.nativeEngineArgs),
    };
  } catch {
    return { command: 'codex', extraArgs: [] };
  }
}

export function updateNativeEngineConfig(input: AgentProviderInput): NativeEngineConfig {
  const prior = nativeEngineConfig();
  const next = {
    command: normalizeEngineCommand(input.fields?.command, prior.command),
    extraArgs: input.fields?.launchArgs === undefined
      ? prior.extraArgs
      : normalizeEngineArgs(input.fields.launchArgs),
  };
  updateAgentManagement('codex', current => ({
    ...current,
    defaults: {
      ...current.defaults,
      nativeEngineCommand: next.command,
      nativeEngineArgs: next.extraArgs,
    },
  }));
  return next;
}
