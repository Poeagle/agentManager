import { useQuery } from '@tanstack/react-query';
import { api, type MyPermissions, type PermissionLevel } from './api';

const rank: Record<PermissionLevel, number> = { read: 1, write: 2, delete: 3 };
export function hasPermission(data: MyPermissions | undefined, key: string, required: PermissionLevel = 'read'): boolean {
  const level = data?.permissions[key];
  return !!level && rank[level] >= rank[required];
}
export function usePermissions() {
  return useQuery({ queryKey: ['rbac-me'], queryFn: api.rbac.me, staleTime: 15_000, refetchInterval: 30_000 });
}
