import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const HARNESS_URL_SETTING = 'deepseek_harness_url';
export const HARNESS_BRIDGE = 'octoally:dsh/1';

export function useHarnessUrl() {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 30_000 });
  return data?.settings?.[HARNESS_URL_SETTING] ?? '';
}
