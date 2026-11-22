import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,request as playwrightRequest} from '@playwright/test';
test.beforeEach(async({page})=>{
 await page.route('**/api/codex/environments/*/quota',route=>route.fulfill({json:{quota:null,reason:'fixture'}}));
 await page.route('**/api/codex/environments/*/config-files*',route=>{const url=new URL(route.request().url());if(route.request().method()==='PUT'){const body=route.request().postDataJSON();return route.fulfill({json:{content:body.content,revision:'updated',exists:true}});}return route.fulfill({json:url.searchParams.has('file')?{content:'model = "fixture"',revision:'fixture',exists:true}:{files:[{id:'config',label:'Codex 配置',description:'模型配置',format:'TOML',path:'/fixture/.codex/config.toml',exists:true},{id:'credentials',label:'Codex 凭据文件',description:'仅显示文件状态',format:'JSON',path:'/fixture/.codex/auth.json',exists:true,sensitive:true}]}});});
});
const accountDetails=(id:string)=>({id,checked_at:'2026-11-09T00:00:00Z',executable:'/fixture/bin/codex',version:'codex-cli 0.fixture',home:'/fixture/.codex',engine:{state:'connected',pid:123},authentication:{status:'authenticated',type:'chatgpt',email:'fixture@example.invalid',plan:'fixture-plan'},config:{path:'/fixture/.codex/config.toml',exists:true,notice:null},settings:{model:'fixture-model',model_provider:'openai',model_reasoning_effort:'high'},models:[{model:'fixture-model',name:'Fixture model',description:'Selected user model',defaultEffort:'high'}]});

