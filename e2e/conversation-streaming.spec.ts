import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';

test('renders each native delta before the item completes and keeps one progress bubble',async({page},info)=>{
 const root=join(process.cwd(),'.test-data/e2e'),require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3'),server=createServer(),wss=new WebSocketServer({server});
 const native='019ff001-1234-7234-8234-123456789abe',submitted:any[]=[];let nativeActive=false,nativeItems:any[]=[],queue:any[]=[];
 const emit=(method:string,params:unknown)=>{if(method==='turn/started')nativeActive=true;if(method==='turn/completed')nativeActive=false;for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify({method,params}));};
 wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{
  const f=JSON.parse(bytes);if(!f.id||!f.method)return;
  if(f.method==='turn/start')submitted.push(f.params);
  if(f.method==='thread/queue/add'){queue.push({clientUserMessageId:f.params.clientUserMessageId,input:f.params.input});emit('thread/queue/changed',{threadId:native});}
  socket.send(JSON.stringify({id:f.id,result:f.method==='thread/read'?{thread:{status:{type:nativeActive?'active':'idle'}}}:f.method==='thread/turns/list'?{data:nativeActive?[{id:'question-turn',status:'inProgress',items:nativeItems}]:[]}:f.method==='thread/queue/list'?{data:queue}: {}}));
 }));
 await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));let sessionId:string|undefined;
 try{
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const path=join(root,'streaming-project'),logs=join(root,'home/.codex/sessions');mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});writeFileSync(join(logs,`rollout-${native}.jsonl`),JSON.stringify({type:'event_msg',timestamp:new Date(Date.now()-10000).toISOString(),payload:{type:'task_complete',turn_id:'prior',last_agent_message:'等待开始。'}})+'\n');
  const {project}=await(await page.request.post('/api/projects',{data:{name:'逐段流式回归',path}})).json(),{session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();sessionId=session.id;const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{app_theme:'light',statusline_prompted:'true'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'逐段流式回归'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});await expect(chat.getByText('等待开始。',{exact:true})).toBeVisible();await expect(chat.getByText('Event stream connected',{exact:true})).toBeVisible();await chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'}).fill('检查逐段流式输出');await chat.getByRole('button',{name:'发送消息',exact:true}).click();await expect.poll(()=>submitted.length).toBe(1);
  const threadId=native,turnId='work',itemId='stream-step';emit('turn/started',{threadId,turn:{id:turnId,startedAt:Date.now()/1000}});emit('item/started',{threadId,turnId,startedAtMs:Date.now(),item:{type:'agentMessage',id:itemId,phase:'commentary',text:''}});emit('item/agentMessage/delta',{threadId,turnId,itemId,delta:'第一段已经到达。'});
  const first=chat.getByText('第一段已经到达。',{exact:true});await expect(first).toBeVisible({timeout:1000});const bubble=chat.getByRole('region',{name:'Codex 进展'}).locator('article');await expect(bubble).toHaveAttribute('data-streaming','true');await expect(bubble.locator('time')).toHaveCount(0);await expect(chat.getByText('第二段继续到达。',{exact:true})).toHaveCount(0);await page.screenshot({path:info.outputPath('first-delta-before-completion.png')});
  emit('item/agentMessage/delta',{threadId,turnId,itemId,delta:'第二段继续到达。'});await expect(chat.getByText('第一段已经到达。第二段继续到达。',{exact:true})).toBeVisible({timeout:1000});await expect(chat.getByRole('region',{name:'Codex 进展'}).locator('article')).toHaveCount(1);
  emit('item/completed',{threadId,turnId,completedAtMs:Date.now(),item:{type:'agentMessage',id:itemId,phase:'commentary',text:'第一段已经到达。第二段继续到达。'}});await expect(bubble).toHaveAttribute('data-streaming','false');await expect(bubble.getByLabel('进展完成时间')).toBeVisible();emit('turn/completed',{threadId,turn:{id:turnId,status:'completed',completedAt:Date.now()/1000}});await expect(chat.getByText('可以继续发送消息',{exact:true})).toBeVisible();expect(submitted).toHaveLength(1);
  // Keep the rollout unchanged while a reply waits through compaction. The
  // existing RPC stream must drive the tab state and distinguish queueing.
  const log=join(logs,`rollout-${native}.jsonl`),call='async-question',question='使用哪个测试邮箱？';
  await chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'}).fill('保留主输入框草稿');
  const questionItemId=JSON.stringify(['request_user_input_async',call,0]);
  const record=(payload:unknown,type='event_msg')=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  appendFileSync(log,record({type:'task_started',turn_id:'question-turn'})+record({type:'item_completed',turn_id:'question-turn',item:{type:'AgentMessage',id:call,delivery:'async',questions:[{title:question,options:null}]}}));
  emit('turn/started',{threadId,turn:{id:'question-turn'}});
  await expect(page.getByTitle('有 1 个问题待回答 · Agent 仍在执行').first()).toBeVisible({timeout:1500});
  nativeItems=[{id:'compact',type:'contextCompaction',status:'inProgress'}];emit('item/started',{threadId,turnId:'question-turn',item:nativeItems[0]});
  const answer=chat.getByRole('textbox',{name:question,exact:true});await answer.fill('复用现有测试邮箱');
  await answer.evaluate(element=>{
   const transfer=new DataTransfer(),png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9hZsEAAAAASUVORK5CYII='),value=>value.charCodeAt(0));
   transfer.items.add(new File([png],'answer-shot.png',{type:'image/png'}));transfer.items.add(new File(['answer evidence'],'answer-log.txt',{type:'text/plain'}));
   element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
  });
  const ready=chat.locator('.session-chat-question-seat [data-attachment-id][data-status="ready"]');await expect(ready).toHaveCount(2);
  await chat.getByRole('button',{name:'稍后回答',exact:true}).click();await expect(chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveText('保留主输入框草稿');await chat.locator('.session-chat-question-reminder').click();await expect(ready).toHaveCount(2);
  await page.screenshot({path:info.outputPath('question-attachments-desktop.png')});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('question-attachments-mobile.png')});await page.setViewportSize({width:1280,height:720});
  await chat.getByRole('button',{name:'提交回答',exact:true}).click();
  await expect(chat.getByText('回答已排队',{exact:true})).toBeVisible({timeout:1500});
  const queuedDot=page.getByTitle('Codex 运行中 · 回答已排队，等待接收').first();await expect(queuedDot).toBeVisible({timeout:1500});await expect(queuedDot).toHaveCSS('background-color','rgb(59, 130, 246)');
  expect(queue).toHaveLength(1);expect(queue[0].input.some((item:any)=>item.type==='localImage')).toBe(true);expect(queue[0].input[0].text).toContain('answer-log.txt');await expect(chat.getByText('已回答',{exact:true})).toHaveCount(0);
  await page.reload();await expect(chat.getByText('回答已排队',{exact:true})).toBeVisible();
  const queued=queue[0];
  queue=[];appendFileSync(log,record({type:'message',role:'user',content:[{type:'input_text',text:queued.input[0].text},...queued.input.slice(1)],internal_chat_message_metadata_passthrough:{turn_id:'question-turn'}},'response_item'));
  emit('item/completed',{threadId,turnId:'question-turn',item:{type:'userMessage',id:'reply',clientId:queued.clientUserMessageId,content:queued.input}});emit('thread/queue/changed',{threadId});
  await expect(chat.getByText('已回答',{exact:true})).toBeVisible({timeout:1500});
  emit('turn/completed',{threadId,turn:{id:'question-turn',status:'completed'}});
  await expect(page.getByTitle('Codex 本轮已结束 · 等待输入').first()).toBeVisible({timeout:1500});expect(submitted).toHaveLength(1);
 }finally{if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`).catch(()=>{});for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
