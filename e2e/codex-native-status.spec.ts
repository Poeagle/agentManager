import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('Codex labels show native activity and execution state through reloads and later native events',async({page})=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  const auth=await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}});
  expect(auth.ok()).toBeTruthy();const {user}=await auth.json();
  const root=join(process.cwd(),'.test-data','e2e');
  const path=join(root,'codex-native-project');mkdirSync(path,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'Native Codex',path}})).json();
  const nativeId='019ff001-3333-7333-8333-333333333333';
  const nativeDir=join(root,'home','.codex','sessions');mkdirSync(nativeDir,{recursive:true});
  const log=join(nativeDir,`rollout-native-${nativeId}.jsonl`);
  writeFileSync(log,JSON.stringify({timestamp:'2026-10-29T01:00:00Z',type:'event_msg',payload:{type:'task_complete',turn_id:'a'}})+'\n');
  const require=createRequire(import.meta.url);const Database=require('../server/node_modules/better-sqlite3');const db=new Database(join(root,'agentmanager.db'));
  try {
    db.prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id,updated_at) VALUES ('native-browser',?,'native-clock','completed','session','codex',?,?,'2099-01-01 00:00:00')").run(project.id,nativeId,user.id);
  } finally {db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:'native-browser',label:'native-clock'}],activeTerminalId:'native-browser',explorerInstances:[],hiddenSessionIds:[]}}});
  await page.goto('/');
  const label=page.getByText('native-clock',{exact:true});
  await expect(label).toHaveAttribute('title',/Codex 原生状态：本轮已结束/);
  const before=await label.getAttribute('title');
  expect(before).toContain('最后活跃：');expect(before).not.toContain('2099');
  await page.reload();await expect(label).toHaveAttribute('title',before!);
  appendFileSync(log,JSON.stringify({timestamp:'2026-10-29T01:01:00Z',type:'event_msg',payload:{type:'turn_aborted',turn_id:'a'}})+'\n');
  await expect(label).toHaveAttribute('title',/Codex 原生状态：本轮已中断/,{timeout:15000});
});
