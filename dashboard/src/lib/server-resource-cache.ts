import type { QueryClient } from '@tanstack/react-query';
import type { AdminMonitorResponse } from './api';

export const SERVER_RESOURCE_QUERY_KEY = ['server-resources'] as const;
export type ServerResourceResponse = Pick<AdminMonitorResponse, 'server_resources'>;

/** A delayed REST response or an old stream message must not replace a newer sample. */
export function newestServerResources(current: ServerResourceResponse | undefined, incoming: ServerResourceResponse): ServerResourceResponse {
  return current && Date.parse(current.server_resources.sampled_at) >= Date.parse(incoming.server_resources.sampled_at)
    ? current : incoming;
}

export function cacheServerResources(client: QueryClient, incoming: ServerResourceResponse): void {
  if (!Number.isFinite(Date.parse(incoming.server_resources.sampled_at))) return;
  client.setQueryData<ServerResourceResponse>(SERVER_RESOURCE_QUERY_KEY, (current) => newestServerResources(current, incoming));
}
