import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser, setProjectToolAccess } from '../src/auth.js';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { agentRoutes } from '../src/routes/agent.js';
import { factId } from '../src/services/agents/session-fact-values.js';
import { activateFreshConversation, snapshotConversation } from '../src/services/conversation-history.js';
import { subscribe } from '../src/services/event-store.js';
import { getSession, purgeSessionRecord } from '../src/services/session-manager.js';
import { recordSessionBinding } from '../src/services/session-statistics.js';
import { notifyTabUsage, readTabUsage } from '../src/services/session-tab-usage.js';
import { createTestDatabase } from './helpers/database.js';

let fixture:ReturnType<typeof createTestDatabase>, owner:string;
beforeEach(()=>{
  fixture=createTestDatabase();
  vi.stubEnv('CODEX_HOME',`${fixture.dir}/codex`);
  vi.stubEnv('CLAUDE_CONFIG_DIR',`${fixture.dir}/claude`);
  owner=createUser({username:'usage-owner',password:'password1',role:'admin'}).id;
  const addProject=getDb().prepare('INSERT INTO projects(id,name,path,owner_id) VALUES(?,?,?,?)');
  for(const project of ['own','other'])addProject.run(project,project,`${fixture.dir}/${project}`,owner);
  setProjectToolAccess({projectId:'own',userId:owner,canSession:true,canTerminal:true,sessionClients:['codex','claude'],grantedBy:owner});
});
afterEach(()=>{vi.unstubAllEnvs();fixture.cleanup();});

function tab(id:string,native:string,parent:string|null=null,project='own',agent='codex') {
  getDb().prepare(`INSERT INTO sessions(id,task,project_id,created_by_user_id,agent_id,cli_type,native_session_id,parent_session_id,status,mode)
    VALUES(?,?,?,?,?,?,?,?,'completed','session')`).run(id,id,project,owner,agent,agent,native,parent);
  return getSession(id)!;
}
function receipt(native:string,tokens:number,amount:number,unit='credits',agent='codex',env='native',inheritedTokens=0){
  const db=getDb(),source=factId(agent,env,native),cost={amount,unit,complete:true};
  const summary={native_id:native,status:'complete',totals:{tokens:{total_tokens:tokens+inheritedTokens},cost:{...cost,amount:amount+(inheritedTokens?20:0)},requests:inheritedTokens?2:1}};
  db.prepare(`INSERT OR REPLACE INTO session_statistics_sources VALUES(?,?,?,?,100,'file',0,0,'','','',0,1,1,'null','{}',?)`)
    .run(source,agent,native,env,JSON.stringify(summary));
  if(inheritedTokens){
    const add=db.prepare(`INSERT OR REPLACE INTO session_statistics_requests VALUES(?,?,'generation',0,NULL,0,?)`);
    add.run(source,'own',JSON.stringify({tokens:{total_tokens:tokens},cost}));
    add.run(source,'imported',JSON.stringify({tokens:{total_tokens:inheritedTokens},cost:{...cost,amount:20},inherited:true}));
  }
  return source;
}

it('keeps lifetime usage through a native restart, account fork, transcript cleanup and database reopen',async()=>{
  tab('work','original');
  receipt('original',100,20);
  const archive=snapshotConversation('work');
  activateFreshConversation('work',archive,'forked');
  getDb().prepare("UPDATE sessions SET agent_environment_id='account:changed' WHERE id='work'").run();
  receipt('forked',50,10,'credits','codex','account:changed',100);
  expect(readTabUsage(getSession('work')!)).toEqual({total_tokens:150,costs:[{unit:'credits',amount:30,complete:true}],complete:true});
  expect(await purgeSessionRecord(archive)).toEqual({ok:true});
  closeDb();initDb();
  expect(readTabUsage(getSession('work')!)).toMatchObject({total_tokens:150,costs:[{unit:'credits',amount:30}],complete:true});
  const independent=tab('plus','blank');
  expect(readTabUsage(independent)).toBeNull();
});

it('includes live and deleted descendants once while isolating unrelated tabs and pricing units',async()=>{
  const root=tab('root','root-native');
  tab('child','child-native','root');
  tab('grandchild','grand-native','child','own','claude');
  tab('unrelated','hidden-native','root','other');
  receipt('root-native',100,20);
  receipt('child-native',50,10);
  const grand=receipt('grand-native',80,2,'USD','claude');
  receipt('hidden-native',1000,200);
  expect(readTabUsage(root)).toMatchObject({total_tokens:230,costs:[{unit:'credits',amount:30},{unit:'USD',amount:2}]});
  expect(readTabUsage(getSession('child')!)).toMatchObject({total_tokens:130});
  expect(await purgeSessionRecord('child')).toEqual({ok:true});
  expect(readTabUsage(root)).toMatchObject({total_tokens:230});
  const refreshed:string[]=[];
  const stop=subscribe(event=>{if(event.type==='session.tab-usage'&&event.session_id)refreshed.push(event.session_id);});
  try {
    notifyTabUsage(grand,'claude','native','grand-native');
    expect(refreshed.sort()).toEqual(['grandchild','root']);
  } finally {stop();}
  expect(await purgeSessionRecord('grandchild')).toEqual({ok:true});
  expect(readTabUsage(root)).toMatchObject({total_tokens:230,costs:[{unit:'credits',amount:30},{unit:'USD',amount:2}]});
});

it('reconstructs known tab bindings when upgrading a database and protects the public endpoint',async()=>{
  const current=tab('task','native-now');
  recordSessionBinding(current,'native-previous',null);
  receipt('native-previous',70,5);
  receipt('native-now',15,1);
  const oldChild=tab('deleted-child','child-previous','task');
  recordSessionBinding(oldChild,'child-previous',null);
  receipt('child-previous',40,2);
  getDb().exec(`CREATE TABLE agent_docs_operations (tab_id TEXT, result TEXT);
    INSERT INTO agent_docs_operations VALUES ('task','{"tab_id":"deleted-child","launch_status":"running"}');
    DELETE FROM sessions WHERE id='deleted-child';
    DROP TABLE session_tab_usage_sources; PRAGMA user_version=30;`);
  closeDb();initDb();
  const app=Fastify();
  await app.register(websocket);
  app.addHook('onRequest',authHook);
  await app.register(agentRoutes,{prefix:'/api'});
  try {
    const privateTab='/api/sessions/task/tab-usage';
    const response=await app.inject({url:privateTab,headers:{cookie:`agentmanager_session=${createSession(owner)}`}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({usage:{total_tokens:125,costs:[{unit:'credits',amount:8}]}});
    expect(response.headers['cache-control']).toBe('private, no-store');
    const unrelated=createUser({username:'unrelated',password:'password1'}).id;
    expect((await app.inject({url:privateTab,headers:{cookie:`agentmanager_session=${createSession(unrelated)}`}})).statusCode).toBeGreaterThanOrEqual(403);
  } finally {await app.close();}
});
