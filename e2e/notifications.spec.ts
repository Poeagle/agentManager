import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3');

test('notifies changed sessions across closed projects, answers in the drawer and jumps to the source',async({page},testInfo)=>{
  const root=join(process.cwd(),'.test-data/e2e'),native='019ff001-3535-7353-8353-353535353535';
  const logDir=join(root,'home/.codex/sessions');mkdirSync(logDir,{recursive:true});const log=join(logDir,`rollout-notification-${native}.jsonl`);
  const record=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:new Date().toISOString(),payload})+'\n';
  writeFileSync(log,record('session_meta',{id:native})+record('event_msg',{type:'task_started',turn_id:'work'})+record('event_msg',{type:'user_message',message:'检查兼容性'}));
  const server=createServer(),wss=new WebSocketServer({server}),inputs:Array<{text:string;clientId:string}>=[];
  let active=true;
  const send=(method:string,params:unknown)=>{for(const client of wss.clients)client.send(JSON.stringify({method,params}));};
  wss.on('connection',(socket:any)=>socket.on('message',(bytes:Buffer)=>{
    const frame=JSON.parse(bytes.toString());if(!frame.id||!frame.method)return;
    let result:any=frame.method==='thread/read'?{thread:{id:native,status:{type:active?'active':'idle'}}}:frame.method==='thread/resume'?{thread:{id:native,status:{type:active?'active':'idle'}}}:frame.method==='thread/turns/list'?{data:[]}:{};
    if(frame.method==='turn/start'){
      const text=frame.params.input.find((part:any)=>part.type==='text').text;
      inputs.push({text,clientId:frame.params.clientUserMessageId});
      const turnId=`reply-turn-${inputs.length}`,itemId=`answer-user-${inputs.length}`;
      active=true;send('turn/started',{threadId:native,turn:{id:turnId,status:'inProgress'}});
      appendFileSync(log,record('response_item',{type:'message',id:itemId,role:'user',internal_chat_message_metadata_passthrough:{turn_id:turnId},content:[{type:'input_text',text}]}));
      send('item/completed',{threadId:native,turnId,item:{type:'userMessage',id:itemId,clientId:frame.params.clientUserMessageId,content:[{type:'text',text}]}});
      result={turn:{id:turnId}};
    }
    socket.send(JSON.stringify({id:frame.id,result}));
  }));
  await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
  let projectId:string|undefined,fixtureUserId:string|undefined;
  try {
    const status=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
    const username=`notice-e2e-${Date.now()}`;
    const created=await page.request.post('/api/users',{data:{username,password:'test-password',display_name:'通知体验',role:'admin'}});
    expect(created.status()).toBe(200);fixtureUserId=(await created.json()).user.id;
    expect((await page.request.post('/api/auth/login',{data:{username,password:'test-password'}})).ok()).toBeTruthy();
    const auth=await(await page.request.get('/api/auth/status')).json(),userId=auth.user.id;
    const path=join(root,'notifications-project');mkdirSync(path,{recursive:true});
    const {project}=await(await page.request.post('/api/projects',{data:{name:'通知验证项目',path}})).json();projectId=project.id;
    const db=new Database(join(root,'agentmanager.db'));
    try{
      db.prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('notification-work',?,'兼容性修复','running','session','codex',?,?)").run(project.id,native,userId);
      db.prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES('notification-quiet',?,'安静的标签页','running','terminal','claude',?)").run(project.id,userId);
    }finally{db.close();}
    await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
    await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[],activeTab:'home'}}});
    // The fixture native engine is running without a PTY wrapper. This changes
    // only the browser's wrapper-ready flag; replies use the real input API.
    await page.route('**/api/sessions/notification-work/conversation?*',async route=>{
      const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),session_active:true}});
    });
    await page.goto('/');await expect(page.getByRole('button',{name:'消息通知',exact:true})).toBeVisible();
    await expect.poll(()=>wss.clients.size).toBeGreaterThan(0);
    expect((await(await page.request.get('/api/notifications')).json()).notifications).toHaveLength(0);
    appendFileSync(log,record('response_item',{type:'message',id:'work-result',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'work'},content:[{type:'output_text',text:'兼容性检查完成，现有接口保持兼容。'}]})+record('event_msg',{type:'task_complete',turn_id:'work'}));
    active=false;send('turn/completed',{threadId:native,turn:{id:'work',status:'completed',completedAt:Date.now()/1000}});
    await expect(page.getByRole('button',{name:/消息通知，1 条未读/})).toBeVisible({timeout:15000});
    const toast=page.getByRole('complementary',{name:'新消息通知'});await expect(toast).toContainText('本轮运行完成');
    await toast.getByRole('button',{name:'查看并处理'}).click();
    const drawer=page.getByRole('dialog',{name:'消息通知'});
    await expect(drawer.getByRole('region',{name:'会话对话'})).toContainText('兼容性检查完成');
    await expect(drawer).not.toContainText('安静的标签页');
    await page.screenshot({path:testInfo.outputPath('notification-result-desktop.png')});
    await drawer.getByRole('button',{name:'关闭消息通知'}).click();
    const questionId=JSON.stringify(['request_user_input_async','notify-question',0]);
    const question={type:'AgentMessage',id:'notify-question',delivery:'async',questions:[{title:'需要继续兼容旧版接口吗？',options:['兼容旧版','只支持新版']}],content:[{type:'Text',text:'需要继续兼容旧版接口吗？'}]};
    appendFileSync(log,record('event_msg',{type:'task_started',turn_id:'question-turn'})+record('event_msg',{type:'item_completed',thread_id:native,turn_id:'question-turn',item:question}));
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.pending;}).toBe(1);
    await page.getByRole('button',{name:/^消息通知/}).click();
    await drawer.getByRole('button',{name:'直接处理',exact:true}).click();
    const card=drawer.getByRole('region',{name:'Codex 向你提问'});
    await expect(card).toContainText('需要继续兼容旧版接口吗？');
    await page.screenshot({path:testInfo.outputPath('notification-question-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    await expect(card).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('notification-question-mobile.png')});
    await card.getByRole('radio',{name:/兼容旧版/}).check();await card.getByRole('button',{name:'提交回答'}).click();
    await expect.poll(()=>inputs.length).toBe(1);
    const reply=JSON.parse(inputs[0].text.replace('<send_user_message_question_reply>','').replace('</send_user_message_question_reply>',''));
    expect(reply).toEqual([{questionItemId:questionId,question:'需要继续兼容旧版接口吗？',answer:'兼容旧版'}]);
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.pending;}).toBe(0);
    await page.setViewportSize({width:1280,height:860});
    await drawer.getByRole('button',{name:'打开标签页',exact:true}).last().click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByLabel('会话标签',{exact:true}).locator('[data-session-id="notification-work"]')).toHaveCount(1);
    await expect(page.locator('.session-chat[data-session-id="notification-work"]').filter({visible:true})).toBeVisible();
    expect((await(await page.request.get('/api/sessions')).json()).sessions).toHaveLength(2);
    expect(inputs).toHaveLength(1);

    // A permanent failure becomes actionable, with its original error and the
    // same reply target. Continuing is a real, explicitly requested input.
    active=false;
    send('turn/started',{threadId:native,turn:{id:'failed-turn',status:'inProgress'}});
    send('error',{threadId:native,turnId:'failed-turn',error:{message:'测试执行错误：请检查项目配置。'},willRetry:false});
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.notifications.filter((n:{kind:string;state:string})=>n.kind==='error'&&n.state==='pending').length;}).toBe(1);
    await page.getByRole('button',{name:/^消息通知/}).click();
    await drawer.getByRole('button',{name:'直接处理',exact:true}).click();
    await expect(drawer.locator('.session-chat-error-notice')).toContainText('测试执行错误：请检查项目配置。');
    await page.screenshot({path:testInfo.outputPath('notification-error-desktop.png')});
    const input=drawer.getByRole('textbox',{name:'发送给当前 Agent 的消息'});
    await input.fill('配置已调整，请继续处理。');await drawer.getByRole('button',{name:'发送消息',exact:true}).click();
    const guard=page.getByRole('dialog',{name:'发送前检查'});
    await expect(guard).toBeVisible();await guard.getByRole('button',{name:'原样发送',exact:true}).click();
    await expect.poll(()=>inputs.length).toBe(2);expect(inputs[1].text).toBe('配置已调整，请继续处理。');
  }finally{
    try {
      if(projectId||fixtureUserId){const db=new Database(join(root,'agentmanager.db'));try{
        db.pragma('foreign_keys=ON');
        db.prepare('DELETE FROM notifications WHERE session_id IN (?,?)').run('notification-work','notification-quiet');
        db.prepare('DELETE FROM sessions WHERE id IN (?,?)').run('notification-work','notification-quiet');
        if(projectId)db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
        if(fixtureUserId){db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(fixtureUserId);db.prepare('DELETE FROM users WHERE id=?').run(fixtureUserId);}
      }finally{db.close();}}
    }finally{
      for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  }
});
