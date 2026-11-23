import { DeepSeekHarnessSettings } from './DeepSeekHarnessSettings';
import { useHarnessUrl } from '../lib/deepseek-harness';
import {ProviderDeleteDialog} from './ProviderDeleteDialog';
import {AgentModelInformation} from './AgentModelInformation';
import {ProviderModelsExpansion} from './ProviderModelsExpansion';
import {ModelCatalogTable,ProviderModelActions} from './ModelCatalogTable';
import {modelCapabilitiesPayload} from './ModelPricing';
import {ProviderAdvancedSettings,ProviderConnectionFields} from './ProviderConnectionFields';
import {useProviderUsage} from '../lib/use-provider-usage';
import {CodexAccountModelExpansion,CodexAccountProvider,useCodexAccountQuota} from './CodexAccountProvider';
import {ConfigFileTable} from './ConfigFileTable';
import {BalanceSummary,useEngineBalance} from './CodexEngineBalance';
import {CodexAccountProviderEditor} from './CodexAccountProviderEditor';
import {ClaudeProviderEditor} from './ClaudeProviderEditor';
import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  Pencil,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  api,
  fetchJSON,
  type AgentConfigFile,
  type AgentManagementField,
  type AgentManagementState,
  type AgentProviderState,
  type DetectedAgentModel,
  type AgentOperationProgress,
  type CodexEnvironment,
} from "../lib/api";
import { ClaudeIcon, CodexIcon } from "./CliIcons";
import { Dialog } from "./Dialog";
import { DataTable,TableDetailRow,TableExpandButton } from './table/DataTable';
import { TableActionButton, TableActions } from './table/TableActions';
import { useTableModel, type TableColumn } from './table/use-table-model';
import "./AgentManagementPanel.css";
import "./ProviderModelTable.css";

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
  compact=false,
}: {
  field: AgentManagementField;
  value: string;
  onChange: (value: string | boolean | string[]) => void;
  disabled?: boolean;
  compact?:boolean;
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
        {!compact&&<InfoTip text={help} />}
        {field.configured && (
          <small className="agent-management-configured">已配置</small>
        )}
      </span>
      {field.type === "string-list" ? (
        <textarea
          aria-label={field.label}
          title={help}
          rows={compact?1:field.key === "launchArgs" ? 4 : 3}
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
      {!compact&&field.description && <small>{field.description}</small>}
    </label>
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
      <ConfigFileTable rows={files.map(file=>({
        label:file.description,
        path:file.path,
        format:file.format,
        status:`${file.exists?'已存在':'未创建'}${file.sensitive?' · 受保护':file.writable===false?' · 只读':''}`,
        description:file.purpose,
      }))} onOpen={file=>{
        onDirtyChange(false);
        setSelectedPath(file.path);
      }}/>
      {selected && (
        <Dialog appearance="manager"
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

function liveProviderQuery(agentId: string, provider: AgentProviderState) {
  return {
    queryKey: ['agent-provider', agentId, provider.id],
    queryFn: async () => (await api.agentManagement.provider(agentId, provider.id)).provider,
    initialData: provider,
    initialDataUpdatedAt: 0,
    staleTime: 5_000,
    refetchInterval: (query: {state: {data?: AgentProviderState}}) => query.state.data?.status === 'ready' ? false as const : 3_000,
    refetchIntervalInBackground: false,
  };
}

function ProviderEditor({
  agentId,
  provider: initialProvider,
  defaults,
  readOnly,
  onDirtyChange,
  onFileDirtyChange,
  onBusyChange,
  onRemoved,
  nativeApi = false,
  apiMode = false,
  accountMode = false,
}: {
  agentId: string;
  provider: AgentProviderState;
  defaults: AgentManagementField[];
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onFileDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onRemoved: () => void;
  nativeApi?: boolean;
  apiMode?: boolean;
  accountMode?: boolean;
}) {
  const queryClient = useQueryClient();
  const nativeDetails=useQuery({queryKey:['codex-account-details','native'],queryFn:()=>api.codexEnvironments.details('native'),enabled:nativeApi,retry:false});
  const nativeBalance=useEngineBalance('native',nativeApi&&!readOnly);
  const usage=useProviderUsage(initialProvider.id==='native'?'native':'provider:'+initialProvider.id);
  const [renameOpen,setRenameOpen]=useState(false);
  const [renameValue,setRenameValue]=useState(initialProvider.name);
  const [renameError,setRenameError]=useState('');
  const rename=useMutation({
    mutationFn:(name:string)=>api.agentManagement.updateProvider(agentId,initialProvider.id,{name}),
    onSuccess:(result)=>{
      queryClient.setQueryData(["agent-management",agentId],{state:result.state});
      const updated=result.state.providers.find(item=>item.id===initialProvider.id);
      if(updated)queryClient.setQueryData(["agent-provider",agentId,initialProvider.id],updated);
      void queryClient.invalidateQueries({queryKey:["agent-management-list"]});
      void queryClient.invalidateQueries({queryKey:["codex-environments"]});
      void queryClient.invalidateQueries({queryKey:["codex-environment-management"]});
      void queryClient.invalidateQueries({queryKey:["session-environments"]});
      setRenameOpen(false);setRenameError('');
    },
    onError:(failure:Error)=>setRenameError(failure.message),
  });

  const provider = initialProvider;
  const [displayName,setDisplayName]=useState(provider.name);
  const liveProvider = useQuery(liveProviderQuery(agentId, provider)).data;
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
  const rateField = apiMode ? provider.fields.find(field=>field.key==='providerRateMultiplier'&&!field.readOnly) : undefined;
  const rate = fields.providerRateMultiplier?.trim() ?? '';
  const rateChanged = !!rateField && rate!==valueText(rateField.value);
  const initialFields = initial();
  const [selectedModels, setSelectedModels] = useState<string[]>(
    provider.models,
  );
  const rateOnly = rateChanged && !saveApiKey && displayName.trim()===provider.name &&
    JSON.stringify(selectedModels)===JSON.stringify(provider.models) &&
    provider.fields.every(field=>field.key==='providerRateMultiplier'||fields[field.key]===initialFields[field.key]);
  const availableModels = provider.id === "native"
    ? splitLines(fields.models || "")
    : selectedModels;
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runtimeOpen,setRuntimeOpen]=useState(false),[filesOpen,setFilesOpen]=useState(false);
  const [modelsSaving]=useState(false);
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
  const providerSignature=JSON.stringify([provider.id,provider.fields]);
  const initializedSignature=useRef(providerSignature);
  dirtyRef.current = onDirtyChange;
  useEffect(() => {
    if(initializedSignature.current===providerSignature)return;
    initializedSignature.current=providerSignature;
    setFields(initial());
    setDisplayName(provider.name);
    setError("");
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
  }, [provider.id, provider.fields,providerSignature]);
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
      ) || displayName!==provider.name || saveApiKey || JSON.stringify(selectedModels)!==JSON.stringify(provider.models),
    );
  }, [fields, provider.fields, provider.models, provider.name, displayName,saveApiKey,selectedModels]);
  const beginEngineOperation = (message: string) => {
    setError("");
    setSaved(false);
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
    mutationFn: async (patches?:Parameters<typeof api.agentManagement.updateModelConfigs>[1]) => {
      if (rateOnly) {
        setError("");
        setSaved(false);
        const {state} = await api.agentManagement.updateProvider(agentId, provider.id, {
          fields: {providerRateMultiplier:rate},
        });
        return {provider:state.providers.find(item=>item.id===provider.id),state,nextModels:selectedModels,nextDefault:fields.defaultModel||''};
      }
      beginEngineOperation("正在校验 Provider 配置…");
      const discovery=provider.id==='native'?{models:detected}:await api.agentManagement.detectModels(agentId,{
        providerId:provider.id,endpoint:fields.baseUrl,apiKey:saveApiKey?fields.envKey:undefined,
      });
      if(provider.id!=='native'&&!discovery.models.length)throw Error('Provider 未返回可用模型，当前配置未保存');
      const discoveredModels=discovery.models.map(model=>model.model);
      const retained=selectedModels.filter(model=>discoveredModels.includes(model));
      const nextModels=provider.id==='native'?(discoveredModels.length?discoveredModels:availableModels):retained.length?retained:discoveredModels;
      const configuredDefault=fields.defaultModel||provider.defaultModel||'';
      const nextDefault=nextModels.includes(configuredDefault)?configuredDefault:nextModels[0]||'';
      const edited=new Map(patches?.map(patch=>[patch.model,patch]));
      const observations=discovery.models.map(model=>{
        const patch=edited.get(model.model);
        return {...model,context_window:patch?.contextWindow===undefined?model.context_window:undefined,
          input_modalities:patch?.supportsImages===undefined?model.input_modalities:undefined};
      });
      const result=await api.agentManagement.updateProviderStream(agentId, provider.id, {
        ...(provider.id!=='native'&&displayName.trim()!==provider.name?{name:displayName.trim()} : {}),
        ...(provider.fields.some((field) => field.key === "envKey") &&
        saveApiKey
          ? { apiKey: fields.envKey || "" }
          : {}),
        fields: {...Object.fromEntries(
          provider.fields.filter(field=>field.key!=='providerRateMultiplier').map((field) => [
            field.key,
            field.key === "envKey"
              ? ""
              : field.key === "models"
                ? nextModels
                : field.key === 'defaultModel'
                  ? nextDefault
                : field.type === "string-list"
                  ? field.key === "launchArgs"
                    ? splitArgumentLines(fields[field.key] || "")
                    : splitLines(fields[field.key] || "")
                  : fields[field.key] || "",
          ]),
        ),...modelCapabilitiesPayload(observations),...(rateChanged?{providerRateMultiplier:rate}:{})},
      }, recordEngineProgress);
      return {provider:result.provider,state:undefined,nextModels,nextDefault};
    },
    onSuccess: ({provider:updated,state,nextModels,nextDefault}) => {
      if (updated) queryClient.setQueryData(["agent-provider", agentId, provider.id], updated);
      if (state) queryClient.setQueryData(["agent-management", agentId], {state});
      else void queryClient.invalidateQueries({queryKey:["agent-management", agentId]});
      if (rateChanged) {
        for (const key of ['agent-model-configs','agent-model-catalog','conversation-usage-intervals','conversation-metadata-details']) {
          void queryClient.invalidateQueries({queryKey:[key]});
        }
      }
      queryClient.invalidateQueries({ queryKey: ["agent-management-list"] });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
      setSaved(true);
      setSaveApiKey(false);
      setSelectedModels(nextModels);
      setFields(current=>({...current,defaultModel:nextDefault}));
      setEngineOperation((current) => ({
        ...current,
        busy: false,
        success: !state,
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
  const saveProvider = async () => {
    try {
      await update.mutateAsync(undefined);
    } catch {
      // The mutation keeps the concrete error in OperationStatus.
    }
  };
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
      onRemoved();
    },
    onError: (failure: Error) => setError(failure.message),
  });
  const detect = useMutation({
    mutationFn: async () => {
      const endpoint=fields.baseUrl;
      const result=await api.agentManagement.detectModels(agentId, {
        providerId: provider.id,
        ...((provider.id !== "native" && provider.managed) || (provider.id === "native" && provider.authentication.mode === 'uninitialized')
          ? {
              endpoint: fields.baseUrl,
              apiKey: fields.envKey || undefined,
            }
          : {}),
      });
      return {...result,endpoint};
    },
    onSuccess: (result) => {
      const discovered=result.models.map(item=>item.model);
      const overlap=provider.models.filter(model=>discovered.includes(model));
      const next=overlap.length?overlap:discovered;
      setSelectedModels(next);
      setFields(current=>({...current,models:discovered.join('\n'),defaultModel:next.includes(current.defaultModel)?current.defaultModel:next[0]||''}));
      void queryClient.invalidateQueries({
        queryKey: ["agent-management", agentId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls"],
      });
    },
    onError: (failure: Error) => setError(failure.message),
  });
  const busy = engineOperation.busy || modelsSaving || update.isPending || detect.isPending || remove.isPending || rename.isPending;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const detected = detect.data?.endpoint===fields.baseUrl?detect.data?.models??[]:[];
  const files = (liveProvider.configFiles||[]).filter(file=>file.exists&&file.writable!==false&&!file.sensitive);
  return (
    <div className="agent-management-provider-detail provider-editor">
      <header className="agent-management-detail-heading">
        <div>
          {renameOpen&&<Dialog appearance="manager" title="重命名 Provider" busy={rename.isPending} onClose={()=>setRenameOpen(false)}><form onSubmit={event=>{event.preventDefault();if(renameValue.trim())rename.mutate(renameValue.trim());}}><label className="agent-management-field"><span>名称</span><input autoFocus aria-label="Provider 名称" maxLength={100} value={renameValue} onChange={event=>setRenameValue(event.target.value)} /></label>{renameError&&<p role="alert">{renameError}</p>}<footer className="mt-4 flex justify-end gap-2"><button type="button" className="agent-management-button" onClick={()=>setRenameOpen(false)}>取消</button><button type="submit" className="agent-management-button" disabled={rename.isPending||!renameValue.trim()}>保存</button></footer></form></Dialog>}
          <p>{liveProvider.statusText}</p>
        </div>
        <div className="agent-management-status-row">
          {provider.id==='native'&&!readOnly && <button type="button" className="agent-management-button" disabled={busy} onClick={()=>{setRenameValue(liveProvider.name);setRenameError('');setRenameOpen(true);}}>重命名</button>}
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
                disabled={engineOperation.busy || modelsSaving || readOnly || !!liveProvider.pid}
                onClick={() => void changeEngineState("start")}
              >
                启动 Engine
              </button>
              <button
                type="button"
                className="agent-management-button"
                title="停止原生 Codex Engine。所有原生会话会断开，正在执行的请求会被中断。"
                disabled={engineOperation.busy || modelsSaving || readOnly || !liveProvider.pid || usage.busy || !usage.verified}
                onClick={() => void changeEngineState("stop")}
              >
                停止 Engine
              </button>
              <button
                type="button"
                className="agent-management-button"
                title="停止并重新启动原生 Codex Engine。所有原生会话会短暂断开。"
                disabled={engineOperation.busy || modelsSaving || readOnly || usage.busy || !usage.verified}
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
              disabled={engineOperation.busy || modelsSaving || readOnly || usage.busy || !usage.verified}
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
                disabled={engineOperation.busy || modelsSaving || readOnly || usage.busy || !usage.verified}
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
              disabled={remove.isPending || modelsSaving || readOnly}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={13} />
              彻底删除
            </button>
          )}
        </div>
      </header>
      {runtimeOpen&&<Dialog appearance="manager" title="Engine 运行信息" size="lg" onClose={()=>setRuntimeOpen(false)}><dl className="provider-runtime"><dt>实际启动命令</dt><dd><pre>{liveProvider.launchCommand||'未提供'}</pre></dd><dt>CODEX_HOME</dt><dd><code>{liveProvider.codexHome||'未提供'}</code></dd><dt>认证方式</dt><dd>{liveProvider.authentication.method}</dd></dl></Dialog>}
      {provider.id==='native'&&<AgentDefaultsEditor
        agentId={agentId}
        defaults={defaults}
        readOnly={readOnly}
        onDirtyChange={onDirtyChange}
      />}
      <section className="agent-management-section agent-management-engine-settings">
        {!readOnly&&!accountMode&&<p className="codex-account-description">钱包余额：<BalanceSummary id={provider.id==='native'?'native':'provider:'+provider.id}/></p>}
        <div className="agent-management-section-title"><h4>连接配置</h4><button type="button" className="agent-management-button" onClick={()=>setRuntimeOpen(true)}><FileCode2 size={13}/>运行信息</button></div>
        {!accountMode&&provider.id==='native'&&provider.authentication.mode==='uninitialized'&&!readOnly&&<div className="agent-management-uninitialized-guide">
          <p className="agent-management-uninitialized-title">原生 Codex Provider 尚未初始化</p>
          <p className="agent-management-uninitialized-description">请选择认证方式以开始配置：</p>
          <div className="agent-management-uninitialized-options">
            <button type="button" className="agent-management-button agent-management-button-primary" onClick={()=>{
              setFields(current=>({...current,baseUrl:'',envKey:'',models:'',defaultModel:''}));
              setSaveApiKey(true);
            }}>
              <ShieldCheck size={16}/>
              配置 API Key
            </button>
            <p className="agent-management-uninitialized-hint">使用第三方兼容端点（如 OpenAI 兼容服务）</p>
          </div>
          <div className="agent-management-uninitialized-options">
            <button type="button" className="agent-management-button" disabled>
              <Activity size={16}/>
              账号登录（即将支持）
            </button>
            <p className="agent-management-uninitialized-hint">使用官方 Codex 或 ChatGPT 账号</p>
          </div>
        </div>}
        {provider.id!=='native'||provider.authentication.mode!=='uninitialized'||readOnly?<OperationStatus
          busy={
            modelsSaving || detect.isPending ||
            update.isPending ||
            engineOperation.busy ||
            remove.isPending
          }
          message={
            detect.isPending
              ? "正在探测此 Provider 的模型…"
              : update.isPending
                ? rateOnly ? "正在保存倍率…" : engineOperation.message
                : engineOperation.busy
                  ? engineOperation.message
                  : modelsSaving?"正在保存模型配置…":"正在删除 Provider…"
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
        />:null}
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

          {provider.id!=='native'&&<ProviderConnectionFields name={displayName} endpoint={fields.baseUrl||''} apiKey={fields.envKey||''}
            endpointLabel="Responses API 地址" configured={provider.fields.some(field=>field.key==='envKey'&&field.configured)} disabled={readOnly||busy}
            onChange={(field,value)=>{
              if(field==='name'){setDisplayName(value);return;}
              if(field==='apiKey')setSaveApiKey(true);
              detect.reset();
              setFields(current=>({...current,[field==='endpoint'?'baseUrl':'envKey']:value}));
            }}/>}
          {nativeApi&&<div className="agent-management-form agent-management-engine-form">
            <label className="agent-management-field agent-management-field-baseUrl"><span>Responses API 地址<b aria-label="必填">*</b><InfoTip text="保存到 Codex config.toml 当前 Provider；重启 Engine 后生效。" /></span><input aria-label="Responses API 地址" inputMode="url" value={fields.baseUrl||''} disabled={readOnly||busy} placeholder="https://api.example.com/v1" onChange={event=>setFields(current=>({...current,baseUrl:event.target.value}))}/></label>
            <label className="agent-management-field"><span>API Key{nativeBalance.data?.error!=='missing_key'&&<small className="agent-management-configured">已配置</small>}<InfoTip text="平台加密保存，不写入 config.toml 或前端回显；重启 Engine 后生效。" /></span><input aria-label="API Key" type="password" autoComplete="new-password" value={fields.envKey||''} disabled={readOnly||busy} placeholder={nativeBalance.data?.error==='missing_key'?'输入 API Key':'留空保持当前凭据'} onChange={event=>{setSaveApiKey(!!event.target.value);setFields(current=>({...current,envKey:event.target.value}));}}/></label>
            <label className="agent-management-field"><span>CODEX_HOME<InfoTip text="原生 Provider 共用当前进程的 Codex 目录；切换目录请新建独立 API Provider。" /></span><input aria-label="CODEX_HOME" value={nativeDetails.data?.details.home||provider.codexHome||''} readOnly /></label>
            <label className="agent-management-field"><span>模型<b aria-label="必填">*</b><InfoTip text="每行一个模型 ID；保存时同步 Codex 模型目录。" /></span><textarea aria-label="模型" rows={3} value={fields.models||''} disabled={readOnly||busy} onChange={event=>setFields(current=>({...current,models:event.target.value}))}/></label>
            <label className="agent-management-field"><span>默认模型<InfoTip text="新会话默认模型；必须来自上方模型列表。" /></span><input aria-label="默认模型" value={fields.defaultModel||''} disabled={readOnly||busy} onChange={event=>setFields(current=>({...current,defaultModel:event.target.value}))}/></label>
          </div>}
          {!accountMode&&provider.id==='native'&&provider.authentication.mode==='uninitialized'&&!readOnly&&saveApiKey&&<div className="agent-management-form agent-management-engine-form">
            <label className="agent-management-field agent-management-field-baseUrl"><span>Responses API 地址<b aria-label="必填">*</b><InfoTip text="保存到 Codex config.toml 当前 Provider；重启 Engine 后生效。" /></span><input aria-label="Responses API 地址" inputMode="url" value={fields.baseUrl||''} disabled={readOnly||busy} placeholder="https://api.example.com/v1" onChange={event=>setFields(current=>({...current,baseUrl:event.target.value}))}/></label>
            <label className="agent-management-field"><span>API Key<b aria-label="必填">*</b><InfoTip text="平台加密保存，不写入 config.toml 或前端回显；重启 Engine 后生效。" /></span><input aria-label="API Key" type="password" autoComplete="new-password" value={fields.envKey||''} disabled={readOnly||busy} placeholder="输入 API Key" onChange={event=>{setFields(current=>({...current,envKey:event.target.value}));}}/></label>
            <label className="agent-management-field"><span>模型<b aria-label="必填">*</b><InfoTip text="每行一个模型 ID；探测完成后自动填充。" /></span><textarea aria-label="模型" rows={3} value={fields.models||''} disabled={readOnly||busy||detect.isPending} placeholder="探测完成后显示" onChange={event=>setFields(current=>({...current,models:event.target.value}))}/></label>
            <label className="agent-management-field"><span>默认模型<InfoTip text="新会话默认模型；必须来自上方模型列表。" /></span><input aria-label="默认模型" value={fields.defaultModel||''} disabled={readOnly||busy||detect.isPending} placeholder="探测完成后显示" onChange={event=>setFields(current=>({...current,defaultModel:event.target.value}))}/></label>
            <div className="agent-management-actions">
              <button type="button" className="agent-management-button agent-management-button-primary" disabled={!fields.baseUrl||!fields.envKey||detect.isPending||busy} onClick={()=>detect.mutate()}>
                <ShieldCheck size={13}/>
                探测模型
              </button>
              <button type="button" className="agent-management-button agent-management-button-primary" disabled={update.isPending||engineOperation.busy||!fields.baseUrl||!fields.envKey||!fields.models||!fields.defaultModel} onClick={()=>update.mutate(undefined)}>
                <Save size={13}/>
                保存并初始化 Engine
              </button>
            </div>
          </div>}
          {rateField&&<div className="agent-management-form agent-management-engine-form">
            <FieldEditor field={rateField} value={fields.providerRateMultiplier||''} disabled={readOnly||busy}
              onChange={value=>setFields(current=>({...current,providerRateMultiplier:String(value)}))}/>
          </div>}
          {!accountMode&&provider.fields.some(field=>!['models','defaultModel','baseUrl','envKey','providerRateMultiplier'].includes(field.key))&&<ProviderAdvancedSettings label="Codex 设置">
           <div className="agent-management-form agent-management-engine-form">
            {provider.fields
              .filter(
                (field) =>
                  !['models','defaultModel','baseUrl','envKey','providerRateMultiplier'].includes(field.key),
              )
              .map((field) => (
                <FieldEditor
                  key={field.key}
                  field={field}
                  value={fields[field.key] || ""}
                  disabled={readOnly||modelsSaving||update.isPending}
                  compact
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
          </ProviderAdvancedSettings>}
          {nativeApi&&!readOnly&&<div className="agent-management-actions"><button type="button" className="agent-management-button agent-management-button-primary" disabled={busy||!rateOnly&&(usage.busy||!usage.verified)} onClick={()=>update.mutate(undefined)}><Save size={13}/>{rateOnly?'保存倍率':'保存连接配置并重启 Engine'}</button></div>}
          {nativeApi&&!rateOnly&&<p className="agent-management-hint">保存前会校验模型并确认 Provider 没有运行中的任务。更改地址或密钥后会重启 Engine。</p>}
      </section>
      {!readOnly&&!nativeApi&&!accountMode&&<div className="agent-management-actions"><button type="button" className="agent-management-button agent-management-button-primary" disabled={busy||!rateOnly&&(usage.busy||!usage.verified)} onClick={()=>void saveProvider()}><Save size={13}/>{rateOnly?'保存倍率':'保存并探测模型'}</button></div>}
      {!accountMode&&files.length>0&&<section className="agent-management-section provider-files"><button type="button" className="agent-management-button" aria-expanded={filesOpen} onClick={()=>setFilesOpen(!filesOpen)}><ChevronRight size={13} style={{transform:filesOpen?'rotate(90deg)':undefined}}/>配置文件 ({files.length})</button>{filesOpen&&<ConfigFiles agentId={agentId} files={files} readOnly={readOnly} onDirtyChange={onFileDirtyChange}/>}</section>}
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
  onBusyChange,
}: {
  agentId: string;
  readOnly: boolean;
  onClose: () => void;
  onEditingChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<DetectedAgentModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const probeVersion=useRef(0);
  const probeRequestVersion=useRef(0);
  const clearProbe=()=>{probeVersion.current++;setModels([]);setSelectedModels([]);setDefaultModel('');};
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
    mutationFn: async () => {
      const version=probeRequestVersion.current;
      const result=await api.agentManagement.detectModels(agentId, { endpoint: baseUrl, apiKey });
      return {...result,version};
    },
    onSuccess: (result) => {
      if(result.version!==probeVersion.current)return;
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
          ...modelCapabilitiesPayload(models),
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
  const busy = create.isPending || detect.isPending;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const canCreate = !readOnly && !busy && !!(id && baseUrl && apiKey && selectedModels.length);
  return (
    <form className="agent-management-add-provider" onSubmit={event => {
      event.preventDefault();
      if (canCreate) create.mutate();
    }}>
      <ProviderConnectionFields id={id} name={name} endpoint={baseUrl} apiKey={apiKey} endpointLabel="Responses API 地址" disabled={readOnly||create.isPending}
        onChange={(field,value)=>{
          if(field==='id')setId(value);
          if(field==='name')setName(value);
          if(field==='endpoint'){setBaseUrl(value);clearProbe();}
          if(field==='apiKey'){setApiKey(value);clearProbe();}
        }}/>
      <section className="provider-models" aria-label="Provider 模型配置">
        <ProviderModelActions selected={selectedModels.length} total={models.length} detecting={detect.isPending} disabled={readOnly||create.isPending||!baseUrl||!apiKey}
          onDetect={()=>{probeRequestVersion.current=probeVersion.current;detect.mutate();}}/>
        <ModelCatalogTable rows={models.map(model=>({model:model.model,name:model.name,metadata:model,context:model.context_window}))}
          selected={selectedModels} locked={readOnly||busy} loading={detect.isPending}
          onSelectedChange={models=>{setSelectedModels(models);setDefaultModel(current=>models.includes(current)?current:models[0]||'');}}/>
        {detect.isError&&probeRequestVersion.current===probeVersion.current&&<OperationStatus busy={false} message="正在探测 Provider 模型…" error={detect.error}/>}
      </section>
      <OperationStatus
        busy={create.isPending}
        message="正在创建 Provider、保存密钥并启动 Engine…"
        successMessage="Provider 已创建，Engine 已启动"
        error={create.isError ? create.error : undefined}
        success={create.isSuccess}
      />
      <div className="agent-management-actions">
        <button
          type="submit"
          className="agent-management-button agent-management-button-primary"
          disabled={!canCreate}
        >
          {create.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
          添加 Provider
        </button>
      </div>
    </form>
  );
}

const harnessAgent = { id: 'deepseek-harness', label: 'DeepSeek Harness' };

interface ProviderRow {
  key: string;
  state: AgentManagementState | null;
  name: string;
  connection: string | undefined;
  auth: string;
  authMode?: 'api'|'account'|null;
  balanceId?: string;
  provider?: AgentProviderState;
  environment?: CodexEnvironment;
}

function rowStatus(row: ProviderRow, provider = row.provider) {
  if (!row.state) return '已配置';
  if (!(provider?.enabled ?? row.environment?.enabled)) return '已停用';
  if (provider) return statusLabel[provider.status];
  return row.environment?.auth_mode ? '已启用' : '认证待检测';
}

const providerColumns: TableColumn<ProviderRow>[] = [
  {key:'name',title:'Provider',value:row=>row.name},
  {key:'agent',title:'Agent',value:row=>row.state?.agent.label ?? harnessAgent.label},
  {key:'auth',title:'接入方式',value:row=>row.auth},
  {key:'connection',title:'连接',value:row=>row.connection},
  {key:'rate',title:'倍率',kind:'number',interactive:false,value:providerRate},
  {key:'status',title:'状态',value:row=>rowStatus(row)},
  {key:'balance',title:'余额',value:()=>null,interactive:false},
];

function providerRate({provider,authMode}:ProviderRow) {
  if (authMode!=='api') return null;
  const field=provider?.fields.find(item=>item.key==='providerRateMultiplier');
  const value=valueText(field?.value);
  return value ? Number(value) : null;
}

function CodexQuotaSummary({id}:{id:string}) {
  const query=useCodexAccountQuota(id);
  const quota=query.data?.quota;
  if(!quota) return <span>{query.isPending?'读取中…':'暂不可用'}</span>;
  const stale=quota.stale||query.isError||(quota.resetsAt!=null&&quota.resetsAt*1000<=Date.now());
  const reset=quota.resetsAt?new Date(quota.resetsAt*1000).toLocaleString():null;
  return <span title={`周额度剩余${reset?` · 重置于 ${reset}`:''}`}>
    {quota.remainingPercent}%{stale?'（上次）':''}
  </span>;
}

function ProviderTableRow({row, readOnly, expanded, onToggle, onOpen, onError, onChanged}: {
  row: ProviderRow;
  readOnly: boolean;
  expanded:boolean;
  onToggle:()=>void;
  onOpen: () => void;
  onError: (message: string) => void;
  onChanged:(state:AgentManagementState)=>void;
}) {
  const client = useQueryClient();
  const provider = row.provider;
  const agent = row.state?.agent ?? harnessAgent;
  const agentId = agent.id;
  const [detected,setDetected] = useState<DetectedAgentModel[]>([]);
  const detect = useMutation({
    mutationFn: async () => {
      if (!provider) throw Error('当前 Provider 不支持模型探测');
      const result = await api.agentManagement.detectModels(agentId, { providerId: provider.id });
      if (!result.models.length) throw Error('Provider 未返回可用模型');
      const saved = await api.agentManagement.updateProvider(agentId, provider.id, {
        fields: { models: [...new Set(provider.models)], defaultModel: provider.defaultModel || provider.models[0] || '', ...modelCapabilitiesPayload(result.models) },
      });
      return { result, saved };
    },
    onSuccess: ({ result, saved }) => {
      setDetected(result.models);
      client.setQueryData(['agent-management', agentId], saved);
      onChanged(saved.state);
    },
    onError: (error: Error) => onError(`${row.name} · ${error.message}`),
  });
  const save = useMutation({
    mutationFn: (fields:Record<string,string>)=>api.agentManagement.updateProvider(agentId,provider!.id,{fields}),
    onMutate: ()=>onError(''),
    onSuccess: async (result)=>{
      client.setQueryData(['agent-management',agentId],result);
      const updated = result.state.providers.find(item=>item.id===provider?.id);
      if(updated)client.setQueryData(['agent-provider',agentId,updated.id],updated);
      await Promise.all([
        client.invalidateQueries({queryKey:['agent-management-list']}),
        client.invalidateQueries({queryKey:['agent-model-configs',agentId]}),
        client.invalidateQueries({queryKey:['conversation-controls']}),
        client.invalidateQueries({queryKey:['session-environments']}),
      ]);
    },
    onError: (error:Error)=>onError(`${row.name} · ${error.message}`),
  });
  const enabled = provider?.enabled ?? row.environment?.enabled;
  const status = rowStatus(row, provider);
  const rate = providerRate(row);
  const codexEnvironmentCatalog=agentId==='codex'&&(row.authMode==='account'||row.environment?.kind==='account');
  const quotaId=agentId==='codex'&&row.authMode==='account'?(row.environment?.id??'native'):undefined;
  return <Fragment><tr>
    <td>{row.state && <TableExpandButton expanded={expanded} label={`Provider ${row.name} 的模型`} onClick={onToggle}/>}</td>
    <td><strong title={provider?.name ?? row.name}>{provider?.name ?? row.name}</strong></td>
    <td><span className="agent-provider-agent"><AgentIcon id={agentId}/>{agent.label}</span></td>
    <td>{row.auth}</td>
    <td title={row.connection}>{row.connection || '—'}</td>
    <td className="agent-provider-rate">{rate==null?'—':`${rate}×`}</td>
    <td><span className="agent-provider-status" title={enabled ? provider?.statusText : undefined}>
      <span className={`agent-management-dot ${enabled ? statusTone(provider?.status ?? (row.environment?.auth_mode ? 'ready' : 'unknown')) : 'unknown'}`} />{status}
    </span></td>
    <td className="agent-provider-balance">{enabled && quotaId ? <CodexQuotaSummary id={quotaId}/>
      : !readOnly && enabled && row.balanceId ? <BalanceSummary id={row.balanceId}/> : '—'}</td>
    <td className="agent-provider-actions"><TableActions>
      {provider&&!codexEnvironmentCatalog&&<TableActionButton onClick={()=>detect.mutate()} disabled={readOnly||detect.isPending||save.isPending} aria-label={`探测 ${provider.name} 模型`}><RefreshCw size={12} className={detect.isPending?'animate-spin':undefined}/>探测模型</TableActionButton>}
      <TableActionButton onClick={onOpen} disabled={save.isPending||detect.isPending} aria-label={`${readOnly ? '查看' : '编辑'} ${provider?.name ?? row.name}${row.state?.agent.label ? ` · ${row.state.agent.label}` : ''}`}>
        {readOnly ? '查看' : <><Pencil size={12}/>编辑</>}
      </TableActionButton>
    </TableActions></td>
  </tr>
  {expanded&&<TableDetailRow columnCount={providerColumns.length+2}>
    {codexEnvironmentCatalog?<CodexAccountModelExpansion id={row.environment?.id??'native'} enabled={!!enabled}/>
      :provider?<ProviderModelsExpansion agentId={agentId} provider={provider} detected={detected} readOnly={readOnly} onChanged={onChanged}/>:null}
  </TableDetailRow>}</Fragment>;
}

type ProviderDialog = {type:'add'; agentId:string; kind:'api'|'account'} |
  {type:'edit'; row:ProviderRow; accountDetails:boolean};

export function AgentManagementPanel({readOnly = false}: {readOnly?:boolean}) {
  const client = useQueryClient();
  const harnessUrl = useHarnessUrl();
  const [settingsPage,setSettingsPage] = useState<'providers'|'models'>('providers');
  const [expandedProviders,setExpandedProviders] = useState<Set<string>>(()=>new Set());
  const [dialog, setDialog] = useState<ProviderDialog | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState('');
  const dialogStart = useRef<HTMLDivElement>(null);
  const catalog = useQuery({queryKey:['agent-management-list'],queryFn:api.agentManagement.list});
  const agents = catalog.data?.agents ?? [];
  const activeAgent = dialog?.type === 'edit' ? dialog.row.state?.agent.id : dialog?.agentId;
  const states = useQueries({queries:agents.map(({agent}) => ({
    queryKey:['agent-management',agent.id],
    queryFn:()=>api.agentManagement.get(agent.id),
    enabled:dialog?.type === 'edit' && activeAgent === agent.id,
  }))});
  const accounts = useQuery({
    queryKey:['codex-environment-management'],
    queryFn:()=>api.codexEnvironments.management(),
    enabled:!readOnly && agents.some(item=>item.agent.id==='codex'),
    retry:false,
    refetchInterval:query=>query.state.data?.environments.some(environment=>environment.enabled&&!environment.auth_mode) ? 10_000 : false,
  });
  const environments = accounts.data?.environments ?? [];
  const nativeApiConfigured = (provider?:AgentProviderState) => provider?.id==='native'
    && (provider.authentication.mode==='api' || provider.fields.some(field=>field.key==='envKey'&&field.configured)
    && !!valueText(provider.fields.find(field=>field.key==='baseUrl')?.value));
  const allStates = agents.map(({state},index)=>states[index].data?.state ?? state);
  const codex = allStates.find(state=>state.agent.id==='codex');
  const liveProviders = useQueries({queries:(codex?.providers ?? []).map(provider=>liveProviderQuery('codex',provider))});
  const providerStates = new Map(liveProviders.flatMap(query=>query.data ? [[query.data.id,query.data] as const] : []));
  const providerRows: ProviderRow[] = allStates.flatMap(state=>{
    const codex = state.agent.id==='codex';
    const providers: ProviderRow[] = state.providers.map(provider=>{
      const environment = codex ? environments.find(item=>item.id===(provider.id==='native'?'native':`provider:${provider.id}`)) : undefined;
      const liveProvider = codex ? providerStates.get(provider.id) ?? provider : provider;
      const mode = environment?.auth_mode
        ?? (nativeApiConfigured(liveProvider) || liveProvider.authentication.mode==='api' || provider.managed && !['native','official'].includes(provider.kind) ? 'api'
          : liveProvider.authentication.mode==='account' ? 'account' : null);
      return {
        key:`${state.agent.id}:${provider.id}`, state, provider:liveProvider, environment, name:liveProvider.name,
        connection:valueText(liveProvider.fields.find(field=>field.key==='baseUrl')?.value),
        auth:mode==='api'?'API Key':mode==='account'?'账号':liveProvider.authentication.mode==='api'?'API Key':provider.kind==='native'||provider.kind==='official'?'原生':'待检测',
        authMode:mode,
        balanceId:codex && mode==='api' ? environment?.id ?? `provider:${provider.id}` : undefined,
      };
    });
    if (codex) for (const environment of environments.filter(item=>item.kind==='account')) providers.push({
      key:`codex:${environment.id}`,state,environment,name:environment.name,connection:environment.connection?.username,
      auth:environment.auth_mode==='api'?'API Key':environment.auth_mode==='account'?'账号':'SSH',
      authMode:environment.auth_mode,
      balanceId:environment.auth_mode==='api'?environment.id:undefined,
    });
    return providers;
  });
  const accountRows = readOnly || settingsPage!=='providers' ? [] : providerRows.filter(row=>row.state?.agent.id==='codex'&&row.authMode==='account'
    && (row.environment?.enabled ?? row.provider?.enabled));
  const accountIdentities = useQueries({queries:accountRows.map(row=>{
    const id=row.environment?.id??'native';
    return {
      queryKey:['codex-reset-credits',id],
      queryFn:()=>fetchJSON<{account:{email:string|null}}>('/codex/environments/'+encodeURIComponent(id)+'/reset-credits'),
      staleTime:300_000,
      refetchInterval:300_000,
      retry:false,
    };
  })});
  const emailByRow = new Map(accountRows.map((row,index)=>[row.key,accountIdentities[index].data?.account?.email]));
  const rows = providerRows.map(row=>({...row,connection:emailByRow.get(row.key)||row.connection}));
  if (harnessUrl) rows.push({
    key: harnessAgent.id, state: null, name: harnessAgent.label, connection: harnessUrl, auth: '网页',
  });
  const table = useTableModel(rows, providerColumns);
  const creatable = allStates.filter(state=>state.providerManagement?.create);
  const confirmDiscard = () => !dirty && !fileDirty || window.confirm('有未保存的修改，确定丢弃吗？');
  const finish = () => {
    setDialog(null);
    setDirty(false);
    setFileDirty(false);
    setBusy(false);
  };
  const close = () => { if (!busy && confirmDiscard()) finish(); };
  useEffect(()=>{
    if (!dirty && !fileDirty) return;
    const protect = (event:BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload',protect);
    return ()=>window.removeEventListener('beforeunload',protect);
  },[dirty,fileDirty]);
  const refresh = () => {
    void catalog.refetch();
    if (!readOnly && agents.some(item=>item.agent.id==='codex')) void accounts.refetch();
    states.forEach(query=>{ if (query.data) void query.refetch(); });
    void client.invalidateQueries({queryKey:['agent-provider']});
    void client.invalidateQueries({queryKey:['codex-account-details']});
    void client.invalidateQueries({queryKey:['codex-engine-balance']});
    void client.invalidateQueries({queryKey:['codex-reset-credits']});
    void client.invalidateQueries({queryKey:['agent-weekly-quota','codex']});
  };
  const editRow = dialog?.type === 'edit' ? rows.find(row=>row.key===dialog.row.key) ?? dialog.row : null;
  const editProvider = editRow?.state?.providers.find(provider=>provider.id===editRow.provider?.id);
  const editEnvironment = editRow?.environment;
  const editNativeApi = editProvider?.id==='native' && editRow?.authMode==='api';
  const title = editRow ? `${readOnly ? '查看' : '编辑'} Provider · ${editRow.name}` : dialog?.type === 'add' && dialog.agentId === harnessAgent.id ? 'DeepSeek Harness 接入' : '新增 Provider';
  const toggleDetails = () => {
    if (dialog?.type !== 'edit' || busy || !confirmDiscard()) return;
    setDirty(false);
    setFileDirty(false);
    setDialog({...dialog,accountDetails:!dialog.accountDetails});
  };
  const showModels=settingsPage==='models';
  const navigation=<>
    <div className="agent-management-tabs" role="tablist" aria-label="Agent 配置页面">
      <button type="button" role="tab" aria-selected={settingsPage==='providers'} onClick={()=>setSettingsPage('providers')}>Provider</button>
      <button type="button" role="tab" aria-selected={showModels} onClick={()=>setSettingsPage('models')}>模型资料</button>
    </div>
    {!showModels&&<div className="agent-provider-toolbar">
      <span aria-live="polite">{table.rows.length} 个 Provider</span>
      <button type="button" className="agent-management-button" onClick={refresh} disabled={catalog.isFetching || accounts.isFetching}>
        <RefreshCw size={13} className={catalog.isFetching || accounts.isFetching ? 'animate-spin' : undefined}/>重新检测
      </button>
      {!readOnly && !catalog.isPending && <button type="button" className="agent-management-button agent-management-button-primary" onClick={()=>setDialog({type:'add',agentId:creatable[0]?.agent.id ?? harnessAgent.id,kind:'api'})}>
        <Plus size={14}/>新增 Provider
      </button>}
    </div>}
  </>;
  return <div className="agent-management-page">
    <AgentModelInformation navigation={navigation} active={showModels}/>
    {!showModels&&<>
    {accounts.isError && !readOnly && <div className="agent-management-error-box" role="alert">
      <CircleAlert size={14}/>读取 Codex 账号 Provider 失败
      <TableActionButton onClick={()=>void accounts.refetch()}>重试</TableActionButton>
    </div>}
    {rowError&&<div className="agent-management-error-box" role="alert"><CircleAlert size={14}/>{rowError}</div>}
    <DataTable label="Agent Provider" model={table} actions actionsWidth={168} expandable minWidth={900} className="agent-provider-table"
      loading={catalog.isPending} error={catalog.isError ? catalog.error.message : undefined} onRetry={refresh}
      empty={!table.rows.length} emptyMessage={rows.length ? '没有符合筛选条件的 Provider' : '暂无 Provider'}>
      {table.rows.map(row=><ProviderTableRow key={row.key} row={row} readOnly={readOnly} expanded={expandedProviders.has(row.key)}
        onToggle={()=>setExpandedProviders(current=>{const next=new Set(current);if(next.has(row.key))next.delete(row.key);else next.add(row.key);return next;})}
        onChanged={state=>client.setQueryData(['agent-management',state.agent.id],{state})} onError={setRowError}
        onOpen={()=>setDialog({type:'edit',row,accountDetails:readOnly||row.authMode==='account'||row.environment?.kind==='account'})}/>)}
    </DataTable>
    {dialog && <Dialog appearance="manager" className="agent-provider-dialog" title={title} size="image" width={1160}
      maxWidth="calc(100vw - 32px)" busy={busy} onClose={close} initialFocus={dialogStart}
      actions={dialog.type==='edit' && editRow?.state?.agent.id==='codex' &&
        (editEnvironment?.kind==='account'||editProvider?.id==='native') && !dialog.accountDetails &&
        <button type="button" className="agent-management-button" disabled={busy} onClick={toggleDetails}>{editNativeApi?'账号详情':'配置文件与状态'}</button>}>
      <div ref={dialogStart} tabIndex={-1} className="agent-provider-dialog-content">
      {dialog.type==='add' ? <>
        <div className="agent-provider-dialog-options">
          <label className="agent-management-field"><span>Agent</span><select value={dialog.agentId} disabled={busy} onChange={event=>{
            if (confirmDiscard()) { setDirty(false); setDialog({type:'add',agentId:event.target.value,kind:'api'}); }
          }}>{creatable.map(state=><option key={state.agent.id} value={state.agent.id}>{state.agent.label}</option>)}<option value={harnessAgent.id}>{harnessAgent.label}</option></select></label>
          {dialog.agentId==='codex' && <label className="agent-management-field"><span>接入类型</span><select aria-label="Provider 接入类型" value={dialog.kind} disabled={busy} onChange={event=>{
            if (confirmDiscard()) { setDirty(false); setDialog({...dialog,kind:event.target.value as 'api'|'account'}); }
          }}><option value="api">API Key</option><option value="account">Codex 登录账号</option></select></label>}
        </div>
        {dialog.agentId===harnessAgent.id ? <DeepSeekHarnessSettings url={harnessUrl} onSaved={finish} onDirtyChange={setDirty} onBusyChange={setBusy}/>
          : dialog.agentId==='claude' ? <ClaudeProviderEditor readOnly={readOnly} inDialog onSaved={finish} onDirtyChange={setDirty} onBusyChange={setBusy}/>
          : dialog.kind==='account' ? <CodexAccountProviderEditor inDialog onSaved={finish} onDirtyChange={setDirty} onBusyChange={setBusy}/>
          : <AddCodexProvider key={dialog.agentId} agentId={dialog.agentId} readOnly={readOnly} onClose={finish} onEditingChange={setDirty} onBusyChange={setBusy}/>}
      </> : editRow && (editRow.state ? <>
        {editRow.state.agent.id==='claude' && editProvider ?
          <ClaudeProviderEditor key={editRow.key} provider={editProvider} readOnly={readOnly} inDialog onSaved={finish} onDirtyChange={setDirty} onBusyChange={setBusy}/>
          : dialog.accountDetails && (editEnvironment?.kind==='account' || editProvider?.id==='native' && !editNativeApi) ?
            <CodexAccountProvider key={editRow.key} environment={editEnvironment ?? {id:'native',name:editRow.name,kind:'native',enabled:editProvider!.enabled,allowed_user_ids:null}} readOnly={readOnly} onDirtyChange={setFileDirty} nativeInfo={editProvider} onNativeEdit={toggleDetails}/>
          : editEnvironment?.kind==='account' ?
            <CodexAccountProviderEditor key={editRow.key} environment={editEnvironment} readOnly={readOnly} inDialog onSaved={finish} onRemoved={finish} onDirtyChange={setDirty} onBusyChange={setBusy}/>
          : editProvider && <ProviderEditor key={editRow.key} agentId={editRow.state.agent.id} provider={editProvider}
            defaults={editRow.state.defaults ?? []} nativeApi={editNativeApi} apiMode={editRow.authMode==='api'} accountMode={editRow.authMode==='account'} readOnly={readOnly}
            onDirtyChange={setDirty} onFileDirtyChange={setFileDirty} onBusyChange={setBusy} onRemoved={finish}/>}
      </> : <DeepSeekHarnessSettings url={harnessUrl} readOnly={readOnly} onSaved={finish} onDirtyChange={setDirty} onBusyChange={setBusy}/>)}
      </div>
    </Dialog>}
    </>}
  </div>;
}
