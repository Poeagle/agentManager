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

interface RestorableSession {
  id: string;
  project_id: string | null;
  status: string;
  cli_type?: string | null;
  claude_session_id?: string | null;
  codex_session_id?: string | null;
}

/** Only a durable, still-open server tab may restart an ended native CLI. */
export function shouldAutoRestoreSession(
  session: RestorableSession,
  projectId: string,
  displayedSessionIds: ReadonlySet<string>,
  canonicalOpenSessionIds: ReadonlySet<string>,
) {
  if (
    session.project_id !== projectId
    || !displayedSessionIds.has(session.id)
    || !canonicalOpenSessionIds.has(session.id)
    || (session.status !== 'completed' && session.status !== 'failed')
  ) return false;

  return session.cli_type === 'codex'
    ? !!session.codex_session_id
    : !!session.claude_session_id;
}
