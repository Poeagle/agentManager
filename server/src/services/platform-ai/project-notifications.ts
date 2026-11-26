import {agentForSession} from '../agents/index.js';
import type {FastifyInstance} from 'fastify';
import {createHash} from 'crypto';
import {nanoid} from 'nanoid';
import {z} from 'zod';
import {getDb} from '../../db/index.js';
import {findUserById,userCanUseSessionTool,userOwnsProject,userProjectIds} from '../../auth.js';
import {userHasPermission} from '../rbac.js';
import {sessionPresenter} from '../session-labels.js';
import {getSession} from '../session-manager.js';
import {getTracker} from '../session-state.js';
import type {AgentTextMessage} from '../prompt-context.js';
import {ChannelError} from './channels.js';
import {type AiConfig,publicFailure} from './config.js';
import {platformApi} from './tools.js';
import {refreshConversation} from './live.js';
import {notificationReplyTarget,replyTurnKey} from './quoted-replies.js';
import {formatTaskNotification} from './store.js';
import {nativeConversationId} from '../session-identity.js';
import {readConversation} from '../conversation-reader.js';
import {sessionAgentContext} from '../agents/session.js';
import {hasScheduledConversationInput,isConversationInput,linkConversationInputs,precedingScheduledInput} from '../conversation-input-links.js';

export interface NotificationRecipient {
  id: string; name: string; channel_id: string; external_user_id: string; chat_id: string; group: boolean;
}
export interface ProjectNotificationRule {
  id: string; user_id: string; project_id: string; recipient_id: string; conversation_id: string;
  enabled: number; on_complete: number; on_input: number; since_ms: number;
}
interface Watch extends ProjectNotificationRule { session_id: string; failures: number; rechecks: number }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);

/** Only already-authorized identities are selectable. No credentials are returned. */
export function notificationRecipients(userId: string): NotificationRecipient[] {
  const bindings = getDb().prepare(`SELECT b.id,b.channel_id,b.external_user_id,ch.name,
    COALESCE(s.last_chat_id,(SELECT c.external_chat_id FROM platform_ai_conversations c
      WHERE c.user_id=b.user_id AND c.channel_id=b.channel_id AND c.external_user_id=b.external_user_id
      ORDER BY c.rowid DESC LIMIT 1),b.external_user_id) AS chat_id
    FROM platform_ai_bindings b JOIN platform_ai_channels ch ON ch.id=b.channel_id
    LEFT JOIN platform_ai_channel_senders s ON s.channel_id=b.channel_id AND s.external_user_id=b.external_user_id
    WHERE b.user_id=? AND ch.enabled=1 AND ch.kind!='wecom_webhook'`).all(userId) as Array<Omit<NotificationRecipient, 'group'>>;
  const groups = getDb().prepare(`SELECT n.id,n.channel_id,ch.name FROM platform_ai_notification_targets n
    JOIN platform_ai_channels ch ON ch.id=n.channel_id WHERE n.user_id=? AND ch.enabled=1 AND ch.kind='wecom_webhook'`)
    .all(userId) as Array<{id: string; channel_id: string; name: string}>;
  return [
    ...bindings.map(row => ({...row, id: `binding:${row.id}`, name: `${row.name} · ${row.external_user_id}`, group: false})),
    ...groups.map(row => ({...row, id: `target:${row.id}`, name: `${row.name}（群通知）`, external_user_id: userId, chat_id: `notifications:${userId}`, group: true})),
  ];
}

export function projectNotificationSettings(userId: string) {
  const allowed = userProjectIds(userId);
  const projects = (getDb().prepare('SELECT id,name FROM projects ORDER BY name,id').all() as Array<{id: string; name: string}>)
    .filter(project => allowed.has(project.id));
  const rules = (getDb().prepare(`SELECT r.*,
    (SELECT w.error FROM platform_ai_project_notification_watches w WHERE w.rule_id=r.id AND w.error IS NOT NULL LIMIT 1) AS error
    FROM platform_ai_project_notifications r WHERE r.user_id=? ORDER BY r.rowid`).all(userId) as ProjectNotificationRule[])
    .filter(rule => allowed.has(rule.project_id));
  return {projects, recipients: notificationRecipients(userId), rules};
}

