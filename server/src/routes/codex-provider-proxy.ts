import type { FastifyPluginAsync } from 'fastify';
import { codexProviderProxyPlugin } from '../services/agents/codex/responses-chat-bridge.js';

export const codexProviderProxyRoutes: FastifyPluginAsync = codexProviderProxyPlugin;
