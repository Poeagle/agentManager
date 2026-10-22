import {afterEach, expect, it} from 'vitest';
import {createUser} from '../src/auth.js';
import {closeDb, getDb, initDb} from '../src/db/index.js';
import {createTestDatabase} from './helpers/database.js';

let cleanup: (() => void) | undefined;
afterEach(()=>cleanup?.());

it('repairs the missing watch rechecks column at the current schema version without losing data', () => {
  const fixture=createTestDatabase(); cleanup=fixture.cleanup;
  const db=getDb();
  // Standalone and already-upgraded installations both exercise this path.
  db.exec('CREATE TABLE IF NOT EXISTS platform_ai_project_notification_watches (rule_id TEXT,session_id TEXT, failures INTEGER NOT NULL DEFAULT 0)');
  const columns=db.prepare('PRAGMA table_info(platform_ai_project_notification_watches)').all() as Array<{name:string}>;
  if(columns.some(column=>column.name==='rechecks')) db.exec('ALTER TABLE platform_ai_project_notification_watches DROP COLUMN rechecks');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_ai_project_notifications'").get()) {
    const user=createUser({username:'owner',password:'password1',role:'admin'}).id;
    db.prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('project','Project',?,?)").run(fixture.dir,user);
    db.exec("INSERT INTO sessions(id,project_id,task,status) VALUES ('tab','project','Task','running')");
    db.prepare("INSERT INTO platform_ai_conversations(id,user_id,external_chat_id,external_user_id) VALUES ('conversation',?,'chat','sender')").run(user);
    db.prepare("INSERT INTO platform_ai_project_notifications(id,user_id,project_id,recipient_id,conversation_id,since_ms) VALUES ('rule',?,'project','recipient','conversation',0)").run(user);
  }
  db.prepare("INSERT INTO platform_ai_project_notification_watches(rule_id,session_id,failures) VALUES ('rule','tab',2)").run();
  const version=db.pragma('user_version',{simple:true});
  closeDb(); initDb();
  expect(getDb().prepare("SELECT rechecks,failures FROM platform_ai_project_notification_watches WHERE rule_id='rule'").get()).toEqual({rechecks:0,failures:2});
  expect(getDb().pragma('user_version',{simple:true})).toBe(version);
  closeDb(); initDb();
  expect(getDb().prepare("SELECT COUNT(*) AS count FROM platform_ai_project_notification_watches").get()).toEqual({count:1});
});
