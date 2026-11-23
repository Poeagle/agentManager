import {getDb} from '../db/index.js';
import {subscribe,broadcastEphemeral} from './event-store.js';
import {agentForSession} from './agents/index.js';
import {sessionAgentContext} from './agents/session.js';
import type {AgentMessage,AgentRuntime} from './agents/types.js';
import type {AgentStreamFrame} from './agents/events.js';
import type {ConversationRetry} from './conversation-retry.js';
import {observeConversationFile} from './conversation-file-stream.js';
import {readConversation} from './conversation-reader.js';
import {activityResultPreview} from './conversation-activity.js';
import {hasScheduledConversationInput,isConversationInput,linkConversationInputs} from './conversation-input-links.js';
import {nativeConversationId} from './session-identity.js';
import {personalQuestionRuntime,ignoredQuestionIds} from './question-attention.js';
import {
  canReadNotifications,notificationSession,putNotification,updateNotificationState,pruneNotifications,
  notificationChanged,settleNotificationResults,type NotificationSession,type Notification,
} from './notifications.js';

const ACTIVE=new Set(['pending','launching','running','detached','released']);
const MAX_WATCHES=512;
type Watch={native:string;stop:()=>void;questions:Set<string>;interactions:Set<string>;seen:Set<string>;checkingResults:Set<string>;running:boolean;completed:boolean;finals:Map<string,AgentMessage>;endTimer?:ReturnType<typeof setTimeout>};

/** Read-only leases share the platform's existing streams and incremental file
 * reader. They survive switching/closing project tabs and never submit input. */
