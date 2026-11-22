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
  const tabs = query.data?.tabs ?? [];
  return {
    ...query,
    inUse: !query.data || tabs.length > 0,
    busy: !query.data || query.data.busy === true,
    verified: !query.isError && !!query.data?.verified,
  };
}
