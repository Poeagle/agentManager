import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3');
test('progress badges and folding keep metadata separate from the message content',async({page},info)=>{
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
  const toggle=chat.getByLabel('展开进展（2 条）');await expect(toggle).toBeVisible();await expect(chat.getByText('First progress',{exact:true})).toBeHidden();await expect(chat.getByText('Finished',{exact:true})).toBeVisible();await toggle.click();
  await expect(chat.getByText('step · token: 100 · tools: 1 call / 1 round',{exact:true})).toBeVisible();
  await expect(chat.getByText('step · token: 200 · tools: 2 calls / 1 round',{exact:true})).toBeVisible();
  await expect(chat.getByText('turn · token: 600 · tools: 3 calls / 2 rounds',{exact:true})).toBeVisible();
  expect(await chat.locator('.session-chat-message-statistics').first().getAttribute('title')).toContain('since the previous progress request');
  await expect(chat.getByRole('region',{name:'Codex 进展'}).locator('.session-chat-kind')).toHaveText('进展');
  await expect(chat.locator('.session-chat-message[data-phase="final"] .session-chat-kind')).toHaveText('结论');
  await expect(chat.getByRole('region',{name:'Codex 进展'})).toHaveCSS('border-left-width','0px');
  await expect(chat.locator('.session-chat-message[data-phase="final"]')).toHaveCSS('border-left-width','0px');
  const checkRows=async()=>{for(const article of await chat.locator('.session-chat-message.assistant').all()){
    const geometry=await article.evaluate(node=>{const meta=node.querySelector('.session-chat-metadata-row')!,content=node.querySelector('.conversation-markdown')!;return {bottom:meta.getBoundingClientRect().bottom,top:content.getBoundingClientRect().top,first:meta.querySelector('.session-chat-message-meta')!.firstElementChild?.tagName};});
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.top);expect(geometry.first).toBe('TIME');
  }};
  await checkRows();await chat.getByLabel('收起进展（2 条）').click();await expect(chat.getByText('First progress',{exact:true})).toBeHidden();await expect(chat.getByText('Finished',{exact:true})).toBeVisible();await chat.getByLabel('展开进展（2 条）').click();await expect(chat.locator('.conversation-inline-meta')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'对话',exact:true}).first()).toBeVisible();
  await page.screenshot({path:info.outputPath('progress-interval-english.png')});
  await page.setViewportSize({width:390,height:844});await checkRows();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('progress-cards-mobile.png')});
 }finally{await page.request.delete(`/api/sessions/${session.id}`).catch(()=>{});}
});
