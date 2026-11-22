import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

test('keeps native Codex thinking inside its Progress step and Final after reload',async({page})=>{
  const root=join(process.cwd(),'.test-data/e2e');
  const require=createRequire(import.meta.url);
  const {WebSocketServer}=require('../server/node_modules/ws');
  const Database=require('../server/node_modules/better-sqlite3');
  const server=createServer(),wss=new WebSocketServer({server});
  const threadId='019ff001-1234-7234-8234-123456789ac0',turnId='reasoning-turn';
  const startedAt=Date.now()/1000;
  let active=false,subscribed=false;
  const notify=(method:string,params:object)=>{
    for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify({method,params:{threadId,turnId,...params}}));
  };
  wss.on('connection',(socket:any)=>socket.on('message',(bytes:Buffer)=>{
    const frame=JSON.parse(bytes);
    if(!frame.id)return;
    if(frame.method==='thread/turns/list')subscribed=true;
    const result=frame.method==='thread/read'?{thread:{status:{type:active?'active':'idle'}}}: {data:[]};
    socket.send(JSON.stringify({id:frame.id,result}));
  }));
  await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
  let sessionId:string|undefined;
  try{
    const auth=await(await page.request.get('/api/auth/status')).json();
    expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{
      data:{username:'e2e-admin',password:'test-password'},
    })).ok()).toBeTruthy();
    const projectPath=join(root,'codex-reasoning-project'),logs=join(root,'home/.codex/sessions');
    mkdirSync(projectPath,{recursive:true});mkdirSync(logs,{recursive:true});
    const log=join(logs,`rollout-${threadId}.jsonl`);
    const record=(type:string,payload:object)=>JSON.stringify({type,timestamp:new Date().toISOString(),payload})+'\n';
    const prompt='检查测试文件';
    writeFileSync(log,record('event_msg',{type:'task_started',turn_id:turnId})+
      record('response_item',{type:'message',id:'reasoning-user',role:'user',content:[{type:'input_text',text:prompt}]}));
    const {project}=await(await page.request.post('/api/projects',{data:{name:'Codex reasoning',path:projectPath}})).json();
    const {session}=await(await page.request.post('/api/sessions',{
      data:{project_id:project.id,project_path:projectPath,mode:'terminal'},
    })).json();
    sessionId=session.id;
    const db=new Database(join(root,'agentmanager.db'));
    try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',threadId,sessionId);}
    finally{db.close();}
    await page.request.put('/api/settings',{data:{settings:{app_theme:'light',statusline_prompted:'true'}}});
    await page.request.put('/api/user-state/app',{data:{value:{
      projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`,
    }}});
    await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{
      terminalInstances:[{id:sessionId,label:'Codex reasoning'}],activeTerminalId:sessionId,explorerInstances:[],
    }}});
    await page.goto('/');
    const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
    await expect(chat.getByText(prompt,{exact:true})).toBeVisible();
    await expect.poll(()=>subscribed).toBe(true);
    active=true;
    notify('turn/started',{turn:{id:turnId,startedAt}});
    const first='先读测试文件。',second='再检查计算结果。',progressText='测试文件已读。',answer='计算完成。';
    const streamReasoning=(id:string,delta:string)=>notify('item/reasoning/textDelta',{itemId:id,contentIndex:0,delta});
    notify('item/started',{item:{type:'reasoning',id:'reason-1',summary:[],content:[]}});
    streamReasoning('reason-1','先读');
    const progress=chat.getByRole('region',{name:'codex 进展'});
    const steps=progress.locator('.session-chat-progress-entry');
    const firstStep=steps.first();
    const preview=firstStep.locator('.session-chat-thinking-preview');
    await expect(preview).toHaveText('先读');
    streamReasoning('reason-1','测试文件。');
    await expect(preview).toHaveText(first);
    notify('item/completed',{item:{type:'reasoning',id:'reason-1',summary:[],content:[first]}});
    notify('item/started',{item:{type:'commandExecution',id:'fixture-tool',command:'cat fixture.txt'}});
    const pending=progress.getByRole('status',{name:'正在执行的进展 1'});
    await expect(pending.locator('.session-chat-thinking-preview')).toHaveText(first);
    await expect(pending.locator('.session-chat-live-tool')).toContainText('fixture.txt');
    notify('item/completed',{item:{type:'commandExecution',id:'fixture-tool',command:'cat fixture.txt',status:'completed'}});
    notify('item/completed',{item:{type:'agentMessage',id:'reasoning-progress',phase:'commentary',text:progressText}});
    await expect(firstStep.getByText(progressText)).toBeVisible();
    streamReasoning('reason-2',second);
    await expect(steps.nth(1).locator('.session-chat-thinking-preview')).toHaveText(second);
    notify('item/completed',{item:{type:'reasoning',id:'reason-2',summary:[],content:[second]}});
    notify('item/completed',{item:{type:'agentMessage',id:'reasoning-answer',phase:'final_answer',text:answer}});
    notify('turn/completed',{turn:{id:turnId,status:'completed'}});
    active=false;
    await expect(chat.getByText(answer,{exact:true})).toBeVisible();
    const final=chat.locator('[data-phase="final"]');
    const finalSummary=final.locator('.session-chat-thinking-block > summary');
    const verifyPlacement=async()=>{
      const toggle=progress.locator('.session-chat-progress-toggle');
      if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
      await expect(firstStep.locator('.session-chat-progress-number')).toHaveText('1');
      await expect(firstStep.locator('.session-chat-thinking-preview')).toHaveText(first);
      await expect(firstStep.getByText(progressText,{exact:true})).toBeVisible();
      await expect(progress.locator('.session-chat-thinking-block')).toHaveCount(1);
      await expect(finalSummary.locator('.session-chat-thinking-preview')).toHaveText(second);
      const heading=final.locator('.session-chat-final-heading');
      expect((await heading.boundingBox())!.y).toBeLessThan((await finalSummary.boundingBox())!.y);
      expect((await finalSummary.boundingBox())!.y).toBeLessThan((await final.getByText(answer,{exact:true}).boundingBox())!.y);
      await finalSummary.click();
      await expect(final.locator('.session-chat-thinking-body')).toHaveText(second);
    };
    await verifyPlacement();
    const reasoningRecord=(id:string,text:string)=>record('response_item',{
      type:'reasoning',id,summary:[],content:[{type:'reasoning_text',text}],encrypted_content:'fixture-hidden',
    });
    const assistantRecord=(id:string,phase:string,text:string)=>record('response_item',{
      type:'message',id,role:'assistant',phase,content:[{type:'output_text',text}],
    });
    appendFileSync(log,reasoningRecord('reason-1',first)+assistantRecord('reasoning-progress','commentary',progressText)+
      reasoningRecord('reason-2',second)+assistantRecord('reasoning-answer','final_answer',answer)+
      record('event_msg',{type:'task_complete',turn_id:turnId,last_agent_message:answer}));
    await page.reload();
    await expect(final.getByText(answer,{exact:true})).toBeVisible();
    await verifyPlacement();
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  }finally{
    if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`).catch(()=>{});
    for(const client of wss.clients)client.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
