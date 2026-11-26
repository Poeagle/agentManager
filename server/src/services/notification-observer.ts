import {getDb} from '../db/index.js';
import {subscribe,broadcastEphemeral} from './event-store.js';
import {agentForSession} from './agents/index.js';
import {sessionAgentContext} from './agents/session.js';
import type {AgentMessage,AgentRuntime} from './agents/types.js';
import type {AgentStreamFrame} from './agents/events.js';
import type {ConversationRetry} from './conversation-retry.js';
import {observeConversationFile} from './conversation-file-stream.js';
import {activityResultPreview} from './conversation-activity.js';
import {hasScheduledConversationInput,isConversationInput,linkConversationInputs,precedingScheduledInput} from './conversation-input-links.js';
import {nativeConversationId} from './session-identity.js';
import {personalQuestionRuntime,ignoredQuestionIds} from './question-attention.js';
import {
  canReadNotifications,notificationSession,putNotification,updateNotificationState,pruneNotifications,
  notificationChanged,settleNotificationResults,type NotificationSession,type Notification,type NotificationInput,
} from './notifications.js';

const ACTIVE=new Set(['pending','launching','running','detached','released']);
const MAX_WATCHES=512;
type Watch={native:string;stop:()=>void;questions:Set<string>;interactions:Set<string>;seen:Set<string>;checkingOutcomes:Set<string>;running:boolean;completed:boolean;outcomes:Map<string,AgentMessage>;turnInputs:Map<string,boolean>;endTimer?:ReturnType<typeof setTimeout>};

