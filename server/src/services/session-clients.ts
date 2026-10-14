/** Client choices exposed by project authorization and Session launchers. */
export const SESSION_CLIENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
] as const;

export function parseSessionClients(value: string): string[] {
  try {
    const clients: unknown = JSON.parse(value);
    return Array.isArray(clients) ? [...new Set(clients.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}
