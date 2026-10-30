import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('one-line tool activity scrolls, keeps real timers and never enters public conversation messages',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data/e2e'),projectPath=join(root,'activity-project');mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'执行状态与耗时',path:projectPath}})).json();
  const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
  const native='019ff001-1313-7131-8131-131313131313',dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});
  const now=Date.now(),stamp=(offset:number)=>new Date(now+offset).toISOString();
  const line=(payload:unknown,offset:number)=>JSON.stringify({type:'event_msg',payload,timestamp:stamp(offset)})+'\n';
  writeFileSync(join(dir,`rollout-activity-${native}.jsonl`),line({type:'user_message',message:'检查项目部署'},-180000)
    +line({type:'agent_message',message:'开始检查项目配置。'},-170000)
    +line({type:'agent_message',message:'配置检查完成，正在部署。'},-64000));
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  let push:((value:unknown)=>void)|undefined;
  const activity=(id:string,label:string)=>({id,label,status:'running',started_at:stamp(-5000),completed_at:null,duration_ms:null});
  const frame=(activities:unknown[],busy=true)=>({type:'snapshot',messages:[],activities,busy,stage:busy?'tools':'idle',turn_id:'turn',started_at:stamp(-180000)});
  await page.routeWebSocket('**/conversation/stream',socket=>{push=value=>socket.send(JSON.stringify(value));socket.send(JSON.stringify(frame([activity('one','运行命令 · npm run build')])));});
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'部署状态'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  const ticker=chat.getByTestId('conversation-activity-line');
  await expect(ticker).toContainText('运行命令 · npm run build');await expect(ticker).toContainText('本轮 3分');
  await expect(chat.getByText('阶段间隔 1分46秒',{exact:true})).toBeVisible();
  expect((await ticker.boundingBox())!.height).toBeLessThan(26);
  const long='调用工具 · tools / exec_command · '+Array.from({length:18},()=> '只在状态栏显示的工具活动').join(' ');
  push?.(frame([activity('one','运行命令 · npm run build'),activity('two',long)]));
  await expect(ticker).toContainText('只在状态栏显示的工具活动');
  await expect(ticker.locator('[data-overflow=true]')).toHaveCount(1);
  await expect(chat.locator('.session-chat-feed')).not.toContainText('只在状态栏显示的工具活动');
  const publicPage=await(await page.request.get(`/api/sessions/${session.id}/conversation`)).json();
  expect(JSON.stringify(publicPage.messages)).not.toContain('只在状态栏显示的工具活动');
  await page.screenshot({path:testInfo.outputPath('activity-timing-desktop.png')});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await ticker.boundingBox())!.height).toBeLessThan(26);await page.screenshot({path:testInfo.outputPath('activity-timing-mobile.png')});
  push?.(frame([],false));await expect(ticker).toContainText('可以继续发送消息');
  await page.request.delete(`/api/sessions/${session.id}`);
});
