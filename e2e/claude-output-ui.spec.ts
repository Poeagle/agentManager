import {expect,test} from '@playwright/test';

test('renders Claude streaming thinking and tool output in the transcript',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{
    data:{username:'e2e-admin',password:'test-password'},
  })).ok()).toBeTruthy();
  const projectPath=`${process.cwd()}/.test-data/e2e/claude-output-ui`;
  const {mkdirSync}=await import('node:fs');
  mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{
    data:{name:'Claude output UI',path:projectPath},
  })).json();
  const session={
    id:'claude-output-ui',project_id:project.id,task:'',status:'running',mode:'session',
    cli_type:'claude',agent_id:'claude',native_session_id:'019ff001-7777-7777-8777-777777777777',
    agent_environment_id:'claude-provider:anthropic',pid:null,created_at:new Date().toISOString(),
  };
  let socket:import('@playwright/test').WebSocketRoute|null=null,push:any;
  await page.routeWebSocket('**/conversation/stream*',route=>{
    socket=route;
    push=value=>route.send(JSON.stringify(value));
    push({type:'snapshot',messages:[],busy:true,turn_id:'turn',started_at:new Date().toISOString(),stage:'answering',activities:[]});
  });
  await page.route('**/api/sessions**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/sessions'&&route.request().method()==='GET')return route.fulfill({json:{sessions:[session]}});
    if(url.pathname===`/api/sessions/${session.id}`&&route.request().method()==='GET')return route.fulfill({json:{session}});
    return route.continue();
  });
  await page.route('**/api/sessions/claude-output-ui/conversation**',route=>route.fulfill({json:{
    messages:[
      {id:'u',role:'user',text:'Inspect the project',timestamp:new Date().toISOString()},
      {id:'a',role:'assistant',text:'Inspection complete.',timestamp:new Date().toISOString(),
       turn_id:'turn',phase:'final',content_blocks:[
        {type:'thinking',index:0,text:'I should read the README before changing anything.'},
        {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'README.md'},status:'completed',result:'# Project'},
        {type:'text',index:2,text:'Inspection complete.'},
       ]},
    ],
    statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:session.native_session_id,session_active:true,session_status:'running',
    runtime:{state:'idle'},interaction:null,
  }}));
  await page.route('**/api/sessions/claude-output-ui/controls**',route=>route.fulfill({json:{
    supports_fresh_model:true,model:'claude-fable-5',effort:'',provider:'anthropic',cwd:projectPath,
    state:'idle',permission:'bypassPermissions',usage:{total:{total_tokens:150,input_tokens:120,cached_input_tokens:80,output_tokens:30},last:{total_tokens:150,input_tokens:120,cached_input_tokens:80,output_tokens:30},window:200000},limits:[],
    models:[{model:'claude-fable-5',name:'claude-fable-5',description:'Anthropic · Provider 模型',context_window:200000,max_output_tokens:64000,input_modalities:['text','image'],efforts:[{value:'',description:'由原生客户端决定'}],defaultEffort:''}],loaded:true,
    native_id:session.native_session_id,checked_at:new Date().toISOString(),can_edit:true,
  }}));
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{
    projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`,
  }}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{
    terminalInstances:[{id:session.id,label:'Claude output'}],activeTerminalId:session.id,
    explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.setViewportSize({width:1100,height:900});
  await page.goto('/');
  await expect(page.getByText('Event stream connected')).toBeVisible();
  expect(socket).not.toBeNull();
  const stamp=new Date().toISOString();
  push({type:'snapshot',messages:[
    {id:'u',role:'user',text:'Inspect the project',timestamp:stamp},
    {id:'live-thinking',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
      {type:'thinking',index:0,text:'I am checking the current files.'},
    ]},
    {id:'live-tool',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
      {type:'tool_use',index:0,id:'tool-live',name:'Read',input:{file_path:'README.md'},status:'running',result:''},
    ]},
  ],activities:[],busy:true,turn_id:'turn',started_at:stamp,stage:'tools'});
  const live=page.getByLabel('Claude 进展').last();
  await expect(live.getByText('Claude 正在思考')).toBeVisible();
  await expect(live.getByText('I am checking the current files.')).toBeVisible();
  await expect(live.locator('.session-chat-thinking-caret')).toBeVisible();
  await expect(live.getByText('Read',{exact:true})).toBeVisible();
  push({type:'snapshot',messages:[
    {id:'u',role:'user',text:'Inspect the project',timestamp:new Date(Date.now()-5000).toISOString()},
    {id:'a',role:'assistant',text:'Inspection complete.',timestamp:new Date().toISOString(),
     turn_id:'turn',phase:'final',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:30,total_tokens:150},content_blocks:[
      {type:'thinking',index:0,text:'I should read the README before changing anything.'},
      {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'README.md'},status:'completed',result:'# Project'},
      {type:'text',index:2,text:'Inspection complete.'},
     ]},
  ],busy:false,turn_id:'turn',completed_at:new Date().toISOString(),stage:'idle'});
  await expect(page.getByText('Ready for your next message')).toBeVisible();
  await expect(page.getByRole('button',{name:'停止当前执行'})).toHaveCount(0);
  await expect(page.getByText(/esc to interrupt/)).toHaveCount(0);
  const final=page.locator('.session-chat-message.assistant[data-phase="final"]');
  await expect(final.getByText('Claude 的思考过程')).toBeAttached();
  await expect(page.getByText('Claude 正在思考')).toHaveCount(0);
  await expect(page.locator('.session-chat-tool summary').last()).toContainText('Read');
  await expect(page.getByText('final',{exact:true})).toBeVisible();
  await expect(page.locator('.session-chat-tool-compact')).toHaveCount(0);
  await expect(page.locator('.session-chat-message[data-phase="final"] .session-chat-tool summary').last()).toContainText('Read完成');
  await expect(page.getByText('Inspection complete.',{exact:true}).last()).toBeVisible();
  await expect(page.locator('.claudian-message')).toHaveCount(0);
  await expect(final).toBeVisible();
  await expect(page.getByText('final',{exact:true})).toBeVisible();
  await expect(page.getByText('# Project')).not.toBeVisible();
  await expect(page.getByText('I should read the README before changing anything.')).not.toBeVisible();
  await final.getByText('Claude 的思考过程').click();
  await expect(page.getByText('I should read the README before changing anything.')).toBeVisible();
  await final.locator('.session-chat-tool summary').click();
  await expect(page.getByText('# Project')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('claude-output.png'),fullPage:true});
});

test('collapses Claude progress across native records and shows its recorded usage',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{
    data:{username:'e2e-admin',password:'test-password'},
  })).ok()).toBeTruthy();
  const projectPath=`${process.cwd()}/.test-data/e2e/claude-progress-statistics`;
  const {mkdirSync}=await import('node:fs');
  mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{
    data:{name:'Claude progress statistics',path:projectPath},
  })).json();
  const session={
    id:'claude-progress-statistics',project_id:project.id,task:'',status:'running',mode:'session',
    cli_type:'claude',agent_id:'claude',native_session_id:'019ff001-8888-8888-8888-888888888888',
    agent_environment_id:'claude-provider:anthropic',pid:null,created_at:new Date().toISOString(),
  };
  let socket:import('@playwright/test').WebSocketRoute|null=null,push:any;
  await page.routeWebSocket('**/conversation/stream*',route=>{
    socket=route;push=value=>route.send(JSON.stringify(value));
    push({type:'snapshot',messages:[],busy:true,turn_id:'turn',started_at:new Date().toISOString(),stage:'answering',activities:[]});
  });
  await page.route('**/api/sessions**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/sessions'&&route.request().method()==='GET')return route.fulfill({json:{sessions:[session]}});
    if(url.pathname===`/api/sessions/${session.id}`&&route.request().method()==='GET')return route.fulfill({json:{session}});
    return route.continue();
  });
  const messages=[
    {id:'user',role:'user',text:'Run the full check',timestamp:'2026-11-19T23:45:45.000Z'},
    {id:'read',role:'assistant',turn_id:'record-read',phase:'commentary',text:'Read the implementation.',timestamp:'2026-11-19T23:45:46.000Z',
     content_blocks:[{type:'tool_use',index:0,id:'tool-read',name:'Read',input:{file_path:'README.md'},status:'completed',result:'# Project'}]},
    {id:'test',role:'assistant',turn_id:'record-test',phase:'commentary',text:'Run the tests.',timestamp:'2026-11-19T23:45:47.000Z',
     content_blocks:[{type:'tool_use',index:0,id:'tool-test',name:'Bash',input:{command:'npm test'},status:'completed',result:'passed'}]},
    {id:'build',role:'assistant',turn_id:'record-build',phase:'commentary',text:'Build the dashboard.',timestamp:'2026-11-19T23:45:48.000Z'},
  ];
  const statistics=[
    {sequence:2,message_id:'read',turn_id:'user-record',tokens:{total_tokens:12000,input_tokens:10000,cached_input_tokens:8000,output_tokens:2000},requests:1,tool_calls:1,tool_rounds:1,complete:true},
    {sequence:3,message_id:'test',turn_id:'user-record',tokens:{total_tokens:30000,input_tokens:26000,cached_input_tokens:20000,output_tokens:4000},requests:2,tool_calls:3,tool_rounds:2,complete:true},
    {sequence:4,message_id:'build',turn_id:'user-record',tokens:{total_tokens:48000,input_tokens:40000,cached_input_tokens:32000,output_tokens:8000},requests:3,tool_calls:4,tool_rounds:3,complete:true},
  ];
  await page.route('**/api/sessions/claude-progress-statistics/conversation**',route=>route.fulfill({json:{
    messages,statistics,has_more:false,reset:false,available:true,generation:'g',
    native_id:session.native_session_id,session_active:true,session_status:'running',
    runtime:{state:'idle'},interaction:null,
  }}));
  await page.route('**/api/sessions/claude-progress-statistics/controls**',route=>route.fulfill({json:{
    supports_fresh_model:true,model:'claude-fable-5',effort:'',provider:'anthropic',cwd:projectPath,
    state:'idle',permission:'bypassPermissions',usage:{total:{total_tokens:150,input_tokens:120,cached_input_tokens:80,output_tokens:30},last:{total_tokens:150,input_tokens:120,cached_input_tokens:80,output_tokens:30},window:200000},limits:[],
    models:[{model:'claude-fable-5',name:'claude-fable-5',description:'Anthropic · Provider 模型',context_window:200000,max_output_tokens:64000,input_modalities:['text','image'],efforts:[{value:'',description:'由原生客户端决定'}],defaultEffort:''}],loaded:true,
    native_id:session.native_session_id,checked_at:new Date().toISOString(),can_edit:true,
  }}));
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{
    projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`,
  }}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{
    terminalInstances:[{id:session.id,label:'Claude progress'}],activeTerminalId:session.id,
    explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.setViewportSize({width:1100,height:900});
  await page.goto('/');
  await expect(page.getByText('Event stream connected')).toBeVisible();
  expect(socket).not.toBeNull();
  push({type:'snapshot',messages:[...messages,{id:'final',role:'assistant',turn_id:'record-final',phase:'final',text:'Everything passed.',timestamp:'2026-11-19T23:45:50.000Z'}],statistics,busy:false,turn_id:'turn',completed_at:new Date().toISOString(),stage:'idle'});
  const progressView=page.getByLabel('Claude 进展').last();
  const summary=progressView.locator(':scope > details > summary');
  await summary.click();
  await expect(progressView.getByText('Read',{exact:true})).toBeVisible();
  await expect(progressView.getByText('Bash',{exact:true})).toBeVisible();
  await expect(progressView).toContainText('Build the dashboard.');
  await expect(summary).toContainText('3 items');
  await expect(summary).toContainText('48K');
  await expect(summary).toContainText('3 rounds | 4 calls');
  await expect(summary).not.toContainText('— rounds | — calls');
  await expect(page.getByText('Everything passed.',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('claude-progress-statistics.png'),fullPage:true});
});

