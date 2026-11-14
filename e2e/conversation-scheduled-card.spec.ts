import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('scheduled input remains a compact expandable card after reload at desktop and narrow widths',async({page})=>{
  const auth=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data/e2e'),projectPath=join(root,'scheduled-card-project');mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'定时卡片',path:projectPath}})).json();
  const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
  const native='019ff001-dead-7bee-8bee-deadbeef1234',client='scheduled-card-client';
  const dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});
  const row={type:'event_msg',timestamp:'2026-11-01T00:00:00Z',payload:{type:'item_completed',turn_id:'turn',item:{type:'UserMessage',id:'scheduled-item',client_id:client,content:[{type:'text',text:'定时提示正文\n第二行'}]}}};
  writeFileSync(join(dir,`rollout-card-${native}.jsonl`),JSON.stringify(row)+'\n');
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);db.prepare('INSERT INTO conversation_input_sources(session_id,client_id,kind,label) VALUES(?,?,?,?)').run(session.id,client,'scheduled','每日巡检');}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'定时卡片'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.routeWebSocket('**/conversation/stream*',socket=>socket.send(JSON.stringify({type:'snapshot',messages:[],busy:false,stage:'idle'})));
  try{
    await page.goto('/');const card=page.locator('.session-chat-sourced details');
    await expect(card).toHaveCount(1);await expect(card).not.toHaveAttribute('open');await expect(card.locator('summary')).toContainText('每日巡检');
    await card.locator('summary').click();await expect(card).toHaveAttribute('open');await expect(card.locator('.session-chat-sourced-content')).toContainText('定时提示正文');
    await page.reload();await expect(card).not.toHaveAttribute('open');
    await page.setViewportSize({width:390,height:844});await card.locator('summary').click();await expect(card.locator('.session-chat-sourced-content')).toBeVisible();
    expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  }finally{await page.request.delete(`/api/sessions/${session.id}`);await page.request.delete(`/api/projects/${project.id}`);}
});
