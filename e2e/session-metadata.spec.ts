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
  const incident=session.chat.getByRole('button',{name:/缓存命中率下降/});
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('11K / 10K (90.91%)');
  await expect(incident).toContainText('10K / 0 (0.0%)');
  await expect(incident).toContainText('2026-11-20');
  const credits=session.chat.locator('.conversation-total-credits');
  await expect(credits).toHaveText(/^Est\. Cr [\d,]+\.\d$/);
  await expect(credits).toHaveCSS('color','rgb(126, 34, 206)');
  const final=session.chat.locator('[data-phase=final]').filter({hasText:'第二问答复'});
  await expect(final.locator('.session-chat-message-statistics')).toContainText('1 Run');
  await incident.click();
  const card=page.getByRole('dialog',{name:'缓存命中率下降',exact:true});
  await expect(card).toContainText('模型变化、速度变化、上下文压缩、输入间隔较长');
  await expect(card.getByRole('table').locator('time')).toHaveText('2026-11-20 17:16:35');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const details=page.getByRole('dialog',{name:'会话详情',exact:true});
  await expect(details.getByRole('tab',{name:'概览'})).toBeFocused();
  expect((await details.boundingBox())!.width).toBeGreaterThan(1000);
  await expect(details.getByRole('rowheader',{name:'用户输入 / 已完成问答'}).locator('..')).toContainText('2 / 2');
  await expect(details.getByRole('table',{name:'Token 用量'})).toContainText('31,060');
  await details.getByRole('tab',{name:'概览'}).press('ArrowRight');
  const cache=details.getByRole('table',{name:'缓存命中率下降明细'});
  await expect(details.getByRole('heading',{name:'缓存命中率下降（1 次）'})).toBeVisible();
  await expect(cache.locator('time')).toHaveText('2026-11-20 17:16:35');
  await expect(cache).toContainText('11K / 10K (90.91%)');
  await expect(cache).not.toContainText('请求 ID');
  await details.getByRole('tab',{name:'会话详情'}).click();
  await expect(details.getByRole('table',{name:'按模型用量'})).toContainText('gpt-6.1-terra');
  await expect(details.getByRole('table',{name:'按模型用量'})).toContainText('priority');
  const usage=details.getByRole('table',{name:'逐区间用量'});
  await expect(usage.getByRole('columnheader')).toHaveText(['时间','总输入','缓存输入','未缓存输入','缓存率','输出','总量','预估积分']);
  const firstFinal=usage.locator('[data-interval-kind="final"]').filter({hasText:'21,040'});
  await firstFinal.getByRole('button',{name:'展开答复用量'}).click();
  const progress=usage.locator('[data-interval-kind="progress"]');
  await expect(progress).toHaveCount(1);
  await progress.getByRole('button',{name:'展开进展用量'}).click();
  const item=usage.locator('[data-interval-depth="2"]');
  await expect(item).toContainText('10,020');
  await expect(item.getByRole('cell',{name:'200',exact:true})).toHaveCount(1);
  await expect(item.getByRole('cell',{name:'98.00%',exact:true})).toBeVisible();
  const totalCell=item.getByRole('cell',{name:'10,020',exact:true});
  await expect(totalCell).toHaveCSS('white-space','nowrap');
  await expect(totalCell).toHaveCSS('text-align','right');
  const dates=await Promise.all([firstFinal,progress,item].map(row=>row.locator('time').boundingBox()));
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
  writeFileSync(session.log+'.corrected',prefix+second(9600));
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
  await expect(dialog.getByRole('rowheader',{name:'模型请求（Runs）'}).locator('..')).toContainText('1');
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
  await expect(stats).toContainText('1 round | 1 call | 2 Runs');
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
    request(14.2,turn,'late-tail',7000,6800)+message(14.3,'steer3','user','暂缓前面的请求')+
    message(15,'answer','assistant','核对完成','final_answer')+request(16,turn,'r6',6000,5800)+
    event(17,'task_complete',{turn_id:turn}));
  await page.goto('/');
  const group=session.chat.getByRole('region',{name:'Codex 进展'}).filter({hasText:'跨段的进展'});
  const disclosure=group.getByRole('button',{name:/展开进展/});
  await expect(group).toBeVisible();
  if(await disclosure.isVisible())await disclosure.click();
  await expect(group.locator('.session-chat-message-statistics').first()).toHaveAttribute('title',/Total 16,060;/);
  const crossing=group.locator('.session-chat-progress-entry').filter({hasText:'跨段的进展'});
  await expect(crossing.locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 4,020;/);
  await expect(crossing.locator('time').first()).toHaveAttribute('datetime',at(11));
  await expect(group.locator('.session-chat-progress-entry').filter({hasText:'本段的进展'}).locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 5,020;/);
  await expect(group.locator('.session-chat-progress-entry').filter({hasText:'无单独消息的用量'}).locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 7,020;/);
  await expect(group.locator('.session-chat-progress-entry')).toHaveCount(3);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情',exact:true});
  await dialog.getByRole('tab',{name:'会话详情'}).click();
  const table=dialog.getByRole('table',{name:'逐区间用量'});
  await table.getByRole('button',{name:'展开答复用量'}).click();
  await table.locator('[data-interval-kind="progress"]').filter({hasText:'16,060'}).getByRole('button',{name:'展开进展用量'}).click();
  const items=table.locator('[data-interval-depth="2"][data-interval-kind="item"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('5,020');
  await expect(items.nth(1)).toContainText('4,020');
  await expect(table.locator('[data-interval-kind="unassigned"]')).toContainText('7,020');
  await dialog.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(dialog.getByRole('tab',{name:'会话详情'})).toHaveAttribute('aria-selected','true');
  await expect(items).toHaveCount(2);
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
  const incident=session.chat.getByRole('button',{name:/缓存命中率下降/});
  await expect(incident).toHaveCount(0);
  const after=request(60.309,turn,'after',32061,13696);
  appendFileSync(session.log,after+after);
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('99.65%');
  await expect(incident).toContainText('42.72%');
  await expect(incident).toContainText('请求间隔 4.954秒');
  await expect(incident.locator('time')).toHaveText('2026-11-20 17:01:00');
  expect(await summary.evaluate(node=>node.closest('[data-context-kind="compaction_summary"]')?.nextElementSibling?.matches('[data-cache-drop-id]'))).toBe(true);
  await incident.click();
  const card=page.getByRole('dialog',{name:'缓存命中率下降',exact:true});
  await expect(card.getByRole('cell',{name:'上下文压缩',exact:true})).toBeVisible();
  await expect(card.locator('time')).toHaveText('2026-11-20 17:01:00');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情',exact:true});
  await dialog.getByRole('tab',{name:'缓存异常'}).click();
  const cache=dialog.getByRole('table',{name:'缓存命中率下降明细'});
  await expect(cache.getByRole('cell',{name:'上下文压缩',exact:true})).toBeVisible();
  await expect(cache).toContainText('4.954秒');
  await expect(cache.locator('time')).toHaveAttribute('datetime',at(60.309));
  await page.reload();
  await expect(incident).toHaveCount(1);
  const history=await read(page,session.api+'/conversation');
  expect(history.cache_drops).toHaveLength(1);
  expect(history.cache_drops[0]).toMatchObject({elapsed_ms:4954,compaction_at:at(55.363),interval_kind:'request'});
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
  const incident=session.chat.getByRole('button',{name:/缓存命中率下降/});
  await expect(summary).toBeVisible();
  await expect(incident).toHaveCount(0);
  const after=request(77.877,'next','after',32483,13696);
  appendFileSync(session.log,event(61.915,'task_started',{turn_id:'next'})+
    message(61.930,'next','user','压缩后提问')+message(74,'after','assistant','压缩后答复','final_answer')+
    after+after+event(78,'task_complete',{turn_id:'next'}));
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('99.76%');
  await expect(incident).toContainText('42.16%');
  expect(await summary.evaluate(node=>node.closest('[data-context-kind="compaction_summary"]')?.nextElementSibling?.matches('[data-cache-drop-id]'))).toBe(true);
  await page.reload();
  await expect(incident).toHaveCount(1);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'会话详情'});
  await dialog.getByRole('tab',{name:'缓存异常'}).click();
  const table=dialog.getByRole('table',{name:'缓存命中率下降明细'});
  await expect(table.getByRole('cell',{name:'上下文压缩',exact:true})).toBeVisible();
  await expect(table).toContainText('336.4K / 335.6K (99.76%)');
  await expect(table).toContainText('32.5K / 13.7K (42.16%)');
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
  appendFileSync(session.log,record(24.121,'token_usage_record',{turn_id:turn,response_id:'visible-receipt',
    usage:{total_tokens:281353,input_tokens:279734,cached_input_tokens:278784,output_tokens:1619,reasoning_output_tokens:1500}}));
  await expect(item).toHaveAttribute('title',/Total 281,353;/);
  await expect(header).toContainText('1 Run');
  appendFileSync(session.log,record(30,'token_usage_record',{turn_id:turn,response_id:'reasoning-receipt',
    usage:{total_tokens:284146,input_tokens:283775,cached_input_tokens:279552,output_tokens:371,reasoning_output_tokens:371}}));
  const reasoning=group.locator('.session-chat-progress-entry').filter({hasText:'无单独消息的用量'});
  await expect(reasoning).toContainText('0 rounds | 0 calls | 1 Run');
  await expect(reasoning.locator('.session-chat-message-statistics')).toHaveAttribute('title',/Total 284,146;/);
  await expect(header).toHaveAttribute('title',/Total 565,499;/);
  await expect(header).toContainText('2 Runs');
});
