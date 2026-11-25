import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdirSync,writeFileSync,renameSync} from 'fs';
import {join} from 'path';
import Fastify,{type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createSession,createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import {conversationMessageId,readConversation} from '../src/services/conversation-reader.js';
import {projectAttachmentDirectory} from '../src/services/attachment-storage.js';
import {nativeConversationInput,rememberConversationAttachments} from '../src/services/conversation-attachments.js';
import {parseBriefContext,prepareBriefSend} from '../src/shared/conversation-brief.js';

const id='019ff001-6666-7666-8666-666666666666';
let app:FastifyInstance,cleanup:()=>void,file:string,cookie:string,dbDirPath:string;
const binding={cli_type:'codex' as const,codex_session_id:id,claude_session_id:null,project_path:'/project'};
const line=(type:string,payload:unknown,stamp='2026-10-29T10:00:00Z')=>JSON.stringify({type,timestamp:stamp,payload})+'\n';
const user=(text:string,stamp?:string)=>line('event_msg',{type:'user_message',message:text},stamp);
const final=(text:string,stamp?:string)=>line('event_msg',{type:'task_complete',last_agent_message:text},stamp);
beforeEach(async()=>{
  const db=createTestDatabase();cleanup=db.cleanup;dbDirPath=db.dir;vi.stubEnv('CODEX_HOME',db.dir);mkdirSync(join(db.dir,'sessions'));
  file=join(db.dir,'sessions',`rollout-test-${id}.jsonl`);
  const owner=createUser({username:'chat-owner',password:'password1',role:'admin'});
  cookie=`agentmanager_session=${createSession(owner.id)}`;
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('p','Chat',?,?)").run(db.dir,owner.id);
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES ('chat','p','Task','completed','session','codex',?,?)").run(id,owner.id);
  app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});
});
afterEach(async()=>{await app.close();vi.unstubAllEnvs();cleanup();});
describe('public conversation pages',()=>{
  it('returns the initial public context with a recent page beyond the cold history window', async () => {
    const publicRules = '<environment_context>project runtime</environment_context>';
    const shared = '<octoally_shared_resources>\n说明可以显示。\n</octoally_shared_resources>';
    const developer = line('response_item', {
      type: 'message', id: 'startup-developer', role: 'developer',
      content: [{ type: 'input_text', text: shared + '\nPRIVATE_FIXTURE' }],
    });
    const padding = line('irrelevant_record', { text: 'a'.repeat(64 * 1024) }).repeat(40);
    const ordinary = line('response_item', {
      type: 'message', id: 'ordinary-user', role: 'user', content: [{ type: 'input_text', text: 'ordinary input' }],
    });
    writeFileSync(file, developer + user(publicRules) + user('<task_notification>execution notice</task_notification>') +
      ordinary + padding + final('latest answer'));
    const response = await app.inject({ url: '/api/sessions/chat/conversation?include_context=true&limit=1', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.messages.map((message: { text: string }) => message.text)).toEqual(['latest answer']);
    expect(page.startup_context.map((message: { text: string }) => message.text)).toEqual([shared, publicRules]);
    const incremental = await app.inject({ url: `/api/sessions/chat/conversation?after=${page.messages[0].id}`, headers: { cookie } });
    expect(incremental.json()).not.toHaveProperty('startup_context');
  });
  it('restores inherited messages from a paginated native fork',async()=>{
    const parent='019ff001-1111-7111-8111-111111111111';
    const record=(ordinal:number,type:string,payload:unknown)=>JSON.stringify({ordinal,type,payload})+'\n';
    const prefix=record(0,'session_meta',{id:parent})+record(1,'event_msg',{type:'user_message',message:'before switching'});
    writeFileSync(join(dbDirPath,'sessions',`rollout-${parent}.jsonl`),prefix+record(2,'event_msg',{type:'user_message',message:'other branch'}));
    writeFileSync(file,record(2,'session_meta',{id,history_base:{thread_id:parent,end_byte_offset:Buffer.byteLength(prefix),end_ordinal_exclusive:2}})+record(3,'event_msg',{type:'agent_message',message:'after switching'}));
    const page=await readConversation({...binding,agent_environment_id:'native'});
    expect(page.messages.map(message=>message.text)).toEqual(['before switching','after switching']);
  });
  it('links duplicate native record statistics to the displayed conclusion',async()=>{
    const contents=[{type:'output_text',text:'最终答复'}],turn='turn-stats';
    const usage={total_token_usage:{total_tokens:200},last_token_usage:{total_tokens:200,input_tokens:180,cached_input_tokens:50,output_tokens:20,reasoning_output_tokens:5}};
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn},'2026-10-29T10:00:00Z')+line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id:'answer',phase:'final_answer',content:contents}},'2026-10-29T10:01:04Z')+line('response_item',{type:'message',role:'assistant',id:'answer',phase:'final_answer',content:contents},'2026-10-29T10:01:04.001Z')+line('event_msg',{type:'token_count',info:usage},'2026-10-29T10:01:05Z')+line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:'最终答复'},'2026-10-29T10:01:06Z'));
    const page=await readConversation(binding);const answer=page.messages.find(message=>message.id===conversationMessageId(turn,'assistant','answer'));
    expect(answer).toBeDefined();expect(page.statistics?.find(stat=>stat.message_id===answer?.id)).toMatchObject({conclusion:{shared_messages:1,elapsed_ms:64000,tokens:{total_tokens:200}}});
  });
  it.each([false,true])('preserves an async notice as progress when a formal answer is present: %s',async(withFinal)=>{
    const turn='async-notice-turn';
    const content=[{type:'output_text',text:'期间给你的说明'}];
    const notice={type:'AgentMessage',id:'notice',delivery:'async',phase:'final_answer',content};
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn})+user('开始')+
      line('response_item',{type:'message',id:'progress',role:'assistant',phase:'commentary',
        content:[{type:'output_text',text:'先核对'}]})+
      line('event_msg',{type:'item_completed',turn_id:turn,item:notice})+
      line('response_item',{type:'message',id:'notice',role:'assistant',phase:'final_answer',content})+
      (withFinal?line('response_item',{type:'message',id:'answer',role:'assistant',phase:'final_answer',
        content:[{type:'output_text',text:'正式答复'}]}):'')+
      line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:withFinal?'正式答复':'期间给你的说明'}));
    const page=await readConversation(binding);
    expect(page.messages.filter(message=>message.role==='assistant').map(message=>[message.phase,message.text]))
      .toEqual([['commentary','先核对'],['commentary','期间给你的说明'],...(withFinal?[['final','正式答复']]:[])]);
  });
  it('returns a complete baseline when a history file is replaced even if its old cursor survives',async()=>{
    writeFileSync(file,user('第一问')+final('第一答'));
    const first=await readConversation(binding);const cursor=first.messages.at(-1)!.id;
    writeFileSync(file+'.replacement',user('第一问')+final('第一答')+user('第二问')+final('第二答'));
    renameSync(file+'.replacement',file);
    const result=await readConversation(binding,{after:cursor});
    expect(result.reset).toBe(true);expect(result.messages.map(m=>m.text)).toEqual(['第一问','第一答','第二问','第二答']);
  });
  it('rejects a thread UUID masquerading as a turn ID and merges event echoes within the real turn',async()=>{
    const start=(turn:string)=>line('event_msg',{type:'task_started',turn_id:turn});
    const answer=(turn:string,item:string)=>line('response_item',{type:'message',id:item,role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:'same answer'}]});
    const echo=line('event_msg',{type:'agent_message',turn_id:id,message:'same answer',phase:'final_answer'});
    writeFileSync(file,start('real-one')+answer('real-one','item-one')+echo+line('event_msg',{type:'task_complete',turn_id:'real-one'}));
    expect((await readConversation(binding)).messages).toMatchObject([{turn_id:'real-one',text:'same answer'}]);
    appendFileSync(file,start('real-two')+answer('real-two','item-two')+echo);
    const messages=(await readConversation(binding)).messages;expect(messages).toHaveLength(2);expect(messages.map(m=>m.turn_id)).toEqual(['real-one','real-two']);
  });
  it('binds legacy rollout messages to lifecycle turns so live and durable replies have one identity',async()=>{
    const answer=(id:string,text:string)=>line('response_item',{type:'message',id,role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]});
    const start=(turn:string)=>line('event_msg',{type:'task_started',turn_id:turn});
    const complete=(turn:string,text:string)=>line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:text});
    writeFileSync(file,start('mac-one')+user('你好？')+answer('answer-one','你好！想让我帮你做什么？')+complete('mac-one','你好！想让我帮你做什么？'));
    const first=await readConversation(binding),reply=first.messages.at(-1)!;
    expect(first.messages.filter(m=>m.role==='assistant')).toHaveLength(1);expect(reply).toMatchObject({id:conversationMessageId('mac-one','assistant','answer-one'),turn_id:'mac-one'});
    appendFileSync(file,start('mac-two')+user('再说一次')+answer('answer-two','你好！想让我帮你做什么？'));
    const delta=await readConversation(binding,{after:reply.id});expect(delta.reset).toBe(false);expect(delta.messages.at(-1)).toMatchObject({id:conversationMessageId('mac-two','assistant','answer-two'),turn_id:'mac-two'});
    appendFileSync(file,complete('mac-two','你好！想让我帮你做什么？'));
    expect((await readConversation(binding,{after:delta.messages.at(-1)!.id})).messages).toEqual([]);
    expect((await readConversation(binding)).messages.filter(m=>m.role==='assistant')).toHaveLength(2);
  });
  it('keeps explicit item identities inside one inferred turn and ignores quoted lifecycle records',async()=>{
    const native=(item:string)=>line('response_item',{type:'message',id:item,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'相同内容'}]});
    writeFileSync(file,line('turn_context',{turn_id:'context-turn'})+user('问题')+native('first')+line('response_item',{type:'function_call_output',output:JSON.stringify({type:'task_started',turn_id:'FAKE'})})+native('second')+line('event_msg',{type:'task_complete',turn_id:'context-turn',last_agent_message:'相同内容'}));
    const result=await readConversation(binding);expect(result.messages.filter(m=>m.role==='assistant').map(m=>m.id)).toEqual([conversationMessageId('context-turn','assistant','first'),conversationMessageId('context-turn','assistant','second')]);expect(JSON.stringify(result)).not.toContain('FAKE');
  });
  it('uses a closing turn boundary for a cold tail without rescanning a giant tool record',async()=>{
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:'cold-turn'})+user('问题')+line('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)})+line('response_item',{type:'message',id:'tail-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'冷加载回答'}]})+line('event_msg',{type:'task_complete',turn_id:'cold-turn',last_agent_message:'冷加载回答'}));
    const result=await readConversation(binding,{limit:1});expect(result.messages).toHaveLength(1);expect(result.messages[0]).toMatchObject({id:conversationMessageId('cold-turn','assistant','tail-answer'),turn_id:'cold-turn',text:'冷加载回答'});
  });
  it('shows startup shared context coalesced with other developer blocks without exposing those instructions',async()=>{
    const notice='<octoally_shared_resources>\n凭据文件：/work/.env\n通过本地程序按需读取凭据。\n</octoally_shared_resources>';
    writeFileSync(file,line('response_item',{type:'message',id:'startup-developer',role:'developer',internal_chat_message_metadata_passthrough:{turn_id:'startup-turn'},content:[
      {type:'input_text',text:'PRIVATE developer prefix'},
      {type:'input_text',text:'  '+notice+'\n'},
      {type:'input_text',text:'PRIVATE permissions and runtime settings'},
      {type:'input_text',text:'PRIVATE skills'},
    ]})+user('Start up')+final('What would you like me to do?'));
    const initial=await readConversation(binding);
    expect(initial.messages.map(message=>message.text)).toEqual([notice,'Start up','What would you like me to do?']);
    expect(initial.messages[0]).toMatchObject({role:'user',timestamp:'2026-10-29T10:00:00Z',id:conversationMessageId('startup-turn','user','startup-developer')});
    expect(JSON.stringify(initial)).not.toContain('PRIVATE');
    const page=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
    expect(page.json().messages[0].text).toBe(notice);expect(page.body).not.toContain('PRIVATE');
    expect((await readConversation(binding,{after:initial.messages[0].id})).messages.map(message=>message.text)).toEqual(['Start up','What would you like me to do?']);
  });
  it.each(['combined','separate','skill only','reversed'])('restores startup notices in native order from %s developer text', async (shape) => {
    const notice = '<octoally_shared_resources>\n凭据文件：/work/.env\n通过本地程序按需读取凭据。\n</octoally_shared_resources>';
    const index = 'You are in an Agent Manager tab. The platform skill agent-docs covers finding tabs, delegating work, reading progress and returning results. Load /work/agent-docs/SKILL.md only when this task calls for collaboration. The platform supplies the scoped tab credential to the included client automatically.';
    const input = shape === 'reversed' ? [index, notice] : shape === 'skill only' ? [index] : [notice, index];
    const blocks = shape === 'separate' ? input : [input.join('\n\n')];
    const displayIndex = `<octoally_agent_docs>\n${index}\n</octoally_agent_docs>`;
    const expected = input.map(text => text === index ? displayIndex : text).join('\n\n');
    const rules = '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>Project rules</INSTRUCTIONS>\n<environment_context>fixture</environment_context>';
    writeFileSync(file, line('response_item', { type: 'message', id: 'startup-developer', role: 'developer', content: [
      ...blocks.map(text => ({ type: 'input_text', text })),
      { type: 'input_text', text: `private settings quoted this example:\n${index}` },
      { type: 'input_text', text: '<octoally_agent_docs>\nprivate lookalike\n</octoally_agent_docs>' },
    ] }) + line('response_item', { type: 'message', id: 'startup-rules', role: 'user', content: [{ type: 'input_text', text: rules }] })
      + line('response_item', { type: 'message', id: 'question', role: 'user', content: [{ type: 'input_text', text: 'Start up' }] }, '2026-10-29T10:00:01Z')
      + final('Ready', '2026-10-29T10:00:02Z'));
    const response = await app.inject({ url: '/api/sessions/chat/conversation', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages.map((message: { text: string }) => message.text)).toEqual([expected, rules, 'Start up', 'Ready']);
    expect(response.body).not.toContain('private');
  });
  it('returns Codex compaction summaries with an explicit presentation marker',async()=>{
    const summary='Another language model summarized the session.\n\n## Current Goal\nFix duplicate messages.';
    const before=line('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:141965}}});
    const compacted=line('compacted',{message:summary,window_id:'window-7',latest_token_usage_record:{usage:{input_tokens:141965}},replacement_history:[{role:'assistant',content:'private archived transcript'}]},'2026-10-29T10:05:00Z');
    const after=line('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:7212}}});
    writeFileSync(file,before+compacted+after+user('继续'));
    const result=await readConversation(binding);
    expect(result.messages[0]).toMatchObject({role:'assistant',phase:'commentary',presentation:'compaction_summary',text:summary,timestamp:'2026-10-29T10:05:00Z'});
    expect(result.messages[0].compaction).toEqual({before_tokens:141965,after_tokens:7212,duration_ms:null});
    expect(result.messages[0].id).toBe(conversationMessageId('compaction','assistant','compaction:window-7'));
    expect(JSON.stringify(result)).not.toContain('private archived transcript');
    expect(result.messages[1]).toMatchObject({role:'user',text:'继续'});
  });
  it('restores Codex history from a provider-specific CODEX_HOME after a cold start',async()=>{
    const providerHome=join(dbDirPath,'provider-xindu');
    mkdirSync(join(providerHome,'sessions'),{recursive:true});
    const providerFile=join(providerHome,'sessions',`rollout-xindu-${id}.jsonl`);
    writeFileSync(providerFile,
      line('event_msg',{type:'user_message',message:'xindu 的历史问题'})+
      line('response_item',{type:'message',id:'xindu-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'xindu 的历史答复'}]}));
    getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('agent_management_codex',JSON.stringify({
      defaults:{},
      providers:[{id:'xindu',name:'Xindu',kind:'responses',enabled:true,fields:{codexHome:providerHome,models:['model-a']}}],
    }));

    const result=await readConversation(binding);
    expect(result.messages.map(message=>message.text)).toEqual(['xindu 的历史问题','xindu 的历史答复']);
  });
  it('uses the compaction response item identity so its ordinary echo cannot become a duplicate conclusion',async()=>{
    const summary='## Current Goal\nKeep the compaction summary visible as a summary card.';
    const responseId='compaction-response-7';
    const compacted=line('compacted',{message:summary,window_id:'window-7',compaction_response_id:responseId});
    const echoed=line('response_item',{type:'message',id:responseId,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:summary}]});
    const followup=line('response_item',{type:'message',id:'after-compaction',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'后续回答只显示一次。'}]});
    writeFileSync(file,user('继续')+compacted+echoed+followup);
    const messages=(await readConversation(binding)).messages;
    expect(messages.filter(message=>message.text===summary)).toHaveLength(1);
    expect(messages.find(message=>message.text===summary)).toMatchObject({presentation:'compaction_summary',phase:'commentary',id:conversationMessageId('compaction','assistant',responseId)});
    expect(messages.filter(message=>message.text==='后续回答只显示一次。')).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({text:'后续回答只显示一次。',phase:'final'});
  });
  it('replaces a wrapped provider compaction echo with its distinct card, including for an existing cursor',async()=>{
    const body='压缩摘要正文';
    const wrapper='Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
    const item=(id:string,text:string)=>line('response_item',{type:'message',role:'assistant',phase:'final_answer',id,content:[{type:'output_text',text}]});
    writeFileSync(file,user('旧问题')+item('same-text-real-answer',body)+user('继续')+item('rewrite-item',body));
    const echo=(await readConversation(binding)).messages.at(-1)!;
    const summary=wrapper+'\n'+body;
    appendFileSync(file,line('token_usage_record',{response_id:'rewrite-response'})+line('compacted',{
      compaction_response_id:'rewrite-response',message:summary,
      replacement_history:[{type:'message',role:'user',id:'rewrite-card',content:[{type:'input_text',text:summary}]}],
    }));
    const delta=await readConversation(binding,{after:echo.id});
    expect(delta).toMatchObject({reset:false,messages:[{presentation:'compaction_summary',phase:'commentary',
      text:summary,compaction:{replaces_message_id:echo.id}}]});
    expect(delta.messages).toHaveLength(1);
    expect((await readConversation(binding)).messages.map(message=>message.text)).toEqual(['旧问题',body,'继续',summary]);
  });
  it('rebuilds Codex history from replacement_history and renders its summary only as a summary card',async()=>{
    const staleUser=line('response_item',{type:'message',id:'stale-user',role:'user',content:[{type:'input_text',text:'旧问题'}]});
    const staleAnswer=line('response_item',{type:'message',id:'stale-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'旧结论'}]});
    writeFileSync(file,staleUser+staleAnswer);
    const first=await readConversation(binding);
    const staleCursor=first.messages.at(-1)!.id;
    const summary='压缩后的会话摘要';
    const compacted=line('compacted',{
      message:summary,
      window_id:'window-real-shape',
      compaction_response_id:'resp_compaction_7',
      replacement_history:[
        {type:'message',id:'canonical-user',role:'user',content:[{type:'input_text',text:'保留的问题'}]},
        {type:'message',id:'canonical-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'保留的结论'}]},
        {type:'message',id:'msg_summary_7',role:'user',content:[{type:'input_text',text:summary}]},
      ],
    });
    appendFileSync(file,compacted+user('继续')+final('继续后的答复'));

    const delta=await readConversation(binding,{after:staleCursor});
    expect(delta.reset).toBe(false);
    expect(delta.messages.map(message=>message.text)).toEqual([summary,'继续','继续后的答复']);
    expect(delta.messages[0]).toMatchObject({
      role:'assistant',
      phase:'commentary',
      presentation:'compaction_summary',
      id:conversationMessageId('','assistant','msg_summary_7'),
    });
    expect(delta.messages.filter(message=>message.text===summary)).toHaveLength(1);
    expect((await readConversation(binding)).messages.map(message=>message.text)).toEqual(['旧问题','旧结论',summary,'继续','继续后的答复']);
    expect(delta.messages.at(-1)).toMatchObject({phase:'final',text:'继续后的答复'});
  });
  it('keeps the compaction summary after replacement history when the summary has no native message copy',async()=>{
    const summary='压缩内容';
    const compacted=line('compacted',{message:summary,window_id:'window-no-summary-item',replacement_history:[
      {type:'message',id:'replacement-user',role:'user',content:[{type:'input_text',text:'保留的问题'}]},
      {type:'message',id:'replacement-answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'保留的答复'}]},
    ]});
    writeFileSync(file,compacted+user('继续'));
    const messages=(await readConversation(binding)).messages;
    expect(messages.map(message=>message.text)).toEqual([summary,'继续']);
    expect(messages[0]).toMatchObject({presentation:'compaction_summary',phase:'commentary'});
  });
  it('projects Codex replacement history COMPACTION_SUMMARY markers as cards, not user or conclusion messages',async()=>{
    const compacted=line('compacted',{message:'',replacement_history:[
      {type:'message',id:'before-summary',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'压缩前保留的回答'}]},
      {type:'message',id:'summary-marker',role:'user',content:[{type:'input_text',text:'<COMPACTION_SUMMARY>\n压缩后需要继续的上下文'}]},
    ]});
    writeFileSync(file,compacted+user('继续'));
    const messages=(await readConversation(binding)).messages;
    expect(messages.map(message=>message.text)).toEqual(['压缩后需要继续的上下文','继续']);
    expect(messages[0]).toMatchObject({role:'assistant',phase:'commentary',presentation:'compaction_summary'});
  });
  it('preserves original turns and exposes an encrypted compaction without leaking its payload',async()=>{
    const original=user('原问题')+final('原答复');
    writeFileSync(file,original);
    const before=await readConversation(binding);
    appendFileSync(file,line('compacted',{message:'',replacement_history:[
      {type:'message',id:'copied-user',role:'user',content:[{type:'input_text',text:'原问题'}]},
      {type:'compaction',id:'encrypted-summary',encrypted_content:'SECRET_ENCRYPTED_DATA'},
    ]})+user('继续')+final('新答复'));
    const delta=await readConversation(binding,{after:before.messages.at(-1)!.id});
    expect(delta.reset).toBe(false);
    expect(delta.messages.map(message=>message.text)).toEqual(['压缩内容由 Codex 加密保存，无法显示摘要正文。','继续','新答复']);
    expect(delta.messages[0]).toMatchObject({presentation:'compaction_summary'});
    const full=await readConversation(binding);
    expect(full.messages.map(message=>message.text)).toEqual(['原问题','原答复','压缩内容由 Codex 加密保存，无法显示摘要正文。','继续','新答复']);
    expect(JSON.stringify(full)).not.toContain('SECRET_ENCRYPTED_DATA');
  });
  it('preserves prior messages when a compaction contains no readable or encrypted summary',async()=>{
    writeFileSync(file,user('原问题')+final('原答复')+line('compacted',{message:'',replacement_history:[]})+user('继续'));
    expect((await readConversation(binding)).messages.map(message=>message.text)).toEqual(['原问题','原答复','Codex 未提供可显示的压缩摘要正文。','继续']);
  });
  it('retains separate summaries and messages across multiple compactions',async()=>{
    const compact=(id:string)=>line('compacted',{message:'',replacement_history:[{type:'compaction',id,encrypted_content:'opaque'}]});
    writeFileSync(file,user('第一问')+final('第一答')+compact('compact-1')+user('第二问')+final('第二答')+compact('compact-2')+user('第三问'));
    const messages=(await readConversation(binding)).messages;
    expect(messages.map(message=>message.presentation==='compaction_summary'?'摘要':message.text)).toEqual(['第一问','第一答','摘要','第二问','第二答','摘要','第三问']);
    expect(new Set(messages.map(message=>message.id)).size).toBe(messages.length);
  });
  it('shows only an actual shared-resource developer notice while hiding other developer context and tool lookalikes',async()=>{
    const notice='<octoally_shared_resources>\n凭据文件：/work/.env\n通过本地程序按需读取凭据。\n</octoally_shared_resources>';
    const developer=(text:string)=>line('response_item',{type:'message',role:'developer',content:[{type:'input_text',text}]});
    writeFileSync(file,user('原问题')+developer('private developer instructions')+line('response_item',{type:'function_call_output',output:notice})+developer(notice)+final('答复'));
    const result=await readConversation(binding);
    expect(result.messages.map(message=>message.text)).toEqual(['原问题',notice,'答复']);
    expect(JSON.stringify(result)).not.toContain('private developer instructions');
    const page=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
    expect(page.json().messages.filter((message:{text:string})=>message.text===notice)).toHaveLength(1);
  });
  it('restores actual async question items as structured messages and keeps one stable identity',async()=>{
    const questions=[{title:'免费旅行，你最想去哪里？',options:['太空','深海','森林']}];
    const item={type:'AgentMessage',id:'call-question',delivery:'async',phase:'final_answer',questions,content:[{type:'Text',text:'免费旅行，你最想去哪里？\n- 太空\n- 深海\n- 森林'}]};
    writeFileSync(file,user('出个问题')+line('response_item',{type:'function_call',name:'request_user_input_async',arguments:JSON.stringify({questions})})+line('event_msg',{type:'item_completed',thread_id:id,turn_id:'turn',item})+final('免费旅行，你最想去哪里？\n- 太空\n- 深海\n- 森林'));
    const result=await readConversation(binding);expect(result.messages).toHaveLength(2);
    expect(result.messages.at(-1)).toMatchObject({id:conversationMessageId('turn','assistant','call-question'),role:'assistant',phase:'final',async_questions:questions});
    expect((await readConversation(binding)).messages.at(-1)?.async_questions).toEqual([{...questions[0],id:JSON.stringify(['request_user_input_async','call-question',0])}]);
    appendFileSync(file,user('我选太空'));expect((await readConversation(binding)).messages.map(message=>message.role)).toEqual(['user','assistant','user']);
  });
  it('restores legacy async agent_message metadata using the actual request call ID across appends',async()=>{
    const questions=[{title:'这批是否一并回补？',options:['一并回补 feat_zx','本批只合并 main']}],text='这批是否一并回补？\n- 一并回补 feat_zx\n- 本批只合并 main';
    const call=(id:string)=>line('response_item',{type:'function_call',id:'fc-ignored',name:'request_user_input_async',call_id:id,arguments:JSON.stringify({questions}),internal_chat_message_metadata_passthrough:{turn_id:'legacy-turn'}});
    const question=()=>line('event_msg',{type:'agent_message',message:text,phase:'final_answer',delivery:'async',questions});
    writeFileSync(file,user('处理需求')+call('call-one'));
    const initial=await readConversation(binding);expect(initial.messages).toHaveLength(1);
    appendFileSync(file,line('event_msg',{type:'agent_message',message:text,phase:'final_answer'})+question()+final(text));
    const first=await readConversation(binding);expect(first.messages).toHaveLength(2);
    expect(first.messages[1]).toMatchObject({id:conversationMessageId('legacy-turn','assistant','call-one'),async_questions:[{...questions[0],id:JSON.stringify(['request_user_input_async','call-one',0])}]});
    expect((await readConversation(binding)).messages[1].id).toBe(first.messages[1].id);
    appendFileSync(file,user('再问一次')+call('call-two')+question());
    const next=await readConversation(binding);expect(next.messages.at(-1)?.async_questions?.[0].id).toBe(JSON.stringify(['request_user_input_async','call-two',0]));
    expect(next.messages.at(-1)?.id).not.toBe(first.messages[1].id);
  });
  it('keeps prose as prose and never binds a quoted fake request to native async metadata',async()=>{
    const questions=[{title:'真的问题',options:['A','B']}];
    writeFileSync(file,user('处理')+line('response_item',{type:'function_call_output',output:JSON.stringify({type:'function_call',name:'request_user_input_async',call_id:'private-call',arguments:JSON.stringify({questions})})})+line('event_msg',{type:'agent_message',delivery:'async',questions,message:'真的问题'}));
    const result=await readConversation(binding);expect(result.messages.at(-1)?.async_questions).toEqual(questions);expect(JSON.stringify(result)).not.toContain('private-call');
  });
  it('never converts quoted question metadata in tool output or unstructured prose into a form',async()=>{
    writeFileSync(file,user('问题')+line('response_item',{type:'function_call_output',output:JSON.stringify({delivery:'async',questions:[{title:'private',options:['a','b']}]})})+line('event_msg',{type:'item_completed',item:{type:'AgentMessage',id:'normal',content:[{type:'Text',text:'1. a 2. b'}],questions:[{title:'伪提问',options:['a','b']}]}})+final('1. a 2. b'));
    const result=await readConversation(binding);expect(result.messages).toHaveLength(2);expect(result.messages.some(message=>message.async_questions)).toBe(false);
  });
  it('restores a native capacity error from task completion and excludes private details and tool errors',async()=>{
    writeFileSync(file,user('执行任务')+line('response_item',{type:'function_call_output',error:{message:'PRIVATE TOOL FAILURE'},output:'PRIVATE RESULT'})
      +line('event_msg',{type:'agent_message',message:'正在处理'})
      +line('event_msg',{type:'task_complete',turn_id:'capacity-turn',last_agent_message:null,error:{message:'Selected model is at capacity. Please try a different model.',codex_error_info:'server_overloaded',additionalDetails:'PRIVATE REQUEST'}}));
    const result=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
    expect(result.statusCode).toBe(200);const messages=result.json().messages;
    expect(messages).toHaveLength(3);expect(messages[2]).toMatchObject({phase:'error',role:'assistant',turn_id:'capacity-turn',text:'Selected model is at capacity. Please try a different model.',error:{code:'server_overloaded',will_retry:false}});
    expect(result.body).not.toContain('PRIVATE');expect((await readConversation(binding)).messages[2].id).toBe(messages[2].id);
    expect((await readConversation(binding,{after:messages[1].id})).messages).toHaveLength(1);
  });
  it('projects native Codex reasoning as commentary and keeps the legacy final response',async()=>{
    const turn='reasoning-turn',first='reasoning-a',last='reasoning-b';
    const reasoning=(payload:object)=>line('response_item',{type:'reasoning',encrypted_content:'fixture-opaque',...payload});
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn})+user('检查文件')+
      reasoning({id:first,summary:[],content:[{type:'reasoning_text',text:'先检查文件'}]})+
      reasoning({id:'opaque-only',summary:[],content:null}));
    const firstPage=await readConversation(binding);
    const firstThought={id:conversationMessageId(turn,'assistant',first),phase:'commentary',text:'',turn_id:turn,
      content_blocks:[{type:'thinking',index:0,text:'先检查文件'}]};
    expect(firstPage.messages).toHaveLength(2);
    expect(firstPage.messages[1]).toMatchObject(firstThought);
    appendFileSync(file,reasoning({id:last,summary:[{type:'summary_text',text:'核对结果'}],
      content:[{type:'reasoning_text',text:'fixture-shadowed'}]})+line('event_msg',{
        type:'task_complete',turn_id:turn,last_agent_message:'已检查。',
      }));
    const delta=await readConversation(binding,{after:firstThought.id});
    expect(delta.messages).toMatchObject([
      {id:conversationMessageId(turn,'assistant',last),phase:'commentary',text:'',
        content_blocks:[{type:'thinking',index:0,text:'核对结果'}]},
      {phase:'final',text:'已检查。'},
    ]);
    expect(JSON.stringify(delta.messages)).not.toMatch(/fixture-opaque|fixture-shadowed/);
  });
  it('uses durable response items instead of lifecycle text mirrors while excluding tool records',async()=>{
    writeFileSync(file,user('修复问题')
      +line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'修复问题'}]})
      +line('response_item',{type:'reasoning',text:'hidden reasoning'})
      +line('response_item',{type:'function_call',arguments:'secret arguments'})
      +line('response_item',{type:'function_call_output',output:'private tool output'})
      +line('event_msg',{type:'agent_message',message:'中间进展'})
      +line('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'已完成。'}]})+final('已完成。'));
    const result=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
    expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toContain('no-store');
    expect(result.json().messages.map((message:{text:string})=>message.text)).toEqual(['修复问题','已完成。']);
    expect(result.body).not.toMatch(/secret arguments|private tool output|hidden reasoning/);
    expect(getDb().prepare('SELECT COUNT(*) n FROM platform_ai_tasks').get()).toEqual({n:0});
  });
  it('uses native user identity and log order even with equal or decreasing timestamps',async()=>{
    const record=(role:string,id:string,text:string,stamp:string)=>line('response_item',{type:'message',id,role,phase:role==='assistant'?'final_answer':undefined,internal_chat_message_metadata_passthrough:{turn_id:'turn'},content:[{type:role==='user'?'input_text':'output_text',text}]},stamp);
    writeFileSync(file,record('user','q1','继续','2030-01-01')+record('assistant','a1','第一答复','2030-01-01')+record('user','q2','继续','2020-01-01')+record('assistant','a2','第二答复','2019-01-01'));
    const result=await readConversation(binding);
    expect(result.messages.map(message=>message.id)).toEqual([conversationMessageId('turn','user','q1'),conversationMessageId('turn','assistant','a1'),conversationMessageId('turn','user','q2'),conversationMessageId('turn','assistant','a2')]);
    expect(result.messages.map(message=>message.sequence)).toEqual([...result.messages.map(message=>message.sequence)].sort((a,b)=>a!-b!));
  });
  it('returns only newly appended messages, handles partial UTF-8 and retains long final replies',async()=>{
    writeFileSync(file,user('first')+final('done'));
    const first=await readConversation(binding);const cursor=first.messages.at(-1)!.id;
    expect((await readConversation(binding,{after:cursor})).messages).toEqual([]);
    const next=Buffer.from(user('新问题','2026-10-29T10:01:00Z'));const split=next.indexOf(Buffer.from('新'))+1;
    appendFileSync(file,next.subarray(0,split));expect((await readConversation(binding,{after:cursor})).messages).toEqual([]);
    appendFileSync(file,next.subarray(split));const long='完整结果'.repeat(5000);appendFileSync(file,final(long,'2026-10-29T10:02:00Z'));
    const result=await readConversation(binding,{after:cursor});expect(result.messages.map(message=>message.text)).toEqual(['新问题',long]);
    expect(result.reset).toBe(false);
  });
  it('keeps image messages on cold load and incremental append without exposing inline image data',async()=>{
    const image=(id:string)=>line('response_item',{type:'message',id,role:'user',internal_chat_message_metadata_passthrough:{turn_id:'images'},content:[{type:'input_text',text:`图片问题 ${id}`},{type:'input_text',text:'<image name=[Image #1] path="/project/image.png">'},{type:'input_image',image_url:'data:image/png;base64,'+'A'.repeat(3*1024*1024)},{type:'input_text',text:'</image>'}]});
    writeFileSync(file,image('cold')+final('图像答复'));
    const first=await readConversation(binding);expect(first.messages.map(message=>message.text)).toEqual(['图片问题 cold','图像答复']);expect(JSON.stringify(first).length).toBeLessThan(2000);
    const next=Buffer.from(image('appended'));appendFileSync(file,next.subarray(0,next.length-50));expect((await readConversation(binding,{after:first.messages.at(-1)!.id})).messages).toEqual([]);
    appendFileSync(file,next.subarray(next.length-50));appendFileSync(file,final('第二份图像答复'));
    expect((await readConversation(binding,{after:first.messages.at(-1)!.id})).messages.map(message=>message.text)).toEqual(['图片问题 appended','第二份图像答复']);
  });
  it('keeps a Codex screenshot reference from native history in brief context',async()=>{
    const projectPath=join(dbDirPath,'project');
    mkdirSync(projectPath);
    getDb().prepare("UPDATE projects SET path=? WHERE id='p'").run(projectPath);
    vi.stubEnv('AGENTMANAGER_ATTACHMENTS_DIR',join(dbDirPath,'attachments'));
    const bytes=Buffer.from('fixture screenshot');
    const image={kind:'image' as const,name:'screen.png',path:join(projectAttachmentDirectory(projectPath,true),'screen.png')};
    writeFileSync(image.path,bytes);
    rememberConversationAttachments('chat','screen-input','See the screenshot',[image],true);
    writeFileSync(file,line('response_item',{type:'message',id:'screen-message',role:'user',content:[
      {type:'input_text',text:nativeConversationInput('See the screenshot',[image])[0].text},
      {type:'input_text',text:`<image name=[Image #1] path="${image.path}">`},
      {type:'input_image',image_url:`data:image/png;base64,${bytes.toString('base64')}`},
      {type:'input_text',text:'</image>'},
    ]}));
    const result=await prepareBriefSend('chat',id,{input:'Continue'},async()=>{
      const page=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie}});
      expect(page.statusCode).toBe(200);
      return page.json();
    });
    expect(parseBriefContext(result.input)?.context.turns).toEqual([
      expect.objectContaining({input:'See the screenshot',attachments:[image]}),
    ]);
    expect(result.input).not.toContain(bytes.toString('base64'));
    expect(result.attachments).toBeUndefined();
  });
  it('continues brief pagination when an older window reveals the original user message behind an echo',async()=>{
    const turn='cursor-turn',text='paired user input';
    const recent=final('paired answer')+Array.from({length:39},(_,i)=>user(`recent request ${i}`)+final(`recent reply ${i}`)).join('');
    const original=line('response_item',{type:'message',id:'cursor-original',role:'user',
      internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'input_text',text}]});
    const echo=line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:'cursor-echo',content:[{type:'text',text}]}});
    const tools=line('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)});
    writeFileSync(file,user('older request')+final('older reply')+original+tools+echo+recent);
    const result=await prepareBriefSend('chat',id,{input:'new draft'},async query=>{
      const params=new URLSearchParams(query);
      const response=await app.inject({url:`/api/sessions/chat/conversation?${params}`,headers:{cookie}});
      expect(response.statusCode).toBe(200);
      return response.json();
    });
    const brief=parseBriefContext(result.input);
    expect(brief?.context.older_omitted).toBe(false);
    expect(brief?.context.turns).toHaveLength(41);
    const [old,paired]=brief!.context.turns;
    expect(old).toMatchObject({input:'older request',conclusion:'older reply'});
    expect(paired).toMatchObject({input:text,conclusion:'paired answer'});
    expect(brief?.context.turns.filter(turn=>turn.input===text)).toHaveLength(1);
  });
  it('restarts brief preparation when the native history is rewritten between HTTP pages',async()=>{
    const history=(version:string)=>Array.from({length:41},(_,i)=>user(`${version} request ${i}`)+final(`${version} reply ${i}`)).join('');
    writeFileSync(file,history('old'));
    const cursors:Array<string|undefined>=[];
    const result=await prepareBriefSend('chat',id,{input:'new draft'},async query=>{
      cursors.push(query.before);
      if(cursors.length===2)writeFileSync(file,history('updated'));
      const response=await app.inject({url:`/api/sessions/chat/conversation?${new URLSearchParams(query)}`,headers:{cookie}});
      expect(response.statusCode).toBe(200);
      const page=response.json();
      if(cursors.length===2)expect(page.reset).toBe(true);
      return page;
    });
    expect(cursors).toEqual([undefined,expect.any(String),undefined,expect.any(String)]);
    const brief=parseBriefContext(result.input);
    expect(brief?.context.turns).toHaveLength(41);
    expect(brief?.context.turns[0]).toEqual({input:'updated request 0',conclusion:'updated reply 0'});
    expect(brief?.context.turns.at(-1)).toEqual({input:'updated request 40',conclusion:'updated reply 40'});
    expect(result.input).not.toContain('old request');
    expect(brief?.input).toBe('new draft');
  });
  it('prepares brief context across empty history pages containing oversized tool results',async()=>{
    const toolOutput=line('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)});
    const recent=Array.from({length:40},(_,i)=>user(`recent question ${i}`)+final(`recent answer ${i}`)).join('');
    writeFileSync(file,user('older question')+final('older answer')+toolOutput.repeat(3)+recent);
    const result=await prepareBriefSend('chat',id,{input:'new draft'},async query=>{
      const params=new URLSearchParams(query);
      const response=await app.inject({url:`/api/sessions/chat/conversation?${params}`,headers:{cookie}});
      expect(response.statusCode).toBe(200);
      return response.json();
    });
    const brief=parseBriefContext(result.input);
    expect(brief?.context.older_omitted).toBe(false);
    expect(brief?.context.turns).toHaveLength(41);
    expect(brief?.context.turns[0]).toMatchObject({input:'older question',conclusion:'older answer'});
    expect(brief?.context.turns.at(-1)).toMatchObject({input:'recent question 39',conclusion:'recent answer 39'});
    expect(brief?.input).toBe('new draft');
  });
  it('pages old messages on demand without tool output displacing conversation',async()=>{
    writeFileSync(file,Array.from({length:80},(_,i)=>user(`q${i}`)+final(`a${i}`)).join(''));
    const latest=await readConversation(binding,{limit:20});expect(latest.messages).toHaveLength(20);expect(latest.has_more).toBe(true);
    const old=await readConversation(binding,{before:latest.messages[0].id,limit:20});expect(old.messages.at(-1)?.text).toBe('a69');
    appendFileSync(file,line('response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)}));
    const delta=await readConversation(binding,{after:latest.messages.at(-1)!.id});expect(delta.messages).toEqual([]);
    expect((await readConversation(binding)).messages.at(-1)?.text).toBe('a79');
    expect((await readConversation(binding,{before:'f'.repeat(32),limit:5})).messages.length).toBeLessThanOrEqual(5);
  });
  it('recovers a replaced log and never reads another users session',async()=>{
    writeFileSync(file,user('old'));const first=await readConversation(binding);
    writeFileSync(file,user('new native conversation'));
    expect((await readConversation(binding,{after:first.messages[0].id})).reset).toBe(true);
    const other=createUser({username:'other-chat',password:'password1'});
    const otherCookie=`agentmanager_session=${createSession(other.id)}`;
    const denied=await app.inject({url:'/api/sessions/chat/conversation',headers:{cookie:otherCookie}});
    expect(denied.statusCode).toBe(404);
    expect((await app.inject({url:'/api/sessions/chat/conversation/metadata',headers:{cookie:otherCookie}})).statusCode).toBe(404);
    expect((await app.inject({url:'/api/sessions/chat/conversation/metadata',headers:{cookie}})).json().metadata.summary.native_id).toBe(id);
    expect((await app.inject({url:'/api/sessions/chat/conversation?before=bad',headers:{cookie}})).statusCode).toBe(400);
  });
  it('finds dialogue on cold load even when a giant tool result is the last record',async()=>{
    writeFileSync(file,user('Keep this conversation')+final('Keep this final reply')+line('response_item',{type:'function_call_output',output:'x'.repeat(4*1024*1024)}));
    const result=await readConversation(binding);
    expect(result.messages.map(message=>message.text)).toEqual(['Keep this conversation','Keep this final reply']);
  });
  it('settles a delayed duplicate by native turn identity and preserves identical replies in later turns',async()=>{
    const response=(turn:string,stamp:string)=>line('response_item',{type:'message',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:'相同结果'}]},stamp);
    writeFileSync(file,user('first')+response('turn-one','2026-10-29T10:00:00Z'));
    const first=await readConversation(binding);
    appendFileSync(file,line('event_msg',{type:'task_complete',turn_id:'turn-one',last_agent_message:'相同结果'},'2026-10-29T10:00:07Z'));
    expect((await readConversation(binding,{after:first.messages.at(-1)!.id})).messages).toEqual([]);
    expect((await readConversation(binding)).messages.map(item=>item.text)).toEqual(['first','相同结果']);
    appendFileSync(file,user('again','2026-10-29T10:01:00Z')+response('turn-two','2026-10-29T10:01:05Z')+line('event_msg',{type:'task_complete',turn_id:'turn-two',last_agent_message:'相同结果'},'2026-10-29T10:01:15Z'));
    expect((await readConversation(binding)).messages.map(item=>item.text)).toEqual(['first','相同结果','again','相同结果']);
  });
  it('keeps two answer items inside one native turn while removing its completion echo',async()=>{
    const answer=(id:string)=>line('response_item',{type:'message',id,role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'shared-turn'},content:[{type:'output_text',text:'相同的回答'}]});
    writeFileSync(file,user('问题')+answer('first-item')+answer('second-item')+line('event_msg',{type:'task_complete',turn_id:'shared-turn',last_agent_message:'相同的回答'},'2026-10-29T10:00:10Z'));
    const result=await readConversation(binding);const answers=result.messages.filter(message=>message.role==='assistant');
    expect(answers).toHaveLength(2);expect(answers[0].id).not.toBe(answers[1].id);
  });
  it('coalesces the adjacent lifecycle and durable assistant copies with different turn IDs',async()=>{
    const text='同一条最终结论';
    const lifecycle=line('event_msg',{type:'agent_message',turn_id:'native-turn',message:text,phase:'final_answer'});
    const durable=line('response_item',{type:'message',id:'durable-item',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'internal-copy'},content:[{type:'output_text',text}]});
    writeFileSync(file,user('问题')+lifecycle+durable);
    const answers=(await readConversation(binding)).messages.filter(message=>message.role==='assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0].text).toBe(text);
  });
  it('removes a delayed completion echo even when progress is interleaved',async()=>{
    const answer=line('response_item',{type:'message',id:'answer-item',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'delayed-turn'},content:[{type:'output_text',text:'延迟完成回显'}]});
    writeFileSync(file,user('问题')+answer+line('event_msg',{type:'agent_reasoning',text:'内部进展'})+line('event_msg',{type:'task_complete',turn_id:'delayed-turn',last_agent_message:'延迟完成回显'}));
    const result=await readConversation(binding);
    expect(result.messages.filter(message=>message.role==='assistant').map(message=>message.text)).toEqual(['延迟完成回显']);
  });
  it('promotes an unphased final answer using its exact task completion and keeps it across incremental reads',async()=>{
    const turn='implicit-final-turn',answer='我是 Codex，一个编程协作助手。';
    const start=line('event_msg',{type:'task_started',turn_id:turn});
    const eventItem=line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id:'event-answer',content:[{type:'Text',text:answer}]}});
    const native=line('response_item',{type:'message',id:'native-answer',role:'assistant',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:answer}]});
    const complete=line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:answer});
    writeFileSync(file,start+user('介绍你自己')+eventItem+native+complete);
    const result=await readConversation(binding),answers=result.messages.filter(message=>message.role==='assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({role:'assistant',phase:'final',text:answer,turn_id:turn});
    expect((await readConversation(binding)).messages.filter(message=>message.role==='assistant')).toEqual(answers);
  });
  it('deduplicates item_completed and response_item copies by their shared native item ID',async()=>{
    const turn='shared-native-item-turn',item='msg_09fffff6ba8453c7016aefe4fd49c887d09617620d9fcedbb',answer='只显示一次的最终回复';
    const started=line('event_msg',{type:'task_started',turn_id:turn});
    const completed=line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id:item,content:[{type:'Text',text:answer}]}},'2026-10-29T10:00:05Z');
    const durable=line('response_item',{type:'message',id:item,role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:answer}]},'2026-10-29T10:00:05Z');
    const finished=line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:answer},'2026-10-29T10:00:06Z');
    writeFileSync(file,started+user('问题')+completed+durable+finished);
    const answers=(await readConversation(binding)).messages.filter(message=>message.role==='assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({text:answer,phase:'final',turn_id:turn});
  });
  it('uses the completed Codex UserMessage identity instead of rendering its response_item copy twice',async()=>{
    const turn='input-turn',item='01a1b938-c01c-7512-b8dd-e82285b0991a',client='eb84cac63fa00b11cecd8739d9472cae';
    const text='[Image #1]刚才又发现一个问题，就是另一个会话输出过程中重新覆盖了内容，是你刚才重新部署的缘故吗\n';
    const started=line('event_msg',{type:'task_started',turn_id:turn});
    const durable=line('response_item',{type:'message',id:'msg_01a1b938-c01c-7512-b8dd-e81da9939816',role:'user',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'input_text',text},{type:'input_text',text:'<image name=[Image #1] path="/tmp/input.png">'},{type:'input_image',image_url:'data:image/png;base64,hidden'},{type:'input_text',text:'</image>'}]});
    const completed=line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:item,client_id:client,content:[{type:'text',text},{type:'local_image',path:'/tmp/input.png'}]}});
    writeFileSync(file,started+durable+completed);
    const users=(await readConversation(binding)).messages.filter(message=>message.role==='user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({id:conversationMessageId(turn,'user','msg_01a1b938-c01c-7512-b8dd-e81da9939816'),text:text.trimEnd(),turn_id:turn,client_id:client,image_paths:['/tmp/input.png']});
  });
  it('keeps one stable user message when an asynchronous question follows the native and completion records',async()=>{
    const turn='question-turn',text='清理并重新获取',stamp='2026-10-29T10:00:01Z',client='client-fixture';
    const durable=line('response_item',{type:'message',id:'native-user',role:'user',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'input_text',text}]},stamp);
    const completed=line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:'completed-user',client_id:client,content:[{type:'text',text}]}},'2026-10-29T10:00:01.001Z');
    const questions=[{title:'选择范围',options:['当前','全部']}];
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn})+durable);
    const first=await readConversation(binding);expect(first.messages.filter(m=>m.role==='user')).toHaveLength(1);
    appendFileSync(file,completed+line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id:'question',delivery:'async',questions,content:[{type:'Text',text:'选择范围'}]}}));
    const next=await readConversation(binding),users=next.messages.filter(m=>m.role==='user');expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({id:first.messages[0].id,text,client_id:client});expect(next.messages.some(m=>m.async_questions?.length)).toBe(true);
  });
  it('preserves repeated distinct user inputs within the same question turn',async()=>{
    const turn='repeated-question',text='同一内容';
    const pair=(suffix:string,stamp:string)=>line('response_item',{type:'message',id:'native-'+suffix,role:'user',content:[{type:'input_text',text}]},stamp)+line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:'event-'+suffix,client_id:'client-'+suffix,content:[{type:'text',text}]}},stamp);
    const questions=[{title:'选择',options:['A','B']}];
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn})+pair('one','2026-10-29T10:00:01Z')+pair('two','2026-10-29T10:00:02Z')+line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id:'question',delivery:'async',questions,content:[{type:'Text',text:'选择'}]}}));
    const users=(await readConversation(binding)).messages.filter(m=>m.role==='user');expect(users).toHaveLength(2);expect(users.map(m=>m.client_id)).toEqual(['client-one','client-two']);
  });
  it('does not promote an unphased item when task completion names a different later item',async()=>{
    const turn='implicit-interleaved-turn',answer='本轮最终答复';
    const answerItem=(id:string,text:string)=>line('event_msg',{type:'item_completed',turn_id:turn,item:{type:'AgentMessage',id,content:[{type:'Text',text}]}});
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn})+user('问题')+answerItem('answer','本轮最终答复')+answerItem('progress','补充检查')+line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:answer}));
    const messages=(await readConversation(binding)).messages.filter(message=>message.role==='assistant');
    // `last_agent_message` is authoritative only when its exact text matches.
    // Here it names an earlier item, so neither native message is the result.
    expect(messages.map(message=>message.text)).toEqual(['本轮最终答复','补充检查']);
  });
  it('uses turn completion to finalize the last unphased durable assistant item without comparing text',async()=>{
    const turn='implicit-progress-turn';
    const progress=line('response_item',{type:'message',id:'progress-answer',role:'assistant',internal_chat_message_metadata_passthrough:{turn_id:turn},content:[{type:'output_text',text:'正在检查文件'}]});
    writeFileSync(file,line('event_msg',{type:'task_started',turn_id:turn})+user('检查')+progress+line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:'检查完成'}));
    const messages=(await readConversation(binding)).messages.filter(message=>message.role==='assistant');
    expect(messages).toMatchObject([{text:'正在检查文件',phase:'final'}]);
  });
});
