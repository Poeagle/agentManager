import Fastify from 'fastify';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {updateAiConfig} from '../src/services/platform-ai/config.js';
import {compactConversation} from '../src/services/platform-ai/context.js';
import {PLATFORM_SYSTEM_PROMPT, type ModelMessage} from '../src/services/platform-ai/model.js';
import * as scheduled from '../src/services/platform-ai/scheduled-observation.js';
import * as tools from '../src/services/platform-ai/tools.js';
import {getConversation, receiveMessage} from '../src/services/platform-ai/store.js';
import {PlatformAiWorker} from '../src/services/platform-ai/worker.js';
import {createTestDatabase} from './helpers/database.js';

let cleanup: () => void;
let worker: PlatformAiWorker;
let app: ReturnType<typeof Fastify>;
let userId: string;
beforeEach(() => {
  ({cleanup} = createTestDatabase());
  userId = createUser({username:'admin', password:'password1', role:'admin'}).id;
  updateAiConfig({enabled:true, endpoint:'https://model.example/v1', model:'test', api_key:'test-secret', max_tool_rounds:1});
  app = Fastify();
  worker = new PlatformAiWorker(app);
});
afterEach(async () => {
  await worker.stop(); await app.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup();
});
const reply = (message: unknown) => new Response(JSON.stringify({choices:[{message}]}));
const inbound = (content: string, messageId: string) => receiveMessage({userId, externalUserId:userId,chatId:'cache-test',messageId,content});

