import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3');
test('progress footers show request increments and English metadata while the final keeps turn totals',async({page},info)=>{
 const root=join(process.cwd(),'.test-data/e2e'),directory=join(root,'progress-interval-project'),docs=join(directory,'docs'),native='019ff001-4141-7414-8414-414141414143';
 mkdirSync(join(docs,'nested'),{recursive:true});mkdirSync(join(docs,'empty'));mkdirSync(join(docs,'reports.md'));writeFileSync(join(docs,'nested','README.md'),'# 从目录打开的文档\n\n目录树中的文件可以直接预览。');writeFileSync(join(docs,'index.html'),'<!doctype html><html><body><h1>目录内网页</h1></body></html>');
 const logs=join(root,'home/.codex/sessions');mkdirSync(logs,{recursive:true});
 const rec=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
 const msg=(id:string,text:string,phase='commentary')=>rec('response_item',{type:'message',id,role:'assistant',phase,content:[{type:'output_text',text}],internal_chat_message_metadata_passthrough:{turn_id:'turn'}});
 const usage=(total:number,last:number)=>rec('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last}}});
 const call=(id:string)=>rec('response_item',{type:'function_call',call_id:id,name:'exec',arguments:'{}'});
 writeFileSync(join(logs,`rollout-${native}.jsonl`),rec('event_msg',{type:'task_started',turn_id:'turn'})+rec('event_msg',{type:'user_message',message:'Check interval usage',turn_id:'turn'})+msg('one','First progress')+call('a')+usage(100,100)+msg('two','Second progress')+call('b')+call('c')+usage(300,200)+msg('final','Finished','final_answer')+usage(600,300)+rec('event_msg',{type:'task_complete',turn_id:'turn',last_agent_message:'Finished'}));
 const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const {project}=await(await page.request.post('/api/projects',{data:{name:'目录预览验证',path:directory}})).json();const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:directory,mode:'terminal'}})).json();
 const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'目录预览'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 try{
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  await expect(chat.getByText('step · token: 100 · tools: 1 call / 1 round',{exact:true})).toBeVisible();
  await expect(chat.getByText('step · token: 200 · tools: 2 calls / 1 round',{exact:true})).toBeVisible();
  await expect(chat.getByText('turn · token: 600 · tools: 3 calls / 2 rounds',{exact:true})).toBeVisible();
  expect(await chat.locator('.session-chat-message-statistics').first().getAttribute('title')).toContain('since the previous progress request');
  await expect(page.getByRole('button',{name:'对话',exact:true}).first()).toBeVisible();
  await page.screenshot({path:info.outputPath('progress-interval-english.png')});
 }finally{await page.request.delete(`/api/sessions/${session.id}`).catch(()=>{});}
});
