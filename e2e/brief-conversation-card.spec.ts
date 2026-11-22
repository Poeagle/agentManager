import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('restores the brief-history card and current request after a reload',async({page},testInfo)=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'brief-context-project'),directory=join(root,'home/.codex/sessions');
 mkdirSync(path,{recursive:true});mkdirSync(directory,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'Brief context',path}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const upload=await page.request.post(`/api/sessions/${session.id}/paste-image`,{data:{
  dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9hZsEAAAAASUVORK5CYII=',
 }});
 expect(upload.ok()).toBeTruthy();
 const {path:attachmentPath}=await upload.json();
 const native='019ff001-abcd-7abc-8abc-abcdefabcd01',file=join(directory,`rollout-${native}.jsonl`);
 const context={version:1,turns:[
  {input:'上一轮需求',scheduled_task:'每日巡检',progress:'确认了问题',conclusion:'上一轮结论',
   attachments:[{kind:'image',name:'截图.png',path:attachmentPath}]},
  {input:'同第 1 轮定时任务提示词',input_ref:1,scheduled_task:'每日巡检',conclusion:'本次结论'},
 ],truncated:false,older_omitted:false,omitted_turns:0};
 const text='以下是上一会话的记录节选，可能不完整，仅供当前需求参考：\n<agentmanager_brief_context>\n'+JSON.stringify(context)+'\n</agentmanager_brief_context>\n\n当前需求：\n继续新的工作';
 writeFileSync(file,JSON.stringify({type:'response_item',timestamp:'2026-11-21T04:00:00Z',payload:{type:'message',id:'brief-user',role:'user',content:[{type:'input_text',text}]}})+'\n');
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 try{
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'简要压缩测试'}],activeTerminalId:session.id,explorerInstances:[]}}});
  await page.goto('/');
  const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  const card=chat.locator('[data-context-kind="brief_compaction"] button');
  await expect(card).toBeVisible();await expect(card).toContainText('2 轮');
  await expect(chat.getByText('继续新的工作',{exact:true})).toBeVisible();
  await expect(chat.getByText('上一轮需求',{exact:true})).toHaveCount(0);
  await card.click();
  let dialog=page.getByRole('dialog',{name:'简要压缩详情'});
  await expect(dialog.getByText('上一轮需求',{exact:true})).toBeVisible();
  await expect(dialog.getByText('确认了问题',{exact:true})).toBeVisible();
  await expect(dialog.getByText('上一轮结论',{exact:true})).toBeVisible();
  await expect(dialog.getByText('同第 1 轮定时任务提示词',{exact:true})).toBeVisible();
  await expect(dialog.getByText('本次结论',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('brief-details-desktop.png')});
  await page.keyboard.press('Escape');
  await page.reload();await expect(card).toBeVisible();
  await page.setViewportSize({width:390,height:844});await card.click();
  dialog=page.getByRole('dialog',{name:'简要压缩详情'});
  await expect(dialog.getByText('上一轮结论',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('brief-details-mobile.png')});
  await dialog.getByRole('button',{name:'打开附件 截图.png'}).click();
  const preview=page.getByRole('dialog',{name:'图片预览 · 截图.png'});
  await expect(preview.getByText('1 × 1')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(dialog).toBeVisible();
 }finally{await page.request.delete(`/api/sessions/${session.id}`);}
});