const ruleInput = z.object({
  project_id: z.string().min(1).max(256), recipient_id: z.string().min(1).max(300),
  enabled: z.boolean(), on_complete: z.boolean(), on_input: z.boolean(),
}).strict().refine(value => value.on_complete || value.on_input, {message: '请至少选择一种通知事件'});

export function saveProjectNotification(userId: string, value: unknown, id?: string): ProjectNotificationRule {
  const input = ruleInput.parse(value);
  if (!userOwnsProject(userId, input.project_id)) throw new ChannelError('项目不存在或无访问权限', 404);
  const previous = id ? getDb().prepare('SELECT * FROM platform_ai_project_notifications WHERE id=? AND user_id=?').get(id, userId) as ProjectNotificationRule | undefined : undefined;
  if (id && !previous) throw new ChannelError('通知规则不存在', 404);
  const recipient = notificationRecipients(userId).find(item => item.id === input.recipient_id);
  if (!recipient && (!previous || input.enabled || previous.recipient_id !== input.recipient_id || previous.project_id !== input.project_id)) {
    throw new ChannelError('请选择已启用且已绑定当前用户的通知渠道');
  }
  const duplicate = getDb().prepare('SELECT id FROM platform_ai_project_notifications WHERE user_id=? AND project_id=? AND recipient_id=? AND id<>?')
    .get(userId, input.project_id, input.recipient_id, id || '');
  if (duplicate) throw new ChannelError('此项目已配置该通知渠道，请修改现有规则', 409);
  return getDb().transaction(() => {
    const ruleId = id || nanoid(16);
    const changedDestination = !previous || previous.project_id !== input.project_id || previous.recipient_id !== input.recipient_id;
    let conversationId = previous?.conversation_id;
    if (changedDestination) {
      if (!recipient) throw new ChannelError('接收渠道已失效');
      const chatId = recipient.group ? `project:${ruleId}:${nanoid(8)}` : recipient.chat_id;
      const existing = getDb().prepare(`SELECT id FROM platform_ai_conversations WHERE user_id=? AND COALESCE(channel_id,'')=? AND external_chat_id=? AND external_user_id=?`)
        .get(userId, recipient.group ? '' : recipient.channel_id, chatId, recipient.external_user_id) as {id: string} | undefined;
      conversationId = existing?.id || nanoid(16);
      if (!existing) getDb().prepare(`INSERT INTO platform_ai_conversations
          (id,user_id,channel_id,external_chat_id,external_user_id,title) VALUES (?,?,?,?,?,?)`)
          .run(conversationId, userId, recipient.group ? null : recipient.channel_id, chatId, recipient.external_user_id, '项目自动通知');
    }
    // Re-enabling starts a new observation window; never replay old completed work.
    const since = changedDestination || (!previous?.enabled && input.enabled) ? Math.max(Date.now(), (previous?.since_ms || 0) + 1) : previous!.since_ms;
    getDb().prepare(`INSERT INTO platform_ai_project_notifications
      (id,user_id,project_id,recipient_id,conversation_id,enabled,on_complete,on_input,since_ms) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,recipient_id=excluded.recipient_id,
      conversation_id=excluded.conversation_id,enabled=excluded.enabled,on_complete=excluded.on_complete,on_input=excluded.on_input,since_ms=excluded.since_ms`)
      .run(ruleId, userId, input.project_id, input.recipient_id, conversationId, Number(input.enabled), Number(input.on_complete), Number(input.on_input), since);
    if (changedDestination || (!previous?.enabled && input.enabled)) {
      getDb().prepare('DELETE FROM platform_ai_project_notification_watches WHERE rule_id=?').run(ruleId);
    }
    if (input.enabled) getDb().prepare(`INSERT INTO platform_ai_project_notification_watches (rule_id,session_id,next_check_at)
      SELECT ?,id,? FROM sessions WHERE project_id=? AND created_by_user_id=? AND status IN ('pending','launching','running','detached','released')
      ON CONFLICT(rule_id,session_id) DO UPDATE SET next_check_at=excluded.next_check_at`)
      .run(ruleId, Date.now(), input.project_id, userId);
    return getDb().prepare('SELECT * FROM platform_ai_project_notifications WHERE id=?').get(ruleId) as ProjectNotificationRule;
  })();
}

