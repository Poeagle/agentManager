import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('compaction refreshes the timeline and shows its summary once',async({page})=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'compaction-simulation-project'),directory=join(root,'home/.codex/sessions');mkdirSync(path,{recursive:true});mkdirSync(directory,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'Compaction simulation',path}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const native='019ff001-abcd-7abc-8abc-abcdefabcdef',file=join(directory,`rollout-${native}.jsonl`);
 const record=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:'2026-11-09T12:00:00Z',payload})+'\n';
 const user=(id:string,text:string)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
 writeFileSync(file,record('response_item',user('old','压缩前消息')));
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 try{
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'压缩模拟'}],activeTerminalId:session.id,explorerInstances:[]}}});
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  await expect(chat.getByText('压缩前消息',{exact:true})).toBeVisible();
  appendFileSync(file,record('compacted',{message:'模拟压缩摘要',replacement_history:[user('kept','压缩后保留消息')]}));
  await expect(chat.getByText('会话压缩摘要',{exact:true})).toBeVisible();
  await expect(chat.getByText('压缩前消息',{exact:true})).toHaveCount(0);
  await expect(chat.getByText('压缩后保留消息',{exact:true})).toHaveCount(1);
  await chat.getByText('会话压缩摘要',{exact:true}).click();await expect(chat.getByText('模拟压缩摘要',{exact:true})).toBeVisible();
  appendFileSync(file,record('response_item',user('after','压缩后发送')));
  await expect(chat.getByText('压缩后发送',{exact:true})).toHaveCount(1);
  await page.reload();await expect(chat.getByText('压缩后发送',{exact:true})).toHaveCount(1);await expect(chat.getByText('会话压缩摘要',{exact:true})).toHaveCount(1);
 }finally{await page.request.delete(`/api/sessions/${session.id}`);}
});
