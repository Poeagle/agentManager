import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('login IP, independent browser heartbeats and disconnects are visible in monitoring',async({page,browser},testInfo)=>{
 test.setTimeout(65_000);
 const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const {user:member}=await(await page.request.post('/api/users',{data:{username:'heartbeat-member',display_name:'心跳验证用户',password:'test-password'}})).json();
 const context=await browser.newContext({baseURL:'http://127.0.0.1:43111',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'});
 try {
  expect((await context.request.post('/api/auth/login',{headers:{'x-agentmanager-client-ip':'203.0.113.42','x-forwarded-for':'203.0.113.42'},data:{username:'heartbeat-member',password:'test-password'}})).ok()).toBeTruthy();
  const memberState=async()=>(await(await page.request.get('/api/admin/monitor')).json()).users.find((u:any)=>u.id===member.id);
  expect((await memberState()).presence.state).toBe('offline');
  // A page with no application polling: only the actual native WebSocket
  // handshake and automatic protocol pongs can keep this login online.
  const idle=await context.newPage();await idle.goto('/api/health');await idle.evaluate(()=>new Promise<void>((resolve,reject)=>{const socket=new WebSocket(`ws://${location.host}/api/stream`);(window as any).presenceSocket=socket;socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error('stream failed'));}));
  await expect.poll(async()=>(await memberState()).presence.state).toBe('online');
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(process.cwd(),'.test-data/e2e/agentmanager.db'));
  try{db.prepare("UPDATE auth_sessions SET last_seen_at=datetime('now','-6 minutes') WHERE user_id=?").run(member.id);}finally{db.close();}
  const before=(await memberState()).last_seen_at;
  await expect.poll(async()=>(await memberState()).last_seen_at,{timeout:35_000,intervals:[1000]}).not.toBe(before);
  const online=await memberState();expect(online.login_sessions).toHaveLength(1);expect(online.login_sessions[0]).toMatchObject({login_ip:'127.0.0.1',last_ip:'127.0.0.1'});expect(online.login_sessions[0].user_agent).toContain('Chrome');
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.goto('/');await page.getByRole('button',{name:'平台管理',exact:true}).click();const dialog=page.getByRole('dialog',{name:'平台管理'});await dialog.getByRole('navigation',{name:'平台管理分类'}).getByRole('button',{name:'用户监控',exact:true}).click();
  const row=dialog.getByRole('table',{name:'用户监控',exact:true}).getByRole('row').filter({has:page.getByRole('button',{name:'展开用户 heartbeat-member',exact:true})});
  await expect(row.getByText('在线',{exact:true})).toBeVisible();await expect(row.getByText('Chrome · Windows',{exact:true})).toBeVisible();await row.getByRole('button',{name:'展开用户 heartbeat-member',exact:true}).click();
  const logins=dialog.getByRole('table',{name:'heartbeat-member 的登录连接',exact:true});await expect(logins.getByRole('button',{name:'登录 IP排序',exact:true})).toBeVisible();await page.setViewportSize({width:1600,height:1000});await page.screenshot({path:testInfo.outputPath('login-presence-light.png')});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('login-presence-mobile.png')});
  await context.close();await expect.poll(async()=>(await memberState()).presence.state).toBe('offline');
 }finally{await context.close();}
});
