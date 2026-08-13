export const WARM_TERMINAL_LIMIT = 3;
export const TERMINAL_COLD_DELAY_MS = 45_000;

export function promoteWarmTerminal(
  current: readonly string[],
  terminalId: string,
  limit = WARM_TERMINAL_LIMIT,
): { recent: string[]; cooling: string[] } {
  const recent = [...current.filter((id) => id !== terminalId), terminalId];
  const overflow = Math.max(0, recent.length - Math.max(1, limit));
  return {
    recent: overflow > 0 ? recent.slice(overflow) : recent,
    cooling: overflow > 0 ? recent.slice(0, overflow) : [],
  };
}
