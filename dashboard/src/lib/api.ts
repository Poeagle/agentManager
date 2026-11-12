import type {AgentDescriptor} from './agents';
import {calibrateBrowserClock} from './display-clock';
import type {AiSource} from './ai-source';
import type {ConversationAttachment} from './conversation-attachments';
const API_BASE = '/api';
export interface PreviewFontReport {checked:boolean;substitutions:Array<{requested:string;replacement:string}>;omitted?:number}

function fileEndpoint(url: string, projectId?: string): string {
  return projectId ? `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(projectId)}` : url;
}

export class ApiError extends Error {readonly status:number;readonly submission?:string;constructor(message:string,status:number,submission?:string){super(message);this.status=status;this.submission=submission;}}

export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${url}`, {
    headers,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `API error: ${res.status}`,res.status,body?.submission);
  }
  return res.json();
}

async function streamProviderOperation(
  url: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PUT',
  onProgress?: (progress: AgentOperationProgress) => void,
): Promise<{provider: AgentProviderState}> {
  const response = await fetch(`${API_BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error || `API error: ${response.status}`,response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('浏览器不支持 Engine 操作进度流');
  const decoder = new TextDecoder();
  let buffer = '';
  let complete: {provider: AgentProviderState} | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type: 'progress' | 'complete' | 'error';
      stage?: string;
      message?: string;
      progress?: number;
      provider?: AgentProviderState;
      error?: string;
      status?: number;
    };
    if (event.type === 'progress' && event.stage && event.message) {
      onProgress?.({
        stage: event.stage,
        message: event.message,
        progress: event.progress ?? 0,
      });
    } else if (event.type === 'complete' && event.provider) {
      complete = { provider: event.provider };
    } else if (event.type === 'error') {
      throw new ApiError(event.error || 'Engine 操作失败', event.status || 400);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!complete) throw new Error('Engine 操作未返回完成状态');
  return complete;
}

