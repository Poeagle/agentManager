export interface TerminalInstance {
  id: string;
  label: string;
  /** User-set tab name. Falls back to the auto-generated label when empty. */
  customLabel?: string;
}

/**
 * Reconcile the fast localStorage snapshot with the cross-device server state.
 *
 * The server list is authoritative for durable open tabs. Local-only tabs are
 * retained only when their session is currently alive or was just created and
 * has not reached the server query yet. This prevents a stale browser cache
 * from resurrecting ended tabs after an application restart.
 */
export function reconcileHydratedTerminalInstances(
  localInstances: TerminalInstance[],
  serverInstances: TerminalInstance[],
  hiddenSessionIds: ReadonlySet<string>,
  retainLocalSessionIds: ReadonlySet<string>,
): TerminalInstance[] {
  const localById = new Map(
    localInstances
      .filter((terminal) => !hiddenSessionIds.has(terminal.id))
      .map((terminal) => [terminal.id, terminal]),
  );
  const reconciled: TerminalInstance[] = [];
  const includedIds = new Set<string>();

  for (const saved of serverInstances) {
    if (hiddenSessionIds.has(saved.id) || includedIds.has(saved.id)) continue;
    const local = localById.get(saved.id);
    reconciled.push(
      local
        ? { ...saved, ...local, customLabel: local.customLabel || saved.customLabel }
        : saved,
    );
    includedIds.add(saved.id);
  }

  for (const local of localInstances) {
    if (
      includedIds.has(local.id)
      || hiddenSessionIds.has(local.id)
      || !retainLocalSessionIds.has(local.id)
    ) continue;
    reconciled.push(local);
    includedIds.add(local.id);
  }

  return reconciled;
}
