import type Database from 'better-sqlite3';

export function migrateSessionStatistics(db: Database.Database) {
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
  `);
}
