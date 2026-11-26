import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3');

test('notifies changed sessions across closed projects, answers in the centered window and jumps to the source',async({page},testInfo)=>{
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
    const toast=page.getByRole('complementary',{name:'新消息通知'});
    await expect(toast).toHaveCount(0);
    await page.getByRole('button',{name:/消息通知，1 条未读/}).click();
    const drawer=page.getByRole('dialog',{name:'消息通知'});
    const noticeList=drawer.getByRole('region',{name:'通知列表'});
    const projectGroup=noticeList.getByRole('group',{name:'通知验证项目'});
    const projectToggle=projectGroup.getByRole('button',{name:'通知验证项目',exact:true});
    await expect(projectToggle).toHaveAttribute('aria-expanded','true');
    const tabRow=projectGroup.getByRole('button',{name:'通知验证项目 · 兼容性修复',exact:true});
    await expect(tabRow).toContainText('兼容性修复');await expect(tabRow).not.toContainText('通知验证项目');
    const projectBox=await projectToggle.boundingBox(),tabBox=await tabRow.boundingBox();
    expect(tabBox!.x).toBeGreaterThan(projectBox!.x+10);
    const nameBox=await tabRow.locator('strong').boundingBox(),timeBox=await tabRow.locator('time').boundingBox();
    expect(Math.abs(nameBox!.y+nameBox!.height/2-timeBox!.y-timeBox!.height/2)).toBeLessThan(2);
    expect(nameBox!.x+nameBox!.width).toBeLessThan(timeBox!.x);
    expect(tabBox!.height).toBeLessThan(40);
    await projectToggle.click();await expect(tabRow).not.toBeVisible();
    await projectToggle.click();await expect(tabRow).toBeVisible();
    await expect(noticeList.locator('time')).toHaveText(/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}$/);
    await expect(noticeList).not.toContainText('兼容性检查完成');
    await tabRow.click();
    await expect(drawer.getByRole('region',{name:'会话对话'})).toContainText('兼容性检查完成');
    await expect(drawer).not.toContainText('安静的标签页');
    await expect(drawer).toHaveAttribute('aria-modal','true');
    const bounds=await drawer.boundingBox(),viewport=page.viewportSize()!;
    expect(Math.abs(bounds!.x+bounds!.width/2-viewport.width/2)).toBeLessThan(2);
    expect(Math.abs(bounds!.y+bounds!.height/2-viewport.height/2)).toBeLessThan(2);
    await expect(page.locator('.notification-bell svg')).toHaveAttribute('width','14');
    await expect(drawer.locator('.session-chat-message-statistics')).toHaveCount(0);
    await expect(drawer.getByRole('combobox',{name:'发送模式'})).toHaveCount(0);
    const titleBox=await drawer.getByRole('heading',{name:'消息通知',exact:true}).boundingBox();
    const filterBox=await drawer.getByRole('group',{name:'通知分类'}).boundingBox(),projectFilterBox=await drawer.getByRole('combobox',{name:'筛选通知项目'}).boundingBox();
    expect(Math.abs(titleBox!.y+titleBox!.height/2-filterBox!.y-filterBox!.height/2)).toBeLessThan(2);
    expect(Math.abs(titleBox!.y+titleBox!.height/2-projectFilterBox!.y-projectFilterBox!.height/2)).toBeLessThan(2);
    await page.screenshot({path:testInfo.outputPath('notification-result-desktop.png')});
    await expect(noticeList.getByRole('button',{name:/^通知验证项目 · /})).toHaveCount(0);
    expect(inputs).toHaveLength(0);
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.notifications.length;}).toBe(0);
    await drawer.getByRole('button',{name:'关闭消息通知'}).click();
    const questionId=JSON.stringify(['request_user_input_async','notify-question',0]);
    const question={type:'AgentMessage',id:'notify-question',delivery:'async',questions:[{title:'需要继续兼容旧版接口吗？',options:['兼容旧版','只支持新版']}],content:[{type:'Text',text:'需要继续兼容旧版接口吗？'}]};
    appendFileSync(log,record('event_msg',{type:'task_started',turn_id:'question-turn'})+record('event_msg',{type:'item_completed',thread_id:native,turn_id:'question-turn',item:question}));
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.pending;}).toBe(1);
    await expect(toast.locator('[data-kind="question"] .notification-toast-dot')).toHaveCSS('background-color','rgb(217, 119, 6)');
    await page.getByRole('button',{name:/^消息通知/}).click();
    const listTitleBox=await drawer.getByRole('heading',{name:'消息通知',exact:true}).boundingBox(),listFilterBox=await drawer.getByRole('group',{name:'通知分类'}).boundingBox();
    expect(Math.abs(listTitleBox!.y+listTitleBox!.height/2-listFilterBox!.y-listFilterBox!.height/2)).toBeLessThan(2);
    await drawer.getByRole('region',{name:'通知列表'}).getByRole('button',{name:/^通知验证项目 · /}).click();
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
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.notifications.length;}).toBe(0);
    await expect(noticeList.getByRole('button',{name:/^通知验证项目 · /})).toHaveCount(0);
    await page.setViewportSize({width:1280,height:860});
    const replyDraft=drawer.getByRole('textbox',{name:'发送给当前 Agent 的消息'});
    await replyDraft.fill('配置已调整，请继续处理。');

    // The open conversation shows a permanent failure and marks it as read.
    // The reply stays in the same composer while the notification is cleared.
    active=false;
    send('turn/started',{threadId:native,turn:{id:'failed-turn',status:'inProgress'}});
    send('error',{threadId:native,turnId:'failed-turn',error:{message:'测试执行错误：请检查项目配置。'},willRetry:false});
    await expect(drawer.locator('.session-chat-error-notice')).toContainText('测试执行错误：请检查项目配置。');
    await expect(drawer.getByRole('button',{name:/新通知，点击显示/})).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath('notification-error-desktop.png')});
    const input=drawer.getByRole('textbox',{name:'发送给当前 Agent 的消息'});
    await expect(input).toHaveText('配置已调整，请继续处理。');
    const sendBox=await drawer.getByRole('button',{name:'发送消息',exact:true}).boundingBox();
    const attachBox=await drawer.getByRole('button',{name:'上传图片或文件',exact:true}).boundingBox();
    expect(Math.abs(sendBox!.y+sendBox!.height/2-attachBox!.y-attachBox!.height/2)).toBeLessThan(3);
    await drawer.getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(()=>inputs.length).toBe(2);expect(inputs[1].text).toBe('配置已调整，请继续处理。');
    await expect.poll(async()=>{const data=await(await page.request.get('/api/notifications')).json();return data.notifications.length;}).toBe(0);
    await expect(noticeList.getByRole('button',{name:/^通知验证项目 · /})).toHaveCount(0);
    await drawer.getByRole('button',{name:'打开标签页',exact:true}).click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByLabel('会话标签',{exact:true}).locator('[data-session-id="notification-work"]')).toHaveCount(1);
    const original=page.locator('.session-chat[data-session-id="notification-work"]').filter({visible:true});
    await expect(original).toBeVisible();await expect(original.locator('.session-chat-message-statistics').first()).toBeVisible();
    expect((await(await page.request.get('/api/sessions')).json()).sessions).toHaveLength(2);

    await page.getByRole('button',{name:'Projects',exact:true}).click();
    await expect(original).not.toBeVisible();
    await page.setViewportSize({width:320,height:780});
    await page.clock.install();
    appendFileSync(log,record('response_item',{type:'message',id:'popup-result',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'reply-turn-2'},content:[{type:'output_text',text:'普通完成结果只进铃铛。'}]})+record('event_msg',{type:'task_complete',turn_id:'reply-turn-2'}));
    active=false;send('turn/completed',{threadId:native,turn:{id:'reply-turn-2',status:'completed',completedAt:Date.now()/1000}});
    const bell=page.getByRole('button',{name:'消息通知，1 条未读',exact:true});
    await expect(bell).toBeVisible();
    await expect(toast.locator('[data-kind="result"]')).toHaveCount(0);
    await page.clock.fastForward(11_000);
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(drawer.getByRole('button',{name:'通知验证项目 · 兼容性修复'})).toBeVisible();
    await drawer.getByRole('button',{name:'关闭消息通知'}).click();
    await expect(drawer).not.toBeVisible();

    send('turn/started',{threadId:native,turn:{id:'toast-failure',status:'inProgress'}});
    send('error',{threadId:native,turnId:'toast-failure',error:{message:'验证右侧报错提醒。'},willRetry:false});
    const errorToast=toast.locator('button[data-kind="error"]');
    await expect(errorToast.locator('.notification-toast-dot')).toHaveCSS('background-color','rgb(220, 38, 38)');
    const toastLabel=errorToast.getByText('通知验证项目｜兼容性修复');
    await expect(toastLabel).toHaveCSS('white-space','nowrap');
    await expect(toastLabel).toHaveCSS('text-overflow','ellipsis');
    const toastBox=await toast.boundingBox();
    expect(toastBox!.height).toBeLessThan(40);
    expect(toastBox!.x+toastBox!.width).toBeLessThanOrEqual(320);
    await errorToast.click();
    await expect(original).toBeVisible();
    expect((await(await page.request.get('/api/sessions')).json()).sessions).toHaveLength(2);
  }finally{
    try {
      // Finish intercepted history reads while the fixture engine is still
      // available, before closing the browser's API request context.
      if(!page.isClosed())await page.unrouteAll({behavior:'wait'});
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

test('excludes child results from popups, the inbox and unread counts', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = await login.json();
  const directory = join(process.cwd(), '.test-data/e2e');
  const path = join(directory, 'notification-lineage');
  mkdirSync(path, { recursive: true });
  const { project } = await (await page.request.post('/api/projects', {
    data: { name: '子标签通知验证', path },
  })).json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: { projectTabs: [], activeTab: 'home' } } });

  const db = new Database(join(directory, 'agentmanager.db'));
  try {
    const addSession = db.prepare(`INSERT INTO sessions(id,project_id,task,status,mode,cli_type,native_session_id,created_by_user_id,parent_session_id)
      VALUES(?,?,?,'completed','session',?,?,?,?)`);
    const addNotification = db.prepare(`INSERT INTO notifications(user_id,session_id,native_id,source_id,kind,state,title,body,created_at,updated_at)
      VALUES(?,?,?,'fixture-final','result','info','完成','验证',datetime('now'),datetime('now'))`);
    for (const [id, name, agent, native, parent] of [
      ['notice-root', '通知主标签', 'codex', '019ff001-9181-7181-8181-111111111111', null],
      ['notice-child', '通知子标签', 'claude', '019ff001-9181-7181-8181-222222222222', 'notice-root'],
    ] as const) {
      addSession.run(id, project.id, name, agent, native, user.id, parent);
      addNotification.run(user.id, id, native);
    }
  } finally {
    db.close();
  }

  await page.goto('/');
  const toast = page.getByRole('complementary', { name: '新消息通知' });
  await expect(toast).toHaveCount(0);

  await page.getByRole('button', { name: '消息通知，1 条未读', exact: true }).click();
  const inbox = page.getByRole('dialog', { name: '消息通知' });
  await inbox.getByRole('button', { name: '全部', exact: true }).click();
  await expect(inbox.getByRole('button', { name: '子标签通知验证 · 通知主标签' })).toBeVisible();
  await expect(inbox.getByRole('button', { name: '子标签通知验证 · 通知子标签' })).toHaveCount(0);
});
