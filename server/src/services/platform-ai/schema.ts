import type Database from 'better-sqlite3';

export function migratePlatformAi(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_ai_channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('webhook','wecom','wecom_bot','wecom_webhook','wechat','qq')),
      enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
      secrets TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS platform_ai_bindings (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES platform_ai_channels(id) ON DELETE CASCADE,
      external_user_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(channel_id, external_user_id)
    );
    CREATE TABLE IF NOT EXISTS platform_ai_conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES platform_ai_channels(id) ON DELETE CASCADE,
      external_chat_id TEXT NOT NULL, external_user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '[]',
      reply_context TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_ai_conversation_source
      ON platform_ai_conversations(COALESCE(channel_id,''), external_chat_id, external_user_id, user_id);
    CREATE TABLE IF NOT EXISTS platform_ai_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES platform_ai_conversations(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','notice')),
      content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      error TEXT, checkpoint TEXT NOT NULL DEFAULT '[]', reply_context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(conversation_id, external_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_platform_ai_messages_queue ON platform_ai_messages(status,available_at);
    CREATE TABLE IF NOT EXISTS platform_ai_operations (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES platform_ai_messages(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL,
      result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS platform_ai_tasks (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES platform_ai_conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, requirement TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running',
      cursor INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT '',
      last_fingerprint TEXT NOT NULL DEFAULT '', last_assessed_fingerprint TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
      next_observe_at INTEGER NOT NULL DEFAULT 0, last_assessed_at INTEGER NOT NULL DEFAULT 0,
      last_notified_at INTEGER NOT NULL DEFAULT 0, observation_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_ai_task_active_session ON platform_ai_tasks(session_id)
      WHERE status IN ('running','blocked','uncertain');
    CREATE INDEX IF NOT EXISTS idx_platform_ai_tasks_due ON platform_ai_tasks(status,next_observe_at);
    CREATE TABLE IF NOT EXISTS platform_ai_schedule_links (
      schedule_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES platform_ai_conversations(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS platform_ai_schedule_receipts (
      run_id TEXT PRIMARY KEY REFERENCES scheduled_task_runs(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES platform_ai_tasks(id) ON DELETE SET NULL,
      baseline_cursor INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS platform_ai_outbox (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES platform_ai_conversations(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, reply_context TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_ai_outbox_queue ON platform_ai_outbox(status,available_at);
  `);
  const channelSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE name='platform_ai_channels'").get() as {sql: string}).sql;
  if (!channelSchema.includes("'wecom_bot'")) {
    // The migration runner disables FK actions around this transaction. Rebuild
    // the parent without cascading deletion into bindings/conversations.
    db.exec(`CREATE TABLE platform_ai_channels_v16 (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('webhook','wecom','wecom_bot','wecom_webhook','wechat','qq')),
      enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
      secrets TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO platform_ai_channels_v16 SELECT * FROM platform_ai_channels;
      DROP TABLE platform_ai_channels;
      ALTER TABLE platform_ai_channels_v16 RENAME TO platform_ai_channels;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS platform_ai_channel_senders (
    channel_id TEXT NOT NULL REFERENCES platform_ai_channels(id) ON DELETE CASCADE,
    external_user_id TEXT NOT NULL, last_chat_id TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(channel_id,external_user_id));
    CREATE TABLE IF NOT EXISTS platform_ai_notification_targets (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES platform_ai_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(channel_id,user_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS platform_ai_attachments (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES platform_ai_messages(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', mime TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0, data BLOB, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_platform_ai_attachments_message ON platform_ai_attachments(message_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS platform_ai_project_notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES platform_ai_conversations(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1, on_complete INTEGER NOT NULL DEFAULT 1, on_input INTEGER NOT NULL DEFAULT 1,
    since_ms INTEGER NOT NULL, UNIQUE(user_id,project_id,recipient_id));
    CREATE TABLE IF NOT EXISTS platform_ai_project_notification_watches (
    rule_id TEXT NOT NULL REFERENCES platform_ai_project_notifications(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    next_check_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, rechecks INTEGER NOT NULL DEFAULT 0, error TEXT,
    PRIMARY KEY(rule_id,session_id));
    CREATE INDEX IF NOT EXISTS idx_platform_ai_project_notification_due ON platform_ai_project_notification_watches(next_check_at);
    CREATE TABLE IF NOT EXISTS platform_ai_project_notification_receipts (
    rule_id TEXT NOT NULL REFERENCES platform_ai_project_notifications(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL, PRIMARY KEY(rule_id,session_id,event_key));`);
  // CREATE TABLE IF NOT EXISTS does not repair an already-created table.
  // Run on every startup, including databases already at the current version.
  const watchColumns = db.prepare('PRAGMA table_info(platform_ai_project_notification_watches)').all() as Array<{name: string}>;
  if (watchColumns.length && !watchColumns.some(column => column.name === 'rechecks')) {
    db.exec('ALTER TABLE platform_ai_project_notification_watches ADD COLUMN rechecks INTEGER NOT NULL DEFAULT 0');
  }
  const outboxColumns = db.prepare('PRAGMA table_info(platform_ai_outbox)').all() as Array<{name: string}>;
  if (!outboxColumns.some(column => column.name === 'destination_channel_id')) {
    db.exec('ALTER TABLE platform_ai_outbox ADD COLUMN destination_channel_id TEXT REFERENCES platform_ai_channels(id) ON DELETE SET NULL');
  }
  const taskColumns = db.prepare('PRAGMA table_info(platform_ai_tasks)').all() as Array<{name: string}>;
  if (!taskColumns.some(column => column.name === 'source_ref')) db.exec("ALTER TABLE platform_ai_tasks ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.some(column => column.name === 'last_assessed_output')) db.exec("ALTER TABLE platform_ai_tasks ADD COLUMN last_assessed_output TEXT NOT NULL DEFAULT ''");
  const messageColumns = db.prepare('PRAGMA table_info(platform_ai_messages)').all() as Array<{name: string}>;
  for (const column of ['progress', 'partial_content']) {
    if (!messageColumns.some(item => item.name === column)) db.exec(`ALTER TABLE platform_ai_messages ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
}
