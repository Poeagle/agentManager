import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';

test('terminal input reconciles pasted line endings once and preserves two intentional identical sends',async({page},info)=>{
 const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3');
 const root=join(process.cwd(),'.test-data/e2e'),server=createServer(),wss=new WebSocketServer({server});
 wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const frame=JSON.parse(bytes);if(frame.method&&frame.id)socket.send(JSON.stringify({id:frame.id,result:frame.method==='thread/read'?{thread:{status:{type:'notLoaded'}}}:{}}));}));
 await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
 let sessionId:string|undefined;
 try{
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const path=join(root,'duplicate-input-project'),logs=join(root,'home/.codex/sessions'),native='019ff001-1234-7234-8234-123456789abd';mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});
  const log=join(logs,`rollout-${native}.jsonl`),row=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  writeFileSync(log,row('event_msg',{type:'user_message',message:'开始检查'})+row('event_msg',{type:'task_complete',last_agent_message:'等待输入。'}));
  const {project}=await(await page.request.post('/api/projects',{data:{name:'重复消息回归',path}})).json(),{session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();sessionId=session.id;
  const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{app_theme:'light',statusline_prompted:'true'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'重复消息回归'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  let requests=0;const clients:string[]=[];await page.route(`**/api/sessions/${session.id}/input`,async route=>{requests++;clients.push(route.request().postDataJSON().client_id);await route.fulfill({response:await route.fetch()});});
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true}),editor=chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'}),text='网络地址说明\r\n  interface: eno3\r\n  inet 192.168.1.31\r\n';await expect(chat.getByText('等待输入。',{exact:true})).toBeVisible();
  for(let index=1;index<=2;index++){
   // This fixture exercises inputs to a legacy engine that is still busy.
   appendFileSync(log,row('event_msg',{type:'task_started',turn_id:`legacy-${index}`}));
   await editor.evaluate((node,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},text);
   await expect(editor).toContainText('inet 192.168.1.31');
   const accepted=page.waitForResponse(response=>response.url().endsWith(`/sessions/${session.id}/input`)&&response.request().method()==='POST');await chat.getByRole('button',{name:'发送消息',exact:true}).click();expect((await accepted).status()).toBe(202);await expect(editor).toHaveText('');
   const normalized=text.replace(/\r\n/g,'\n').trim(),turn=`turn-${index}`;
   appendFileSync(log,row('response_item',{type:'message',role:'user',id:`native-${index}`,content:[{type:'input_text',text:normalized}],internal_chat_message_metadata_passthrough:{turn_id:turn}})+row('event_msg',{type:'user_message',message:normalized})+row('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:`已处理 ${index}`}));
   await expect(chat.getByText(`已处理 ${index}`,{exact:true})).toBeVisible();await expect(chat.locator('.session-chat-user-text').filter({hasText:'网络地址说明'})).toHaveCount(index);
   const history=await(await page.request.get(`/api/sessions/${session.id}/conversation`)).json();expect(history.messages.filter((m:any)=>m.role==='user'&&m.text===normalized).map((m:any)=>m.client_id)).toEqual(clients);
  }
  expect(requests).toBe(2);expect(new Set(clients).size).toBe(2);
  await page.getByRole('button',{name:'原始终端',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).click();await expect(chat.locator('.session-chat-user-text').filter({hasText:'网络地址说明'})).toHaveCount(2);await page.reload();await expect(chat.locator('.session-chat-user-text').filter({hasText:'网络地址说明'})).toHaveCount(2);await page.screenshot({path:info.outputPath('terminal-input-correlated-once.png')});
 }finally{if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`).catch(()=>{});for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
