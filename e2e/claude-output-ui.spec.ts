import {expect,test} from '@playwright/test';

test('renders Claude thinking and tool output in the transcript',async({page},testInfo)=>{
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
  await expect(page.getByText('Thought').last()).toBeVisible();
  await expect(page.getByText('Read',{exact:true}).last()).toBeVisible();
  await expect(page.getByText('README.md',{exact:true}).last()).toBeVisible();
  await expect(page.getByText('Inspection complete.',{exact:true}).last()).toBeVisible();
  await expect(page.locator('.claudian-response-footer')).toHaveCount(1);
  await expect(page.getByText(/150 tokens · 80 cached/)).toBeVisible();
  await page.getByRole('combobox',{name:'选择模型'}).hover();
  await expect(page.getByRole('tooltip')).toContainText('200,000 tokens');
  await expect(page.getByRole('tooltip')).toContainText('64,000 tokens');
  await expect(page.getByRole('tooltip')).toContainText('text、image');
  await expect(page.getByText('progress',{exact:true})).toHaveCount(0);
  await expect(page.getByText('final',{exact:true})).toHaveCount(0);
  await expect(page.getByText('# Project')).not.toBeVisible();
  await expect(page.getByText('I should read the README before changing anything.')).not.toBeVisible();
  await page.getByText('Thought').last().click();
  await expect(page.getByText('I should read the README before changing anything.')).toBeVisible();
  await page.getByText('Read',{exact:true}).last().click();
  await expect(page.getByText('# Project')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('claude-output.png'),fullPage:true});
});
