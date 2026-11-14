import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('successive native reconnect notices update one compact card and survive reload',async({page})=>{
 const auth=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'reconnect-card');mkdirSync(path,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'重连提示',path}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
 const native='019ff001-dead-7bee-8bee-deadbeef1239',dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});
 const file=join(dir,`rollout-${native}.jsonl`),row=(payload:unknown)=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})+'\n';
 writeFileSync(file,row({type:'task_started',turn_id:'retry-turn'})+row({type:'user_message',message:'检查连接'}));
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
 await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'重连提示'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 let push!:(value:unknown)=>void;
 await page.routeWebSocket('**/conversation/stream*',socket=>{push=value=>socket.send(JSON.stringify(value));push({type:'snapshot',messages:[],busy:true,stage:'waiting',turn_id:'retry-turn'});});
 try{
  await page.goto('/');await expect(page.getByText('检查连接',{exact:true})).toBeVisible();
  const message=(n:number)=>({id:`retry-${n}`,role:'assistant',phase:'error',text:`Reconnecting... ${n}/5`,turn_id:'retry-turn',timestamp:null,error:{code:'response_stream_disconnected',will_retry:true}});
  for(let n=2;n<=5;n++){
   appendFileSync(file,row({type:'error',turn_id:'retry-turn',message:`Reconnecting... ${n}/5`,codex_error_info:'response_stream_disconnected',will_retry:true}));
   push({type:'snapshot',messages:Array.from({length:n-1},(_,i)=>message(i+2)),busy:true,stage:'waiting',turn_id:'retry-turn'});
   const card=page.locator('.session-chat-error-notice');await expect(card).toHaveCount(1);await expect(card).toContainText(`Reconnecting... ${n}/5`);
  }
  const card=page.locator('.session-chat-error-notice');expect((await card.boundingBox())!.height).toBeLessThan(70);
  await page.reload();await expect(card).toHaveCount(1);await expect(card).toContainText('Reconnecting... 5/5');
  await page.setViewportSize({width:390,height:844});expect((await card.boundingBox())!.height).toBeLessThan(100);await expect(card.getByRole('button',{name:'复制错误信息'})).toBeVisible();
 }finally{await page.request.delete(`/api/sessions/${session.id}`);await page.request.delete(`/api/projects/${project.id}`);}
});