export function canNotifyProject(rule: ProjectNotificationRule, sessionId: string): boolean {
  const user = findUserById(rule.user_id);
  const session = getSession(sessionId);
  return !!(rule.enabled && user && !user.disabled && userHasPermission(user.id, 'agent_api') && session && !session.parent_session_id
    && session.project_id === rule.project_id && session.created_by_user_id === rule.user_id
    && userCanUseSessionTool(user.id, sessionId, agentForSession(session).descriptor.id, session.mode === 'terminal' ? 'terminal' : 'session'));
}

/** Recheck pending delivery authorization, including revocation after enqueue. */
export function authorizeProjectNotice(key: string, conversationId: string) {
  const [,ruleId,sessionId,kind,since] = key.split(':');
  const rule = getDb().prepare('SELECT * FROM platform_ai_project_notifications WHERE id=? AND conversation_id=?').get(ruleId, conversationId) as ProjectNotificationRule | undefined;
  if (!rule || String(rule.since_ms) !== since || !canNotifyProject(rule, sessionId) || !(kind === 'error' ? true : kind === 'complete' ? rule.on_complete : rule.on_input)) {
    throw new ChannelError('项目通知已停用或会话访问权限已失效', 403, true);
  }
  const recipient = notificationRecipients(rule.user_id).find(item => item.id === rule.recipient_id);
  if (!recipient) throw new ChannelError('通知渠道或用户绑定已失效', 403, true);
  return recipient;
}

export interface CompletionNotice {
  session_id:string;
  native_id:string;
  timestamp:string|null;
  text_length:number;
  text_hash:string;
}

export function completionNotice(sessionId:string,text:string,timestamp:string|null):CompletionNotice|undefined {
  const session=getSession(sessionId),nativeId=session&&nativeConversationId(session);
  if(nativeId&&text)return {session_id:sessionId,native_id:nativeId,timestamp,text_length:text.length,text_hash:hash(text)};
}

export function completionAvailableAt(personalId:number|null,now=Date.now()):number {
  const row=personalId&&getDb().prepare('SELECT created_at FROM notifications WHERE id=?').get(personalId) as {created_at:string}|undefined;
  const created=row?Date.parse(row.created_at):NaN;
  return (Number.isFinite(created)?created:now)+10_000;
}

/** The public excerpt may be clipped. Require a unique native final before
 * linking it to a web read receipt or to the preceding scheduled input. */