/** Shared stream leases observe native events regardless of the selected tab. */
export class NotificationObserver {
  private watches=new Map<string,Watch>();
  private unsubscribe:()=>void=()=>{};
  private stopped=false;
  private since:number;
  private readonly childErrorSince=Date.now();
  private pruneAt=0;
  private pending=new Set<string>();
  private relays=new Set<Promise<void>>();
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private onError:(error:unknown)=>void, private relayChild:(session:NotificationSession,notice:NotificationInput)=>Promise<void>) {
    const row=getDb().prepare("SELECT value FROM settings WHERE key='notification-center-since'").get() as {value:string}|undefined;
    this.since=Number(row?.value)||Date.now();
    getDb().prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('notification-center-since',?)").run(String(this.since));
  }
  private publish(session:NotificationSession,notice:NotificationInput) {
    if(!session.parent_session_id)putNotification(session,notice);
    else if(notice.kind!=='result'&&notice.state==='pending'){
      const relay=this.relayChild(session,notice).catch(this.onError);
      this.relays.add(relay);
      void relay.then(()=>this.relays.delete(relay));
    }
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
    const entry:Watch={native,stop:()=>{},questions:new Set(),interactions:new Set(),seen:new Set(),checkingOutcomes:new Set(),running:false,completed:false,outcomes:new Map(),turnInputs:new Map()};
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
        this.publish(session,{kind:request.kind==='question'?'question':'approval',source_id:source,
          message_id:request.id,turn_id:request.turn_id,state:request.submitted?'submitted':'pending',title:request.title,
          body:request.questions?.map(q=>q.question+(session.parent_session_id&&q.options?.length?`\n选项：${q.options.map(o=>o.label).join('、')}`:'')).join('\n\n')||activityResultPreview(request.detail)||'等待确认本次操作。'});
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
    const outcomeInputs=new Map<string,boolean>();
    let scheduled:boolean|undefined;
    for(const message of messages){
      if(isConversationInput(message)){
        scheduled=message.input_source?.kind==='scheduled';
        // A live echo with no submission identity can precede the durable
        // input link. Wait for that link before treating it as manual input.
        if(message.turn_id&&(durable||message.client_id||scheduled))entry.turnInputs.set(message.turn_id,scheduled);
      }else if(durable&&scheduled!==undefined&&(message.phase==='final'||message.phase==='error')){
        outcomeInputs.set(message.id,scheduled);
      }
    }
    while(entry.turnInputs.size>32)entry.turnInputs.delete(entry.turnInputs.keys().next().value!);
    // History can establish provenance when the native stream omits the input
    // or reports a different turn identity for the same message.
    let hasScheduledInput:boolean|undefined;
    messages=[...entry.outcomes.values(),...messages];
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
          this.publish(session,{kind:'question',source_id:'question:'+question.id,message_id:message.id,turn_id:message.turn_id,
            state:'pending',title:'Agent 需要你的回答',body:question.title+(session.parent_session_id&&question.options?.length?`\n选项：${question.options.join('、')}`:'')});
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
      if(entry.seen.has(`outcome:${message.id}`)||entry.seen.has(`skip:${message.id}`))continue;
      entry.outcomes.set(message.id,message);
      while(entry.outcomes.size>32)entry.outcomes.delete(entry.outcomes.keys().next().value!);
      if(message.phase==='final'){
        // A final that merely accompanies an outstanding async question must
        // not turn into a delayed completion notice after the answer arrives.
        if(entry.questions.size){entry.seen.add(`skip:${message.id}`);entry.outcomes.delete(message.id);continue;}
        if(!entry.completed||entry.interactions.size)continue;
      }
      hasScheduledInput??=hasScheduledConversationInput(session.id);
      const scheduled=hasScheduledInput?outcomeInputs.get(message.id)??(message.turn_id?entry.turnInputs.get(message.turn_id):undefined):false;
      if(scheduled!==undefined)this.finishOutcome(session,message,entry,scheduled);
      else if(!entry.checkingOutcomes.has(message.id)&&entry.checkingOutcomes.size<32){
        entry.checkingOutcomes.add(message.id);
        const binding={...session,cli_type:session.cli_type??null,codex_session_id:session.codex_session_id??null,claude_session_id:session.claude_session_id??null,project_path:sessionAgentContext(session).projectPath??null};
        void precedingScheduledInput(binding,entry.native,message.id).then(scheduled=>{
          const current=this.current(session.id,entry.native);
          if(scheduled!==undefined&&current&&this.watches.get(session.id)===entry&&!entry.seen.has(`outcome:${message.id}`))this.finishOutcome(current,message,entry,scheduled);
        }).catch(this.onError).finally(()=>entry.checkingOutcomes.delete(message.id));
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
  private finishOutcome(session:NotificationSession,message:AgentMessage,entry:Watch,scheduled:boolean) {
    if(message.phase==='error'){
      entry.outcomes.delete(message.id);
      const job=this.findRetry(session,message.turn_id);
      const source=job?.root_turn_id||message.turn_id||message.id;
      if(session.parent_session_id){
        entry.seen.add(`outcome:${message.id}`);
        // A replayed error is history. Current native questions are recovered separately from runtime state.
        if(!scheduled&&(!message.timestamp||Date.parse(message.timestamp)>=this.childErrorSince))this.publish(session,{kind:'error',source_id:source,message_id:message.id,turn_id:message.turn_id,
          state:'pending',title:'子 Agent 本轮执行出错',body:message.text});
        return;
      }
      const previous=getDb().prepare("SELECT state,message_id FROM notifications WHERE session_id=? AND native_id=? AND kind='error' AND source_id=?").get(session.id,entry.native,source) as Pick<Notification,'state'|'message_id'>|undefined;
      if(scheduled){
        entry.seen.add(`outcome:${message.id}`);
        if(previous?.message_id===message.id)updateNotificationState(session,'error',source,'resolved');
      }else{
        putNotification(session,{kind:'error',source_id:source,
          message_id:message.id,turn_id:message.turn_id,state:previous?.message_id===message.id?previous.state:job?this.retryState(job):message.error?.will_retry?'recovering':'pending',
          title:'本轮执行出错',body:message.text});
      }
      return;
    }
    entry.seen.add(`outcome:${message.id}`);
    if(!scheduled)putNotification(session,{kind:'result',source_id:message.id,message_id:message.id,turn_id:message.turn_id,state:'info',title:'本轮运行完成',body:message.text});
    else updateNotificationState(session,'result',message.id,'resolved');
    const updated=getDb().prepare("UPDATE notifications SET state='resolved',updated_at=? WHERE session_id=? AND native_id=? AND kind='error' AND state IN ('recovering','submitted')").run(new Date().toISOString(),session.id,entry.native);
    if(updated.changes&&session.created_by_user_id)notificationChanged(session.created_by_user_id);
  }
  private runtime(session:NotificationSession,raw:AgentRuntime,entry:Watch) {
    if(raw.session_id!==entry.native)return;
    const runtime=personalQuestionRuntime(raw,session.created_by_user_id!);
    // Unknown/unavailable runtime does not prove an unanswered question vanished.
    if(runtime.pending_questions){
      const active=new Set<string>();
      for(const group of runtime.pending_questions)for(const question of group.questions){
        if(!question.id)continue;active.add(question.id);
        this.publish(session,{kind:'question',source_id:'question:'+question.id,turn_id:group.turn_id,
          state:'pending',title:'Agent 需要你的回答',body:question.title+(session.parent_session_id&&question.options?.length?`\n选项：${question.options.join('、')}`:'')});
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
    const previous=getDb().prepare("SELECT state FROM notifications WHERE session_id=? AND native_id=? AND kind='error' AND source_id=?")
      .get(session.id,job.native_id,job.root_turn_id) as Pick<Notification,'state'>|undefined;
    if(previous&&previous.state!=='resolved')updateNotificationState(session,'error',job.root_turn_id,this.retryState(job));
  }
  async stop() {
    this.stopped=true;this.unsubscribe();clearTimeout(this.timer);this.pending.clear();
    for(const watch of this.watches.values())watch.stop();this.watches.clear();
    await Promise.all(this.relays);
  }
  limited(userId:string) {
    if(this.watches.size<MAX_WATCHES)return 0;
    const rows=getDb().prepare("SELECT id FROM sessions WHERE created_by_user_id=? AND COALESCE(native_session_id,codex_session_id,claude_session_id) IS NOT NULL AND status IN ('pending','launching','running','detached','released')").all(userId) as {id:string}[];
    return rows.filter(row=>!this.watches.has(row.id)).length;
  }
}
