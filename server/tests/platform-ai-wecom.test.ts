import { once } from 'events';
import {writeFileSync,mkdirSync} from 'fs';
import {join} from 'path';
import { createCipheriv, randomBytes } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { WSClient } from '@wecom/aibot-node-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser, setProjectToolAccess } from '../src/auth.js';
import { closeDb, getDb, initDb } from '../src/db/index.js';
import { platformAiRoutes } from '../src/routes/platform-ai.js';
import { getBotTransport } from '../src/services/platform-ai/channel-runtime.js';
import { compactText, decodeCallback, deliverMessage, getChannel, saveChannel } from '../src/services/platform-ai/channels.js';
import { updateAiConfig } from '../src/services/platform-ai/config.js';
import { publishMessage } from '../src/services/platform-ai/live.js';
import { enqueueNotice, receiveMessage, getConversation, trackTask } from '../src/services/platform-ai/store.js';
import { WecomBotManager } from '../src/services/platform-ai/wecom-bot.js';
import { PlatformAiWorker } from '../src/services/platform-ai/worker.js';
import { messageAttachments, prepareImages, validateImageSource } from '../src/services/platform-ai/attachments.js';
import { createTestDatabase } from './helpers/database.js';

import {notificationReplyTarget,quotedReplyRoute} from '../src/services/platform-ai/quoted-replies.js';
import * as platformTools from '../src/services/platform-ai/tools.js';
import {saveProjectNotification,canNotifyProject} from '../src/services/platform-ai/project-notifications.js';

let cleanup: () => void;
let app: FastifyInstance;
let manager: WecomBotManager;
let worker: PlatformAiWorker;
let server: WebSocketServer;
let sockets: WebSocket[];
let frames: any[];
let admin: string, member: string, other: string, adminCookie: string, memberCookie: string;
let rejectAuth = false;
let rejectStream = false;
let databaseDir: string;
let rejectImage = false;
let uploadCount = 0;

beforeEach(async () => {
  const database = createTestDatabase(); cleanup = database.cleanup; databaseDir = database.dir;
  admin = createUser({username: 'admin', password: 'password1', role: 'admin'}).id;
  member = createUser({username: 'member', password: 'password1'}).id;
  other = createUser({username: 'other', password: 'password1'}).id;
  adminCookie = `agentmanager_session=${createSession(admin)}`;
  memberCookie = `agentmanager_session=${createSession(member)}`;
  updateAiConfig({enabled: true, endpoint: 'https://model.example/v1', model: 'test', api_key: 'model-secret'});
  app = Fastify(); app.addHook('onRequest', authHook);
  await app.register(platformAiRoutes, {prefix: '/api', runWorker: false}); await app.ready();
  sockets = []; frames = []; rejectAuth = false; rejectStream = false;rejectImage=false;uploadCount=0;
  server = new WebSocketServer({host: '127.0.0.1', port: 0}); await once(server, 'listening');
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()); frames.push(frame);
      const fail = (rejectAuth && frame.cmd === 'aibot_subscribe') || (rejectStream && frame.cmd === 'aibot_respond_msg') || (rejectImage&&frame.cmd==='aibot_send_msg'&&frame.body?.msgtype==='image');
      let body;
      if(frame.cmd==='aibot_upload_media_init')body={upload_id:'upload-'+(++uploadCount)};
      if(frame.cmd==='aibot_upload_media_finish')body={type:'image',media_id:'media-'+uploadCount};
      socket.send(JSON.stringify({headers: frame.headers, body, errcode: fail ? 40001 : 0, errmsg: fail ? 'secret echoed here bot-secret-do-not-expose' : 'ok'}));
    });
  });
  const address = server.address() as {port: number};
  manager = new WecomBotManager(options => new WSClient({...options, wsUrl: `ws://127.0.0.1:${address.port}`, reconnectInterval: 10, maxAuthFailureAttempts: 1}));
  worker = new PlatformAiWorker(app);
});
afterEach(async () => {
  manager.stop(); await worker.stop();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await app.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup();
});