export async function resolveCompletionNotice(userId:string,notice:CompletionNotice|undefined):Promise<{personalId:number|null;scheduled?:boolean}> {
  const session=notice&&getSession(notice.session_id);
  if(!notice||!session||session.created_by_user_id!==userId||nativeConversationId(session)!==notice.native_id)return {personalId:null};
  const project=session.project_id?getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined:undefined;
  const binding={...session,cli_type:session.cli_type??null,codex_session_id:session.codex_session_id??null,claude_session_id:session.claude_session_id??null,project_path:project?.path??null};
  try {
    const page=await readConversation(binding,{limit:80});
    const matches=page.messages.filter(item=>item.role==='assistant'&&item.phase==='final'&&
      (!notice.timestamp||item.timestamp===notice.timestamp)&&hash(item.text.slice(-notice.text_length))===notice.text_hash);
    if(matches.length!==1)return {personalId:null};
    const final=matches[0],index=page.messages.indexOf(final);
    const personal=getDb().prepare(`SELECT id FROM notifications WHERE user_id=? AND session_id=? AND native_id=?
      AND message_id=? AND kind IN ('result','question') ORDER BY kind='result' DESC LIMIT 1`).get(userId,session.id,notice.native_id,final.id) as {id:number}|undefined;
    let previous=linkConversationInputs(session.id,notice.native_id,page.messages.slice(0,index)).reverse().find(isConversationInput);
    if(!previous&&page.has_more){
      const older=await readConversation(binding,{before:final.id,limit:80});
      if(older.available&&!older.reset&&older.generation===page.generation)previous=linkConversationInputs(session.id,notice.native_id,older.messages).reverse().find(isConversationInput);
    }
    return {personalId:personal?.id??null,...(previous?{scheduled:previous.input_source?.kind==='scheduled'}:{})};
  }catch{return {personalId:null};}
}

/** Legacy errors may have been queued before personal notifications filtered the source. */
export async function isScheduledProjectError(userId:string,sessionId:string,messageId:string|null):Promise<boolean> {
  if(!messageId||!hasScheduledConversationInput(sessionId))return false;
  const session=getSession(sessionId),nativeId=session&&nativeConversationId(session);
  if(!session||!nativeId||session.created_by_user_id!==userId)return false;
  const binding={...session,cli_type:session.cli_type??null,codex_session_id:session.codex_session_id??null,claude_session_id:session.claude_session_id??null,project_path:sessionAgentContext(session).projectPath??null};
  return await precedingScheduledInput(binding,nativeId,messageId).catch(()=>undefined)===true;
}

/** Event-driven observation; durable watches recover delayed native logs/restarts. */
export class ProjectNotifications {
  private pending = new Map<string, Promise<void>>();
  private lastDiscovery = 0;
  private structuredSince:number;
  constructor(private app: FastifyInstance, private signal: AbortSignal) {
    const db=getDb();db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('project-notice-structured-since',?)").run(String(Date.now()));
    this.structuredSince=Number((db.prepare("SELECT value FROM settings WHERE key='project-notice-structured-since'").get() as {value:string}).value);
  }

  wake(sessionId: string, urgent = false): void {
    const now = Date.now();
    getDb().prepare(`INSERT INTO platform_ai_project_notification_watches (rule_id,session_id,next_check_at,rechecks)
      SELECT r.id,s.id,?,? FROM platform_ai_project_notifications r JOIN sessions s ON s.project_id=r.project_id AND s.created_by_user_id=r.user_id
      WHERE r.enabled=1 AND s.id=?
      ON CONFLICT(rule_id,session_id) DO UPDATE SET next_check_at=MIN(next_check_at,excluded.next_check_at),rechecks=MAX(rechecks,excluded.rechecks)
      WHERE failures=0`).run(now + 250, urgent ? 3 : 0, sessionId);
  }