test('keeps Provider multiplier read-only in the row and edits it in the Provider dialog',async({page})=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
 const agents=['codex','claude'].map((id,index)=>{
  const agent={id,label:index?'Claude':'Codex',presentation:{icon:id,color:'#60a5fa'},capabilities:{}};
  const provider={id:'gateway',name:`${agent.label} Gateway`,kind:'compatible',managed:true,enabled:true,status:'ready',statusText:'Fixture ready',models:['model-a','model-b'],defaultModel:'model-a',fields:[
   {key:'baseUrl',label:'Responses API 地址',type:'text',value:'https://gateway.example/v1'},
   {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
   {key:'codexHome',label:'独立 CODEX_HOME',type:'text',value:'/fixture/codex'},
   {key:'command',label:'启动命令',type:'text',value:'codex'},
   {key:'launchArgs',label:'附加启动参数',type:'string-list',value:[]},
   {key:'models',label:'模型',type:'string-list',value:['model-a','model-b']},
   {key:'defaultModel',label:'默认模型',type:'text',value:'model-a'},
   {key:'providerRateMultiplier',label:'Provider 计费倍率',type:'text',value:'',description:'按官方参考价估算'},
  ],authentication:{status:'authenticated',method:'加密 API Key'},configFiles:[],codexHome:'/fixture/codex',launchCommand:'codex app-server',launchArgs:[],pid:null};
  return {agent,state:{agent,providers:[provider],defaults:[],providerManagement:{create:true}}};
 });
 const updates:unknown[]=[];
 await page.route('**/api/agent-management**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/agent-management')return route.fulfill({json:{agents:agents.map(({agent,state})=>({agent,state}))}});
  const agentEntry=agents.find(item=>path.startsWith(`/api/agent-management/${item.agent.id}`))!;
  let {state}=agentEntry;
  const provider=state.providers[0];
  if(path.endsWith('/detect-models'))return route.fulfill({json:{models:provider.models.map(model=>({model,name:model,description:''}))}});
  if(path.endsWith('/model-configs'))return route.fulfill({json:{models:[]}});
  if(route.request().method()==='PUT'&&path.endsWith('/update-stream')){
   const {fields}=route.request().postDataJSON();
   updates.push({agent:state.agent.id,fields});
   for(const field of provider.fields)if(field.key in fields)field.value=fields[field.key];
   return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'complete',provider})+"\n"});
  }
  if(route.request().method()==='PUT'){
   const {fields}=route.request().postDataJSON();
   updates.push({agent:state.agent.id,fields});
   expect(fields.providerRateMultiplier).toBe('1.2');
   if(fields.providerRateMultiplier==='0')return route.fulfill({status:400,json:{error:'Provider 计费倍率必须为正数'}});
   for(const field of provider.fields)if(field.key in fields)field.value=fields[field.key];
   provider.models=fields.models;
   provider.defaultModel=fields.defaultModel;
   state={...state,providers:[provider]};
   agentEntry.state=state;
   return route.fulfill({json:{provider,state}});
  }
  return route.fulfill({json:{provider}});
 });
 await page.route('**/api/codex/environments**',route=>route.fulfill({json:{environments:[],users:[]}}));
 await page.route('**/api/codex/environments/*/usage',route=>route.fulfill({json:{tabs:[],busy:false,verified:true}}));
 const open=async()=>{
  await page.goto('/');
  await page.getByTitle('My account').click();
  await page.getByRole('button',{name:'Agent 配置'}).click();
 };
 await page.setViewportSize({width:560,height:850});
 await open();
 const region=page.getByRole('region',{name:/Agent Provider，/});
 await expect.poll(()=>region.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
 for(const {agent} of agents){
  const row=region.getByRole('row').filter({hasText:`${agent.label} Gateway`});
  await expect(row.getByRole('combobox',{name:/默认模型/})).toHaveCount(0);
  await expect(row.getByRole('textbox',{name:/计费倍率/})).toHaveCount(0);
  await row.getByRole('button',{name:`编辑 ${agent.label} Gateway · ${agent.label}`}).click();
  const dialog=page.getByRole('dialog',{name:`编辑 Provider · ${agent.label} Gateway`});
  await expect(dialog.getByRole('textbox',{name:/API 地址/})).toHaveValue('https://gateway.example/v1');
  const settings=dialog.locator('summary').filter({hasText:/设置/});
  if(!(await settings.getAttribute('open'))&&!await settings.evaluate(element=>(element.parentElement as HTMLDetailsElement).open))await settings.click();
  const rate=dialog.getByRole('textbox',{name:'Provider 计费倍率'});
  await rate.fill('1.2');
  await dialog.getByRole('button',{name:/保存/}).click();
  await expect(rate).toHaveValue('1.2');
  await expect.poll(()=>updates.some(item=>JSON.stringify(item).includes('"agent":"'+agent.id+'"'))).toBe(true);
  await expect(region.getByRole('row').filter({hasText:`${agent.label} Gateway`}).first()).toContainText('1.2×');
  if(await dialog.count())await dialog.getByRole('button',{name:/关闭编辑 Provider/}).click();
  await expect(page.getByRole('dialog',{name:/编辑 Provider/})).toHaveCount(0);
 }
 expect(updates.length).toBeGreaterThanOrEqual(2);
});


