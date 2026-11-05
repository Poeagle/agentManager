import type {AgentRetrySnapshot} from './agents/types.js';
import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import type {AgentStreamFrame as ConversationStreamFrame} from './agents/events.js';
import {agentForSession} from './agents/index.js';
import {sessionAgentContext} from './agents/session.js';
import {conversationErrorMessage} from './conversation-error.js';

const DELAYS=[10_000,20_000,40_000] as const;
export type RetryStatus='waiting'|'submitting'|'running'|'succeeded'|'exhausted'|'cancelled'|'unknown';
export interface ConversationRetry {
  session_id:string;native_id:string;root_turn_id:string;failed_turn_ids:string[];
  user_id:string;attempt:number;max_attempts:3;status:RetryStatus;
  next_retry_at:string|null;retry_turn_id:string|null;client_id:string|null;
  stop_reason?:string;
}
export type ConversationRetryFrame={type:'retry';retry:ConversationRetry};
export type Inspect=AgentRetrySnapshot;
export type AgentRetryObserver=(nativeId:string,emit:(frame:ConversationStreamFrame)=>void,onFailure?:(turnId:string,error:unknown,willRetry:boolean)=>void)=>{():void;respond(id:string,answer:unknown):unknown};
export interface RetryDependencies {
  allowed:(sessionId:string,userId:string,nativeId:string)=>boolean;
  inspect?:(nativeId:string)=>Promise<Inspect>;
  retryable?:(nativeId:string,error:unknown)=>boolean;
  start?:(nativeId:string,failedTurnId:string,clientId:string)=>Promise<string>;
  observe?:AgentRetryObserver;
}

/** Deliberately narrow: permanent errors and uncertain transport outcomes never
 * generate another execution. Native willRetry notifications belong to Codex. */
export function retryableConversationError(error:unknown):boolean {
  const message=conversationErrorMessage('retry',error,false,null);
  if(!message)return false;
  return /^_?server_overloaded$/.test(message.error?.code||'')||/selected model is at capacity|model (?:is )?(?:at capacity|overloaded)|server (?:is )?(?:overloaded|at capacity)|temporarily (?:overloaded|unavailable)/i.test(message.text);
}
export const instruction='<task_notification>\n上一次执行因模型服务暂时繁忙而中断。请在当前会话中继续用户尚未完成的任务。先核对已经完成或结果未确认的操作，避免重复执行；不要重新开始已经完成的工作。\n</task_notification>';

export {inspectRetryThread,startRetryTurn} from './agents/codex/retry.js';
export class RetrySuperseded extends Error {constructor(readonly reason:string){super(reason);}}

/** One durable budget for an entire failure chain, shared by all browser tabs.
 * Active jobs retain their observer when a browser disconnects. */
