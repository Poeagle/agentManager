import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';

test('legacy rollout echoes reconcile live conclusions once across turns, tab switches and reload',async({page},info)=>{
 const root=join(process.cwd(),'.test-data/e2e'),require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3'),server=createServer(),wss=new WebSocketServer({server});
 const native='019ff001-1234-7234-8234-123456789abf';
 const emit=(method:string,params:unknown)=>{for(const socket of wss.clients)if(socket.readyState===1)socket.send(JSON.stringify({method,params}));};
 wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const f=JSON.parse(bytes);if(f.id&&f.method)socket.send(JSON.stringify({id:f.id,result:f.method==='thread/read'?{thread:{status:{type:'idle'}}}:f.method==='thread/turns/list'||f.method==='thread/queue/list'?{data:[]}: {}}));}));
 await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));let sessionId:string|undefined;
 try{
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const path=join(root,'legacy-identity-project'),logs=join(root,'home/.codex/sessions');mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});
  const log=join(logs,`rollout-${native}.jsonl`),record=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  writeFileSync(log,record('event_msg',{type:'task_complete',turn_id:'prior',last_agent_message:'等待输入。'}));
  const {project}=await(await page.request.post('/api/projects',{data:{name:'旧版原生日志身份回归',path}})).json(),{session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();sessionId=session.id;
  const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{app_theme:'light',statusline_prompted:'true'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'原生身份回归'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.setViewportSize({width:1600,height:1000});await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});await expect(chat.getByText('等待输入。',{exact:true})).toBeVisible();await expect(chat.getByText('Event stream connected',{exact:true})).toBeVisible();
  const answer='你好！想让我帮你做什么？';
  for(let index=1;index<=2;index++){
   const turnId=`legacy-${index}`,itemId=`live-answer-${index}`,threadId=native;
   appendFileSync(log,record('event_msg',{type:'task_started',turn_id:turnId})+record('event_msg',{type:'user_message',message:`第 ${index} 次问候`}));
   emit('turn/started',{threadId,turn:{id:turnId,startedAt:Date.now()/1000}});emit('item/started',{threadId,turnId,item:{type:'agentMessage',id:itemId,phase:'final_answer',text:''}});emit('item/agentMessage/delta',{threadId,turnId,itemId,delta:answer});
   await expect(chat.getByText(answer,{exact:true})).toHaveCount(index);
   emit('item/completed',{threadId,turnId,completedAtMs:Date.now(),item:{type:'agentMessage',id:itemId,phase:'final_answer',text:answer}});
   // Older engines omit message-level turn metadata and can use a different
   // native item ID in the durable log than in their live notification.
   appendFileSync(log,record('event_msg',{type:'agent_message',phase:'final_answer',message:answer})+record('response_item',{type:'message',id:itemId,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:answer}]})+record('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:index*100},last_token_usage:{total_tokens:100,input_tokens:90,output_tokens:10}}})+record('event_msg',{type:'task_complete',turn_id:turnId,last_agent_message:answer}));
   emit('turn/completed',{threadId,turn:{id:turnId,status:'completed',completedAt:Date.now()/1000}});
   const articles=chat.locator('article[data-phase="final"]').filter({hasText:answer});await expect(articles).toHaveCount(index);await expect(articles.last().locator('.session-chat-message-statistics')).toContainText('token: 100');
   const history=await(await page.request.get(`/api/sessions/${sessionId}/conversation`)).json();expect(history.messages.filter((item:any)=>item.text===answer)).toHaveLength(index);
  }
  await page.getByRole('button',{name:'原始终端',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).click();await expect(chat.getByText(answer,{exact:true})).toHaveCount(2);
  await page.reload();await expect(chat.getByText(answer,{exact:true})).toHaveCount(2);await page.screenshot({path:info.outputPath('legacy-conclusions-reconciled.png')});
 }finally{if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`).catch(()=>{});for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
