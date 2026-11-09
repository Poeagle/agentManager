import {useQuery} from '@tanstack/react-query';
import {api} from './api';

export function useProviderUsage(environmentId?: string) {
  const query = useQuery({
    queryKey: ['provider-usage', environmentId],
    queryFn: () => api.codexEnvironments.usage(environmentId!),
    enabled: !!environmentId,
    retry: false,
    refetchInterval: 10000,
  });
  return {
    ...query,
    inUse: !query.data || !!query.data.tabs.length,
    busy: !query.data || query.data.busy,
    verified: !query.isError && !!query.data?.verified,
  };
}
