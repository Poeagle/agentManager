import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  // The fixture has a real rollout and conversation stream but no terminal
  // worker. Retain the detached tab when the host discovers this.
  await page.route('**/api/sessions**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()!=='GET'||(path!=='/api/sessions'&&path!==session.api))return route.continue();
    const response=await route.fetch();
    if(!response.ok())return route.fulfill({response});
    const data=await response.json();
    const keepDetached=(row:{id:string;status:string})=>row.id===session.id?{...row,status:'detached'}:row;
    if(data.session)data.session=keepDetached(data.session);
    if(Array.isArray(data.sessions))data.sessions=data.sessions.map(keepDetached);
    return route.fulfill({response,json:data});
  });
  await page.routeWebSocket('**/conversation/stream*',route=>{connections++;route.connectToServer();});
  await page.setViewportSize({width:1200,height:900});
  await page.goto('/');
  await expect(session.chat.getByText('第一问答复',{exact:true})).toBeVisible();
  await expect.poll(()=>connections).toBeGreaterThan(0);
  expect(await session.chat.locator('[data-cache-drop-id]').count()).toBe(0);
  appendFileSync(session.log,second(0));
  const incident=session.chat.getByRole('button',{name:/缓存命中率下降/});
  await expect(incident).toHaveCount(1);
  await expect(incident).toContainText('10K / 9.8K (98.0%)');
  await expect(incident).toContainText('10K / 0 (0.0%)');
  await expect(incident).toContainText('2026-11-20');
  const credits=session.chat.locator('.conversation-total-credits');
  await expect(credits).toHaveText(/^Est\. Cr [\d,]+\.\d$/);
  await expect(credits).toHaveCSS('color','rgb(126, 34, 206)');
  const final=session.chat.locator('[data-phase=final]').filter({hasText:'第二问答复'});
  await expect(final.locator('.session-chat-message-statistics')).toContainText('1 Run');
  await incident.click();
  const card=page.getByRole('dialog',{name:'缓存命中率下降',exact:true});
  await expect(card).toContainText('原因未确认');
  await expect(card).toContainText('模型变化、速度变化、上下文压缩、输入间隔较长');
  await expect(card.locator('time')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Details',exact:true}).click();
  const details=page.getByRole('dialog',{name:'会话详情',exact:true});
  await expect(details.getByRole('region',{name:'按模型用量'})).toContainText('gpt-6.1-terra');
  await expect(details.getByRole('region',{name:'按模型用量'})).toContainText('priority');
  await expect(details.getByRole('heading',{name:'缓存命中率下降（1 次）'})).toBeVisible();
  await expect(details.getByRole('rowheader',{name:'用户输入 / 已完成问答'}).locator('..')).toContainText('2 / 2');
  await expect(details.getByRole('region',{name:'生命周期与输入记录'})).toContainText('压缩 · 已完成');
  await page.setViewportSize({width:390,height:844});
  await expect(details.getByRole('region',{name:'缓存命中率下降明细'})).toBeAttached();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('metadata-narrow.png')});
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
  await expect(dialog.getByRole('region',{name:'按模型用量'})).toContainText('claude-fixture');
  await expect(dialog.getByRole('rowheader',{name:'模型请求（Runs）'}).locator('..')).toContainText('1');
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
