import { getDb } from '../../db/index.js';
import { enqueueNotice, getConversation, trackTask } from './store.js';
import { getTracker } from '../session-state.js';

export class PlatformAiScheduleBusyError extends Error {}

/** Called only for schedules created through the platform AI; existing schedules are untouched. */
export function captureScheduledBaseline(scheduleId: string, runId: string, sessionId: string | null, requireAvailable = false): void {
  const link = getDb().prepare('SELECT conversation_id FROM platform_ai_schedule_links WHERE schedule_id=?').get(scheduleId) as {conversation_id: string} | undefined;
  if (!link) return;
  if (requireAvailable) {
    const active = getDb().prepare(`SELECT t.id FROM platform_ai_tasks t JOIN sessions s ON s.id=t.session_id
      JOIN scheduled_tasks scheduled ON scheduled.project_id=s.project_id
      WHERE scheduled.id=? AND t.status IN ('running','blocked','uncertain') LIMIT 1`).get(scheduleId);
    const tracker = sessionId ? getTracker(sessionId) : undefined;
    if (active || tracker?.hasPendingExecute || tracker?.state.processState === 'busy') {
      throw new PlatformAiScheduleBusyError('项目已有未完成的工作或目标会话忙碌，跳过本次发送');
    }
  }
  const baseline = sessionId ? (getDb().prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM pty_output WHERE session_id=?').get(sessionId) as {cursor: number}).cursor : 0;
  // Only sequence metadata is read here. All actual output is rendered through the Agent API.
  getDb().prepare(`INSERT INTO platform_ai_schedule_receipts (run_id,baseline_cursor) VALUES (?,?)
    ON CONFLICT(run_id) DO UPDATE SET baseline_cursor=excluded.baseline_cursor`).run(runId, baseline);
}

export function reconcileScheduledObservations(): void {
  const runs = getDb().prepare(`SELECT r.id,r.status,r.session_id,r.error,t.prompt,t.name,l.conversation_id,receipt.baseline_cursor
    FROM platform_ai_schedule_receipts receipt JOIN scheduled_task_runs r ON r.id=receipt.run_id
    JOIN scheduled_tasks t ON t.id=r.task_id JOIN platform_ai_schedule_links l ON l.schedule_id=t.id
    WHERE receipt.reconciled=0 AND r.status!='running' LIMIT 20`).all() as Array<{
      id: string; status: string; session_id: string | null; error: string | null; prompt: string; name: string; conversation_id: string; baseline_cursor: number;
    }>;
  for (const run of runs) {
    getDb().transaction(() => {
      const conversation = getConversation(run.conversation_id);
      if (!conversation) return;
      let taskId: string | null = null;
      if (run.status === 'success' && run.session_id) {
        try { taskId = trackTask(conversation, run.session_id, run.prompt, run.baseline_cursor, run.id).id; }
        catch { enqueueNotice(conversation.id, `schedule-tracking:${run.id}`, `定时任务「${run.name}」已发送，但该会话已有其他跟踪任务，请到平台核对执行情况。`); }
      }
      enqueueNotice(conversation.id, `schedule:${run.id}`, run.status === 'success'
        ? `定时任务「${run.name}」已发送，正在跟踪 Agent 执行结果。${taskId ? '\n任务：' + taskId : ''}`
        : `定时任务「${run.name}」${run.status === 'skipped' ? '本次跳过' : run.status === 'stopped' ? '已停止' : '发送失败'}。${run.error || ''}`);
      getDb().prepare('UPDATE platform_ai_schedule_receipts SET reconciled=1,task_id=? WHERE run_id=?').run(taskId, run.id);
    })();
  }
}

/** Unique native prompt marker, so repeated schedules cannot reuse an earlier final answer. */
export function scheduledObservationPrompt(scheduleId: string, runId: string, prompt: string): string {
  const link = getDb().prepare('SELECT 1 FROM platform_ai_schedule_links WHERE schedule_id=?').get(scheduleId);
  return link ? `${prompt}\n\n[Platform task reference: ${runId}]` : prompt;
}
