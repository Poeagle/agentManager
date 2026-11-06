/** Forward only user-facing shell variables, excluding server ports, runtime
 * modes and credentials. Browser terminals consume UTF-8; service managers on
 * macOS often omit the locale inherited by an interactive shell. */
export function sessionEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const allowedKeys = [
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'COLORTERM', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'NVM_BIN', 'NVM_DIR', 'FNM_DIR', 'PNPM_HOME', 'VOLTA_HOME', 'BUN_INSTALL',
    'EDITOR', 'VISUAL', 'PAGER',
  ] as const;
  const env: Record<string, string> = {};
  for (const key of allowedKeys) if (source[key] !== undefined) env[key] = source[key]!;
  if (!env.LANG && !env.LC_CTYPE && !env.LC_ALL) env.LANG = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return { ...env, TERM: 'xterm-256color', AGENTMANAGER_SESSION: '1', HEADLESS_WORKERS_DISABLED: '1' };
}

/** tmux otherwise replaces non-ASCII glyphs with underscores when the client
 * starts under LANG=C or without a locale, even if the pane contains UTF-8. */
export function tmuxClientArgs(server: string): string[] {
  return ['-u', '-L', server];
}
