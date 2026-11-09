import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,request as playwrightRequest} from '@playwright/test';

test('configures a private same-machine account and enforces visibility in browser and API',async({page},testInfo)=>{
 const status=await (await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const authenticated=await (await page.request.get('/api/auth/status')).json(),owner=authenticated.user;
 const descriptor={id:'codex',label:'Codex',presentation:{icon:'codex',color:'#60a5fa'},capabilities:{}};
 const state={agent:descriptor,installation:{status:'ready',executable:'/fixture/codex',version:'0.test',latestVersion:null,updateAvailable:false,installCommand:'',updateCommand:''},authentication:{status:'authenticated',method:'fixture'},defaults:[],providers:[],configFiles:[],diagnostics:[],actions:[],providerManagement:{create:true,update:true,delete:true,actions:[],fields:[]},applySemantics:{settings:'new_session',providers:'immediate',detail:'fixture'},checkedAt:new Date().toISOString()};
 await page.route('**/api/agent-management**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/agent-management'?{agents:[{agent:descriptor,state}]}:{state}}));
 // Connection stages are simulated; never use a real user's SSH or login.
 await page.route('**/api/codex/environments/check-connection',route=>route.fulfill({json:{ok:false,checks:[{stage:'codex_authentication',ok:false,message:'该系统用户尚未登录 Codex，请先以该用户运行 codex login'}]}}));
 await page.goto('/');await page.getByRole('button',{name:'平台管理'}).click();await page.getByRole('button',{name:'Agent 配置'}).click();
 await page.getByRole('button',{name:'添加 Provider',exact:true}).click();await page.getByRole('combobox',{name:'Provider 接入类型'}).selectOption('account');const dialog=page.getByRole('region',{name:'Codex 账号 Provider'});
 await dialog.getByRole('textbox',{name:'账号 Provider 名称',exact:true}).fill('ymchen private fixture');await dialog.getByRole('textbox',{name:'系统用户名',exact:true}).fill('fixture_user');
 await expect(dialog.getByRole('button',{name:'保存账号 Provider'})).toBeDisabled();await dialog.getByRole('combobox',{name:'SSH 认证方式'}).selectOption('key');
 await dialog.getByRole('button',{name:'预检连接、已有登录、模型与项目'}).click();await expect(dialog.getByRole('alert')).toContainText('codex login');
 await page.screenshot({path:testInfo.outputPath('missing-login-preflight.png'),fullPage:true});
 await dialog.getByRole('button',{name:'保存账号 Provider'}).click();await expect(dialog.getByRole('heading',{name:'ymchen private fixture'})).toBeVisible();await expect(page.getByText('1 个 Provider',{exact:true})).toBeVisible();
 const visible=await (await page.request.get('/api/codex/environments')).json();const account=visible.environments.find((e:any)=>e.name==='ymchen private fixture');expect(account).toBeTruthy();expect(account.connection).toBeUndefined();
 const username='environment-member';expect((await page.request.post('/api/users',{data:{username,password:'test-password',role:'user'}})).ok()).toBeTruthy();
 const other=await playwrightRequest.newContext({baseURL:'http://127.0.0.1:43110'});
 try{
  expect((await other.post('/api/auth/login',{data:{username,password:'test-password'}})).ok()).toBeTruthy();
  const response=await other.get('/api/codex/environments');expect(response.ok()).toBeTruthy();expect((await response.json()).environments.some((e:any)=>e.id===account.id)).toBe(false);
  expect((await other.post(`/api/codex/environments/${encodeURIComponent(account.id)}/preflight`,{data:{}})).status()).toBe(403);
 }finally{await other.dispose();await page.request.delete(`/api/codex/environments/${encodeURIComponent(account.id)}`);}
});


test('idle tabs from every user block Provider deletion until individually or collectively removed',async({page})=>{
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
  await page.goto('/');await page.getByRole('button',{name:'平台管理'}).click();await page.getByRole('button',{name:'Agent 配置'}).click();
  await page.getByRole('button').filter({hasText:'Occupancy account'}).click();const form=page.getByRole('region',{name:'Codex 账号 Provider'}),table=form.getByRole('table',{name:'Provider 占用标签页列表'});
  await expect(table.getByText('Tab '+owner.username,{exact:true})).toBeVisible();await expect(table.getByText('Tab '+member.username,{exact:true})).toBeVisible();
  await expect(form.getByRole('button',{name:'删除账号 Provider'})).toBeDisabled();
  await form.getByRole('textbox',{name:'账号 Provider 名称',exact:true}).fill('Adjusted occupancy account');await form.getByRole('button',{name:'保存账号 Provider'}).click();await expect(form.getByRole('heading',{name:'Adjusted occupancy account',exact:true})).toBeVisible();
  await table.getByRole('row').filter({hasText:'Tab '+owner.username}).getByRole('button',{name:'删除标签页',exact:true}).click();await page.getByRole('button',{name:'确认删除标签页',exact:true}).click();
  await expect(table.getByText('Tab '+owner.username,{exact:true})).toHaveCount(0);await expect(table.getByText('Tab '+member.username,{exact:true})).toBeVisible();expect((await page.request.delete(providerPath)).status()).toBe(409);
  await form.getByRole('checkbox',{name:'全选占用标签页'}).check();await form.getByRole('button',{name:'批量删除标签页（1）'}).click();await page.getByRole('button',{name:'确认删除标签页',exact:true}).click();
  await expect(form.getByText('当前没有用户占用此 Provider。')).toBeVisible();await form.getByRole('button',{name:'删除账号 Provider'}).click();await page.getByRole('button',{name:'确认删除 Provider',exact:true}).click();
  await expect.poll(async()=>{const r=await(await page.request.get('/api/codex/environments?management=true')).json();return r.environments.some((e:any)=>e.id===environment.id)}).toBe(false);
  expect((await page.request.get('/api/sessions/'+sessions[0].id)).ok()).toBeTruthy();expect((await other.get('/api/sessions/'+sessions[1].id)).ok()).toBeTruthy();
 }finally{await other.dispose();}
});
