import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';

test('a detached chat reconnects independently of the raw terminal and preserves its draft',async({page},testInfo)=>{
 const auth=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'reconnect-project');mkdirSync(path,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'会话重连验证',path}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const native='019ff001-7373-7373-8373-737373737373',dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,`rollout-${native}.jsonl`),JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'agent_message',message:'原会话历史保持不变。'}})+'\n');
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
 await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'可视化友好'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 let disconnected=true,reconnects=0;const sent:Array<{input:string}>=[];
 await page.route(`**/api/sessions/${session.id}/input`,async route=>{sent.push(route.request().postDataJSON());await route.fulfill({status:202,json:{status:'submitted'}});});
 await page.route(`**/api/sessions/${session.id}/conversation?*`,async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({response,json:disconnected?{...data,session_active:false,session_status:'detached'}:data});});
 await page.routeWebSocket('**/conversation/stream',socket=>socket.send(JSON.stringify({type:'snapshot',messages:[],busy:false,stage:'idle'})));
 await page.route(`**/api/sessions/${session.id}/reconnect`,async route=>{reconnects++;if(reconnects===1){await route.fulfill({status:409,json:{error:'现有终端连接暂不可用，请重新连接。'}});return;}const response=await route.fetch();if(response.ok())disconnected=false;await route.fulfill({response});});
 try {
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  await expect(chat.getByText('原会话历史保持不变。')).toBeVisible();await expect(chat.getByRole('alert')).toContainText('请重新连接');
  const input=chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'});await input.fill('继续处理，不丢草稿');
  await expect(chat.getByRole('button',{name:'发送消息'})).toBeDisabled();expect(reconnects).toBe(1);
  await expect.poll(async()=>{const response=await page.request.get(`/api/sessions/${session.id}/conversation`);return (await response.json()).session_active;}).toBe(true);
  await chat.getByRole('button',{name:'重新连接',exact:true}).click();
  await expect(chat.getByRole('button',{name:'发送消息'})).toBeEnabled();await expect(input).toHaveText('继续处理，不丢草稿');expect(reconnects).toBe(2);
  await expect(page.getByRole('button',{name:'对话',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:testInfo.outputPath('chat-reconnected.png')});
  await chat.getByRole('button',{name:'发送消息'}).click();await expect(input).toHaveText('');expect(sent).toHaveLength(1);expect(sent[0].input).toBe('继续处理，不丢草稿');
 }finally{await page.request.delete(`/api/sessions/${session.id}`).catch(()=>{});}
});
