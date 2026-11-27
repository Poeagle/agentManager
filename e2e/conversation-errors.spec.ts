import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('native retries recover on live tool activity and terminal failures survive reconciliation and reload',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'error-project');mkdirSync(path,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'Native failure display',path}})).json();
  const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
  const native='019ff001-dead-7bee-8bee-deadbeef1235',directory=join(root,'home/.codex/sessions');mkdirSync(directory,{recursive:true});
  const log=join(directory,`rollout-errors-${native}.jsonl`),turn='failed-turn',time='2026-10-30T07:30:00Z';
  const entry=(payload:unknown)=>JSON.stringify({type:'event_msg',timestamp:time,payload})+'\n';
  writeFileSync(log,entry({type:'task_started',turn_id:turn})+entry({type:'user_message',message:'执行验证任务'}));
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'错误显示'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  let push!:(data:string)=>void;
  await page.routeWebSocket('**/conversation/stream*',socket=>{push=data=>socket.send(data);push(JSON.stringify({type:'snapshot',
    messages:[],busy:true,stage:'tools',turn_id:turn,activities:[{id:'test-tool',label:'Run command · verify',status:'running',
      turn_id:turn,after_message_id:null,started_at:'2026-10-30T07:30:01Z'}]}));});
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  await expect(chat.getByText('执行验证任务',{exact:true})).toBeVisible();await expect(chat.getByText('In progress',{exact:true})).toBeVisible();
  const text='Selected model is at capacity. Please try a different model.';
  const errorId=createHash('sha256').update(JSON.stringify([turn,'error','server_overloaded',text])).digest('hex').slice(0,32);
  const failure={id:errorId,role:'assistant',phase:'error',text,turn_id:turn,timestamp:time,streaming:false,error:{code:'server_overloaded',will_retry:false}};
  push(JSON.stringify({type:'snapshot',messages:[{...failure,error:{...failure.error,will_retry:true}}],busy:true,stage:'waiting',turn_id:turn}));
  const alert=chat.getByRole('alert');
  await expect(alert).toContainText('执行遇到错误，正在自动重试');
  push(JSON.stringify({type:'patch',upserts:[],deltas:[],state:{busy:true,stage:'tools',turn_id:turn,activities:[{
    id:'resumed-tool',label:'Run command · resume work',status:'running',turn_id:turn,
    after_message_id:errorId,started_at:'2026-10-30T07:30:02Z',
  }]}}));
  await expect(chat.getByText('Run command · resume work',{exact:true})).toBeVisible();
  await expect(alert).toContainText('重试已结束');
  push(JSON.stringify({type:'snapshot',messages:[failure],busy:false,stage:'idle',turn_id:turn}));
  await expect(alert).toContainText(text);await expect(alert).toContainText('当前模型繁忙');await expect(alert.locator('time')).toBeVisible();
  await expect(chat.getByText('In progress',{exact:true})).toHaveCount(0);await expect(chat.locator('.session-chat-caret')).toHaveCount(0);
  appendFileSync(log,entry({type:'task_complete',turn_id:turn,last_agent_message:null,error:{message:text,codex_error_info:'server_overloaded',additionalDetails:'PRIVATE DETAILS'}}));
  await expect.poll(async()=>{const result=await(await page.request.get(`/api/sessions/${session.id}/conversation`)).json();return result.messages.at(-1)?.phase;}).toBe('error');
  await expect(alert).toHaveCount(1);await expect(chat).not.toContainText('PRIVATE DETAILS');
  await page.reload();await expect(chat.getByRole('alert')).toContainText(text);await expect(chat.getByRole('alert')).toHaveCount(1);
  // A stale busy baseline after reload must not hide the persisted terminal failure.
  await expect(chat.getByRole('status').filter({hasText:'Turn failed; resolve the error and retry'})).toBeVisible();
  await chat.getByRole('button',{name:'查看原始终端',exact:true}).click();await expect(page.locator('.xterm').filter({visible:true})).toBeVisible();
  await page.getByRole('button',{name:'对话',exact:true}).click();await expect(chat.getByRole('alert')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('capacity-error.png')});
  await page.setViewportSize({width:390,height:844});await expect(alert).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const quotaTurn='quota-turn';
  const quotaProgress=(stage:string,failed_turn_id:string|null)=>push(JSON.stringify({type:'quota_handoff',quota_handoff:{
    stage,source_account:'日常订阅',target_account:'备用订阅',failed_turn_id,remaining_ms:30_000,
  }}));
  quotaProgress('switching',null);
  await expect(chat.getByRole('status').filter({hasText:'「日常订阅」额度已耗尽，正在切换到「备用订阅」'})).toBeVisible();
  quotaProgress('switched',null);
  await expect(chat.getByText('已从「日常订阅」切换到「备用订阅」',{exact:true})).toBeVisible();
  push(JSON.stringify({type:'quota_handoff',quota_handoff:null}));
  await expect(chat.getByText('已从「日常订阅」切换到「备用订阅」',{exact:true})).toHaveCount(0);
  push(JSON.stringify({type:'snapshot',messages:[{...failure,id:'quota-error',turn_id:quotaTurn,text:"You've hit your usage limit.",
    error:{code:'usage_limit_exceeded',will_retry:false}}],busy:false,stage:'idle',turn_id:quotaTurn}));
  push(JSON.stringify({type:'retry',retry:{session_id:session.id,native_id:native,root_turn_id:quotaTurn,failed_turn_ids:[quotaTurn],
    attempt:1,max_attempts:1,action:'quota_handoff',status:'submitting',next_retry_at:null}}));
  await expect(chat.getByText('正在核对订阅额度错误和原会话状态…')).toBeVisible();
  quotaProgress('preparing',quotaTurn);
  const quotaError=chat.getByRole('alert').filter({hasText:"You've hit your usage limit."});
  await expect(quotaError).toContainText('「日常订阅」额度已耗尽，正在整理简要历史，准备切换到「备用订阅」');
  quotaProgress('switching',quotaTurn);
  await expect(quotaError).toContainText('「日常订阅」额度已耗尽，正在切换到「备用订阅」');
  await expect(chat.getByText('「日常订阅」额度已耗尽，正在切换到「备用订阅」…',{exact:true})).toHaveCount(1);
  await expect(quotaError.getByRole('button',{name:'取消换号'})).toBeVisible();
  await page.request.delete(`/api/sessions/${session.id}`);
});