test('configures a private same-machine account and enforces visibility in browser and API',async({page},testInfo)=>{
 const status=await (await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const authenticated=await (await page.request.get('/api/auth/status')).json(),owner=authenticated.user;
 const descriptor={id:'codex',label:'Codex',presentation:{icon:'codex',color:'#60a5fa'},capabilities:{}};
 const state={agent:descriptor,installation:{status:'ready',executable:'/fixture/codex',version:'0.test',latestVersion:null,updateAvailable:false,installCommand:'',updateCommand:''},authentication:{status:'authenticated',method:'fixture'},defaults:[],providers:[],configFiles:[],diagnostics:[],actions:[],providerManagement:{create:true,update:true,delete:true,actions:[],fields:[]},applySemantics:{settings:'new_session',providers:'immediate',detail:'fixture'},checkedAt:new Date().toISOString()};
 await page.route('**/api/agent-management**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/agent-management'?{agents:[{agent:descriptor,state}]}:{state}}));
 // Connection stages are simulated; never use a real user's SSH or login.
 await page.route('**/api/codex/environments/check-connection',route=>route.fulfill({json:{ok:false,checks:[{stage:'codex_authentication',ok:false,message:'该系统用户尚未登录 Codex，请先以该用户运行 codex login'}]}}));
 await page.route('**/api/codex/environments/*/details',route=>route.fulfill({json:{details:accountDetails(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!))}}));
 await page.setViewportSize({width:1500,height:1100});await page.goto('/');await page.getByTitle('My account').click();await page.getByRole('button',{name:'Agent 配置'}).click();
 await page.getByRole('button',{name:'新增 Provider',exact:true}).click();await page.getByRole('combobox',{name:'Provider 接入类型'}).selectOption('account');const dialog=page.getByRole('dialog',{name:'新增 Provider'});
 await dialog.getByRole('textbox',{name:'账号 Provider 名称',exact:true}).fill('ymchen private fixture');await dialog.getByRole('textbox',{name:'系统用户名',exact:true}).fill('fixture_user');
 await expect(dialog.getByRole('button',{name:'保存账号 Provider'})).toBeDisabled();await dialog.getByRole('combobox',{name:'SSH 认证方式'}).selectOption('key');
 await dialog.getByRole('textbox',{name:'Codex 命令',exact:true}).fill('codex --dangerously-bypass-approvals-and-sandbox');await expect(dialog.getByRole('alert')).toContainText('例如填写 codex');await expect(dialog.getByRole('button',{name:'预检连接、已有登录、模型与项目'})).toBeDisabled();await dialog.getByRole('textbox',{name:'Codex 命令',exact:true}).fill('codex');
 await dialog.getByRole('button',{name:'预检连接、已有登录、模型与项目'}).click();await expect(dialog.getByRole('alert')).toContainText('codex login');
 await page.screenshot({path:testInfo.outputPath('missing-login-preflight.png'),fullPage:true});
 await dialog.getByRole('button',{name:'保存账号 Provider'}).click();await expect(dialog).toHaveCount(0);await page.getByRole('button',{name:/编辑 ymchen private fixture/}).click();const edit=page.getByRole('dialog',{name:'编辑 Provider · ymchen private fixture'});await edit.getByRole('button',{name:'账号详情'}).click();await expect(page.getByText('1 个 Provider',{exact:true})).toBeVisible();await expect(edit.getByText('fixture@example.invalid')).toBeVisible();await expect(edit.getByText('Fixture model')).toBeVisible();await expect(edit.getByRole('textbox',{name:'Codex 命令'})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('saved-account-details.png'),fullPage:true});
 await edit.getByRole('button',{name:/Codex 配置/}).click();const fileDialog=page.getByRole('dialog',{name:'Codex 配置'});await fileDialog.getByRole('textbox',{name:'Codex 配置 内容'}).fill('model = "updated"');await fileDialog.getByRole('button',{name:'保存文件'}).click();await expect(fileDialog.getByRole('status')).toHaveText('已保存');await fileDialog.getByRole('button',{name:'关闭Codex 配置'}).click();await edit.getByRole('button',{name:/Codex 凭据文件/}).click();const credential=page.getByRole('dialog',{name:'Codex 凭据文件'});await expect(credential).toContainText('凭据内容受保护');await expect(credential.locator('textarea')).toHaveCount(0);await credential.getByRole('button',{name:'关闭Codex 凭据文件'}).click();
 const visible=await (await page.request.get('/api/codex/environments')).json();const account=visible.environments.find((e:any)=>e.name==='ymchen private fixture');expect(account).toBeTruthy();expect(account.connection).toBeUndefined();
 const username='environment-member';expect((await page.request.post('/api/users',{data:{username,password:'test-password',role:'user'}})).ok()).toBeTruthy();
 const other=await playwrightRequest.newContext({baseURL:`http://127.0.0.1:${process.env.E2E_API_PORT || '43110'}`});
 try{
  expect((await other.post('/api/auth/login',{data:{username,password:'test-password'}})).ok()).toBeTruthy();
  const response=await other.get('/api/codex/environments');expect(response.ok()).toBeTruthy();expect((await response.json()).environments.some((e:any)=>e.id===account.id)).toBe(false);
  expect((await other.post(`/api/codex/environments/${encodeURIComponent(account.id)}/preflight`,{data:{}})).status()).toBe(403);
 }finally{await other.dispose();await page.request.delete(`/api/codex/environments/${encodeURIComponent(account.id)}`);}
});