function bot(id = 'bot-1') {
  return saveChannel({name: '开发助手', kind: 'wecom_bot', enabled: true, config: {bot_id: id}, secrets: {bot_secret: 'bot-secret-do-not-expose'}});
}
function bind(channel: string, external = 'wx-member', user = member) {
  getDb().prepare('INSERT INTO platform_ai_bindings (id,channel_id,external_user_id,user_id) VALUES (?,?,?,?)').run(`${channel}:${external}`, channel, external, user);
}
function inbound(id = 'msg-1', user = 'wx-member', group?: string) {
  return {cmd: 'aibot_msg_callback', headers: {req_id: `request-${id}`}, body: {
    msgid: id, aibotid: 'bot-1', chattype: group ? 'group' : 'single', chatid: group, from: {userid: user}, msgtype: 'text', text: {content: '列出项目'},
  }};
}
function send(frame = inbound()) { sockets.at(-1)!.send(JSON.stringify(frame)); }
async function connected(id: string) { await expect.poll(() => getBotTransport(id)?.status.state).toBe('connected'); }
function groupWebhook() {
  return saveChannel({name: '开发通知群', kind: 'wecom_webhook', enabled: true, config: {}, secrets: {webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=group-key-private'}});
}
function subscribe(channel: string, user = member) {
  getDb().prepare('INSERT INTO platform_ai_notification_targets (id,channel_id,user_id) VALUES (?,?,?)').run(`${channel}:${user}`, channel, user);
}
function webConversation() {
  const result = receiveMessage({userId: member, externalUserId: member, chatId: 'web-test', messageId: 'web-1', content: '任务'});
  getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
  return result.conversation_id;
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CsAAAAAASUVORK5CYII=', 'base64');
function imageFixture() {
  const key = randomBytes(32), padding = 32 - png.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0,16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([png, Buffer.alloc(padding,padding)])), cipher.final()]);
  return {source: {url: 'https://wework.qpic.cn/private-test-image?token=private-download-token', aeskey: key.toString('base64')}, encrypted};
}

describe('WeCom outbound screenshot delivery',()=>{
 it('sends a single image/text template card using the existing authenticated connection',async()=>{
  const channel=bot();bind(channel.id);manager.start();await connected(channel.id);
  const result=await manager.testImageCard(channel.id,member,`binding:${channel.id}:wx-member`);
  expect(result.ok).toBe(true);
  const sends=frames.filter(frame=>frame.cmd==='aibot_send_msg');expect(sends).toHaveLength(1);
  expect(sends[0].body).toMatchObject({chatid:'wx-member',msgtype:'template_card',template_card:{card_type:'news_notice',card_image:{url:expect.stringMatching(/^https:\/\/wwcdn\.weixin\.qq\.com\//)},vertical_content_list:expect.arrayContaining([expect.objectContaining({title:'正文示例'})])}});
  expect(frames.filter(frame=>frame.cmd==='aibot_subscribe')).toHaveLength(1);
 });
 it('rejects a test-card recipient belonging to another user before sending',async()=>{
  const channel=bot();bind(channel.id,'wx-other',other);manager.start();await connected(channel.id);
  await expect(manager.testImageCard(channel.id,member,`binding:${channel.id}:wx-other`)).rejects.toThrow('当前用户');
  expect(frames.filter(frame=>frame.cmd==='aibot_send_msg')).toHaveLength(0);
 });
 it('requires existing administration permissions and a supported card destination',async()=>{
  const channel=bot(),payload={mode:'image_card',recipient_id:'binding:fixture'};
  expect((await app.inject({method:'POST',url:`/api/platform-ai/channels/${channel.id}/test`,headers:{cookie:memberCookie},payload})).statusCode).toBe(403);
  const group=groupWebhook();expect((await app.inject({method:'POST',url:`/api/platform-ai/channels/${group.id}/test`,headers:{cookie:adminCookie},payload})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`/api/platform-ai/channels/${channel.id}/test`,headers:{cookie:adminCookie},payload:{mode:'image_card'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`/api/platform-ai/channels/${channel.id}/test`,headers:{cookie:adminCookie},payload:{...payload,image_url:'http://localhost/private'}})).statusCode).toBe(400);
 });
 async function imageNotice(count=2){
  const channel=bot();bind(channel.id);manager.start();await connected(channel.id);
  const root=join(databaseDir,'image-project');mkdirSync(root);
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('image-project','Images',?,?)").run(root,member);
  setProjectToolAccess({projectId:'image-project',userId:member,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:admin});
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('image-tab','image-project','Work','running','session','codex','native-image',?)").run(member);
  const conversation=receiveMessage({userId:member,channelId:channel.id,externalUserId:'wx-member',chatId:'wx-member',messageId:'image-initial',content:'work'}).conversation_id;
  getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
  const task=trackTask(getConversation(conversation)!,'image-tab','work',0,'image-turn');getDb().prepare("UPDATE platform_ai_tasks SET status='reported_complete' WHERE id=?").run(task.id);
  const files=Array.from({length:count},(_,index)=>join(root,`screen-${index}.png`));files.forEach(file=>writeFileSync(file,png));
  enqueueNotice(conversation,`task:${task.id}:images`,'**Images / Work**\n\nCI 已通过。\n'+files.map(file=>`[查看正式截图](${file})`).join('\n'),{notification_target:notificationReplyTarget('image-tab','ref:image-turn')});
  return {channel,files};
 }
 async function tick(count=1){for(let n=0;n<count;n++){worker.tick();await worker.drain();}}
 const messages=()=>frames.filter(frame=>frame.cmd==='aibot_send_msg');
 const imageRows=()=>getDb().prepare("SELECT * FROM platform_ai_outbox WHERE json_extract(reply_context,'$.outbound_image') IS NOT NULL ORDER BY rowid").all() as any[];
 it('uploads actual bytes through the SDK and sends ordered image messages after readable Markdown',async()=>{
  const {channel,files}=await imageNotice();await tick(3);
  expect(messages().map(frame=>frame.body.msgtype)).toEqual(['markdown','image','image']);
  expect(messages()[0].body.markdown.content).toContain('CI 已通过');expect(messages()[0].body.markdown.content).not.toContain(files[0]);
  expect(messages()[0].body.markdown.content).toContain('图片见下方');
  expect(frames.filter(frame=>frame.cmd==='aibot_upload_media_chunk').every(frame=>Buffer.from(frame.body.base64_data,'base64').equals(png))).toBe(true);
  expect(uploadCount).toBe(2);expect(imageRows().map(row=>row.status)).toEqual(['sent','sent']);
  expect(quotedReplyRoute(messages()[0].body.markdown.content,{channelId:channel.id,externalUserId:'wx-member',chatId:'wx-member'})).toBeTruthy();
 });
 it('retries only the unacknowledged image after worker recovery, reusing its uploaded media',async()=>{
  await imageNotice();rejectImage=true;await tick(2);
  expect(imageRows().map(row=>row.status)).toEqual(['pending','pending']);expect(uploadCount).toBe(1);
  expect(imageRows()[0].error).toContain('未获确认');expect(imageRows()[0].error).not.toContain('bot-secret');
  await worker.stop();worker=new PlatformAiWorker(app);rejectImage=false;
  getDb().prepare("UPDATE platform_ai_outbox SET available_at=0 WHERE status='pending'").run();await tick(2);
  expect(messages().filter(frame=>frame.body.msgtype==='markdown')).toHaveLength(1);
  expect(uploadCount).toBe(2);expect(imageRows().map(row=>row.status)).toEqual(['sent','sent']);
  expect(messages().filter(frame=>frame.body.msgtype==='image').map(frame=>frame.body.image.media_id)).toEqual(['media-1','media-1','media-2']);
 });
 it('rechecks session authorization before upload and sends no image after revocation',async()=>{
  await imageNotice();await tick();
  setProjectToolAccess({projectId:'image-project',userId:member,canSession:false,canTerminal:false,sessionClients:[],grantedBy:admin});await tick(3);
  expect(uploadCount).toBe(0);expect(imageRows().every(row=>row.status==='failed')).toBe(true);
  expect(messages().map(frame=>frame.body.msgtype)).toEqual(['markdown']);
 });
 it('rechecks binding after asynchronous upload before sending any image',async()=>{
  const {channel}=await imageNotice(1);await tick();
  const transport=getBotTransport(channel.id)!,upload=transport.uploadImage!;
  vi.spyOn(transport,'uploadImage').mockImplementation(async(data,name)=>{const id=await upload(data,name);getDb().prepare('DELETE FROM platform_ai_bindings WHERE channel_id=?').run(channel.id);return id;});
  await tick();expect(uploadCount).toBe(1);expect(messages().filter(frame=>frame.body.msgtype==='image')).toHaveLength(0);expect(imageRows()[0].status).toBe('failed');
 });
 it('rechecks filesystem access after uploading an ordinary conversational image',async()=>{
  const {channel}=await imageNotice(1);
  getDb().prepare("UPDATE platform_ai_outbox SET dedupe_key='ordinary-image-reply'").run();await tick();
  const transport=getBotTransport(channel.id)!,upload=transport.uploadImage!;
  vi.spyOn(transport,'uploadImage').mockImplementation(async(data,name)=>{
   const id=await upload(data,name);
   getDb().prepare("UPDATE projects SET owner_id=? WHERE id='image-project'").run(other);
   getDb().prepare("DELETE FROM project_user_access WHERE project_id='image-project' AND user_id=?").run(member);
   return id;
  });
  await tick();expect(uploadCount).toBe(1);expect(messages().filter(frame=>frame.body.msgtype==='image')).toHaveLength(0);
  expect(imageRows()[0]).toMatchObject({status:'failed',error:expect.stringContaining('权限')});
 });
 it('does not replace a queued screenshot with changed file bytes and reports partial failure',async()=>{
  const {files}=await imageNotice();await tick();writeFileSync(files[0],Buffer.concat([png,Buffer.from('changed')]));await tick(3);
  expect(imageRows().map(row=>row.status)).toEqual(['failed','sent']);expect(imageRows()[0].error).toContain('已变化');
  expect(messages().filter(frame=>frame.body.msgtype==='image')).toHaveLength(1);
  expect(messages().filter(frame=>frame.body.markdown?.content.includes('截图未能发送'))).toHaveLength(1);
 });
 it('reuploads expired media without repeating the Markdown body',async()=>{
  await imageNotice(1);rejectImage=true;await tick(2);expect(uploadCount).toBe(1);
  getDb().prepare("UPDATE platform_ai_outbox SET available_at=0,reply_context=json_set(reply_context,'$.outbound_image.expires_at',0) WHERE json_extract(reply_context,'$.outbound_image') IS NOT NULL").run();
  rejectImage=false;await tick();expect(uploadCount).toBe(2);expect(imageRows()[0].status).toBe('sent');
  expect(messages().filter(frame=>frame.body.msgtype==='markdown')).toHaveLength(1);
 });
});

describe('project notification classification through the native adapter and WeCom SDK', () => {
  const sandboxIt = process.platform === 'linux' ? it : it.skip;
  sandboxIt('delivers the previously failing greeting as Markdown and preserves deduplication after recovery', async () => {
    const channel = bot(); bind(channel.id); manager.start(); await connected(channel.id);
    getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('notice-project','通知项目','/fixture',?)").run(member);
    setProjectToolAccess({projectId:'notice-project',userId:member,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:admin});
    getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('notice-tab','notice-project','文档','running','session','codex','native-notice',?)").run(member);
    const rule = saveProjectNotification(member, {project_id:'notice-project',recipient_id:`binding:${channel.id}:wx-member`,enabled:true,on_complete:true,on_input:true});
    expect(canNotifyProject(rule, 'notice-tab')).toBe(true);
    const text = '你好！有什么需要我帮忙的？\n\n- **文档**：[查看说明](https://example.com/docs)';
    const timestamp = new Date(Date.now()+1000).toISOString();
    let messages = [{role:'user',phase:'user',text:'你好',timestamp,task_reference:'notice-turn'}, {role:'assistant',phase:'final',text,timestamp,task_reference:'notice-turn'}];
    const api = vi.spyOn(platformTools, 'platformApi').mockImplementation(async (_app,_user,method,url,body) => {
      if(url.endsWith('/agent-messages')) return {messages};
      if(url.includes('/display')) return {processState:'idle',promptType:null,cursor:0};
      if(method==='GET' && url==='/api/sessions/notice-tab') return {session:getDb().prepare("SELECT * FROM sessions WHERE id='notice-tab'").get()};
      if(method==='POST' && url.endsWith('/input')) {
        const ref = String(body?.input).match(/\[Platform task reference: (quoted_[^\]]+)\]/)![1];
        messages = [{role:'user',phase:'user',text:'不用',timestamp,task_reference:ref}, {role:'assistant',phase:'final',text:'好的。',timestamp,task_reference:ref}];
        return {status:'submitted'};
      }
      throw Error('Unexpected fixture API '+url);
    });
    const adapter = join(databaseDir, 'classifier.cjs');
    writeFileSync(adapter, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
      const request=JSON.parse(input);
      const structured=request.response_schema.properties.kind && JSON.parse(request.messages.at(-1).content).agent_final_reply;
      console.log(JSON.stringify(structured?{kind:'input',evidence:'有什么需要我帮忙的？'}:{content:'你好！有什么需要我帮忙的？',tool_calls:[]}));
    });`);
    updateAiConfig({enabled:true,model:'fixture',source:{kind:'command',executable:process.execPath,arguments_json:JSON.stringify([adapter])}});
    vi.stubGlobal('fetch', vi.fn(() => {throw Error('No external HTTP expected');}));
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(getDb().prepare('SELECT failures,error FROM platform_ai_project_notification_watches WHERE rule_id=?').get(rule.id)).toEqual({failures:0,error:null});
    expect(getDb().prepare('SELECT status,error FROM platform_ai_outbox').all()).toEqual([expect.objectContaining({status:'sent',error:null})]);
    const sent = frames.filter(frame => frame.cmd === 'aibot_send_msg');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({chatid:'wx-member',msgtype:'markdown',markdown:{content:expect.stringContaining(`**通知项目 / 文档**\n\n${text}`)}});
    expect(sent[0].body.markdown.content).toBe(`**通知项目 / 文档**\n\n${text}`);
    expect(sent[0].body.markdown.content).not.toContain('AM-');
    expect(getDb().prepare('SELECT status,attempts,error FROM platform_ai_outbox').get()).toEqual({status:'sent',attempts:1,error:null});
    expect(getDb().prepare('SELECT failures,error FROM platform_ai_project_notification_watches WHERE rule_id=?').get(rule.id)).toEqual({failures:0,error:null});
    await worker.stop(); worker = new PlatformAiWorker(app);
    getDb().prepare('UPDATE platform_ai_project_notification_watches SET next_check_at=0').run();
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(frames.filter(frame => frame.cmd === 'aibot_send_msg')).toHaveLength(1);
    // A recovered native final may have a different timestamp for the same turn.
    messages[1] = {...messages[1], timestamp: new Date(Date.parse(timestamp)+5000).toISOString()};
    getDb().prepare('UPDATE platform_ai_project_notification_watches SET next_check_at=0').run();
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(frames.filter(frame => frame.cmd === 'aibot_send_msg')).toHaveLength(1);
    // History may contain the final alone, without any recoverable turn ID.
    messages = [{...messages[1], task_reference: '', timestamp: new Date(Date.parse(timestamp)+10000).toISOString()}];
    getDb().prepare('UPDATE platform_ai_project_notification_watches SET next_check_at=0').run();
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(frames.filter(frame => frame.cmd === 'aibot_send_msg')).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();

    messages = [{role:'user',phase:'user',text:'你好',timestamp,task_reference:'notice-turn'}, {role:'assistant',phase:'final',text,timestamp,task_reference:'notice-turn'}];
    // Real WeCom strips bold markup and turns Markdown list hyphens into dots.
    const renderedQuote=sent[0].body.markdown.content.replace(/\*\*([^*]+)\*\*/g,'$1').replace(/^- /gm,'· ');
    send({...inbound('project-reply'),body:{...inbound('project-reply').body,text:{content:'不用'},quote:{msgtype:'text',text:{content:renderedQuote}}}} as any);
    await expect.poll(() => getDb().prepare("SELECT count(*) n FROM platform_ai_messages WHERE external_id='project-reply'").get()).toEqual({n:1});
    for(let tick=0;tick<4;tick++){worker.tick();await worker.drain();}
    expect(api.mock.calls.filter(call=>call[2]==='POST')).toHaveLength(1);
    expect(api.mock.calls.find(call=>call[2]==='POST')![4]?.input).toMatch(/^不用\n\n\[Platform task reference: quoted_/);
    const followups = frames.filter(frame=>frame.cmd==='aibot_send_msg');
    expect(followups).toHaveLength(2);
    expect(followups[1].body).toMatchObject({msgtype:'markdown',markdown:{content:'**通知项目 / 文档**\n\n好的。'}});
    expect(getDb().prepare("SELECT count(*) n FROM platform_ai_outbox WHERE status='sent'").get()).toEqual({n:2});
  });
});

describe('WeCom quoted notification direct routing',()=>{
 it.each(['text','mixed'])('delivers a prefixed notice and routes a %s quote through the quick lane, deduplicating WebSocket replay',async quoteType=>{
  const channel=bot();bind(channel.id);manager.start();await connected(channel.id);
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('quick-project','Project','/fixture',?)").run(member);
  setProjectToolAccess({projectId:'quick-project',userId:member,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:admin});
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('quick-tab','quick-project','Work','running','session','codex','native-quick',?)").run(member);
  const received=receiveMessage({userId:member,channelId:channel.id,externalUserId:'wx-member',chatId:'wx-member',messageId:'original',content:'work'});
  getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
  const task=trackTask(getConversation(received.conversation_id)!,'quick-tab','work',0,'turn-quick');
  getDb().prepare("UPDATE platform_ai_tasks SET status='reported_complete' WHERE id=?").run(task.id);
  enqueueNotice(received.conversation_id,`task:${task.id}:done`,'是否使用测试环境？',{notification_target:notificationReplyTarget('quick-tab','ref:turn-quick')});
  worker.tick();await worker.drain();
  const notification=frames.find(frame=>frame.cmd==='aibot_send_msg').body.markdown.content;
  expect(notification).toBe('**Project / Work**\n\n是否使用测试环境？');
  const api=vi.spyOn(platformTools,'platformApi').mockImplementation(async(_app,_user,method,url)=>{
   if(url.endsWith('/agent-messages'))return {messages:[{role:'user',phase:'user',text:'work',timestamp:null,task_reference:'turn-quick'}]};
   if(url.includes('/display'))return {processState:'idle',promptType:null,cursor:0};
   if(method==='POST'&&url.endsWith('/input'))return {status:'submitted'};
   throw Error('Unexpected test API '+url);
  });
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No model expected');}));
  const frame={...inbound('direct-reply'),body:{...inbound('direct-reply').body,text:{content:'使用测试环境'},quote:quoteType==='text'?{msgtype:'text',text:{content:notification}}:{msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:notification}}]}}}};
  send(frame as any);send(frame as any);
  await expect.poll(()=>getDb().prepare("SELECT count(*) n FROM platform_ai_messages WHERE external_id='direct-reply'").get()).toEqual({n:1});
  expect((getDb().prepare("SELECT content FROM platform_ai_messages WHERE external_id='direct-reply'").get() as any).content).toBe('使用测试环境');
  worker.tick();await worker.drain();
  const input=api.mock.calls.find(call=>call[2]==='POST')!;expect(input[3]).toBe('/api/sessions/quick-tab/input');expect(input[4]?.input).toMatch(/^使用测试环境\n\n\[Platform task reference:/);expect(fetch).not.toHaveBeenCalled();
  worker.tick();await worker.drain();
  expect(frames.some(frame=>frame.cmd==='aibot_respond_msg'&&frame.headers.req_id==='request-direct-reply')).toBe(false);
  expect(getDb().prepare("SELECT count(*) n FROM platform_ai_outbox WHERE dedupe_key LIKE 'reply:%'").get()).toEqual({n:0});
 });
 it.each(['success','image-only','download-failed','copy-failed'])('routes quoted images without dropping them: %s',async outcome=>{
  const channel=bot();bind(channel.id);manager.start();await connected(channel.id);
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('quick-project','Project','/fixture',?)").run(member);
  setProjectToolAccess({projectId:'quick-project',userId:member,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:admin});
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('quick-tab','quick-project','Work','running','session','codex','native-quick',?)").run(member);
  const received=receiveMessage({userId:member,channelId:channel.id,externalUserId:'wx-member',chatId:'wx-member',messageId:'original',content:'work'});
  getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
  const task=trackTask(getConversation(received.conversation_id)!,'quick-tab','work',0,'turn-quick');
  getDb().prepare("UPDATE platform_ai_tasks SET status='reported_complete' WHERE id=?").run(task.id);
  enqueueNotice(received.conversation_id,`task:${task.id}:done`,'请确认',{notification_target:notificationReplyTarget('quick-tab','ref:turn-quick')});
  worker.tick();await worker.drain();
  const notification=frames.find(frame=>frame.cmd==='aibot_send_msg').body.markdown.content;
  const image=imageFixture();
  const fetch=vi.fn(async()=>outcome==='download-failed'?new Response('',{status:500}):new Response(image.encrypted,{status:200}));vi.stubGlobal('fetch',fetch);
  const copy=vi.spyOn(platformTools,'copyImagesToSession').mockImplementation(async(_app,_user,_session,images)=>{
    expect(images).toEqual([expect.objectContaining({mime:'image/png',data:png})]);
    if(outcome==='copy-failed')throw Error('copy failed');
    return '\n\n图片 1：/fixture/paste.png';
  });
  const api=vi.spyOn(platformTools,'platformApi').mockImplementation(async(_app,_user,method,url)=>{
    if(url.endsWith('/agent-messages'))return {messages:[{role:'user',text:'work',task_reference:'turn-quick'}]};
    if(url.includes('/display'))return {processState:'idle',promptType:null,cursor:0};
    if(method==='POST'&&url.endsWith('/input'))return {status:'submitted'};
    throw Error('Unexpected test API '+url);
  });
  const frame={...inbound('quoted-image'),body:{...inbound('quoted-image').body,...(outcome==='image-only'?{msgtype:'image',text:undefined,image:image.source}:{msgtype:'mixed',text:undefined,mixed:{msg_item:[{msgtype:'text',text:{content:'参考这张图'}},{msgtype:'image',image:image.source}]}}),quote:{msgtype:'text',text:{content:notification}}}};
  send(frame as any);send(frame as any);
  await expect.poll(()=>getDb().prepare("SELECT count(*) n FROM platform_ai_messages WHERE external_id='quoted-image' AND role='user'").get()).toEqual({n:1});
  worker.tick();await worker.drain();
  const inputs=api.mock.calls.filter(call=>call[2]==='POST'&&call[3].endsWith('/input'));
  if(outcome==='success'||outcome==='image-only'){
    expect(inputs).toHaveLength(1);expect(inputs[0][4]?.input).toContain(outcome==='image-only'?'请查看我发送的图片。':'参考这张图');expect(inputs[0][4]?.input).toContain('/fixture/paste.png');expect(copy).toHaveBeenCalledTimes(1);
  }else{
    expect(inputs).toHaveLength(0);const reply=getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='assistant' AND external_id=(SELECT id FROM platform_ai_messages WHERE external_id='quoted-image' AND role='user')").get() as {content:string};
    expect(reply.content).toContain('文字和图片均未投递');
  }
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('saves image bytes through the authenticated session attachment API',async()=>{
  const target=Fastify();let received:unknown;
  target.post('/api/sessions/:id/paste-image',async request=>{received=request.body;return {path:'/fixture/image.png'};});
  try{
    const prompt=await platformTools.copyImagesToSession(target,member,'quick-tab',[{mime:'image/png',data:png}]);
    expect(received).toEqual({dataUrl:`data:image/png;base64,${png.toString('base64')}`});expect(prompt).toContain('/fixture/image.png');
  }finally{await target.close();}
 });
 it('rejects a quote without a routing prefix instead of guessing or invoking a model',async()=>{
  const channel=bot();bind(channel.id);manager.start();await connected(channel.id);
  const frame={...inbound('invalid-quote'),body:{...inbound('invalid-quote').body,quote:{msgtype:'text',text:{content:'没有标识的旧通知'}}}};
  send(frame as any);await expect.poll(()=>frames.some(frame=>frame.body?.stream?.content?.includes('没有可识别的通知关联'))).toBe(true);
  expect(getDb().prepare("SELECT count(*) n FROM platform_ai_messages WHERE status='failed'").get()).toEqual({n:1});
  expect(getDb().prepare("SELECT content,reply_context FROM platform_ai_messages WHERE status='failed'").get()).toMatchObject({content:'列出项目',reply_context:expect.stringContaining('没有标识的旧通知')});
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);worker.tick();await worker.drain();expect(fetchMock).not.toHaveBeenCalled();
 });
});

describe('WeCom image and mixed-message ingestion', () => {
  it('lets a worker cancel its wait on a shared image download without cancelling the receiver',async()=>{
    const channel=bot();bind(channel.id);manager.start();await connected(channel.id);
    const image=imageFixture();let complete!:(response:Response)=>void;
    const fetch=vi.fn(()=>new Promise<Response>(resolve=>{complete=resolve;}));vi.stubGlobal('fetch',fetch);
    send({...inbound('shared-image'),body:{...inbound('shared-image').body,msgtype:'image',text:undefined,image:image.source}} as any);
    await expect.poll(()=>fetch.mock.calls.length).toBe(1);
    const message=getDb().prepare("SELECT id FROM platform_ai_messages WHERE external_id='shared-image'").get() as {id:string};
    const controller=new AbortController();const waiting=prepareImages(message.id,controller.signal);controller.abort();
    await expect(waiting).rejects.toThrow('图片接收已暂停');
    complete(new Response(image.encrypted,{status:200}));
    await expect.poll(()=>messageAttachments(message.id)[0].status).toBe('ready');
  });
  it('persists, decrypts and displays a mixed message, feeds the model real image bytes, and deduplicates replay', async () => {
    const channel = bot(); bind(channel.id); manager.start(); await connected(channel.id);
    const image = imageFixture();
    const modelBodies: any[] = [];
    const fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === image.source.url) return new Response(image.encrypted, {status: 200});
      modelBodies.push(JSON.parse(String(options?.body)));
      return new Response(JSON.stringify({choices: [{message: {role: 'assistant', content: '图片已收到，请说明要修改的项目。'}}]}), {status: 200});
    }); vi.stubGlobal('fetch', fetch);
    const frame = {...inbound('with-image'), body: {...inbound('with-image').body, msgtype: 'mixed', text: undefined, mixed: {msg_item: [
      {msgtype: 'text', text: {content: '请根据截图分析'}}, {msgtype: 'image', image: image.source},
    ]}}};
    send(frame as any); send(frame as any);
    await expect.poll(() => getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_attachments WHERE status='ready'").get()).toEqual({n: 1});
    const message = getDb().prepare('SELECT id,conversation_id,content FROM platform_ai_messages').get() as {id: string; conversation_id: string; content: string};
    const attachment = messageAttachments(message.id)[0];
    expect(message.content).toBe('请根据截图分析');
    const conversation = await app.inject({url: `/api/platform-ai/conversations/${message.conversation_id}`, headers: {cookie: memberCookie}});
    expect(conversation.json().messages[0].attachments).toEqual([expect.objectContaining({id: attachment.id, mime: 'image/png', status: 'ready'})]);
    expect(conversation.body).not.toContain('private-download-token'); expect(conversation.body).not.toContain(image.source.aeskey);
    expect(conversation.body).not.toContain(png.toString('base64'));
    const url = `/api/platform-ai/attachments/${attachment.id}`;
    const viewed = await app.inject({url, headers: {cookie: memberCookie}});
    expect(viewed.headers['content-type']).toContain('image/png'); expect(viewed.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url, headers: {cookie: adminCookie}})).statusCode).toBe(404);
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    const content = modelBodies[0].messages.find((message: any) => message.role === 'user').content;
    expect(content).toEqual([expect.objectContaining({type: 'text'}), {type: 'image_url', image_url: {url: `data:image/png;base64,${png.toString('base64')}`}}]);
    expect(modelBodies[0].messages.some((message: any) => message.attachment_ids)).toBe(false);
    expect(fetch.mock.calls.filter(call => call[0] === image.source.url)).toHaveLength(1);
    expect(frames.some(frame => frame.body?.stream?.finish && frame.body.stream.content.includes('图片已收到'))).toBe(true);
    const stored = getDb().prepare('SELECT context FROM platform_ai_conversations').get() as {context: string};
    expect(stored.context).toContain(attachment.id); expect(stored.context).not.toContain(png.toString('base64'));
    await prepareImages(message.id); expect(fetch.mock.calls.filter(call => call[0] === image.source.url)).toHaveLength(1);
  });

  it('keeps image-only messages and falls back honestly when a text-only model rejects vision input', async () => {
    const channel = bot(); bind(channel.id); manager.start(); await connected(channel.id);
    const image = imageFixture(); let textCalls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === image.source.url) return new Response(image.encrypted, {status: 200});
      const body = JSON.parse(String(options?.body));
      if (body.messages.some((message: any) => Array.isArray(message.content))) return new Response('{}', {status: 400});
      textCalls++;
      expect(body.messages.at(-1).content).toContain('不得猜测图片内容');
      expect(body.messages[0].content).not.toContain('当前模型接口拒绝图片输入');
      return new Response(JSON.stringify({choices: [{message: {role: 'assistant', content: '原图已保存，可交给工作 Agent 查看。'}}]}), {status: 200});
    }));
    send({...inbound('image-only'), body: {...inbound('image-only').body, msgtype: 'image', text: undefined, image: image.source}} as any);
    await expect.poll(() => getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_attachments WHERE status='ready'").get()).toEqual({n: 1});
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(getDb().prepare("SELECT status FROM platform_ai_messages WHERE role='user'").get()).toEqual({status: 'done'});
    expect(textCalls).toBe(1);
    expect((getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='assistant'").get() as {content: string}).content).toContain('当前模型接口未接受图像输入');
    expect(frames.some(frame => frame.body?.stream?.finish && frame.body.stream.content.includes('图片已保存'))).toBe(true);
  });

  it('retains failed image records without leaking temporary media credentials or downloading unbound users images', async () => {
    const channel = bot(); manager.start(); await connected(channel.id); const image = imageFixture();
    const fetch = vi.fn().mockRejectedValue(new Error(image.source.url + image.source.aeskey)); vi.stubGlobal('fetch', fetch);
    const frame = {...inbound('unbound-image'), body: {...inbound('unbound-image').body, msgtype: 'image', text: undefined, image: image.source}};
    send(frame as any);
    await expect.poll(() => frames.some(frame => frame.body?.stream?.content?.includes('尚未绑定'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    bind(channel.id); send({...frame, headers: {req_id: 'bound-image'}, body: {...frame.body, msgid: 'bound-image'}} as any);
    await expect.poll(() => getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_attachments WHERE status='failed'").get()).toEqual({n: 1});
    const attachment = getDb().prepare('SELECT id,message_id,source,error FROM platform_ai_attachments').get() as {id: string; message_id: string; source: string; error: string};
    expect(attachment.source).toBe(''); expect(attachment.error).toContain('请重新发送'); expect(attachment.error).not.toContain('private-download-token');
    expect((await app.inject({url: `/api/platform-ai/attachments/${attachment.id}`, headers: {cookie: memberCookie}})).statusCode).toBe(404);
    for (const url of ['http://127.0.0.1/image','https://example.com/image','https://wework.qpic.cn.evil.example/image']) {
      expect(() => validateImageSource({url, aesKey: image.source.aeskey})).toThrow('媒体服务');
    }
  });
});

describe('WeCom bot transport with the real official SDK and a local WebSocket peer', () => {
  it('runs the durable inbox/model/outbox flow and delivers the reply without any extra model calls for notifications', async () => {
    const channel = bot(); bind(channel.id); manager.start(); await connected(channel.id);
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({choices: [{message: {role: 'assistant', content: '项目查询结果'}}]}), {status: 200}));
    vi.stubGlobal('fetch', fetch);
    send(); await expect.poll(() => frames.some(frame => frame.body?.stream)).toBe(true);
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(frames.some(frame => frame.body?.stream?.content === '项目查询结果' && frame.body.stream.finish)).toBe(true);
    const conversation = (getDb().prepare('SELECT id FROM platform_ai_conversations').get() as {id: string}).id;
    enqueueNotice(conversation, 'task:fixture:blocked', '需要你确认接口字段');
    worker.tick(); await worker.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)).toMatchObject({cmd: 'aibot_send_msg', body: {markdown: {content: '需要你确认接口字段'}}});
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_outbox WHERE status='sent'").get()).toEqual({n: 2});
  });
  it('authenticates once, records unbound identities without content, deduplicates input and streams the final answer', async () => {
    const channel = bot(); manager.start(); await connected(channel.id);
    expect(await manager.test(channel.id)).toMatchObject({ok: true});
    expect(frames.filter(frame => frame.cmd === 'aibot_subscribe')).toHaveLength(1);
    expect(frames[0].body).toMatchObject({bot_id: 'bot-1', secret: 'bot-secret-do-not-expose'});
    send();
    await expect.poll(() => frames.filter(frame => frame.body?.stream?.content?.includes('尚未绑定')).length).toBe(1);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get()).toEqual({n: 0});
    const listing = await app.inject({url: '/api/platform-ai/channels', headers: {cookie: adminCookie}});
    expect(listing.json().senders).toEqual([expect.objectContaining({external_user_id: 'wx-member'})]);
    expect(listing.body).not.toContain('bot-secret'); expect(listing.body).not.toContain('列出项目');
    bind(channel.id); send(inbound('bound')); send(inbound('bound'));
    await expect.poll(() => (getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get() as any).n).toBe(1);
    const message = getDb().prepare('SELECT id,reply_context FROM platform_ai_messages').get() as {id: string; reply_context: string};
    getDb().prepare("UPDATE platform_ai_messages SET status='processing',partial_content='**当前有两个项目**',progress='生成中' WHERE id=?").run(message.id);
    publishMessage(message.id);
    await expect.poll(() => frames.some(frame => frame.body?.stream?.content === '**当前有两个项目**'), {timeout: 3000}).toBe(true);
    const final = '最终回复：项目列表';
    await deliverMessage(getChannel(channel.id)!, 'wx-member', 'wx-member', final, JSON.parse(message.reply_context), 'reply-1');
    const finished = frames.filter(frame => frame.body?.stream?.finish && frame.body?.stream?.content === final);
    expect(finished).toHaveLength(1); expect(finished[0].headers.req_id).toBe('request-bound');
    await deliverMessage(getChannel(channel.id)!, 'wx-member', 'wx-member', '任务已完成', {}, 'task-1');
    expect(frames.at(-1)).toMatchObject({cmd: 'aibot_send_msg', body: {chatid: 'wx-member', msgtype: 'markdown', markdown: {content: '任务已完成'}}});
  });

  it('isolates group senders and stops live output when their binding is revoked', async () => {
    const channel = bot(); bind(channel.id); bind(channel.id, 'wx-other', other);
    manager.start(); await connected(channel.id);
    send(inbound('first', 'wx-member', 'group-1')); send(inbound('second', 'wx-other', 'group-1'));
    await expect.poll(() => (getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_conversations').get() as any).n).toBe(2);
    const message = getDb().prepare("SELECT id FROM platform_ai_messages WHERE external_id='first'").get() as {id: string};
    await expect.poll(() => frames.filter(frame => frame.cmd === 'aibot_respond_msg').length).toBe(2);
    getDb().prepare('DELETE FROM platform_ai_bindings WHERE channel_id=? AND external_user_id=?').run(channel.id, 'wx-member');
    getDb().prepare("UPDATE platform_ai_messages SET status='processing',partial_content='不得再发送的私密内容' WHERE id=?").run(message.id);
    publishMessage(message.id);
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(JSON.stringify(frames)).not.toContain('不得再发送的私密内容');
    const forged = inbound('wrong-bot'); forged.body.aibotid = 'other-bot'; send(forged);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get()).toEqual({n: 2});
  });

  it('reconnects after a lost socket and sends pending answers actively without re-running the request', async () => {
    const channel = bot(); bind(channel.id); manager.start(); await connected(channel.id); send();
    await expect.poll(() => frames.some(frame => frame.body?.stream)).toBe(true);
    const message = getDb().prepare('SELECT reply_context FROM platform_ai_messages').get() as {reply_context: string};
    sockets.at(-1)!.terminate();
    await expect.poll(() => sockets.length).toBe(2); await connected(channel.id);
    send(); await new Promise(resolve => setTimeout(resolve, 50));
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get()).toEqual({n: 1});
    await deliverMessage(getChannel(channel.id)!, 'wx-member', 'wx-member', '恢复后的结果', JSON.parse(message.reply_context), 'reply-1');
    expect(frames.at(-1)).toMatchObject({cmd: 'aibot_send_msg', body: {markdown: {content: '恢复后的结果'}}});
    saveChannel({name: channel.name, kind: channel.kind, enabled: false, config: {}, secrets: {}}, channel.id);
    expect(getBotTransport(channel.id)).toBeUndefined();
  });

  it('falls back to active sending when a temporary stream is rejected', async () => {
    const channel = bot(); bind(channel.id); manager.start(); await connected(channel.id); send();
    await expect.poll(() => frames.some(frame => frame.body?.stream)).toBe(true);
    rejectStream = true;
    const message = getDb().prepare('SELECT reply_context FROM platform_ai_messages').get() as {reply_context: string};
    await deliverMessage(getChannel(channel.id)!, 'wx-member', 'wx-member', '最终内容', JSON.parse(message.reply_context), 'reply-1');
    expect(frames.at(-1)).toMatchObject({cmd: 'aibot_send_msg', body: {markdown: {content: '最终内容'}}});
  });

  it('stops reconnecting when displaced and exposes credential-safe authentication errors', async () => {
    const channel = bot(); manager.start(); await connected(channel.id);
    sockets[0].send(JSON.stringify({cmd: 'aibot_event_callback', headers: {req_id: 'displaced'}, body: {msgtype: 'event', event: {eventtype: 'disconnected_event'}}}));
    await expect.poll(() => getBotTransport(channel.id)?.status.state).toBe('displaced');
    await new Promise(resolve => setTimeout(resolve, 80)); expect(sockets).toHaveLength(1);
    rejectAuth = true; manager.reconnect(channel.id);
    await expect.poll(() => getBotTransport(channel.id)?.status.message).toContain('检查 Bot ID');
    const result = await app.inject({url: '/api/platform-ai/channels', headers: {cookie: adminCookie}});
    expect(result.body).not.toContain('bot-secret'); expect(result.body).not.toContain('echoed');
  });
});

describe('WeCom configuration, group subscriptions and migration', () => {
  it('protects bot/webhook credentials, preserves empty secret fields, and blocks invalid channel modes', async () => {
    const channel = bot();
    expect(() => bot()).toThrow('Bot ID');
    saveChannel({name: 'rename', kind: 'wecom_bot', enabled: true, config: {}, secrets: {bot_secret: ''}}, channel.id);
    expect(getChannel(channel.id)!.secrets.bot_secret).toBe('bot-secret-do-not-expose');
    const group = groupWebhook();
    expect(group.callback_path).toBeNull(); expect(channel.callback_path).toBeNull();
    const response = await app.inject({url: '/api/platform-ai/channels', headers: {cookie: adminCookie}});
    expect(response.body).not.toContain('group-key-private'); expect(response.body).not.toContain('bot-secret');
    expect(() => decodeCallback(getChannel(group.id)!, 'POST', {}, {}, '{}')).toThrow('HTTP');
    for (const value of ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a', 'https://example.com/cgi-bin/webhook/send?key=a', 'https://qyapi.weixin.qq.com/other?key=a']) {
      expect(() => saveChannel({name: 'invalid', kind: 'wecom_webhook', enabled: true, secrets: {webhook_url: value}})).toThrow('群机器人');
    }
    expect((await app.inject({method: 'POST', url: '/api/platform-ai/bindings', headers: {cookie: adminCookie}, payload: {channel_id: group.id, external_user_id: 'x', user_id: member}})).statusCode).toBe(400);
    expect((await app.inject({method: 'POST', url: `/api/platform-ai/channels/${group.id}/test`, headers: {cookie: memberCookie}, payload: {}})).statusCode).toBe(403);
  });

  it('tests group delivery without exposing the key and fans out task notices exactly once per target', async () => {
    const group = groupWebhook(); subscribe(group.id);
    const fetch = vi.fn().mockImplementation(async () => new Response('{"errcode":0}', {status: 200})); vi.stubGlobal('fetch', fetch);
    const test = await app.inject({method: 'POST', url: `/api/platform-ai/channels/${group.id}/test`, headers: {cookie: adminCookie}, payload: {}});
    expect(test.json().ok).toBe(true); expect(test.body).not.toContain('group-key-private');
    const conversation = webConversation();
    enqueueNotice(conversation, 'task:fixture:done', '任务完成内容'); enqueueNotice(conversation, 'task:fixture:done', '任务完成内容');
    enqueueNotice(conversation, 'message-failed:fixture', '普通对话失败');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_outbox WHERE destination_channel_id=?').get(group.id)).toEqual({n: 1});
    worker.tick(); await worker.drain(); worker.tick(); await worker.drain();
    expect(fetch).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(fetch.mock.calls[1][1].body);
    expect(payload).toEqual({msgtype: 'markdown', markdown: {content: '任务完成内容'}});
    const deliveries = await app.inject({url: '/api/platform-ai/deliveries', headers: {cookie: memberCookie}});
    expect(deliveries.json().deliveries.some((delivery: any) => delivery.channel_name === '开发通知群' && delivery.status === 'sent')).toBe(true);
  });

  it('revokes queued notifications when a subscription is removed and retries channel failures safely', async () => {
    const group = groupWebhook(); subscribe(group.id); const conversation = webConversation();
    enqueueNotice(conversation, 'task:fixture:done', '私密结果');
    getDb().prepare('DELETE FROM platform_ai_notification_targets').run();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    worker.tick(); await worker.drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status,error FROM platform_ai_outbox WHERE destination_channel_id=?').get(group.id)).toEqual({status: 'failed', error: '通知订阅已取消'});
    fetch.mockRejectedValue(new Error('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=group-key-private'));
    const test = await app.inject({method: 'POST', url: `/api/platform-ai/channels/${group.id}/test`, headers: {cookie: adminCookie}, payload: {}});
    expect(test.statusCode).toBe(502); expect(test.body).not.toContain('group-key-private');
    const compact = compactText('中文😀'.repeat(1000), 1850);
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(1850); expect(compact).not.toContain('\ufffd');
  });

  it('does not leak application secrets through failed connection tests or malformed upstream error codes', async () => {
    const appChannel = saveChannel({name: '应用', kind: 'wecom', enabled: true, config: {corp_id: 'corp', agent_id: '1001'}, secrets: {app_secret: 'application-private-secret', token: 'callback-token', aes_key: 'a'.repeat(43)}});
    const fetch = vi.fn().mockRejectedValue(new Error('gettoken?corpsecret=application-private-secret')); vi.stubGlobal('fetch', fetch);
    const test = () => app.inject({method: 'POST', url: `/api/platform-ai/channels/${appChannel.id}/test`, headers: {cookie: adminCookie}, payload: {}});
    let response = await test(); expect(response.statusCode).toBe(502); expect(response.body).not.toContain('application-private-secret');
    fetch.mockResolvedValueOnce(new Response('{"errcode":"application-private-secret"}', {status: 200}));
    response = await test(); expect(response.statusCode).toBe(502); expect(response.body).toContain('未知错误码'); expect(response.body).not.toContain('application-private-secret');
    fetch.mockResolvedValueOnce(new Response('invalid application-private-secret', {status: 200}));
    response = await test(); expect(response.statusCode).toBe(502); expect(response.body).not.toContain('application-private-secret');
  });

  it('uses Markdown for application and group deliveries and bounds multibyte messages', async () => {
    const group = groupWebhook();
    const application = saveChannel({name:'应用',kind:'wecom',enabled:true,config:{corp_id:'corp',agent_id:'1001'},secrets:{app_secret:'dummy',token:'callback',aes_key:'a'.repeat(43)}});
    const content = '**结果**\n\n- [查看说明](https://example.com/docs)\n' + '中文😀'.repeat(2000);
    const fetchMock = vi.fn().mockImplementation(async (url:string) => new Response(JSON.stringify(String(url).includes('gettoken')?{access_token:'fixture-token',expires_in:7200}:{errcode:0}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    for(const channel of [group,application]) {
      await deliverMessage(getChannel(channel.id)!, 'chat', 'wx-member', content, {}, 'markdown-test');
      const payload=JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
      expect(payload).toMatchObject({msgtype:'markdown',markdown:{content:expect.stringContaining('**结果**\n\n- [查看说明](https://example.com/docs)')}});
      expect(Buffer.byteLength(payload.markdown.content)).toBeLessThanOrEqual(channel.kind==='wecom_webhook'?4000:1850);
      expect(payload.markdown.content).not.toContain('\ufffd');
      expect(payload).not.toHaveProperty('text');
    }
  });

  it('migrates the old channel CHECK constraint without cascading away conversations, secrets or deliveries', () => {
    const channel = saveChannel({name: 'old', kind: 'webhook', enabled: true, config: {outbound_url: 'https://gateway.example'}, secrets: {signing_secret: 'a'.repeat(40)}});
    bind(channel.id);
    const result = receiveMessage({userId: member, channelId: channel.id, externalUserId: 'wx-member', chatId: 'old-chat', messageId: 'old-message', content: '保留历史'});
    enqueueNotice(result.conversation_id, 'old-notice', '保留通知');
    const secret = (getDb().prepare('SELECT secrets FROM platform_ai_channels WHERE id=?').get(channel.id) as {secrets: string}).secrets;
    getDb().pragma('foreign_keys = OFF');
    getDb().exec(`CREATE TABLE old_channels (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('webhook','wecom','wechat','qq')),enabled INTEGER NOT NULL DEFAULT 0,config TEXT NOT NULL DEFAULT '{}',secrets TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO old_channels SELECT * FROM platform_ai_channels; DROP TABLE platform_ai_channels; ALTER TABLE old_channels RENAME TO platform_ai_channels; PRAGMA user_version=15;`);
    closeDb(); initDb();
    expect(getDb().pragma('user_version', {simple: true})).toBe(29);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
    expect(getDb().pragma('foreign_keys', {simple: true})).toBe(1);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_bindings').get()).toEqual({n: 1});
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get()).toEqual({n: 2});
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_outbox').get()).toEqual({n: 1});
    expect((getDb().prepare('SELECT secrets FROM platform_ai_channels WHERE id=?').get(channel.id) as {secrets: string}).secrets).toBe(secret);
    expect(getChannel(channel.id)!.secrets.signing_secret).toBe('a'.repeat(40));
    expect(bot().kind).toBe('wecom_bot'); expect(groupWebhook().kind).toBe('wecom_webhook');
  });
});
