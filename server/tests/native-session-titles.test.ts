import {beforeEach,afterEach,it,expect} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {rememberCodexTitle} from '../src/services/agents/codex/thread-title.js';
import {nativeSessionTitle} from '../src/services/native-session-titles.js';
let fixture:ReturnType<typeof createTestDatabase>;beforeEach(()=>{fixture=createTestDatabase();const db=getDb();db.prepare("INSERT INTO sessions(id,task,cli_type,codex_session_id,agent_environment_id) VALUES('a','Terminal','codex','same','one'),('b','Terminal','codex','same','two')").run();});afterEach(()=>fixture.cleanup());
it('scopes a native title to its engine and persists subsequent generated names',()=>{
 rememberCodexTitle('same','First title','one');expect(nativeSessionTitle('a')).toBe('First title');expect(nativeSessionTitle('b')).toBeNull();rememberCodexTitle('same','New title','one');expect(nativeSessionTitle('a')).toBe('New title');rememberCodexTitle('same',' ','one');expect(nativeSessionTitle('a')).toBe('New title');
});
it('presents generated titles while preserving explicit user labels',async()=>{
 const {sessionPresenter}=await import('../src/services/session-labels.js');const db=getDb();db.prepare("INSERT INTO users(id,username,password_hash) VALUES('viewer','viewer','fixture')").run();db.prepare("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture')").run();db.prepare("UPDATE sessions SET project_id='p' WHERE id='a'").run();rememberCodexTitle('same','Generated','one');
 db.prepare('INSERT INTO user_ui_state(user_id,key,value) VALUES(?,?,?)').run('viewer','project:p',JSON.stringify({terminalInstances:[{id:'a',label:'Session 1'}]}));const session={id:'a',project_id:'p',task:'Terminal'};expect(sessionPresenter('viewer')(session)).toMatchObject({native_title:'Generated',display_name:'Generated'});
 db.prepare('UPDATE user_ui_state SET value=?').run(JSON.stringify({terminalInstances:[{id:'a',label:'Session 1',customLabel:'My own name'}]}));expect(sessionPresenter('viewer')(session)).toMatchObject({native_title:'Generated',display_name:'My own name'});
});
it('supports a Codex API-provider environment without overwriting another engine title',()=>{
 const db=getDb();db.prepare("INSERT INTO sessions(id,task,cli_type,codex_session_id,agent_environment_id) VALUES('api','Terminal','codex','same','provider:api')").run();rememberCodexTitle('same','API generated title','provider:api');expect(nativeSessionTitle('api')).toBe('API generated title');expect(nativeSessionTitle('a')).toBeNull();expect(nativeSessionTitle('b')).toBeNull();
});
