import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

test('an attached answer clears only its native terminal question and stays resolved after replay',async({page},info)=>{
 const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3');
 const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'question-terminal-project'),logs=join(root,'home/.codex/sessions'),native='019ff001-5555-7555-8555-555555555558';mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});
 const version=execFileSync('codex',['--version'],{encoding:'utf8'}).match(/\d+\.\d+\.\d+/)![0],record=(type:string,payload:any)=>JSON.stringify({type,timestamp:new Date().toISOString(),payload})+'\n',log=join(logs,`rollout-${native}.jsonl`);
 const question=(id:string,title:string)=>({type:'agentMessage',id,delivery:'async',phase:'final_answer',text:title,questions:[{title,options:null}]});
 const items:any[]=[question('other','还需要回答的另一个问题'),question('upload','请提供截图和日志')],submissions:any[]=[];
 writeFileSync(log,record('event_msg',{type:'user_message',message:'开始验证'})+items.map(item=>record('event_msg',{type:'item_completed',turn_id:'question-turn',item:{...item,type:'AgentMessage',content:[{type:'Text',text:item.text}]}})).join('')+record('event_msg',{type:'task_complete',turn_id:'question-turn'}));
 const fake=join(path,'fake-tui.mjs'),stateFile=join(path,'terminal-state.json');
 writeFileSync(fake,`import WebSocket from ${JSON.stringify(require.resolve('../server/node_modules/ws'))};
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2),remote=args[args.indexOf('--remote')+1],socket=new WebSocket('ws+unix://'+remote.slice('unix://'.length)+':/'),pending=new Set(),answered=new Set();
function draw(){writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({pending:[...pending],remote,pid:process.pid}));process.stdout.write('\\x1b[H\\x1b[2J'+(pending.size?'Queued follow-up inputs\\r\\n? '+pending.size+' questions\\r\\n':'No pending questions\\r\\n'));}
function apply(item){if(item?.type==='agentMessage'&&item.delivery==='async')item.questions.forEach((q,index)=>{const id=JSON.stringify(['request_user_input_async',item.id,index]);if(!answered.has(id))pending.add(id);});
if(item?.type==='userMessage'&&item.content.length===1&&item.content[0].type==='text'){const text=item.content[0].text.trim(),start='<send_user_message_question_reply>',end='</send_user_message_question_reply>';if(text.startsWith(start)&&text.endsWith(end))try{JSON.parse(text.slice(start.length,-end.length)).forEach(q=>{answered.add(q.questionItemId);pending.delete(q.questionItemId);});}catch{}}}
socket.on('open',()=>socket.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'test-tui',version:'1'}}})));
socket.on('message',bytes=>{const frame=JSON.parse(bytes.toString());if(frame.id===1)socket.send(JSON.stringify({id:2,method:'thread/resume',params:{threadId:${JSON.stringify(native)}}}));if(frame.result?.thread?.turns)for(const turn of frame.result.thread.turns)for(const item of turn.items)apply(item);if(frame.method==='item/completed')apply(frame.params.item);draw();});socket.on('error',()=>process.exit(1));socket.on('close',()=>process.exit(0));`);
 const server=createServer(),wss=new WebSocketServer({server});
 wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const frame=JSON.parse(bytes.toString());if(!frame.method||!frame.id)return;let result:any={};
  if(frame.method==='initialize')result={userAgent:`codex_cli_rs/${version}`};
  if(frame.method==='thread/read'||frame.method==='thread/resume')result={thread:{id:native,status:{type:'idle'},cwd:path,turns:frame.method==='thread/resume'?[{id:'question-turn',status:'completed',items}]:undefined}};
  if(frame.method==='thread/turns/list')result={data:[{id:'question-turn',status:'completed',items}]};if(frame.method==='thread/queue/list')result={data:[]};
  if(frame.method==='turn/start'){
   submissions.push(frame.params);const answer={type:'userMessage',id:`answer-${submissions.length}`,clientId:frame.params.clientUserMessageId,content:frame.params.input};items.push(answer);
   appendFileSync(log,record('response_item',{type:'message',id:answer.id,role:'user',internal_chat_message_metadata_passthrough:{turn_id:`answer-turn-${submissions.length}`},content:frame.params.input.map((part:any)=>part.type==='text'?{type:'input_text',text:part.text}:{type:'input_image',image_url:'fixture-image'})}));
   for(const client of wss.clients)client.send(JSON.stringify({method:'item/completed',params:{threadId:native,turnId:`answer-turn-${submissions.length}`,item:answer}}));
  }
  socket.send(JSON.stringify({id:frame.id,result}));
 }));await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));let id:string|undefined;
 const state=()=>existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):null;
 try{
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const {project}=await(await page.request.post('/api/projects',{data:{name:'问题终端同步',path}})).json(),{session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();id=session.id;
  const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{session_codex_command:`node '${fake}'`,statusline_prompted:'true',app_theme:'light'}}});
  expect((await page.request.post(`/api/sessions/${id}/reload`)).ok()).toBeTruthy();await expect.poll(()=>state()?.pending.length).toBe(2);expect(state().remote).not.toBe('unix://'+join(root,'codex.sock'));
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id,label:'问题终端同步'}],activeTerminalId:id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.setViewportSize({width:1600,height:1000});await page.goto('/');const card=page.getByRole('region',{name:'Codex 向你提问'}).filter({visible:true}),answer=card.getByRole('textbox',{name:'请提供截图和日志',exact:true});await answer.fill('见附件');
  await answer.evaluate(element=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9hZsEAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'proof.png',{type:'image/png'}));transfer.items.add(new File(['test log'],'proof.txt',{type:'text/plain'}));element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));});
  await expect(card.locator('[data-status="ready"]')).toHaveCount(2);await card.getByRole('button',{name:'提交回答',exact:true}).click();
  await expect.poll(()=>state()?.pending).toEqual([JSON.stringify(['request_user_input_async','other',0])]);expect(submissions).toHaveLength(1);expect(submissions[0].input.some((part:any)=>part.type==='localImage')).toBe(true);expect(submissions[0].input[0].text).toContain('proof.txt');expect(submissions[0].input[0].text.startsWith('<send_user_message_question_reply>')).toBe(true);
  await expect(card.getByRole('textbox',{name:'还需要回答的另一个问题',exact:true})).toBeVisible();await page.getByRole('button',{name:'原始终端',exact:true}).click();await expect(page.locator('.xterm').filter({visible:true})).toBeVisible();await page.screenshot({path:info.outputPath('terminal-one-unanswered-question.png')});await page.getByRole('button',{name:'对话',exact:true}).click();await page.reload();await expect(page.locator('.session-chat-question-summary')).toContainText(['待回答','已回答']);
  const previousPid=state().pid;expect((await page.request.post(`/api/sessions/${id}/reload`)).ok()).toBeTruthy();await expect.poll(()=>state()?.pid).not.toBe(previousPid);await expect.poll(()=>state()?.pending).toEqual([JSON.stringify(['request_user_input_async','other',0])]);expect(submissions).toHaveLength(1);
  await page.reload();await card.getByRole('textbox',{name:'还需要回答的另一个问题',exact:true}).fill('继续验证');await card.getByRole('button',{name:'提交回答',exact:true}).click();await expect.poll(()=>state()?.pending).toEqual([]);expect(submissions).toHaveLength(2);
  await page.getByRole('button',{name:'原始终端',exact:true}).click();await expect(page.locator('.xterm').filter({visible:true})).toBeVisible();await page.screenshot({path:info.outputPath('terminal-no-pending-questions.png')});
 }finally{if(id)await page.request.delete(`/api/sessions/${id}`,{timeout:3000}).catch(()=>{});await page.request.put('/api/settings',{data:{settings:{session_codex_command:'codex'}},timeout:3000}).catch(()=>{});for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
