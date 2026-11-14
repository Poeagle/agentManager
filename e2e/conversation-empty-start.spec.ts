import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';

test('new empty Codex session survives its creation connection, reload and first manual input',async({page})=>{
 const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws');
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'empty-session-project'),logs=join(root,'home/.codex/sessions');
 mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});
 const native='019ff001-5151-7515-8515-515151515151',log=join(logs,`rollout-${native}.jsonl`);
 const row=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
 const fake=join(path,'fake-codex.mjs');writeFileSync(fake,"process.stdout.write('Ready\\n');setInterval(()=>{},1000);");
 const server=createServer(),wss=new WebSocketServer({server});let persisted=false,sessionId:string|undefined;const inputs:any[]=[];
 const emit=(method:string,params:unknown)=>{for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify({method,params}));};
 wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{
  const f=JSON.parse(bytes);if(!f.id||!f.method)return;let result:any={};
  if(['thread/read','thread/resume'].includes(f.method)&&!persisted){socket.send(JSON.stringify({id:f.id,error:{code:-32600,message:`thread not loaded: ${native}`}}));return;}
  if(f.method==='thread/start')result={thread:{id:native}};
  if(f.method==='thread/inject_items'){
   expect(f.params.items.every((item:any)=>item.role==='developer')).toBe(true);persisted=true;
   writeFileSync(log,row('session_meta',{id:native})+row('response_item',f.params.items[0]));
  }
  if(['thread/read','thread/resume'].includes(f.method))result={thread:{id:native,path:log,status:{type:'idle'}}};
  if(['thread/turns/list','thread/queue/list','model/list'].includes(f.method))result={data:[]};
  if(f.method==='turn/start'){
   inputs.push(f.params);result={turn:{id:'manual-turn'}};
   appendFileSync(log,row('event_msg',{type:'task_started',turn_id:'manual-turn'})+row('response_item',{type:'message',id:'manual-user',role:'user',content:[{type:'input_text',text:f.params.input[0].text}]})+row('response_item',{type:'message',id:'manual-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'收到手动消息'}]})+row('event_msg',{type:'task_complete',turn_id:'manual-turn'}));
   setTimeout(()=>{emit('turn/started',{threadId:native,turn:{id:'manual-turn'}});emit('item/completed',{threadId:native,turnId:'manual-turn',item:{type:'agentMessage',id:'manual-answer',phase:'final_answer',text:'收到手动消息'}});emit('turn/completed',{threadId:native,turn:{id:'manual-turn',status:'completed'}});},50);
  }
  socket.send(JSON.stringify({id:f.id,result}));
 }));
 await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
 try{
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBe(true);
  const created=await page.request.post('/api/projects',{data:{name:'空白会话回归',path}});expect(created.ok()).toBe(true);
  await page.request.put('/api/settings',{data:{settings:{session_codex_command:`node '${fake}'`,statusline_prompted:'true'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[],activeTab:'home'}}});
  await page.goto('/');await page.getByRole('button',{name:'打开项目 空白会话回归'}).click();
  const dialog=page.getByRole('dialog',{name:'打开项目 · 空白会话回归'});await dialog.getByRole('radio',{name:'Codex',exact:true}).check();
  const creation=page.waitForResponse(response=>response.url().endsWith('/api/sessions')&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'新建会话',exact:true}).click();const response=await creation;expect(response.ok()).toBe(true);expect(response.request().postDataJSON()).not.toHaveProperty('task');sessionId=(await response.json()).session.id;
  const chat=page.getByRole('region',{name:'会话对话'});await expect(chat.getByText('Event stream connected',{exact:true})).toBeVisible();expect(persisted).toBe(true);expect(inputs).toEqual([]);
  const check=async()=>{const response=await page.request.get(`/api/sessions/${sessionId}/conversation`);expect(response.status()).toBe(200);expect((await response.json()).messages).toEqual([]);await expect(chat.getByRole('alert')).toHaveCount(0);};
  await check();await page.reload();await expect(chat.getByText('Event stream connected',{exact:true})).toBeVisible();await check();expect(inputs).toEqual([]);
  await chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'}).fill('这是首次手动输入');await chat.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect.poll(()=>inputs.length).toBe(1);expect(inputs[0].input[0].text).toBe('这是首次手动输入');await expect(chat.getByText('收到手动消息',{exact:true})).toBeVisible();
  await page.reload();await expect(chat.getByText('收到手动消息',{exact:true})).toHaveCount(1);expect(inputs).toHaveLength(1);
 }finally{
  if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`,{timeout:3000}).catch(()=>{});
  await page.request.put('/api/settings',{data:{settings:{session_codex_command:'codex'}},timeout:3000}).catch(()=>{});
  for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
