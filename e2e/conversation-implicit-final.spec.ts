import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('renders an unphased Codex completion as the conclusion across reload',async({page})=>{
  const root=join(process.cwd(),'.test-data/e2e'),require=createRequire(import.meta.url),
    {WebSocketServer}=require('../server/node_modules/ws'),
    Database=require('../server/node_modules/better-sqlite3'),
    server=createServer(),wss=new WebSocketServer({server}),
    native='019ff001-1234-7234-8234-123456789ac0';
  wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{
    const frame=JSON.parse(bytes.toString());
    if(!frame.id||!frame.method)return;
    socket.send(JSON.stringify({id:frame.id,result:
      frame.method==='thread/read'?{thread:{status:{type:'idle'}}}:
      frame.method==='thread/turns/list'||frame.method==='thread/queue/list'?{data:[]}:{}}));
  }));
  await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
  let sessionId:string|undefined;
  try{
    const auth=await(await page.request.get('/api/auth/status')).json();
    expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{
      data:{username:'e2e-admin',password:'test-password'},
    })).ok()).toBeTruthy();
    const path=join(root,'implicit-final-project'),logs=join(root,'home/.codex/sessions');
    mkdirSync(path,{recursive:true});mkdirSync(logs,{recursive:true});
    const log=join(logs,`rollout-${native}.jsonl`),turn='implicit-final-e2e',
      answer='我是 Codex，一个编程协作助手。',
      record=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
    writeFileSync(log,'');
    const {project}=await(await page.request.post('/api/projects',{data:{name:'无阶段最终回答回归',path}})).json(),
      {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
    sessionId=session.id;
    const db=new Database(join(root,'agentmanager.db'));
    try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}
    finally{db.close();}
    await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
    await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
    await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'无阶段最终回答'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
    await page.goto('/');
    const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
    await expect(chat.getByText('事件通道已连接',{exact:true})).toBeVisible();
    appendFileSync(log,
      record('event_msg',{type:'task_started',turn_id:turn})
      +record('event_msg',{type:'user_message',message:'介绍你自己'})
      +record('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id:'event-answer',content:[{type:'Text',text:answer}]}})
      +record('response_item',{type:'message',id:'native-answer',role:'assistant',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:answer}]})
      +record('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:100},last_token_usage:{total_tokens:100,input_tokens:80,output_tokens:20}}})
      +record('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:answer}));
    const conclusions=chat.locator('article[data-phase="final"]').filter({hasText:answer});
    await expect(conclusions).toHaveCount(1);
    await expect(conclusions.getByText('结论',{exact:true})).toBeVisible();
    await expect(chat.getByRole('region',{name:'Codex 进展'})).not.toContainText(answer);
    const history=await(await page.request.get(`/api/sessions/${sessionId}/conversation`)).json();
    const replies=history.messages.filter((message:any)=>message.role==='assistant'&&message.text===answer);
    expect(replies).toHaveLength(1);
    expect(replies[0].phase).toBe('final');
    await page.reload();
    await expect(chat.locator('article[data-phase="final"]').filter({hasText:answer})).toHaveCount(1);
    await expect(chat.getByRole('region',{name:'Codex 进展'})).not.toContainText(answer);
  }finally{
    if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`).catch(()=>{});
    for(const client of wss.clients)client.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
