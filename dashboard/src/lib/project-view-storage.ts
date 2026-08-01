function storageKey(userId: string, projectId: string): string {
  return `agentmanager-project-${userId}-${projectId}`;
}

/** Remove a project's persisted view and the explorer states it owns. */
export function cleanupProjectStorage(userId: string, projectId: string): void {
  try {
    const raw = localStorage.getItem(storageKey(userId, projectId));
    if (raw) {
      const parsed = JSON.parse(raw) as { explorerInstances?: Array<{ id?: unknown }> };
      for (const instance of parsed.explorerInstances ?? []) {
        if (typeof instance.id === 'string') {
          localStorage.removeItem(`agentmanager-explorer-${instance.id}`);
        }
      }
    }
    localStorage.removeItem(storageKey(userId, projectId));
  } catch {
    // Cleanup is best effort when storage is unavailable or malformed.
  }
}
