import {expect,test} from '@playwright/test';
import {mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('replacing durable history during a live turn preserves older bubbles before and after refresh',async({page})=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'history-replacement-project');mkdirSync(path,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'History replacement',path}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const native='019ff001-bbbb-7bbb-8bbb-bbbbbbbbbbbb',directory=join(root,'home/.codex/sessions');mkdirSync(directory,{recursive:true});
 const file=join(directory,`rollout-replacement-${native}.jsonl`);
 const record=(role:string,id:string,text:string)=>JSON.stringify({type:'response_item',timestamp:'2026-11-09T12:00:00Z',payload:{type:'message',id,role,phase:role==='assistant'?'final_answer':undefined,content:[{type:role==='user'?'input_text':'output_text',text}]}})+'\n';
 const original=record('user','old-user','之前的问题')+record('assistant','old-answer','之前的回答');writeFileSync(file,original);
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
 await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
 await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'历史替换回归'}],activeTerminalId:session.id,explorerInstances:[]}}});
 let push!:(frame:unknown)=>void;
 await page.routeWebSocket('**/conversation/stream*',socket=>{push=frame=>socket.send(JSON.stringify(frame));push({type:'snapshot',messages:[],busy:false,stage:'idle'});});
 await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
 const texts=()=>chat.locator('.session-chat-user-text,.session-chat-message.assistant .session-chat-body').allTextContents();
 await expect.poll(texts).toEqual(['之前的问题','之前的回答']);
 writeFileSync(file+'.replacement',original+record('user','new-user','新问题')+record('assistant','new-answer','新回答'));renameSync(file+'.replacement',file);
 const answer={id:createHash('sha256').update('item:assistant:new-answer').digest('hex').slice(0,32),role:'assistant',phase:'final',text:'新回答',streaming:false};
 push({type:'snapshot',messages:[answer],busy:false,stage:'idle'});
 await expect.poll(texts).toEqual(['之前的问题','之前的回答','新问题','新回答']);
 push({type:'snapshot',messages:[answer],busy:false,stage:'idle'});
 await expect(chat.locator('[data-chat-message-id]')).toHaveCount(4);
 await page.reload();await expect.poll(texts).toEqual(['之前的问题','之前的回答','新问题','新回答']);
 await page.request.delete(`/api/sessions/${session.id}`);
});
