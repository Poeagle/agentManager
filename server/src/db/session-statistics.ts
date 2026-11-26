import type Database from 'better-sqlite3';

export function migrateSessionStatistics(db: Database.Database, backfillTabUsage: boolean) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_statistics_sources (
      source TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      native_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      codec_version INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      offset INTEGER NOT NULL,
      length INTEGER NOT NULL,
      stamp TEXT NOT NULL,
      first_anchor TEXT NOT NULL,
      end_anchor TEXT NOT NULL,
      skipping INTEGER NOT NULL,
      caught_up INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      adapter_state TEXT NOT NULL,
      projection_state TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_statistics_requests (
      source TEXT NOT NULL REFERENCES session_statistics_sources(source) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      position INTEGER NOT NULL,
      input_id TEXT,
      tool_calls INTEGER NOT NULL,
      fact TEXT NOT NULL,
      PRIMARY KEY(source, request_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS session_statistics_source_scope ON session_statistics_sources(agent,environment,native_id);
    CREATE TABLE IF NOT EXISTS session_statistics_items (
      source TEXT NOT NULL REFERENCES session_statistics_sources(source) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      facts TEXT NOT NULL,
      PRIMARY KEY(source, item_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS session_statistics_timeline ON session_statistics_items(source, position);
    CREATE INDEX IF NOT EXISTS session_statistics_live ON session_statistics_items(source, revision, position);
    CREATE INDEX IF NOT EXISTS session_statistics_finals ON session_statistics_items(source, position DESC, item_id DESC)
      WHERE json_type(facts, '$.conclusion') = 'object';
    CREATE INDEX IF NOT EXISTS session_statistics_progress_timeline ON session_statistics_items(source, position DESC, item_id DESC)
      WHERE json_extract(facts, '$.segment.id') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS session_statistics_progress_identity
      ON session_statistics_items(source, json_extract(facts, '$.segment.id'), revision DESC, position DESC, item_id DESC)
      WHERE json_extract(facts, '$.segment.id') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS session_statistics_progress_items
      ON session_statistics_items(source, json_extract(facts, '$.progress_id'), position);
    CREATE TABLE IF NOT EXISTS session_statistics_identities (
      source TEXT NOT NULL REFERENCES session_statistics_sources(source) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      PRIMARY KEY(source, identity)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS session_statistics_models (
      source TEXT NOT NULL REFERENCES session_statistics_sources(source) ON DELETE CASCADE,
      dimensions TEXT NOT NULL,
      counter TEXT NOT NULL,
      PRIMARY KEY(source, dimensions)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS session_statistics_cache_drops (
      source TEXT NOT NULL REFERENCES session_statistics_sources(source) ON DELETE CASCADE,
      id TEXT NOT NULL,
      input_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      position INTEGER NOT NULL,
      fact TEXT NOT NULL,
      PRIMARY KEY(source, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS session_statistics_drops_timeline ON session_statistics_cache_drops(source, occurred_at DESC, position DESC, id);
    CREATE INDEX IF NOT EXISTS session_statistics_drops_input ON session_statistics_cache_drops(source, input_id);
    CREATE INDEX IF NOT EXISTS session_statistics_drops_source_input ON session_statistics_cache_drops(source, json_extract(fact, '$.current.input_id'));
    CREATE TABLE IF NOT EXISTS session_statistics_events (
      source TEXT NOT NULL,
      id TEXT NOT NULL,
      occurred_at TEXT,
      position INTEGER NOT NULL,
      evidence TEXT NOT NULL CHECK(evidence IN ('native','platform')),
      owner_id TEXT,
      fact TEXT NOT NULL,
      PRIMARY KEY(source, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS session_statistics_events_order ON session_statistics_events(source, occurred_at DESC, position DESC, id);
    CREATE TABLE IF NOT EXISTS session_tab_usage_sources (
      tab_id TEXT NOT NULL,
      source TEXT NOT NULL,
      parent_tab_id TEXT,
      project_id TEXT,
      owner_id TEXT,
      PRIMARY KEY(tab_id, source)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS session_tab_usage_by_parent ON session_tab_usage_sources(parent_tab_id, project_id, owner_id);
    CREATE INDEX IF NOT EXISTS session_tab_usage_by_source ON session_tab_usage_sources(source);
    CREATE INDEX IF NOT EXISTS session_usage_children ON sessions(parent_session_id, project_id, created_by_user_id);
    CREATE INDEX IF NOT EXISTS session_statistics_inherited_receipts ON session_statistics_requests(source)
      WHERE json_extract(fact, '$.inherited') = 1;
  `);
  if (backfillTabUsage) db.exec(`
    INSERT OR IGNORE INTO session_tab_usage_sources(tab_id, source, parent_tab_id, project_id, owner_id)
    SELECT s.id, e.source, s.parent_session_id, s.project_id, s.created_by_user_id
    FROM session_statistics_events e JOIN sessions s ON s.id=json_extract(e.fact,'$.platform_session_id')
    WHERE e.evidence='platform' AND e.owner_id IS s.created_by_user_id
      AND json_extract(e.fact,'$.action') IN ('create','resume') AND json_extract(e.fact,'$.state')='accepted'
      AND EXISTS (SELECT 1 FROM session_statistics_sources recorded WHERE recorded.source=e.source);
  `);
  if (backfillTabUsage && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_docs_operations'").get()) db.exec(`
    WITH creations AS MATERIALIZED (
      SELECT tab_id AS parent_id, json_extract(result,'$.tab_id') AS child_id
      FROM agent_docs_operations
      WHERE CASE WHEN json_valid(result) THEN json_type(result,'$.launch_status')='text' ELSE 0 END
    )
    INSERT OR IGNORE INTO session_tab_usage_sources(tab_id, source, parent_tab_id, project_id, owner_id)
    SELECT creation.child_id,e.source,parent.id,parent.project_id,parent.created_by_user_id
    FROM creations creation JOIN sessions parent ON parent.id=creation.parent_id
    JOIN session_statistics_events e ON json_extract(e.fact,'$.platform_session_id')=creation.child_id
    WHERE creation.child_id<>parent.id AND parent.created_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sessions existing WHERE existing.id=creation.child_id)
      AND e.evidence='platform' AND e.owner_id=parent.created_by_user_id
      AND json_extract(e.fact,'$.action') IN ('create','resume') AND json_extract(e.fact,'$.state')='accepted'
      AND EXISTS (SELECT 1 FROM session_statistics_sources recorded WHERE recorded.source=e.source);
  `);
}
