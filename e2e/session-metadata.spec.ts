import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test.use({timezoneId:'Asia/Taipei'});
test.afterEach(({page})=>page.unrouteAll({behavior:'wait'}));

const require = createRequire(import.meta.url);
const Database = require('../server/node_modules/better-sqlite3');
const root = join(process.cwd(), '.test-data/e2e');
const start = Date.parse('2026-11-20T09:00:00Z');
const executionUsageLabel = '执行用量（已计入本段）';
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const record = (seconds: number, type: string, payload: object) =>
  JSON.stringify({type, timestamp:at(seconds), payload})+'\n';
const event = (seconds: number, type: string, payload: object) => record(seconds,'event_msg',{type,...payload});
const message = (seconds: number, id: string, role: 'user' | 'assistant', text: string, phase?: string) =>
  record(seconds,'response_item',{type:'message',id,role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]});
const request = (seconds: number, turn: string, response_id: string, input: number, cached: number) =>
  record(seconds,'token_usage_record',{turn_id:turn,response_id,usage:{
    total_tokens:input+20,input_tokens:input,cached_input_tokens:cached,output_tokens:20,reasoning_output_tokens:5,
  }});
const read = async (page: Page, path: string) => {
  const response = await page.request.get(path);
  expect(response.ok()).toBeTruthy();
  return response.json();
};

