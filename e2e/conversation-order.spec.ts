import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('sending, early native echoes, late history and reload preserve causal message order',async({page},testInfo)=>{
  const auth=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data/e2e'),projectPath=join(root,'order-project');mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'Message order',path:projectPath}})).json();
  const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
  const native='019ff001-aaaa-7aaa-8aaa-aaaaaaaaaaaa';const dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});const log=join(dir,`rollout-order-${native}.jsonl`);
  const id=(turn:string,role:string,item:string)=>createHash('sha256').update(`${turn}:${role}:${item}`).digest('hex').slice(0,32);
  const record=(turn:string,role:string,item:string,text:string,timestamp:string)=>JSON.stringify({type:'response_item',timestamp,payload:{type:'message',id:item,role,phase:role==='assistant'?'final_answer':undefined,internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:role==='user'?'input_text':'output_text',text}]}})+'\n';
  writeFileSync(log,record('t0','user','q0','之前的问题','2099-01-01T00:00:00Z')+record('t0','assistant','a0','之前的答复','2099-01-02T00:00:00Z'));
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'顺序测试'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  let push!:(data:string)=>void;
  await page.routeWebSocket('**/conversation/stream',socket=>{push=data=>socket.send(data);push(JSON.stringify({type:'snapshot',messages:[],busy:false,stage:'idle'}));});
  let release!:()=>void;let submitted:{input:string;client_id:string}|undefined;
  await page.route(`**/api/sessions/${session.id}/input`,async route=>{
    submitted=route.request().postDataJSON();await new Promise<void>(resolve=>{release=resolve;});
    await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({status:'submitted'})});
  });
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
  await expect(chat.getByText('事件通道已连接')).toBeVisible();
  const bodies=chat.locator('.session-chat-message .session-chat-body');
  const expected=['之前的问题','之前的答复'];await expect(bodies).toHaveText(expected);
  for(let round=1;round<=2;round++) {
    submitted=undefined;
    await chat.getByRole('textbox').fill('继续');await chat.getByRole('button',{name:'发送消息',exact:true}).click();
    expected.push('继续');await expect(bodies).toHaveText(expected);
    await expect.poll(()=>submitted?.client_id).toMatch(/^[a-f0-9]{32}$/);
    const turn=`t${round}`,stamp=`201${round}-01-01T00:00:00Z`;
    // Real Codex uses different IDs in userMessage events and rollout records.
    const user={id:id(turn,'user',`stream-user-${round}`),role:'user',text:'继续',timestamp:stamp,turn_id:turn,client_id:submitted!.client_id};
    const answer={id:id(turn,'assistant',`stream-a${round}`),role:'assistant',phase:round===1?'commentary':'final',text:`第 ${round} 轮答复\n`,timestamp:stamp,turn_id:turn,streaming:true};
    push(JSON.stringify({type:'snapshot',messages:[user,answer],busy:true,stage:'answering',turn_id:turn}));
    expected.push(answer.text.trim());await expect(bodies).toHaveText(expected);
    appendFileSync(log,record(turn,'user',`log-user-${round}`,'继续',stamp)+record(turn,'assistant',`a${round}`,answer.text.trim(),stamp).replace('"phase":"final_answer"',`"phase":"${round===1?'commentary':'final_answer'}"`));
    push(JSON.stringify({type:'snapshot',messages:[user,{...answer,streaming:false}],busy:false,stage:'idle',turn_id:turn}));
    // Let durable reconciliation run before the HTTP send is acknowledged.
    await expect(chat.locator(`[data-chat-message-id="${id(turn,'user',`log-user-${round}`)}"]`)).toHaveCount(1);
    await expect(chat.locator(`[data-chat-message-id="${id(turn,'assistant',`a${round}`)}"]`)).toHaveAttribute('data-streaming','false');
    await expect(bodies).toHaveText(expected);release();await expect(chat.getByRole('textbox')).toHaveValue('');
    // Replaying the same live snapshot must not resurrect its aliased user ID.
    push(JSON.stringify({type:'snapshot',messages:[user,{...answer,streaming:false}],busy:false}));
    await expect(bodies).toHaveText(expected);
  }
  await page.getByRole('button',{name:'原始终端',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).click();await expect(bodies).toHaveText(expected);
  await page.reload();await expect(chat.getByText('事件通道已连接')).toBeVisible();await expect(bodies).toHaveText(expected);
  await page.screenshot({path:testInfo.outputPath('message-order.png')});
  await page.request.delete(`/api/sessions/${session.id}`);
});
