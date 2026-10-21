import { fetchJSON } from './api';

export interface PlatformAiConfig {
  enabled: boolean; endpoint: string; model: string; api_key_configured: boolean;
  timeout_ms: number; max_tool_rounds: number; observation_interval_seconds: number;
  assessment_interval_seconds: number; notification_interval_seconds: number;
}
export interface ModelConnectionDraft { endpoint: string; model?: string; api_key?: string; timeout_ms: number }
export interface ModelProbeResult {
  ok: boolean; model: string; elapsed_ms: number;
  checks: Record<'connection' | 'response' | 'tools', {status: 'passed' | 'failed' | 'skipped'; message: string}>;
}
export type ChannelKind = 'webhook' | 'wecom' | 'wecom_bot' | 'wecom_webhook' | 'wechat' | 'qq';
export interface AiChannel {
  id: string; name: string; kind: ChannelKind; enabled: number; config: Record<string, string>;
  secret_fields_configured: string[]; callback_path: string | null;
  connection?: {state: string; message: string; updated_at: string};
}
export interface AiBinding { id: string; channel_id: string; external_user_id: string; user_id: string; username: string; display_name: string }
export interface AiSender {channel_id: string; external_user_id: string; last_chat_id: string; last_seen_at: string}
export interface AiNotificationTarget {id: string; channel_id: string; user_id: string; username: string; display_name: string}
export interface AiConversation { id: string; title: string; channel_id: string | null; channel_name?: string; updated_at?: string }
export interface AiAttachment {id: string; status: string; mime: string; bytes: number; error: string | null}
export interface AiMessage { id: string; role: 'user' | 'assistant' | 'notice'; content: string; status: string; error: string | null; created_at: string; progress?: string; partial_content?: string; attachments?: AiAttachment[] }
export interface WorkAgent { cli_type: 'codex' | 'claude'; label: string; status: 'available' | 'unavailable' | 'unknown'; reason: string }
export interface AiTask { id: string; conversation_id: string; session_id: string; project_id: string | null; requirement: string; status: string; summary: string; evidence: string; updated_at: string }
export interface AiDelivery { id: string; conversation_id: string; status: string; attempts: number; error: string | null; created_at: string; channel_name?: string | null }
export interface ChannelInput { name: string; kind: ChannelKind; enabled: boolean; config: Record<string, string>; secrets: Record<string, string> }
const json = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
const base = '/platform-ai';
export const platformAiApi = {
  status: () => fetchJSON<{enabled: boolean}>(`${base}/status`),
  agents: () => fetchJSON<{agents: WorkAgent[]}>(`${base}/agents`),
  config: () => fetchJSON<{config: PlatformAiConfig}>(`${base}/config`),
  saveConfig: (value: Partial<PlatformAiConfig> & {api_key?: string; clear_api_key?: boolean}) => fetchJSON<{config: PlatformAiConfig}>(`${base}/config`, json('PUT', value)),
  discoverModels: (value: ModelConnectionDraft) => fetchJSON<{models: string[]}>(`${base}/config/models`, json('POST', value)),
  testConnection: (value: ModelConnectionDraft) => fetchJSON<ModelProbeResult>(`${base}/config/test`, json('POST', value)),
  conversations: () => fetchJSON<{conversations: AiConversation[]}>(`${base}/conversations`),
  conversation: (id: string) => fetchJSON<{conversation: AiConversation; messages: AiMessage[]}>(`${base}/conversations/${encodeURIComponent(id)}`),
  send: (value: {content: string; request_id: string; conversation_id?: string}) => fetchJSON<{conversation_id: string; message_id: string; duplicate: boolean}>(`${base}/messages`, json('POST', value)),
  tasks: () => fetchJSON<{tasks: AiTask[]}>(`${base}/tasks`),
  stopTracking: (id: string) => fetchJSON<{ok: boolean}>(`${base}/tasks/${encodeURIComponent(id)}/stop-tracking`, json('POST', {})),
  deliveries: () => fetchJSON<{deliveries: AiDelivery[]}>(`${base}/deliveries`),
  channels: () => fetchJSON<{channels: AiChannel[]; bindings: AiBinding[]; senders?: AiSender[]; notification_targets?: AiNotificationTarget[]}>(`${base}/channels`),
  saveChannel: (value: ChannelInput, id?: string) => fetchJSON<{channel: AiChannel}>(`${base}/channels${id ? '/' + encodeURIComponent(id) : ''}`, json(id ? 'PUT' : 'POST', value)),
  testChannel: (id: string) => fetchJSON<{ok: boolean; message: string}>(`${base}/channels/${encodeURIComponent(id)}/test`, json('POST', {})),
  reconnectChannel: (id: string) => fetchJSON<{ok: boolean}>(`${base}/channels/${encodeURIComponent(id)}/reconnect`, json('POST', {})),
  deleteChannel: (id: string) => fetchJSON<{ok: boolean}>(`${base}/channels/${encodeURIComponent(id)}`, {method: 'DELETE'}),
  saveNotificationTarget: (value: {channel_id: string; user_id: string}) => fetchJSON<{ok: boolean}>(`${base}/notification-targets`, json('POST', value)),
  deleteNotificationTarget: (id: string) => fetchJSON<{ok: boolean}>(`${base}/notification-targets/${encodeURIComponent(id)}`, {method: 'DELETE'}),
  saveBinding: (value: {channel_id: string; external_user_id: string; user_id: string}) => fetchJSON<{ok: boolean}>(`${base}/bindings`, json('POST', value)),
  deleteBinding: (id: string) => fetchJSON<{ok: boolean}>(`${base}/bindings/${encodeURIComponent(id)}`, {method: 'DELETE'}),
  tools: () => fetchJSON<{tools: unknown[]; endpoints: Array<{endpoint_id: string; description: string}>}>(`${base}/tools`),
};
