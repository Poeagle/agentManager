import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';

test.use({timezoneId:'Asia/Taipei'});

test('progress uses the browser clock across reload, shows completion metadata and aligns with its number',async({page},info)=>{
 const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'timezone-project'),logs=join(root,'home/.codex/sessions'),native='019ff001-7777-7777-8777-777777777795';mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});
 const start='2026-11-03T07:00:00Z',end='2026-11-03T07:01:45Z',record=(payload:unknown,timestamp:string)=>JSON.stringify({type:'event_msg',payload,timestamp})+'\n';
 writeFileSync(join(logs,`rollout-${native}.jsonl`),record({type:'user_message',message:'检查显示时区'},start)+record({type:'agent_message',message:'进展已经输出完成。'},end));
 const {project}=await(await page.request.post('/api/projects',{data:{name:'时区验证',path}})).json(),{session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 let push:(value:unknown)=>void=()=>{};await page.routeWebSocket('**/conversation/stream*',socket=>{push=value=>socket.send(JSON.stringify(value));socket.send(JSON.stringify({type:'snapshot',messages:[],busy:true,stage:'tools',turn_id:'turn'}));});
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'时区验证'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 try{
  await page.clock.setFixedTime(new Date(Date.parse(end)-90000+500));
  await page.route('**/api/settings',async route=>{const response=await route.fetch();const json=await response.json();if(route.request().method()==='GET')json.server_time=Date.parse(end);await route.fulfill({response,json});});
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true}),time=chat.getByLabel('进展完成时间').first();await expect(time).toHaveText('2026-11-03 15:00:15');await expect(time).toHaveAttribute('datetime',end);
  await page.reload();await expect(time).toHaveText('2026-11-03 15:00:15');await expect(time).toHaveAttribute('title',/browser time/);
  await expect(chat.getByText('Elapsed: 1m 45s',{exact:true})).toBeVisible();
  const message={id:'live-time',role:'assistant',phase:'commentary',turn_id:'turn',text:'正在输出的进展内容',streaming:true,timestamp:start,statistics:{complete:false,requests:1,tool_calls:2,tool_rounds:1,tokens:{total_tokens:500}}};
  push({type:'snapshot',messages:[message],busy:true,stage:'answering',turn_id:'turn'});const live=chat.locator('[data-chat-message-id="live-time"]');await expect(live).toContainText('正在输出');await expect(live.locator('time')).toHaveCount(0);await expect(live.locator('.session-chat-message-statistics')).toHaveCount(0);await chat.getByLabel('收起进展（2 条）').click();await expect(live).toBeHidden();
  push({type:'snapshot',messages:[{...message,streaming:false,timestamp:'2026-11-03T07:01:50Z',text:'进展已经完整输出。'}],busy:true,stage:'tools',turn_id:'turn'});await expect(live).toBeHidden();await chat.getByLabel('展开进展（2 条）').click();await expect(live.getByLabel('进展完成时间')).toHaveText('2026-11-03 15:00:20');await expect(live.locator('.session-chat-message-statistics')).toHaveText('token: ≥500 · tools: ≥2/≥1');await expect(live.locator('.session-chat-message-duration')).toHaveText('Elapsed: 5s');
  const alignment=await live.evaluate(node=>{const number=node.parentElement!.querySelector('.session-chat-progress-number')!.getBoundingClientRect(),time=node.querySelector('.session-chat-metadata-row time')!.getBoundingClientRect();const text=time;return Math.abs(number.y+number.height/2-text.y-text.height/2);});expect(alignment).toBeLessThan(3);await page.screenshot({path:info.outputPath('timezone-completion-alignment.png')});
 }finally{await page.request.delete(`/api/sessions/${session.id}`).catch(()=>{});}
});
