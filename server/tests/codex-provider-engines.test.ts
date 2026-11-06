import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'http';
import {WebSocketServer} from 'ws';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {inCodexThread,engineForProvider} from '../src/services/agents/codex/engine-context.js';
import {withCodexConnection,publicCodexRpcMessage,createStreamingCodexThread} from '../src/services/agents/codex/stream.js';
import {prepareCodexModelRecovery,readCodexModels} from '../src/services/agents/codex/controls.js';
import {codexAdapter} from '../src/services/agents/codex/adapter.js';
import {agentContext} from '../src/services/agents/index.js';
vi.mock('../src/services/agents/codex/terminal-bridge.js',()=>({ensureCodexTerminalBridge:vi.fn(async(path:string)=>path)}));
import {prepareFreshCodexConversation} from '../src/services/agents/codex/actions.js';
let dir:string,servers:Server[],sockets:WebSocketServer[],calls:Array<{provider:string;method:string;params:any}>;
const native='019ff001-1212-7212-8212-121212121212',fresh='019ff001-1313-7313-8313-131313131313';
let model:string,loaded:boolean,configuredModel:string;
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'provider-engines-'));servers=[];sockets=[];calls=[];model='a-model';loaded=true;configuredModel='a-model';
 vi.stubEnv('CODEX_HOME',dir);vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',join(dir,'a'));
 vi.stubEnv('AGENTMANAGER_CODEX_PROVIDER_ENGINES',JSON.stringify([{provider:'provider-a',socket:join(dir,'a'),models:['a-model']},{provider:'provider-b',socket:join(dir,'b'),models:['b-model']}]));
 for(const provider of ['provider-a','provider-b']) {
  const server=createServer(),wss=new WebSocketServer({server});servers.push(server);sockets.push(wss);
  wss.on('connection',ws=>ws.on('message',raw=>{
   const m=JSON.parse(raw.toString());if(!m.id)return;calls.push({provider,...m});let result:any={};
   const thread={id:m.params.threadId||fresh,status:{type:loaded?'idle':'notLoaded'},model:provider==='provider-a'?model:'b-model',reasoningEffort:'high',modelProvider:provider};
   if(m.method==='config/read')result={config:{model_provider:provider,model:provider==='provider-a'?configuredModel:'b-model'}};
   // Simulate a mixed catalog: explicit engine allowlists must scope it.
   if(m.method==='model/list')result={data:['a-model','b-model'].map(model=>({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}))};
   if(m.method==='thread/read')result={thread};
   if(m.method==='thread/resume'){loaded=true;if(m.params.model)model=m.params.model;result={thread:{...thread,status:{type:'idle'},model:provider==='provider-a'?model:'b-model'},approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}};}
   if(m.method==='thread/settings/update')model=m.params.model;
   if(m.method==='thread/start')result={thread:{...thread,id:fresh,model:m.params.model}};
   ws.send(JSON.stringify({id:m.id,result}));
  }));
  await new Promise<void>(resolve=>server.listen(join(dir,provider==='provider-a'?'a':'b'),resolve));
 }
});
afterEach(async()=>{for(const wss of sockets){for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));}for(const server of servers)await new Promise<void>(r=>server.close(()=>r()));vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('scopes mixed catalogs to explicitly declared providers and creates/resumes a new provider thread on its engine',async()=>{
 const models=await readCodexModels();expect(models.map(m=>[m.provider,m.model])).toEqual([['provider-a','a-model'],['provider-b','b-model']]);
 await prepareFreshCodexConversation(native,'/work',undefined,{provider:'provider-b',model:'b-model',effort:'high'});
 expect(calls.filter(c=>c.method==='thread/start')).toMatchObject([{provider:'provider-b',params:{model:'b-model',modelProvider:'provider-b'}}]);
 expect(calls.filter(c=>c.method==='thread/inject_items')).toMatchObject([{provider:'provider-b'}]);
 expect(calls.some(c=>c.method==='turn/start')).toBe(false);
 calls=[];await inCodexThread(fresh,()=>withCodexConnection(request=>request('thread/read',{threadId:fresh})));
 expect(calls.find(c=>c.method==='thread/read')?.provider).toBe('provider-b');
 expect(()=>engineForProvider('not-configured')).toThrow('尚未接入');
});
it('recovers a cold thread route from native metadata and uses it for live streaming and terminal resume',async()=>{
 const cold='019ff001-1414-7414-8414-141414141414';mkdirSync(join(dir,'sessions'));writeFileSync(join(dir,'sessions',`rollout-${cold}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:cold,model_provider:'provider-b'}})+'\n');
 const context=agentContext({cli_type:'codex',codex_session_id:cold},{projectPath:dir,sharedAccess:true});
 const stop=codexAdapter.stream.observe(context,()=>{});
 try {await vi.waitFor(()=>expect(calls.some(c=>c.provider==='provider-b'&&c.method==='thread/read')).toBe(true));expect(calls.filter(c=>c.method==='thread/read').every(c=>c.provider==='provider-b')).toBe(true);}finally{stop();}
 const plan=await codexAdapter.launch.prepare(context,'do not replay',undefined,true);expect(plan.streamSocket).toBe(join(dir,'b'));expect(plan.nativeId).toBe(cold);expect(calls.some(c=>c.method==='turn/start')).toBe(false);
});
it('blocks an unavailable persisted model and resumes an unloaded session with an explicit correction before updating settings',async()=>{
 model='removed-model';loaded=false;
 await expect(inCodexThread(native,()=>prepareCodexModelRecovery(native,null))).rejects.toThrow('原会话模型');
 expect(calls.some(c=>c.method==='turn/start'||c.method==='thread/resume')).toBe(false);
 calls=[];await inCodexThread(native,()=>prepareCodexModelRecovery(native,{provider:'provider-a',model:'a-model',effort:'high'}));
 const methods=calls.map(c=>c.method);expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('thread/settings/update'));expect(methods).not.toContain('turn/start');
});
it('rejects invalid creation config before creating a thread or submitting input',async()=>{
 configuredModel='removed-model';await expect(createStreamingCodexThread('/work','never send')).rejects.toThrow('不在当前模型服务');
 expect(calls.some(c=>c.method==='thread/start'||c.method==='turn/start')).toBe(false);
});
it('does not dereference a missing engine configuration',async()=>{
 vi.stubEnv('AGENTMANAGER_CODEX_PROVIDER_ENGINES','');vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',undefined);
 expect(()=>engineForProvider()).not.toThrow();
});
it('keeps native actionable status/reasons while redacting credentials',()=>{
 expect(publicCodexRpcMessage('404 model not found api_key=PRIVATE https://user:password@host/error?token=PRIVATE Bearer PRIVATE')).toBe('404 model not found api_key=[redacted] https://host/error Bearer [redacted]');
});