describe('stable platform conversation context', () => {
  it('retains history beyond twenty messages until the budget is exceeded', () => {
    const history: ModelMessage[] = Array.from({length:30}, (_,index) => ({role:index % 2 ? 'assistant':'user', content:String(index)}));
    expect(compactConversation(history)).toBe(history);
  });
  it('compacts in batches without orphaning tool results or discarding the latest user turn', () => {
    const turn = (id: string, size: number): ModelMessage[] => [
      {role:'user',content:id},
      {role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'read_tab',arguments:'{}'}}]},
      {role:'tool',tool_call_id:id,content:'x'.repeat(size)},
      {role:'assistant',content:'done'},
    ];
    const latest = turn('latest',1000);
    expect(compactConversation([...turn('old',40000),...turn('middle',33000),...latest])).toEqual(latest);
    const huge = turn('huge',70000);
    expect(compactConversation([...turn('old',1000),...huge])).toEqual(huge);
  });
  it('keeps tool schemas, timestamps and full tool history stable across rounds and later turns', async () => {
    vi.spyOn(tools,'executePlatformTool').mockResolvedValue({tabs:[{tab_name:'设计',status:'busy'}]});
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (_url: unknown, options: any) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1 || bodies.length === 3) return reply({content:null,tool_calls:[{id:'call-'+bodies.length,type:'function',function:{name:'list_project_tabs',arguments:'{}'}}]});
      return reply({content:'设计正在处理。'});
    });
    vi.stubGlobal('fetch',fetchMock);
    const first=inbound('查看进度','first');
    worker.tick(); await worker.drain();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].messages[0]).toEqual({role:'system',content:PLATFORM_SYSTEM_PROMPT});
    expect(bodies[1].messages.slice(0,2)).toEqual(bodies[0].messages);
    expect(bodies[1].tools).toEqual(bodies[0].tools);
    expect(bodies[1].tool_choice).toBe('none');
    const history=JSON.parse(getConversation(first.conversation_id)!.context);
    expect(history.map((message: ModelMessage)=>message.role)).toEqual(['user','assistant','tool','assistant']);
    expect(history[0].runtime_context).toContain('当前时间：');
    expect(history[0].content).toBe('查看进度');
    expect(bodies[0].messages[1]).not.toHaveProperty('runtime_context');
    inbound('再看一下','second'); worker.tick(); await worker.drain();
    expect(bodies).toHaveLength(4); // Prior tool calls do not consume the new turn's budget.
    expect(bodies[2].messages.slice(0,4)).toEqual(bodies[1].messages);
    expect(bodies[2].messages[4]).toEqual({role:'assistant',content:'设计正在处理。'});
    expect(tools.executePlatformTool).toHaveBeenCalledTimes(2);
    const raw=getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='user' ORDER BY rowid").all();
    expect(raw).toEqual([{content:'查看进度'},{content:'再看一下'}]);
  });
  it('checkpoints the runtime snapshot before inference and reuses it after a retry', async () => {
    const bodies: any[]=[];
    vi.stubGlobal('fetch',vi.fn(async (_url: unknown, options: any)=>{
      bodies.push(JSON.parse(options.body));
      return bodies.length===1 ? new Response('',{status:503}) : reply({content:'在。'});
    }));
    const received=inbound('在吗','retry'); worker.tick(); await worker.drain();
    expect(getDb().prepare('SELECT status FROM platform_ai_messages WHERE id=?').get(received.message_id)).toEqual({status:'queued'});
    getDb().prepare('UPDATE platform_ai_messages SET available_at=0 WHERE id=?').run(received.message_id);
    worker.tick(); await worker.drain();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });
  it('never includes another group sender’s history in a model request', async () => {
    const other=createUser({username:'other',password:'password1',role:'admin'}).id;
    const bodies: any[]=[];
    vi.stubGlobal('fetch',vi.fn(async (_url: unknown, options: any)=>{
      bodies.push(JSON.parse(options.body)); return reply({content:'收到。'});
    }));
    const send=(id: string, content: string, messageId: string, chatId='shared-group') => receiveMessage({userId:id,externalUserId:id,chatId,messageId,content});
    const first=send(userId,'仅属于甲的历史标记','a1');
    const second=send(other,'仅属于乙的历史标记','b1');
    expect(first.conversation_id).not.toBe(second.conversation_id);
    worker.tick(); await worker.drain();
    send(userId,'甲继续','a2'); send(other,'乙继续','b2');
    worker.tick(); await worker.drain();
    const requestFor=(text: string)=>bodies.find(body=>body.messages.at(-1).content.includes(text));
    expect(JSON.stringify(requestFor('甲继续'))).toContain('仅属于甲的历史标记');
    expect(JSON.stringify(requestFor('甲继续'))).not.toContain('仅属于乙的历史标记');
    expect(JSON.stringify(requestFor('乙继续'))).toContain('仅属于乙的历史标记');
    expect(JSON.stringify(requestFor('乙继续'))).not.toContain('仅属于甲的历史标记');
    const separateChat=send(userId,'另外一个群','a3','other-group');
    expect(separateChat.conversation_id).not.toBe(first.conversation_id);
    expect(getConversation(separateChat.conversation_id)!.context).toBe('[]');
  });
});

describe('platform queue fault isolation', () => {
  it('processes incoming chat when scheduled observation reconciliation throws', async () => {
    vi.spyOn(scheduled,'reconcileScheduledObservations').mockImplementation(()=>{throw new Error('broken optional schema');});
    vi.stubGlobal('fetch',vi.fn(async()=>reply({content:'在。'})));
    const received=inbound('在吗','isolated');
    expect(()=>worker.tick()).not.toThrow(); await worker.drain();
    expect(getDb().prepare('SELECT status FROM platform_ai_messages WHERE id=?').get(received.message_id)).toEqual({status:'done'});
  });
  it('continues delivery after task observation lookup fails', async () => {
    vi.spyOn(scheduled,'reconcileScheduledObservations').mockImplementation(()=>{});
    const received=inbound('在吗','outbox');
    getDb().prepare("UPDATE platform_ai_messages SET status='done' WHERE id=?").run(received.message_id);
    getDb().prepare("INSERT INTO platform_ai_outbox(id,conversation_id,dedupe_key,content) VALUES ('o',?,'o','在。')").run(received.conversation_id);
    const deliver=vi.spyOn(worker,'deliver').mockResolvedValue();
    getDb().exec('DROP TABLE platform_ai_tasks');
    worker.tick(); await worker.drain(); // The observation lane cannot block outbox delivery.
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