test('refreshes one live Claude thinking row across request items',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{
    data:{username:'e2e-admin',password:'test-password'},
  })).ok()).toBeTruthy();
  const projectPath=`${process.cwd()}/.test-data/e2e/claude-thinking-live-row`;
  const {mkdirSync}=await import('node:fs');
  mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{
    data:{name:'Claude live thinking',path:projectPath},
  })).json();
  const session={
    id:'claude-thinking-live-row',project_id:project.id,task:'',status:'running',mode:'session',
    cli_type:'claude',agent_id:'claude',native_session_id:'019ff001-9999-9999-8999-999999999999',
    agent_environment_id:'claude-provider:anthropic',pid:null,created_at:new Date().toISOString(),
  };
  let push:((value:unknown)=>void)|null=null;
  await page.routeWebSocket('**/conversation/stream*',route=>{
    push=value=>route.send(JSON.stringify(value));
    route.send(JSON.stringify({type:'snapshot',messages:[],busy:true,turn_id:'turn',started_at:new Date().toISOString(),stage:'tools',activities:[]}));
  });
  await page.route('**/api/sessions**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/sessions'&&route.request().method()==='GET')return route.fulfill({json:{sessions:[session]}});
    if(url.pathname===`/api/sessions/${session.id}`&&route.request().method()==='GET')return route.fulfill({json:{session}});
    return route.continue();
  });
  await page.route('**/api/sessions/claude-thinking-live-row/conversation**',route=>route.fulfill({json:{
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:session.native_session_id,session_active:true,session_status:'running',
    runtime:{state:'running'},interaction:null,
  }}));
  await page.route('**/api/sessions/claude-thinking-live-row/controls**',route=>route.fulfill({json:{
    supports_fresh_model:true,model:'claude-fable-5',effort:'',provider:'anthropic',cwd:projectPath,
    state:'running',permission:'bypassPermissions',usage:null,limits:[],
    models:[{model:'claude-fable-5',name:'claude-fable-5',description:'Anthropic · Provider 模型',context_window:200000,max_output_tokens:64000,input_modalities:['text','image'],efforts:[{value:'',description:'由原生客户端决定'}],defaultEffort:''}],loaded:true,
    native_id:session.native_session_id,checked_at:new Date().toISOString(),can_edit:true,
  }}));
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{
    projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`,
  }}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{
    terminalInstances:[{id:session.id,label:'Claude thinking'}],activeTerminalId:session.id,
    explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.setViewportSize({width:1100,height:900});
  await page.goto('/');
  await expect(page.getByText('Event stream connected')).toBeVisible();
  expect(push).not.toBeNull();
  const stamp=new Date(Date.now()-5000).toISOString();
  const rounds=(items:Array<[thinking:string,id:string]>)=>[
    {id:'user',role:'user',text:'Inspect the project',timestamp:stamp},
    ...items.map(([thinking,id])=>({
      id:`round-${id}`,role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,
      content_blocks:[
        {type:'thinking',index:0,text:thinking},
        {type:'tool_use',index:1,id,name:'Read',input:{file_path:`/p/${id}`},status:'completed',result:'ok'},
      ],
    })),
  ];
  push!({type:'snapshot',messages:rounds([
    ['Reading the first files.','one'],
    ['Checking the next files.','two'],
    ['Running the final checks.','three'],
  ]),activities:[],busy:true,turn_id:'turn',started_at:stamp,stage:'tools'});
  const progress=page.getByLabel('Claude 进展').last();
  await expect(progress.getByText('Claude 正在思考')).toHaveCount(1);
  await expect(progress.getByText('Reading the first files.')).toHaveCount(0);
  await expect(progress.getByText('Checking the next files.')).toHaveCount(0);
  await expect(progress.getByText('Running the final checks.')).toHaveCount(1);
  await expect(progress.getByText('Running the final checks.')).toBeVisible();
  await expect(progress.locator('.session-chat-thinking-caret')).toBeVisible();
  await expect(progress.getByText('Read',{exact:true})).toHaveCount(3);
  push!({type:'snapshot',messages:rounds([
    ['Reading the first files.','one'],
    ['Checking the next files.','two'],
    ['Running the final checks.','three'],
    ['Waiting for the build result.','four'],
  ]),activities:[],busy:true,turn_id:'turn',started_at:stamp,stage:'tools'});
  await expect(progress.getByText('Claude 正在思考')).toHaveCount(1);
  await expect(progress.getByText('Running the final checks.')).toHaveCount(0);
  await expect(progress.getByText('Waiting for the build result.')).toBeVisible();
  await expect(progress.locator('.session-chat-thinking-block')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('claude-thinking-live-row.png'),fullPage:true});
});

test('does not show empty numbers for Claude thinking-only request items',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{
    data:{username:'e2e-admin',password:'test-password'},
  })).ok()).toBeTruthy();
  const projectPath=`${process.cwd()}/.test-data/e2e/claude-thinking-compact-items`;
  const {mkdirSync}=await import('node:fs');
  mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{
    data:{name:'Claude compact thinking items',path:projectPath},
  })).json();
  const session={
    id:'claude-thinking-compact-items',project_id:project.id,task:'',status:'running',mode:'session',
    cli_type:'claude',agent_id:'claude',native_session_id:'019ff001-aaaa-aaaa-8aaa-aaaaaaaaaaaa',
    agent_environment_id:'claude-provider:anthropic',pid:null,created_at:new Date().toISOString(),
  };
  let push:((value:unknown)=>void)|null=null;
  await page.routeWebSocket('**/conversation/stream*',route=>{
    push=value=>route.send(JSON.stringify(value));
    route.send(JSON.stringify({type:'snapshot',messages:[],busy:true,turn_id:'turn',started_at:new Date().toISOString(),stage:'tools',activities:[]}));
  });
  await page.route('**/api/sessions**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/sessions'&&route.request().method()==='GET')return route.fulfill({json:{sessions:[session]}});
    if(url.pathname===`/api/sessions/${session.id}`&&route.request().method()==='GET')return route.fulfill({json:{session}});
    return route.continue();
  });
  await page.route('**/api/sessions/claude-thinking-compact-items/conversation**',route=>route.fulfill({json:{
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:session.native_session_id,session_active:true,session_status:'running',runtime:{state:'running'},interaction:null,
  }}));
  await page.route('**/api/sessions/claude-thinking-compact-items/controls**',route=>route.fulfill({json:{
    supports_fresh_model:true,model:'claude-fable-5',effort:'',provider:'anthropic',cwd:projectPath,state:'running',permission:'bypassPermissions',
    usage:null,limits:[],models:[],loaded:true,native_id:session.native_session_id,checked_at:new Date().toISOString(),can_edit:true,
  }}));
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{
    terminalInstances:[{id:session.id,label:'Claude compact thinking'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.setViewportSize({width:1100,height:900});
  await page.goto('/');
  await expect(page.getByText('Event stream connected')).toBeVisible();
  const stamp=new Date(Date.now()-5000).toISOString();
  const message=(id:string,content_blocks:unknown[])=>({id,role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks});
  push!({type:'snapshot',busy:true,turn_id:'turn',started_at:stamp,stage:'tools',activities:[],messages:[
    {id:'user',role:'user',text:'Inspect the project',timestamp:stamp},
    message('thought-one',[{type:'thinking',index:0,text:'Private reasoning one.'}]),
    {id:'commentary',role:'assistant',turn_id:'turn',phase:'commentary',text:'I found the relevant files.',timestamp:stamp},
    message('thought-two',[{type:'thinking',index:0,text:'Private reasoning two.'}]),
    message('tool',[{type:'tool_use',index:0,id:'read',name:'Read',input:{file_path:'README.md'},status:'completed',result:'README'}]),
  ]});
  const progress=page.getByLabel('Claude 进展').last();
  await expect(progress.locator('.session-chat-progress-entry:not(.session-chat-progress-pending)')).toHaveCount(2);
  await expect(progress.locator('.session-chat-progress-entry:not(.session-chat-progress-pending) .session-chat-progress-number')).toHaveText(['1','2']);
  await expect(progress.getByText('Private reasoning two.')).toBeVisible();
  await expect(progress.locator(':scope > details > summary')).toContainText('5 items');
  await page.screenshot({path:testInfo.outputPath('claude-thinking-compact-items.png'),fullPage:true});
});
