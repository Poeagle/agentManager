import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';

export const agentDocsBatchLimits = {
  batch_tasks: 32, active_batches: 8, batch_timeout_default: 1800, batch_timeout_max: 86400,
};

export interface AgentDocsBatch {
  id: string;
  tab_id: string;
  native_id: string;
  environment_id: string;
  deadline: number;
  task_count: number;
  sealed: number;
  wake_status: string;
  wake_reason: string | null;
  wake_error: string | null;
}

type Delivery = { tab_id?: string; message_id?: string; status?: string; reason?: string };
type Dispatch = Delivery & {
  results?: Delivery[];
  launch_status?: string;
  initial_message_id?: string;
  initial_message_status?: string;
  initial_message_reason?: string;
};

export function initAgentDocsBatches() {
  const db = getDb();
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_docs_batches (
        id TEXT PRIMARY KEY, tab_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        native_id TEXT NOT NULL, environment_id TEXT NOT NULL, deadline INTEGER NOT NULL,
        task_count INTEGER NOT NULL DEFAULT 0, sealed INTEGER NOT NULL DEFAULT 0,
        wake_status TEXT NOT NULL DEFAULT 'waiting', wake_reason TEXT, wake_error TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_docs_batch_deadline ON agent_docs_batches(wake_status,deadline);
      CREATE INDEX IF NOT EXISTS agent_docs_batch_owner ON agent_docs_batches(tab_id,wake_status);
    `);
    const add = (table: string, column: string, type: string) => {
      if (!(db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(item => item.name === column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    add('agent_docs_operations', 'batch_id', 'TEXT');
    add('agent_docs_operations', 'batch_size', 'INTEGER');
    add('agent_docs_handoffs', 'batch_id', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS agent_docs_operation_batch ON agent_docs_operations(batch_id);
      CREATE INDEX IF NOT EXISTS agent_docs_handoff_batch ON agent_docs_handoffs(batch_id,source_tab_id,request_id);
      UPDATE agent_docs_batches SET wake_status='unknown' WHERE wake_status='submitting';
    `);
  })();
}

export function openAgentDocsBatch(tabId: string, nativeId: string, environmentId: string, seconds: number) {
  const db = getDb();
  const id = randomUUID(), deadline = Date.now() + seconds * 1000;
  const insert = db.prepare(`INSERT INTO agent_docs_batches(id,tab_id,native_id,environment_id,deadline)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM agent_docs_batches WHERE tab_id=? AND wake_status='waiting') < ?`)
    .run(id, tabId, nativeId, environmentId, deadline, tabId, agentDocsBatchLimits.active_batches);
  return insert.changes ? { batch_id: id, deadline_at: new Date(deadline).toISOString() } : undefined;
}

export function getAgentDocsBatch(id: string, tabId: string) {
  return getDb().prepare('SELECT * FROM agent_docs_batches WHERE id=? AND tab_id=?').get(id, tabId) as AgentDocsBatch | undefined;
}

