import type Database from 'better-sqlite3';

export function migrateNotifications(db:Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    native_id TEXT NOT NULL,source_id TEXT NOT NULL,message_id TEXT,turn_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('question','approval','result','error')),
    state TEXT NOT NULL CHECK(state IN ('pending','recovering','submitted','resolved','info')),
    title TEXT NOT NULL,body TEXT NOT NULL,read_at TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(user_id,session_id,native_id,kind,source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,id DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_session ON notifications(session_id,native_id);
  `);
  const columns=db.pragma('table_info(notifications)') as {name:string}[];
  if(!columns.some(column=>column.name==='dismissed_at'))db.exec('ALTER TABLE notifications ADD COLUMN dismissed_at TEXT');
}
