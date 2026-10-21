import type { FastifyInstance } from 'fastify';

export interface RegisteredPlatformApi {
  endpoint_id: string; method: string; path: string; description: string;
  schema?: unknown; callable: boolean; restriction?: string;
}

declare module 'fastify' {
  interface FastifyInstance { platformAiApiRegistry?: Map<string, RegisteredPlatformApi> }
}

/** Inventory all actual API routes instead of giving the AI a second, stale API list. */
export function installPlatformApiRegistry(app: FastifyInstance): void {
  const registry = new Map<string, RegisteredPlatformApi>();
  app.decorate('platformAiApiRegistry', registry);
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/')) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const path = route.url;
      let restriction: string | undefined;
      if (route.websocket || /\/(?:stream|terminal)$/.test(path)) restriction = 'WebSocket protocol; use session tools for agent control';
      else if (/\/sessions\/:id\/(?:output|rendered-output)$/.test(path)) restriction = 'Use the clean session display or completed-turn API instead of terminal replay data';
      else if (/^\/api\/auth\//.test(path)) restriction = 'Login and credential management require direct user interaction';
      else if (/^\/api\/platform-ai\/(?:config|channels|bindings|notification-targets|callbacks|messages|attachments)/.test(path)) restriction = 'AI/channel credentials, identity bindings and ingress are managed directly in the platform';
      else if (/^\/api\/platform-ai\/(?:conversations|tools)/.test(path)) restriction = 'Use conversation context or platform_capabilities to avoid recursive requests';
      else if (/\/files\/(?:upload|preview|export)$/.test(path) || /\/sessions\/.*\/(?:paste-image|paste-file)$/.test(path)) restriction = 'Binary transfer or preview endpoint requires a dedicated client';
      else if (method !== 'GET') restriction = 'Requires a documented command tool; query the endpoint definition';
      registry.set(`${method} ${path}`, {
        endpoint_id: `${method} ${path}`, method, path,
        description: (route.schema as {description?: string} | undefined)?.description || `Platform API: ${method} ${path}`,
        ...(route.schema ? { schema: route.schema } : {}),
        callable: !restriction, ...(restriction ? { restriction } : {}),
      });
    }
  });
}