/** Only platform-initiated brief handoffs continue active batches in the fresh conversation. */
export function rebindActiveAgentDocsBatches(tabId: string, oldNative: string, newNative: string, environmentId: string, newEnvironmentId=environmentId) {
  if(!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_docs_batches'").get())return;
  getDb().prepare(`UPDATE agent_docs_batches SET native_id=?,environment_id=? WHERE tab_id=? AND native_id=?
    AND environment_id=? AND wake_status IN ('waiting','submitting')`).run(newNative, newEnvironmentId, tabId, oldNative, environmentId);
}

/** Called within the same transaction that records the idempotent dispatch operation. */
export function reserveAgentDocsBatch(id: string, tabId: string, count: number) {
  return getDb().prepare(`UPDATE agent_docs_batches SET task_count=task_count+? WHERE id=? AND tab_id=?
    AND sealed=0 AND wake_status='waiting' AND deadline>? AND task_count+?<=?`)
    .run(count, id, tabId, Date.now(), count, agentDocsBatchLimits.batch_tasks).changes > 0;
}

export function sealAgentDocsBatch(id: string, tabId: string) {
  getDb().prepare("UPDATE agent_docs_batches SET sealed=1 WHERE id=? AND tab_id=? AND wake_status='waiting' AND deadline>?")
    .run(id, tabId, Date.now());
}

export function agentDocsBatchSnapshot(batch: AgentDocsBatch) {
  const db = getDb();
  const operations = db.prepare(`SELECT request_id,state,result,batch_size FROM agent_docs_operations
    WHERE batch_id=? AND tab_id=? ORDER BY rowid`).all(batch.id, batch.tab_id) as
    Array<{ request_id: string; state: string; result: string | null; batch_size: number }>;
  const latestResult = db.prepare(`SELECT id,source_tab_id,source_label FROM agent_docs_handoffs
    WHERE reply_to=? AND target_tab_id=? AND batch_id=? AND intent='result' AND status='stored'
    ORDER BY rowid DESC LIMIT 1`);
  const outgoing = db.prepare(`SELECT id AS message_id,target_tab_id AS tab_id,status FROM agent_docs_handoffs
    WHERE batch_id=? AND source_tab_id=? AND request_id=? AND intent='task' AND reply_to IS NULL`);
  const tasks = operations.flatMap(operation => {
    const dispatch: Dispatch | null = operation.result ? JSON.parse(operation.result) : null;
    const deliveries = dispatch?.results || [{
      tab_id: dispatch?.tab_id, message_id: dispatch?.initial_message_id,
      status: dispatch?.initial_message_status ?? dispatch?.launch_status,
      reason: dispatch?.initial_message_reason ?? dispatch?.reason,
    }];
    // The handoff can be committed before the operation has recorded its receipt.
    const sent = new Map((outgoing.all(batch.id, batch.tab_id, operation.request_id) as Delivery[])
      .map(item => [item.tab_id, item]));
    return Array.from({ length: operation.batch_size }, (_, index) => {
      const receipt = deliveries[index];
      const handoff = sent.get(receipt?.tab_id);
      const messageId = receipt?.message_id ?? handoff?.message_id;
      const status = handoff?.status ?? receipt?.status;
      const response = messageId ? latestResult.get(messageId, batch.tab_id, batch.id) as
        { id: string; source_tab_id: string; source_label: string } | undefined : undefined;
      return { request_id: operation.request_id, tab_id: receipt?.tab_id ?? null, message_id: messageId ?? null,
        state: response ? 'result' : status === 'rejected' ? 'unavailable' : 'pending',
        delivery_status: status ?? 'unknown', reason: receipt?.reason ?? null,
        result_message_id: response?.id ?? null, source_tab_id: response?.source_tab_id ?? null, source_label: response?.source_label ?? null };
    });
  });
  return {
    batch_id: batch.id, deadline_at: new Date(batch.deadline).toISOString(), sealed: !!batch.sealed,
    wake_status: batch.wake_status, wake_reason: batch.wake_reason, wake_error: batch.wake_error,
    dispatching: operations.some(operation => operation.state === 'pending'),
    task_count: batch.task_count, tasks,
  };
}

type Wake = (batch: AgentDocsBatch, text: string) => Promise<{ status: string; reason?: string }>;

/** One deadline timer per server. Reply/seal events handle ready batches without polling. */
export function agentDocsBatchScheduler(wake: Wake, logError: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recovery: ReturnType<typeof setImmediate> | undefined;
  let stopped = false;
  const active = new Set<Promise<void>>();

  async function notify(batch: AgentDocsBatch) {
    const db = getDb();
    const snapshot = agentDocsBatchSnapshot(batch);
    const deadlineReached = batch.deadline <= Date.now();
    const ready = batch.sealed && snapshot.tasks.length === batch.task_count
      && snapshot.tasks.every(task => task.state !== 'pending');
    if (!deadlineReached && !ready) return;
    const reason = ready ? 'complete' : 'deadline';
    const status = batch.task_count ? 'submitting' : 'skipped';
    if (!db.prepare(`UPDATE agent_docs_batches SET wake_status=?,wake_reason=? WHERE id=? AND wake_status='waiting'`)
      .run(status, reason, batch.id).changes || status === 'skipped') return;

    const resultCount = snapshot.tasks.filter(task => task.state === 'result').length;
    const unavailable = snapshot.tasks.filter(task => task.state === 'unavailable').length;
    const pending = batch.task_count - resultCount - unavailable;
    const sources = [...new Set(snapshot.tasks.flatMap(task => task.source_label ? [task.source_label.replace(/\s+/g, ' ').slice(0, 120)] : []))];
    const text = `协作批次 ${batch.id}${ready ? '已收齐' : '已到等待时限'}。结果 ${resultCount} 项，待回传 ${pending} 项，未能投递 ${unavailable} 项。\n`
      + (sources.length ? `已回传来源：${sources.join('、')}。\n` : '')
      + `使用 agent-docs 的 read-batch ${batch.id} 查看本批任务，再按 result_message_id 用 read-message 读取各项证据和来源。核对待跟进事项后汇总，按需沿用子标签页或在收尾后关闭。`;
    const receipt = await wake(batch, text).catch(error => {
      logError(error);
      return { status: 'unknown', reason: undefined };
    });
    db.prepare("UPDATE agent_docs_batches SET wake_status=?,wake_error=? WHERE id=? AND wake_status='submitting'")
      .run(receipt.status, receipt.reason ?? null, batch.id);
  }

  function check(batch: AgentDocsBatch) {
    if (stopped || batch.wake_status !== 'waiting') return Promise.resolve();
    const task = notify(batch).catch(logError);
    active.add(task);
    void task.then(() => active.delete(task));
    return task;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const next = getDb().prepare("SELECT deadline FROM agent_docs_batches WHERE wake_status='waiting' ORDER BY deadline LIMIT 1")
      .get() as { deadline: number } | undefined;
    if (!next) return;
    timer = setTimeout(() => {
      try {
        const due = getDb().prepare("SELECT * FROM agent_docs_batches WHERE wake_status='waiting' AND deadline<=? ORDER BY deadline LIMIT 16")
          .all(Date.now()) as AgentDocsBatch[];
        void Promise.all(due.map(check)).then(schedule).catch(logError);
      } catch (error) { logError(error); }
    }, Math.max(0, next.deadline - Date.now()));
    timer.unref();
  }

  function recover(after = '') {
    recovery = setImmediate(() => {
      if (stopped) return;
      try {
        const sealed = getDb().prepare("SELECT * FROM agent_docs_batches WHERE wake_status='waiting' AND sealed=1 AND id>? ORDER BY id LIMIT 16")
          .all(after) as AgentDocsBatch[];
        void Promise.all(sealed.map(check)).then(() => {
          if (!stopped && sealed.length === 16) recover(sealed[15].id);
        }).catch(logError);
      } catch (error) { logError(error); }
    });
    recovery.unref();
  }

  return {
    start() {
      schedule();
      recover();
    },
    schedule,
    async check(batchId: string, tabId: string) {
      const batch = getAgentDocsBatch(batchId, tabId);
      if (batch) await check(batch);
      schedule();
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (recovery) clearImmediate(recovery);
      await Promise.all(active);
    },
  };
}