// XMLHttpRequest reports file upload progress; fetch does not expose it.
// `onProgress` receives a 0..1 fraction.
function uploadWithProgress<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${url}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.withCredentials = true;
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T);
      } else {
        const r = xhr.response as { error?: string } | null;
        reject(new Error(r?.error || `API error: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });
}

export interface AuthUser { id: string; username: string; display_name: string; role: 'admin' | 'member'; role_ids?: string[]; disabled?: number; max_tabs?: number; can_create_projects?: number; created_at?: string; }
export type PermissionLevel = 'read' | 'write' | 'delete';
export type PermissionGrants = Record<string, PermissionLevel>;
export interface PermissionDefinition { key: string; label: string; levels: PermissionLevel[]; }
export interface PlatformRole { id: string; name: string; description: string; builtin: number; permissions: PermissionGrants; member_count: number; }
export interface MyPermissions { permissions: PermissionGrants; roles: Array<{ id: string; name: string }>; catalog: PermissionDefinition[]; }
export interface AuthStatus { needsSetup: boolean; authenticated: boolean; user: AuthUser | null; }
export interface AuthCredentials { username: string; password: string; display_name?: string; }
export interface SharedResourcesInput {
  directory: string; scope_path?: string; env_file?: string; instructions: string;
  enabled: boolean; revision: number;
}
export interface SharedResources extends SharedResourcesInput { scope_path:string;env_file:string;env_exists: boolean; }
export interface SharedEnvFile { path: string; content: string; hash: string | null; exists: boolean; revision: number; }
export type PromptEnhancerMode = 'base' | 'lite' | 'standard' | 'expert' | 'publish';
export interface PromptEnhancerConfig {
  source?:AiSource;
  enabled: boolean;
  endpoint: string;
  model: string;
  mode: PromptEnhancerMode;
  context_rounds: number;
  timeout_ms: number;
  api_key_configured: boolean;
}

export interface AgentApiEndpoint {
  category: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'WS';
  path: string;
  description: string;
  public?: boolean;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  errors?: Record<string, string>;
  incomingMessages?: unknown[];
  outgoingMessages?: unknown[];
}

export interface AgentManagementField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'toggle' | 'string-list';
  value?: string | boolean | string[] | null;
  required?: boolean;
  configured?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}
export interface AgentConfigFile {
  path: string;
  exists: boolean;
  format: string;
  description: string;
  writable?: boolean;
  sensitive?: boolean;
  purpose?: string;
}
export interface AgentProviderState {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  managed: boolean;
  status: 'ready' | 'warning' | 'error' | 'unavailable' | 'unknown';
  statusText: string;
  authentication: { status: 'authenticated' | 'missing' | 'unknown'; method: string };
  models: string[];
  defaultModel: string | null;
  fields: AgentManagementField[];
  socket?: string | null;
  pid?: number | null;
  codexHome?: string | null;
  launchCommand?: string;
  launchArgs?: string[];
  configFiles?: AgentConfigFile[];
}
export interface AgentOperationProgress {
  stage: string;
  message: string;
  progress: number;
}
export interface AgentManagementState {
  agent: AgentDescriptor;
  installation: {
    status: 'ready' | 'warning' | 'error' | 'unavailable' | 'unknown';
    executable: string | null;
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    installCommand: string;
    updateCommand: string;
    requirement?: string | null;
  };
  authentication: {
    status: 'authenticated' | 'missing' | 'unknown' | 'not_applicable';
    method: string;
    detail: string;
  };
  defaults: AgentManagementField[];
  providers: AgentProviderState[];
  configFiles: AgentConfigFile[];
  environment?: AgentEnvironmentVariable[];
  diagnostics: Array<{ id: string; status: 'ready' | 'warning' | 'error' | 'unavailable' | 'unknown'; label: string; detail: string }>;
  actions: Array<{ id: string; label: string; kind?: 'primary' | 'secondary' | 'danger'; confirm?: string; available: boolean }>;
  providerManagement: {
    create: boolean;
    update: boolean;
    delete: boolean;
    actions: string[];
    fields: AgentManagementField[];
  };
  applySemantics: {
    settings: 'immediate' | 'new_session' | 'restart';
    providers: 'immediate' | 'new_session' | 'restart';
    detail: string;
  };
  checkedAt: string;
}
export interface AgentEnvironmentVariable {
  name: string;
  value: string;
  configured: boolean;
  secret?: boolean;
  description: string;
  source: string;
  editable: boolean;
}
export interface DetectedAgentModel {
  provider?: string;
  model: string;
  name: string;
  description: string;
  efforts: Array<{ value: string; description: string }>;
  defaultEffort: string;
  default_service_tier?: string | null;
  service_tiers?: Array<{ id: string; name: string; description: string }>;
}
export interface AgentConfigFileContent { path: string; content: string; exists: boolean; format: string; restarted?: boolean; }
export interface AgentModelConfig {
  provider?: string;
  model: string;
  name: string;
  contextWindow: number | null;
  maxContextWindow: number | null;
  effectiveContextWindowPercent: number | null;
  inputModalities: string[];
  supportsImages: boolean;
  sourceFile: string | null;
}

export interface AgentApiContract {
  name: string;
  version: string;
  updatedAt: string;
  scope: string;
  description: string;
  authentication: {
    type: string;
    cookieName: string;
    loginEndpoint: string;
    capabilitiesEndpoint: string;
    login: string;
    usage: string;
    errors: Record<string, string>;
    security: string;
  };
  authorization: Record<string, string>;
  critical: string[];
  quickstart: string[];
  stateMachine: {
    states: Record<string, string>;
    transitions: Array<{ from: string; to: string; trigger: string }>;
  };
  promptTypes: Record<string, string>;
  endpoints: AgentApiEndpoint[];
  tips: string[];
  operationalGuidance: Record<string, unknown>;
}

// Sessions
export const api = {
  codexEnvironments: {
    scheduledModels:(project:string,environment:string)=>fetchJSON<{models:ConversationControlsData['models']}>(`/scheduled-tasks/codex-models?project_id=${encodeURIComponent(project)}&environment_id=${encodeURIComponent(environment)}`),
    quota:(id:string)=>fetchJSON<AgentQuotaResponse>('/codex/environments/'+encodeURIComponent(id)+'/quota'),
    configFiles:(id:string)=>fetchJSON<{files:Array<{id:string;path:string;exists:boolean;label:string;description:string;format:string;sensitive?:boolean}>}>('/codex/environments/'+encodeURIComponent(id)+'/config-files'),
    readConfigFile:(id:string,file:string)=>fetchJSON<{content:string;revision:string;exists:boolean}>('/codex/environments/'+encodeURIComponent(id)+'/config-files?file='+encodeURIComponent(file)),
    writeConfigFile:(id:string,file:string,content:string,revision:string)=>fetchJSON<{content:string;revision:string;exists:boolean}>('/codex/environments/'+encodeURIComponent(id)+'/config-files',{method:'PUT',body:JSON.stringify({file,content,revision})}),
    details:(id:string)=>fetchJSON<{details:CodexAccountDetails}>('/codex/environments/'+encodeURIComponent(id)+'/details'),
    remove:(id:string)=>fetchJSON<{ok:boolean}>('/codex/environments/'+encodeURIComponent(id),{method:'DELETE'}),
    usage:(id:string)=>fetchJSON<{tabs:ProviderUsageTab[];busy:boolean;verified:boolean}>('/codex/environments/'+encodeURIComponent(id)+'/usage'),
    closeTabs:(id:string,ids:string[])=>fetchJSON<{results:Array<{id:string;ok:boolean;error?:string}>}>('/codex/environments/'+encodeURIComponent(id)+'/close-tabs',{method:'POST',body:JSON.stringify({session_ids:ids})}),
    list:()=>fetchJSON<{environments:CodexEnvironment[]}>('/codex/environments'),
    management:()=>fetchJSON<{environments:CodexEnvironment[];users:Array<{id:string;username:string;display_name:string;role?:string}>}>('/codex/environments?management=true'),
    save:(input:{name:string;enabled:boolean;allowed_user_ids:string[]|null;connection?:CodexEnvironment['connection']},id?:string)=>fetchJSON<{environment:CodexEnvironment}>('/codex/environments'+(id?'/'+encodeURIComponent(id):''),{method:id?'PUT':'POST',body:JSON.stringify(input)}),
    checkConnection:(connection:NonNullable<CodexEnvironment['connection']>&{environment_id?:string;project_id?:string})=>fetchJSON<EnvironmentPreflight>('/codex/environments/check-connection',{method:'POST',body:JSON.stringify(connection)}),
    preflight:(id:string,projectId?:string)=>fetchJSON<EnvironmentPreflight>('/codex/environments/'+encodeURIComponent(id)+'/preflight',{method:'POST',body:JSON.stringify(projectId?{project_id:projectId}:{})}),
    forSession:(id:string)=>fetchJSON<{current:string;environments:CodexEnvironment[]}>('/sessions/'+encodeURIComponent(id)+'/environments'),
    sessionPreflight:(id:string,environment:string)=>fetchJSON<EnvironmentPreflight>('/sessions/'+encodeURIComponent(id)+'/environments/'+encodeURIComponent(environment)+'/preflight',{method:'POST',body:'{}'}),
    transfer:(id:string,input:{environment_id:string;model:string;effort:string;provider?:string})=>fetchJSON<{ok:boolean;session:Session;history_id?:string}>('/sessions/'+encodeURIComponent(id)+'/environment',{method:'POST',body:JSON.stringify(input)}),
  },

  sharedResources: {
    get: () => fetchJSON<{ resources: SharedResources }>('/me/shared-resources'),
    openEnv: () => fetchJSON<SharedEnvFile>('/me/shared-resources/env/open', { method: 'POST' }),
    createEnv: () => fetchJSON<SharedEnvFile>('/me/shared-resources/env/create', { method: 'POST' }),
    browse: (path?:string) => fetchJSON<BrowseResult>(`/me/shared-resources/browse${path?`?path=${encodeURIComponent(path)}`:''}`),
    saveEnv: (data: { content: string; expected_hash: string | null; revision: number }) => fetchJSON<{path: string; hash: string; exists: boolean}>('/me/shared-resources/env', { method: 'PUT', body: JSON.stringify(data) }),
    save: (data: SharedResourcesInput) => fetchJSON<{ resources: SharedResources }>('/me/shared-resources', { method: 'PUT', body: JSON.stringify(data) }),
    preview: (scope_path: string) => fetchJSON<{ projects: Array<{ id: string; name: string; path: string }> }>('/me/shared-resources/preview', { method: 'POST', body: JSON.stringify({ scope_path }) }),
    delete: () => fetchJSON<{ ok: boolean }>('/me/shared-resources', { method: 'DELETE' }),
  },
  auth: {
    status: () => fetchJSON<AuthStatus>('/auth/status'),
    setup: (data: AuthCredentials) => fetchJSON<{ user: AuthUser }>('/auth/setup', { method: 'POST', body: JSON.stringify(data) }),
    login: (data: AuthCredentials) => fetchJSON<{ user: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
    logout: () => fetchJSON<{ ok: boolean }>('/auth/logout', { method: 'POST', body: JSON.stringify({}) }),
    changePassword: (data: { current_password: string; new_password: string }) =>
      fetchJSON<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
  },
  users: {
    list: () => fetchJSON<{ users: AuthUser[] }>('/users'),
    create: (data: { username: string; password: string; display_name?: string; role?: 'admin' | 'member'; max_tabs?: number; can_create_projects?: boolean }) =>
      fetchJSON<{ user: AuthUser }>('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { role?: 'admin' | 'member'; disabled?: boolean; password?: string; max_tabs?: number; can_create_projects?: boolean }) =>
      fetchJSON<{ user: AuthUser }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      fetchJSON<{ ok: boolean; closed_sessions: number }>(`/users/${id}`, { method: 'DELETE' }),
  },
  rbac: {
    me: () => fetchJSON<MyPermissions>('/rbac/me'),
    roles: () => fetchJSON<{ roles: PlatformRole[]; catalog: PermissionDefinition[] }>('/rbac/roles'),
    assignableRoles: () => fetchJSON<{ roles: Array<Pick<PlatformRole, 'id' | 'name' | 'builtin'>> }>('/rbac/assignable-roles'),
    createRole: (data: { name: string; description: string; permissions: PermissionGrants }) =>
      fetchJSON<{ role: PlatformRole }>('/rbac/roles', { method: 'POST', body: JSON.stringify(data) }),
    updateRole: (id: string, data: { name: string; description: string; permissions: PermissionGrants }) =>
      fetchJSON<{ role: PlatformRole }>(`/rbac/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteRole: (id: string) => fetchJSON<{ ok: boolean }>(`/rbac/roles/${id}`, { method: 'DELETE' }),
    assignRoles: (userId: string, roleIds: string[]) =>
      fetchJSON<{ ok: boolean }>(`/rbac/users/${userId}/roles`, { method: 'PUT', body: JSON.stringify({ role_ids: roleIds }) }),
  },
  admin: {
    monitor: () => fetchJSON<AdminMonitorResponse>('/admin/monitor'),
    serverResources: () => fetchJSON<Pick<AdminMonitorResponse, 'server_resources'>>('/admin/server-resources'),
    renameMonitorTab: (userId: string, projectId: string, sessionId: string, name: string) =>
      fetchJSON<{ ok: boolean; tab: { id: string; name: string } }>(
        `/admin/monitor/users/${encodeURIComponent(userId)}/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(sessionId)}`,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      ),
    deleteMonitorTab: (userId: string, projectId: string, sessionId: string) =>
      fetchJSON<{ ok: boolean; session_continues: boolean }>(
        `/admin/monitor/users/${encodeURIComponent(userId)}/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      ),
  },
  sessions: {
    list: (status?: string, projectId?: string) => {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (projectId) query.set('project_id', projectId);
      const suffix = query.size ? `?${query.toString()}` : '';
      return fetchJSON<{ sessions: Session[] }>(`/sessions${suffix}`);
    },
    get: (id: string) => fetchJSON<{ session: Session }>(`/sessions/${id}`),
    ignoreQuestions:(id:string,questionIds:string[],ignored=true)=>fetchJSON<{ok:boolean;ignored_question_ids:string[]}>(`/sessions/${encodeURIComponent(id)}/questions/ignore`,{method:'POST',body:JSON.stringify({question_ids:questionIds,ignored})}),
    create: (data: { project_path: string; task?: string; mode?: 'session' | 'terminal'; project_id?: string; cli_type?: string;environment_id?:string }) =>
      fetchJSON<{ ok: boolean; session: Session }>('/sessions', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    kill: (id: string) =>
      fetchJSON<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
    reconnect: (id: string) =>
      fetchJSON<{ ok: boolean; session: Session }>(`/sessions/${id}/reconnect`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    discoverable: (projectPath?: string) => {
      const qs = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : '';
      return fetchJSON<{ sessions: DiscoverableSession[] }>(`/sessions/discoverable${qs}`);
    },
    adopt: (socketPath: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; session: Session }>('/sessions/adopt', {
        method: 'POST',
        body: JSON.stringify({ socket_path: socketPath, project_id: projectId }),
      }),
    output: (id: string, opts?: { before?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.before != null) qs.set('before', String(opts.before));
      if (opts?.limit != null) qs.set('limit', String(opts.limit));
      return fetchJSON<SessionOutput>(`/sessions/${id}/output?${qs}`);
    },
    pasteImage: (id: string, dataUrl: string, signal?: AbortSignal) =>
      fetchJSON<{ ok: boolean; path: string }>(`/sessions/${encodeURIComponent(id)}/paste-image`, {
        method: 'POST', body: JSON.stringify({ dataUrl }), signal,
      }),
    pasteFile: (id: string, dataUrl: string, filename: string, signal?: AbortSignal) =>
      fetchJSON<{ ok: boolean; path: string }>(`/sessions/${encodeURIComponent(id)}/paste-file`, {
        method: 'POST', body: JSON.stringify({ dataUrl, filename }), signal,
      }),
    // Resume an ended Claude/Codex conversation; reuses the same app session id.
    resume: (id: string, automatic = false) =>
      fetchJSON<{ ok: boolean; session: Session }>(`/sessions/${id}/resume`, {
        method: 'POST',
        body: JSON.stringify(automatic ? { automatic: true } : {}),
      }),
    newConversation:(id:string,preference?:AgentModelPreference)=>fetchJSON<{ok:boolean;session:Session;history_id:string;warning?:string}>(`/sessions/${encodeURIComponent(id)}/new-conversation`,{method:'POST',body:JSON.stringify({preference})}),
    compactConversation:(id:string)=>fetchJSON<{ok:boolean}>(`/sessions/${encodeURIComponent(id)}/compact`,{method:'POST'}),
    reload:(id:string)=>fetchJSON<{ok:boolean;session:Session;client_version?:string}>(`/sessions/${encodeURIComponent(id)}/reload`,{method:'POST'}),
    // Permanently delete an ended session from history (record + events + JSONL).
    deleteRecord: (id: string, stop = false) =>
      fetchJSON<{ ok: boolean }>(`/sessions/${id}/record${stop?'?stop=true':''}`, { method: 'DELETE' }),
    // Permanently delete this account's ended records for one project.
    deleteEndedRecords: (projectId: string) =>
      fetchJSON<{ ok: boolean; deleted: number; failed: number }>(`/sessions/records/ended?project_id=${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      }),
    // Claude on-disk conversation history for a project (the real, complete history).
    claudeHistory: (projectId: string) =>
      fetchJSON<{ projectId: string | null; sessions: ClaudeHistoryItem[] }>(`/sessions/claude-history?project_id=${encodeURIComponent(projectId)}`),
    resumeClaude: (data: { project_id: string; claude_session_id: string; title?: string }) =>
      fetchJSON<{ ok: boolean; session: Session }>('/sessions/resume-claude', { method: 'POST', body: JSON.stringify(data) }),
    deleteClaudeHistory: (uuid: string, projectId: string) =>
      fetchJSON<{ ok: boolean }>(`/sessions/claude-history/${encodeURIComponent(uuid)}?project_id=${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
    renderedOutput: (id: string, cols?: number, rows?: number, signal?: AbortSignal) => {
      const qs = new URLSearchParams();
      if (cols) qs.set('cols', String(cols));
      if (rows) qs.set('rows', String(rows));
      const qsStr = qs.toString();
      return fetchJSON<{ rendered: string }>(`/sessions/${id}/rendered-output${qsStr ? `?${qsStr}` : ''}`, { signal });
    },
  },
  events: {
    list: (params?: { session_id?: string; project_id?: string; project_path?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.session_id) qs.set('session_id', params.session_id);
      if (params?.project_id) qs.set('project_id', params.project_id);
      if (params?.project_path) qs.set('project_path', params.project_path);
      if (params?.limit) qs.set('limit', String(params.limit));
      return fetchJSON<{ events: Event[] }>(`/events?${qs}`);
    },
  },
  tasks: {
    list: (status?: string) =>
      fetchJSON<{ tasks: Task[] }>(`/tasks${status ? `?status=${status}` : ''}`),
    create: (data: { title: string; description?: string; project_id?: string }) =>
      fetchJSON<{ ok: boolean; task: Task }>('/tasks', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  scheduledTasks: {
    agentQuota:(projectId:string,agentId:string)=>fetchJSON<AgentQuotaResponse>(`/scheduled-tasks/agent-quota?project_id=${encodeURIComponent(projectId)}&agent_id=${encodeURIComponent(agentId)}`),
    list: (projectId?: string) => {
      const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
      return fetchJSON<{ tasks: ScheduledTask[] }>(`/scheduled-tasks${query}`);
    },
    create: (data: ScheduledTaskInput) =>
      fetchJSON<{ ok: boolean; task: ScheduledTask }>('/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<ScheduledTaskInput>) =>
      fetchJSON<{ ok: boolean; task: ScheduledTask }>(`/scheduled-tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchJSON<{ ok: boolean }>(`/scheduled-tasks/${id}`, { method: 'DELETE' }),
    run: (id: string) =>
      fetchJSON<{ ok: boolean; run: ScheduledTaskRun }>(`/scheduled-tasks/${id}/run`, { method: 'POST' }),
    runs: (id: string) =>
      fetchJSON<{ runs: ScheduledTaskRun[] }>(`/scheduled-tasks/${id}/runs`),
    codexQuota: (projectId: string) =>
      fetchJSON<AgentQuotaResponse>(`/scheduled-tasks/codex-quota?project_id=${encodeURIComponent(projectId)}`),
  },
  agentQuota:{read:(agentId:string,force=false)=>fetchJSON<AgentQuotaResponse>(`/agent-quota/${encodeURIComponent(agentId)}${force?'?refresh=true':''}`)},
  codexQuota: {
    read: (force = false) => fetchJSON<AgentQuotaResponse>(`/codex-quota${force ? '?refresh=true' : ''}`),
  },
  projects: {
    list: async () => {const data=await fetchJSON<{projects:Project[];agents?:AgentDescriptor[]}>('/projects');return {...data,projects:data.projects.map(project=>({...project,agent_catalog:data.agents}))};},
    create: (data: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; color?: string }) =>
      fetchJSON<{ ok: boolean; project: Project }>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; description?: string; session_prompt?: string | null; openclaw_prompt?: string | null; color?: string }) =>
      fetchJSON<{ ok: boolean; project: Project }>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchJSON<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    browse: (path?: string) =>
      fetchJSON<BrowseResult>(`/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    access: (id: string) =>
      fetchJSON<{ access: ProjectUserAccess[]; clients: SessionClient[] }>(`/projects/${id}/access`),
    setAccess: (id: string, userId: string, access: ProjectToolPermissions) =>
      fetchJSON<{ ok: boolean; access: ProjectUserAccess }>(`/projects/${id}/access/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(access),
      }),
    removeAccess: (id: string, userId: string) =>
      fetchJSON<{ ok: boolean }>(`/projects/${id}/access/${userId}`, { method: 'DELETE' }),
  },
  skills: {
    // Project-scoped: lists the project's own skills + global read-only references.
    list: (projectId: string) =>
      fetchJSON<{ groups: SkillGroup[] }>(`/skills?project_id=${encodeURIComponent(projectId)}`),
    marketplaceSearch: (projectId: string, query: string) => {
      const params = new URLSearchParams({ project_id: projectId });
      if (query.trim()) params.set('q', query.trim());
      return fetchJSON<SkillMarketplaceSearchResponse>(`/skills/marketplace/search?${params.toString()}`);
    },
    marketplaceInstall: (
      projectId: string,
      skill: Pick<SkillMarketplaceResult, 'provider' | 'slug' | 'author' | 'skillId'>,
      targets: SkillInstallTargetId[],
    ) =>
      fetchJSON<SkillMarketplaceInstallResponse>('/skills/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          provider: skill.provider,
          slug: skill.slug,
          ...(skill.provider === 'clawhub' && skill.author ? { ownerHandle: skill.author } : {}),
          ...(skill.skillId ? { skillId: skill.skillId } : {}),
          targets,
        }),
      }),
    create: (projectId: string, tool: string, scope: string, data: { name: string; description?: string; content?: string }) =>
      fetchJSON<{ ok: boolean; tool: string; scope: string; dirName: string; path: string }>(`/skills/${tool}/${scope}`, {
        method: 'POST',
        body: JSON.stringify({ ...data, project_id: projectId }),
      }),
    remove: (projectId: string, tool: string, scope: string, name: string) =>
      fetchJSON<{ ok: boolean }>(`/skills/${tool}/${scope}/${encodeURIComponent(name)}?project_id=${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  },
  files: {
    createDirectory: (path: string, projectId?: string) => fetchJSON<{ok:boolean;created:boolean}>(fileEndpoint('/files/directory',projectId),{method:'POST',body:JSON.stringify({path})}),
    upload: (path: string, file: File, onProgress?: (fraction: number) => void, projectId?: string) =>
      uploadWithProgress<{ ok: boolean; path: string; size: number }>(
        fileEndpoint(`/files/upload?path=${encodeURIComponent(path)}&filename=${encodeURIComponent(file.name)}`, projectId),
        file, onProgress,
      ),
    list: (path: string, showHidden?: boolean, projectId?: string) =>
      fetchJSON<{ path: string; files: FileEntry[] }>(fileEndpoint(`/files?path=${encodeURIComponent(path)}${showHidden ? '&showHidden=true' : ''}`, projectId)),
    read: (path: string, projectId?: string) =>
      fetchJSON<{ path: string; content: string; extension: string; size: number; previewType?: FilePreviewType }>(
        fileEndpoint(`/files/read?path=${encodeURIComponent(path)}`, projectId)
      ),
    previewUrl:(path:string,projectId?:string)=>`${API_BASE}${fileEndpoint(`/files/preview?path=${encodeURIComponent(path)}`,projectId)}`,
    preview: async (path: string, signal?: AbortSignal, projectId?: string,onFonts?:(report:PreviewFontReport)=>void) => {
      const res = await fetch(`${API_BASE}${fileEndpoint(`/files/preview?path=${encodeURIComponent(path)}`, projectId)}`, { signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `预览失败：${res.status}`);
      }
      const header=res.headers.get('X-Preview-Fonts');
      if(header&&onFonts)try{const report=JSON.parse(decodeURIComponent(header));if(typeof report.checked==='boolean'&&Array.isArray(report.substitutions)&&report.substitutions.every((entry:PreviewFontReport['substitutions'][number])=>typeof entry.requested==='string'&&typeof entry.replacement==='string'))onFonts(report);}catch{/* Ignore malformed preview metadata. */}
      return res.blob();
    },
    export: async (path: string, signal?: AbortSignal, projectId?: string) => {
      const res = await fetch(`${API_BASE}${fileEndpoint(`/files/export?path=${encodeURIComponent(path)}`, projectId)}`, { signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `API error: ${res.status}`);
      }
      return res;
    },
    write: (path: string, content: string, expectedContent?: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; size: number }>(fileEndpoint('/files/write', projectId), {
        method: 'PUT',
        body: JSON.stringify({ path, content, expectedContent }),
      }),
    diff: (pathA: string, pathB: string, projectId?: string) =>
      fetchJSON<{ diff: string }>(fileEndpoint('/files/diff', projectId), {
        method: 'POST',
        body: JSON.stringify({ pathA, pathB }),
      }),
    delete: (path: string, projectId?: string) =>
      fetchJSON<{ ok: boolean }>(fileEndpoint('/files/delete', projectId), {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    rename: (path: string, newName: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; path: string }>(fileEndpoint('/files/rename', projectId), {
        method: 'POST',
        body: JSON.stringify({ path, newName }),
      }),
    move: (src: string, destDir: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; path: string }>(fileEndpoint('/files/move', projectId), {
        method: 'POST',
        body: JSON.stringify({ src, destDir }),
      }),
    copy: (src: string, destDir: string, projectId?: string) =>
      fetchJSON<{ ok: boolean; path: string }>(fileEndpoint('/files/copy', projectId), {
        method: 'POST',
        body: JSON.stringify({ src, destDir }),
      }),
  },
  git: {
    status: (path: string) =>
      fetchJSON<GitStatus>(`/git/status?path=${encodeURIComponent(path)}`),
    log: (path: string, limit = 20) =>
      fetchJSON<{ commits: GitCommit[] }>(
        `/git/log?path=${encodeURIComponent(path)}&limit=${limit}`
      ),
    diff: (path: string, file?: string, staged?: boolean, ignoreWhitespace?: boolean, fullFile?: boolean) => {
      const qs = new URLSearchParams({ path });
      if (file) qs.set('file', file);
      if (staged) qs.set('staged', 'true');
      if (ignoreWhitespace) qs.set('ignoreWhitespace', 'true');
      if (fullFile) qs.set('fullFile', 'true');
      return fetchJSON<{ diff: string }>(`/git/diff?${qs}`);
    },
    show: (path: string, hash: string, ignoreWhitespace?: boolean, fullFile?: boolean) => {
      const qs = new URLSearchParams({ path, hash });
      if (ignoreWhitespace) qs.set('ignoreWhitespace', 'true');
      if (fullFile) qs.set('fullFile', 'true');
      return fetchJSON<{ files: CommitFile[]; diff: string }>(`/git/show?${qs}`);
    },
    stage: (path: string, files: string[]) =>
      fetchJSON<{ ok: boolean }>('/git/stage', {
        method: 'POST',
        body: JSON.stringify({ path, files }),
      }),
    unstage: (path: string, files: string[]) =>
      fetchJSON<{ ok: boolean }>('/git/unstage', {
        method: 'POST',
        body: JSON.stringify({ path, files }),
      }),
    commit: (path: string, message: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/commit', {
        method: 'POST',
        body: JSON.stringify({ path, message }),
      }),
    push: (path: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/push', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    discard: (path: string, files: string[]) =>
      fetchJSON<{ ok: boolean }>('/git/discard', {
        method: 'POST',
        body: JSON.stringify({ path, files }),
      }),
    branches: (path: string) =>
      fetchJSON<{ branches: GitBranch[]; current: string }>(
        `/git/branches?path=${encodeURIComponent(path)}`
      ),
    checkout: (path: string, branch: string, isRemote?: boolean) =>
      fetchJSON<{ ok: boolean }>('/git/checkout', {
        method: 'POST',
        body: JSON.stringify({ path, branch, isRemote }),
      }),
    fetch: (path: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/fetch', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    pull: (path: string) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/pull', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    ghAccounts: () =>
      fetchJSON<{ accounts: string[] }>('/git/gh-accounts'),
    createRepo: (data: { path: string; name?: string; owner?: string; private?: boolean; defaultBranch?: string }) =>
      fetchJSON<{ ok: boolean; output: string }>('/git/create-repo', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  agent: {
    cancelQueuedInput:(sessionId:string,clientId:string)=>fetchJSON<{ok:boolean}>(`/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(clientId)}`,{method:'DELETE'}),
    controls:(sessionId:string,refresh=false)=>fetchJSON<ConversationControlsData>(`/sessions/${encodeURIComponent(sessionId)}/controls${refresh?'?refresh=true':''}`),
    contextBreakdown:(sessionId:string,refresh=false,signal?:AbortSignal)=>fetchJSON<{context:ConversationContextBreakdown}>(`/sessions/${encodeURIComponent(sessionId)}/context-breakdown${refresh?'?refresh=true':''}`,{signal}),
    setControls:(sessionId:string,value:AgentModelPreference|null)=>fetchJSON<{ok:boolean;pending:AgentModelPreference|null;pending_status?:'saved'|'submitted'|null;model?:string;effort?:string;provider?:string;service_tier?:string}>(`/sessions/${encodeURIComponent(sessionId)}/controls`,{method:'PUT',body:JSON.stringify(value)}),
    conversation:(sessionId:string,query:{after?:string;before?:string}={},signal?:AbortSignal)=>fetchJSON<ConversationPage>(`/sessions/${encodeURIComponent(sessionId)}/conversation?${new URLSearchParams(query)}`,{signal}),
    sendInput:(sessionId:string,input:string,clientId?:string,attachments?:ConversationAttachment[])=>fetchJSON<{status:string}>(`/sessions/${encodeURIComponent(sessionId)}/input`,{method:'POST',body:JSON.stringify({input,source:'conversation',client_id:clientId,attachments})}),
    capabilities: () => fetchJSON<AgentApiContract>('/agent/capabilities'),
    execute: (sessionId: string, opts: {
      input: string;
      waitFor?: string;
      timeout?: number;
      stripAnsi?: boolean;
      quiescenceMs?: number;
    }) =>
      fetchJSON<ExecuteResult>(`/sessions/${sessionId}/execute`, {
        method: 'POST',
        body: JSON.stringify(opts),
      }),
    state: (sessionId: string) =>
      fetchJSON<SessionStateResponse>(`/sessions/${sessionId}/state`),
  },
  settings: {
    get: async () => {
      const started=performance.now();
      const result=await fetchJSON<{ settings: Record<string, string>;server_time?:number }>('/settings');
      if(typeof result.server_time==='number')calibrateBrowserClock(result.server_time,Date.now(),performance.now()-started);
      return result;
    },
    update: (settings: Record<string, string>) =>
      fetchJSON<{ ok: boolean; settings: Record<string, string> }>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      }),
    statusline: {
      get: () => fetchJSON<{ installed: boolean }>('/settings/statusline'),
      install: () => fetchJSON<{ ok: boolean; scriptPath: string }>('/settings/statusline/install', { method: 'POST' }),
      uninstall: () => fetchJSON<{ ok: boolean; removed: string[] }>('/settings/statusline/uninstall', { method: 'POST' }),
    },
  },
  agentManagement: {
    list: () => fetchJSON<{ agents: Array<{ agent: AgentDescriptor; state: AgentManagementState }> }>('/agent-management'),
    get: (agentId: string) => fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}`),
    provider: (agentId: string, providerId: string) =>
      fetchJSON<{ provider: AgentProviderState }>(`/agent-management/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}`),
    detectModels: (agentId: string, options: { providerId?: string; endpoint?: string; apiKey?: string; all?: boolean } = {}) => fetchJSON<{ models: DetectedAgentModel[] }>(`/agent-management/${encodeURIComponent(agentId)}/detect-models`, {
      method: 'POST', body: JSON.stringify({ refresh: true, ...options }),
    }),
    updateDefaults: (agentId: string, defaults: Record<string, string | boolean | string[] | null>) =>
      fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}`, {
        method: 'PUT', body: JSON.stringify({ defaults }),
      }),
    action: (agentId: string, action: string) =>
      fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}/action`, {
        method: 'POST', body: JSON.stringify({ action }),
      }),
    createProvider: (agentId: string, input: { id?: string; name?: string; kind?: string; enabled?: boolean; apiKey?: string; fields?: Record<string, string | boolean | string[] | null> }) =>
      fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}/providers`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    updateProvider: (agentId: string, providerId: string, input: { name?: string; kind?: string; enabled?: boolean; apiKey?: string; fields?: Record<string, string | boolean | string[] | null> }) =>
      fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}`, {
        method: 'PUT', body: JSON.stringify(input),
      }),
    updateProviderStream: (agentId: string, providerId: string, input: { name?: string; kind?: string; enabled?: boolean; apiKey?: string; fields?: Record<string, string | boolean | string[] | null> }, onProgress?: (progress: AgentOperationProgress) => void) =>
      streamProviderOperation(`/agent-management/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}/update-stream`, input, 'PUT', onProgress),
    deleteProvider: (agentId: string, providerId: string) =>
      fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' }),
    providerAction: (agentId: string, providerId: string, action: string) =>
      fetchJSON<{ state: AgentManagementState }>(`/agent-management/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}/action`, {
        method: 'POST', body: JSON.stringify({ action }),
      }),
    providerActionStream: (agentId: string, providerId: string, action: string, onProgress?: (progress: AgentOperationProgress) => void) =>
      streamProviderOperation(`/agent-management/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}/action-stream`, { action }, 'POST', onProgress),
    readFile: (agentId: string, path: string, revealSensitive = false) =>
      fetchJSON<{ file: AgentConfigFileContent }>(`/agent-management/${encodeURIComponent(agentId)}/config-file`, {
        method: 'POST', body: JSON.stringify({ path, revealSensitive }),
      }),
    writeFile: (agentId: string, file: { path: string; content: string; expectedContent?: string | null }) =>
      fetchJSON<{ file: AgentConfigFileContent }>(`/agent-management/${encodeURIComponent(agentId)}/config-file`, {
        method: 'PUT', body: JSON.stringify(file),
      }),
    modelConfigs: (agentId: string) =>
      fetchJSON<{ models: AgentModelConfig[] }>(`/agent-management/${encodeURIComponent(agentId)}/model-configs`),
    updateModelConfigs: (agentId: string, models: Array<{
      provider?: string; model: string; contextWindow?: number | null; maxContextWindow?: number | null;
      effectiveContextWindowPercent?: number | null; supportsImages?: boolean;
    }>) => fetchJSON<{ models: AgentModelConfig[] }>(`/agent-management/${encodeURIComponent(agentId)}/model-configs`, {
      method: 'PUT', body: JSON.stringify({ models }),
    }),
    updateEnvironment: (agentId: string, environment: { values: Record<string, string>; clear?: string[]; restart?: boolean }) =>
      fetchJSON<{ environment: AgentEnvironmentVariable[] }>(`/agent-management/${encodeURIComponent(agentId)}/environment`, {
        method: 'PUT', body: JSON.stringify(environment),
      }),
    saveSelectedModels: (agentId: string, models: string[], defaultModel: string | null, restart = false) =>
      fetchJSON<{ environment: AgentEnvironmentVariable[] }>(`/agent-management/${encodeURIComponent(agentId)}/selected-models`, {
        method: 'PUT', body: JSON.stringify({ models, defaultModel, restart }),
      }),
  },
  promptEnhancer: {
    config: () => fetchJSON<{ config: PromptEnhancerConfig }>('/prompt-enhancer/config'),
    updateConfig: (config: {
      source?:AiSource;
      enabled?: boolean;
      endpoint?: string;
      model?: string;
      mode?: PromptEnhancerMode;
      context_rounds?: number;
      timeout_ms?: number;
      api_key?: string;
      clear_api_key?: boolean;
    }) => fetchJSON<{ ok: boolean; config: PromptEnhancerConfig }>('/prompt-enhancer/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
    test: () => fetchJSON<{ ok: boolean }>('/prompt-enhancer/test', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    models: (config: { endpoint?: string; api_key?: string }) => fetchJSON<{ models: string[] }>('/prompt-enhancer/models', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
    enhance: (data: { session_id: string; prompt: string; mode?: PromptEnhancerMode; attachments?: import('./conversation-attachments').ConversationAttachment[] }, signal?: AbortSignal) =>
      fetchJSON<{
        prompt: string;
        warnings?: string[];
        context?: { requested_rounds: number; included_rounds: number };
      }>('/prompt-enhancer/enhance', {
        method: 'POST',
        body: JSON.stringify(data),
        signal,
      }),
  },
  // Per-user UI view state — cross-device sync of open tabs + custom names.
  userState: {
    getAll: () => fetchJSON<{ state: Record<string, unknown> }>('/user-state'),
    set: (key: string, value: unknown) =>
      fetchJSON<{ ok: boolean }>(`/user-state/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
    remove: (key: string) =>
      fetchJSON<{ ok: boolean }>(`/user-state/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  },
  health: () => fetchJSON<{ name: string; version: string; status: string; uptime?: number; reconnecting?: boolean; reconnectTotal?: number; reconnectDone?: number }>('/health'),
  versionCheck: () =>
    fetchJSON<{ current: string; latest: string; name: string; url: string; prerelease: boolean; channel: string; updateAvailable: boolean; unavailable?: boolean }>('/version-check'),
};

// Keep the project context on every explorer operation, including writes.
export function scopeProjectFiles(files: typeof api.files, projectId?: string): typeof api.files {
  if (!projectId) return files;
  return {
    createDirectory: (path) => files.createDirectory(path, projectId),
    list: (path, hidden) => files.list(path, hidden, projectId),
    read: (path) => files.read(path, projectId),
    previewUrl: (path) => files.previewUrl(path,projectId),
    preview: (path, signal,_projectId,onFonts) => onFonts?files.preview(path, signal, projectId,onFonts):files.preview(path, signal, projectId),
    upload: (path, file, progress) => files.upload(path, file, progress, projectId),
    export: (path, signal) => files.export(path, signal, projectId),
    write: (path, content, expected) => files.write(path, content, expected, projectId),
    diff: (a, b) => files.diff(a, b, projectId),
    delete: (path) => files.delete(path, projectId),
    rename: (path, name) => files.rename(path, name, projectId),
    move: (src, dest) => files.move(src, dest, projectId),
    copy: (src, dest) => files.copy(src, dest, projectId),
  };
}

// Types
export interface Session {
  agent_environment_id?: string | null;
  id: string;
  project_id: string | null;
  task: string;
  status: 'pending' | 'launching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'detached' | 'released';
  pid: number | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  created_at: string;
  updated_at?: string;
  last_activity_at?: string | null;
  content_summary?: string | null;
  cli_type?: string;
  agent_id?:string|null;native_session_id?:string|null;agent?:AgentDescriptor;
  mode?: 'session' | 'terminal';
  claude_session_id?: string | null;
  codex_session_id?: string | null;
  agent_runtime?: {
    source: string; session_id: string | null;
    state: 'ready' | 'running' | 'idle' | 'waiting_for_input' | 'interrupted' | 'failed' | 'unknown';
    last_activity_at: string | null; observed_at: string; reason: string;
    compaction?:import('./agents').AgentCompaction|null;
    pending_question_count?: number;
    completed_turn_id?:string;
    ignored_question_ids?:string[];
    submitted_question_ids?:string[];queued_answer_count?:number;
    pending_questions?: Array<{id:string;questions:NonNullable<ConversationMessage['async_questions']>;timestamp:string|null;turn_id?:string}>;
  };
  // Live process-state (present when the session has an active in-memory tracker).
  processState?: 'busy' | 'idle' | 'waiting_for_input';
  promptType?: 'choice' | 'confirmation' | 'text' | null;
  isPermission?: boolean;
}

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'cron';
export type ScheduledTargetType = 'existing' | 'new';
export type ScheduledNewMode = 'session' | 'terminal';

export type ScheduledTaskCondition =
  | { type: 'time_after'; value: string }
  | { type: 'time_range'; value: { start: string; end: string } }
  | { type: 'weekday'; value: 'workday' | 'weekend' }
  | { type: 'target_idle'; value: boolean }
  | { type: 'quota_below' | 'successes_today' | 'failures_today'; value: number };
export interface ScheduledConditionGroup {
  operator: 'and' | 'or';
  conditions: Array<ScheduledTaskCondition | ScheduledConditionGroup>;
}

export interface ScheduledTaskInput {
  project_id: string;
  name: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  schedule_value: string;
  timezone: string;
  target_type: ScheduledTargetType;
  target_session_id?: string | null;
  new_mode?: ScheduledNewMode | null;
  new_cli_type?: string | null;
  new_environment_id?: string | null;
  new_model_preference?: AgentModelPreference | null;
  inactive_policy?: 'resume' | 'fail';
  stop_at?: string | null;
  daily_stop_time?: string | null;
  daily_start_time?: string | null;
  daily_end_time?: string | null;
  start_conditions?: ScheduledConditionGroup | null;
  daily_stop_conditions?: ScheduledConditionGroup | null;
  condition_unmet_policy?: 'wait' | 'skip';
  max_successful_runs?: number | null;
  quota_remaining_below?: number | null;
  max_consecutive_failures?: number | null;
  stop_on_target_unavailable?: boolean;
  enabled?: boolean;
}

export interface ScheduledTask extends Omit<ScheduledTaskInput, 'enabled'> {
  id: string;
  user_id: string;
  enabled: number;
  next_run_at: string | null;
  daily_stop_at: string | null;
  daily_paused_until?: string | null;
  daily_pause_reason?: string | null;
  waiting_reason?: string | null;
  successful_runs: number;
  consecutive_failures: number;
  last_quota_remaining: number | null;
  stopped_at: string | null;
  stop_reason: string | null;
  last_run_at: string | null;
  last_status: 'success' | 'failed' | 'stopped' | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  trigger: 'scheduled' | 'manual';
  scheduled_for: string;
  status: 'running' | 'success' | 'failed' | 'stopped' | 'skipped';
  session_id: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AgentQuotaResponse {quota:AgentWeeklyQuota|null;reason?:'not_applicable';message?:string}
export interface AgentWeeklyQuota {
  stale?: boolean;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
  planType: string | null;
  checkedAt: string;
}
export type CodexWeeklyQuota=AgentWeeklyQuota;


export interface AdminMonitorSession {
  id: string;
  project_id: string | null;
  task: string;
  status: string;
  mode: 'session' | 'terminal' | null;
  cli_type: string | null;
  created_by_user_id: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_output: string | null;
  root_pid: number | null;
  process_count: number;
  memory_bytes: number | null;
  process_state: 'busy' | 'idle' | 'waiting_for_input' | null;
  prompt_type: 'choice' | 'confirmation' | 'text' | null;
  choices: string[] | null;
  is_permission: boolean;
}

export interface AdminMonitorProject {
  id: string | null;
  name: string;
  path: string | null;
  is_open: boolean;
  is_active: boolean;
  custom_name: string | null;
  state_updated_at: string | null;
  tabs: AdminMonitorTab[];
  sessions: AdminMonitorSession[];
}

export interface AdminMonitorTab {
  id: string;
  name: string;
  kind: 'session';
  is_active: boolean;
}

export interface AdminMonitorUser extends AuthUser {
  online: boolean;
  presence?:AdminMonitorPresence;
  login_sessions?:AdminMonitorLogin[];
  last_seen_at: string | null;
  active_sessions: number;
  open_projects: number;
  memory_bytes: number;
  projects: AdminMonitorProject[];
}

export interface AdminMonitorPresence {
  state:'online'|'offline'|'unresponsive';
  connections:number;
  last_heartbeat_at:string|null;
}
export interface AdminMonitorLogin {
  login_at:string;
  last_seen_at:string;
  login_ip:string|null;
  last_ip:string|null;
  user_agent:string|null;
  presence:AdminMonitorPresence;
}

export interface AdminMonitorResponse {
  generated_at: string;
  login_session_policy?:{idle_ttl_days:number};
  server_resources: {
    sampled_at: string;
    hostname: string;
    uptime_seconds: number;
    cpu: {
      usage_percent: number;
      core_count: number;
      load_average_1m: number;
    };
    memory: {
      total_bytes: number;
      used_bytes: number;
      available_bytes: number;
      usage_percent: number;
    };
    disk: {
      total_bytes: number;
      used_bytes: number;
      available_bytes: number;
      usage_percent: number;
      mount: string;
    } | null;
  };
  active_users: number;
  active_sessions: number;
  total_memory_bytes: number;
  users: AdminMonitorUser[];
}

export interface ClaudeHistoryItem {
  uuid: string;
  title: string;
  startTime: string | null;
  lastActivity: number;
  sizeBytes: number;
  model: string | null;
  /** Set when an AgentManager session is currently bound to this conversation. */
  liveSessionId: string | null;
  liveStatus: string | null;
}

export interface Event {
  id: number;
  session_id: string | null;
  type: string;
  tool_name: string | null;
  data: string | null;
  timestamp: string;
}

export interface Project {
  agent_catalog?:AgentDescriptor[];
  owner_id?: string | null;
  owner?: { id: string; username: string; display_name: string } | null;
  id: string;
  name: string;
  path: string;
  description: string | null;
  session_prompt: string | null;
  openclaw_prompt: string | null;
  color: string;
  created_at: string;
  updated_at?: string;
  tool_access?: ProjectToolPermissions | null;
}

export interface SessionClient { id: string; label: string; }

export interface ProjectToolPermissions {
  session_clients: string[];
  can_session: boolean;
  can_terminal: boolean;
}

export interface ProjectUserAccess extends ProjectToolPermissions {
  user_id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  owner_id?: string | null;
  granted_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type FilePreviewType = 'text' | 'pdf' | 'word' | 'presentation' | 'spreadsheet' | 'csv' | 'image' | 'drawio' | 'video' | 'audio';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension: string;
  modified_at?: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  remoteUrl: string | null;
}

export interface GitFileStatus {
  x: string; // index status
  y: string; // worktree status
  path: string;
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface CommitFile {
  status: string;
  path: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
}



export interface SkillSummary {
  name: string;
  dirName: string;
  description: string;
  fileCount: number;
  path: string; // absolute path to the skill directory (for FileExplorer)
}
export interface SkillGroup {
  key: string;
  tool: string;
  toolLabel: string;
  scope: string;
  label: string;
  dir: string;
  readOnly: boolean;
  skills: SkillSummary[];
}

export type SkillMarketplaceProviderId = 'clawhub' | 'skills.sh';
export type SkillInstallTargetId = 'claude-code' | 'codex' | 'openclaw';

export interface SkillMarketplaceResult {
  id: string;
  provider: SkillMarketplaceProviderId;
  providerLabel: string;
  skillId?: string;
  slug: string;
  name: string;
  description: string;
  author: string | null;
  downloads: number;
  installs: number | null;
  version: string | null;
  url: string;
  featured: boolean;
  official: boolean;
  installed: boolean;
  installedTargets: SkillInstallTargetId[];
}

export interface SkillMarketplaceProviderStatus {
  id: SkillMarketplaceProviderId;
  label: string;
  enabled: boolean;
  ok: boolean;
  message?: string;
}

export interface SkillMarketplaceSearchResponse {
  query: string;
  skills: SkillMarketplaceResult[];
  providers: SkillMarketplaceProviderStatus[];
  installTargets: SkillInstallTarget[];
}

export interface SkillInstallTarget {
  id: SkillInstallTargetId;
  label: string;
  description: string;
}

export interface SkillMarketplaceInstallResponse {
  ok: boolean;
  tool: string;
  scope: string;
  dirName: string;
  path: string;
  name: string;
  description: string;
  installedTargets: SkillInstallTargetId[];
  destinations: { id: SkillInstallTargetId; label: string; path: string }[];
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  folderName: string;
  dirs: { name: string; path: string; hasChildren: boolean }[];
}

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  priority: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  session_id: string | null;
  created_at: string;
}

export interface ExecuteResult {
  id: string;
  status: 'completed' | 'timeout' | 'pattern_matched';
  output: string;
  durationMs: number;
  state: SessionStateResponse;
}

export interface DiscoverableSession {
  socketPath: string;
  projectPath: string;
  task: string;
  startedAt: string;
  cliType?: string;
}

export interface SessionOutput {
  chunks: { seq: number; data: string }[];
  hasMore: boolean;
  oldestSeq: number | null;
}

export interface ConversationInterval {tokens:Record<string,number|null>|null;requests:number;tool_calls:number;tool_rounds:number;complete:boolean;shared_messages:number}
export interface ConversationConclusion extends ConversationInterval {start_at:string|null;end_at:string|null;elapsed_ms:number|null}
export interface ConversationStatistics {sequence:number;message_id?:string;turn_id:string;tokens:Record<string,number|null>|null;requests:number;tool_calls:number;tool_rounds:number;complete:boolean;interval?:ConversationInterval;conclusion?:ConversationConclusion}
export interface ConversationMessage {statistics?:ConversationStatistics;id:string;role:'user'|'assistant';text:string;timestamp:string|null;turn_id?:string;streaming?:boolean;queued?:boolean;phase?:'commentary'|'final'|'error';content_blocks?:Array<{type:'text';index:number;text:string}|{type:'tool_use';index:number;id:string;name:string;input:unknown;status:'running'|'completed'|'failed';result?:string;is_error?:boolean}>;presentation?:'compaction_summary';compaction?:{before_tokens:number|null;after_tokens:number|null;duration_ms:number|null};error?:{code?:string;will_retry:boolean};client_id?:string;sequence?:number;attachments?:ConversationAttachment[];async_questions?:Array<{id?:string;title:string;options:string[]|null}>;question_replies?:Array<{question_id:string;question:string;answer:string}>}
export interface ConversationContextBreakdown {
 source:'jsonl';exact:false;method:'characters_div_3';checked_at:string;observed_at:string|null;model:string|null;
 usage:ConversationControlsData['usage'];partial:boolean;warnings:string[];
 files_read:number;records_read:number;bytes_read:number;compactions:number;
 categories:Array<{id:string;name:string;tokens:number|null;count:number;detail:Array<{name:string;tokens:number;count:number}>}>;
}
export interface ConversationUsageUpdate {native_id:string;usage:NonNullable<ConversationControlsData['usage']>;observed_at:string}
export interface CodexEnvironment {id:string;name:string;kind:'native'|'provider'|'account';auth_mode?:'account'|'api'|null;balance_group?:string|null;source?:'managed_host'|'managed_provider'|'system_user';provider?:string;enabled:boolean;allowed_user_ids:string[]|null;can_control?:boolean;connection?:{username:string;port:number;identityFile:string;codexCommand:string;codexHome:string;authMethod?:'key'|'password';password?:string;passwordConfigured?:boolean}}
export interface CodexEngineBalance {auth_mode:'account'|'api'|null;groupKey?:string;origin?:string;status:'available'|'unavailable'|'unsupported'|'stale';amount?:number;currency?:string;mode?:string|null;todayActualCost?:number|null;todayRequests?:number|null;totalActualCost?:number|null;checkedAt?:string|null;error?:string|null}
export interface ProviderUsageTab {id:string;user_id:string|null;username:string;project_id:string|null;project_name:string;name:string;status:string;native_id:string|null;model:string|null;busy:boolean|null}
export interface EnvironmentCheck {stage:string;ok:boolean;message:string}
export interface EnvironmentPreflight {ok:boolean;checks:EnvironmentCheck[];models?:ConversationControlsData['models']}
export interface AgentModelPreference {service_tier?:string;model:string;effort:string;provider?:string}
export interface ConversationControlsData {
  supports_model_recovery?:boolean;supports_fresh_model?:boolean;
  agent?:AgentDescriptor;can_edit_features?:Partial<Record<import('./agents').AgentFeature,boolean>>;
  engine_version?:string|null;installed_cli_version?:string|null;git?:{branch:string;changes:number}|null;state?:string|null;
  model:string|null;effort:string|null;provider:string|null;cwd:string|null;cli_version:string|null;permission:string|null;approval:string|null;service_tier:string|null;
  usage:{total:Record<string,number|null>;last:Record<string,number|null>;window:number|null}|null;
  limits:Array<{used_percent:number;minutes:number;resets_at:number|null}>;
  models:Array<{default_service_tier?:string|null;service_tiers?:Array<{id:string;name:string;description:string}>;provider?:string;model:string;name:string;description:string;efforts:Array<{value:string;description:string}>;defaultEffort:string}>;
  pending_status?:'saved'|'submitted'|null;can_edit:boolean;loaded:boolean;pending:AgentModelPreference|null;warning:string|null;native_id:string;checked_at:string;usage_observed_at:string|null;
}
export interface ConversationPage {
  messages:ConversationMessage[];statistics?:ConversationStatistics[];has_more:boolean;reset:boolean;available:boolean;generation:string|null;
  agent?:AgentDescriptor;agent_id?:string;native_session_id?:string|null;session_id:string;session_status:Session['status'];session_active:boolean;native_id:string|null;
  runtime:Session['agent_runtime']|null;
  interaction:{processState:'busy'|'idle'|'waiting_for_input';promptType:'choice'|'confirmation'|'text'|null;isPermission:boolean;choices:string[]|null}|null;
}

export interface SessionStateResponse {
  sessionId: string;
  processState: 'busy' | 'idle' | 'waiting_for_input';
  lastActivity: number;
  promptType: 'choice' | 'confirmation' | 'text' | null;
  choices: string[] | null;
}

export interface CodexAccountDetails {
  id:string;system_user?:string|null;checked_at:string;executable:string|null;version:string|null;home:string|null;
  engine:{state:string;pid:number|null};
  authentication:{status:string;type:string|null;email:string|null;plan:string|null};
  config:{path:string|null;exists:boolean;notice:string|null};
  settings:Record<string,string|null>;
  models:Array<{model:string;name?:string;description?:string;defaultEffort?:string;efforts?:Array<{value:string;description:string}>;service_tiers?:Array<{id:string;name:string;description:string}>;default_service_tier?:string|null}>;
}
