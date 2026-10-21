import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

test('Platform AI chats through real platform tools and a signed external gateway', async ({page},testInfo) => {
  test.setTimeout(90000);
  // Match the crypto API available when the dashboard is opened over LAN HTTP.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {value: undefined, configurable: true});
  });
  const deliveries: Array<{body: string; headers: Record<string, unknown>}> = [];
  const modelRequests: any[] = [];
  const probeRequests: any[] = [];
  let releaseFirstReply: (()=>void) | undefined;
  let pauseFirstReply = true;
  const replyText='当前可访问项目包含：平台 AI 验证项目。你可以指定项目并下发开发需求。\n\n当前可见 **1 个**项目：\n\n| 项目 | ID | 路径 | 可用客户端 | 会话权限 |\n| --- | --- | --- | --- | --- |\n| 平台 AI 验证项目 | project-test | `/workspace/'+ 'nested-project/'.repeat(12) +'src/index.ts` | **Codex** | 可创建会话、可开终端 |';
  const server=createServer(async (request,response) => {
    let body='';for await (const chunk of request) body+=chunk;
    response.setHeader('Content-Type','application/json');
    if (request.url==='/delivery') {
      deliveries.push({body,headers:request.headers});response.end('{}');return;
    }
    if (request.url==='/v1/models' && request.method==='GET') {
      expect(request.headers.authorization).toBe('Bearer e2e-platform-ai-secret');
      response.end(JSON.stringify({data:[{id:'e2e-text-model'},{id:'e2e-tools-model'}]}));return;
    }
    const payload=JSON.parse(body);
    if (payload.messages[0]?.content==='This is a connectivity test. Reply with OK.') {
      probeRequests.push(payload);response.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));return;
    }
    if (payload.tools?.[0]?.function?.name==='platform_connection_probe') {
      probeRequests.push(payload);
      const token=payload.messages[0].content.match(/exactly "([a-f0-9]+)"/)[1];
      response.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'probe',type:'function',function:{name:'platform_connection_probe',arguments:JSON.stringify({token})}}]}}]}));return;
    }
    modelRequests.push(payload);
    const last=payload.messages.at(-1);
    const message=last.role==='tool'
      ? {content:replyText}
      : {content:null,tool_calls:[{id:'list-projects',type:'function',function:{name:'platform_request',arguments:JSON.stringify({endpoint_id:'GET /api/projects'})}}]};
    if (payload.stream) {
      response.setHeader('Content-Type','text/event-stream');
      const emit=(delta: unknown,finish_reason: string | null=null)=>response.write(`data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`);
      if (message.tool_calls) {
        emit({tool_calls:message.tool_calls.map((call,index)=>({...call,index}))});emit({},'tool_calls');
      } else {
        emit({content:'当前可访问项目包含：'});
        if (pauseFirstReply) {pauseFirstReply=false;await new Promise<void>(resolveReply=>{releaseFirstReply=resolveReply;});}
        emit({content:message.content.slice('当前可访问项目包含：'.length)});emit({},'stop');
      }
      response.end('data: [DONE]\n\n');return;
    }
    response.end(JSON.stringify({choices:[{message}]}));
  });
  await new Promise<void>(resolveListen => server.listen(0,'127.0.0.1',resolveListen));
  const address=server.address();
  if (!address || typeof address==='string') throw new Error('Cannot start test provider');
  const provider=`http://127.0.0.1:${address.port}`;
  try {
    const auth=await (await page.request.get('/api/auth/status')).json();
    expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
    await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true'}}});
    const projectPath=join(resolve(dirname(fileURLToPath(import.meta.url)),'..'),'.test-data','e2e','platform-ai-project');
    mkdirSync(projectPath,{recursive:true});
    const created=await page.request.post('/api/projects',{data:{name:'平台 AI 验证项目',path:projectPath}});
    expect(created.ok()).toBeTruthy();
    await page.goto('/');
    await page.getByRole('button',{name:'平台 AI',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'平台管理'});
    await dialog.getByRole('button',{name:'模型配置',exact:true}).click();
    const beforeProbe=await (await page.request.get('/api/platform-ai/config')).json();
    await dialog.getByLabel('模型 API 地址',{exact:true}).fill(provider+'/v1');
    await dialog.getByLabel('API Key',{exact:true}).fill('e2e-platform-ai-secret');
    await dialog.getByRole('button',{name:'获取模型列表',exact:true}).click();
    await expect(dialog.getByLabel('选择探测到的模型')).toBeVisible();
    await dialog.getByLabel('选择探测到的模型').selectOption('e2e-tools-model');
    await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('e2e-tools-model');
    await dialog.getByRole('button',{name:'测试连通性',exact:true}).click();
    await expect(dialog.getByRole('status')).toContainText('测试通过，可用于平台 AI');
    await expect(dialog.getByText('工具调用：通过',{exact:true})).toBeVisible();
    expect(probeRequests.length).toBe(2);
    expect(await (await page.request.get('/api/platform-ai/config')).json()).toEqual(beforeProbe);
    await page.screenshot({path:testInfo.outputPath('platform-ai-model-probes.png')});
    await dialog.getByLabel('启用平台 AI',{exact:true}).check();
    await dialog.getByRole('button',{name:'保存模型配置',exact:true}).click();
    await expect(dialog.getByRole('status')).toHaveText('配置已保存');
    await dialog.getByRole('button',{name:'对话',exact:true}).click();
    await dialog.getByLabel('发送给平台 AI 的消息').fill('列出我能访问的项目');
    await dialog.getByRole('button',{name:'发送消息'}).click();
    await expect(dialog.getByText('当前可访问项目包含：',{exact:true})).toBeVisible();
    await expect(dialog.getByText('正在生成回复…',{exact:true})).toBeVisible();
    await expect(dialog.getByText('实时更新中',{exact:true})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('platform-ai-streaming-reply.png')});
    expect(releaseFirstReply).toBeDefined();releaseFirstReply!();
    await expect(dialog.getByText('当前可访问项目包含：平台 AI 验证项目。你可以指定项目并下发开发需求。',{exact:true})).toBeVisible();
    const table=dialog.getByRole('table');
    await expect(table.getByRole('columnheader',{name:'项目',exact:true})).toBeVisible();
    await expect(table.getByRole('cell',{name:'Codex',exact:true})).toBeVisible();
    expect(await dialog.getByText('1 个',{exact:true}).evaluate(element=>element.tagName)).toBe('STRONG');
    expect(modelRequests.length).toBe(2);
    const tool=JSON.parse(modelRequests[1].messages.find((message: any) => message.role==='tool').content);
    expect(tool.projects.some((project: any) => project.name==='平台 AI 验证项目')).toBeTruthy();
    expect(JSON.stringify(modelRequests)).not.toContain('agentmanager_session');
    await page.screenshot({path:testInfo.outputPath('platform-ai-chat.png')});
    await page.setViewportSize({width:390,height:844});
    await table.scrollIntoViewIfNeeded();
    const overflow=await table.evaluate(element=>{
      const parent=element.parentElement!;
      return {scrolls:parent.scrollWidth>parent.clientWidth,overflow:getComputedStyle(parent).overflowX};
    });
    expect(overflow).toEqual({scrolls:true,overflow:'auto'});
    expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('platform-ai-mobile-markdown.png')});
    await page.setViewportSize({width:1280,height:720});

    await dialog.getByRole('button',{name:'渠道与用户映射',exact:true}).click();
    await dialog.getByRole('button',{name:'添加渠道',exact:true}).click();
    await dialog.getByLabel('渠道名称',{exact:true}).fill('E2E 外部网关');
    await dialog.getByLabel('渠道类型',{exact:true}).selectOption('webhook');
    await dialog.getByLabel('回复接收地址',{exact:true}).fill(provider+'/delivery');
    const secret='e2e-gateway-signing-secret-'.repeat(2);
    await dialog.getByLabel('HMAC 签名密钥（至少 32 字符）',{exact:true}).fill(secret);
    await dialog.getByLabel('启用此渠道',{exact:true}).check();
    await dialog.getByRole('button',{name:'保存渠道',exact:true}).click();
    await expect(dialog.getByLabel('映射渠道').locator('option',{hasText:'E2E 外部网关'})).toHaveCount(1);
    const channels=await (await page.request.get('/api/platform-ai/channels')).json();
    const channel=channels.channels.find((item: any) => item.name==='E2E 外部网关');
    const users=await (await page.request.get('/api/users')).json();
    const admin=users.users.find((user: any) => user.username==='e2e-admin');
    await dialog.getByLabel('映射渠道').selectOption(channel.id);
    await dialog.getByLabel('外部用户 ID',{exact:true}).fill('external-admin');
    await dialog.getByLabel('映射平台用户').selectOption(admin.id);
    await dialog.getByRole('button',{name:'保存用户映射',exact:true}).click();
    await expect(dialog.getByText(/external-admin →/)).toBeVisible();
    const raw=JSON.stringify({message_id:'external-message-1',user_id:'external-admin',chat_id:'external-chat',content:'外部渠道：列出我的项目'});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
    const callback={data:raw,headers:{'Content-Type':'application/json','X-Platform-Timestamp':timestamp,'X-Platform-Signature':signature}};
    expect((await page.request.post(channel.callback_path,callback)).ok()).toBeTruthy();
    expect((await page.request.post(channel.callback_path,callback)).ok()).toBeTruthy();
    await expect.poll(() => deliveries.length).toBe(1);
    const delivered=deliveries[0];
    const sentTimestamp=String(delivered.headers['x-platform-timestamp']);
    expect(delivered.headers['x-platform-signature']).toBe(createHmac('sha256',secret).update(sentTimestamp+'.'+delivered.body).digest('hex'));
    expect(JSON.parse(delivered.body)).toMatchObject({user_id:'external-admin',chat_id:'external-chat',content:expect.stringContaining('平台 AI 验证项目')});
    expect(delivered.headers['idempotency-key']).toBe(JSON.parse(delivered.body).delivery_id);
    const storedConfig=await (await page.request.get('/api/platform-ai/config')).text();
    expect(storedConfig).not.toContain('e2e-platform-ai-secret');
    expect(JSON.stringify(channels)).not.toContain(secret);
    await page.setViewportSize({width:390,height:844});
    await expect(dialog.getByLabel('映射平台用户')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('platform-ai-mobile-channels.png')});
  } finally {
    releaseFirstReply?.();
    await page.request.put('/api/platform-ai/config',{data:{enabled:false}}).catch(()=>{});
    await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));
  }
});