export class NotificationObserver {
  private watches=new Map<string,Watch>();
  private unsubscribe:()=>void=()=>{};
  private stopped=false;
  private since:number;
  private pruneAt=0;
  private pending=new Set<string>();
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private onError:(error:unknown)=>void=()=>{}) {
    const row=getDb().prepare("SELECT value FROM settings WHERE key='notification-center-since'").get() as {value:string}|undefined;
    this.since=Number(row?.value)||Date.now();
    getDb().prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('notification-center-since',?)").run(String(this.since));
  }
  start() {
    this.unsubscribe=subscribe(event=>{
      if(event.type==='rbac.changed'){
        const rows=getDb().prepare("SELECT id FROM sessions WHERE status IN ('pending','launching','running','detached','released') ORDER BY updated_at DESC LIMIT ?").all(MAX_WATCHES) as {id:string}[];
        for(const id of this.watches.keys())this.pending.add(id);for(const row of rows)this.pending.add(row.id);
        if(!this.timer)this.timer=setTimeout(()=>this.flush(),80);return;
      }
      if(this.stopped||!event.session_id||!event.type.startsWith('session.'))return;
      this.pending.add(event.session_id);
      if(!this.timer)this.timer=setTimeout(()=>this.flush(),80);
      if(event.type==='session.retry')try {this.retry(event.session_id,JSON.parse(event.data||'{}').retry);}catch(error){this.onError(error);}
      if(event.type==='session.runtime')try {
        const entry=this.watches.get(event.session_id),session=entry&&this.current(event.session_id,entry.native);
        if(entry&&session)this.runtime(session,JSON.parse(event.data||'{}').runtime,entry);
      }catch(error){this.onError(error);}
    });
    const rows=getDb().prepare(`SELECT id FROM sessions WHERE created_by_user_id IS NOT NULL AND status IN ('pending','launching','running','detached','released') ORDER BY updated_at DESC LIMIT ?`).all(MAX_WATCHES) as {id:string}[];
    for(const row of rows)this.pending.add(row.id);
    this.flush();
  }
  private flush() {
    this.timer=undefined;if(this.stopped)return;
    const ids=[...this.pending].slice(0,8);
    for(const id of ids){this.pending.delete(id);try{this.watch(id);}catch(error){this.onError(error);}}
    if(this.pending.size)this.timer=setTimeout(()=>this.flush(),30);
    if(Date.now()-this.pruneAt>60000){this.pruneAt=Date.now();pruneNotifications();}
  }
  private current(id:string,native:string) {
    if(this.stopped)return;
    const session=notificationSession(id);
    if(session&&nativeConversationId(session)===native&&session.created_by_user_id&&canReadNotifications(session,session.created_by_user_id))return session;
  }
  private watch(id:string) {
    const session=notificationSession(id),native=session&&nativeConversationId(session),old=this.watches.get(id);
    const allowed=!!session?.created_by_user_id&&canReadNotifications(session,session.created_by_user_id);
    if(old&&native===old.native&&session&&allowed){
      if(ACTIVE.has(session.status)){clearTimeout(old.endTimer);old.endTimer=undefined;return;}
      // Give the existing incremental reader time to receive a final append
      // accompanying process exit; this does not create another connection.
      if(!old.endTimer)old.endTimer=setTimeout(()=>{old.stop();if(this.watches.get(id)===old)this.watches.delete(id);},1000);
      return;
    }
    old?.stop();this.watches.delete(id);
    if(!session||!native||!ACTIVE.has(session.status)||!session.created_by_user_id||!canReadNotifications(session,session.created_by_user_id))return;
    if(this.watches.size>=MAX_WATCHES)return;
    // A changed native identity makes old pending actions historical.
    const changed=getDb().prepare("UPDATE notifications SET state='resolved',updated_at=? WHERE session_id=? AND native_id!=? AND state!='info' AND state!='resolved'").run(new Date().toISOString(),id,native);
    if(changed.changes)notificationChanged(session.created_by_user_id);
    const entry:Watch={native,stop:()=>{},questions:new Set(),interactions:new Set(),seen:new Set(),checkingResults:new Set(),running:false,completed:false,finals:new Map()};
    this.watches.set(id,entry);
    const context=sessionAgentContext(session),stops:Array<()=>void>=[];
    try {
      stops.push(observeConversationFile({...session,cli_type:session.cli_type??null,codex_session_id:session.codex_session_id??null,claude_session_id:session.claude_session_id??null,project_path:context.projectPath??null},frame=>{
        if(frame.type!=='history')return;
        const current=this.current(id,native);if(!current)return;
        try{this.runtime(current,frame.runtime,entry);this.messages(current,frame.messages,entry,false,true);}catch(error){this.onError(error);}
      }));
      // The shared native stream also carries live approvals and questions that
      // do not yet have durable history records.
      stops.push(agentForSession(session).stream.observe({...context,streamFormat:'state'},frame=>{
        const current=this.current(id,native);if(!current)return;
        try{this.frame(current,frame,entry);}catch(error){this.onError(error);}
      }));
    }catch(error){this.onError(error);}
    entry.stop=()=>{clearTimeout(entry.endTimer);for(const stop of stops)stop();};
  }
  private frame(session:NotificationSession,frame:AgentStreamFrame,entry:Watch) {
    if(frame.type==='snapshot'||frame.type==='patch'){
      const state=frame.type==='snapshot'?frame:frame.state;
      if(!state){this.messages(session,frame.type==='patch'?frame.upserts:[],entry,!frame.baseline);return;}
      if(state.busy){entry.running=true;entry.completed=false;this.recovering(session);}
      else if(state.stage==='idle'&&(entry.running||!!state.completed_at&&Date.parse(state.completed_at)>=this.since)){entry.completed=true;entry.running=false;}
      const active=new Set<string>();
      for(const request of state.interactions){
        const source='interaction:'+JSON.stringify([request.turn_id,request.id]);active.add(source);
        putNotification(session,{kind:request.kind==='question'?'question':'approval',source_id:source,
          message_id:request.id,turn_id:request.turn_id,state:request.submitted?'submitted':'pending',title:request.title,
          body:request.questions?.map(q=>q.question).join('\n\n')||activityResultPreview(request.detail)||'等待你确认本次操作。'});
      }
      for(const source of entry.interactions)if(!active.has(source)){
        updateNotificationState(session,'question',source,'resolved');updateNotificationState(session,'approval',source,'resolved');
      }
      entry.interactions=active;
      this.messages(session,frame.type==='snapshot'?frame.messages:frame.upserts,entry,!frame.baseline);
    }
  }
  private messages(session:NotificationSession,messages:AgentMessage[],entry:Watch,live=false,durable=false) {
    messages=linkConversationInputs(session.id,entry.native,messages);
    const finalInputs=new Map<string,boolean>();
    if(durable){
      let scheduled:boolean|undefined;
      for(const message of messages){
        if(isConversationInput(message))scheduled=message.input_source?.kind==='scheduled';
        else if(message.phase==='final'&&scheduled!==undefined)finalInputs.set(message.id,scheduled);
      }
    }
    // A live final can arrive before the native input has been linked to its
    // saved source. Use the ordered history when this tab has scheduled inputs.
    let hasScheduledInput:boolean|undefined;
    messages=[...entry.finals.values(),...messages];
    for(const message of messages){
      for(const reply of message.question_replies||[]){entry.questions.delete(reply.question_id);updateNotificationState(session,'question','question:'+reply.question_id,message.queued?'submitted':'resolved');}
      if(message.role!=='assistant'||message.streaming||message.presentation==='compaction_summary')continue;
      if(message.async_questions?.length){
        for(const question of message.async_questions){
          if(!question.id)continue;
          // Runtime is authoritative about already answered/ignored questions.
          if(!entry.questions.has(question.id)){
            if(!live||!message.timestamp||Date.parse(message.timestamp)<this.since||ignoredQuestionIds(session.created_by_user_id!,entry.native).includes(question.id))continue;
            const previous=getDb().prepare("SELECT state FROM notifications WHERE session_id=? AND native_id=? AND kind='question' AND source_id=?").get(session.id,entry.native,'question:'+question.id) as Pick<Notification,'state'>|undefined;
            if(previous&&previous.state!=='pending')continue;
            entry.questions.add(question.id);
          }
          putNotification(session,{kind:'question',source_id:'question:'+question.id,message_id:message.id,turn_id:message.turn_id,
            state:'pending',title:'Agent 需要你的回答',body:question.title});
        }
        continue;
      }
      if(!['final','error'].includes(message.phase||'')||!message.text.trim())continue;
      // Reuse the shared native stream to wake external notification observers.
      // Old history and repeated snapshots must not generate a wake-up storm.
      const eventKey=`external-final:${message.id}`, messageTime=Date.parse(message.timestamp||'');
      if(message.phase==='final' && Number.isFinite(messageTime) && messageTime>=Date.now()-120000 && !entry.seen.has(eventKey)){
        entry.seen.add(eventKey);
        broadcastEphemeral({type:'session.final',session_id:session.id,project_id:session.project_id||undefined});
      }
      if(message.timestamp&&Date.parse(message.timestamp)<this.since)continue;
      if(!message.timestamp&&!entry.seen.has(message.id)){
        // Timestamp-less history cannot prove a new result. A live streaming
        // item is tracked below by the stream's earlier upsert.
        if(!entry.seen.has(`live:${message.id}`))continue;
      }
      if(message.phase==='error'){
        const job=this.findRetry(session,message.turn_id);
        const source=job?.root_turn_id||message.turn_id||message.id;
        const previous=getDb().prepare("SELECT state,message_id FROM notifications WHERE session_id=? AND native_id=? AND kind='error' AND source_id=?").get(session.id,entry.native,source) as Pick<Notification,'state'|'message_id'>|undefined;
        putNotification(session,{kind:'error',source_id:source,
          message_id:message.id,turn_id:message.turn_id,state:previous?.message_id===message.id?previous.state:job?this.retryState(job):message.error?.will_retry?'recovering':'pending',
          title:'本轮执行出错',body:message.text});
      }else{
        if(entry.seen.has(`skip:${message.id}`))continue;
        entry.finals.set(message.id,message);while(entry.finals.size>32)entry.finals.delete(entry.finals.keys().next().value!);
        // A final that merely accompanies an outstanding async question must
        // not turn into a delayed completion notice after the answer arrives.
        if(entry.questions.size){entry.seen.add(`skip:${message.id}`);entry.finals.delete(message.id);continue;}
        if(!entry.completed||entry.interactions.size)continue;
        hasScheduledInput??=hasScheduledConversationInput(session.id);
        if(!hasScheduledInput){this.finishResult(session,message,entry,false);}
        else if(!entry.seen.has(`result:${message.id}`)){
          const scheduled=finalInputs.get(message.id);
          if(scheduled!==undefined)this.finishResult(session,message,entry,scheduled);
          else if(!entry.checkingResults.has(message.id)&&entry.checkingResults.size<32){
            entry.checkingResults.add(message.id);
            void this.priorScheduledInput(session,entry.native,message.id).then(scheduled=>{
              const current=this.current(session.id,entry.native);
              if(scheduled!==undefined&&current&&this.watches.get(session.id)===entry&&!entry.seen.has(`result:${message.id}`))this.finishResult(current,message,entry,scheduled);
            }).catch(this.onError).finally(()=>entry.checkingResults.delete(message.id));
          }
        }
      }
      entry.seen.add(message.id);
    }
    for(const message of messages)if(message.streaming)entry.seen.add(`live:${message.id}`);
    const prior=new Map<string,number>(),settled:string[]=[];
    let repliedAt:number|undefined;
    for(const message of messages){
      const at=Date.parse(message.timestamp||'');
      if(!Number.isFinite(at))continue;
      if(message.role==='assistant'&&message.phase==='final'&&!message.streaming&&!message.async_questions?.length)prior.set(message.id,at);
      if(isConversationInput(message)&&!message.input_source){
        for(const [id,completed] of prior)if(completed<at)settled.push(id);
        if(at<=Date.now())repliedAt=Math.max(repliedAt||0,at);
      }
    }
    settleNotificationResults(session,settled,repliedAt?new Date(repliedAt).toISOString():undefined);
    while(entry.seen.size>256)entry.seen.delete(entry.seen.values().next().value!);
  }
  private finishResult(session:NotificationSession,message:AgentMessage,entry:Watch,scheduled:boolean) {
    entry.seen.add(`result:${message.id}`);
    if(!scheduled)putNotification(session,{kind:'result',source_id:message.id,message_id:message.id,turn_id:message.turn_id,state:'info',title:'本轮运行完成',body:message.text});
    const updated=getDb().prepare("UPDATE notifications SET state='resolved',updated_at=? WHERE session_id=? AND native_id=? AND kind='error' AND state IN ('recovering','submitted')").run(new Date().toISOString(),session.id,entry.native);
    if(updated.changes&&session.created_by_user_id)notificationChanged(session.created_by_user_id);
  }
  private async priorScheduledInput(session:NotificationSession,nativeId:string,before:string):Promise<boolean|undefined> {
    const binding={...session,cli_type:session.cli_type??null,codex_session_id:session.codex_session_id??null,claude_session_id:session.claude_session_id??null,project_path:sessionAgentContext(session).projectPath??null};
    let generation:string|null|undefined;
    for(let i=0;i<4;i++){
      const page=await readConversation(binding,{before,limit:80});
      if(!page.available||page.reset||(generation!==undefined&&page.generation!==generation)||!this.current(session.id,nativeId))return;
      const previous=linkConversationInputs(session.id,nativeId,page.messages).reverse().find(isConversationInput);
      if(previous)return previous.input_source?.kind==='scheduled';
      if(!page.has_more)return false;
      const cursor=page.messages[0]?.id;
      if(!cursor||cursor===before)return;
      before=cursor;generation=page.generation;
    }
  }
  private runtime(session:NotificationSession,raw:AgentRuntime,entry:Watch) {
    if(raw.session_id!==entry.native)return;
    const runtime=personalQuestionRuntime(raw,session.created_by_user_id!);
    // Unknown/unavailable runtime does not prove an unanswered question vanished.
    if(runtime.pending_questions){
      const active=new Set<string>();
      for(const group of runtime.pending_questions)for(const question of group.questions){
        if(!question.id)continue;active.add(question.id);
        putNotification(session,{kind:'question',source_id:'question:'+question.id,turn_id:group.turn_id,
          state:'pending',title:'Agent 需要你的回答',body:question.title});
      }
      const submitted=new Set(runtime.submitted_question_ids||[]);
      const previous=getDb().prepare("SELECT source_id FROM notifications WHERE session_id=? AND native_id=? AND kind='question'").all(session.id,entry.native) as Pick<Notification,'source_id'>[];
      for(const row of previous)if(row.source_id.startsWith('question:')){
        const id=row.source_id.slice(9);
        if(!active.has(id))updateNotificationState(session,'question',row.source_id,submitted.has(id)?'submitted':'resolved');
      }
      entry.questions=active;
    }
    if(runtime.state==='running'){entry.running=true;entry.completed=false;this.recovering(session);}
    else if(runtime.state==='idle'&&(entry.running||!!runtime.last_turn_ended_at&&Date.parse(runtime.last_turn_ended_at)>=this.since)){entry.completed=true;entry.running=false;this.messages(session,[],entry);}
  }
  private recovering(session:NotificationSession) {
    const result=getDb().prepare("UPDATE notifications SET state='submitted',updated_at=? WHERE session_id=? AND native_id=? AND kind='error' AND state='pending'").run(new Date().toISOString(),session.id,nativeConversationId(session));
    if(result.changes&&session.created_by_user_id)notificationChanged(session.created_by_user_id);
  }
  private findRetry(session:NotificationSession,turnId?:string) {
    if(!getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_retries' AND type='table'").get())return;
    const rows=getDb().prepare('SELECT data FROM conversation_retries WHERE session_id=? AND native_id=? ORDER BY updated_at DESC LIMIT 20').all(session.id,nativeConversationId(session)) as {data:string}[];
    for(const row of rows)try {const job=JSON.parse(row.data) as ConversationRetry;if(job.root_turn_id===turnId||job.failed_turn_ids.includes(turnId||''))return job;}catch{/* Invalid historical job is not evidence. */}
  }
  private retryState(job:ConversationRetry):Notification['state'] {
    return ['waiting','submitting','running'].includes(job.status)?'recovering':job.status==='succeeded'?'resolved':job.status==='cancelled'&&['new_input','newer_turn','final_answer'].includes(job.stop_reason||'')?'submitted':'pending';
  }
  private retry(sessionId:string,job:ConversationRetry) {
    const session=this.current(sessionId,job.native_id);if(!session)return;
    updateNotificationState(session,'error',job.root_turn_id,this.retryState(job));
  }
  stop() {
    this.stopped=true;this.unsubscribe();clearTimeout(this.timer);this.pending.clear();
    for(const watch of this.watches.values())watch.stop();this.watches.clear();
  }
  limited(userId:string) {
    if(this.watches.size<MAX_WATCHES)return 0;
    const rows=getDb().prepare("SELECT id FROM sessions WHERE created_by_user_id=? AND COALESCE(native_session_id,codex_session_id,claude_session_id) IS NOT NULL AND status IN ('pending','launching','running','detached','released')").all(userId) as {id:string}[];
    return rows.filter(row=>!this.watches.has(row.id)).length;
  }
}
