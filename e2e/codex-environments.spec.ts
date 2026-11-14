import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,request as playwrightRequest} from '@playwright/test';
test.beforeEach(async({page})=>{
 await page.route('**/api/codex/environments/*/quota',route=>route.fulfill({json:{quota:null,reason:'fixture'}}));
 await page.route('**/api/codex/environments/*/config-files*',route=>{const url=new URL(route.request().url());if(route.request().method()==='PUT'){const body=route.request().postDataJSON();return route.fulfill({json:{content:body.content,revision:'updated',exists:true}});}return route.fulfill({json:url.searchParams.has('file')?{content:'model = "fixture"',revision:'fixture',exists:true}:{files:[{id:'config',label:'Codex 配置',description:'模型配置',format:'TOML',path:'/fixture/.codex/config.toml',exists:true},{id:'credentials',label:'Codex 凭据文件',description:'仅显示文件状态',format:'JSON',path:'/fixture/.codex/auth.json',exists:true,sensitive:true}]}});});
});
const accountDetails=(id:string)=>({id,checked_at:'2026-11-09T00:00:00Z',executable:'/fixture/bin/codex',version:'codex-cli 0.fixture',home:'/fixture/.codex',engine:{state:'connected',pid:123},authentication:{status:'authenticated',type:'chatgpt',email:'fixture@example.invalid',plan:'fixture-plan'},config:{path:'/fixture/.codex/config.toml',exists:true,notice:null},settings:{model:'fixture-model',model_provider:'openai',model_reasoning_effort:'high'},models:[{model:'fixture-model',name:'Fixture model',description:'Selected user model',defaultEffort:'high'}]});


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
 await page.setViewportSize({width:1500,height:1100});await page.goto('/');await page.getByTitle('My account', { exact: true }).click();await page.getByRole('button',{name:'Agent 配置'}).click();
 await page.getByRole('button',{name:'添加 Provider',exact:true}).click();await page.getByRole('combobox',{name:'Provider 接入类型'}).selectOption('account');const dialog=page.getByRole('region',{name:'Codex 账号 Provider'});
 await dialog.getByRole('textbox',{name:'账号 Provider 名称',exact:true}).fill('ymchen private fixture');await dialog.getByRole('textbox',{name:'系统用户名',exact:true}).fill('fixture_user');
 await expect(dialog.getByRole('button',{name:'保存账号 Provider'})).toBeDisabled();await dialog.getByRole('combobox',{name:'SSH 认证方式'}).selectOption('key');
 await dialog.getByRole('textbox',{name:'Codex 命令',exact:true}).fill('codex --dangerously-bypass-approvals-and-sandbox');await expect(dialog.getByRole('alert')).toContainText('例如填写 codex');await expect(dialog.getByRole('button',{name:'预检连接、已有登录、模型与项目'})).toBeDisabled();await dialog.getByRole('textbox',{name:'Codex 命令',exact:true}).fill('codex');
 await dialog.getByRole('button',{name:'预检连接、已有登录、模型与项目'}).click();await expect(dialog.getByRole('alert')).toContainText('codex login');
 await page.screenshot({path:testInfo.outputPath('missing-login-preflight.png'),fullPage:true});
 await dialog.getByRole('button',{name:'保存账号 Provider'}).click();await expect(dialog.getByRole('heading',{name:'ymchen private fixture'})).toBeVisible();await expect(page.getByText('1 个 Provider',{exact:true})).toBeVisible();await expect(dialog.getByText('fixture@example.invalid')).toBeVisible();await expect(dialog.getByText('Fixture model')).toBeVisible();await expect(dialog.getByRole('textbox',{name:'Codex 命令'})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('saved-account-details.png'),fullPage:true});
 await dialog.getByRole('button',{name:/Codex 配置/}).click();const fileDialog=page.getByRole('dialog',{name:'Codex 配置'});await fileDialog.getByRole('textbox',{name:'Codex 配置 内容'}).fill('model = "updated"');await fileDialog.getByRole('button',{name:'保存文件'}).click();await expect(fileDialog.getByRole('status')).toHaveText('已保存');await fileDialog.getByRole('button',{name:'关闭Codex 配置'}).click();await dialog.getByRole('button',{name:/Codex 凭据文件/}).click();const credential=page.getByRole('dialog',{name:'Codex 凭据文件'});await expect(credential).toContainText('凭据内容受保护');await expect(credential.locator('textarea')).toHaveCount(0);await credential.getByRole('button',{name:'关闭Codex 凭据文件'}).click();
 const visible=await (await page.request.get('/api/codex/environments')).json();const account=visible.environments.find((e:any)=>e.name==='ymchen private fixture');expect(account).toBeTruthy();expect(account.connection).toBeUndefined();
 const username='environment-member';expect((await page.request.post('/api/users',{data:{username,password:'test-password',role:'user'}})).ok()).toBeTruthy();
 const other=await playwrightRequest.newContext({baseURL:'http://127.0.0.1:43110'});
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
 const other=await playwrightRequest.newContext({baseURL:'http://127.0.0.1:43110'});
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
 await page.goto('/');await page.getByTitle('My account', { exact: true }).click();await page.getByRole('button',{name:'Agent 配置'}).click();
  await page.getByRole('button').filter({hasText:'Occupancy account'}).click();const form=page.getByRole('region',{name:'Codex 账号 Provider'});
  await expect(form.getByRole('table',{name:'Provider 占用标签页列表'})).toHaveCount(0);
  await expect(form.getByRole('button',{name:'删除账号 Provider'})).toBeEnabled();
  await form.getByRole('button',{name:'编辑配置'}).click();
  await form.getByRole('textbox',{name:'账号 Provider 名称',exact:true}).fill('Adjusted occupancy account');await form.getByRole('button',{name:'保存账号 Provider'}).click();await expect(form.getByRole('heading',{name:'Adjusted occupancy account',exact:true})).toBeVisible();
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
 await page.route('**/api/agent-management**',route=>{const path=new URL(route.request().url()).pathname;if(path.includes('/providers/'))return route.fulfill({json:{provider:providers.find(p=>path.endsWith('/'+p.id))||providers[0]}});if(path.includes('/model-configs'))return route.fulfill({json:{models:[]}});return route.fulfill({json:path==='/api/agent-management'?{agents:[{agent:descriptor,state}]}:{state}})});
 await page.route('**/api/codex/environments**',route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/config-files'))return route.fulfill({json:{files:[{id:'credentials',label:'Codex 凭据文件',description:'仅显示文件状态',format:'JSON',path:'/fixture/.codex/auth.json',exists:true,sensitive:true}]}});if(path.endsWith('/details'))return route.fulfill({json:{details:accountDetails(decodeURIComponent(path.split('/').at(-2)!))}});if(path.endsWith('/usage'))return route.fulfill({json:{tabs:[],busy:false,verified:true}});return route.fulfill({json:{environments,users:[]}})});
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});let unexpectedDialogs=0;page.on('dialog',async dialog=>{unexpectedDialogs++;await dialog.dismiss()});
 await page.setViewportSize({width:1500,height:1100});await page.goto('/');await page.getByTitle('My account', { exact: true }).click();await page.getByRole('button',{name:'Agent 配置'}).click();
 for(const name of ['账号 A','原生测试 Provider','账号 B','API 测试 Provider','账号 A']){await page.getByRole('button').filter({hasText:name}).click();await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();await expect(page.locator('.agent-management-provider-list [aria-current="true"]')).toHaveCount(1);await expect(page.locator('.agent-management-provider-list [aria-current="true"]')).toContainText(name);}
 expect(unexpectedDialogs).toBe(0);await expect(page.getByRole('table',{name:'Provider 占用标签页列表'})).toHaveCount(0);await expect(page.getByText('fixture@example.invalid')).toBeVisible();
 const accountRegion=page.getByRole('region',{name:'Codex 账号 Provider'});const commonFields=['登录状态','账号身份','登录方式 / 套餐','Codex 引擎','周额度剩余','额度重置时间','执行用户','Codex 版本','默认模型','模型 Provider','默认推理强度','执行确认策略','沙箱模式','本机连接'];
 for(const field of commonFields)await expect(accountRegion.getByText(field,{exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('ssh-account-details.png'),fullPage:true});
 await page.getByRole('button').filter({hasText:'原生测试 Provider'}).click();await expect(accountRegion.getByRole('heading',{name:'原生测试 Provider'})).toBeVisible();for(const field of commonFields)await expect(accountRegion.getByText(field,{exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('native-account-details.png'),fullPage:true});
 await expect(page.getByRole('table',{name:'Provider 占用标签页列表'})).toHaveCount(0);await accountRegion.getByRole('button',{name:/Codex 凭据文件/}).click();const nativeCredential=page.getByRole('dialog',{name:'Codex 凭据文件'});await expect(nativeCredential).toContainText('凭据内容受保护');await nativeCredential.getByRole('button',{name:'关闭Codex 凭据文件'}).click();await accountRegion.getByRole('button',{name:'编辑配置'}).click();await expect(page.getByRole('button',{name:'返回详情'})).toBeVisible();await page.getByRole('button',{name:'返回详情'}).click();await expect(accountRegion.getByRole('heading',{name:'原生测试 Provider'})).toBeVisible();
 await page.getByRole('button').filter({hasText:'账号 A'}).click();await expect(accountRegion.getByRole('heading',{name:'账号 A'})).toBeVisible();await page.screenshot({path:testInfo.outputPath('account-provider-switching.png'),fullPage:true});
});
