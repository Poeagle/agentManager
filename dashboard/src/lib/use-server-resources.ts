import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { newestServerResources, SERVER_RESOURCE_QUERY_KEY, type ServerResourceResponse } from './server-resource-cache';
import { useStreamStore } from './websocket';

/** All views render one query cache updated by the server's resource stream.
 * REST bootstraps the page and polls the same snapshot during stream outages. */
export function useServerResources() {
  const client = useQueryClient();
  const connected = useStreamStore((state) => state.connected);
  return useQuery({
    queryKey: SERVER_RESOURCE_QUERY_KEY,
    queryFn: async () => {
      const response = await api.admin.serverResources();
      return newestServerResources(client.getQueryData<ServerResourceResponse>(SERVER_RESOURCE_QUERY_KEY), response);
    },
    refetchInterval: connected ? false : 5000,
    refetchIntervalInBackground: false,
    staleTime: 5000,
    retry: false,
  });
}
