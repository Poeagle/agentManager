import { getDb } from '../../db/index.js';
import { getConversation, trackTask, type TrackedTask } from './store.js';

/** Called only for schedules created through the platform AI; existing schedules are untouched. */
export function captureScheduledBaseline(scheduleId: string, runId: string, sessionId: string | null): void {
  const link = getDb().prepare('SELECT conversation_id FROM platform_ai_schedule_links WHERE schedule_id=?').get(scheduleId) as {conversation_id: string} | undefined;
  if (!link) return;
  const baseline = sessionId ? (getDb().prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM pty_output WHERE session_id=?').get(sessionId) as {cursor: number}).cursor : 0;
  // Only sequence metadata is read here. All actual output is rendered through the Agent API.
  getDb().prepare(`INSERT INTO platform_ai_schedule_receipts (run_id,baseline_cursor) VALUES (?,?)
    ON CONFLICT(run_id) DO UPDATE SET baseline_cursor=excluded.baseline_cursor`).run(runId, baseline);
}

export function isScheduledObservation(task: Pick<TrackedTask,'id'|'source_ref'>): boolean {
  return !!task.source_ref&&!!getDb().prepare('SELECT 1 FROM platform_ai_schedule_receipts WHERE run_id=? AND task_id=?').get(task.source_ref,task.id);
}

export function reconcileScheduledObservations(): void {
  const runs = getDb().prepare(`SELECT r.id,r.status,r.session_id,t.prompt,l.conversation_id,receipt.baseline_cursor
    FROM platform_ai_schedule_receipts receipt JOIN scheduled_task_runs r ON r.id=receipt.run_id
    JOIN scheduled_tasks t ON t.id=r.task_id JOIN platform_ai_schedule_links l ON l.schedule_id=t.id
    WHERE receipt.reconciled=0 AND r.status!='running'
      AND (r.status NOT IN ('queued','success') OR NOT EXISTS (
        SELECT 1 FROM platform_ai_tasks active WHERE active.session_id=r.session_id AND active.status IN ('running','blocked','uncertain')
      ))
    ORDER BY r.rowid LIMIT 20`).all() as Array<{
      id: string; status: string; session_id: string | null; prompt: string; conversation_id: string; baseline_cursor: number;
    }>;
  for (const run of runs) {
    getDb().transaction(() => {
      const conversation = getConversation(run.conversation_id);
      if (!conversation) return;
      const accepted = run.status === 'success' || run.status === 'queued';
      if (accepted && getDb().prepare(
        "SELECT 1 FROM platform_ai_tasks WHERE session_id=? AND status IN ('running','blocked','uncertain')",
      ).get(run.session_id)) return;
      let taskId: string | null = null;
      if (accepted && run.session_id) {
        try { taskId = trackTask(conversation, run.session_id, run.prompt, run.baseline_cursor, run.id).id; }
        catch { /* The scheduler still records the run if tracking is unavailable. */ }
      }
      getDb().prepare('UPDATE platform_ai_schedule_receipts SET reconciled=1,task_id=? WHERE run_id=?').run(taskId, run.id);
    })();
  }
}

/** Unique native prompt marker, so repeated schedules cannot reuse an earlier final answer. */
export function scheduledObservationPrompt(scheduleId: string, runId: string, prompt: string): string {
  const link = getDb().prepare('SELECT 1 FROM platform_ai_schedule_links WHERE schedule_id=?').get(scheduleId);
  return link ? `${prompt}\n\n[Platform task reference: ${runId}]` : prompt;
}
