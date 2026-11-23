import {getDb} from '../db/index.js';
import {broadcastEphemeral} from './event-store.js';

type DeletionState = 'pending' | 'failed';
const QUEUE_LIMIT = 100;

export function sessionRecordDeletionState(id: string): DeletionState | undefined {
  return (getDb().prepare('SELECT state FROM session_record_deletions WHERE session_id=?').get(id) as
    {state: DeletionState} | undefined)?.state;
}

/** Persist the request before the caller reports that cleanup was accepted. */
export function enqueueSessionRecordDeletion(id: string): boolean {
  const result = getDb().prepare(`INSERT INTO session_record_deletions(session_id, state)
    SELECT ?, 'pending' WHERE (SELECT count(*) FROM session_record_deletions WHERE state='pending') < ?
    ON CONFLICT(session_id) DO UPDATE SET state='pending', requested_at=excluded.requested_at`).run(id, QUEUE_LIMIT);
  return result.changes > 0;
}

export function createSessionRecordDeletionWorker(
  purge: (id: string) => Promise<{ok: boolean}>,
  logError: (error: unknown) => void,
) {
  let scheduled: NodeJS.Immediate | undefined;
  let running: Promise<void> | undefined;
  let closing = false;

  async function runNext(): Promise<boolean> {
    const db = getDb();
    const job = db.prepare(`SELECT d.session_id, s.created_by_user_id, s.project_id FROM session_record_deletions d
      JOIN sessions s ON s.id=d.session_id WHERE d.state='pending' ORDER BY d.requested_at,d.session_id LIMIT 1`)
      .get() as {session_id: string; created_by_user_id: string | null; project_id: string | null} | undefined;
    if (!job) return false;

    const result = await purge(job.session_id).catch(error => {
      logError(error);
      return {ok: false};
    });
    // An interrupted worker can retry from the durable queue at next startup.
    if (!result.ok && !closing) {
      db.prepare("UPDATE session_record_deletions SET state='failed' WHERE session_id=?").run(job.session_id);
    }
    if (job.created_by_user_id && !closing) {
      const projectPending = !!db.prepare(`SELECT 1 FROM session_record_deletions d
        JOIN sessions s ON s.id=d.session_id
        WHERE d.state='pending' AND s.created_by_user_id=? AND s.project_id IS ? LIMIT 1`)
        .get(job.created_by_user_id, job.project_id);
      broadcastEphemeral({
        type: 'session.record-deletion', session_id: job.session_id, project_id: job.project_id ?? undefined,
        data: { user_id: job.created_by_user_id, state: result.ok ? 'deleted' : 'failed', project_pending: projectPending },
      });
    }
    return true;
  }

  function wake(): void {
    if (closing || scheduled || running) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      running = runNext().then(
        processed => { running = undefined; if (processed) wake(); },
        error => { running = undefined; logError(error); },
      );
    });
  }

  function enqueue(id: string): boolean {
    if (closing || !enqueueSessionRecordDeletion(id)) return false;
    wake();
    return true;
  }

  return {
    wake,
    enqueue,
    async close() {
      closing = true;
      if (scheduled) clearImmediate(scheduled);
      await running;
    },
  };
}