test('idle tabs appear in the Provider deletion dialog until removed',async({page},testInfo)=>{
 const status=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const owner=(await(await page.request.get('/api/auth/status')).json()).user;
 const member=(await(await page.request.post('/api/users',{data:{username:'occupancy-member',password:'test-password',role:'member'}})).json()).user;
 const path=join(process.cwd(),'.test-data/e2e/provider-occupancy');mkdirSync(path,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'Provider occupancy',path}})).json();
 expect((await page.request.put(`/api/projects/${project.id}/access/${member.id}`,{data:{can_session:true,can_terminal:false,session_clients:['codex']}})).ok()).toBeTruthy();
 const connection={username:'fixture_user',port:22,authMethod:'key',identityFile:'',codexCommand:'codex',codexHome:''};
 const {environment}=await(await page.request.post('/api/codex/environments',{data:{name:'Occupancy account',connection,allowed_user_ids:[member.id]}})).json();
 const providerPath='/api/codex/environments/'+encodeURIComponent(environment.id);
 const other=await playwrightRequest.newContext({baseURL:`http://127.0.0.1:${process.env.E2E_API_PORT || '43110'}`});
 try{
  expect((await other.post('/api/auth/login',{data:{username:'occupancy-member',password:'test-password'}})).ok()).toBeTruthy();
  const sessions=[];
  for(const [request,user] of [[page.request,owner],[other,member]] as const){
   const {session}=await(await request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'session',cli_type:'codex',environment_id:environment.id,task:'Unstarted occupancy fixture'}})).json();sessions.push(session);
   await request.put('/api/user-state/'+encodeURIComponent('project:'+project.id),{data:{value:{terminalInstances:[{id:session.id,label:'Tab '+user.username}],activeTerminalId:session.id}}});
  }
  // Do not attach a terminal: deterministic fixtures never launch a real CLI.
  expect((await page.request.put(providerPath,{data:{connection}})).status()).toBe(409);
  expect((await page.request.delete('/api/sessions/'+sessions[0].id)).ok()).toBeTruthy();
  expect((await other.delete('/api/sessions/'+sessions[1].id)).ok()).toBeTruthy();
  expect((await page.request.delete(providerPath)).status()).toBe(409);
  const descriptor={id:'codex',label:'Codex',presentation:{icon:'codex',color:'#60a5fa'},capabilities:{}};
  const state={agent:descriptor,installation:{status:'ready',executable:'/fixture/codex',version:'0.test',latestVersion:null,updateAvailable:false,installCommand:'',updateCommand:''},authentication:{status:'authenticated',method:'fixture'},defaults:[],providers:[],configFiles:[],diagnostics:[],actions:[],providerManagement:{create:true,update:true,delete:true,actions:[],fields:[]},applySemantics:{settings:'new_session',providers:'immediate',detail:'fixture'},checkedAt:new Date().toISOString()};
  await page.route('**/api/agent-management**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/agent-management'?{agents:[{agent:descriptor,state}]}:{state}}));
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
  await page.route('**/api/codex/environments/*/details',route=>route.fulfill({json:{details:accountDetails(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!))}}));
 await page.goto('/');await page.getByTitle('My account').click();await page.getByRole('button',{name:'Agent 配置'}).click();
  await page.getByRole('button',{name:/编辑 Occupancy account/}).click();const form=page.getByRole('region',{name:'Codex 账号 Provider'});
  await expect(form.getByRole('table',{name:'Provider 占用标签页列表'})).toHaveCount(0);
  await expect(form.getByRole('button',{name:'删除账号 Provider'})).toBeEnabled();
  await form.getByRole('textbox',{name:'账号 Provider 名称',exact:true}).fill('Adjusted occupancy account');await form.getByRole('button',{name:'保存账号 Provider'}).click();await expect(form).toHaveCount(0);await page.getByRole('button',{name:/编辑 Adjusted occupancy account/}).click();
  await form.getByRole('button',{name:'删除账号 Provider'}).click();const deletion=page.getByRole('dialog',{name:'删除 Provider · Adjusted occupancy account'}),table=deletion.getByRole('table',{name:'Provider 占用标签页列表'});
  await expect(table.getByText('Tab '+owner.username,{exact:true})).toBeVisible();await expect(table.getByText('Tab '+member.username,{exact:true})).toBeVisible();await expect(deletion.getByRole('button',{name:'确认删除 Provider'})).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath('provider-delete-occupancy.png'),fullPage:true});
  await deletion.getByRole('button',{name:'取消',exact:true}).click();await expect(form.getByRole('table',{name:'Provider 占用标签页列表'})).toHaveCount(0);
  await form.getByRole('button',{name:'删除账号 Provider'}).click();
  await table.getByRole('row').filter({hasText:'Tab '+owner.username}).getByRole('button',{name:'删除标签页',exact:true}).click();await page.getByRole('button',{name:'确认删除标签页',exact:true}).click();
  await expect(table.getByText('Tab '+owner.username,{exact:true})).toHaveCount(0);await expect(table.getByText('Tab '+member.username,{exact:true})).toBeVisible();expect((await page.request.delete(providerPath)).status()).toBe(409);
  await deletion.getByRole('checkbox',{name:'全选占用标签页'}).check();await deletion.getByRole('button',{name:'批量删除标签页（1）'}).click();await page.getByRole('button',{name:'确认删除标签页',exact:true}).click();
  await expect(deletion.getByText('当前没有用户占用此 Provider。')).toBeVisible();await expect(deletion.getByRole('button',{name:'确认删除 Provider'})).toBeEnabled();await deletion.getByRole('button',{name:'确认删除 Provider',exact:true}).click();
  await expect.poll(async()=>{const r=await(await page.request.get('/api/codex/environments?management=true')).json();return r.environments.some((e:any)=>e.id===environment.id)}).toBe(false);
  expect((await page.request.get('/api/sessions/'+sessions[0].id)).ok()).toBeTruthy();expect((await other.get('/api/sessions/'+sessions[1].id)).ok()).toBeTruthy();
 }finally{await other.dispose();}
});


