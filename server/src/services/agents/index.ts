/** Application composition root. Native implementations are selected here. */
import {registerAgent} from './registry.js';
import {codexAdapter} from './codex/adapter.js';
import {claudeAdapter} from './claude/adapter.js';
registerAgent(codexAdapter);registerAgent(claudeAdapter);
export * from './registry.js';
export type * from './types.js';
