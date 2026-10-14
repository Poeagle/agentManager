import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type PromptEnhancerMode } from '../lib/api';
import { X, Settings, Check, Loader2, Zap, Type, Globe, Palette, Sparkles, PlugZap, Search, LockKeyhole } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { THEMES, applyTheme, DEFAULT_THEME } from '../lib/themes';
import './SettingsPanel.css';

interface SettingsModalProps {
  onClose: () => void;
  embedded?: boolean;
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
    <label className="settings-panel-field">
      <span className="flex items-center gap-1.5">{icon}{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="settings-panel-control"
        onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
        onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
      />
    </label>
  );
}

function SettingsSection({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`settings-panel-section ${className}`}>
      <div className="settings-panel-section-heading">
        <div>
          <h4 className="text-sm font-semibold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{title}</h4>
          <p className="mt-1 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{description}</p>
        </div>
      </div>
      <div>
        {children}
      </div>
    </section>
  );
}

export function SettingsModal({ onClose, readOnly = false, embedded = false }: SettingsModalProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
  });

  const [sessionClaudeCmd, setSessionClaudeCmd] = useState('');
  const [sessionCodexCmd, setSessionCodexCmd] = useState('');
  const [fontSize, setFontSize] = useState('12');
  const [appFontSize, setAppFontSize] = useState('16');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [memoryCleanupEnabled, setMemoryCleanupEnabled] = useState(false);
  const [memoryCleanupThreshold, setMemoryCleanupThreshold] = useState('85');
  const [memoryCleanupIdleMinutes, setMemoryCleanupIdleMinutes] = useState('10');
  const [saved, setSaved] = useState(false);
  const [activePage, setActivePage] = useState<'session' | 'appearance' | 'enhancer' | 'server'>('session');

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
      setFontSize(s.terminal_font_size || '12');
      setAppFontSize(s.app_font_size || '16');
      setTheme(s.app_theme || DEFAULT_THEME);
      persistedThemeRef.current = s.app_theme || DEFAULT_THEME;
      setMemoryCleanupEnabled(s.memory_cleanup_enabled === 'true');
      setMemoryCleanupThreshold(s.memory_cleanup_threshold_percent || '85');
      setMemoryCleanupIdleMinutes(s.memory_cleanup_idle_minutes || '10');
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

  const memoryThreshold = Number(memoryCleanupThreshold);
  const memoryIdleMinutes = Number(memoryCleanupIdleMinutes);
  const memoryCleanupError = !Number.isFinite(memoryThreshold) || memoryThreshold < 1 || memoryThreshold > 100
    ? '内存使用率阈值须在 1% 到 100% 之间。'
    : !Number.isInteger(memoryIdleMinutes) || memoryIdleMinutes < 1 || memoryIdleMinutes > 10080
      ? '最短空闲时间须为 1 到 10080 分钟的整数。'
      : null;

  function handleSave() {
    if (memoryCleanupError) return;
    // The previewed theme is now the persisted one — don't revert it on close.
    themeCommittedRef.current = true;
    persistedThemeRef.current = theme;
    mutation.mutate({
      session_claude_command: sessionClaudeCmd,
      session_codex_command: sessionCodexCmd,
      terminal_font_size: fontSize,
      app_font_size: appFontSize,
      app_theme: theme,
      memory_cleanup_enabled: String(memoryCleanupEnabled),
      memory_cleanup_threshold_percent: memoryCleanupThreshold,
      memory_cleanup_idle_minutes: memoryCleanupIdleMinutes,
    });
  }

  const navigation = [
    { id: 'session' as const, label: '普通会话', icon: Zap },
    { id: 'appearance' as const, label: '外观', icon: Type },
    { id: 'enhancer' as const, label: '提示词增强', icon: Sparkles },
    { id: 'server' as const, label: '服务器', icon: Globe },
  ];

  return (
    <div
      className={embedded ? 'h-full min-h-0 flex' : 'fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6'}
      style={{ background: embedded ? 'transparent' : 'rgba(0,0,0,0.58)' }}
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={`settings-panel-shell ${embedded ? 'flex min-h-0 w-full flex-col overflow-hidden' : 'flex min-h-[560px] w-full flex-col overflow-hidden rounded-xl shadow-2xl'}`}
        style={{
          width: '100%',
          maxHeight: embedded ? undefined : 'calc(100vh - 48px)',
          background: 'var(--bg-secondary)',
          border: embedded ? undefined : '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {!embedded && <div
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
        </div>}

        <div className="settings-panel-workbench">
          <aside className="settings-panel-navigation" aria-label="设置分类">
            <nav className="space-y-1">
              {navigation.map((item) => {
                const Icon = item.icon;
                const active = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActivePage(item.id)}
                    aria-current={active ? 'page' : undefined}
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
          <div className="settings-panel-content">
          {readOnly && (
            <div className="settings-panel-readonly">
              <LockKeyhole className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              当前为只读模式，需要平台设置的修改权限。
            </div>
          )}
          <fieldset disabled={readOnly} className="block">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <div className="w-full">
              {/* ── LEFT COLUMN ── */}
              <div className={activePage === 'session' || activePage === 'server' ? 'space-y-3' : 'hidden'}>
                {/* Session Commands */}
                <SettingsSection title="普通会话" description="启动普通会话时使用的 CLI 命令。" className={activePage === 'session' ? '' : 'hidden'}>
                  <div className="settings-panel-commands">
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

                {/* Server */}
                <SettingsSection title="服务器" description="设置空闲会话的自动资源回收。" className={activePage === 'server' ? '' : 'hidden'}>
                  <div className="space-y-4">
                    <div className="space-y-3" style={{ borderColor: 'var(--border)' }}>
                      <label className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        <input type="checkbox" checked={memoryCleanupEnabled} onChange={(event) => setMemoryCleanupEnabled(event.target.checked)} />
                        内存不足时自动关闭空闲会话
                      </label>
                      <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>
                        每 5 秒检查服务器内存。达到阈值后，按空闲时间从长到短逐个关闭会话，直到内存使用率低于阈值。保存后生效，无需重启。
                      </p>
                      <div className="settings-panel-form-grid">
                        <label className="settings-panel-field">
                          <span>内存使用率阈值（%）</span>
                          <input type="number" min="1" max="100" step="any" value={memoryCleanupThreshold}
                            onChange={(event) => setMemoryCleanupThreshold(event.target.value)}
                            className="settings-panel-control" />
                        </label>
                        <label className="settings-panel-field">
                          <span>最短空闲时间（分钟）</span>
                          <input type="number" min="1" max="10080" step="1" value={memoryCleanupIdleMinutes}
                            onChange={(event) => setMemoryCleanupIdleMinutes(event.target.value)}
                            className="settings-panel-control" />
                        </label>
                      </div>
                      <p className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
                        空闲指没有输入和输出，且会话处于空闲或等待输入状态。正在执行指令、启动中或无法确认活动状态的会话会跳过。关闭后保留会话记录，可手动恢复。
                      </p>
                      {memoryCleanupError && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{memoryCleanupError}</p>}
                    </div>
                  </div>
                </SettingsSection>
              </div>

              {/* ── RIGHT COLUMN ── */}
              <div className={activePage === 'appearance' || activePage === 'enhancer' ? 'space-y-3' : 'hidden'}>
                {/* Appearance */}
                <SettingsSection title="外观" description="主题会即时预览；保存设置后才会长期生效。" className={activePage === 'appearance' ? '' : 'hidden'}>
                  <div className="space-y-6">
                    {/* Theme */}
                    <div className="space-y-2">
                      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        <Palette className="w-3.5 h-3.5" style={{ color: '#a855f7' }} />
                        主题
                      </label>
                      <select aria-label="界面主题" value={theme} onChange={(event) => { setTheme(event.target.value); applyTheme(event.target.value); }} className="settings-panel-control">
                        {THEMES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                      </select>
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
                <div className={activePage === 'enhancer' ? '' : 'hidden'}><PromptEnhancerSettings readOnly={readOnly} /></div>
              </div>
            </div>
          )}

          </fieldset>
          </div>
        </div>

        {/* Footer */}
        {activePage !== 'enhancer' && (!embedded || !readOnly) && <div className="settings-panel-footer">
          {mutation.isError && <p role="alert" className="mr-auto text-xs" style={{ color: 'var(--error)' }}>{mutation.error.message}</p>}
          {!embedded && <button
            onClick={onClose}
            className="settings-panel-button"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            取消
          </button>}
          {!readOnly && <button
            onClick={handleSave}
            disabled={mutation.isPending || !!memoryCleanupError}
            className="settings-panel-button settings-panel-button--primary"
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
        </div>}
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

function PromptEnhancerSettings({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['prompt-enhancer-config'],
    queryFn: () => api.promptEnhancer.config(),
  });
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<PromptEnhancerMode>('standard');
  const [contextRounds, setContextRounds] = useState('3');
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
    setContextRounds(String(config.context_rounds));
    setTimeoutMs(String(config.timeout_ms));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.promptEnhancer.updateConfig({
      enabled,
      endpoint,
      model,
      mode,
      context_rounds: Number(contextRounds),
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
    <section className="settings-panel-section">
      <div className="settings-panel-section-heading">
        <div>
          <h4>提示词增强</h4>
          <p>配置用于优化提示词的模型。API Key 保存在服务器，不会返回浏览器。</p>
        </div>
        <label className="settings-panel-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}><Loader2 className="h-3.5 w-3.5 animate-spin" />加载配置…</div>
      ) : (
        <>
          <div className="settings-panel-form-grid">
            <div className="settings-panel-field">
              <label htmlFor="enhancer-endpoint">LLM URL</label>
              <input id="enhancer-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://api.openai.com/v1" className="settings-panel-control" />
            </div>
            <div className="settings-panel-field">
              <label htmlFor="enhancer-key">API Key {keyConfigured && <span className="text-xs" style={{ color: 'var(--success)' }}>已配置</span>}</label>
              <input id="enhancer-key" type="password" autoComplete="new-password" value={apiKey}
                onChange={(event) => setApiKey(event.target.value)} placeholder={keyConfigured ? '留空保留已保存的密钥' : '输入 API Key'}
                className="settings-panel-control" />
            </div>
            <div className="settings-panel-field">
              <label htmlFor="enhancer-model">模型</label>
              <div className="settings-panel-input-action">
                <input id="enhancer-model" list="prompt-enhancer-models" value={model} onChange={(event) => setModel(event.target.value)}
                  placeholder="gpt-4.1-mini" className="settings-panel-control" />
                {!readOnly && <button type="button"
                  onClick={() => { setModelsResult(null); detectModelsMutation.mutate(); }}
                  disabled={detectModelsMutation.isPending || !endpoint.trim()}
                  className="settings-panel-button" title="从当前 LLM URL 探测可用模型">
                  {detectModelsMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  探测模型
                </button>}
              </div>
              <datalist id="prompt-enhancer-models">
                {models.map((item) => <option key={item} value={item} />)}
              </datalist>
              {modelsResult && <span role="status" className="settings-panel-help" style={{ color: modelsResult.startsWith('已发现') ? 'var(--success)' : 'var(--error)' }}>{modelsResult}</span>}
            </div>
            <div className="settings-panel-field">
              <label htmlFor="enhancer-mode">优化模式</label>
              <select id="enhancer-mode" value={mode} onChange={(event) => setMode(event.target.value as PromptEnhancerMode)} className="settings-panel-control">
                {ENHANCER_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className="settings-panel-help">{modeDescription}</span>
            </div>
            <div className="settings-panel-field">
              <label htmlFor="enhancer-context">最近上下文轮数</label>
              <input id="enhancer-context" type="number" min="0" max="10" step="1" value={contextRounds}
                onChange={(event) => setContextRounds(event.target.value)} className="settings-panel-control" />
              <span className="settings-panel-help">0 表示关闭；仅传入用户输入和模型最终回答。</span>
            </div>
            <div className="settings-panel-field">
              <label htmlFor="enhancer-timeout">超时（毫秒）</label>
              <input id="enhancer-timeout" type="number" min="1000" max="120000" step="1000" value={timeoutMs}
                onChange={(event) => setTimeoutMs(event.target.value)} className="settings-panel-control" />
            </div>
          </div>
          {!readOnly && <div className="settings-panel-actions">
            <button type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}
              className="settings-panel-button settings-panel-button--primary">
              {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : null}
              {saved ? '已保存' : '保存增强设置'}
            </button>
            <button type="button" onClick={() => { setTestResult(null); testMutation.mutate(); }}
              disabled={testMutation.isPending || !enabled} className="settings-panel-button">
              {testMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
              测试连接
            </button>
            {(saveMutation.error || testResult) && <span role="status" className="settings-panel-help"
              style={{ color: saveMutation.error || (testResult && !testResult.includes('成功')) ? 'var(--error)' : 'var(--success)' }}>
              {saveMutation.error instanceof Error ? saveMutation.error.message : testResult}
            </span>}
          </div>}
        </>
      )}
    </section>
  );
}