test('switches from account Providers to native and API Providers without becoming stuck or inventing unsaved changes',async({page},testInfo)=>{
 const status=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const descriptor={id:'codex',label:'Codex',presentation:{icon:'codex',color:'#60a5fa'},capabilities:{}};
 const provider=(id:string,name:string)=>({id,name,kind:id==='native'?'native':'responses',managed:id!=='native',enabled:true,status:'ready',statusText:'Fixture ready',models:['fixture-model'],fields:[],configFiles:[],authentication:{status:'authenticated',method:'fixture'},pid:null});
 const providers=[provider('native','原生测试 Provider'),provider('gateway','API 测试 Provider')];
 const state={agent:descriptor,installation:{status:'ready',executable:'/fixture/codex',version:'0.test',latestVersion:null,updateAvailable:false,installCommand:'',updateCommand:''},authentication:{status:'authenticated',method:'fixture'},defaults:[],providers,configFiles:[],diagnostics:[],actions:[],providerManagement:{create:true,update:true,delete:true,actions:[],fields:[]},applySemantics:{settings:'new_session',providers:'immediate',detail:'fixture'},checkedAt:new Date().toISOString()};
 const environments=[{id:'native',name:'原生测试 Provider',kind:'native',enabled:true,allowed_user_ids:null},...['A','B'].map(name=>({id:'account:'+name,name:'账号 '+name,kind:'account',enabled:true,allowed_user_ids:[],connection:{username:'fixture_'+name.toLowerCase(),port:22,authMethod:'key',identityFile:'',codexCommand:'codex',codexHome:''}}))];
 await page.route('**/api/agent-management**',route=>{const path=new URL(route.request().url()).pathname;if(path.includes('/providers/'))return route.fulfill({json:{provider:providers.find(p=>path.endsWith('/'+p.id))||providers[0]}});if(path.includes('/model-configs'))return route.fulfill({json:{models:[{
  provider:'gateway',model:'fixture-model',name:'Fixture model',release_date:'2026-11-17',official_context_window:1050000,
  api_pricing:{currency:'USD',reference_only:true,source:'fixture-official',bands:[{rates:{input:2,cached:0.1,output:10}}]},
  provider_pricing:{currency:'USD',source:'fixture-provider',bands:[{rates:{input:3,cached:0.2,output:12}}]},
 }]}});return route.fulfill({json:path==='/api/agent-management'?{agents:[{agent:descriptor,state}]}:{state}})});
 await page.route('**/api/codex/environments**',route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/config-files'))return route.fulfill({json:{files:[{id:'credentials',label:'Codex 凭据文件',description:'仅显示文件状态',format:'JSON',path:'/fixture/.codex/auth.json',exists:true,sensitive:true}]}});if(path.endsWith('/details'))return route.fulfill({json:{details:accountDetails(decodeURIComponent(path.split('/').at(-2)!))}});if(path.endsWith('/usage'))return route.fulfill({json:{tabs:[],busy:false,verified:true}});return route.fulfill({json:{environments,users:[]}})});
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});let unexpectedDialogs=0;page.on('dialog',async dialog=>{unexpectedDialogs++;await dialog.dismiss()});
 await page.setViewportSize({width:1500,height:1100});await page.goto('/');await page.getByTitle('My account').click();await page.getByRole('button',{name:'Agent 配置'}).click();
 const open = async (name:string) => {
  await page.getByRole('table',{name:'Agent Provider'}).getByRole('button',{name:`编辑 ${name} · Codex`}).click();
  const dialog=page.getByRole('dialog',{name:`编辑 Provider · ${name}`});
  await expect(dialog).toBeVisible();
  return dialog;
 };
 const close = async (dialog:ReturnType<typeof page.getByRole>) => {
  await dialog.getByRole('button',{name:/^关闭编辑 Provider/}).click();
  await expect(dialog).toHaveCount(0);
 };
 for(const name of ['账号 A','原生测试 Provider','账号 B','API 测试 Provider','账号 A']) await close(await open(name));
 const gateway=await open('API 测试 Provider');
 const modelRow=gateway.getByRole('table',{name:'Provider 模型'}).getByRole('row').filter({hasText:'fixture-model'});
 await expect(modelRow).toContainText('2026-11-17');
 await expect(modelRow).toContainText('1,050,000');
 await expect(modelRow).toContainText('输入 2 · 缓存命中 0.1 · 输出 10');
 await expect(modelRow).toContainText('输入 3 · 缓存命中 0.2 · 输出 12');
 await close(gateway);
 expect(unexpectedDialogs).toBe(0);
 const account=await open('账号 A');
 await account.getByRole('button',{name:'账号详情'}).click();
 await expect(account.getByText('fixture@example.invalid')).toBeVisible();
 const commonFields=['登录状态','账号身份','登录方式 / 套餐','Codex 引擎','周额度剩余','额度重置时间','执行用户','Codex 版本','默认模型','模型 Provider','默认推理强度','执行确认策略','沙箱模式','本机连接'];
 for(const field of commonFields)await expect(account.getByText(field,{exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('ssh-account-details.png'),fullPage:true});
 await close(account);
 const native=await open('原生测试 Provider');
 await native.getByRole('button',{name:'账号详情'}).click();
 for(const field of commonFields)await expect(native.getByText(field,{exact:true})).toBeVisible();
 await native.getByRole('button',{name:/Codex 凭据文件/}).click();
 const credential=page.getByRole('dialog',{name:'Codex 凭据文件'});
 await expect(credential).toContainText('凭据内容受保护');
 await credential.getByRole('button',{name:'关闭Codex 凭据文件'}).click();
 await native.getByRole('button',{name:'编辑配置'}).click();
 await expect(native.getByRole('button',{name:'账号详情'})).toBeVisible();
 await native.getByRole('button',{name:'账号详情'}).click();
 await expect(native.getByText('fixture@example.invalid')).toBeVisible();
 await close(native);
 expect(unexpectedDialogs).toBe(0);
});