  tick(config: AiConfig): void {
    const now = Date.now();
    if (now - this.lastDiscovery >= 30000) {
      this.lastDiscovery = now;
      getDb().prepare(`INSERT OR IGNORE INTO platform_ai_project_notification_watches (rule_id,session_id,next_check_at)
        SELECT r.id,s.id,? FROM platform_ai_project_notifications r JOIN sessions s ON s.project_id=r.project_id AND s.created_by_user_id=r.user_id
        WHERE r.enabled=1 AND (s.status IN ('pending','launching','running','detached','released')
        OR (julianday(s.updated_at)-2440587.5)*86400000>=r.since_ms)`).run(now);
    }
    const watches = getDb().prepare(`SELECT r.*,w.session_id,w.failures,w.rechecks FROM platform_ai_project_notification_watches w
      JOIN platform_ai_project_notifications r ON r.id=w.rule_id WHERE r.enabled=1 AND w.next_check_at<=?
      ORDER BY CASE WHEN w.rechecks>0 THEN 0 ELSE 1 END,w.next_check_at,w.rowid LIMIT 20`).all(now) as Watch[];
    for (const watch of watches) {
      if (this.pending.size >= 2) break;
      const key = `${watch.id}:${watch.session_id}`;
      if (this.pending.has(key)) continue;
      const work = this.observe(watch, config).finally(() => this.pending.delete(key));
      this.pending.set(key, work);
    }
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]); }

  private alreadyTracked(watch: Watch, message?: AgentTextMessage): boolean {
    if (!message?.task_reference) return false;
    const tasks = getDb().prepare(`SELECT c.channel_id,c.external_user_id,c.user_id FROM platform_ai_tasks t
      JOIN platform_ai_conversations c ON c.id=t.conversation_id WHERE t.session_id=? AND t.user_id=? AND t.source_ref=?
      AND t.status NOT IN ('cancelled','superseded','suspended','failed')`).all(watch.session_id, watch.user_id, message.task_reference) as Array<{channel_id: string | null; external_user_id: string; user_id: string}>;
    const recipient = notificationRecipients(watch.user_id).find(item => item.id === watch.recipient_id);
    return !!recipient && tasks.some(task => recipient.group || (task.channel_id === recipient.channel_id && task.external_user_id === recipient.external_user_id));
  }

  private record(watch: Watch, key: string, kind?: 'complete' | 'input' | 'error', body = '', turnKey:string|null=null, personalId:number|null=null, completion?:CompletionNotice): void {
    getDb().transaction(() => {
      // Settings/permissions may have changed while the model/API call was pending.
      const rule = getDb().prepare('SELECT * FROM platform_ai_project_notifications WHERE id=?').get(watch.id) as ProjectNotificationRule | undefined;
      if (!rule || rule.conversation_id !== watch.conversation_id || rule.since_ms !== watch.since_ms || !canNotifyProject(rule, watch.session_id)) return;
      const session = getSession(watch.session_id)!;
      const inserted = getDb().prepare('INSERT OR IGNORE INTO platform_ai_project_notification_receipts (rule_id,session_id,event_key) VALUES (?,?,?)')
        .run(watch.id, watch.session_id, key);
      if (!inserted.changes || !kind || !(kind === 'error' ? true : kind === 'complete' ? rule.on_complete : rule.on_input)) return;
      if(personalId){
        const personal=getDb().prepare('SELECT read_at,dismissed_at,state FROM notifications WHERE id=? AND user_id=? AND session_id=?').get(personalId,watch.user_id,watch.session_id) as {read_at:string|null;dismissed_at:string|null;state:string}|undefined;
        if(personal&&(personal.read_at||personal.dismissed_at||['submitted','resolved'].includes(personal.state)))return;
      }
      const dedupe = `project-notice:${rule.id}:${watch.session_id}:${kind}:${rule.since_ms}:${key}`;
      const recipient = authorizeProjectNotice(dedupe, rule.conversation_id);
      const label = sessionPresenter(watch.user_id)(session);
      const content = formatTaskNotification(`${label.project_name} / ${label.tab_name}`, body);
      getDb().prepare(`INSERT OR IGNORE INTO platform_ai_messages (id,conversation_id,external_id,role,content,status) VALUES (?,?,?,'notice',?,'done')`)
        .run(nanoid(16), rule.conversation_id, dedupe, content);
      getDb().prepare(`INSERT OR IGNORE INTO platform_ai_outbox (id,conversation_id,dedupe_key,content,destination_channel_id,reply_context,available_at)
        VALUES (?,?,?,?,?,?,?)`).run(nanoid(16), rule.conversation_id, dedupe, content, recipient.group ? recipient.channel_id : null,
        JSON.stringify({notification_target:notificationReplyTarget(watch.session_id,turnKey),...(personalId?{personal_notification_id:personalId}:{}),...(completion?{completion}:{})}),
        kind==='complete'?completionAvailableAt(personalId):0);
    })();
    refreshConversation(watch.conversation_id);
  }

  private seen(watch: Watch, key: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM platform_ai_project_notification_receipts WHERE rule_id=? AND session_id=? AND event_key=?').get(watch.id, watch.session_id, key);
  }

  private async observe(watch: Watch, _config: AiConfig): Promise<void> {
    const update = (delay: number, failures = 0, error: string | null = null) => getDb().prepare(`UPDATE platform_ai_project_notification_watches
      SET next_check_at=?,failures=?,error=? WHERE rule_id=? AND session_id=?`).run(Date.now() + delay, failures, error, watch.id, watch.session_id);
    update(30000);
    try {
      if (!canNotifyProject(watch, watch.session_id)) { update(300000); return; }
      if (!notificationRecipients(watch.user_id).some(item => item.id === watch.recipient_id)) { update(300000, 1, '通知渠道已停用或用户绑定已失效'); return; }
      const native = await platformApi(this.app, watch.user_id, 'GET', `/api/sessions/${encodeURIComponent(watch.session_id)}/agent-messages`);
      const messages = (native.messages || []) as AgentTextMessage[];
      const latestUser = [...messages].reverse().find(message => message.role === 'user');
      const display = await platformApi(this.app, watch.user_id, 'GET', `/api/sessions/${encodeURIComponent(watch.session_id)}/display?lines=20`);
      const state = getTracker(watch.session_id)?.state;
      const session=getSession(watch.session_id),nativeId=session&&nativeConversationId(session);
      const structuredInteraction=nativeId&&getDb().prepare(`SELECT 1 FROM notifications WHERE user_id=? AND session_id=? AND native_id=?
        AND kind IN ('question','approval') AND state='pending' AND created_at>=? LIMIT 1`).get(watch.user_id,watch.session_id,nativeId,new Date(Math.max(watch.since_ms,this.structuredSince)).toISOString());
      if (!structuredInteraction && watch.on_input && display.processState === 'waiting_for_input'
        && (state?.isPermission || ['choice','confirmation'].includes(display.promptType))) {
        const key = hash(['prompt', latestUser?.task_reference || latestUser?.timestamp || watch.since_ms, state?.choices || display.choices || [], display.promptType]);
        if (!this.seen(watch, key) && !this.alreadyTracked(watch, latestUser)) {
          const choices: string[] = state?.choices || display.choices || [];
          this.record(watch, key, 'input', `工作 Agent 正在等待${state?.isPermission ? '授权' : '交互'}确认，请打开对应标签页处理。${choices.length ? '\n\n' + choices.join('\n') : ''}`,replyTurnKey(latestUser));
        }
      }
      if(nativeId){
        const rows=getDb().prepare(`SELECT id,kind,body,state,read_at,dismissed_at,created_at,message_id FROM notifications
          WHERE user_id=? AND session_id=? AND native_id=? AND kind IN ('question','approval','error') AND state='pending' AND created_at>=?
          AND NOT EXISTS (SELECT 1 FROM platform_ai_project_notification_receipts r WHERE r.rule_id=? AND r.session_id=notifications.session_id AND r.event_key=('structured:'||notifications.id||':'||COALESCE(notifications.message_id,''))) ORDER BY id LIMIT 100`)
          .all(watch.user_id,watch.session_id,nativeId,new Date(Math.max(watch.since_ms,this.structuredSince)).toISOString(),watch.id) as Array<{id:number;kind:string;body:string;state:string;read_at:string|null;dismissed_at:string|null;created_at:string;message_id:string|null}>;
        for(const row of rows){
          const key='structured:'+row.id+':'+(row.message_id||'');if(this.seen(watch,key))continue;
          const active=row.state==='pending'&&!row.read_at&&!row.dismissed_at;
          if(active&&row.kind==='error'&&await isScheduledProjectError(watch.user_id,watch.session_id,row.message_id)){
            this.record(watch,key);
            continue;
          }
          let turnKey:string|null=null;
          if(active&&row.kind==='question'&&row.message_id&&session&&latestUser){
            // A quote may target a turn only when the native history proves
            // which user message owns this exact question.
            const project=session.project_id?getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined:undefined;
            try {
              const page=await readConversation({...session,cli_type:session.cli_type||'codex',codex_session_id:session.codex_session_id||null,claude_session_id:session.claude_session_id||null,project_path:project?.path||null},{limit:100});
              const index=page.messages.findIndex(item=>item.id===row.message_id);
              const user=index>=0?[...page.messages.slice(0,index)].reverse().find(item=>item.role==='user'):undefined;
              if(user&&user.timestamp===latestUser.timestamp&&user.text===latestUser.text)turnKey=replyTurnKey(latestUser);
            }catch{/* Unknown ownership must not be guessed. */}
          }
          this.record(watch,key,active?(row.kind==='error'?'error':'input'):undefined,row.body,turnKey,row.id);
        }
      }
      // Timestamps and durable receipts prevent stale finals from becoming new notifications.
      const finals = session?.parent_session_id ? [] : messages.filter(message => message.role === 'assistant' && message.phase === 'final'
        && message.timestamp && Date.parse(message.timestamp) >= watch.since_ms && message.text.trim());
      for (const message of finals) {
        const owningUser = [...messages].reverse().find(m => m.role === 'user' && !!m.timestamp && !!message.timestamp && Date.parse(m.timestamp) <= Date.parse(message.timestamp));
        const turn = message.task_reference || owningUser?.task_reference || owningUser?.timestamp;
        const legacyKey = hash(['final', message.task_reference, message.timestamp, message.text]);
        const key = turn ? hash(['final-v2', turn, message.text]) : legacyKey;
        if (this.seen(watch, key)) continue;
        if (key !== legacyKey && this.seen(watch, legacyKey)) { this.record(watch, key); continue; }
        // A truncated history can lose the user turn that identified an already
        // delivered final. Avoid replaying its exact text when identity is unknown.
        if (!turn) {
          const session = getSession(watch.session_id);
          if (session) {
            const label = sessionPresenter(watch.user_id)(session);
            const content = formatTaskNotification(`${label.project_name} / ${label.tab_name}`, message.text);
            const prefix = `project-notice:${watch.id}:${watch.session_id}:`;
            const prior = getDb().prepare(`SELECT 1 FROM platform_ai_outbox WHERE conversation_id=? AND substr(dedupe_key,1,?)=? AND content=? AND status IN ('sent','pending','sending') LIMIT 1`)
              .get(watch.conversation_id, prefix.length, prefix, content);
            if (prior) { this.record(watch, key); continue; }
          }
        }
        if (this.alreadyTracked(watch, message.task_reference ? message : owningUser)) { this.record(watch, key); continue; }
        const completion=completionNotice(watch.session_id,message.text,message.timestamp);
        const {personalId,scheduled}=await resolveCompletionNotice(watch.user_id,completion);
        if(scheduled){this.record(watch,key);continue;}
        if(scheduled===undefined&&hasScheduledConversationInput(watch.session_id))continue;
        this.record(watch, key, 'complete', message.text,message.task_reference?'ref:'+message.task_reference:replyTurnKey(owningUser),personalId,completion);
      }
      if (watch.rechecks > 0) {
        getDb().prepare('UPDATE platform_ai_project_notification_watches SET next_check_at=MIN(next_check_at,?),rechecks=rechecks-1 WHERE rule_id=? AND session_id=? AND rechecks>0')
          .run(Date.now() + 2000, watch.id, watch.session_id);
      }
    } catch (error) {
      update(Math.min(300000, 15000 * (watch.failures + 1)), watch.failures + 1, publicFailure(error));
    }
  }
}
