import {ProviderDeleteDialog} from './ProviderDeleteDialog';
import {useProviderUsage} from '../lib/use-provider-usage';
import {CodexAccountProvider} from './CodexAccountProvider';
import {CodexAccountProviderEditor} from './CodexAccountProviderEditor';
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FolderCog,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  api,
  type AgentConfigFile,
  type AgentEnvironmentVariable,
  type AgentManagementField,
  type AgentManagementState,
  type AgentProviderState,
  type DetectedAgentModel,
  type AgentModelConfig,
  type AgentOperationProgress,
} from "../lib/api";
import { ClaudeIcon, CodexIcon } from "./CliIcons";
import { Dialog } from "./Dialog";
import { DataTable } from "./table/DataTable";
import { useTableModel } from "./table/use-table-model";
import "./AgentManagementPanel.css";

const statusLabel: Record<string, string> = {
  ready: "正常",
  warning: "需注意",
  error: "异常",
  unavailable: "不可用",
  unknown: "待检测",
};
const valueText = (value: AgentManagementField["value"]) =>
  Array.isArray(value) ? value.join("\n") : value == null ? "" : String(value);
const splitLines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
const splitArgumentLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

function InfoTip({ text }: { text: string }) {
  return (
    <span
      className="agent-management-info-tip"
      role="note"
      tabIndex={0}
      aria-label={text}
      title={text}
    >
      <Info size={11} aria-hidden="true" />
    </span>
  );
}

function AgentIcon({ id }: { id: string }) {
  if (id === "codex")
    return <CodexIcon className="agent-management-agent-icon" />;
  if (id === "claude")
    return <ClaudeIcon className="agent-management-agent-icon" />;
  return <Activity className="agent-management-agent-icon" />;
}

function FieldEditor({
  field,
  value,
  onChange,
  disabled,
}: {
  field: AgentManagementField;
  value: string;
  onChange: (value: string | boolean | string[]) => void;
  disabled?: boolean;
}) {
  const displayValue =
    field.type === "password" && field.configured && value !== "configured"
      ? ""
      : value;
  const help =
    field.description ||
    (field.required ? `${field.label}为必填项。` : `${field.label}。`);
  return (
    <label
      className={`agent-management-field agent-management-field-${field.key}`}
      title={help}
    >
      <span>
        {field.label}
        {field.required && <b aria-label="必填">*</b>}
        <InfoTip text={help} />
        {field.configured && (
          <small className="agent-management-configured">已配置</small>
        )}
      </span>
      {field.type === "string-list" ? (
        <textarea
          aria-label={field.label}
          title={help}
          rows={field.key === "launchArgs" ? 4 : 3}
          value={value}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={(event) => onChange(splitLines(event.target.value))}
        />
      ) : field.type === "select" ? (
        <select
          aria-label={field.label}
          title={help}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "toggle" ? (
        <span className="agent-management-toggle">
          <input
            aria-label={field.label}
            title={help}
            type="checkbox"
            checked={value === "true"}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          {value === "true" ? "已启用" : "未启用"}
        </span>
      ) : (
        <input
          aria-label={field.label}
          title={help}
          type={field.type === "password" ? "password" : "text"}
          value={displayValue}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.description && <small>{field.description}</small>}
    </label>
  );
}

function ModelSelector({
  provider,
  detected,
  selected,
  onSelectedChange,
  onDetect,
  detecting,
  error,
}: {
  provider: AgentProviderState;
  detected: DetectedAgentModel[];
  selected: string[];
  onSelectedChange: (models: string[]) => void;
  onDetect: () => void;
  detecting: boolean;
  error?: string;
}) {
  const available = detected.length
    ? detected
    : provider.models.map((model) => ({ model, name: model }));
  return (
    <div className="agent-management-model-picker">
      <div className="agent-management-model-picker-heading">
        <div>
          <strong>
            可用模型
            <InfoTip text="探测会读取当前 Engine 的模型目录。勾选后的模型可保存到该 Provider，并用于新会话。" />
          </strong>
          <p>
            探测时从当前 Engine 读取；未探测时显示已经保存到该 Provider 的模型。
          </p>
        </div>
        <button
          type="button"
          className="agent-management-button"
          disabled={detecting}
          title="读取当前 Provider Engine 返回的模型列表；不会发送模型请求，也不会消耗模型额度。"
          onClick={onDetect}
        >
          {detecting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Search size={13} />
          )}
          探测此 Provider 模型
        </button>
      </div>
      {available.length ? (
        <div className="agent-management-model-options">
          {available.map((item) => (
            <label
              key={item.model}
              title={`${item.name}（${item.model}）：${
                selected.includes(item.model) ? "已勾选" : "未勾选"
              }。勾选后保存到 Provider 模型目录。`}
            >
              <input
                type="checkbox"
                checked={selected.includes(item.model)}
                onChange={(event) =>
                  onSelectedChange(
                    event.target.checked
                      ? [...selected, item.model]
                      : selected.filter((model) => model !== item.model),
                  )
                }
              />
              <span>{item.name}</span>
              <code>{item.model}</code>
            </label>
          ))}
        </div>
      ) : (
        <div className="agent-management-model-empty">
          <Search size={14} />
          <span>
            {provider.id === "native"
              ? "当前原生 Engine 尚未返回模型。点击“探测此 Provider 模型”读取。"
              : "尚未保存或发现模型。请确认 API Key 有效后探测。"}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="agent-management-error">
          {error}
        </p>
      )}
    </div>
  );
}

function statusTone(status: string) {
  return status === "ready"
    ? "ready"
    : status === "error"
      ? "error"
      : status === "warning"
        ? "warning"
        : "unknown";
}

export function OperationStatus({
  busy,
  message,
  successMessage = "操作已完成",
  progress,
  error,
  success,
}: {
  busy?: boolean;
  message: string;
  successMessage?: string;
  progress?: number;
  error?: unknown;
  success?: boolean;
}) {
  const failure =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!busy && !failure && !success) return null;
  return (
    <div
      className={`agent-management-operation ${failure ? "error" : success ? "success" : "busy"}`}
      role={failure ? "alert" : "status"}
      aria-live="polite"
    >
      {failure ? (
        <CircleAlert size={13} />
      ) : busy ? (
        <Loader2 size={13} className="animate-spin" />
      ) : (
        <Check size={13} />
      )}
      <div className="agent-management-operation-copy">
        <span>{failure || (success && !busy ? successMessage : message)}</span>
        {busy && progress !== undefined && (
          <span
            className="agent-management-operation-progress"
            role="progressbar"
            aria-label="Engine 操作进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
          </span>
        )}
      </div>
    </div>
  );
}

