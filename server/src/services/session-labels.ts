import { getDb } from '../db/index.js';

interface LabelledSession {
  id: string; project_id?: string | null; created_by_user_id?: string | null;
  mode?: string | null; task?: string | null;
}
interface TabState {
  terminalInstances?: Array<{id?: unknown; customLabel?: unknown; label?: unknown}>;
  terminalLabels?: Record<string, unknown>;
  hiddenSessionIds?: unknown[];
}
const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0,160) : '';

/** Call only after session access has been checked. Cache UI rows per response. */
export function sessionPresenter(viewerId: string) {
  const states = new Map<string, TabState>();
  const projects = new Map<string, string>();
  const readState = (userId: string, projectId: string): TabState => {
    const key = `${userId}:${projectId}`;
    if (!states.has(key)) {
      const row = getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId, `project:${projectId}`) as {value: string} | undefined;
      try {const value = JSON.parse(row?.value || '{}'); states.set(key, value && typeof value === 'object' ? value : {});} catch {states.set(key, {});}
    }
    return states.get(key)!;
  };
  return (session: LabelledSession) => {
    let name = '', isOpen = false;
    if (session.project_id) {
      for (const userId of [...new Set([viewerId, session.created_by_user_id].filter(Boolean) as string[])]) {
        const state = readState(userId, session.project_id);
        const tab = Array.isArray(state.terminalInstances) ? state.terminalInstances.find(tab => tab?.id === session.id) : undefined;
        name = text(tab?.customLabel) || text(state.terminalLabels?.[session.id]) || text(tab?.label);
        isOpen = !!tab && !(Array.isArray(state.hiddenSessionIds) && state.hiddenSessionIds.includes(session.id));
        if (name) break;
      }
      if (!projects.has(session.project_id)) {
        const project = getDb().prepare('SELECT name FROM projects WHERE id=?').get(session.project_id) as {name: string} | undefined;
        projects.set(session.project_id, project?.name || '');
      }
    }
    if (!name) name = session.task && session.task !== 'Terminal' ? session.task.split('\n')[0].slice(0,100) : session.mode === 'terminal' ? '终端' : '工作会话';
    return {display_name: name, tab_name: name, project_name: session.project_id ? projects.get(session.project_id) || '' : '', is_open_tab: isOpen};
  };
}
