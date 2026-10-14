export const MEMORY_REAPER_DEFAULTS = {
  memory_cleanup_enabled: 'false',
  memory_cleanup_threshold_percent: '85',
  memory_cleanup_idle_minutes: '10',
};

export function memoryCleanupSettingError(settings: Record<string, unknown>): string | null {
  if ('memory_cleanup_enabled' in settings
    && !['true', 'false'].includes(String(settings.memory_cleanup_enabled))) {
    return 'memory_cleanup_enabled must be true or false';
  }
  if ('memory_cleanup_threshold_percent' in settings) {
    const threshold = Number(settings.memory_cleanup_threshold_percent);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
      return 'memory_cleanup_threshold_percent must be between 1 and 100';
    }
  }
  if ('memory_cleanup_idle_minutes' in settings) {
    const minutes = Number(settings.memory_cleanup_idle_minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      return 'memory_cleanup_idle_minutes must be an integer between 1 and 10080';
    }
  }
  return null;
}
