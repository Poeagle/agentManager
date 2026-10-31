import {test,expect} from '@playwright/test';
import {createServer} from 'http';
import {createRequire} from 'module';
import {appendFileSync,mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3');

test('the actual Codex async AgentMessage becomes a persistent choice card and replies as a normal user message',async({page},testInfo)=>{
  const root=join(process.cwd(),'.test-data/e2e'),native='019ff001-5555-7555-8555-555555555555';
  const logDir=join(root,'home/.codex/sessions');mkdirSync(logDir,{recursive:true});const log=join(logDir,`rollout-${native}.jsonl`);
  const record=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:new Date().toISOString(),payload})+'\n';
  // This is the exact item shape emitted by the real request_user_input_async
  // call, including its completed-tool semantics and string-array options.
  const questions=[{title:'免费旅行，你最想去哪里？',options:['太空','深海','森林']}];
  const item={type:'AgentMessage',id:'call-question',phase:'final_answer',delivery:'async',questions,content:[{type:'Text',text:'免费旅行，你最想去哪里？\n- 太空\n- 深海\n- 森林'}]};
  writeFileSync(log,record('event_msg',{type:'user_message',message:'随机出个问题'})+record('event_msg',{type:'item_completed',thread_id:native,turn_id:'question-turn',item})+record('response_item',{type:'message',role:'assistant',id:'followup',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'question-turn'},content:[{type:'output_text',text:'问题已发出，可以点选。'}]}));
  const server=createServer(),wss=new WebSocketServer({server}),inputs:any[]=[];
  wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{
    const frame=JSON.parse(bytes.toString());if(!frame.method)return;
    const result=frame.method==='thread/read'?{thread:{status:{type:'idle'}}}:frame.method==='thread/turns/list'?{data:[]}:{};
    if(frame.method==='turn/start') {
      inputs.push(frame.params);const text=frame.params.input.find((part:any)=>part.type==='text').text;
      appendFileSync(log,record('response_item',{type:'message',id:'answer-user',role:'user',internal_chat_message_metadata_passthrough:{turn_id:'reply-turn'},content:[{type:'input_text',text}]}));
      for(const client of wss.clients)client.send(JSON.stringify({method:'item/completed',params:{threadId:native,turnId:'reply-turn',item:{type:'userMessage',id:'answer-user',clientId:frame.params.clientUserMessageId,content:[{type:'text',text}]}}}));
    }
    socket.send(JSON.stringify({id:frame.id,result}));
  }));
  await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
  let sessionId:string|undefined;
  try {
    const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
    const path=join(root,'async-question-project');mkdirSync(path,{recursive:true});const {project}=await(await page.request.post('/api/projects',{data:{name:'异步提问验证',path}})).json();
    const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();sessionId=session.id;
    const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
    await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
    await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
    await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'异步提问验证'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
    await page.goto('/');
    const card=page.getByRole('region',{name:'Codex 向你提问'}).filter({visible:true}),submit=card.getByRole('button',{name:'提交回答',exact:true});
    await expect(card).toContainText('免费旅行，你最想去哪里？');await expect(card.getByRole('radio')).toHaveCount(4);
    await page.getByRole('button',{name:'原始终端',exact:true}).first().click();await expect(page.locator('.xterm').filter({visible:true})).toBeVisible();
    await expect.poll(async()=>{const result=await page.request.get(`/api/sessions/${session.id}/conversation`);return (await result.json()).session_active;}).toBe(true);
    await page.getByRole('button',{name:'对话',exact:true}).click();
    await card.getByRole('radio',{name:/太空/}).check();await expect(submit).toBeEnabled();
    await page.reload();await expect(card.getByRole('radio',{name:/太空/})).toBeChecked();
    await card.getByRole('button',{name:'稍后回答'}).click();
    const draft=page.getByRole('textbox',{name:'发送给当前 Agent 的消息'}).filter({visible:true});await draft.fill('保留这份未发送草稿');await page.getByRole('button',{name:/^待回答/}).click();
    await card.scrollIntoViewIfNeeded();await expect(card.getByText('免费旅行，你最想去哪里？',{exact:false}).first()).toBeInViewport();
    await page.screenshot({path:testInfo.outputPath('actual-async-question.png')});
    await submit.click();await expect.poll(()=>inputs.length).toBe(1);const reply=JSON.parse(inputs[0].input[0].text.replace('<send_user_message_question_reply>','').replace('</send_user_message_question_reply>',''));expect(reply).toEqual([{questionItemId:JSON.stringify(['request_user_input_async','call-question',0]),question:'免费旅行，你最想去哪里？',answer:'太空'}]);await expect(draft).toHaveValue('保留这份未发送草稿');
    await expect(card).toHaveCount(0);const summary=page.locator('.session-chat-question-summary');await expect(summary).toContainText('已回答');await expect(summary.locator('details')).toHaveJSProperty('open',false);expect((await summary.boundingBox())!.height).toBeLessThan(90);await summary.getByText('查看详情').click();await expect(summary.locator('details')).toHaveJSProperty('open',true);await expect(summary.locator('dd')).toHaveText('太空');await summary.getByText('查看详情').click();await page.screenshot({path:testInfo.outputPath('answered-collapsed.png')});await page.reload();await expect(summary).toContainText('已回答');await expect(summary.locator('details')).toHaveJSProperty('open',false);expect(inputs).toHaveLength(1);await expect(page.getByText('<send_user_message_question_reply>',{exact:false})).toHaveCount(0);
  }finally {if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`);for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
