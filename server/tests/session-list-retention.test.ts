import {afterEach,beforeEach,expect,it} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createSession as createAuthSession,createUser} from '../src/auth.js';
import Fastify from 'fastify';
import {sessionRoutes} from '../src/routes/sessions.js';
import {getDb} from '../src/db/index.js';
import {listSessions,listSessionsForUser} from '../src/services/session-manager.js';
let cleanup:()=>void,owner:string,other:string;
beforeEach(()=>{const fixture=createTestDatabase();cleanup=fixture.cleanup;owner=createUser({username:'owner',password:'password1'}).id;other=createUser({username:'other',password:'password2'}).id;const insert=getDb().prepare('INSERT INTO sessions(id,task,status,created_by_user_id,created_at) VALUES(?,?,?,?,?)');for(let i=0;i<60;i++){insert.run(`ended-${i}`,'ended','completed',owner,`2026-10-${String(i%28+1).padStart(2,'0')} 00:00:00`);insert.run(`foreign-${i}`,'foreign','completed',other,'2026-11-01 00:00:00');}for(const status of ['running','pending','launching','detached','released'])insert.run(`old-${status}`,'old',status,owner,'2020-01-01 00:00:00');});
afterEach(()=>cleanup());
it('retains every process-bearing old session beyond the 50-record history window',()=>{for(const rows of [listSessions(),listSessionsForUser(owner)])for(const status of ['running','pending','launching','detached','released'])expect(rows.some(row=>row.id===`old-${status}`)).toBe(true);});
it('applies the history limit within the owner and never imports another account into their tabs',()=>{const rows=listSessionsForUser(owner);expect(rows).toHaveLength(55);expect(rows.every(row=>row.created_by_user_id===owner)).toBe(true);expect(listSessionsForUser(owner,'detached').map(row=>row.id)).toEqual(['old-detached']);});

it('shows the latest terminal sequence time and falls back to the session row without output', async () => {
 const db = getDb();
 db.prepare("UPDATE sessions SET updated_at = '2026-11-01 01:00:00', mode = 'terminal' WHERE id IN ('old-running', 'old-detached')").run();
 const output = db.prepare('INSERT INTO pty_output(session_id, seq, data, created_at) VALUES (?, ?, ?, ?)');
 output.run('old-running', 3, 'latest sequence', '2026-11-02 00:00:00');
 output.run('old-running', 2, 'arrived later', '2026-11-03 00:00:00');
 const app = Fastify();
 app.addHook('onRequest', authHook);
 await app.register(sessionRoutes, { prefix: '/api' });
 try {
  const response = await app.inject({
   method: 'GET', url: '/api/sessions', headers: { cookie: `agentmanager_session=${createAuthSession(owner)}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().sessions).toEqual(expect.arrayContaining([
   expect.objectContaining({ id: 'old-running', last_activity_at: '2026-11-02T00:00:00Z' }),
   expect.objectContaining({ id: 'old-detached', last_activity_at: '2026-11-01T01:00:00Z' }),
  ]));
 } finally {
  await app.close();
 }
});
