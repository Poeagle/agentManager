import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { X, Settings, Check, Loader2, Zap, Bot, Type, Globe, RotateCcw, BarChart3, Download, Trash2, Palette } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { THEMES, applyTheme, DEFAULT_THEME } from '../lib/themes';

interface SettingsModalProps {
  onClose: () => void;
  readOnly?: boolean;
}

function CommandInput({
  label,
  icon,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
        {icon}
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm"
        style={{
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          outline: 'none',
        }}
        onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
        onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
      />
    </div>
  );
}

export function SettingsModal({ onClose, readOnly = false }: SettingsModalProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });
  const { data: networkData } = useQuery({
    queryKey: ['network-info'],
    queryFn: () => fetch('/api/network-info').then((r) => r.json()) as Promise<{ addresses: string[]; port: number }>,
  });

  const [sessionClaudeCmd, setSessionClaudeCmd] = useState('');
  const [sessionCodexCmd, setSessionCodexCmd] = useState('');
  const [agentClaudeCmd, setAgentClaudeCmd] = useState('');
  const [agentCodexCmd, setAgentCodexCmd] = useState('');
  const [fontSize, setFontSize] = useState('12');
  const [appFontSize, setAppFontSize] = useState('16');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [serverPort, setServerPort] = useState('42010');
  const [saved, setSaved] = useState(false);

  // Theme is previewed live on click; if the modal closes without a save we
  // revert to the persisted theme so an un-saved preview doesn't linger.
  const persistedThemeRef = useRef(DEFAULT_THEME);
  const themeCommittedRef = useRef(false);

  useEffect(() => {
    if (data?.settings) {
      const s = data.settings;
      // Query data is the external source that hydrates this editable form.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSessionClaudeCmd(s.session_claude_command || '');
      setSessionCodexCmd(s.session_codex_command || '');
      setAgentClaudeCmd(s.agent_claude_command || '');
      setAgentCodexCmd(s.agent_codex_command || '');
      setFontSize(s.terminal_font_size || '12');
      setAppFontSize(s.app_font_size || '16');
      setTheme(s.app_theme || DEFAULT_THEME);
      persistedThemeRef.current = s.app_theme || DEFAULT_THEME;
      setServerPort(s.server_port || '42010');
    }
  }, [data]);

  // On unmount, undo any unsaved live theme preview.
  useEffect(() => {
    return () => {
      if (!themeCommittedRef.current) applyTheme(persistedThemeRef.current);
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (settings: Record<string, string>) => api.settings.update(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleSave() {
    // The previewed theme is now the persisted one — don't revert it on close.
    themeCommittedRef.current = true;
    persistedThemeRef.current = theme;
    mutation.mutate({
      session_claude_command: sessionClaudeCmd,
      session_codex_command: sessionCodexCmd,
      agent_claude_command: agentClaudeCmd,
      agent_codex_command: agentCodexCmd,
      terminal_font_size: fontSize,
      app_font_size: appFontSize,
      app_theme: theme,
      server_port: serverPort,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          width: '100%',
          maxWidth: '900px',
          maxHeight: '90vh',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Settings
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — 2-column grid */}
        <div className="px-6 py-5 overflow-y-auto" style={{ maxHeight: '65vh' }}>
          {readOnly && (
            <div className="mb-4 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              普通用户只能查看设置，只有管理员可以修改。
            </div>
          )}
          <fieldset disabled={readOnly} className="contents">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
              {/* ── LEFT COLUMN ── */}
              <div className="space-y-6">
                {/* Session Commands */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4" style={{ color: '#60a5fa' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Session Commands
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    The CLI command used when launching sessions.
                  </p>
                  <div className="space-y-3 pl-1">
                    <CommandInput
                      label="Claude"
                      icon={<ClaudeIcon className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />}
                      value={sessionClaudeCmd}
                      onChange={setSessionClaudeCmd}
                      placeholder="claude --dangerously-skip-permissions"
                    />
                    <CommandInput
                      label="Codex"
                      icon={<CodexIcon className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />}
                      value={sessionCodexCmd}
                      onChange={setSessionCodexCmd}
                      placeholder="codex --dangerously-bypass-approvals-and-sandbox"
                    />
                  </div>
                </div>

                {/* Agent Commands */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4" style={{ color: '#ef4444' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Agent Commands
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    The CLI command used when launching Agent sessions.
                  </p>
                  <div className="space-y-3 pl-1">
                    <CommandInput
                      label="Claude"
                      icon={<ClaudeIcon className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                      value={agentClaudeCmd}
                      onChange={setAgentClaudeCmd}
                      placeholder="claude --dangerously-skip-permissions"
                    />
                    <CommandInput
                      label="Codex"
                      icon={<CodexIcon className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                      value={agentCodexCmd}
                      onChange={setAgentCodexCmd}
                      placeholder="codex --dangerously-bypass-approvals-and-sandbox"
                    />
                  </div>
                </div>

                {/* Server */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4" style={{ color: '#22c55e' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Server
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Port for the AgentManager server. Changes take effect on restart.
                  </p>
                  <div className="space-y-2 pl-1">
                    <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      Port
                    </label>
                    <input
                      type="number"
                      min="1024"
                      max="65535"
                      value={serverPort}
                      onChange={(e) => setServerPort(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-sm"
                      style={{
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        outline: 'none',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                      onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
                    />
                    {networkData?.addresses && networkData.addresses.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-1">
                        {networkData.addresses.map((ip) => (
                          <span
                            key={ip}
                            className="px-2 py-0.5 rounded text-xs font-mono"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                          >
                            http://{ip}:{serverPort}
                          </span>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={async () => {
                        try {
                          await fetch('/api/restart', { method: 'POST' });
                        } catch {
                          // The server may close the connection before the response
                          // arrives because the restart has already begun.
                        }
                      }}
                      className="flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                      style={{ background: 'var(--warning)', color: '#000' }}
                    >
                      <RotateCcw className="w-3 h-3" />
                      Restart Server
                    </button>
                  </div>
                </div>
              </div>

              {/* ── RIGHT COLUMN ── */}
              <div className="space-y-6">
                {/* Appearance */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Type className="w-4 h-4" style={{ color: '#a855f7' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Appearance
                    </h4>
                  </div>
                  <div className="space-y-4 pl-1">
                    {/* Theme */}
                    <div className="space-y-2">
                      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <Palette className="w-3.5 h-3.5" style={{ color: '#a855f7' }} />
                        Theme
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {THEMES.map((t) => {
                          const active = theme === t.id;
                          return (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => { setTheme(t.id); applyTheme(t.id); }}
                              className="rounded-lg overflow-hidden text-left transition-all"
                              style={{
                                border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                                padding: 0,
                              }}
                              title={t.label}
                            >
                              {/* mini window preview painted in the theme's own colors */}
                              <div style={{ background: t.bg, padding: '9px 9px 7px' }}>
                                <div className="flex items-center gap-1" style={{ marginBottom: 6 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: 999, background: t.accent, display: 'inline-block', flexShrink: 0 }} />
                                  <span style={{ height: 5, width: '55%', borderRadius: 999, background: t.panel, display: 'inline-block' }} />
                                </div>
                                <div style={{ height: 5, width: '85%', borderRadius: 999, background: t.panel, marginBottom: 4 }} />
                                <div style={{ height: 5, width: '45%', borderRadius: 999, background: t.text, opacity: 0.45 }} />
                              </div>
                              <div className="flex items-center justify-between px-2 py-1" style={{ background: 'var(--bg-primary)' }}>
                                <span className="text-[11px] font-medium truncate" style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                                  {t.label}
                                </span>
                                {active && <Check className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* App Font Size */}
                    <div className="space-y-2">
                      <label className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <span>App Font Size</span>
                        <span
                          className="px-2 py-0.5 rounded text-xs tabular-nums"
                          style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                        >
                          {appFontSize}px
                        </span>
                      </label>
                      <input
                        type="range"
                        min="10"
                        max="32"
                        step="1"
                        value={appFontSize}
                        onChange={(e) => {
                          setAppFontSize(e.target.value);
                          document.documentElement.style.setProperty('--app-font-size', `${e.target.value}px`);
                        }}
                        className="w-full accent-purple-500"
                        style={{ height: '4px' }}
                      />
                      <div className="flex justify-between text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
                        <span>10</span>
                        <span>32</span>
                      </div>
                    </div>

                    {/* Terminal Font Size */}
                    <div className="space-y-2">
                      <label className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <span>Terminal Font Size</span>
                        <span
                          className="px-2 py-0.5 rounded text-xs tabular-nums"
                          style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                        >
                          {fontSize}px
                        </span>
                      </label>
                      <input
                        type="range"
                        min="8"
                        max="24"
                        step="1"
                        value={fontSize}
                        onChange={(e) => setFontSize(e.target.value)}
                        className="w-full accent-purple-500"
                        style={{ height: '4px' }}
                      />
                      <div className="flex justify-between text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
                        <span>8</span>
                        <span>24</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Claude Status Bar */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" style={{ color: '#06b6d4' }} />
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Claude Status Bar
                    </h4>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Custom status bar for Claude Code showing git branch, model, context usage, cost, and session duration.
                  </p>
                  <StatuslineSettings />
                </div>

              </div>
            </div>
          )}

          </fieldset>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-6 py-4 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          {!readOnly && <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: saved ? 'var(--success, #22c55e)' : 'var(--accent)',
              color: '#fff',
              opacity: mutation.isPending ? 0.7 : 1,
            }}
          >
            {mutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : saved ? (
              <Check className="w-3.5 h-3.5" />
            ) : null}
            {saved ? 'Saved' : 'Save'}
          </button>}
        </div>
      </div>
    </div>
  );
}

function StatuslineSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['statusline'],
    queryFn: () => api.settings.statusline.get(),
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleToggle = async () => {
    setBusy(true);
    setResult(null);
    try {
      if (data?.installed) {
        await api.settings.statusline.uninstall();
        setResult('Status bar removed.');
      } else {
        await api.settings.statusline.install();
        setResult('Status bar installed! It will appear on your next Claude Code interaction.');
      }
      await queryClient.invalidateQueries({ queryKey: ['statusline'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed';
      setResult(`Error: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={handleToggle}
        disabled={busy || isLoading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
        style={{
          background: data?.installed ? '#ef4444' : '#06b6d4',
          color: '#fff',
          opacity: busy || isLoading ? 0.6 : 1,
        }}
      >
        {busy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : data?.installed ? (
          <Trash2 className="w-3 h-3" />
        ) : (
          <Download className="w-3 h-3" />
        )}
        {busy
          ? (data?.installed ? 'Removing...' : 'Installing...')
          : (data?.installed ? 'Uninstall Status Bar' : 'Install Status Bar')}
      </button>
      {result && (
        <p className="text-xs mt-1" style={{ color: result.startsWith('Error') ? '#ef4444' : '#22c55e' }}>
          {result}
        </p>
      )}
    </>
  );
}