test('Platform AI displays persisted channel images through the authenticated attachment endpoint', async ({page}, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(auth.needsSetup ? '/api/auth/setup' : '/api/auth/login', {data: {username: 'e2e-admin', password: 'test-password'}})).ok()).toBeTruthy();
  const users = await (await page.request.get('/api/users')).json();
  const user = users.users.find((user: any) => user.username === 'e2e-admin');
  // Seed only the isolated test DB; SDK/decryption is covered by transport tests.
  const require = createRequire(import.meta.url);
  const Database = require('../server/node_modules/better-sqlite3');
  const db = new Database(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.test-data', 'e2e', 'agentmanager.db'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CsAAAAAASUVORK5CYII=', 'base64');
  try {
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO platform_ai_conversations (id,user_id,external_chat_id,external_user_id,title) VALUES ('image-conversation',?,'image-chat',?,'机器人截图需求')").run(user.id, user.id);
    db.prepare("INSERT INTO platform_ai_messages (id,conversation_id,external_id,role,content,status) VALUES ('image-message','image-conversation','image-source','user','请按截图修复这个问题','done')").run();
    db.prepare("INSERT INTO platform_ai_attachments (id,message_id,status,mime,bytes,data) VALUES ('image-fixture','image-message','ready','image/png',?,?)").run(png.length, png);
  } finally {db.close();}
  await page.goto('/');
  await page.getByRole('button', {name: '平台 AI', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '平台管理'});
  await dialog.getByRole('button').filter({hasText: '机器人截图需求'}).click();
  const image = dialog.getByRole('img', {name: '用户发送的图片 1'});
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const original = await page.request.get('/api/platform-ai/attachments/image-fixture');
  expect(original.ok()).toBe(true); expect((await original.body()).equals(png)).toBe(true);
  await page.setViewportSize({width: 390, height: 844});
  await expect(image).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('platform-ai-received-image.png')});
});
