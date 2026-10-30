export interface ConversationActivity {
  id: string; label: string; status: 'running' | 'completed' | 'failed';
  started_at: string | null; completed_at: string | null; duration_ms: number | null;
}

function short(value: unknown, limit = 180): string {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ')
    .replace(/(Bearer\s+)\S+/gi, '$1[隐藏]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[=:]\s*["']?)[^\s"']+/gi, '$1[隐藏]')
    .replace(/(--(?:api-key|token|password|secret)\s+)\S+/gi, '$1[隐藏]').slice(0, limit);
}

/** UI-only activity metadata. Never copy arguments, command output or reasoning
 * into conversation messages or the platform AI's progress reads. */
export function conversationActivity(item: any, completed: boolean, previous?: ConversationActivity, observedAt: number | null = Date.now()): ConversationActivity | null {
  if (typeof item?.id !== 'string') return null;
  let label: string;
  if (item.type === 'commandExecution') label = `运行命令 · ${short(item.command) || '终端命令'}`;
  else if (item.type === 'mcpToolCall') label = `调用工具 · ${short([item.server, item.tool].filter(Boolean).join(' / ')) || 'MCP 工具'}`;
  else if (item.type === 'dynamicToolCall') label = `调用工具 · ${short(item.tool) || '工具'}`;
  else if (item.type === 'fileChange') label = `修改文件 · ${short((item.changes || []).slice(0, 3).map((change: any) => change.path).filter(Boolean).join('、')) || '项目文件'}`;
  else if (item.type === 'webSearch') label = `搜索 · ${short(item.query || item.action?.query) || '网页搜索'}`;
  else return null;
  const started = typeof item.startedAtMs === 'number' && Number.isFinite(item.startedAtMs) ? item.startedAtMs : previous?.started_at ? Date.parse(previous.started_at) : completed ? null : observedAt;
  const ended = completed ? typeof item.completedAtMs === 'number' && Number.isFinite(item.completedAtMs) ? item.completedAtMs : observedAt : null;
  return {id: item.id, label, status: completed ? ['failed','declined'].includes(item.status) ? 'failed' : 'completed' : 'running',
    started_at: started === null ? null : new Date(started).toISOString(), completed_at: ended === null ? null : new Date(ended).toISOString(),
    duration_ms: typeof item.durationMs === 'number' && item.durationMs >= 0 ? item.durationMs : started !== null && ended !== null ? Math.max(0, ended - started) : null};
}