export class ConversationRetryManager {
  private jobs=new Map<string,ConversationRetry>();
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  private observers=new Map<string,ReturnType<AgentRetryObserver>>();
  private listeners=new Map<string,Set<(frame:ConversationRetryFrame)=>void>>();
  private monitors=new Map<string,{nativeId:string;stop:()=>void;timer?:ReturnType<typeof setTimeout>}>();
  private stopped=false;
  private retryable:NonNullable<RetryDependencies['retryable']>;
  private inspect:NonNullable<RetryDependencies['inspect']>;
  private start:NonNullable<RetryDependencies['start']>;
  private observe:AgentRetryObserver;
  constructor(private db:Database.Database,private deps:RetryDependencies) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_retries (
      session_id TEXT NOT NULL, native_id TEXT NOT NULL, root_turn_id TEXT NOT NULL,
      data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(session_id,native_id,root_turn_id));`);
    const provider=(nativeId:string)=>{const sessions=db.prepare('SELECT * FROM sessions WHERE native_session_id=? OR codex_session_id=? OR claude_session_id=?').all(nativeId,nativeId,nativeId) as import('./agents/types.js').AgentSession[];
      if(!sessions.length||new Set(sessions.map(session=>agentForSession(session).descriptor.id)).size!==1)throw Error('重试目标不明确');const session=sessions[0];return {adapter:agentForSession(session),context:sessionAgentContext(session)};};
    this.retryable=deps.retryable??(deps.inspect?(_native,error)=>retryableConversationError(error):(native,error)=>provider(native).adapter.retry.retryable(error));
    this.inspect=deps.inspect??(native=>provider(native).adapter.retry.inspect(native));this.start=deps.start??((native,failed,client)=>provider(native).adapter.retry.start(native,failed,client));this.observe=deps.observe??((native,emit,onFailure)=>{const {adapter,context}=provider(native);return adapter.stream.observe({...context,streamFormat:'state'},emit,onFailure);});
    for(const row of db.prepare('SELECT data FROM conversation_retries ORDER BY updated_at').all() as {data:string}[]) {
      try {const job=JSON.parse(row.data) as ConversationRetry;
        if(!['waiting','submitting','running'].includes(job.status))continue;
        this.jobs.set(job.session_id,job);this.watch(job);
        if(job.status==='waiting')this.arm(job);else void this.reconcile(job);
      }catch{/* A corrupt entry must never authorize another execution. */}
    }
  }
  /** Keep failure detection alive when the user switches tabs or closes the
   * browser. Unsupported/unloaded engines are left alone until reattached. */
  monitor(sessionId:string,userId:string,nativeId:string) {
    if(this.stopped||!this.deps.allowed(sessionId,userId,nativeId))return;
    const existing=this.monitors.get(sessionId);if(existing?.nativeId===nativeId)return;
    if(existing){clearTimeout(existing.timer);existing.stop();this.monitors.delete(sessionId);}
    const stop=this.observe(nativeId,frame=>{
      const entry=this.monitors.get(sessionId);if(!entry||entry.nativeId!==nativeId)return;
      if(!this.deps.allowed(sessionId,userId,nativeId)||frame.type==='unavailable'&&!frame.retrying){
        queueMicrotask(()=>entry.stop());this.monitors.delete(sessionId);
        if(frame.type==='unavailable'&&frame.reconnect&&!this.stopped){
          entry.timer=setTimeout(()=>{this.monitors.delete(sessionId);this.monitor(sessionId,userId,nativeId);},2500);
          this.monitors.set(sessionId,{...entry,nativeId:''});
        }
      }
    },(turnId,error,willRetry)=>this.failure(sessionId,userId,nativeId,turnId,error,willRetry));
    this.monitors.set(sessionId,{nativeId,stop});
  }
  subscribe(sessionId:string,nativeId:string,emit:(frame:ConversationRetryFrame)=>void) {
    let set=this.listeners.get(sessionId);if(!set)this.listeners.set(sessionId,set=new Set());set.add(emit);
    for(const row of this.db.prepare('SELECT data FROM conversation_retries WHERE session_id=? AND native_id=? ORDER BY updated_at DESC LIMIT 20').all(sessionId,nativeId) as {data:string}[]){try{emit({type:'retry',retry:JSON.parse(row.data)});}catch{}}
    return ()=>{set!.delete(emit);if(!set!.size)this.listeners.delete(sessionId);};
  }
  failure(sessionId:string,userId:string,nativeId:string,turnId:string,error:unknown,willRetry:boolean) {
    if(this.stopped||willRetry||!this.deps.allowed(sessionId,userId,nativeId))return;
    try{if(!this.retryable(nativeId,error))return;}catch{return;}
    const active=this.jobs.get(sessionId);
    if(active) {
      if(active.native_id===nativeId&&active.status==='running'&&active.retry_turn_id===turnId)this.failed(active,turnId);
      return;
    }
    // Baselines never call this method. Replayed live events and page refreshes
    // cannot reset the cap, including a terminal failure from the last retry.
    const rows=this.db.prepare('SELECT data FROM conversation_retries WHERE session_id=? AND native_id=?').all(sessionId,nativeId) as {data:string}[];
    if(rows.some(row=>{try{const job=JSON.parse(row.data) as ConversationRetry;return job.failed_turn_ids.includes(turnId)||job.retry_turn_id===turnId;}catch{return true;}}))return;
    const job:ConversationRetry={session_id:sessionId,native_id:nativeId,root_turn_id:turnId,failed_turn_ids:[turnId],user_id:userId,attempt:0,max_attempts:3,status:'waiting',next_retry_at:new Date(Date.now()+DELAYS[0]).toISOString(),retry_turn_id:null,client_id:null};
    this.jobs.set(sessionId,job);this.save(job);this.watch(job);this.arm(job);
  }
  cancel(sessionId:string,nativeId:string,reason='user_cancelled') {
    const job=this.jobs.get(sessionId);if(job?.native_id===nativeId)this.finish(job,'cancelled',reason);
  }
  close() {
    this.stopped=true;for(const entry of this.monitors.values()){clearTimeout(entry.timer);entry.stop();}this.monitors.clear();
    for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();
    for(const stop of this.observers.values())stop();this.observers.clear();this.listeners.clear();
  }
  private save(job:ConversationRetry) {
    this.db.prepare(`INSERT INTO conversation_retries(session_id,native_id,root_turn_id,data) VALUES (?,?,?,?) ON CONFLICT(session_id,native_id,root_turn_id) DO UPDATE SET data=excluded.data,updated_at=datetime('now')`).run(job.session_id,job.native_id,job.root_turn_id,JSON.stringify(job));
    for(const emit of this.listeners.get(job.session_id)??[])emit({type:'retry',retry:{...job,failed_turn_ids:[...job.failed_turn_ids]}});
  }
  private current(job:ConversationRetry) {return !this.stopped&&this.jobs.get(job.session_id)===job;}
  private authorized(job:ConversationRetry) {return this.deps.allowed(job.session_id,job.user_id,job.native_id);}
  private finish(job:ConversationRetry,status:RetryStatus,reason?:string) {
    if(!this.current(job))return;
    job.status=status;job.next_retry_at=null;job.stop_reason=reason;this.save(job);this.jobs.delete(job.session_id);
    clearTimeout(this.timers.get(job.session_id));this.timers.delete(job.session_id);
    this.observers.get(job.session_id)?.();this.observers.delete(job.session_id);
  }
  private arm(job:ConversationRetry) {
    clearTimeout(this.timers.get(job.session_id));
    this.timers.set(job.session_id,setTimeout(()=>{this.timers.delete(job.session_id);void this.run(job);},Math.max(0,Date.parse(job.next_retry_at!)-Date.now())));
  }
  private failed(job:ConversationRetry,turnId:string) {
    if(!job.failed_turn_ids.includes(turnId))job.failed_turn_ids.push(turnId);
    if(job.attempt>=3){this.finish(job,'exhausted');return;}
    job.status='waiting';job.next_retry_at=new Date(Date.now()+DELAYS[job.attempt]).toISOString();this.save(job);this.arm(job);
  }
  private watch(job:ConversationRetry) {
    if(!this.current(job)||this.observers.has(job.session_id))return;
    const stop=this.observe(job.native_id,frame=>{
      if(!this.current(job))return;
      if(!this.authorized(job)){this.finish(job,'cancelled','access_changed');return;}
      if(frame.type==='unavailable'&&frame.reconnect){
        this.observers.delete(job.session_id);
        // Reconnect the observer without resubmitting any input.
        const timer=setTimeout(()=>{if(this.current(job)){this.watch(job);if(job.status==='running'||job.status==='submitting')void this.reconcile(job);}},2500);timer.unref?.();return;
      }
      this.frame(job,frame);
    },(turnId,error,willRetry)=>this.failure(job.session_id,job.user_id,job.native_id,turnId,error,willRetry));
    this.observers.set(job.session_id,stop);
  }
  private frame(job:ConversationRetry,frame:ConversationStreamFrame) {
    if(frame.type==='queue'&&frame.messages.length){this.finish(job,'cancelled','queued_input');return;}
    if(frame.type!=='snapshot'||!frame.turn_id||job.status==='submitting')return;
    if(job.status==='waiting') {
      if(frame.turn_id!==job.failed_turn_ids.at(-1))this.finish(job,'cancelled','newer_turn');
      return;
    }
    if(frame.turn_id!==job.retry_turn_id){this.finish(job,'cancelled','newer_turn');return;}
    if(frame.messages.some(message=>message.role==='user'&&message.client_id!==job.client_id)){this.finish(job,'cancelled','new_input');return;}
    if(!frame.busy&&frame.completed_at)void this.reconcile(job);
  }
  private async reconcile(job:ConversationRetry) {
    try {
      const snapshot=await this.inspect(job.native_id);
      if(!this.current(job)||!['running','submitting'].includes(job.status))return;
      if(!this.authorized(job)){this.finish(job,'cancelled','access_changed');return;}
      const turn=snapshot.turn;
      if(job.status==='submitting') {
        if(turn?.user_client_ids.includes(job.client_id)){
          job.retry_turn_id=turn.id;job.status='running';this.save(job);
        }else{this.finish(job,'unknown');return;}
      }
      if(snapshot.queued||!turn||snapshot.state==='unavailable'||turn.id!==job.retry_turn_id){this.finish(job,'cancelled',snapshot.queued?'queued_input':!turn||snapshot.state==='unavailable'?'thread_unavailable':'newer_turn');return;}
      if(turn.user_client_ids.some(id=>id!==job.client_id)){this.finish(job,'cancelled','new_input');return;}
      if(turn.status==='running')return;
      if(turn.status==='completed'){this.finish(job,'succeeded');return;}
      if(turn.status==='failed'&&turn.retryable&&!turn.has_final){this.failed(job,turn.id);return;}
      this.finish(job,'cancelled',turn.status==='interrupted'?'interrupted':turn.has_final?'final_answer':'non_retryable_error');
    }catch{if(this.current(job))this.finish(job,'unknown');}
  }
  private async run(job:ConversationRetry) {
    if(!this.current(job)||job.status!=='waiting')return;
    if(!this.authorized(job)){this.finish(job,'cancelled','access_changed');return;}
    try {
      const snapshot=await this.inspect(job.native_id);
      if(!this.current(job)||job.status!=='waiting')return;
      const turn=snapshot.turn;
      const reason=!this.authorized(job)?'access_changed':disqualified(snapshot,job.failed_turn_ids.at(-1)!);
      if(reason){this.finish(job,'cancelled',reason);return;}
      // Commit before dispatch. A crash or lost response cannot reset the budget.
      job.attempt++;job.status='submitting';job.next_retry_at=null;job.client_id=`auto-retry-${randomUUID()}`;this.save(job);
      const id=await this.start(job.native_id,turn!.id,job.client_id);
      if(!this.current(job))return;
      job.retry_turn_id=id;job.status='running';this.save(job);void this.reconcile(job);
    }catch(error){
      if(!this.current(job))return;
      this.finish(job,error instanceof RetrySuperseded?'cancelled':'unknown',error instanceof RetrySuperseded?error.reason:undefined);
    }
  }
}
export function disqualified(snapshot:Inspect,failedTurnId:string):string|undefined {
  if(snapshot.state!=='idle')return snapshot.state==='busy'?'thread_busy':'thread_unavailable';
  if(snapshot.queued)return 'queued_input';
  const turn=snapshot.turn;if(!turn)return 'thread_unavailable';
  if(turn.id!==failedTurnId)return 'newer_turn';
  if(turn.status!=='failed')return 'turn_finished';
  if(!turn.retryable)return 'non_retryable_error';
  if(turn.has_final)return 'final_answer';
}
