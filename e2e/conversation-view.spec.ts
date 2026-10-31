import {createServer} from 'node:http';
import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

let nativeServer:any,nativeWss:any;
test.beforeEach(async()=>{const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws');nativeServer=createServer();nativeWss=new WebSocketServer({server:nativeServer});nativeWss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const frame=JSON.parse(bytes.toString());if(!frame.method||!frame.id)return;socket.send(JSON.stringify({id:frame.id,result:frame.method==='thread/read'?{thread:{status:{type:'notLoaded'}}}:{}}));}));await new Promise<void>(resolve=>nativeServer.listen(join(process.cwd(),'.test-data/e2e/codex.sock'),resolve));});
test.afterEach(async()=>{for(const client of nativeWss.clients)client.terminate();await new Promise<void>(resolve=>nativeWss.close(()=>resolve()));await new Promise<void>(resolve=>nativeServer.close(()=>resolve()));});

test('chat hides tool logs, sends to the same live session and switches to its original terminal',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  const auth=await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}});expect(auth.ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data','e2e');const projectPath=join(root,'conversation-project');mkdirSync(projectPath,{recursive:true});
  const projectResponse=await page.request.post('/api/projects',{data:{name:'Conversation Preview',path:projectPath}});expect(projectResponse.ok()).toBeTruthy();const {project}=await projectResponse.json();
  const created=await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}});expect(created.ok()).toBeTruthy();const {session}=await created.json();
  const id='019ff001-7777-7777-8777-777777777780';const logDir=join(root,'home','.codex','sessions');mkdirSync(logDir,{recursive:true});const log=join(logDir,`rollout-chat-${id}.jsonl`);
  const entry=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  writeFileSync(log,entry('event_msg',{type:'user_message',message:'请检查这个项目。'})
    +entry('response_item',{type:'function_call',arguments:'PRIVATE TOOL ARGS'})
    +entry('response_item',{type:'function_call_output',output:'PRIVATE TOOL OUTPUT'})
    +entry('event_msg',{type:'agent_message',message:'这是 Agent 的中途进展。'})
    +entry('event_msg',{type:'agent_message',message:'已核对项目结构，继续检查配置。'})
    +entry('event_msg',{type:'task_complete',last_agent_message:'检查已完成。\n\n- 已整理结果\n- 可以继续提问'}));
  const require=createRequire(import.meta.url);const Database=require('../server/node_modules/better-sqlite3');const db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',id,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'对话试用'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.goto('/');
  const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  await expect(chat.getByText('请检查这个项目。',{exact:true})).toBeVisible();await expect(chat.getByText('检查已完成。',{exact:true})).toBeVisible();
  await expect(chat).not.toContainText('PRIVATE TOOL');await expect(chat.getByText('这是 Agent 的中途进展。',{exact:true})).toBeVisible();
  const progress=chat.getByRole('region',{name:'Codex 进展'});await expect(progress).toHaveCount(1);await expect(progress).toContainText('已核对项目结构');
  await expect(progress.getByLabel('进展序号 1')).toBeVisible();await expect(progress.getByLabel('进展序号 2')).toBeVisible();
  await expect(progress.getByLabel('进展时间')).toHaveCount(2);
  for(const time of await chat.locator('time[datetime]').all())await expect(time).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  await page.mouse.move(0,0);
  const answerMeta=chat.locator('.session-chat-message[data-phase="final"] .session-chat-message-meta').first();
  await expect(answerMeta).toHaveCSS('opacity','1');
  await expect(answerMeta.getByRole('button',{name:'复制Agent 回复'})).toBeVisible();
await expect(progress).not.toContainText('检查已完成。');
  await page.screenshot({path:testInfo.outputPath('progress-timeline.png')});
  expect(await chat.locator('.session-chat-message.user .session-chat-body').evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe(await chat.locator('.session-chat-message.assistant').first().evaluate(node=>getComputedStyle(node).backgroundColor));
  await expect.poll(async()=>{const data=await(await page.request.get('/api/sessions')).json();return data.sessions.find((item:{id:string})=>item.id===session.id)?.status;}).toBe('running');
  const pid=(await(await page.request.get('/api/sessions')).json()).sessions.find((item:{id:string})=>item.id===session.id).pid;
  await expect(chat.getByRole('status').last()).toContainText('可以继续发送消息');
  await chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'}).fill("printf 'chat-input-ok\\n'");
  const sent=page.waitForResponse(response=>response.url().endsWith(`/api/sessions/${session.id}/input`)&&response.request().method()==='POST');
  await chat.getByRole('button',{name:'发送消息',exact:true}).click();expect((await sent).status()).toBe(202);
  appendFileSync(log,entry('event_msg',{type:'user_message',message:"printf 'chat-input-ok\\n'"})+entry('event_msg',{type:'task_complete',last_agent_message:'本轮答复已更新。'}));
  await expect(chat.getByText('本轮答复已更新。',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('conversation-view.png')});
  await page.getByRole('button',{name:'原始终端',exact:true}).click();await expect(page.locator('.xterm').filter({visible:true})).toBeVisible();
  const next=(await(await page.request.get('/api/sessions')).json()).sessions.find((item:{id:string})=>item.id===session.id);expect(next.pid).toBe(pid);
  await page.screenshot({path:testInfo.outputPath('original-terminal-view.png')});
  const nativeInput=page.locator('.xterm-helper-textarea').filter({visible:true});
  await nativeInput.focus();await nativeInput.pressSequentially('unfinished draft');
  await page.getByRole('button',{name:'对话',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('还有未发送的内容');
  await nativeInput.focus();await nativeInput.press('Control+u');
  await page.getByRole('button',{name:'对话',exact:true}).click();await expect(chat.getByText('本轮答复已更新。',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('conversation-mobile.png')});
  await page.request.delete(`/api/sessions/${session.id}`);
});
