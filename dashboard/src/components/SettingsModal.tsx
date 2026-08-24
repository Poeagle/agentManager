import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type PromptEnhancerMode } from '../lib/api';
import { X, Settings, Check, Loader2, Zap, Bot, Type, Globe, RotateCcw, Palette, Sparkles, PlugZap, Search } from 'lucide-react';
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
        className="h-9 w-full rounded-md px-3 text-sm transition-colors"
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

function SettingsSection({
  title,
  description,
  icon,
  children,
  className = '',
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg p-5 ${className}`} style={{ background: 'color-mix(in srgb, var(--bg-tertiary) 52%, transparent)', border: '1px solid var(--border)' }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-primary)', color: 'var(--accent)', border: '1px solid var(--border)' }}>
          {icon}
        </span>
        <div>
          <h4 className="text-sm font-semibold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{title}</h4>
          <p className="mt-1 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{description}</p>
        </div>
      </div>
      <div className="mt-5 border-t pt-5" style={{ borderColor: 'var(--border)' }}>
        {children}
      </div>
    </section>
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
  const [activePage, setActivePage] = useState<'session' | 'agent' | 'appearance' | 'enhancer' | 'server'>('session');

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

  const navigation = [
    { id: 'session' as const, label: '普通会话', icon: Zap },
    { id: 'agent' as const, label: 'Agent 会话', icon: Bot },
    { id: 'appearance' as const, label: '外观', icon: Type },
    { id: 'enhancer' as const, label: '提示词增强', icon: Sparkles },
    { id: 'server' as const, label: '服务器', icon: Globe },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{ background: 'rgba(0,0,0,0.58)' }}
      onClick={onClose}
    >
      <div
        className="flex min-h-[560px] w-full flex-col overflow-hidden rounded-xl shadow-2xl"
        style={{
          width: '100%',
          maxWidth: '980px',
          maxHeight: 'calc(100vh - 48px)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center justify-between px-5 py-4 sm:px-6"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'var(--bg-tertiary)', color: 'var(--accent)', border: '1px solid var(--border)' }}>
              <Settings className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-base font-semibold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>设置</h3>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>工作区与连接配置</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 transition-colors hover:opacity-75"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="关闭设置"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="w-44 shrink-0 border-r p-3" style={{ background: 'color-mix(in srgb, var(--bg-tertiary) 54%, transparent)', borderColor: 'var(--border)' }} aria-label="设置分类">
            <nav className="space-y-1">
              {navigation.map((item) => {
                const Icon = item.icon;
                const active = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActivePage(item.id)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors"
                    style={{
                      color: active ? 'var(--accent)' : 'var(--text-secondary)',
                      background: active ? 'var(--bg-primary)' : 'transparent',
                      boxShadow: active ? 'inset 0 0 0 1px var(--border)' : 'none',
                    }}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7 sm:py-7">
          {readOnly && (
            <div className="mb-5 rounded-md px-3 py-2 text-xs" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              当前为只读模式；只有管理员可以修改设置。
            </div>
          )}
          <fieldset disabled={readOnly} className="block">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <div className="mx-auto max-w-[680px]">
              {/* ── LEFT COLUMN ── */}
              <div className={activePage === 'session' || activePage === 'agent' || activePage === 'server' ? 'space-y-5' : 'hidden'}>
                {/* Session Commands */}
                <SettingsSection title="普通会话" description="启动普通会话时使用的 CLI 命令。" icon={<Zap className="h-4 w-4" />} className={activePage === 'session' ? '' : 'hidden'}>
                  <div className="space-y-4">
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
                </SettingsSection>

                {/* Agent Commands */}
                <SettingsSection title="Agent 会话" description="启动 Agent 会话时使用的 CLI 命令。" icon={<Bot className="h-4 w-4" />} className={activePage === 'agent' ? '' : 'hidden'}>
                  <div className="space-y-4">
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
                </SettingsSection>

                {/* Server */}
                <SettingsSection title="服务器" description="服务端口的修改会在重启服务器后生效。" icon={<Globe className="h-4 w-4" />} className={activePage === 'server' ? '' : 'hidden'}>
                  <div className="space-y-4">
                    <label className="block space-y-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      <span>服务端口</span>
                    <input
                      type="number"
                      min="1024"
                      max="65535"
                      value={serverPort}
                      onChange={(e) => setServerPort(e.target.value)}
                      className="h-9 w-full rounded-md px-3 text-sm"
                      style={{
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        outline: 'none',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                      onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
                    />
                    </label>
                    {networkData?.addresses && networkData.addresses.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {networkData.addresses.map((ip) => (
                          <span
                            key={ip}
                            className="rounded-md px-2.5 py-1.5 text-[11px] font-mono"
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
                      className="mt-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-opacity hover:opacity-85"
                      style={{ background: 'var(--warning)', color: '#000' }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      重启服务器
                    </button>
                  </div>
                </SettingsSection>
              </div>

              {/* ── RIGHT COLUMN ── */}
              <div className={activePage === 'appearance' || activePage === 'enhancer' ? 'space-y-5' : 'hidden'}>
                {/* Appearance */}
                <SettingsSection title="外观" description="主题会即时预览；保存设置后才会长期生效。" icon={<Type className="h-4 w-4" />} className={activePage === 'appearance' ? '' : 'hidden'}>
                  <div className="space-y-6">
                    {/* Theme */}
                    <div className="space-y-2">
                      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <Palette className="w-3.5 h-3.5" style={{ color: '#a855f7' }} />
                        主题
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {THEMES.map((t) => {
                          const active = theme === t.id;
                          return (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => { setTheme(t.id); applyTheme(t.id); }}
                              className="overflow-hidden rounded-md text-left transition-all"
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
                              <div className="flex items-center justify-between px-2.5 py-2" style={{ background: 'var(--bg-primary)' }}>
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
                        <span>应用字体大小</span>
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
                        <span>终端字体大小</span>
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
                </SettingsSection>

                {/* Prompt enhancement */}
                <div className={activePage === 'enhancer' ? '' : 'hidden'}><PromptEnhancerSettings /></div>
              </div>
            </div>
          )}

          </fieldset>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex shrink-0 items-center justify-end gap-2 px-5 py-4 sm:px-6"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-xs font-medium transition-colors hover:opacity-80"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            取消
          </button>
          {!readOnly && <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-opacity hover:opacity-90"
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
            {saved ? '已保存' : '保存设置'}
          </button>}
        </div>
      </div>
    </div>
  );
}

const ENHANCER_MODE_OPTIONS: Array<{ value: PromptEnhancerMode; label: string; description: string }> = [
  { value: 'base', label: '基础', description: '只梳理表达，不补充假设' },
  { value: 'lite', label: '轻量', description: '压缩成清晰、直接的任务' },
  { value: 'standard', label: '标准', description: '补齐目标、约束和验证方式' },
  { value: 'expert', label: '专家', description: '组织为严格的执行简报' },
  { value: 'publish', label: '发布', description: '生成完整开发规格' },
];

function PromptEnhancerSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['prompt-enhancer-config'],
    queryFn: () => api.promptEnhancer.config(),
  });
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<PromptEnhancerMode>('standard');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsResult, setModelsResult] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.config) return;
    const config = data.config;
    // Query data is the source of truth when this settings section opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(config.enabled);
    setEndpoint(config.endpoint);
    setModel(config.model);
    setMode(config.mode);
    setTimeoutMs(String(config.timeout_ms));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.promptEnhancer.updateConfig({
      enabled,
      endpoint,
      model,
      mode,
      timeout_ms: Number(timeoutMs),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    }),
    onSuccess: () => {
      setApiKey('');
      setSaved(true);
      setTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ['prompt-enhancer-config'] });
      setTimeout(() => setSaved(false), 2000);
    },
  });
  const testMutation = useMutation({
    mutationFn: () => api.promptEnhancer.test(),
    onSuccess: () => setTestResult('连接成功，模型可以响应。'),
    onError: (error) => setTestResult(error instanceof Error ? error.message : '连接测试失败'),
  });
  const detectModelsMutation = useMutation({
    mutationFn: () => api.promptEnhancer.models({
      endpoint,
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    }),
    onSuccess: (result) => {
      setModels(result.models);
      setModelsResult(`已发现 ${result.models.length} 个模型`);
    },
    onError: (error) => {
      setModels([]);
      setModelsResult(error instanceof Error ? error.message : '模型探测失败');
    },
  });

  const keyConfigured = data?.config.api_key_configured;
  const modeDescription = ENHANCER_MODE_OPTIONS.find((option) => option.value === mode)?.description;

  return (
    <section className="space-y-5 rounded-lg p-5" style={{ background: 'color-mix(in srgb, var(--bg-tertiary) 52%, transparent)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ color: '#c4b5fd', background: 'rgba(139, 92, 246, 0.14)', border: '1px solid rgba(139, 92, 246, 0.18)' }}>
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>提示词增强</h4>
            <p className="mt-1 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>通过服务端调用兼容 OpenAI 的模型，密钥不会返回浏览器。</p>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs font-medium" style={{ color: enabled ? '#c4b5fd' : 'var(--text-secondary)' }}>
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-violet-500" />
          启用
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}><Loader2 className="h-3.5 w-3.5 animate-spin" />加载配置…</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              <span>LLM URL</span>
              <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.openai.com/v1" className="h-9 w-full rounded-md px-3 text-xs" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', outline: 'none' }} />
            </label>
            <label className="space-y-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              <span className="flex items-center justify-between gap-2">
                模型
                <button
                  type="button"
                  onClick={(event) => { event.preventDefault(); setModelsResult(null); detectModelsMutation.mutate(); }}
                  disabled={detectModelsMutation.isPending || !endpoint.trim()}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium disabled:opacity-45"
                  style={{ color: '#c4b5fd', background: 'rgba(139, 92, 246, 0.10)' }}
                  title="从当前 LLM URL 探测可用模型"
                >
                  {detectModelsMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                  探测模型
                </button>
              </span>
              <input list="prompt-enhancer-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" className="h-9 w-full rounded-md px-3 text-xs" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', outline: 'none' }} />
              <datalist id="prompt-enhancer-models">
                {models.map((item) => <option key={item} value={item} />)}
              </datalist>
              {modelsResult && <span className="block text-[10px] font-normal" style={{ color: modelsResult.startsWith('已发现') ? 'var(--success)' : 'var(--error)' }}>{modelsResult}</span>}
            </label>
            <label className="space-y-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              <span>优化模式</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as PromptEnhancerMode)} className="h-9 w-full rounded-md px-3 text-xs" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', outline: 'none' }}>
                {ENHANCER_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className="block text-[10px] font-normal" style={{ color: 'var(--text-secondary)' }}>{modeDescription}</span>
            </label>
            <label className="space-y-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              <span>超时（毫秒）</span>
              <input type="number" min="1000" max="120000" step="1000" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} className="h-9 w-full rounded-md px-3 text-xs" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', outline: 'none' }} />
            </label>
          </div>
          <label className="block space-y-1.5 border-t pt-4 text-xs font-medium" style={{ color: 'var(--text-primary)', borderColor: 'var(--border)' }}>
            <span>API Key {keyConfigured && <span className="font-normal" style={{ color: 'var(--success)' }}>· 已配置</span>}</span>
            <input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyConfigured ? '已保存；留空不会覆盖' : '输入 API Key'} className="h-9 w-full rounded-md px-3 text-xs" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', outline: 'none' }} />
          </label>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-60" style={{ background: saved ? 'var(--success, #22c55e)' : '#7c3aed', color: '#fff' }}>
              {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
              {saved ? '已保存' : '保存增强设置'}
            </button>
            <button type="button" onClick={() => { setTestResult(null); testMutation.mutate(); }} disabled={testMutation.isPending || !enabled} className="flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-45" style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              {testMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlugZap className="w-3 h-3" />}
              测试连接
            </button>
            {(saveMutation.error || testResult) && <span className="text-[11px]" style={{ color: saveMutation.error || (testResult && !testResult.includes('成功')) ? 'var(--error)' : 'var(--success)' }}>{saveMutation.error instanceof Error ? saveMutation.error.message : testResult}</span>}
          </div>
        </>
      )}
    </section>
  );
}
