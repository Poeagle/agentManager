import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'http';
import {WebSocketServer} from 'ws';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {compactCodexConversation,prepareFreshCodexConversation,releaseCodexConversation} from '../src/services/agents/codex/actions.js';
import {configureStreamingSharedResources} from '../src/services/agents/codex/stream.js';
let server:Server,wss:WebSocketServer,dir:string,calls:{method:string;params:any}[],active:boolean,systemError:boolean;
const old='019ff001-1111-7111-8111-111111111111',fresh='019ff001-2222-7222-8222-222222222222';
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'native-actions-'));vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',join(dir,'s'));calls=[];active=false;systemError=false;server=createServer();wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',bytes=>{const f=JSON.parse(bytes.toString());if(!f.id)return;calls.push(f);const thread={id:f.params.threadId||fresh,status:{type:active?'active':systemError?'systemError':'idle'},model:'model-a',reasoningEffort:'high',modelProvider:'openai'};let result:any={};if(f.method==='config/read')result={config:{model_provider:'openai',model:'model-a'}};if(f.method==='model/list')result={data:[{model:'model-a',displayName:'Model A',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}]};if(f.method==='thread/read')result={thread};if(f.method==='thread/resume')result={thread,approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:['/work']};if(f.method==='thread/start')result={thread:{id:fresh}};ws.send(JSON.stringify({id:f.id,result}));}));await new Promise<void>(r=>server.listen(join(dir,'s'),r));});
afterEach(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('uses native compaction only when idle',async()=>{await compactCodexConversation(old);expect(calls.map(c=>c.method)).toContain('thread/compact/start');expect(calls.map(c=>c.method)).not.toContain('turn/start');active=true;await expect(compactCodexConversation(old)).rejects.toThrow('当前任务');expect(calls.filter(c=>c.method==='thread/compact/start')).toHaveLength(1);});
it('new conversation startup supplies shared context once and resume does not inject it again',async()=>{
 const text='<octoally_shared_resources>\n凭据文件：/work/.env\n</octoally_shared_resources>';
 const skill='Discover agent-docs only when needed.';
 await prepareFreshCodexConversation(old,'/work',text,undefined,undefined,undefined,skill);
 expect(calls.find(c=>c.method==='thread/start')?.params.developerInstructions).toBe(text+'\n\n'+skill);
 const before=calls.length;await configureStreamingSharedResources(fresh,text);expect(calls).toHaveLength(before);
 await configureStreamingSharedResources(fresh,text+'\nupdated');expect(calls.at(-1)?.method).toBe('thread/inject_items');
 expect(calls.filter(c=>c.method==='turn/start')).toHaveLength(0);
});
it('prepares a durable fresh thread preserving settings and permissions without a user turn',async()=>{expect(await prepareFreshCodexConversation(old,'/work')).toBe(fresh);expect(calls.find(c=>c.method==='thread/start')?.params).toMatchObject({model:'model-a',modelProvider:'openai',approvalPolicy:'on-request',sandbox:'read-only',config:{model_reasoning_effort:'high'}});expect(calls.filter(c=>c.method==='thread/resume').map(c=>c.params.threadId)).toEqual([old,fresh]);expect(calls.find(c=>c.method==='thread/inject_items')?.params.items[0].role).toBe('developer');expect(calls.map(c=>c.method)).not.toContain('turn/start');await releaseCodexConversation(old);expect(calls.slice(-2).map(c=>c.method)).toEqual(['thread/backgroundTerminals/clean','thread/unsubscribe']);expect(calls.map(c=>c.method)).not.toContain('thread/archive');});

it('allows recovery compaction in native systemError without creating another user turn',async()=>{systemError=true;await compactCodexConversation(old);expect(calls.map(c=>c.method)).toContain('thread/compact/start');expect(calls.map(c=>c.method)).not.toContain('turn/start');});

it('creates an empty thread on the selected engine using its model catalog and source permissions',async()=>{
 const targetPath=join(dir,'target'),targetServer=createServer(),targetWss=new WebSocketServer({server:targetServer}),targetCalls:{method:string;params:any}[]=[];
 targetWss.on('connection',ws=>ws.on('message',bytes=>{const f=JSON.parse(bytes.toString());if(!f.id)return;targetCalls.push(f);let result:any={};
  if(f.method==='config/read')result={config:{model_provider:'target-provider',model:'target-model'}};
  if(f.method==='model/list')result={data:[{model:'target-model',displayName:'Target',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}]};
  if(f.method==='thread/start'||f.method==='thread/resume')result={thread:{id:fresh,status:{type:'idle'},model:'target-model',modelProvider:'target-provider'}};
  ws.send(JSON.stringify({id:f.id,result}));
 }));
 await new Promise<void>(resolve=>targetServer.listen(targetPath,resolve));
 try{
  expect(await prepareFreshCodexConversation(old,'/work',undefined,{model:'target-model',provider:'target-provider',effort:'high'},{socket:targetPath,provider:'target-provider',environmentId:'account:fixture'})).toBe(fresh);
  expect(targetCalls.find(c=>c.method==='thread/start')?.params).toMatchObject({model:'target-model',modelProvider:'target-provider',approvalPolicy:'on-request',sandbox:'read-only'});
  expect(calls.some(c=>c.method==='thread/start'||c.method==='thread/fork')).toBe(false);
  expect(targetCalls.some(c=>c.method==='thread/fork'||c.method==='turn/start')).toBe(false);
  await expect(prepareFreshCodexConversation(old,'/work',undefined,undefined,{socket:targetPath,provider:'target-provider',environmentId:'account:fixture'})).rejects.toThrow('该模型或推理强度当前不可用');
  expect(targetCalls.filter(c=>c.method==='thread/start')).toHaveLength(1);
 }finally{for(const ws of targetWss.clients)ws.terminate();await new Promise<void>(resolve=>targetWss.close(()=>resolve()));await new Promise<void>(resolve=>targetServer.close(()=>resolve()));}
});
