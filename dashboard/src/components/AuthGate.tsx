import { useState, useEffect, useCallback } from 'react';
import { api, type AuthUser, type AuthStatus } from '../lib/api';

/**
 * Gates the whole app behind login. While loading, shows a spinner; if the
 * server has no users yet, shows first-run admin setup; if not logged in,
 * shows login; once authenticated, renders the app via the children render-prop.
 */
export function AuthGate({ children }: { children: (user: AuthUser, logout: () => void) => React.ReactNode }) {
  const [state, setState] = useState<AuthStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.auth.status());
    } catch {
      setState({ needsSetup: false, authenticated: false, user: null });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const logout = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    // Full reload so no in-memory state from the previous user (React Query
    // cache, open tabs, WebSocket) can leak into the next session.
    window.location.reload();
  }, []);

  if (!state) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (state.authenticated && state.user) {
    return <>{children(state.user, logout)}</>;
  }

  // Reload after login/setup so the app mounts fresh for the new user (no stale
  // cache/state from a previous session in the same tab).
  return <AuthForm mode={state.needsSetup ? 'setup' : 'login'} onSuccess={() => window.location.reload()} />;
}

function AuthForm({ mode, onSuccess }: { mode: 'setup' | 'login'; onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isSetup = mode === 'setup';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isSetup) {
        await api.auth.setup({ username: username.trim(), password, display_name: displayName.trim() || undefined });
      } else {
        await api.auth.login({ username: username.trim(), password });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl p-6 flex flex-col gap-4"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isSetup ? '创建管理员账户' : '登录 AgentManager'}
          </h1>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {isSetup ? '这是首次启动,第一个账户即管理员。' : '请输入你的账号密码。'}
          </p>
        </div>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          用户名
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="px-3 py-2 rounded-md text-sm outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />
        </label>

        {isSetup && (
          <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            显示名(可选)
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="px-3 py-2 rounded-md text-sm outline-none"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            className="px-3 py-2 rounded-md text-sm outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />
        </label>

        {error && (
          <div className="text-xs px-3 py-2 rounded-md" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--error)' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="px-3 py-2 rounded-md text-sm font-medium transition-opacity disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {busy ? '请稍候…' : isSetup ? '创建并进入' : '登录'}
        </button>
      </form>
    </div>
  );
}
