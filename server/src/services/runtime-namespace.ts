/** Optional isolation boundary for concurrent installations on the same host. */
export function runtimeNames(env: NodeJS.ProcessEnv = process.env) {
  const namespace = env.AGENTMANAGER_RUNTIME_NAMESPACE?.trim() || '';
  if (namespace && !/^[a-zA-Z0-9_-]{1,32}$/.test(namespace)) {
    throw new Error('AGENTMANAGER_RUNTIME_NAMESPACE must contain 1–32 letters, digits, _ or -');
  }
  const base = namespace ? `agentmanager-${namespace}` : 'agentmanager';
  return { tmuxServer: base, socketPrefix: `${base}-`, pipeDirectory: `${base}-pipes`, sandboxPrefix: `${base}-sandbox-` };
}
