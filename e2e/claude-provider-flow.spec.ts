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
 let createdState:{agent:{id:string;label:string};providers:Array<{fields:Array<{key:string;value:unknown}>}>}|undefined;
 await page.route('**/api/agent-management/claude',route=>createdState?route.fulfill({json:{state:createdState}}):route.continue());
 await page.route('**/api/agent-management/claude/providers',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const body=route.request().postDataJSON();
  expect(JSON.parse(body.fields.modelCapabilities)).toMatchObject({'claude-fable-5-1':{context_window:500000,input_modalities:['text','image']}});
  const state={
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
     {key:'providerRateMultiplier',label:'Provider 计费倍率',type:'text',value:''},
    ],
   }],
  };
  createdState=state;
  return route.fulfill({json:{state}});
 });
 await page.route('**/api/agent-management/claude/providers/xindu-real',route=>{
  if(route.request().method()!=='PUT')return route.continue();
  const body=route.request().postDataJSON();
  const rate=body.fields.providerRateMultiplier;
  if(rate!==undefined){expect(body.fields).toEqual({providerRateMultiplier:'1.2'});createdState!.providers[0].fields.find(field=>field.key==='providerRateMultiplier')!.value=rate;}
  if(body.fields.modelCapabilities)JSON.parse(body.fields.modelCapabilities);
  return route.fulfill({json:{state:createdState}});
 });
 await page.route('**/api/agent-management/claude/detect-models',route=>route.fulfill({
  json:{models:[
   {model:'claude-fable-5',name:'Claude Fable 5',description:'由 Claude 兼容网关返回'},
   {model:'claude-fable-5-1',name:'Claude Fable 5.1',description:'由 Claude 兼容网关返回',context_window:500000,input_modalities:['text','image']},
  ]},
 }));
 await page.route('**/api/agent-management/claude/model-configs',route=>route.fulfill({json:{models:[{
  provider:'xindu-real',model:'claude-fable-5-1',name:'Claude Fable 5.1',release_date:'2026-09-01',official_context_window:1000000,contextWindow:500000,input_modalities:['text','image'],
  api_pricing:{currency:'USD',reference_only:true,provider_multiplier:1.2,source:'https://platform.claude.com/docs/en/about-claude/pricing',bands:[{rates:{input:8,cached:0.8,output:40}}]},
 }]}}));
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
 const providers=page.getByRole('table',{name:'Agent Provider'});
 await expect(providers).toBeVisible();
 await expect(providers.getByText('Codex',{exact:true}).first()).toBeVisible();
 await expect(providers.getByText('Claude',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'新增 Provider',exact:true}).click();
 const add=page.getByRole('dialog',{name:'新增 Provider'});
 await add.getByRole('combobox',{name:'Agent',exact:true}).selectOption('claude');
 const form=page.getByRole('form',{name:'Claude Provider 配置'});
 await form.getByLabel('Claude Provider ID').fill('xindu-real');
 await form.getByLabel('Claude Provider 名称').fill('Xindu Real');
 await form.getByLabel('Claude API 地址').fill('https://xindu.example');
 await form.getByLabel('Claude API Key').fill('fixture-secret');
 await expect(form.getByLabel('Claude 上下文窗口')).toBeHidden();
 await form.getByText('Claude Code 设置',{exact:true}).click();
 await form.getByLabel('Claude 上下文窗口').fill('200000');
 await form.getByLabel('Claude 最大输出 Token').fill('64000');
 await form.getByRole('button',{name:'探测模型'}).click();
 await expect(form.getByRole('checkbox',{name:'启用 claude-fable-5',exact:true})).toBeChecked();
 await expect(form.getByRole('row',{name:/claude-fable-5-1/})).toContainText('500,000');
 await expect(form.getByRole('row',{name:/claude-fable-5-1/}).getByRole('cell',{name:'支持',exact:true})).toBeVisible();
 await expect(form.getByText('grok-4.5',{exact:true})).toHaveCount(0);
 await expect(form.getByText('opus',{exact:true})).toHaveCount(0);
 await form.getByRole('checkbox',{name:'启用 claude-fable-5-1'}).check();
 await form.getByRole('button',{name:'添加 Provider'}).click();
 await expect(add).toHaveCount(0);
 const row=providers.getByRole('row').filter({hasText:'Xindu Real'});
 await expect(row).toContainText('—');
 await row.getByRole('button',{name:/展开Provider Xindu Real 的模型/}).click();
 const nested=page.getByRole('table',{name:'Provider 模型'});
 const capabilityRow=nested.getByRole('row',{name:/启用 claude-fable-5-1/});
 await expect(capabilityRow.getByRole('checkbox',{name:'启用 claude-fable-5-1'})).toBeChecked();
 await capabilityRow.getByRole('button',{name:'编辑',exact:true}).click();
 await capabilityRow.getByRole('spinbutton',{name:'claude-fable-5-1 上下文长度'}).fill('500001');
 await capabilityRow.getByRole('button',{name:'保存并重启'}).click();
 await expect(capabilityRow.getByRole('button',{name:'保存并重启'})).toBeDisabled();
 await capabilityRow.getByRole('button',{name:'取消',exact:true}).click();
 await row.getByRole('button',{name:/编辑 Xindu Real/}).click();
 const edit=page.getByRole('dialog',{name:'编辑 Provider · Xindu Real'});
 await expect(edit.getByLabel('Claude API 地址')).toHaveValue('https://xindu.example');
 await edit.getByText('Claude Code 设置',{exact:true}).click();
 const rate=edit.getByRole('textbox',{name:'Provider 计费倍率'});
 await rate.fill('1.2');
 const profileSaveResponse=page.waitForResponse(response=>
  new URL(response.url()).pathname==='/api/agent-management/claude/providers/xindu-real'
  &&response.request().method()==='PUT'&&response.ok());
 await edit.getByRole('button',{name:'保存 Provider'}).click();
 await profileSaveResponse;
 await expect(edit).toHaveCount(0);
 await expect(row).toContainText('1.2×');
 await row.getByRole('button',{name:/编辑 Xindu Real/}).click();
 const reopened=page.getByRole('dialog',{name:'编辑 Provider · Xindu Real'});
 const modelRow=reopened.getByRole('table',{name:'Provider 模型'}).getByRole('row').filter({hasText:'claude-fable-5-1'});
 await expect(modelRow).toContainText('2026-09-01');
 await expect(modelRow).toContainText('1,000,000');
 await expect(modelRow).toContainText('500,000');
 await expect(modelRow.getByRole('cell',{name:'支持',exact:true})).toBeVisible();
 await reopened.getByRole('button',{name:'关闭编辑 Provider · Xindu Real'}).click();
 await expect(row.getByRole('button',{name:/编辑 Xindu Real/})).toBeFocused();
 await page.setViewportSize({width:390,height:844});
 await row.getByRole('button',{name:/编辑 Xindu Real/}).click();
 const narrow=await edit.boundingBox();
 expect(narrow?.x).toBeGreaterThan(0);
 expect(narrow!.x+narrow!.width).toBeLessThan(390);
 await expect(edit.getByRole('button',{name:'保存 Provider'})).toBeDisabled();
 await edit.getByRole('button',{name:'关闭编辑 Provider · Xindu Real'}).click();
 await page.setViewportSize({width:1440,height:1000});
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