function AgentDefaultsEditor({
  agentId,
  defaults,
  readOnly,
  onDirtyChange,
}: {
  agentId: string;
  defaults: AgentManagementField[];
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;
  const editable = defaults.filter((field) => !field.readOnly);
  const initial = () =>
    Object.fromEntries(
      editable.map((field) => [field.key, valueText(field.value)]),
    );
  const initialKey = JSON.stringify(initial());
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saved, setSaved] = useState(false);
  const activeKey = useRef(initialKey);
  useEffect(() => {
    if (activeKey.current === initialKey) return;
    activeKey.current = initialKey;
    setValues(JSON.parse(initialKey));
  }, [initialKey]);
  useEffect(() => {
    const original = JSON.parse(initialKey) as Record<string, string>;
    dirtyRef.current(
      editable.some((field) => values[field.key] !== original[field.key]),
    );
  }, [initialKey, values]);
  const save = useMutation({
    mutationFn: () =>
      api.agentManagement.updateDefaults(
        agentId,
        Object.fromEntries(
          editable.map((field) => [
            field.key,
            field.type === "string-list"
              ? splitLines(values[field.key] || "")
              : values[field.key] || "",
          ]),
        ),
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(["agent-management", agentId], {
        state: result.state,
      });
      void queryClient.invalidateQueries({
        queryKey: ["agent-management-list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
      setSaved(true);
      onDirtyChange(false);
      setTimeout(() => setSaved(false), 1800);
    },
  });
  if (!editable.length) return null;
  return (
    <section className="agent-management-section agent-management-defaults">
      <div className="agent-management-section-title">
        <div>
          <h4>会话默认值</h4>
          <p>保存后用于新会话；当前会话不受影响。</p>
        </div>
      </div>
      <div className="agent-management-form">
        {editable.map((field) => (
          <FieldEditor
            key={field.key}
            field={field}
            value={values[field.key] || ""}
            disabled={readOnly}
            onChange={(value) =>
              setValues((current) => ({
                ...current,
                [field.key]: Array.isArray(value)
                  ? value.join("\n")
                  : String(value),
              }))
            }
          />
        ))}
      </div>
      {!readOnly && (
        <div className="agent-management-actions">
          <button
            type="button"
            className="agent-management-button agent-management-button-primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : saved ? (
              <Check size={13} />
            ) : (
              <Save size={13} />
            )}
            {saved ? "已保存" : "保存默认值"}
          </button>
        </div>
      )}
      <OperationStatus
        busy={save.isPending}
        message="正在保存 Agent 默认值…"
        successMessage="Agent 默认值已保存"
        error={save.isError ? save.error : undefined}
        success={saved}
      />
    </section>
  );
}

function ConfigFileEditor({
  agentId,
  file,
  readOnly,
  active,
  onDirtyChange,
}: {
  agentId: string;
  file: AgentConfigFile;
  readOnly: boolean;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["agent-config-file", agentId, file.path],
    queryFn: () =>
      api.agentManagement.readFile(agentId, file.path, file.writable === false),
    enabled: active,
  });
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setDraft(query.data.file.content);
    setLoaded(true);
  }, [query.data]);
  useEffect(() => {
    onDirtyChange(
      active && loaded && !!query.data && draft !== query.data.file.content,
    );
  }, [active, draft, loaded, onDirtyChange, query.data]);
  const save = useMutation({
    mutationFn: () =>
      api.agentManagement.writeFile(agentId, {
        path: file.path,
        content: draft,
        expectedContent: query.data?.file.content ?? "",
      }),
    onSuccess: (result) => {
      setSaved(true);
      queryClient.setQueryData(
        ["agent-config-file", agentId, file.path],
        result,
      );
      setDraft(result.file.content);
      setLoaded(true);
      void queryClient.invalidateQueries({
        queryKey: ["agent-management", agentId],
      });
      if (agentId === "codex")
        void queryClient.invalidateQueries({
          queryKey: ["conversation-controls"],
        });
      setTimeout(() => setSaved(false), 1800);
    },
  });
  if (!active) return null;
  return (
    <section
      className="agent-management-file"
      aria-label={`${file.description} 编辑器`}
    >
      <header
        className="agent-management-file-heading"
        title={file.purpose || file.description}
      >
        {file.sensitive ? <ShieldCheck size={15} /> : <FileCode2 size={15} />}
        <span>
          <strong>{file.description}</strong>
          <code>{file.path}</code>
        </span>
        <span className="agent-management-file-format">{file.format}</span>
      </header>
      <div className="agent-management-file-body">
        {query.isPending ? (
          <div className="agent-management-loading">
            <Loader2 size={14} className="animate-spin" />
            读取文件…
          </div>
        ) : query.isError ? (
          <p role="alert" className="agent-management-error">
            {query.error.message}
          </p>
        ) : (
          <textarea
            aria-label={`${file.description} 内容`}
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
        )}
        {file.writable === false && (
          <p className="agent-management-hint">
            敏感文件以只读方式查看，不能在此修改。
          </p>
        )}
        {file.exists === false && (
          <p className="agent-management-hint">
            文件尚不存在。保存后会在对应目录创建。
          </p>
        )}
        <OperationStatus
          busy={save.isPending}
          message="正在写入配置文件…"
          successMessage="配置文件已写入"
          error={save.isError ? save.error : undefined}
          success={saved}
        />
        {!readOnly && file.writable !== false && loaded && (
          <div className="agent-management-file-actions">
            <button
              type="button"
              className="agent-management-button agent-management-button-primary"
              disabled={save.isPending || draft === query.data?.file.content}
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : saved ? (
                <Check size={13} />
              ) : (
                <Save size={13} />
              )}
              {saved ? "已写入" : "保存文件"}
            </button>
            <button
              type="button"
              className="agent-management-button"
              disabled={save.isPending}
              onClick={() => {
                if (
                  loaded &&
                  query.data &&
                  draft !== query.data.file.content &&
                  !window.confirm("放弃此文件的未保存修改并重新读取吗？")
                )
                  return;
                void query.refetch();
              }}
            >
              <RefreshCw size={13} />
              重新读取
            </button>
            <span>
              {agentId === "codex"
                ? "保存后自动重启对应 Engine；当前会话不会自动迁移。"
                : "保存后由 Claude Code 在后续请求中读取。"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function ConfigFiles({
  agentId,
  files,
  readOnly,
  onDirtyChange,
}: {
  agentId: string;
  files: AgentConfigFile[];
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [selectedPath, setSelectedPath] = useState("");
  const selected = files.find((file) => file.path === selectedPath);
  return (
    <>
      <div className="agent-management-file-list">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className="agent-management-file-list-item"
            title={file.purpose || file.description}
            onClick={() => {
              onDirtyChange(false);
              setSelectedPath(file.path);
            }}
          >
            {file.sensitive ? (
              <ShieldCheck size={15} />
            ) : (
              <FileCode2 size={15} />
            )}
            <span>
              <strong>{file.description}</strong>
              <code>{file.path}</code>
              <em>{file.purpose || "查看详细配置内容"}</em>
            </span>
            <small>{file.writable === false ? "只读" : file.format}</small>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      {selected && (
        <Dialog
          title={selected.description}
          size="lg"
          width={980}
          onClose={() => setSelectedPath("")}
        >
          <ConfigFileEditor
            agentId={agentId}
            file={selected}
            readOnly={readOnly}
            active
            onDirtyChange={onDirtyChange}
          />
        </Dialog>
      )}
    </>
  );
}

function ProviderCard({
  state,
  selected,
  onSelect,
}: {
  state: AgentProviderState;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="agent-management-provider"
      title={`${state.name}：${state.statusText}。点击查看并管理此 Engine。`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className={`agent-management-dot ${statusTone(state.status)}`} />
      <span className="agent-management-provider-copy">
        <strong>{state.name}</strong>
        <small>
          {state.id} · {state.statusText}
        </small>
      </span>
      <ChevronRight size={14} />
    </button>
  );
}

function LiveProviderCard({
  agentId,
  state,
  selected,
  onSelect,
}: {
  agentId: string;
  state: AgentProviderState;
  selected: boolean;
  onSelect: () => void;
}) {
  const query = useQuery({
    queryKey: ["agent-provider", agentId, state.id],
    queryFn: async () =>
      (await api.agentManagement.provider(agentId, state.id)).provider,
    initialData: state,
    initialDataUpdatedAt: 0,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.status === "ready" ? false : 3_000,
    refetchIntervalInBackground: false,
  });
  return (
    <ProviderCard
      state={query.data}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

function ModelConfigTable({
  agentId,
  providerId,
  readOnly,
  onDirtyChange,
  onReload,
}: {
  agentId: string;
  providerId: string;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["agent-model-configs", agentId, providerId],
    queryFn: () => api.agentManagement.modelConfigs(agentId),
  });
  const [rows, setRows] = useState<AgentModelConfig[]>([]);
  const [written, setWritten] = useState(false);
  const [dirty, setDirty] = useState(false);
  const table = useTableModel(rows, [
    { key: "model", title: "模型", value: (row) => row.name },
    {
      key: "contextWindow",
      title: "上下文长度",
      value: (row) => row.contextWindow,
      kind: "number",
    },
    {
      key: "maxContextWindow",
      title: "最大上下文",
      value: (row) => row.maxContextWindow,
      kind: "number",
    },
    {
      key: "effectiveContextWindowPercent",
      title: "有效比例",
      value: (row) => row.effectiveContextWindowPercent,
      kind: "number",
    },
    {
      key: "supportsImages",
      title: "图片输入",
      value: (row) => row.supportsImages,
    },
    {
      key: "actual",
      title: "实际窗口",
      value: (row) =>
        row.contextWindow && row.effectiveContextWindowPercent
          ? Math.round(
              (row.contextWindow * row.effectiveContextWindowPercent) / 100,
            )
          : null,
      kind: "number",
    },
  ]);
  useEffect(() => {
    const next = (query.data?.models || []).filter(
      (item) =>
        item.provider === providerId ||
        (providerId === "native" && item.provider === "wanzhao"),
    );
    setRows(next);
    setDirty(false);
    onDirtyChange(false);
  }, [onDirtyChange, providerId, query.data]);
  const update = (model: string, patch: Partial<AgentModelConfig>) => {
    setRows((current) =>
      current.map((item) =>
        item.model === model ? { ...item, ...patch } : item,
      ),
    );
    setDirty(true);
    setWritten(false);
    onDirtyChange(true);
  };
  const save = useMutation({
    mutationFn: () =>
      api.agentManagement.updateModelConfigs(
        agentId,
        rows.map((item) => ({
          provider: item.provider,
          model: item.model,
          contextWindow: item.contextWindow,
          maxContextWindow: item.maxContextWindow,
          effectiveContextWindowPercent: item.effectiveContextWindowPercent,
          supportsImages: item.supportsImages,
        })),
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["agent-model-configs", agentId, providerId],
        result,
      );
      setWritten(true);
      setDirty(false);
      onDirtyChange(false);
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
    },
  });
  if (query.isPending)
    return <p className="agent-management-hint">读取模型配置…</p>;
  if (query.isError)
    return <p className="agent-management-error">{query.error.message}</p>;
  return (
    <section className="agent-management-section">
      <div className="agent-management-section-title">
        <div>
          <h4>
            模型参数
            <InfoTip text="这些参数写入当前 Provider 的模型目录。保存文件不会热更新 Engine；需要重载后新进程才会读取。" />
          </h4>
          <p>
            每个模型一行；保存会写回模型目录，点击重载后 Engine 才加载新值。
          </p>
        </div>
        <div className="agent-management-status-row">
          <button
            type="button"
            className="agent-management-button agent-management-button-primary"
            title="只把当前表格写入该 Provider 的模型目录，不发送模型请求。"
            disabled={readOnly || save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Save size={13} />
            )}
            写入配置文件
          </button>
          <button
            type="button"
            className="agent-management-button"
            title="重启当前 Provider Engine，使模型目录参数生效；不影响其他 Provider。"
            disabled={readOnly}
            onClick={() => {
              if (
                providerId === "native" &&
                !window.confirm(
                  "原生 Codex Engine 由所有原生会话共享。重启会断开现有连接并中断正在执行的请求，确定继续吗？",
                )
              )
                return;
              onReload();
            }}
          >
            <RefreshCw size={13} />
            重载 Engine
          </button>
        </div>
      </div>
      <DataTable
        label="模型参数"
        model={table}
        minWidth={820}
        className="agent-management-model-table"
        empty={rows.length === 0}
        emptyMessage="暂无可配置模型"
      >
        {table.rows.map((row) => {
          const actual =
            row.contextWindow && row.effectiveContextWindowPercent
              ? Math.round(
                  (row.contextWindow * row.effectiveContextWindowPercent) / 100,
                )
              : null;
          return (
            <tr key={row.model}>
              <td>
                <strong>{row.name}</strong>
                <code>{row.model}</code>
              </td>
              <td>
                <input
                  aria-label={`${row.model} 上下文长度`}
                  title="模型可用的上下文窗口大小，通常与模型的 token 上限一致。"
                  type="number"
                  min="1"
                  value={row.contextWindow ?? ""}
                  disabled={readOnly}
                  onChange={(event) =>
                    update(row.model, {
                      contextWindow: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                />
              </td>
              <td>
                <input
                  aria-label={`${row.model} 最大上下文`}
                  title="模型支持的最大上下文窗口。大于有效窗口时，部分上下文会被压缩或截断。"
                  type="number"
                  min="1"
                  value={row.maxContextWindow ?? ""}
                  disabled={readOnly}
                  onChange={(event) =>
                    update(row.model, {
                      maxContextWindow: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                />
              </td>
              <td>
                <input
                  aria-label={`${row.model} 有效比例`}
                  title="实际可用上下文占模型窗口的百分比，用于预留系统指令和输出空间。"
                  type="number"
                  min="1"
                  max="100"
                  value={row.effectiveContextWindowPercent ?? ""}
                  disabled={readOnly}
                  onChange={(event) =>
                    update(row.model, {
                      effectiveContextWindowPercent: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                />
                <span>%</span>
              </td>
              <td>
                <label className="agent-management-inline-toggle">
                  <input
                    type="checkbox"
                    title="勾选表示当前模型支持图片输入；保存并重载后生效。"
                    checked={row.supportsImages}
                    disabled={readOnly}
                    onChange={(event) =>
                      update(row.model, {
                        supportsImages: event.target.checked,
                      })
                    }
                  />
                  {row.supportsImages ? "支持" : "不支持"}
                </label>
              </td>
              <td>
                <span className="agent-management-model-window">
                  {actual ? `${Math.round(actual / 1000)}K` : "未配置"}
                </span>
              </td>
            </tr>
          );
        })}
      </DataTable>
      <OperationStatus
        busy={save.isPending}
        message="正在写入模型目录…"
        successMessage="模型目录已写入"
        error={save.isError ? save.error : undefined}
        success={written && !dirty}
      />
    </section>
  );
}

function EnvironmentTable({
  agentId,
  variables,
  readOnly,
  onDirtyChange,
}: {
  agentId: string;
  variables: AgentEnvironmentVariable[];
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setValues(
      Object.fromEntries(
        variables.map((variable) => [variable.name, variable.value]),
      ),
    );
    onDirtyChange(false);
  }, [onDirtyChange, variables]);
  const changed = variables.some(
    (variable) => (values[variable.name] || "") !== variable.value,
  );
  const update = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    onDirtyChange(true);
    setSaved(false);
  };
  const save = useMutation({
    mutationFn: ({ restart, save }: { restart: boolean; save: boolean }) =>
      save
        ? api.agentManagement.updateEnvironment(agentId, {
            values: Object.fromEntries(
              Object.entries(values).filter(
                ([name, value]) =>
                  value &&
                  value !==
                    variables.find((variable) => variable.name === name)?.value,
              ),
            ),
            restart,
          })
        : api.agentManagement.updateEnvironment(agentId, {
            values: {},
            clear: [],
            restart: true,
          }),
    onSuccess: () => {
      setSaved(true);
      setError("");
      onDirtyChange(false);
    },
    onError: (failure: Error) => setError(failure.message),
  });
  return (
    <section className="agent-management-section">
      <div className="agent-management-section-title">
        <div>
          <h4>环境变量</h4>
          <p>
            这些变量决定 Claude 使用的 API 地址、模型和认证方式。密钥不会回显。
          </p>
        </div>
        <div className="agent-management-status-row">
          <button
            type="button"
            className="agent-management-button agent-management-button-primary"
            disabled={readOnly || save.isPending || !changed}
            onClick={() => save.mutate({ restart: false, save: true })}
          >
            <Save size={13} />
            保存变量
          </button>
          <button
            type="button"
            className="agent-management-button"
            disabled={readOnly || save.isPending}
            onClick={() => save.mutate({ restart: true, save: changed })}
          >
            <RefreshCw size={13} />
            保存并重启
          </button>
        </div>
      </div>
      <div className="agent-management-env-table">
        {variables.map((variable) => (
          <div className="agent-management-env-row" key={variable.name}>
            <div>
              <code>{variable.name}</code>
              <p>{variable.description}</p>
            </div>
            <input
              aria-label={variable.name}
              type={variable.secret ? "password" : "text"}
              disabled={readOnly}
              value={values[variable.name] || ""}
              placeholder={
                variable.secret && variable.configured
                  ? "已配置；输入新值可替换"
                  : "未配置"
              }
              onChange={(event) => update(variable.name, event.target.value)}
            />
            <span
              className={
                variable.configured
                  ? "agent-management-env-configured"
                  : "agent-management-env-missing"
              }
            >
              {variable.configured ? "已配置" : "未配置"}
            </span>
          </div>
        ))}
      </div>
      <OperationStatus
        busy={save.isPending}
        message="正在写入 LaunchAgent 环境变量…"
        successMessage="LaunchAgent 环境变量已写入"
        error={error || (save.isError ? save.error : undefined)}
        success={saved}
      />
    </section>
  );
}

function ProviderEditor({
  agentId,
  provider: initialProvider,
  defaults,
  readOnly,
  onDirtyChange,
  onFileDirtyChange,
}: {
  agentId: string;
  provider: AgentProviderState;
  defaults: AgentManagementField[];
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onFileDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const usage=useProviderUsage(initialProvider.id==='native'?'native':'provider:'+initialProvider.id);
  const providerQuery = useQuery({
    queryKey: ["agent-provider", agentId, initialProvider.id],
    queryFn: async () =>
      (await api.agentManagement.provider(agentId, initialProvider.id))
        .provider,
    initialData: initialProvider,
    initialDataUpdatedAt: 0,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.status === "ready" ? false : 3_000,
    refetchIntervalInBackground: false,
  });
  const provider = initialProvider;
  const liveProvider = providerQuery.data;
  const initial = () =>
    Object.fromEntries(
      provider.fields.map((field) => [
        field.key,
        field.type === "password" && field.configured
          ? ""
          : valueText(field.value),
      ]),
    );
  const [fields, setFields] = useState<Record<string, string>>(initial);
  const [saveApiKey, setSaveApiKey] = useState(false);
  const [selectedModels, setSelectedModels] = useState<string[]>(
    provider.models,
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [engineOperation, setEngineOperation] = useState<{
    busy: boolean;
    message: string;
    progress: number;
    success: boolean;
    error: string;
    steps: AgentOperationProgress[];
  }>({
    busy: false,
    message: "",
    progress: 0,
    success: false,
    error: "",
    steps: [],
  });
  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;
  useEffect(() => {
    setFields(initial());
    setError("");
    setSaved(false);
    setSaveApiKey(false);
    setSelectedModels(provider.models);
    setEngineOperation({
      busy: false,
      message: "",
      progress: 0,
      success: false,
      error: "",
      steps: [],
    });
  }, [provider.id, provider.fields]);
  useEffect(() => {
    const original = Object.fromEntries(
      provider.fields.map((field) => [
        field.key,
        field.type === "password" && field.configured
          ? ""
          : valueText(field.value),
      ]),
    );
    dirtyRef.current(
      provider.fields.some(
        (field) => fields[field.key] !== original[field.key],
      ) || saveApiKey,
    );
  }, [fields, provider.fields, saveApiKey]);
  const beginEngineOperation = (message: string) => {
    setError("");
    setEngineOperation({
      busy: true,
      message,
      progress: 0,
      success: false,
      error: "",
      steps: [],
    });
  };
  const recordEngineProgress = (progress: AgentOperationProgress) => {
    setEngineOperation((current) => ({
      ...current,
      message: progress.message,
      progress: Math.max(current.progress, progress.progress),
      steps:
        current.steps.at(-1)?.stage === progress.stage
          ? [...current.steps.slice(0, -1), progress]
          : [...current.steps, progress],
    }));
  };
  const update = useMutation({
    mutationFn: () => {
      beginEngineOperation("正在校验 Provider 配置…");
      return api.agentManagement.updateProviderStream(agentId, provider.id, {
        ...(provider.fields.some((field) => field.key === "envKey") &&
        saveApiKey
          ? { apiKey: fields.envKey || "" }
          : {}),
        fields: Object.fromEntries(
          provider.fields.map((field) => [
            field.key,
            field.key === "envKey"
              ? ""
              : field.key === "models"
                ? selectedModels
                : field.type === "string-list"
                  ? field.key === "launchArgs"
                    ? splitArgumentLines(fields[field.key] || "")
                    : splitLines(fields[field.key] || "")
                  : fields[field.key] || "",
          ]),
        ),
      }, recordEngineProgress);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["agent-provider", agentId, provider.id],
        result.provider,
      );
      void queryClient.invalidateQueries({
        queryKey: ["agent-management", agentId],
      });
      queryClient.invalidateQueries({ queryKey: ["agent-management-list"] });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
      setSaved(true);
      setSaveApiKey(false);
      setEngineOperation((current) => ({
        ...current,
        busy: false,
        success: true,
        message: "Provider 配置已保存，Engine 已就绪",
        progress: 100,
      }));
      setTimeout(() => setSaved(false), 1800);
    },
    onError: (failure: Error) => {
      setError(failure.message);
      setEngineOperation((current) => ({
        ...current,
        busy: false,
        success: false,
        error: failure.message,
      }));
    },
  });
  const changeEngineState = async (
    operation: "start" | "stop" | "restart",
  ) => {
    if (
      provider.id === "native" &&
      operation !== "start" &&
      !window.confirm(
        "原生 Codex Engine 由所有原生会话共享。此操作会断开现有连接并中断正在执行的请求，确定继续吗？",
      )
    )
      return;
    beginEngineOperation("正在准备 Engine 操作…");
    try {
      const result = await api.agentManagement.providerActionStream(
        agentId,
        provider.id,
        operation,
        recordEngineProgress,
      );
      queryClient.setQueryData(
        ["agent-provider", agentId, provider.id],
        result.provider,
      );
      void queryClient.invalidateQueries({
        queryKey: ["agent-management-list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
      setEngineOperation((current) => ({
        ...current,
        busy: false,
        success: true,
        message: "Engine 操作完成",
        progress: 100,
      }));
    } catch (failure) {
      setEngineOperation((current) => ({
        ...current,
        busy: false,
        success: false,
        error:
          failure instanceof Error ? failure.message : "Engine 操作失败",
      }));
    }
  };
  const remove = useMutation({
    mutationFn: () => api.agentManagement.deleteProvider(agentId, provider.id),
    onSuccess: (result) => {
      queryClient.setQueryData(["agent-management", agentId], {
        state: result.state,
      });
      void queryClient.invalidateQueries({
        queryKey: ["agent-management-list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
      setDeleteOpen(false);
    },
    onError: (failure: Error) => setError(failure.message),
  });
  const detect = useMutation({
    mutationFn: () =>
      api.agentManagement.detectModels(agentId, {
        providerId: provider.id,
        ...(provider.id !== "native" && provider.managed
          ? {
              endpoint: fields.baseUrl,
              apiKey: saveApiKey ? fields.envKey : undefined,
            }
          : {}),
      }),
    onSuccess: (result) => {
      setSelectedModels((previous) => [
        ...new Set([...previous, ...result.models.map((item) => item.model)]),
      ]);
      void queryClient.invalidateQueries({
        queryKey: ["agent-management", agentId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
    },
    onError: (failure: Error) => setError(failure.message),
  });
  const detected = detect.data?.models || [];
  const files = (liveProvider.configFiles||[]).filter(file=>file.exists&&file.writable!==false&&!file.sensitive);
  const endpoint=liveProvider.fields.find(field=>field.key==='baseUrl')?.value;

  return (
    <div className="agent-management-provider-detail">
      <header className="agent-management-detail-heading">
        <div>
          <div className="agent-management-eyebrow">
            PROVIDER / {provider.id}
          </div>
          <h3>{liveProvider.name}</h3>
          <p>{liveProvider.statusText}</p>
        </div>
        <div className="agent-management-status-row">
          <span
            className={`agent-management-pill ${statusTone(liveProvider.status)}`}
            title={liveProvider.statusText}
          >
            {statusLabel[liveProvider.status] || liveProvider.status}
          </span>
          {liveProvider.id === "native" ? (
            <>
              <button
                type="button"
                className="agent-management-button"
                title="启动当前尚未运行的原生 Codex Engine。"
                disabled={engineOperation.busy || readOnly || !!liveProvider.pid}
                onClick={() => void changeEngineState("start")}
              >
                启动 Engine
              </button>
              <button
                type="button"
                className="agent-management-button"
                title="停止原生 Codex Engine。所有原生会话会断开，正在执行的请求会被中断。"
                disabled={engineOperation.busy || readOnly || !liveProvider.pid || usage.busy || !usage.verified}
                onClick={() => void changeEngineState("stop")}
              >
                停止 Engine
              </button>
              <button
                type="button"
                className="agent-management-button"
                title="停止并重新启动原生 Codex Engine。所有原生会话会短暂断开。"
                disabled={engineOperation.busy || readOnly || usage.busy || !usage.verified}
                onClick={() => void changeEngineState("restart")}
              >
                <RefreshCw
                  size={13}
                  className={engineOperation.busy ? "animate-spin" : ""}
                />
                重启 Engine
              </button>
            </>
          ) : liveProvider.managed && liveProvider.enabled ? (
            <button
              type="button"
              className="agent-management-button"
              title="停止并重新启动当前 Provider Engine；不影响其他 Provider。"
              disabled={engineOperation.busy || readOnly || usage.busy || !usage.verified}
              onClick={() => void changeEngineState("restart")}
            >
              <RefreshCw
                size={13}
                className={engineOperation.busy ? "animate-spin" : ""}
              />
              重启 Engine
            </button>
          ) : null}
          {liveProvider.managed && liveProvider.id !== "native" && (
            <>
              <button
                type="button"
                className="agent-management-button"
                title={
                  liveProvider.enabled
                    ? "停止当前 Provider Engine，并标记为停用。"
                    : "启用 Provider，并启动它的独立 Engine。"
                }
                disabled={engineOperation.busy || readOnly || usage.busy || !usage.verified}
                onClick={() =>
                  void changeEngineState(liveProvider.enabled ? "stop" : "start")
                }
              >
                {liveProvider.enabled ? "停用" : "启用"}
              </button>
            </>
          )}
          {liveProvider.managed && liveProvider.id !== "native" && (
            <button
              type="button"
              className="agent-management-button agent-management-button-danger"
              title="删除 Provider 的独立 Engine、socket、配置目录和加密密钥。"
              disabled={remove.isPending || readOnly}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={13} />
              彻底删除
            </button>
          )}
        </div>
      </header>
      {liveProvider.codexHome && (
        <div className="agent-management-path">
          <FolderCog size={14} />
          <span>
            <small>独立 CODEX_HOME</small>
            <code>{liveProvider.codexHome}</code>
          </span>
        </div>
      )}
      {liveProvider.launchCommand && (
        <div className="agent-management-path agent-management-launch-command">
          <FileCode2 size={14} />
          <span>
            <small>实际启动命令</small>
            <code title={liveProvider.launchCommand}>
              {liveProvider.launchCommand}
            </code>
          </span>
        </div>
      )}
      <section className="agent-management-section" aria-label="Provider 接入信息"><dl className="agent-management-kv"><div><dt>接入类型</dt><dd>{provider.id==='native'?'本机默认 Codex':'API Key / Responses API'}</dd></div><div><dt>认证方式</dt><dd>{liveProvider.authentication.method}</dd></div>{endpoint&&<div><dt>接口地址</dt><dd>{String(endpoint)}</dd></div>}<div><dt>默认模型</dt><dd>{liveProvider.defaultModel||'使用当前环境默认模型'}</dd></div><div><dt>可用模型</dt><dd>{liveProvider.models.length?liveProvider.models.join('、'):'尚未检测模型'}</dd></div></dl></section>
      {provider.id==='native'&&<AgentDefaultsEditor
        agentId={agentId}
        defaults={defaults}
        readOnly={readOnly}
        onDirtyChange={onDirtyChange}
      />}
      <section className="agent-management-section agent-management-engine-settings">
        <div className="agent-management-section-title">
          <div>
            <h4>
              Engine 配置与模型
              <InfoTip text="启动命令和参数用于创建 Codex app-server；连接信息与模型目录保存到该 Provider 的独立 CODEX_HOME。保存后只重启当前 Engine。" />
            </h4>
            <p>
              启动命令、参数和连接设置会在保存后重启此 Engine；默认模型用于新会话。
            </p>
          </div>
          <span className="agent-management-section-badge">保存后重启</span>
        </div>
        <OperationStatus
          busy={
            detect.isPending ||
            update.isPending ||
            engineOperation.busy ||
            remove.isPending
          }
          message={
            detect.isPending
              ? "正在探测此 Provider 的模型…"
              : update.isPending
                ? engineOperation.message
                : engineOperation.busy
                  ? engineOperation.message
                  : "正在删除 Provider…"
          }
          successMessage={
            detect.isSuccess
              ? "Provider 模型探测完成"
              : engineOperation.success
                ? "Engine 操作完成"
                : "Provider 已保存"
          }
          error={
            error ||
            (detect.isError
              ? detect.error
              : update.isError
                ? update.error
                : engineOperation.error
                  ? engineOperation.error
                  : remove.error)
          }
          progress={engineOperation.busy ? engineOperation.progress : undefined}
          success={saved || detect.isSuccess || engineOperation.success}
        />
        {engineOperation.steps.length > 0 && (
          <ol
            className="agent-management-operation-steps"
            aria-label="Engine 操作过程"
          >
            {engineOperation.steps.map((step, index) => (
              <li key={`${step.stage}-${index}`}>
                <span>{step.progress}%</span>
                {step.message}
              </li>
            ))}
          </ol>
        )}
        <div className="agent-management-subsection">
          <div className="agent-management-subsection-heading">
            <div>
              <h5>
                启动与连接
                <InfoTip text="启动命令作为无 shell 的可执行文件运行；附加参数每行一个 argv。API 地址、密钥和 CODEX_HOME 只作用于当前 Provider。" />
              </h5>
              <p>配置当前 Engine 如何启动，以及它连接哪个模型服务。</p>
            </div>
          </div>
          <div className="agent-management-form agent-management-engine-form">
            {provider.fields
              .filter(
                (field) =>
                  field.key !== "models" && field.key !== "defaultModel",
              )
              .map((field) => (
                <FieldEditor
                  key={field.key}
                  field={field}
                  value={fields[field.key] || ""}
                  disabled={readOnly}
                  onChange={(value) => {
                    if (field.key === "envKey") setSaveApiKey(true);
                    setFields((current) => ({
                      ...current,
                      [field.key]: Array.isArray(value)
                        ? value.join("\n")
                        : String(value),
                    }));
                  }}
                />
              ))}
          </div>
        </div>
        <div className="agent-management-subsection agent-management-model-settings">
          <div className="agent-management-subsection-heading">
            <div>
              <h5>
                模型与默认值
                <InfoTip text="已勾选模型会写入该 Provider 的模型目录。默认模型用于新开会话；当前会话不会自动迁移。" />
              </h5>
              <p>选择此 Engine 可提供的模型，并指定新会话的默认模型。</p>
            </div>
          </div>
          <ModelSelector
            provider={provider}
            detected={detected}
            selected={selectedModels}
            onSelectedChange={setSelectedModels}
            onDetect={() => detect.mutate()}
            detecting={detect.isPending}
            error={detect.isError ? detect.error.message : undefined}
          />
          <div className="agent-management-model-default-grid">
            <label
              className="agent-management-field"
              title="新开会话时优先使用的模型。留空时使用已勾选模型中的第一个。"
            >
              <span>
                默认模型
                <InfoTip text="新开会话时优先使用的模型。留空时使用已勾选模型中的第一个。修改后保存并重启 Engine 才会生效。" />
              </span>
              <select
                aria-label="默认模型"
                title="新开会话时优先使用的模型；当前会话不会自动迁移。"
                value={fields.defaultModel || ""}
                disabled={readOnly}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    defaultModel: event.target.value,
                  }))
                }
              >
                <option value="">使用已选模型中的第一个</option>
                {[
                  ...(detected.length
                    ? detected
                    : provider.models.map((model) => ({ model, name: model }))),
                ]
                  .filter((item) => selectedModels.includes(item.model))
                  .map((item) => (
                    <option key={item.model} value={item.model}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <div
              className="agent-management-provider-models"
              title="这些模型已经保存在当前 Provider 的模型目录中。"
            >
              <span>
                已保存模型
                <InfoTip text="这些模型已经保存在当前 Provider 的模型目录中；切换 Provider 时不会混用。" />
              </span>
              <div>
                {provider.models.length ? (
                  provider.models.map((model) => (
                    <code key={model}>{model}</code>
                  ))
                ) : (
                  <small>尚未保存模型</small>
                )}
              </div>
            </div>
          </div>
        </div>
        {!readOnly && (
          <div className="agent-management-actions agent-management-engine-actions">
            <span>
              保存会重启当前 Engine；当前会话不会自动迁移。
            </span>
            <button
              type="button"
              className="agent-management-button agent-management-button-primary"
              title="保存当前 Provider 的启动参数、连接信息和模型配置，并重启该 Engine。"
              disabled={update.isPending || engineOperation.busy || usage.busy || !usage.verified}
              onClick={() => update.mutate()}
            >
              {update.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : saved ? (
                <Check size={13} />
              ) : (
                <Save size={13} />
              )}
              {saved ? "已保存" : "保存并重启 Engine"}
            </button>
          </div>
        )}
      </section>
      <ModelConfigTable
        agentId={agentId}
        providerId={provider.id}
        readOnly={readOnly}
        onDirtyChange={onDirtyChange}
        onReload={() => void changeEngineState("restart")}
      />
      {files.length > 0 && (
        <section className="agent-management-section">
          <div className="agent-management-section-title">
            <div>
              <h4>配置文件</h4>
              <p>直接查看和修改此 Provider 的独立配置文件。</p>
            </div>
          </div>
          <ConfigFiles
            agentId={agentId}
            files={files}
            readOnly={readOnly}
            onDirtyChange={onFileDirtyChange}
          />
        </section>
      )}
      {deleteOpen && (
        <ProviderDeleteDialog
          environmentId={provider.id==='native'?'native':'provider:'+provider.id}
          name={provider.name}
          message={`将删除此 Provider 的 Engine、socket、独立 CODEX_HOME（${provider.codexHome || '未配置'}）、加密 API Key 和平台配置。确认前请先关闭所有占用标签页。`}
          onCancel={() => setDeleteOpen(false)}
          onDelete={() => remove.mutateAsync()}
        />
      )}
    </div>
  );
}

function AddCodexProvider({
  agentId,
  readOnly,
  onClose,
  onEditingChange,
}: {
  agentId: string;
  readOnly: boolean;
  onClose: () => void;
  onEditingChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<DetectedAgentModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  useEffect(() => {
    onEditingChange(
      !!(
        id ||
        name ||
        baseUrl ||
        apiKey ||
        selectedModels.length ||
        defaultModel
      ),
    );
  }, [
    apiKey,
    baseUrl,
    defaultModel,
    id,
    name,
    onEditingChange,
    selectedModels.length,
  ]);
  const detect = useMutation({
    mutationFn: () =>
      api.agentManagement.detectModels(agentId, { endpoint: baseUrl, apiKey }),
    onSuccess: (result) => {
      setModels(result.models);
      setSelectedModels(result.models.map((item) => item.model));
      setDefaultModel(result.models[0]?.model || "");
    },
  });
  const create = useMutation({
    mutationFn: () =>
      api.agentManagement.createProvider(agentId, {
        id,
        name: name || id,
        kind: "responses",
        enabled: true,
        apiKey,
        fields: {
          baseUrl,
          envKey: "AGENTMANAGER_PROVIDER_API_KEY",
          models: selectedModels,
          defaultModel,
          codexHome: `~/.codex-agentmanager/${id}`,
        },
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(["agent-management", agentId], {
        state: result.state,
      });
      queryClient.invalidateQueries({ queryKey: ["agent-management-list"] });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
      onClose();
    },
  });
  return (
    <div className="agent-management-add-provider">
      <div className="agent-management-add-provider-heading">
        <div>
          <h4>添加 Codex Provider</h4>
          <p>每个 Provider 使用独立 CODEX_HOME、配置文件和 Engine socket。</p>
        </div>
        <button
          type="button"
          className="agent-management-button"
          onClick={onClose}
        >
          收起
        </button>
      </div>
      <div className="agent-management-form">
        <label className="agent-management-field">
          <span>Provider ID</span>
          <input
            aria-label="Provider ID"
            value={id}
            placeholder="例如 xindu"
            onChange={(event) =>
              setId(
                event.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""),
              )
            }
          />
        </label>
        <label className="agent-management-field">
          <span>显示名称</span>
          <input
            aria-label="显示名称"
            value={name}
            placeholder="例如 Xindu"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="agent-management-field">
          <span>Responses API 地址</span>
          <input
            aria-label="Responses API 地址"
            value={baseUrl}
            placeholder="https://example.com/v1"
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setModels([]);
            }}
          />
        </label>
        <label className="agent-management-field">
          <span>API Key</span>
          <input
            aria-label="API Key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            placeholder="输入该 Provider 的 API Key"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <div className="agent-management-field agent-management-model-picker">
          <span>模型</span>
          <button
            type="button"
            className="agent-management-button"
            disabled={detect.isPending || !baseUrl || !apiKey}
            onClick={() => detect.mutate()}
          >
            {detect.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Search size={13} />
            )}
            探测模型
          </button>
          {models.length > 0 ? (
            <div className="agent-management-model-options">
              {models.map((item) => (
                <label key={item.model}>
                  <input
                    type="checkbox"
                    checked={selectedModels.includes(item.model)}
                    onChange={(event) =>
                      setSelectedModels((current) =>
                        event.target.checked
                          ? [...current, item.model]
                          : current.filter((model) => model !== item.model),
                      )
                    }
                  />
                  <span>{item.name}</span>
                  <code>{item.model}</code>
                </label>
              ))}
            </div>
          ) : (
            <small>先填写地址和 API Key，再探测该 Provider 自己的模型。</small>
          )}
          <OperationStatus
            busy={detect.isPending}
            message="正在探测 Provider 模型…"
            successMessage="Provider 模型探测完成"
            error={detect.isError ? detect.error : undefined}
            success={detect.isSuccess}
          />
        </div>
        <label className="agent-management-field">
          <span>默认模型</span>
          <select
            aria-label="默认模型"
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
          >
            <option value="">使用所选模型中的第一个</option>
            {models
              .filter((item) => selectedModels.includes(item.model))
              .map((item) => (
                <option key={item.model} value={item.model}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="agent-management-hint">
        API Key 会加密保存在本机，仅注入此 Provider 的
        Engine。创建后可在详情中继续编辑 config.toml。
      </p>
      <OperationStatus
        busy={create.isPending}
        message="正在创建 Provider、保存密钥并启动 Engine…"
        successMessage="Provider 已创建，Engine 已启动"
        error={create.isError ? create.error : undefined}
        success={create.isSuccess}
      />
      <div className="agent-management-actions">
        <button
          type="button"
          className="agent-management-button agent-management-button-primary"
          disabled={
            readOnly ||
            create.isPending ||
            !id ||
            !baseUrl ||
            !apiKey ||
            !selectedModels.length
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
          添加 Provider
        </button>
      </div>
    </div>
  );
}

function CodexWorkspace({
  agentId,
  state,
  readOnly,
  onDirtyChange,
  onFileDirtyChange,
}: {
  agentId: string;
  state: AgentManagementState;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onFileDirtyChange: (dirty: boolean) => void;
}) {
  const accounts=useQuery({queryKey:['codex-environment-management'],queryFn:()=>api.codexEnvironments.management(),retry:false,enabled:!readOnly});
  const [newKind,setNewKind]=useState<'api'|'account'>('api');
  const accountProviders=accounts.data?.environments.filter(e=>e.kind==='account')||[];
  const defaultProvider =
    state.providers.find(
      (provider) => provider.managed && provider.status === "ready",
    ) ||
    state.providers.find((provider) => provider.managed) ||
    state.providers[0];
  const [selectedProviderId, setSelectedProviderId] = useState(
    defaultProvider?.id || "",
  );
  const [adding, setAdding] = useState(false);
  const [providerDirty, setProviderDirty] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const selected =
    state.providers.find((provider) => provider.id === selectedProviderId) ||
    state.providers[0];
  const selectedAccount=accountProviders.find(e=>e.id===selectedProviderId);
  const providerDirtyChange = useCallback((dirty: boolean) => {
    setProviderDirty(dirty);
  }, []);
  const fileDirtyChange = useCallback((dirty: boolean) => {
    setFileDirty(dirty);
  }, []);
  useEffect(() => {
    onDirtyChange(providerDirty);
  }, [onDirtyChange, providerDirty]);
  useEffect(() => {
    onFileDirtyChange(fileDirty);
  }, [fileDirty, onFileDirtyChange]);
  const switchProvider = (providerId: string) => {
    if (providerId === selectedProviderId && !adding) return;
    if ((providerDirty || fileDirty) &&
      !window.confirm("当前 Provider 配置有未保存的修改，确定丢弃吗？")) return;
    setSelectedProviderId(providerId);
    setAdding(false);
    setProviderDirty(false);
    setFileDirty(false);
  };
  const toggleAdding = () => {
    if (adding) {
      setAdding(false);
      setProviderDirty(false);
      onDirtyChange(false);
      return;
    }
    if (
      (providerDirty || fileDirty) &&
      !window.confirm("当前配置有未保存的修改，确定放弃并添加 Provider 吗？")
    )
      return;
    setAdding(true);
    setProviderDirty(false);
    setFileDirty(false);
    onDirtyChange(false);
    onFileDirtyChange(false);
  };
  return (
    <div className="agent-management-codex">
      <aside className="agent-management-provider-list">
        <div className="agent-management-provider-list-heading">
          <span>模型服务</span>
          {state.providerManagement.create && !readOnly && (
            <button
              type="button"
              aria-label="添加 Provider"
              onClick={toggleAdding}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {state.providers.map((provider) => (
          <LiveProviderCard
            key={provider.id}
            agentId={agentId}
            state={provider}
            selected={provider.id === (selectedAccount?.id || selected?.id)}
            onSelect={() => switchProvider(provider.id)}
          />
        ))}
        {accountProviders.map(e=><button key={e.id} type="button" className="agent-management-provider" title={`${e.name}：本机用户 ${e.connection?.username}，${e.enabled?'已启用':'已停用'}`} aria-current={selectedAccount?.id===e.id?'true':undefined} onClick={()=>switchProvider(e.id)}><span className={`agent-management-dot ${e.enabled?'ready':'unknown'}`}/><span className="agent-management-provider-copy"><strong>{e.name}</strong><small>登录账号 · {e.connection?.username}</small><small>{e.enabled?'已启用':'已停用'} · {e.connection?.authMethod==='password'?'SSH 密码':'SSH 密钥'}</small></span><ChevronRight size={14}/></button>)}
        <p className="agent-management-provider-note">
          API 接口和登录账号分别配置；标签页可选择已授权的 Provider。
        </p>
      </aside>
      <div className="agent-management-provider-content">
        {adding ? (
          <div><label className="agent-management-field"><span>接入类型</span><select aria-label="Provider 接入类型" value={newKind} onChange={e=>{if((providerDirty||fileDirty)&&!window.confirm('放弃当前未保存修改并切换接入类型吗？'))return;setNewKind(e.target.value as 'api'|'account');setProviderDirty(false);setFileDirty(false);}}><option value="api">API Key 接入</option><option value="account">Codex 登录账号</option></select></label>
          {newKind==='account'?<CodexAccountProviderEditor onDirtyChange={providerDirtyChange} onSaved={e=>{setSelectedProviderId(e.id);setAdding(false);setProviderDirty(false);}}/>:<AddCodexProvider agentId={agentId} readOnly={readOnly} onEditingChange={providerDirtyChange} onClose={()=>{setAdding(false);setProviderDirty(false);onDirtyChange(false);}}/>}</div>
        ) : selectedAccount ? (
          <CodexAccountProvider key={selectedAccount.id} environment={selectedAccount} readOnly={readOnly} onDirtyChange={providerDirtyChange}/>
        ) : selected ? (
          <ProviderEditor
            agentId={agentId}
            provider={selected}
            defaults={state.defaults}
            readOnly={readOnly}
            onDirtyChange={providerDirtyChange}
            onFileDirtyChange={fileDirtyChange}
          />
        ) : (
          <div className="agent-management-empty">尚未配置 Provider。</div>
        )}
      </div>
    </div>
  );
}

function ClaudeWorkspace({
  agentId,
  state,
  readOnly,
  onDirtyChange,
}: {
  agentId: string;
  state: AgentManagementState;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const provider = state.providers[0];
  const [models, setModels] = useState<string[]>(provider?.models || []);
  const [selectedModels, setSelectedModels] = useState<string[]>(
    provider?.models || [],
  );
  const [defaultModel, setDefaultModel] = useState(
    provider?.defaultModel || "",
  );
  const detect = useMutation({
    mutationFn: () => api.agentManagement.detectModels(agentId),
    onSuccess: (result) => {
      const values = result.models.map((item) => item.model);
      setModels(values);
      setSelectedModels((current) =>
        current.length
          ? current.filter((model) => values.includes(model))
          : values,
      );
      setDefaultModel((current) =>
        values.includes(current) ? current : values[0] || "",
      );
    },
  });
  const save = useMutation({
    mutationFn: (restart: boolean) =>
      api.agentManagement.saveSelectedModels(
        agentId,
        selectedModels,
        defaultModel,
        restart,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["agent-management", agentId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
    },
  });
  return (
    <div className="agent-management-claude">
      <header className="agent-management-detail-heading">
        <div>
          <div className="agent-management-eyebrow">CLAUDE CODE</div>
          <h3>原生设置</h3>
          <p>{state.authentication.detail}</p>
        </div>
        <span
          className={`agent-management-pill ${statusTone(state.installation.status)}`}
        >
          {statusLabel[state.installation.status]}
        </span>
      </header>
      <section className="agent-management-section">
        <div className="agent-management-section-title">
          <div>
            <h4>安装与认证</h4>
            <p>Claude Code CLI 与凭据由原生配置管理。</p>
          </div>
        </div>
        <dl className="agent-management-kv">
          <div>
            <dt>CLI</dt>
            <dd>{state.installation.executable || "未安装"}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{state.installation.version || "未检测"}</dd>
          </div>
          <div>
            <dt>认证</dt>
            <dd>{state.authentication.method}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{provider?.statusText || state.authentication.status}</dd>
          </div>
        </dl>
      </section>
      {state.environment && (
        <EnvironmentTable
          agentId={agentId}
          variables={state.environment}
          readOnly={readOnly}
          onDirtyChange={onDirtyChange}
        />
      )}
      <AgentDefaultsEditor
        agentId={agentId}
        defaults={state.defaults}
        readOnly={readOnly}
        onDirtyChange={onDirtyChange}
      />
      <section className="agent-management-section">
        <div className="agent-management-section-title">
          <div>
            <h4>可用模型</h4>
            <p>探测 Claude Code 当前可用的模型，并选择默认模型。</p>
          </div>
          <div className="agent-management-status-row">
            <button
              type="button"
              className="agent-management-button"
              disabled={readOnly || detect.isPending}
              onClick={() => detect.mutate()}
            >
              {detect.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Search size={13} />
              )}
              探测模型
            </button>
            <button
              type="button"
              className="agent-management-button agent-management-button-primary"
              disabled={readOnly || save.isPending || !selectedModels.length}
              onClick={() => save.mutate(false)}
            >
              <Save size={13} />
              保存模型
            </button>
            <button
              type="button"
              className="agent-management-button"
              disabled={readOnly || save.isPending || !selectedModels.length}
              onClick={() => save.mutate(true)}
            >
              <RefreshCw size={13} />
              保存并重启
            </button>
          </div>
        </div>
        <div className="agent-management-model-options">
          {(models.length ? models : provider?.models || []).map((model) => (
            <label key={model}>
              <input
                type="checkbox"
                checked={selectedModels.includes(model)}
                disabled={readOnly}
                onChange={(event) =>
                  setSelectedModels((current) =>
                    event.target.checked
                      ? [...current, model]
                      : current.filter((item) => item !== model),
                  )
                }
              />
              <span>{model}</span>
            </label>
          ))}
        </div>
        <label className="agent-management-field agent-management-claude-default">
          <span>默认模型</span>
          <select
            aria-label="Claude 默认模型"
            value={defaultModel}
            disabled={readOnly}
            onChange={(event) => setDefaultModel(event.target.value)}
          >
            <option value="">使用 Claude 默认模型</option>
            {selectedModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <OperationStatus
          busy={detect.isPending || save.isPending}
          message={
            detect.isPending
              ? "正在探测 Claude 模型…"
              : "正在保存 Claude 模型选择…"
          }
          successMessage={
            save.isSuccess
              ? "Claude 模型选择已保存"
              : "Claude 模型探测完成"
          }
          error={
            save.isError
              ? save.error
              : detect.isError
                ? detect.error
                : undefined
          }
          success={save.isSuccess}
        />
        {save.isSuccess && (
          <p className="agent-management-written" role="status">
            <Check size={13} />
            已保存到 Claude 环境变量；重启后新会话生效。
          </p>
        )}
      </section>
      <section className="agent-management-section">
        <div className="agent-management-section-title">
          <div>
            <h4>配置文件</h4>
            <p>这些文件属于 Claude Code，不是 Codex Provider。</p>
          </div>
        </div>
        <ConfigFiles
          agentId={agentId}
          files={state.configFiles}
          readOnly={readOnly}
          onDirtyChange={onDirtyChange}
        />
      </section>
    </div>
  );
}

function useAgentState(agentId: string) {
  return useQuery({
    queryKey: ["agent-management", agentId],
    queryFn: () => api.agentManagement.get(agentId),
    enabled: !!agentId,
    select: (result) => result.state,
  });
}

export function AgentManagementPanel({
  readOnly = false,
}: {
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const accountCatalog = useQuery({
    queryKey: ['codex-environment-management'],
    queryFn: () => api.codexEnvironments.management(),
    enabled: false,
  });
  const catalog = useQuery({
    queryKey: ["agent-management-list"],
    queryFn: () => api.agentManagement.list(),
  });
  const [agentId, setAgentId] = useState("");
  const [providerDirty, setProviderDirty] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const dirty = providerDirty || fileDirty;
  const setProviderDirtyStable = useCallback(
    (dirty: boolean) => setProviderDirty(dirty),
    [],
  );
  const setFileDirtyStable = useCallback(
    (dirty: boolean) => setFileDirty(dirty),
    [],
  );
  const confirmDiscard = () =>
    !dirty || window.confirm("当前 Agent 配置有未保存的修改，确定丢弃吗？");
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  const agents = catalog.data?.agents || [];
  const selectedId = agentId || agents[0]?.agent.id || "";
  const stateQuery = useAgentState(selectedId);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-management-list"] });
    if (selectedId)
      void queryClient.invalidateQueries({
        queryKey: ["agent-management", selectedId],
      });
    if (selectedId)
      void queryClient.invalidateQueries({
        queryKey: ["agent-provider", selectedId],
      });
  };
  const agent = agents.find((item) => item.agent.id === selectedId);
  const state =
    stateQuery.data || (agent?.state as AgentManagementState | undefined);
  return (
    <div className="agent-management-page">
      <div className="agent-management-workbench">
        <header className="agent-management-page-heading">
          <div>
            <h3>Agent 配置</h3>
            <p>
              统一查看和管理每个 Agent 的运行时、模型与配置文件。
              {readOnly ? "当前为只读。" : "保存后立即应用。"}
            </p>
          </div>
          <button
            type="button"
            className="agent-management-button"
            onClick={refresh}
            disabled={catalog.isFetching}
          >
            <RefreshCw
              size={13}
              className={catalog.isFetching ? "animate-spin" : ""}
            />
            重新检测
          </button>
        </header>
        <div className="agent-management-agents">
          {agents.map((item) => (
            <button
              type="button"
              key={item.agent.id}
              className="agent-management-agent-tab"
              aria-current={item.agent.id === selectedId ? "true" : undefined}
              onClick={() => {
                if (item.agent.id === selectedId || confirmDiscard())
                  setAgentId(item.agent.id);
              }}
            >
              <AgentIcon id={item.agent.id} />
              <span>{item.agent.label}</span>
              <small>
                {item.agent.id === "codex"
                  ? `${((item.state as any).providers?.length || 0) + (accountCatalog.data?.environments.filter(e=>e.kind==='account').length || 0)} 个 Provider`
                  : "原生配置"}
              </small>
            </button>
          ))}
        </div>
        {catalog.isPending ? (
          <div className="agent-management-loading">
            <Loader2 size={16} className="animate-spin" />
            读取 Agent 配置…
          </div>
        ) : catalog.isError ? (
          <div className="agent-management-error-box">
            <CircleAlert size={16} />
            {catalog.error.message}
          </div>
        ) : !state ? (
          <div className="agent-management-empty">暂无可用 Agent。</div>
        ) : stateQuery.isError ? (
          <div className="agent-management-error-box">
            <CircleAlert size={16} />
            {stateQuery.error.message}
          </div>
        ) : selectedId === "codex" ? (
          <CodexWorkspace
            agentId={selectedId}
            state={state as AgentManagementState}
            readOnly={readOnly}
            onDirtyChange={setProviderDirtyStable}
            onFileDirtyChange={setFileDirtyStable}
          />
        ) : (
          <ClaudeWorkspace
            agentId={selectedId}
            state={state as AgentManagementState}
            readOnly={readOnly}
            onDirtyChange={setProviderDirtyStable}
          />
        )}
      </div>
    </div>
  );
}