async function setup(page: Page, agent: 'codex' | 'claude', status: 'detached' | 'completed') {
  const auth=await read(page,'/api/auth/status');
  const login=await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{
    data:{username:'e2e-admin',password:'test-password'},
  });
  expect(login.ok()).toBeTruthy();
  const {user}=await login.json();
  const nativeId=randomUUID(),id='stats-'+nativeId;
  const path=join(root,id);mkdirSync(path,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'元信息验收 '+agent,path}})).json();
  const db=new Database(join(root,'agentmanager.db'));
  try {
    db.prepare(`INSERT INTO sessions(id,project_id,task,status,mode,cli_type,agent_id,native_session_id,codex_session_id,claude_session_id,created_by_user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,project.id,'元信息测试',status,'session',agent,agent,nativeId,agent==='codex'?nativeId:null,agent==='claude'?nativeId:null,user.id);
  } finally {db.close();}
  const directory=agent==='codex'?join(root,'home/.codex/sessions'):join(root,'home/.claude/projects',path.replace(/[^a-zA-Z0-9]/g,'-'));
  mkdirSync(directory,{recursive:true});
  const log=join(directory, agent==='codex'?'rollout-'+nativeId+'.jsonl':nativeId+'.jsonl');
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{
    projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:'project-'+project.id,
  }}});
  await page.request.put('/api/user-state/'+encodeURIComponent('project:'+project.id),{data:{value:{
    terminalInstances:[{id,label:'统计验收'}],activeTerminalId:id,explorerInstances:[],hiddenSessionIds:[],
  }}});
  if(status==='detached') {
    // These fixtures expose a native log and stream without a terminal worker.
    await page.route('**/api/sessions**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(route.request().method()!=='GET'||(pathname!=='/api/sessions'&&pathname!=='/api/sessions/'+id))return route.continue();
      const response=await route.fetch();
      if(!response.ok())return route.fulfill({response});
      const data=await response.json();
      const keepDetached=(row:{id:string;status:string})=>row.id===id?{...row,status:'detached'}:row;
      if(data.session)data.session=keepDetached(data.session);
      if(Array.isArray(data.sessions))data.sessions=data.sessions.map(keepDetached);
      return route.fulfill({response,json:data});
    });
  }
  return {nativeId,id,log,api:'/api/sessions/'+id,chat:page.getByRole('region',{name:'会话对话'}).filter({visible:true})};
}

test('restores split Claude thinking after reload and uses secondary text colors in both themes',async({page})=>{
  const session=await setup(page,'claude','completed');
  const line=(seconds:number,uuid:string,type:string,fields:object)=>JSON.stringify({uuid,type,timestamp:at(seconds),message:{role:type,...fields}})+'\n';
  writeFileSync(session.log,
    line(1,'user','user',{content:'核对项目'})+
    line(2,'reasoning','assistant',{id:'answer',stop_reason:'end_turn',content:[{type:'thinking',thinking:'先核对文件。\n\n再看输出。'}]})+
    line(3,'answer','assistant',{id:'answer',stop_reason:'end_turn',content:[{type:'text',text:'检查完成。'}]}));
  await page.goto('/');
  const final=session.chat.locator('.session-chat-message[data-phase="final"]');
  const summary=final.getByLabel('Claude 的思考过程');
  const answer=final.getByText('检查完成。',{exact:true});
  await expect(summary).toBeVisible();
  await expect(answer).toBeVisible();
  expect((await summary.boundingBox())!.y).toBeLessThan((await answer.boundingBox())!.y);
  await expect(summary).toHaveCSS('color','rgb(129, 133, 140)');
  await summary.click();
  const body=final.locator('.session-chat-thinking-body');
  await expect(body).toBeVisible();
  expect(await body.textContent()).toBe('先核对文件。\n再看输出。');
  await expect(body).toHaveCSS('color','rgb(129, 133, 140)');
  await page.reload();
  await expect(summary).toBeVisible();
  await expect(body).toBeHidden();
  await page.mouse.move(0,0);
  await page.evaluate(()=>{document.documentElement.dataset.theme='midnight';});
  await expect(summary).toHaveCSS('color','rgb(173, 178, 184)');
  await expect(answer).not.toHaveCSS('color','rgb(173, 178, 184)');
});

test('streams per-part USD-equivalent estimates as Codex token usage grows',async({page})=>{
  const session=await setup(page,'codex','detached');
  const usage=(seconds:number,total:number)=>event(seconds,'token_count',{turn_id:'priced-live',info:{
    total_token_usage:{total_tokens:total,input_tokens:total*10/11,cached_input_tokens:total*9/11,output_tokens:total/11,reasoning_output_tokens:total/110},
    last_token_usage:{total_tokens:1100000,input_tokens:1000000,cached_input_tokens:900000,output_tokens:100000,reasoning_output_tokens:10000},
  }});
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+event(1,'task_started',{turn_id:'priced-live'})+
    record(2,'turn_context',{turn_id:'priced-live',model:'gpt-6.2-sol',service_tier:'default'})+
    message(3,'priced-progress','assistant','正在执行模型请求','commentary'));
  await page.routeWebSocket('**/conversation/stream*',route=>route.connectToServer());
  await page.goto('/');
  await expect(session.chat.getByText('正在执行模型请求',{exact:true})).toBeVisible();
  appendFileSync(session.log,usage(4,1100000));
  const live=session.chat.locator('.session-chat-progress summary .session-chat-message-statistics');
  await expect(live).toContainText('1.1M ($1.29)｜100K ($0.20)｜900K ($0.09 | 90%)｜10K ($0.10)｜100K ($1.00)');
  appendFileSync(session.log,usage(5,2200000));
  await expect(live).toContainText('2.2M ($2.58)｜200K ($0.40)｜1.8M ($0.18 | 90%)｜20K ($0.20)｜200K ($2.00)');
  appendFileSync(session.log,message(6,'priced-final','assistant','计费统计完成','final_answer')+event(7,'task_complete',{turn_id:'priced-live'}));
  await expect(session.chat.getByText('计费统计完成',{exact:true})).toBeVisible();
});

test('shows the same persisted Codex estimates, request intervals and dated cache incident after live append and reconnect',async({page},testInfo)=>{
  const session=await setup(page,'codex','detached');
  const prefix=record(0,'session_meta',{id:session.nativeId,cwd:join(root,session.id)})+
    event(1,'task_started',{turn_id:'turn-1'})+record(2,'turn_context',{turn_id:'turn-1',model:'gpt-6.1-sol',service_tier:'default'})+
    message(3,'input-1','user','查询第一问')+message(4,'progress-1','assistant','正在核对','commentary')+
    record(5,'response_item',{type:'function_call',call_id:'tool-a'})+
    record(6,'response_item',{type:'function_call',call_id:'tool-b'})+
    request(7,'turn-1','request-1',10000,9800)+
    message(8,'final-1','assistant','第一问答复','final_answer')+request(9,'turn-1','request-2',11000,10000)+
    event(10,'task_complete',{turn_id:'turn-1'});
  const second=(cached: number)=>record(980,'compacted',{message:'已压缩旧上下文'})+
    event(991,'task_started',{turn_id:'turn-2'})+record(992,'turn_context',{turn_id:'turn-2',model:'gpt-6.1-terra',service_tier:'priority'})+
    message(993,'input-2','user','查询第二问')+message(994,'final-2','assistant','第二问答复','final_answer')+
    request(995,'turn-2','request-3',10000,cached)+request(995,'turn-2','request-3',10000,cached)+
    event(996,'task_complete',{turn_id:'turn-2'});
  writeFileSync(session.log,prefix);
  let connections=0;
  await page.routeWebSocket('**/conversation/stream*',route=>{connections++;route.connectToServer();});
  await page.setViewportSize({width:1200,height:900});
  await page.goto('/');
  await expect(session.chat.getByText('第一问答复',{exact:true})).toBeVisible();
  await expect.poll(()=>connections).toBeGreaterThan(0);
  expect(await session.chat.locator('[data-cache-drop-id]').count()).toBe(0);
  appendFileSync(session.log,second(0));
  const incident=session.chat.locator('[data-cache-drop-id]');
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('11K ｜ 10K (90.91%)');
  await expect(incident).toContainText('10K ｜ 0 (0.0%)');
  await expect(incident).toContainText('2026-11-20');
  const estimatedAmount=session.chat.locator('.conversation-total-credits');
  await expect(estimatedAmount).toHaveText(/^Est\. \$[\d,]+\.\d\d(?:\*)?$/);
  await expect(estimatedAmount).toHaveCSS('color','rgb(126, 34, 206)');
  const final=session.chat.locator('[data-phase=final]').filter({hasText:'第二问答复'});
  await expect(final.locator('.session-chat-message-statistics')).toContainText('1 round | 0 calls');
  await expect(incident.locator('button')).toHaveCount(0);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const details=page.getByRole('dialog',{name:'会话详情',exact:true});
  await expect(details.getByRole('tab',{name:'概览'})).toBeFocused();
  expect((await details.boundingBox())!.width).toBeGreaterThan(1000);
  await expect(details.getByRole('rowheader',{name:'用户输入 / 已完成问答'}).locator('..')).toContainText('2 / 2');
  await expect(details.getByRole('table',{name:'Token 用量'})).toContainText('31,060');
  await details.getByRole('tab',{name:'概览'}).press('ArrowRight');
  const cache=details.getByRole('table',{name:'缓存命中输入减少明细'});
  await expect(details.getByRole('heading',{name:'缓存命中输入减少（1 次）'})).toBeVisible();
  await expect(cache.locator('time')).toHaveText('2026-11-20 17:16:35');
  await expect(cache).toContainText('11K / 10K (90.91%)');
  await expect(cache).not.toContainText('请求 ID');
  await details.getByRole('tab',{name:'会话详情'}).click();
  await expect(details.getByRole('table',{name:'按模型用量'})).toContainText('gpt-6.1-terra');
  await expect(details.getByRole('table',{name:'按模型用量'})).toContainText('priority');
  const usage=details.getByRole('table',{name:'逐区间用量'});
  await expect(usage.getByRole('columnheader')).toHaveText(['时间','总输入','缓存输入','未缓存输入','缓存率','输出','总量','Round','Call','预估金额']);
  const firstRound=usage.locator('[data-interval-kind="final"]').filter({hasText:'21,040'});
  await expect(firstRound.getByRole('cell',{name:'2',exact:true})).toHaveCount(2);
  await firstRound.getByRole('button',{name:'展开轮次用量'}).click();
  const finalRow=usage.getByRole('row').filter({has:page.getByText('Final',{exact:true})});
  await expect(finalRow).toHaveAttribute('data-interval-depth','1');
  await expect(finalRow.getByRole('cell',{name:'11,020',exact:true})).toBeVisible();
  await expect(finalRow.getByRole('cell',{name:'0',exact:true})).toBeVisible();
  await expect(finalRow.getByRole('cell',{name:'1',exact:true})).toBeVisible();
  const progress=usage.locator('[data-interval-kind="progress"]');
  await expect(progress).toHaveCount(1);
  await expect(progress.getByText('Progress',{exact:true})).toBeVisible();
  await expect(usage.locator('[data-interval-depth="1"]').first()).toContainText('Final');
  await expect(finalRow.locator('time')).toHaveAttribute('datetime',at(8));
  await expect(progress.locator('time')).toHaveAttribute('datetime',at(7));
  await progress.getByRole('button',{name:'展开进展用量'}).click();
  const item=usage.locator('[data-interval-depth="2"]');
  await expect(item).toContainText('10,020');
  await expect(item.getByRole('cell',{name:'200',exact:true})).toHaveCount(1);
  await expect(item.getByRole('cell',{name:'98.00%',exact:true})).toBeVisible();
  const totalCell=item.getByRole('cell',{name:'10,020',exact:true});
  await expect(totalCell).toHaveCSS('white-space','nowrap');
  await expect(totalCell).toHaveCSS('text-align','right');
  const dates=await Promise.all([firstRound,progress,item].map(row=>row.locator('time').boundingBox()));
  expect(dates[1]!.x).toBeGreaterThan(dates[0]!.x);
  expect(dates[2]!.x).toBeGreaterThan(dates[1]!.x);
  await page.screenshot({path:testInfo.outputPath('metadata-tree.png')});
  await page.setViewportSize({width:390,height:844});
  await details.getByRole('tab',{name:'缓存异常'}).click();
  await expect(cache).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('metadata-narrow.png')});
  await details.getByRole('tab',{name:'会话详情'}).click();
  await expect(usage.locator('[data-interval-depth="2"]')).toContainText('10,020');
  const usageFrame=details.getByRole('region',{name:'逐区间用量，可横向滚动查看全部列'});
  expect(await usageFrame.evaluate(node=>node.scrollWidth>node.clientWidth)).toBeTruthy();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1200,height:900});
  const oldConnections=connections;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect.poll(()=>connections).toBeGreaterThan(oldConnections);
  await expect(incident).toHaveCount(1);
  await page.reload();
  await expect(incident).toHaveCount(1);
  const history=await read(page,session.api+'/conversation');
  expect(history.metadata.totals).toMatchObject({requests:3,tool_calls:2,tool_rounds:1,tokens:{total_tokens:31060}});
  expect(history.cache_drops).toHaveLength(1);
  writeFileSync(session.log+'.corrected',prefix+second(10000));
  renameSync(session.log+'.corrected',session.log);
  await expect(incident).toHaveCount(0);
  await page.reload();
  await expect(session.chat.getByText('第二问答复',{exact:true})).toBeVisible();
  await expect(incident).toHaveCount(0);
});

test('Claude uses the same session details and persists request facts before removing history',async({page})=>{
  const session=await setup(page,'claude','completed');
  const entry=(timestamp:string, type:string, uuid:string, message:object)=>JSON.stringify({type,uuid,timestamp,message})+'\n';
  const usage={input_tokens:2000,cache_read_input_tokens:8000,cache_creation_input_tokens:1000,output_tokens:40};
  writeFileSync(session.log,entry(at(1),'user','u1',{role:'user',content:'Claude 请求'})+
    entry(at(3),'assistant','part',{role:'assistant',id:'cl-request',model:'claude-fixture',stop_reason:'end_turn',
      content:[{type:'text',text:'Claude 答复'}],usage}));
  const result=await read(page,session.api+'/conversation/metadata');
  expect(result.metadata.summary).toMatchObject({totals:{requests:1,cost:null,tokens:{input_tokens:11000,cached_input_tokens:8000,total_tokens:11040}}});
  await page.goto('/');
  await expect(session.chat.getByText('Claude 答复',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情',exact:true});
  await expect(dialog.getByRole('rowheader',{name:'模型请求（Round）'}).locator('..')).toContainText('1');
  await dialog.getByRole('tab',{name:'会话详情'}).click();
  await expect(dialog.getByRole('table',{name:'按模型用量'})).toContainText('claude-fixture');
  await expect(dialog.getByRole('table',{name:'逐区间用量'})).toContainText('11,040');
  await page.keyboard.press('Escape');
  expect((await page.request.delete(session.api+'/record')).ok()).toBeTruthy();
  expect((await page.request.get(session.api+'/conversation/metadata')).status()).toBe(404);
  const db=new Database(join(root,'agentmanager.db'),{readonly:true});
  try {
    expect(db.prepare(`SELECT count(*) n FROM session_statistics_requests r JOIN session_statistics_sources s
      ON s.source=r.source WHERE s.agent='claude' AND s.native_id=?`).get(session.nativeId)).toEqual({n:1});
  } finally {db.close();}
});

test('settles a split Claude Final as soon as its visible text arrives and restores usage on reload',async({page})=>{
  const session=await setup(page,'claude','completed');
  const entry=(seconds:number,type:string,uuid:string,message:object)=>
    JSON.stringify({timestamp:at(seconds),type,uuid,message})+'\n';
  const usage={input_tokens:4,cache_creation_input_tokens:563,cache_read_input_tokens:22321,output_tokens:694};
  const response={role:'assistant',id:'claude-final',model:'claude-fixture',stop_reason:'end_turn',usage};
  writeFileSync(session.log,entry(1,'user','input',{role:'user',content:'Read the receipt'})+
    entry(2,'assistant','thought',{...response,content:[{type:'thinking',thinking:'Check the receipt'}]}));
  await page.goto('/');
  await expect(session.chat.getByText('Read the receipt',{exact:true})).toBeVisible();
  await expect(session.chat.getByLabel('Claude 进展').getByLabel('Claude 的思考过程')).toBeAttached();
  const body={...response,content:[{type:'text',text:'The receipt is complete.'}]};
  appendFileSync(session.log,entry(3,'assistant','answer',body)+entry(4,'assistant','answer-echo',body));
  const final=session.chat.locator('[data-phase="final"]').filter({hasText:'The receipt is complete.'});
  const statistics=final.locator('.session-chat-message-statistics');
  await expect(final).toHaveCount(1);
  await expect(final.getByLabel('Claude 的思考过程')).toBeVisible();
  await expect(statistics).toHaveAttribute('title',/Total 23,582;/);
  await expect(statistics).toContainText('1 round | 0 calls');
  await expect(statistics).not.toContainText('记录不完整');
  await expect(statistics).toContainText('97.52%');
  await page.reload();
  await expect(final).toHaveCount(1);
  await expect(statistics).toHaveAttribute('title',/Total 23,582;/);
});

test('loads exact earlier intervals and pages through the corresponding lifecycle records',async({page,request:anonymous})=>{
  const session=await setup(page,'codex','completed');
  const turns=Array.from({length:28},(_,i)=>{
    const time=i*30,turn='turn-'+i;
    return event(time,'task_started',{turn_id:turn})+
      record(time+1,'turn_context',{turn_id:turn,model:'gpt-6.1-sol',service_tier:'default'})+
      message(time+2,'input-'+i,'user','问题 '+i)+
      message(time+3,'progress-'+i,'assistant','核对 '+i,'commentary')+
      record(time+4,'response_item',{type:'function_call',call_id:'tool-'+i})+
      request(time+5,turn,'progress-request-'+i,5000,4500)+
      message(time+6,'final-'+i,'assistant','答复 '+i,'final_answer')+
      request(time+7,turn,'final-request-'+i,10000,9000)+
      event(time+8,'task_complete',{turn_id:turn});
  });
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+turns.join(''));
  const metadataUrl=session.api+'/conversation/metadata';
  expect((await anonymous.get(metadataUrl)).status()).toBe(401);
  const usageUrl=session.api+'/conversation/usage-intervals';
  expect((await anonymous.get(usageUrl)).status()).toBe(401);
  expect((await page.request.get(usageUrl+'?parent=invalid')).status()).toBe(400);
  expect((await page.request.get(usageUrl+'?before=invalid')).status()).toBe(400);
  const {metadata}=await read(page,metadataUrl);
  expect(metadata.events).toHaveLength(50);
  expect(metadata.next_event).toBeTruthy();
  const {metadata:earlier}=await read(page,metadataUrl+'?event_before='+encodeURIComponent(metadata.next_event));
  expect(earlier.events).toHaveLength(7);
  expect(earlier.next_event).toBeNull();
  expect(new Set([...metadata.events,...earlier.events].map(event=>event.id)).size).toBe(57);
  await page.goto('/');
  await expect(session.chat.getByText('答复 27',{exact:true})).toBeVisible();
  const first=session.chat.locator('[data-phase=final]').filter({has:page.getByText('答复 0',{exact:true})});
  await expect(first).toHaveCount(0);
  const older=session.chat.getByRole('button',{name:'加载更早的对话'});
  await older.click();
  await expect(session.chat.getByText('答复 10',{exact:true})).toBeVisible();
  await older.click();
  const stats=first.locator('.session-chat-message-statistics');
  await expect(stats).toHaveAttribute('title',/Total 15,040/);
  await expect(stats).toContainText('2 rounds | 1 call');
});

test('keeps the shown Item counts and usage within their Progress across consecutive inserted inputs and refresh',async({page})=>{
  const session=await setup(page,'codex','completed');
  const turn='steered-turn';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+record(2,'turn_context',{turn_id:turn,model:'gpt-6.1-sol',service_tier:'default'})+
    message(3,'input','user','开始核对')+message(4,'first','assistant','第一段核对','commentary')+
    request(5,turn,'r1',1000,900)+record(6,'response_item',{type:'function_call',call_id:'call'})+
    request(7,turn,'r2',2000,1800)+message(8,'steer1','user','第一次插入')+
    request(9,turn,'r3',3000,2800)+message(10,'steer2','user','第二次插入')+
    message(11,'crossing','assistant','跨段的进展','commentary')+request(12,turn,'r4',4000,3800)+
    message(13,'after','assistant','本段的进展','commentary')+request(14,turn,'r5',5000,4800)+
    record(14.1,'response_item',{type:'function_call',call_id:'tail'})+
    request(14.2,turn,'late-tail',7000,6800)+request(14.25,turn,'reasoning-tail',8000,7900)+
    message(14.3,'steer3','user','暂缓前面的请求')+
    message(15,'answer','assistant','核对完成','final_answer')+request(16,turn,'r6',6000,5800)+
    event(17,'task_complete',{turn_id:turn}));
  await page.goto('/');
  const group=session.chat.getByRole('region',{name:'Codex 进展'}).filter({hasText:'跨段的进展'});
  const disclosure=group.getByRole('button',{name:/展开进展/});
  await expect(group).toBeVisible();
  if(await disclosure.isVisible())await disclosure.click();
  await expect(group.locator('.session-chat-message-statistics').first()).toHaveAttribute('title',/Total 24,080;/);
  const crossing=group.locator('.session-chat-progress-entry').filter({hasText:'跨段的进展'});
  await expect(crossing.locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 4,020;/);
  await expect(crossing.locator('time').first()).toHaveAttribute('datetime',at(11));
  await expect(group.locator('.session-chat-progress-entry').filter({hasText:'本段的进展'}).locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 5,020;/);
  await expect(group.locator('.session-chat-progress-entry').filter({hasText:executionUsageLabel}).locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 15,040;/);
  await expect(group.locator('.session-chat-progress-entry')).toHaveCount(3);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情',exact:true});
  await dialog.getByRole('tab',{name:'会话详情'}).click();
  const table=dialog.getByRole('table',{name:'逐区间用量'});
  await table.getByRole('button',{name:'展开轮次用量'}).click();
  await expect(table.getByText('Final',{exact:true})).toHaveCount(1);
  expect(await table.getByText('Progress',{exact:true}).count()).toBeGreaterThan(1);
  await table.locator('[data-interval-kind="progress"]').filter({hasText:'24,080'}).getByRole('button',{name:'展开进展用量'}).click();
  const items=table.locator('[data-interval-depth="2"][data-interval-kind="item"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('5,020');
  await expect(items.nth(1)).toContainText('4,020');
  const execution=table.locator('[data-interval-kind="unassigned"]');
  const executionLabel=execution.getByText(executionUsageLabel,{exact:true});
  await expect(execution.getByRole('rowheader')).toHaveText(executionUsageLabel);
  await expect(executionLabel).toHaveAttribute('title',/调用工具或推理/);
  await expect(execution.getByRole('cell',{name:'15,040',exact:true})).toBeVisible();
  await expect(execution.getByRole('cell',{name:'1',exact:true})).toBeVisible();
  await expect(execution.getByRole('cell',{name:'2',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(dialog.getByRole('tab',{name:'会话详情'})).toHaveAttribute('aria-selected','true');
  await expect(items).toHaveCount(2);
});

test('reconciles live Codex API Progress costs when a shared response crosses an accepted input',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='crossing-api-turn';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId}));
  let emit:((frame:unknown)=>void)|undefined;
  await page.routeWebSocket('**/conversation/stream*',socket=>{emit=frame=>socket.send(JSON.stringify(frame));});
  await page.goto('/');
  await expect.poll(()=>!!emit).toBe(true);
  const usage=(total:number,amount:number,requests=1,calls=0)=>({tokens:{total_tokens:total},requests,tool_calls:calls,
    tool_rounds:calls?1:0,complete:true,coverage:'complete',shared_messages:1,cost:{unit:'USD',basis:'api',amount,complete:true}});
  const before=usage(21500,0.2),shared=usage(84800,0.6,3,7),firstLive=usage(42000,0.3,1,1);
  const old={id:'old',start_at:at(1),end_at:at(4),end_reason:'input',elapsed_ms:3000};
  const current={id:'current',start_at:at(4),end_at:null,end_reason:null,elapsed_ms:null};
  const interval=(value:ReturnType<typeof usage>,sequence:number,scope:string,segment?:object)=>({
    ...value,interval:value,progress_id:scope,segment,sequence,revision:sequence,turn_id:turn,
  });
  const messages=[
    {id:'start',role:'user',turn_id:turn,text:'Start',timestamp:at(1),sequence:1},
    {id:'before',role:'assistant',phase:'commentary',turn_id:turn,text:'Check the first scope',timestamp:at(2),sequence:2,
      statistics:interval(before,2,old.id,{...old,...usage(69900,0.5,3,5),unassigned:usage(48400,0.3,2,5)})},
    {id:'steer',role:'user',turn_id:turn,text:'Add a second scope',timestamp:at(4),sequence:4},
    {id:'after',role:'assistant',phase:'commentary',turn_id:turn,text:'Continue from the shared response',timestamp:at(5),sequence:5,
      statistics:interval(shared,5,old.id,{...old,...usage(106300,0.8,4,7)})},
  ];
  emit!({type:'snapshot',messages,turn_id:turn,busy:true,stage:'tools',started_at:at(1),activities:[{
    id:'tool',turn_id:turn,after_message_id:'after',label:'Search',status:'running',started_at:at(6),
  }]});
  emit!({type:'progress_statistics',native_id:session.nativeId,progress:{...firstLive,turn_id:turn,revision:6,
    segment:{...current,...firstLive,unassigned:firstLive},step:{...firstLive,segment_id:current.id,after_message_id:null,after_sequence:null,start_at:at(4)},
  }});
  const oldGroup=session.chat.getByRole('region',{name:'Codex 进展'}).filter({hasText:'Check the first scope'});
  const active=session.chat.getByRole('region',{name:'Codex 进展'}).filter({hasText:'Continue from the shared response'});
  const header=(group:typeof active)=>group.locator('summary .session-chat-message-statistics').first();
  await expect(header(oldGroup)).toHaveAttribute('title',/Total 21,500;/);
  await expect(header(oldGroup)).toContainText('21.5K ($0.20)');
  await expect(oldGroup.getByText(executionUsageLabel)).toHaveCount(0);
  await expect(header(active)).toHaveAttribute('title',/Total 126,800;/);
  await expect(header(active)).toContainText('126.8K ($0.90)');
  const step=active.getByRole('status',{name:'正在执行的进展 2'});
  await expect(step).toContainText('42K ($0.30)');
  await expect(step).toContainText('1 round | 1 call');
});

test('uses adjacent cached-input counts and ignores a ratio drop caused by new input tokens',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='actual-hit-counts';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+message(2,'input','user','核对同一轮缓存')+
    message(3,'first','assistant','先检查')+record(3.5,'response_item',{type:'function_call',call_id:'first'})+
    request(4,turn,'before',36873,36480));
  await page.goto('/');
  await expect(session.chat.getByText('核对同一轮缓存',{exact:true})).toBeVisible();
  const incident=session.chat.locator('[data-cache-drop-id]');
  appendFileSync(session.log,record(7,'response_item',{type:'function_call',call_id:'growth'})+
    request(7.516,turn,'growth',44658,36736));
  const metadataUrl=session.api+'/conversation/metadata';
  const {metadata}=await read(page,metadataUrl);
  expect(metadata.summary.totals.requests).toBe(2);
  expect(metadata.cache_drops).toEqual([]);
  await expect(incident).toHaveCount(0);

  const next=request(10,turn,'fewer-hits',40000,36040);
  appendFileSync(session.log,record(9,'response_item',{type:'function_call',call_id:'next'})+next+next);
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('82.26%');
  await expect(incident).toContainText('90.1%');
  await expect(incident).toContainText('Elapsed: 2.484s');
  await expect(incident).toContainText('额外费用未知');
  await page.reload();
  await expect(incident).toHaveCount(1);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const details=page.getByRole('dialog',{name:'会话详情',exact:true});
  await details.getByRole('tab',{name:'缓存异常'}).click();
  await expect(details.getByRole('table',{name:'缓存命中输入减少明细'})).toContainText('请求间隔 2.484秒');
});

test('shows one cache drop next to an in-turn compaction and keeps it after reload',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='compact-live';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+message(2,'user','user','继续办理')+
    message(3,'progress','assistant','压缩前的进展','commentary')+
    request(55.355,turn,'before',450070,448512)+
    record(55.363,'compacted',{compaction_response_id:'compaction-id',message:'已压缩本次上下文'}));
  await page.goto('/');
  const summary=session.chat.getByRole('button',{name:/Conversation summary/});
  await expect(summary).toBeVisible();
  const incident=session.chat.locator('[data-cache-drop-id]');
  await expect(incident).toHaveCount(0);
  const after=request(60.309,turn,'after',32061,13696);
  appendFileSync(session.log,after+after);
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('99.65%');
  await expect(incident).toContainText('42.72%');
  await expect(incident).toContainText('Elapsed: 4.954s');
  await expect(incident.locator('time')).toHaveText(['2026-11-20 17:01:00', '2026-11-20 17:00:55']);
  expect(await summary.evaluate(node=>node.closest('[data-context-kind="compaction_summary"]')?.nextElementSibling?.matches('[data-cache-drop-id]'))).toBe(true);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情',exact:true});
  await dialog.getByRole('tab',{name:'缓存异常'}).click();
  const cache=dialog.getByRole('table',{name:'缓存命中输入减少明细'});
  await expect(cache.getByRole('cell',{name:'上下文压缩',exact:true})).toBeVisible();
  await expect(cache).toContainText('4.954秒');
  await expect(cache.locator('time')).toHaveAttribute('datetime',at(60.309));
  await page.reload();
  await expect(incident).toHaveCount(1);
  const history=await read(page,session.api+'/conversation');
  expect(history.cache_drops).toHaveLength(1);
  expect(history.cache_drops[0]).toMatchObject({elapsed_ms:4954,compaction_at:at(55.363),interval_kind:'request'});
});

test('reconciles a live provider compaction echo into its card and reports one post-compaction cache drop',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='provider-compact',body='仅在压缩卡片里可见的摘要';
  const wrapper='Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+message(2,'input','user','继续任务')+
    message(3,'before','assistant','压缩前进展','commentary')+request(4,turn,'before',346988,346752));
  await page.goto('/');
  await expect(session.chat.getByText('继续任务',{exact:true})).toBeVisible();
  const rewrite=record(59,'response_item',{type:'message',id:'rewrite-item',role:'assistant',phase:'final_answer',
    content:[{type:'output_text',text:body}],internal_chat_message_metadata_passthrough:{content_item_kinds:['unknown']}});
  appendFileSync(session.log,rewrite+request(60,turn,'rewrite-response',345318,3968));
  const echo=session.chat.locator('[data-phase=final]').filter({hasText:body});
  await expect(echo).toHaveCount(1);
  const summary=wrapper+'\n'+body;
  appendFileSync(session.log,record(60.001,'compacted',{message:summary,compaction_response_id:'rewrite-response',
    replacement_history:[{type:'message',role:'user',id:'summary-card',content:[{type:'input_text',text:summary}]}]})+
    message(67,'after','assistant','压缩后继续','commentary')+request(68,turn,'after',29384,15744));
  const card=session.chat.getByRole('button',{name:/Conversation summary/});
  const drop=session.chat.locator('[data-cache-drop-id]');
  for (const reload of [false,true]) {
    if (reload) await page.reload();
    await expect(card).toHaveCount(1);
    await expect(echo).toHaveCount(0);
    await expect(drop).toHaveCount(1);
    await expect(drop).toContainText('99.93%');
    await expect(drop).toContainText('53.58%');
  }
  await card.click();
  await expect(page.getByRole('dialog',{name:'Conversation summary'})).toContainText(body);
});

test('shows the manual compaction cache drop once its first ordinary request arrives',async({page})=>{
  const session=await setup(page,'codex','detached');
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:'previous'})+message(2,'first','user','压缩前提问')+
    message(3,'before','assistant','压缩前答复','final_answer')+request(4,'previous','before',336415,335616)+
    event(5,'task_complete',{turn_id:'previous'})+event(20,'task_started',{turn_id:'manual'})+
    request(61.481,'manual','rewrite',336983,0)+record(61.489,'compacted',{
      message:'已手动压缩',replacement_history:[{type:'reasoning',encrypted_content:'x'.repeat(2_100_000)}],
      compaction_response_id:'rewrite',
    })+event(61.517,'task_complete',{turn_id:'manual'}));
  await page.goto('/');
  const summary=session.chat.getByRole('button',{name:/Conversation summary/});
  const incident=session.chat.locator('[data-cache-drop-id]');
  await expect(summary).toBeVisible();
  await expect(incident).toHaveCount(0);
  const after=request(77.877,'next','after',32483,13696);
  appendFileSync(session.log,event(61.915,'task_started',{turn_id:'next'})+
    message(61.930,'next','user','压缩后提问')+message(74,'after','assistant','压缩后答复','final_answer')+
    after+after+event(78,'task_complete',{turn_id:'next'}));
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('99.76%');
  await expect(incident).toContainText('42.16%');
  await expect(session.chat.locator('[data-phase=final]').filter({hasText:'压缩后答复'}).locator('[data-cache-drop-id]')).toHaveCount(1);
  await page.reload();
  await expect(incident).toHaveCount(1);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情'});
  await dialog.getByRole('tab',{name:'缓存异常'}).click();
  const table=dialog.getByRole('table',{name:'缓存命中输入减少明细'});
  await expect(table.getByRole('cell',{name:'上下文压缩',exact:true})).toBeVisible();
  await expect(table).toContainText('336.4K / 335.6K (99.76%)');
  await expect(table).toContainText('32.5K / 13.7K (42.16%)');
});

test('shows complete estimates with default speed and uses native Fast settings for the next request',async({page})=>{
  const session=await setup(page,'codex','detached');
  const round=(time:number,turn:string,text:string)=>event(time,'task_started',{turn_id:turn})+
    record(time+1,'turn_context',{turn_id:turn,model:'gpt-6-luna'})+
    message(time+2,turn+'-input','user','核对 '+turn)+message(time+3,turn+'-answer','assistant',text,'final_answer')+
    record(time+4,'token_usage_record',{turn_id:turn,response_id:turn+'-usage',usage:{
      input_tokens:16571,cached_input_tokens:11392,output_tokens:50,reasoning_output_tokens:0,total_tokens:16621,
    }})+event(time+5,'task_complete',{turn_id:turn});

  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+round(1,'standard','默认速度答复'));
  await page.goto('/');
  const finalAmount=(text:string)=>session.chat.locator('[data-phase="final"]').filter({hasText:text})
    .locator('.session-chat-message-statistics .session-chat-estimated-cost').first();
  await expect(finalAmount('默认速度答复')).toHaveText('<$0.01');
  appendFileSync(session.log,event(7,'thread_settings_applied',{thread_settings:{model:'gpt-6-luna',service_tier:'priority'}})+
    round(8,'fast','Fast 速度答复'));
  await expect(finalAmount('Fast 速度答复')).toHaveText('<$0.01');
  await page.reload();
  await expect(finalAmount('默认速度答复')).toHaveText('<$0.01');
  await expect(finalAmount('Fast 速度答复')).toHaveText('<$0.01');
  const {metadata}=await read(page,session.api+'/conversation/metadata');
  expect(metadata.models).toEqual(expect.arrayContaining([
    expect.objectContaining({speed:'default',requests:1,cost:expect.objectContaining({complete:true})}),
    expect.objectContaining({speed:'priority',requests:1,cost:expect.objectContaining({complete:true})}),
  ]));
});

test('keeps a delivered async notice within Progress when consecutive inputs share a Final',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='async-delivery';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+
    message(2,'first','user','开始检查')+message(2.5,'second','user','补充检查范围')+
    record(3,'response_item',{type:'function_call',id:'notice-call',call_id:'notice-call',name:'send_message_to_user_async'})+
    event(4,'item_completed',{turn_id:turn,item:{type:'AgentMessage',id:'notice',phase:'final_answer',delivery:'async',
      content:[{type:'Text',text:'执行中的说明'}]}})+
    request(5,turn,'notice-receipt',5000,4500));
  await page.goto('/');
  const notice=session.chat.getByText('执行中的说明',{exact:true});
  const progress=session.chat.locator('.session-chat-progress').filter({hasText:'执行中的说明'});
  const toggle=progress.locator('summary.session-chat-progress-toggle');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  await expect(notice).toBeVisible();
  await expect(session.chat.locator('[data-phase="final"]')).toHaveCount(0);
  await expect(toggle.getByLabel('进展时间').locator('time')).toHaveAttribute('datetime',at(5));
  await expect(toggle).toContainText('1 round | 1 call');
  appendFileSync(session.log,message(8,'final','assistant','正式答复','final_answer')+
    request(9,turn,'final-receipt',10000,9500)+event(10,'task_complete',{turn_id:turn,last_agent_message:'正式答复'}));
  const final=session.chat.locator('[data-phase="final"]');
  await expect(final).toHaveText(/正式答复/);
  await expect(final.locator('.session-chat-message-statistics')).toContainText('2 rounds | 1 call');
  await page.reload();
  await expect(final).toHaveCount(1);
  await expect(final.locator('.session-chat-message-statistics')).toContainText('2 rounds | 1 call');
  const {metadata}=await read(page,session.api+'/conversation/metadata');
  expect(metadata.summary).toMatchObject({user_inputs:2,completed_turns:1,totals:{requests:2,tool_calls:1}});
});

test('waits for actual usage after commentary and counts a reasoning-only request separately',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='waiting-receipt';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+message(2,'input','user','核对回执')+
    message(3,'update','assistant','文字已经输出','commentary'));
  await page.goto('/');
  const group=session.chat.getByRole('region',{name:'Codex 进展'}).filter({hasText:'文字已经输出'});
  await expect(group).toBeVisible();
  const disclosure=group.getByRole('button',{name:/展开进展/});
  if(await disclosure.isVisible())await disclosure.click();
  const header=group.locator('summary .session-chat-message-statistics');
  const item=group.locator('.session-chat-progress-entry .session-chat-message-statistics').first();
  await expect(header).toHaveText('等待用量回执');
  await expect(item).toHaveText('等待用量回执');
  const footer=page.getByLabel('Session information').filter({visible:true});
  // This fixture has no live terminal, so its unresolved receipt is partial.
  await expect(footer.getByText('记录不完整',{exact:true})).toBeVisible();
  appendFileSync(session.log,record(24.121,'token_usage_record',{turn_id:turn,response_id:'visible-receipt',
    usage:{total_tokens:281353,input_tokens:279734,cached_input_tokens:278784,output_tokens:1619,reasoning_output_tokens:1500}}));
  await expect(item).toHaveAttribute('title',/Total 281,353;/);
  await expect(header).toContainText('1 round | 0 calls');
  await expect(footer.getByText(/记录不完整|等待用量|正在回填/)).toHaveCount(0);
  const progressTime=group.locator('summary').getByLabel('进展时间').locator('time');
  await expect(progressTime).toHaveAttribute('datetime',at(24.121));
  appendFileSync(session.log,record(30,'token_usage_record',{turn_id:turn,response_id:'reasoning-receipt',
    usage:{total_tokens:284146,input_tokens:283775,cached_input_tokens:279552,output_tokens:371,reasoning_output_tokens:371}}));
  const reasoning=group.locator('.session-chat-progress-entry').filter({hasText:executionUsageLabel});
  await expect(reasoning).toContainText('1 round | 0 calls');
  await expect(reasoning.locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 284,146;/);
  await expect(header).toHaveAttribute('title',/Total 565,499;/);
  await expect(header).toContainText('2 rounds | 0 calls');
  await expect(progressTime).toHaveAttribute('datetime',at(30));
});

test('shows dated cache drops under each Progress header before its Items and before the Final answer',async({page})=>{
  const session=await setup(page,'codex','detached');
  const turn='cache-items';
  writeFileSync(session.log,record(0,'session_meta',{id:session.nativeId})+
    event(1,'task_started',{turn_id:turn})+record(1.5,'turn_context',{turn_id:turn,model:'gpt-6.1-sol'})+
    message(2,'input','user','核对缓存下降条目')+
    message(3,'baseline','assistant','建立缓存基线','commentary')+request(4,turn,'r1',10000,9800));
  await page.goto('/');
  await expect(session.chat.getByText('建立缓存基线')).toBeAttached();
  appendFileSync(session.log,message(6,'first-drop','assistant','第一处下降','commentary')+request(7,turn,'r2',10000,1000));
  const progress=session.chat.getByRole('region',{name:'codex 进展'});
  const notice=progress.getByRole('group',{name:'缓存命中输入减少'});
  await expect(notice).toHaveCount(1);
  await expect(notice.first()).toBeVisible();
  appendFileSync(session.log,
    message(8,'restored','assistant','缓存恢复','commentary')+request(9,turn,'r3',11000,10600)+
    message(10,'second-drop','assistant','第二处下降','commentary')+request(11,turn,'r4',11000,500)+
    message(12,'final','assistant','核对完成','final_answer')+request(13,turn,'r5',11000,100)+
    event(14,'task_complete',{turn_id:turn}));
  const verify=async()=>{
    const before = (left:Element,right:Element) => !!(left.compareDocumentPosition(right)&Node.DOCUMENT_POSITION_FOLLOWING);
    const toggle=progress.locator('.session-chat-progress-toggle');
    const firstItem=progress.locator('.session-chat-progress-entry').first();
    await expect(session.chat.locator('[data-cache-drop-id]')).toHaveCount(3);
    await expect(notice).toHaveCount(2);
    await expect(notice.nth(0).locator('time').first()).toHaveAttribute('datetime',at(7));
    await expect(notice.nth(1).locator('time').first()).toHaveAttribute('datetime',at(11));
    if(await toggle.getAttribute('aria-expanded')==='true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded','false');
    await expect(firstItem).toBeHidden();
    await expect(notice.last()).toBeVisible();
    expect(await toggle.evaluate(before,await notice.first().elementHandle())).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded','true');
    await expect(firstItem).toBeVisible();
    await expect(notice).toHaveCount(2);
    expect(await toggle.evaluate(before,await notice.first().elementHandle())).toBe(true);
    expect(await notice.last().evaluate(before,await firstItem.elementHandle())).toBe(true);

    const final=session.chat.locator('[data-phase="final"]').filter({hasText:'核对完成'});
    const finalNotice=final.locator('[data-cache-drop-id]');
    await expect(finalNotice.locator('time').first()).toHaveAttribute('datetime',at(13));
    expect(await finalNotice.evaluate(before,await final.getByText('核对完成',{exact:true}).elementHandle())).toBe(true);

    const firstNotice=notice.first();
    await expect(firstNotice.locator('button')).toHaveCount(0);
    await expect(firstNotice.locator('time').first()).toHaveText('2026-11-20 17:00:07');
    await expect(firstNotice.locator('time').first()).toHaveCSS('color', 'rgb(220, 38, 38)');
    await expect(firstNotice).toHaveText(/2026-11-20 17:00:07\s*10K ｜ 1K \(10\.0%\)\s*←\s*2026-11-20 17:00:04\s*10K ｜ 9\.8K \(98\.0%\)\s*Elapsed: 3s/);
    await expect(firstNotice.locator('time').last()).toHaveAttribute('datetime',at(4));
    await expect(firstNotice.locator('time').last()).toHaveCSS('color', 'rgb(220, 38, 38)');
    await expect(firstNotice).toContainText('预估多耗 $0.42');
    const cacheRates=firstNotice.locator('.session-chat-cache-hit');
    await expect(cacheRates.first()).toHaveCSS('color','rgb(131, 55, 33)');
    await expect(cacheRates.last()).toHaveCSS('color','rgb(33, 131, 60)');
    await expect(firstNotice).toHaveCSS('font-size', '11px');
    await expect(firstNotice).toHaveCSS('white-space', 'nowrap');
  };
  await verify();
  await page.reload();
  await verify();
  await progress.evaluate(node=>{node.style.maxWidth='320px';});
  const narrowNotice=notice.first();
  const layout=await narrowNotice.evaluate(row=>({
    width:row.clientWidth,
    scrollWidth:row.scrollWidth,
    dateTop:row.querySelector('time')?.getBoundingClientRect().top,
    elapsedTop:row.lastElementChild?.getBoundingClientRect().top,
  }));
  expect(layout.width).toBeLessThanOrEqual(320);
  expect(layout.scrollWidth).toBeGreaterThan(layout.width);
  expect(layout.dateTop).toBe(layout.elapsedTop);
});
