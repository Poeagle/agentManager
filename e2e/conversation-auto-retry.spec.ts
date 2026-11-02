import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const {WebSocketServer}=createRequire(import.meta.url)('../server/node_modules/ws');

test('capacity failures retry in the same tab and can be stopped',async({page},testInfo)=>{
 test.setTimeout(65000);
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'retry-project');mkdirSync(path,{recursive:true});
 const server=createServer(),wss=new WebSocketServer({server});let turn:any={id:'initial',status:'inProgress',items:[]},state='active';const inputs:any[]=[];
 const broadcast=(method:string,params:any)=>{for(const peer of wss.clients)if(peer.readyState===1)peer.send(JSON.stringify({method,params}));};
 const native='019ff001-7373-7373-8373-737373737373';
 wss.on('connection',peer=>peer.on('message',bytes=>{
  const frame=JSON.parse(bytes.toString());if(frame.id==null||!frame.method)return;
  let result:any=frame.method==='thread/read'?{thread:{id:native,status:{type:state}}}:frame.method==='thread/turns/list'?{data:[turn]}:frame.method==='thread/queue/list'?{data:[]}:{};
  if(frame.method==='turn/start'){
   inputs.push(frame.params);turn={id:'retry-one',status:'inProgress',startedAt:Date.now()/1000,items:[{type:'userMessage',id:'automatic-user',clientId:frame.params.clientUserMessageId,content:frame.params.input}]};state='active';result={turn};
   setTimeout(()=>{broadcast('turn/started',{threadId:native,turn});broadcast('item/completed',{threadId:native,turnId:turn.id,item:turn.items[0]});},30);
   setTimeout(()=>{turn={...turn,status:'completed',completedAt:Date.now()/1000};state='idle';broadcast('turn/completed',{threadId:native,turn});},120);
  }
  peer.send(JSON.stringify({id:frame.id,result}));
 }));
 await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
 const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const {project}=await(await page.request.post('/api/projects',{data:{name:'自动重试验收',path}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`rollout-${native}.jsonl`),JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'agent_message',message:'原任务的已完成进展。'}})+'\n');
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
 await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'容量错误验证'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 const fail=(id:string)=>{turn={id,status:'failed',items:[],completedAt:Date.now()/1000,error:{message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded'}};state='idle';broadcast('turn/completed',{threadId:native,turn});};
 try{
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});await expect(chat.getByText('原任务的已完成进展。')).toBeVisible();await expect.poll(()=>wss.clients.size).toBeGreaterThan(0);
  await expect.poll(()=>wss.clients.size).toBeGreaterThan(0);await page.waitForTimeout(150);fail('initial');
  await expect(chat.getByRole('status').filter({hasText:'自动重试（1/3）'})).toBeVisible();await page.screenshot({path:testInfo.outputPath('retry-countdown.png')});
  await expect(chat.getByText('已自动恢复（1/3）')).toBeVisible({timeout:18000});expect(inputs).toHaveLength(1);expect(inputs[0].threadId).toBe(native);expect(inputs[0].input[0].text).toContain('避免重复执行');
  // A distinct manual turn gets its own budget. Cancelling prevents dispatch.
  turn={id:'second',status:'inProgress',items:[]};state='active';broadcast('turn/started',{threadId:native,turn});fail('second');
  await chat.getByRole('button',{name:'停止自动重试'}).click();await expect(chat.getByText('自动重试已停止。')).toBeVisible();await page.waitForTimeout(11000);expect(inputs).toHaveLength(1);
  await page.screenshot({path:testInfo.outputPath('retry-recovered-and-stopped.png')});
 }finally{
  await page.request.delete(`/api/sessions/${session.id}`).catch(()=>{});for(const peer of wss.clients)peer.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
