import {expect,test} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

test('creates, discovers, edits and selects the same Claude Provider in a new session',async({page},testInfo)=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{
  data:{username:'e2e-admin',password:'test-password'},
 })).ok()).toBeTruthy();
 const projectPath=join(process.cwd(),'.test-data/e2e/claude-provider-project');
 mkdirSync(projectPath,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{
  data:{name:'Claude Provider flow',path:projectPath},
 })).json();
 await page.route('**/api/agent-management/claude/providers',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const body=route.request().postDataJSON();
  return route.fulfill({json:{state:{
   agent:{id:'claude',label:'Claude'},
   providers:[{
    id:body.id,name:body.name,kind:'anthropic-compatible',enabled:true,managed:true,
    status:'ready',statusText:'可安全注入独立 SDK 会话',
    authentication:{status:'authenticated',method:'ANTHROPIC_AUTH_TOKEN（加密存储）'},
    models:body.fields.models,defaultModel:body.fields.defaultModel,
    fields:[
     {key:'baseUrl',label:'API 地址',type:'text',value:body.fields.baseUrl},
     {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
     {key:'models',label:'模型',type:'string-list',value:body.fields.models},
     {key:'defaultModel',label:'默认模型',type:'text',value:body.fields.defaultModel},
     {key:'contextWindow',label:'上下文窗口',type:'text',value:body.fields.contextWindow},
     {key:'maxOutputTokens',label:'最大输出 Token',type:'text',value:body.fields.maxOutputTokens},
    ],
   }],
  }}});
 });
 await page.route('**/api/agent-management/claude/detect-models',route=>route.fulfill({
  json:{models:[
   {model:'claude-fable-5',name:'Claude Fable 5',description:'由 Claude 兼容网关返回'},
   {model:'claude-fable-5-1',name:'Claude Fable 5.1',description:'由 Claude 兼容网关返回'},
  ]},
 }));
 await page.route('**/api/claude/environments',route=>route.fulfill({json:{
  current:'anthropic',
  environments:[
   {id:'anthropic',name:'Anthropic 原生',kind:'native',enabled:true,allowed_user_ids:null,can_control:true},
   {id:'claude-provider:xindu-real',name:'Xindu Real',kind:'provider',enabled:true,allowed_user_ids:null,provider:'xindu-real',auth_mode:'api',can_control:true},
  ],
 }}));
 await page.route('**/api/sessions',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const body=route.request().postDataJSON();
  return route.fulfill({json:{
   ok:true,
   session:{
    id:'claude-provider-flow',project_id:project.id,task:'',status:'pending',mode:'session',
    cli_type:'claude',agent_id:'claude',agent_environment_id:body.environment_id,
    native_session_id:'019ff001-2222-7222-8222-222222222222',
    pid:null,created_at:new Date().toISOString(),
   },
  }});
 });
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('/');
 await page.getByTitle('My account').click();
 await page.getByRole('button',{name:'Agent 配置'}).click();
 await page.locator('.agent-management-agents').getByRole('button',{name:/Claude/}).click();
 await page.getByRole('button',{name:'添加 Provider',exact:true}).click();
 const form=page.getByRole('form',{name:'Claude Provider 配置'});
 await form.getByLabel('Claude Provider ID').fill('xindu-real');
 await form.getByLabel('Claude Provider 名称').fill('Xindu Real');
 await form.getByLabel('Claude API 地址').fill('https://xindu.example');
 await form.getByLabel('Claude API Key').fill('fixture-secret');
 await form.getByLabel('Claude 上下文窗口').fill('200000');
 await form.getByLabel('Claude 最大输出 Token').fill('64000');
 await form.getByRole('button',{name:'探测模型目录'}).click();
 await expect(form.getByRole('checkbox',{name:'启用模型 claude-fable-5',exact:true})).toBeChecked();
 await expect(form.getByText('grok-4.5',{exact:true})).toHaveCount(0);
 await expect(form.getByText('opus',{exact:true})).toHaveCount(0);
 await form.getByLabel('Claude Provider 默认模型').selectOption('claude-fable-5-1');
 await form.getByRole('button',{name:'添加 Provider'}).click();
 await expect(page.getByRole('form',{name:'Claude Provider 配置'}).getByRole('heading',{name:'Xindu Real'})).toBeVisible();
 await testInfo.attach('claude-provider-form',{
  body:await page.screenshot({fullPage:true}),contentType:'image/png',
 });

 await page.request.put('/api/user-state/app',{data:{value:{
  projectTabs:[{projectId:project.id,projectName:project.name}],
  activeTab:`project-${project.id}`,
 }}});
 await page.goto('/');
 await page.getByRole('button',{name:'Projects'}).click();
 await page.getByRole('button',{name:'打开项目 Claude Provider flow'}).click();
 await page.locator('label.project-open-option').filter({hasText:'Claude'}).click();
 await expect(page.locator('input[name="project-open-mode"][value="claude"]')).toBeChecked();
 const providerSelect=page.getByRole('combobox',{name:'新会话 Claude Provider'});
 await expect(providerSelect).toHaveValue('anthropic');
 await providerSelect.selectOption('claude-provider:xindu-real');
 const created=page.waitForRequest(request=>
  new URL(request.url()).pathname==='/api/sessions'&&request.method()==='POST');
 await page.getByRole('button',{name:'新建会话'}).click();
 expect((await created).postDataJSON()).toMatchObject({
  cli_type:'claude',environment_id:'claude-provider:xindu-real',client_id:expect.stringMatching(/^[a-f0-9]{32}$/),
 });
});
