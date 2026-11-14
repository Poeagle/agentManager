import {ConversationBatchCard} from './ConversationBatchCard';
import {composerKey,loadComposer,saveComposer,emptyComposer,combinedBatch,type ComposerState,type BatchEntry} from '../lib/batch-composer';
import {
  ConversationStreamCursor,
  applyConversationPatches,
  type ConversationPatch,
} from "../lib/conversation-stream";
import { sessionAgent, agentNativeId, agentSupports, type AgentDescriptor } from "../lib/agents";
import { AgentIcon } from "./AgentIcon";
import {
  ConversationStatisticsLabel,
  englishMetadataDuration,
  metadataDurationTitle,
  metadataTimestampTitle,
} from "./ConversationStatisticsLabel";
import {
  ConversationRetryStatus,
  type ConversationRetry,
} from "./ConversationRetryStatus";
import { ConversationPromptEnhancer } from "./ConversationPromptEnhancer";
import { ConversationComposerEditor } from "./ConversationComposerEditor";
import { ConversationImagePreviewRoot } from "./ConversationImagePreview";
import {
  useConversationCompaction,
  type NativeCompaction,
} from "../lib/use-conversation-compaction";
import { ConversationCompactionStatus } from "./ConversationCompactionStatus";
import { ConversationControls } from "./ConversationControls";
import { ConversationAutomaticContext } from "./ConversationAutomaticContext";
import { ConversationCard } from "./ConversationCard";
import { automaticConversationContext } from "../lib/conversation-context";
import {
  ConversationInteraction,
  ConversationAsyncQuestion,
  ConversationQuestionSummary,
  type ConversationInteractionRequest,
} from "./ConversationInteraction";
import type { QuestionAttachmentMap } from "./ConversationQuestionEditor";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Loader2,
  Sparkles,
  Square,
  ChevronDown,
  CalendarClock,
} from "lucide-react";
import {
  api,
  ApiError,
  type ConversationMessage,
  type ConversationPage,
  type ConversationControlsData,
  type ConversationUsageUpdate,
  type ConversationStatistics,
  type Session,
} from "../lib/api";
import {
  decodeQuestionReply,
  createConversationQuestionCache,
  questionReplyDisplayText,
} from "../lib/conversation-question-reply";
import {
  parseConversationInput,
  type ConversationAttachment,
} from "../lib/conversation-attachments";
import {
  ConversationAttachmentPicker,
  ConversationMessageAttachments,
  useConversationAttachments,
  type DraftAttachment,
} from "./ConversationAttachments";
import { ConversationMarkdown } from "./ConversationMarkdown";
import {
  ConversationWidthHandles,
  ConversationNavigator,
} from "./ConversationReadingTools";
import { hasPermission, usePermissions } from "../lib/permissions";
import {
  conversationClientId,
  mergeConversationTimeline,
  type TimelineMessage,
} from "../lib/conversation-timeline";
import { groupConversationProgress } from "../lib/conversation-progress";
import {
  conversationTimings,
  elapsedBetween,
  formatConversationTimestamp,
  formatElapsedEnglish,
} from "../lib/conversation-timing";
import {
  ConversationActivityLine,
  currentConversationActivity,
  conversationActivityDuration,
  type ConversationActivity,
} from "./ConversationActivityLine";
import { ConversationToolCall } from "./ConversationToolCall";
import { useDisplayClock, estimatedServerNow, formatDisplayTimestamp } from "../lib/display-clock";
import "./SessionConversation.css";

interface LiveProgress {
  turn_id: string | null;
  started_at: string | null;
  completed_at?: string | null;
  activities?: ConversationActivity[];
  stage: "waiting" | "tools" | "answering" | "finishing" | "idle";
}
interface FailedDraft {
  clientId: string;
  fingerprint: string;
  text: string;
  attachments: DraftAttachment[];
}

const timeColor=(seconds:number)=>seconds>=60?'var(--error)':seconds>=30?'#e57b18':'var(--text-muted)';

interface ProgressSummaryProps {
  agent: AgentDescriptor; agentName: string; count: number; active: boolean;
  progress?: import('../lib/api').ConversationProgressStatistics | null;
  progressScope?: 'total'|'turn'|'segment'; completed?: boolean; interrupted?: boolean;
  stepDuration?: number|null; stepRunning?: boolean; phaseSeconds?: number|null;
  progressPhase: 'calling'|'waiting'|'unknown'; callingLabel: string|null; turnDuration?: number|null;
}

function ProgressSection({
  agent,
  agentName,
  count,
  active,
  progress,
  progressScope,
  completed,
  interrupted,
  stepDuration,
  stepRunning,
  phaseSeconds,
  progressPhase,
  callingLabel,
  turnDuration,
  children,
}: ProgressSummaryProps & {children: ReactNode}) {
  const [preference, setPreference] = useState<boolean | null>(null);
  const open = preference ?? active;
  return (
    <section className="session-chat-progress" aria-label={`${agentName} 进展`}>
      <details
        className="session-chat-progress-disclosure"
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (next !== open) setPreference(next);
        }}
      >
        <summary
          className="session-chat-agent session-chat-progress-toggle"
          aria-label={`${open ? "收起" : "展开"}进展（${count} 条）`}
          aria-expanded={open}
        >
          <ProgressSummary agent={agent} agentName={agentName} count={count} active={active} progress={progress} progressScope={progressScope} completed={completed} interrupted={interrupted} stepDuration={stepDuration} stepRunning={stepRunning} phaseSeconds={phaseSeconds} progressPhase={progressPhase} callingLabel={callingLabel} turnDuration={turnDuration}/>
          <ChevronDown size={14} className="session-chat-progress-chevron" />
        </summary>
        <div className="session-chat-progress-content">{children}</div>
      </details>
    </section>
  );
}

function ProgressSummary({agent,agentName,count,active,progress,progressScope='total',completed,interrupted,stepDuration,stepRunning,phaseSeconds,progressPhase,callingLabel,turnDuration}:ProgressSummaryProps) {
  return <>
          <span aria-hidden="true"><AgentIcon session={{agent}} className="h-[13px] w-[13px]" /></span>
          <span>{agentName}</span>
          <span className="session-chat-kind">progress</span>
          <span className="session-chat-progress-count">{count} {count === 1 ? "item" : "items"}</span>
          {progress && <span className="session-chat-message-statistics" title={progressScope==='segment'?'Usage recorded since this progress segment started; incomplete data is a lower bound.':progressScope==='total'?'Cumulative recorded usage since the previous conclusion. Incomplete history is a lower bound.':'Recorded usage for this native turn through its last progress update. Incomplete history is a lower bound.'}>{progressScope} · token: {progress.tokens?.total_tokens == null ? '—' : `${progress.complete?'':'≥'}${new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(progress.tokens.total_tokens)}`} · tools: {progress.complete?'':'≥'}{progress.tool_calls} {progress.tool_calls===1?'call':'calls'} ｜ {progress.complete?'':'≥'}{progress.tool_rounds} {progress.tool_rounds===1?'round':'rounds'}</span>}
          {!progress&&progressScope==='segment'&&<span className="session-chat-message-statistics" title="Segment usage is unavailable">segment · token: — · tools: —</span>}
          {active&&stepDuration!=null&&<time className="session-chat-progress-time" title={stepRunning?'Elapsed time for the current tool step':'Duration of the most recently completed tool step'}>Step {formatElapsedEnglish(stepDuration)}</time>}
          {active&&<span className="session-chat-progress-time">{progressPhase}{callingLabel&&<span title={callingLabel}> ({Array.from(callingLabel).length>18?`${Array.from(callingLabel).slice(0,18).join('')}…`:callingLabel})</span>}: <time style={{color:phaseSeconds==null?undefined:timeColor(phaseSeconds)}}>{phaseSeconds==null?'—':`${phaseSeconds}s`}</time></span>}
          {turnDuration!=null?<time className="session-chat-progress-time" style={{color:timeColor(turnDuration/1000)}} title="Elapsed time for this progress segment">Elapsed {formatElapsedEnglish(turnDuration)}</time>:progressScope==='segment'?<span className="session-chat-progress-time" title="Segment timing is unavailable">Elapsed —</span>:null}
          {active ? <span className="session-chat-progress-live">In progress</span> : interrupted ? <span className="session-chat-progress-time">Interrupted</span> : completed ? <span className="session-chat-progress-time">Completed</span> : null}
  </>;
}

const Bubble = memo(function Bubble({
  message,
  streaming,
  allowRaw = true,
  retrying = false,
  autoRetry,
  onCancelRetry,
  onCancelQueued,
  compact = false,
  agent,
  agentName,
  projectPath,
  projectId,
  onOpenFile,
  onNavigate,
  durationLabel,
  onRaw,
}: {
  allowRaw?: boolean;
  durationLabel?: string;
  durationTitle?: string;
  retrying?: boolean;
  autoRetry?: ConversationRetry;
  onCancelRetry?: () => Promise<void>;
  onCancelQueued?: () => Promise<void>;
  onRaw: () => void;
  message: ConversationMessage;
  streaming: boolean;
  compact?: boolean;
  agent: AgentDescriptor;
  agentName: string;
  projectPath?: string;
  projectId: string | null;
  onOpenFile?: (path: string) => void;
  onNavigate: () => void;
}) {
  const timeZone = useDisplayClock();
  const [copied, setCopied] = useState(false),
    [cancelling, setCancelling] = useState(false);
  const visibleText = questionReplyDisplayText(message);
  const parsed =
    message.role === "user"
      ? message.attachments
        ? { text: visibleText, attachments: message.attachments }
        : parseConversationInput(visibleText)
      : { text: message.text, attachments: [] };
  async function copy() {
    const copyText =
      parsed.text +
      (parsed.attachments.length
        ? "\n" + parsed.attachments.map((item) => item.name).join("\n")
        : "");
    try {
      if (navigator.clipboard && window.isSecureContext)
        await navigator.clipboard.writeText(copyText);
      else {
        const area = document.createElement("textarea");
        area.value = copyText;
        area.style.position = "fixed";
        area.style.top = "-9999px";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        if (!ok) return;
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  const metadata =
    compact && (streaming || message.streaming) ? (
      <span className="session-chat-message-meta">
        <span className="session-chat-progress-updating">Streaming</span>
      </span>
    ) : (
      <span className="session-chat-message-meta">
        {message.queued && (
          <>
            <span className="session-chat-queued" role="status">
              Queued · waiting
            </span>
            {onCancelQueued && (
              <button
                type="button"
                disabled={cancelling}
                aria-label="取消排队"
                title="从原生队列撤回，尚未执行的消息将不会发送"
                onClick={() => {
                  setCancelling(true);
                  void onCancelQueued().finally(() => setCancelling(false));
                }}
              >
                {cancelling ? "正在取消…" : "取消排队"}
              </button>
            )}
          </>
        )}
        {message.timestamp && Number.isFinite(Date.parse(message.timestamp)) ? (
          <time
            aria-label={compact ? "进展完成时间" : undefined}
            dateTime={message.timestamp}
            title={metadataTimestampTitle(message, compact)}
          >
            {formatConversationTimestamp(message.timestamp)}
          </time>
        ) : compact ? (
          <span className="session-chat-progress-time-unknown">
            Time pending
          </span>
        ) : null}
        {message.role === "assistant" && message.statistics && (
          <ConversationStatisticsLabel
            statistics={message.statistics}
            interval={message.phase === "commentary"}
          />
        )}
        {(durationLabel || compact || message.phase === "final") && (
          <span
            className="session-chat-message-duration"
            title={
              durationLabel
                ? metadataDurationTitle(message.phase)
                : "Completion timing is unavailable for this interval."
            }
          >
            {durationLabel
              ? englishMetadataDuration(durationLabel)
              : message.phase === "final"
                ? "Total: —"
                : "Elapsed: —"}
          </span>
        )}
        {compact && streaming && (
          <span className="session-chat-progress-updating">Streaming</span>
        )}
        {!compact && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`复制${message.role === "user" ? "你的消息" : "Agent 回复"}`}
            title={copied ? "Copied" : "Copy message"}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </span>
    );
  const automatic =
    message.role === "user" ? automaticConversationContext(message.text) : null;
  const headerMetadata =
    message.role === "assistant" && !compact && message.phase === "final";
  if (message.presentation === "compaction_summary")
    return (
      <ConversationAutomaticContext
        message={message}
        context={{
          kind: "compaction_summary",
          label: "Compaction summary",
          source: "codex",
        }}
        copied={copied}
        onCopy={() => void copy()}
        projectPath={projectPath}
        projectId={projectId}
        onNavigate={onNavigate}
      />
    );
  if (message.role === 'user' && message.input_source)
    return <article className="session-chat-sourced" data-chat-message-id={message.id}>
      <ConversationCard summary={<><CalendarClock size={14}/><span>{message.input_source.kind === 'scheduled' ? '定时任务' : '平台消息'}</span><strong>{message.input_source.label}</strong>{message.queued&&<span>已排队</span>}<span className="conversation-question-expand">查看详情</span></>}>
        <div className="session-chat-sourced-content"><ConversationMessageAttachments text={parsed.text} items={parsed.attachments} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/>{metadata}</div>
      </ConversationCard>
    </article>;
  if (automatic)
    return (
      <ConversationAutomaticContext
        message={message}
        context={automatic}
        copied={copied}
        onCopy={() => void copy()}
        projectPath={projectPath}
        projectId={projectId}
        onNavigate={onNavigate}
      />
    );
  const contentBlocks =
    message.content_blocks?.filter(
      (block) => block.type === "tool_use" || block.text.length > 0,
    ) || [];
  if (
    message.role === "assistant" &&
    !message.text &&
    !contentBlocks.length &&
    !streaming
  )
    return null;
  if (message.phase === "error")
    return (
      <article
        className="session-chat-message session-chat-error-notice"
        role="alert"
        data-phase="error"
        data-streaming="false"
        data-recovered={autoRetry?.status === "succeeded"}
        data-retrying={
          retrying ||
          (!!autoRetry &&
            ["waiting", "submitting", "running"].includes(autoRetry.status))
        }
        data-retry-ended={!!message.error?.will_retry && !retrying}
        data-chat-message-id={message.id}
      >
        <div className="session-chat-error-heading">
          <AlertTriangle size={16} />
          <strong>
            {autoRetry
              ? autoRetry.status === "cancelled"
                ? "模型繁忙 · 重试已取消"
                : autoRetry.status === "succeeded"
                  ? "模型繁忙 · 已恢复"
                  : autoRetry.status === "exhausted"
                    ? "模型繁忙 · 重试已达上限"
                    : autoRetry.status === "unknown"
                      ? "模型繁忙 · 重试待确认"
                      : "模型繁忙 · 自动恢复"
              : message.error?.will_retry
                ? retrying
                  ? "执行遇到错误，正在自动重试"
                  : "重试已结束"
                : "本轮执行出错"}
          </strong>
          {message.timestamp && (
            <time
              dateTime={message.timestamp}
              title={`原生消息记录时间：${formatConversationTimestamp(message.timestamp)}（浏览器时间 · ${timeZone}）；不代表阶段开始时间`}
            >
              {formatConversationTimestamp(message.timestamp)}
            </time>
          )}
        </div>
        <details className="session-chat-error-original"><summary title={message.text}>{message.text}</summary><p>{message.text}</p></details>
        {autoRetry ? (
          <ConversationRetryStatus retry={autoRetry} onCancel={onCancelRetry} />
        ) : !message.error?.will_retry ? (
          <p>
            {message.error?.code === "server_overloaded" ||
                  /at capacity/i.test(message.text)
                ? "当前模型繁忙，本轮已停止。可稍后重试，或在原始终端切换模型。"
                : "本轮已停止。请根据错误信息处理后再试。"}
          </p>
        ) : null}
        <div className="session-chat-error-actions">
          {allowRaw && (
            <button type="button" onClick={onRaw}>
              查看原始终端
            </button>
          )}
          <button type="button" onClick={() => void copy()}>
            {copied ? "已复制" : "复制错误信息"}
          </button>
        </div>
      </article>
    );
  return (
    <article
      className={`session-chat-message ${message.role}`}
      data-phase={message.phase}
      data-streaming={streaming}
      data-chat-message-id={message.id}
    >
      {message.role === "assistant" && !compact && (
        <div
          className={`session-chat-agent${headerMetadata ? " session-chat-final-heading" : ""}`}
        >
          <span aria-hidden="true"><AgentIcon session={{agent}} className="h-[13px] w-[13px]" /></span>
          <span>{agentName}</span>
          {message.phase === "final" && (
            <span className="session-chat-kind">final</span>
          )}
          {streaming && <span className="session-chat-writing">正在输出</span>}
          {headerMetadata && (
            <div className="session-chat-metadata-row session-chat-final-meta">
              {metadata}
            </div>
          )}
        </div>
      )}
      <div className="session-chat-body">
        {message.role === "user" ? (
          <>
            <div className="session-chat-user-text">
              {message.batch?.length?<ConversationBatchCard sentAt={message.timestamp} parts={message.batch} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/>:<ConversationMessageAttachments
                text={
                  parsed.attachments.length &&
                  !parsed.attachments.some((item) => item.offset !== undefined)
                    ? parsed.text.trimEnd()
                    : parsed.text
                }
                items={parsed.attachments}
                projectId={projectId}
                projectPath={projectPath}
                onOpenFile={onOpenFile}
              />}
            </div>
            {metadata}
          </>
        ) : (
          <>
            {!headerMetadata && (
              <div className="session-chat-metadata-row">{metadata}</div>
            )}
            {contentBlocks.length ? (
              contentBlocks.map((block, index) =>
                block.type === "tool_use" ? (
                  <ConversationToolCall
                    key={`${message.id}:tool:${block.id}`}
                    block={block}
                  />
                ) : (
                  <ConversationMarkdown
                    key={`${message.id}:text:${block.index}:${index}`}
                    content={block.text}
                    messageId={`${message.id}-block-${block.index}`}
                    streaming={streaming}
                    projectPath={projectPath}
                    projectId={projectId}
                    onOpenFile={onOpenFile}
                    onNavigate={onNavigate}
                  />
                ),
              )
            ) : (
              <ConversationMarkdown
                content={message.text}
                messageId={message.id}
                streaming={streaming}
                projectPath={projectPath}
                projectId={projectId}
                onOpenFile={onOpenFile}
                onNavigate={onNavigate}
              />
            )}
          </>
        )}
        {streaming && (
          <span className="session-chat-caret" aria-label="正在输出" />
        )}
      </div>
    </article>
  );
});

export function SessionConversation({
  session,
  active,
  onRaw,
  onResume,
  onNewConversation,
  onClose,
  resuming = false,
  resumeFailed = false,
  userId = "local",
  projectPath,
  onOpenFile,
}: {
  session: Session;
  active: boolean;
  onRaw: () => void;
  onResume?: () => void;
  onNewConversation?: (
    preference?: import("../lib/api").AgentModelPreference,
  ) => Promise<void>;
  onClose?: () => void;
  resuming?: boolean;
  resumeFailed?: boolean;
  userId?: string;
  projectPath?: string;
  onOpenFile?: (path: string) => void;
}) {
  const compaction = useConversationCompaction(
    session.id,
    agentNativeId(session),
  );
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const canRead = hasPermission(permissions.data, "agent_api");
  const canSend = hasPermission(permissions.data, "agent_api", "write");
  const canAttach = agentSupports(session, "attachments");
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [autoRetries, setAutoRetries] = useState<
    Record<string, ConversationRetry>
  >({});
  useEffect(() => setAutoRetries({}), [session.id, agentNativeId(session)]);
  const [statistics, setStatistics] = useState<ConversationStatistics[]>([]);
  const [progressStatistics,setProgressStatistics]=useState<import('../lib/api').ConversationProgressStatistics|null>(null);
  const [page, setPage] = useState<ConversationPage | null>(null);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string;
          runtime: NonNullable<Session["agent_runtime"]>;
        }>
      ).detail;
      if (
        detail.sessionId !== session.id ||
        detail.runtime.session_id !== agentNativeId(session)
      )
        return;
      setPage((previous) =>
        previous &&
        (!previous.runtime?.observed_at ||
          Date.parse(previous.runtime.observed_at) <=
            Date.parse(detail.runtime.observed_at))
          ? { ...previous, runtime: detail.runtime }
          : previous,
      );
    };
    window.addEventListener("agentmanager:session-runtime", update);
    return () =>
      window.removeEventListener("agentmanager:session-runtime", update);
  }, [session.id, agentNativeId(session)]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [stoppingTurn,setStoppingTurn]=useState<string|null>(null);
  const [stopError,setStopError]=useState('');
  const stoppingRef=useRef<{sessionId:string;turnId:string}|null>(null);
  useEffect(()=>setStopError(''),[session.id]);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState("");
  const reconnectAttempted = useRef(false),
    reconnectLock = useRef(false);
  const storageKey = composerKey(userId,session.id);
  const [storageError,setStorageError]=useState('');
  const [composer,setComposer]=useState<ComposerState>(()=>{try{return loadComposer(storageKey);}catch{setStorageError('保存的草稿无法读取，请保留浏览器数据。');return emptyComposer();}});
  const composerRef=useRef({key:storageKey,value:composer});
  const [draft, setDraft] = useState(composer.draft);
  function persistComposer(change:Partial<ComposerState>) {
    const next={...composerRef.current.value,...change};
    try{loadComposer(composerRef.current.key);}catch{setStorageError('保存的草稿无法读取，请保留浏览器数据。');return false;}
    try{saveComposer(composerRef.current.key,next);setStorageError('');}
    catch{setStorageError('草稿保存失败，请保留此页面并复制内容备份。');return false;}
    composerRef.current.value=next;setComposer(next);return true;
  }
  useEffect(()=>{
    if(composerRef.current.key===storageKey)return;
    try{const value=loadComposer(storageKey);composerRef.current={key:storageKey,value};setComposer(value);setDraft(value.draft);draftRef.current=value.draft;}
    catch{const value=emptyComposer();composerRef.current={key:storageKey,value};setComposer(value);setDraft('');draftRef.current='';setStorageError('保存的草稿无法读取，请保留浏览器数据。');}
  },[storageKey]);
  const [failedDrafts, setFailedDrafts] = useState<FailedDraft[]>([]);
  const draftVersion = useRef(0);
  const [minimizedQuestion, setMinimizedQuestion] = useState<string | null>(
    null,
  );
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const openQuestion = useCallback((id: string) => {
    setSelectedQuestion(id);
    setMinimizedQuestion(null);
  }, []);
  const [ignoringQuestions, setIgnoringQuestions] = useState(false);
  const [ignoreError, setIgnoreError] = useState("");
  const attachments = useConversationAttachments(session.id,(composer.draftAttachments||[]).map(a=>({...a,id:conversationClientId(),size:0,status:'ready' as const})));
  const attachmentStorageKey=useRef(storageKey);
  useEffect(()=>{
    if(attachmentStorageKey.current!==storageKey){attachmentStorageKey.current=storageKey;attachments.clear(attachments.items.map(i=>i.id));attachments.restore((composerRef.current.value.draftAttachments||[]).map(a=>({...a,id:conversationClientId(),size:0,status:'ready' as const})));return;}
    const ready=attachments.values().map((a,index)=>({...a,offset:attachments.items.filter(i=>i.status==='ready'&&i.path)[index]?.offset}));
    if(JSON.stringify(ready)!==JSON.stringify(composerRef.current.value.draftAttachments||[]))persistComposer({draftAttachments:ready});
  },[attachments.items,storageKey]);
  const attachmentPositions = useRef<(() => Map<string, number>) | null>(null);
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [liveRetrying, setLiveRetrying] = useState(false),
    [liveReason, setLiveReason] = useState("");
  const [liveState, setLiveState] = useState<
    "connecting" | "connected" | "unavailable"
  >("connecting");
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [requests, setRequests] = useState<ConversationInteractionRequest[]>(
    [],
  );
  const liveSocket = useRef<WebSocket | null>(null);
  const pushAvailable = useRef(false);
  const pendingAnswers = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveProgress, setLiveProgress] = useState<LiveProgress>({
    turn_id: null,
    started_at: null,
    stage: "idle",
  });
  // The durable native completion is also an event source. If an RPC snapshot
  // was missed, do not keep a connected socket's old busy flag indefinitely.
  useEffect(() => {
    const runtime = page?.runtime;
    if (
      liveBusy &&
      runtime &&
      runtime.session_id === agentNativeId(session) &&
      runtime.completed_turn_id === liveProgress.turn_id &&
      ["idle", "interrupted", "failed"].includes(runtime.state) &&
      Date.parse(runtime.last_activity_at || "") >
        Date.parse(liveProgress.started_at || "")
    )
      setLiveBusy(false);
  }, [
    page?.runtime?.state,
    page?.runtime?.last_activity_at,
    page?.runtime?.session_id,
    page?.runtime?.completed_turn_id,
    agentNativeId(session),
    liveBusy,
    liveProgress.started_at,
    liveProgress.turn_id,
  ]);
  const [now, setNow] = useState(estimatedServerNow);
  const cursor = useRef<string | undefined>(undefined);
  const generation = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const readingRoot = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const sendingRef = useRef(false);
  const submissionIdentity = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  useEffect(() => {
    const pending = submissionIdentity.current;
    if (
      pending &&
      messages.some(
        (message) =>
          message.role === "user" &&
          message.client_id === pending.id &&
          !message.optimistic,
      )
    )
      setSendError("");
  }, [messages]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const changeDraft = useCallback((text: string) => {
    draftVersion.current++;
    draftRef.current = text;
    setDraft(text);
    persistComposer({draft:text});
  }, []);
  useEffect(()=>{
    const pending=composerRef.current.value.pending;
    if(pending&&messages.some(m=>m.role==='user'&&m.client_id===pending.id&&!m.optimistic)){
      persistComposer({pending:null,entries:composerRef.current.value.entries.filter(e=>!pending.entryIds.includes(e.id))});
    }
  },[messages]);
  function stageBatch(){
    if(!canSend||attachments.uploading||attachments.failed||sendingRef.current)return;
    const text=draftRef.current,values=attachments.values().map((a,index)=>({...a,offset:attachmentPositions.current?.().get(attachments.items.filter(i=>i.status==='ready'&&i.path)[index]?.id)??text.length}));
    if(!text.trim()&&!values.length)return;
    const entries=[...composerRef.current.value.entries,{id:conversationClientId(),createdAt:new Date(estimatedServerNow()).toISOString(),text,attachments:values}];
    const combined=combinedBatch(entries);
    if(entries.length>100||new TextEncoder().encode(combined.text).byteLength>64*1024||combined.attachments.length>8){setSendError('批量内容最多 100 条、64 KB、8 个附件，请先发送已有内容。');return;}
    if(!persistComposer({entries,draft:'',draftAttachments:[]}))return;
    draftVersion.current++;draftRef.current='';setDraft('');
    attachments.release(attachments.take(attachments.items.map(i=>i.id)));
  }
  function recallBatch(entry:BatchEntry){
    if(composerRef.current.value.pending?.entryIds.includes(entry.id)||sendingRef.current||attachments.uploading||attachments.failed)return;
    if(attachments.items.length+entry.attachments.length>8){setSendError('输入框最多支持 8 个附件，请先处理现有输入。');return;}
    const current=draftRef.current,prefix=current?current+'\n\n':'',text=prefix+entry.text;
    const restored=entry.attachments.map(a=>({...a,offset:prefix.length+(a.offset??entry.text.length)}));
    if(!persistComposer({draft:text,draftAttachments:[...attachments.values(),...restored],entries:composerRef.current.value.entries.filter(e=>e.id!==entry.id)}))return;
    draftVersion.current++;draftRef.current=text;setDraft(text);
    attachments.restore(restored.map(a=>({...a,id:conversationClientId(),size:0,status:'ready' as const})));
  }
  function deleteBatch(entry:BatchEntry){
    if(!canSend||sendingRef.current||composerRef.current.value.pending?.entryIds.includes(entry.id))return;
    persistComposer({entries:composerRef.current.value.entries.filter(e=>e.id!==entry.id)});
  }
  async function sendBatch(){
    const value=composerRef.current.value;
    if(value.pending||!value.entries.length)return;
    const combined=combinedBatch(value.entries);
    try{await send(combined.text,combined.attachments,true);}catch{/* Durable batch remains available for reconciliation. */}
  }
  const bottom = useRef<HTMLDivElement>(null);
  const focusedQuestion = useRef<string | null>(null);
  const timelineRef = useRef(messages);
  timelineRef.current = messages;
  const conversationIdentity = useRef<{
    sessionId: string;
    nativeId: string | null;
  }>({ sessionId: "", nativeId: null });
  const scrollBottom = () => {
    pinned.current = true;
    setUnread(false);
    bottom.current?.scrollIntoView({ block: "nearest" });
    const timeline = timelineRef.current,
      lastHuman = timeline.reduce(
        (last, item, index) =>
          item.role === "user" &&
          !item.queued &&
          !automaticConversationContext(item.text)
            ? index
            : last,
        -1,
      );
    const question = timeline
      .slice(lastHuman + 1)
      .reduce<ConversationMessage | null>(
        (last, item) => (item.async_questions?.length ? item : last),
        null,
      );
    if (question && focusedQuestion.current !== question.id) {
      const node = [
        ...(list.current?.querySelectorAll<HTMLElement>(
          "[data-chat-message-id]",
        ) || []),
      ].find((item) => item.dataset.chatMessageId === question.id);
      if (node) {
        focusedQuestion.current = question.id;
        node.scrollIntoView({ block: "nearest" });
      }
    }
  };
  const navigate = useCallback(() => {
    pinned.current = false;
    setUnread(false);
  }, []);
  useEffect(() => {
    const nativeId = agentNativeId(session);
    const previous = conversationIdentity.current;
    const identityChanged =
      previous.sessionId !== session.id ||
      (!!previous.nativeId && !!nativeId && previous.nativeId !== nativeId);
    conversationIdentity.current = { sessionId: session.id, nativeId };
    if (!identityChanged) return;
    cursor.current = undefined;
    generation.current = null;
    pushAvailable.current = false;
    reconnectAttempted.current = false;
    setReconnectError("");
    setMessages([]);
    setStatistics([]);
    setPage(null);
    setRequests([]);
    setHasMore(false);
    setLoading(true);
    setLiveBusy(false);
    setLiveState("connecting");
    setLiveRetrying(false);
    setLiveReason("");
    setLiveProgress({ turn_id: null, started_at: null, stage: "idle" });
    setProgressStatistics(null);
    setMinimizedQuestion(null);
    setUnread(false);
    setError("");
    for (const answer of pendingAnswers.current.values()) {
      clearTimeout(answer.timer);
      answer.reject(Error("会话已切换"));
    }
    pendingAnswers.current.clear();
  }, [session.id, agentNativeId(session), session.claude_session_id]);
  const ended = ["completed", "failed", "cancelled"].includes(session.status);
  const observingStream =
    active &&
    canRead &&
    !ended &&
    agentSupports(session, "stream") &&
    !!page?.native_id &&
    page.native_id === agentNativeId(session);
  const reconnectable =
    !!page &&
    !page.session_active &&
    !ended &&
    ["running", "detached"].includes(page.session_status);
  async function reconnect() {
    if (reconnectLock.current) return;
    reconnectLock.current = true;
    setReconnecting(true);
    setReconnectError("");
    try {
      await api.sessions.reconnect(session.id);
      setRefresh((value) => value + 1);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({
        queryKey: ["project-sessions", session.project_id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-controls", session.id],
      });
    } catch (failure) {
      setReconnectError(
        failure instanceof Error ? failure.message : "连接恢复失败，请重试",
      );
    } finally {
      reconnectLock.current = false;
      setReconnecting(false);
    }
  }
  useEffect(() => {
    if (page?.session_active) {
      reconnectAttempted.current = false;
      setReconnectError("");
      return;
    }
    // One automatic attempt per disconnection, with a visible manual retry.
    // Observing a running thread is separate from having a writable terminal.
    if (!active || !canSend || !reconnectable || reconnectAttempted.current)
      return;
    reconnectAttempted.current = true;
    void reconnect();
  }, [active, canSend, reconnectable, page?.session_active]);
  const lastUserIndex = messages.reduce(
    (last, message, index) =>
      message.role === "user" &&
      !message.queued &&
      !automaticConversationContext(message.text)
        ? index
        : last,
    -1,
  );
  const latestAssistant = messages.reduce<ConversationMessage | null>(
    (last, message, index) =>
      index > lastUserIndex && message.role === "assistant" ? message : last,
    null,
  );
  const activeError =
    latestAssistant?.phase === "error" &&
    (liveState !== "connected" ||
      !liveProgress.turn_id ||
      !latestAssistant.turn_id ||
      latestAssistant.turn_id === liveProgress.turn_id)
      ? latestAssistant
      : null;
  const busy =
    !(activeError && !activeError.error?.will_retry) &&
    (liveState === "connected"
      ? liveBusy
      : page?.runtime?.state === "running" ||
        (!page?.runtime && page?.interaction?.processState === "busy"));
  useEffect(() => {
    if (!active || (!busy && !compaction.running)) return;
    setNow(estimatedServerNow());
    const clock = setInterval(() => setNow(estimatedServerNow()), 1000);
    return () => clearInterval(clock);
  }, [active, busy, compaction.running]);
  useEffect(() => {
    if (ended)
      setMessages((previous) =>
        previous.map((message) =>
          message.streaming ? { ...message, streaming: false } : message,
        ),
      );
  }, [ended]);

  useEffect(() => {
    if (!active || !canRead) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let pageActive = false;
      try {
        let result = await api.agent.conversation(
          session.id,
          cursor.current ? { after: cursor.current } : {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        // A replaced history file changes generation while its old cursor can
        // still be valid. Never replace the timeline with that incremental
        // tail: obtain a complete baseline before resetting visible history.
        if (cursor.current && (result.reset ||
          generation.current !== null && result.generation !== generation.current)) {
          result = await api.agent.conversation(session.id, {}, controller.signal);
          if (controller.signal.aborted) return;
          result = { ...result, reset: true };
        }
        pageActive = result.session_active;
        const reset =
          result.reset ||
          (generation.current !== null &&
            result.generation !== generation.current);
        const first = !cursor.current || reset;
        generation.current = result.generation;
        setPage((previous) =>
          previous?.native_id === result.native_id &&
          Date.parse(previous.runtime?.observed_at || "") >
            Date.parse(result.runtime?.observed_at || "")
            ? { ...result, runtime: previous.runtime }
            : result,
        );
        if (result.statistics)
          setStatistics((previous) =>
            reset
              ? result.statistics!
              : [
                  ...new Map(
                    [...previous, ...result.statistics!].map((item) => [
                      item.sequence,
                      item,
                    ]),
                  ).values(),
                ].slice(-80),
          );
        setError("");
        setLoading(false);
        if (first) {
          setMessages((previous) => {
            if (reset)
              return mergeConversationTimeline(
                previous.filter((item) => item.optimistic),
                result.messages,
                "prepend",
              );
            return mergeConversationTimeline(
              previous,
              result.messages,
              "prepend",
            );
          });
          setHasMore(result.has_more);
          cursor.current = result.messages.at(-1)?.id;
        } else if (result.messages.length) {
          setMessages((previous) =>
            mergeConversationTimeline(previous, result.messages),
          );
          cursor.current = result.messages.at(-1)?.id;
        }
        if (result.messages.length) {
          if (pinned.current)
            requestAnimationFrame(() => {
              if (!controller.signal.aborted) scrollBottom();
            });
          else if (!first) setUnread(true);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "对话读取失败");
          setLoading(false);
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(
            () => void poll(),
            pushAvailable.current && pageActive
              ? 30000
              : document.hidden
                ? 10000
                : 2000,
          );
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    active,
    canRead,
    session.id,
    session.status,
    agentNativeId(session),
    session.claude_session_id,
    refresh,
  ]);

  useEffect(() => {
    if (
      !active ||
      !canRead ||
      !agentSupports(session, "stream") ||
      !page?.native_id ||
      page.native_id !== agentNativeId(session) ||
      ended
    )
      return;
    let disposed = false;
    const settledIds = new Set<string>();
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let raf: number | undefined;
    let pending: ConversationPatch[] = [];
    let pendingBytes = 0,
      lastMessageAt = performance.now();
    let delivery = new ConversationStreamCursor(),
      resyncScheduled = false,
      failures = 0;
    const flushPatches = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      if (!pending.length || disposed) return;
      const batch = pending;
      pending = [];
      pendingBytes = 0;
      setMessages((previous) => {
        const result = applyConversationPatches(previous, batch);
        timelineRef.current = result.messages;
        if (result.needsSync && !resyncScheduled) {
          resyncScheduled = true;
          queueMicrotask(() => {
            if (!disposed) {
              setRefresh((value) => value + 1);
              ensureFresh(true);
            }
          });
        }
        return result.messages;
      });
      if (pinned.current)
        requestAnimationFrame(() => {
          if (!disposed) scrollBottom();
        });
      else setUnread(true);
    };
    const observeState = (
      frame: Partial<LiveProgress> & {
        busy?: boolean;
        interactions?: ConversationInteractionRequest[];
        compaction?: NativeCompaction | null;
        messages?: ConversationMessage[];
      },
    ) => {
      setLiveState("connected");
      setLiveRetrying(false);
      setLiveBusy(!!frame.busy);
      if ("compaction" in frame) {
        const completion = frame.compaction?.completed_at
          ? Date.parse(frame.compaction.completed_at)
          : Infinity;
        const resumed =
          !!frame.busy &&
          (frame.activities?.some(
            (item) =>
              item.id !== frame.compaction?.id &&
              item.started_at &&
              Date.parse(item.started_at) >= completion,
          ) ||
            frame.messages?.some(
              (item) =>
                item.role === "assistant" &&
                item.streaming &&
                item.timestamp &&
                Date.parse(item.timestamp) >= completion,
            ));
        compaction.observe(frame.compaction ?? null, !!frame.busy, !!resumed);
      }
      setRequests(Array.isArray(frame.interactions) ? frame.interactions : []);
      if (frame.stage)
        setLiveProgress({
          turn_id: frame.turn_id || null,
          started_at: frame.started_at || null,
          completed_at: frame.completed_at || null,
          activities: Array.isArray(frame.activities) ? frame.activities : [],
          stage: frame.stage,
        });
    };
    const connect = () => {
      if (disposed) return;
      setLiveState("connecting");
      lastMessageAt = performance.now();
      delivery = new ConversationStreamCursor();
      resyncScheduled = false;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${encodeURIComponent(session.id)}/conversation/stream?protocol=2`,
      );
      const current = socket;
      liveSocket.current = current;
      current.onopen = () => {
        if (!disposed && liveSocket.current === current) {
          lastMessageAt = performance.now();
          setRefresh((value) => value + 1);
        }
      };
      setConnectionGeneration((value) => value + 1);
      socket.onmessage = (event) => {
        if (disposed || liveSocket.current !== current) return;
        lastMessageAt = performance.now();
        let frame: {
          type: string;
          stream_id?: string;
          stream_seq?: number;
          baseline?: boolean;
          retrying?: boolean;
          reason?: string;
          upserts?: ConversationMessage[];
          deltas?: ConversationPatch["deltas"];
          state?: Parameters<typeof observeState>[0];
          model?: string;
          effort?: string | null;
          service_tier?: string | null;
          native_id?: string;
          usage?: ConversationUsageUpdate["usage"];
          statistics?: ConversationStatistics[];
          progress?: import('../lib/api').ConversationProgressStatistics|null;
          retry?: ConversationRetry;
          observed_at?: string;
          messages?: ConversationMessage[];
          reset?: boolean;
          runtime?: ConversationPage["runtime"];
          busy?: boolean;
          interactions?: ConversationInteractionRequest[];
          request_id?: string;
          ok?: boolean;
          error?: string;
          compaction?: NativeCompaction | null;
        } & Partial<LiveProgress>;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === "heartbeat") return;
        const order = delivery.observe(frame);
        if (order === "ignore") return;
        if (order === "resync") {
          setRefresh((value) => value + 1);
          ensureFresh(true);
          return;
        }
        if (frame.type === "snapshot" || frame.type === "patch") failures = 0;
        if(frame.type==='progress_statistics'&&frame.native_id===agentNativeId(session)){if(frame.progress)setProgressStatistics(frame.progress);return;}
        if(frame.type==='input_reconciliation'&&frame.native_id===agentNativeId(session)&&Array.isArray(frame.messages)){setMessages(previous=>mergeConversationTimeline(previous,frame.messages!));return;}
        if (
          frame.type === "patch" &&
          Array.isArray(frame.upserts) &&
          Array.isArray(frame.deltas)
        ) {
          pending.push({
            type: "patch",
            upserts: frame.upserts,
            deltas: frame.deltas,
          });
          pendingBytes += frame.deltas.reduce(
            (sum, delta) => sum + delta.text.length,
            0,
          );
          if (frame.state || frame.upserts.length || pendingBytes >= 64 * 1024)
            flushPatches();
          else if (raf === undefined) raf = requestAnimationFrame(flushPatches);
          if (frame.state)
            observeState({ ...frame.state, messages: frame.upserts });
          pushAvailable.current = true;
          setLiveState("connected");
          setLiveRetrying(false);
          const settled = frame.upserts.filter(
            (item) =>
              item.role === "assistant" &&
              !item.streaming &&
              !settledIds.has(item.id),
          );
          for (const item of settled) settledIds.add(item.id);
          if (settled.length) setRefresh((value) => value + 1);
          return;
        }
        flushPatches();
        if (
          frame.type === "retry" &&
          frame.retry &&
          frame.retry.native_id === agentNativeId(session)
        ) {
          const retry = frame.retry;
          setAutoRetries((previous) => ({
            ...previous,
            [retry.root_turn_id]: retry,
          }));
          return;
        }
        if (frame.type === "usage") {
          if (
            typeof frame.native_id === "string" &&
            frame.native_id === agentNativeId(session) &&
            frame.usage &&
            frame.observed_at &&
            Number.isFinite(Date.parse(frame.observed_at))
          ) {
            const update: ConversationUsageUpdate = {
              native_id: frame.native_id,
              usage: frame.usage,
              observed_at: frame.observed_at,
            };
            const previous = queryClient.getQueryData<ConversationUsageUpdate>([
              "conversation-usage",
              session.id,
            ]);
            if (
              previous?.native_id === update.native_id &&
              Date.parse(previous.observed_at) > Date.parse(update.observed_at)
            )
              return;
            compaction.usage(update.usage, update.observed_at);
            queryClient.setQueryData<ConversationUsageUpdate>(
              ["conversation-usage", session.id],
              (previous) =>
                previous?.native_id === update.native_id &&
                Date.parse(previous.observed_at) >
                  Date.parse(update.observed_at)
                  ? previous
                  : update,
            );
          }
          return;
        }
        if (
          frame.type === "statistics" &&
          frame.native_id === agentNativeId(session) &&
          Array.isArray(frame.statistics)
        ) {
          setStatistics((previous) => {
            const merged = new Map(
              previous.map((item) => [item.sequence, item]),
            );
            for (const item of frame.statistics!)
              merged.set(item.sequence, item);
            return [...merged.values()].slice(-80);
          });
          return;
        }
        if (frame.type === "settings" && typeof frame.model === "string") {
          queryClient.setQueryData<ConversationControlsData>(
            ["conversation-controls", session.id],
            (previous) =>
              previous
                ? {
                    ...previous,
                    model: frame.model!,
                    effort: frame.effort ?? null,
                    ...(frame.service_tier !== undefined
                      ? { service_tier: frame.service_tier }
                      : {}),
                    pending: null,
                  }
                : previous,
          );
          return;
        }
        if (frame.type === "interaction_result" && frame.request_id) {
          const pending = pendingAnswers.current.get(frame.request_id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingAnswers.current.delete(frame.request_id);
            if (frame.ok) pending.resolve();
            else pending.reject(new Error(frame.error || "提交失败"));
          }
          return;
        }
        if (frame.type === "queue" && Array.isArray(frame.messages)) {
          const clients = new Set(frame.messages.map((item) => item.client_id));
          setMessages((previous) =>
            mergeConversationTimeline(
              previous.filter(
                (item) => !item.queued || clients.has(item.client_id),
              ),
              frame.messages!,
            ),
          );
          return;
        }
        if (frame.type === "history" && Array.isArray(frame.messages)) {
          if (frame.reset) {
            setRefresh((value) => value + 1);
            return;
          }
          if (
            frame.messages.some(
              (message) => message.role === "assistant" && !message.streaming,
            ) &&
            queryClient.getQueryData<ConversationControlsData>([
              "conversation-controls",
              session.id,
            ])?.pending_status === "submitted"
          )
            void queryClient.invalidateQueries({
              queryKey: ["conversation-controls", session.id],
            });
          if (frame.runtime && "compaction" in frame.runtime)
            compaction.observe(
              frame.runtime.compaction ?? null,
              frame.runtime.state === "running",
            );
          pushAvailable.current = true;
          setMessages((previous) =>
            mergeConversationTimeline(previous, frame.messages!),
          );
          setPage((previous) =>
            previous
              ? {
                  ...previous,
                  runtime:
                    frame.runtime &&
                    !(
                      Date.parse(previous.runtime?.observed_at || "") >
                      Date.parse(frame.runtime.observed_at)
                    )
                      ? frame.runtime
                      : previous.runtime,
                }
              : previous,
          );
          if (frame.messages.length) {
            if (pinned.current)
              requestAnimationFrame(() => {
                if (!disposed) scrollBottom();
              });
            else setUnread(true);
          }
          return;
        }
        if (frame.type === "unavailable") {
          setMessages(previous => previous.map(message => message.streaming ? {...message, streaming: false} : message));
          pushAvailable.current = false;
          setLiveRetrying(!!frame.retrying);
          setLiveReason(frame.reason || "实时连接暂不可用");
          setLiveState("unavailable");
          setLiveBusy(false);
          compaction.disconnected();
          return;
        }
        if (frame.type !== "snapshot" || !Array.isArray(frame.messages)) return;
        pushAvailable.current = true;
        observeState(frame);
        const incoming = frame.messages;
        setMessages((previous) =>
          mergeConversationTimeline(previous, incoming),
        );
        if (incoming.length) {
          if (pinned.current)
            requestAnimationFrame(() => {
              if (!disposed) scrollBottom();
            });
          else setUnread(true);
          const settled = incoming.filter(
            (item) =>
              item.role === "assistant" &&
              !item.streaming &&
              !settledIds.has(item.id),
          );
          for (const item of settled) settledIds.add(item.id);
          if (settled.length) setRefresh((value) => value + 1);
        }
      };
      socket.onclose = () => {
        if (!disposed && liveSocket.current === current) {
          flushPatches();
          setMessages(previous => previous.map(message => message.streaming ? {...message, streaming: false} : message));
          pushAvailable.current = false;
          liveSocket.current = null;
          for (const pending of pendingAnswers.current.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("连接已断开，请重连核对请求状态"));
          }
          pendingAnswers.current.clear();
          setLiveState("unavailable");
          setLiveRetrying(true);
          setLiveReason("连接中断，正在自动重连并补齐消息");
          setLiveBusy(false);
          compaction.disconnected();
          retry = setTimeout(
            connect,
            Math.min(15000, 500 * 2 ** Math.min(failures++, 5)) +
              Math.floor(Math.random() * 250),
          );
        }
      };
      socket.onerror = () => current.close();
    };
    const ensureFresh = (force = false) => {
      if (disposed) return;
      const current = liveSocket.current;
      if (force || performance.now() - lastMessageAt > 60000) {
        flushPatches();
        liveSocket.current = null;
        current?.close();
        for (const answer of pendingAnswers.current.values()) {
          clearTimeout(answer.timer);
          answer.reject(new Error("连接正在恢复，请重连核对请求状态"));
        }
        pendingAnswers.current.clear();
        clearTimeout(retry);
        failures = 0;
        connect();
      }
    };
    const online = () => ensureFresh(true),
      visible = () => {
        if (document.visibilityState === "visible") ensureFresh();
      };
    const watchdog = setInterval(() => ensureFresh(), 10000);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    connect();
    return () => {
      disposed = true;
      if (raf !== undefined) cancelAnimationFrame(raf);
      pending = [];
      clearInterval(watchdog);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
      clearTimeout(retry);
      socket?.close();
      pushAvailable.current = false;
      liveSocket.current = null;
      for (const pending of pendingAnswers.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("连接已关闭，请重新连接后确认请求状态"));
      }
      pendingAnswers.current.clear();
    };
  }, [active, canRead, session.id, session.cli_type, page?.native_id, ended]);

  async function loadOlder() {
    if (older) return;
    setOlder(true);
    const previousHeight = list.current?.scrollHeight || 0;
    const previousTop = list.current?.scrollTop || 0;
    try {
      const result = await api.agent.conversation(session.id, {
        before: messages[0]?.id || "0".repeat(32),
      });
      setMessages((previous) =>
        mergeConversationTimeline(previous, result.messages, "prepend"),
      );
      setHasMore(result.has_more);
      setError("");
      if (!cursor.current) cursor.current = result.messages.at(-1)?.id;
      requestAnimationFrame(() => {
        if (list.current)
          list.current.scrollTop =
            previousTop + list.current.scrollHeight - previousHeight;
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "历史加载失败");
    } finally {
      setOlder(false);
    }
  }

  const interaction = page?.interaction;
  const nativeStateKnown =
    agentSupports(session, "runtime") &&
    !!page?.runtime &&
    page.runtime.state !== "unknown";
  const needsAction =
    (!nativeStateKnown || page?.runtime?.state === "waiting_for_input") &&
    !!interaction &&
    interaction.processState === "waiting_for_input" &&
    (interaction.isPermission ||
      interaction.promptType === "choice" ||
      interaction.promptType === "confirmation");
  const waiting = requests.length
    ? requests.some((request) => request.blocking)
    : needsAction || page?.runtime?.state === "waiting_for_input";
  function answerRequest(
    id: string,
    answer: unknown,
    attachments?: QuestionAttachmentMap,
  ): Promise<void> {
    const socket = liveSocket.current;
    if (!canSend || !socket || socket.readyState !== 1)
      return Promise.reject(new Error("当前连接不可提交，请重新连接后处理"));
    if (pendingAnswers.current.has(id))
      return Promise.reject(new Error("该回答正在提交"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAnswers.current.delete(id);
        reject(new Error("未收到提交确认，请重连核对请求状态后再处理"));
      }, 10000);
      pendingAnswers.current.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            type: "interaction_response",
            request_id: id,
            answer,
            ...(attachments ? { attachments } : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        pendingAnswers.current.delete(id);
        reject(new Error("连接已断开"));
      }
    });
  }
  async function send(
    questionReply?: string,
    questionAttachments: ConversationAttachment[] = [],
    fromBatch = false,
  ) {
    const fromQuestion = questionReply !== undefined;
    const sendStorageKey=composerRef.current.key;
    const text = questionReply ?? draftRef.current;
    const positions = attachmentPositions.current?.();
    const attached = fromQuestion
      ? questionAttachments
      : attachments
          .values()
          .map((item, index) => ({
            ...item,
            offset:
              positions?.get(
                attachments.items.filter(
                  (entry) => entry.status === "ready" && entry.path,
                )[index]?.id,
              ) ?? text.length,
          }));
    if (
      (!text.trim() && !attached.length) ||
      (!fromQuestion && (attachments.uploading || attachments.failed)) ||
      sendingRef.current ||
      !canSend ||
      !page?.session_active ||
      ended ||
      waiting
    ) {
      if (fromQuestion)
        throw new Error("当前无法提交回答，请等待会话就绪或完成其他交互");
      return;
    }
    let terminalDraft = false;
    window.dispatchEvent(
      new CustomEvent("agentmanager:check-terminal-draft", {
        detail: {
          sessionId: session.id,
          respond: (value: boolean) => {
            terminalDraft ||= value;
          },
        },
      }),
    );
    if (terminalDraft) {
      const message = "原始终端还有未发送内容，请先发送或清空后再从对话发送。";
      if (fromQuestion) throw new Error(message);
      setSendError(message);
      return;
    }
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
      if (fromQuestion) throw new Error("回答超过 64 KB，请缩短后发送");
      setSendError("消息超过 64 KB，请缩短后发送。");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setSendError("");
    const fingerprint = JSON.stringify([
      fromBatch,
      agentNativeId(session),
      session.claude_session_id,
      text,
      attached,
    ]);
    const clientId =
      submissionIdentity.current?.fingerprint === fingerprint
        ? submissionIdentity.current.id
        : conversationClientId();
    if(fromBatch&&!persistComposer({pending:{id:clientId,entryIds:composerRef.current.value.entries.map(e=>e.id),nativeId:agentNativeId(session)}})){
      sendingRef.current=false;setSending(false);return;
    }
    submissionIdentity.current = { fingerprint, id: clientId };
    const parsedReply = decodeQuestionReply(text);
    const timestamp = new Date(estimatedServerNow()).toISOString(),
      visibleText =
        parsedReply?.text ??
        (text.trim() ? text : attached.length ? "请查看附件。" : text),
      attachedIds = fromQuestion
        ? []
        : attachments.items.map((item) => item.id);
    const batchParts=fromBatch?composerRef.current.value.entries.map(({text,attachments})=>({text,attachments})):undefined;
    const version = draftVersion.current;
    const savedAttachments = fromQuestion
      ? []
      : attachments.items.map((item) => ({
          ...item,
          offset: positions?.get(item.id) ?? text.length,
        }));
    const accepted = timelineRef.current.find(
      (item) =>
        item.role === "user" && item.client_id === clientId && !item.optimistic,
    );
    if (!accepted)
      setMessages((previous) => [
        ...previous,
        {
          id: `pending-${clientId}`,
          client_id: clientId,
          role: "user",
          text: visibleText,
          attachments: attached,
          ...(batchParts?{batch:batchParts}:{}),
          timestamp,
          ...(parsedReply ? { question_replies: parsedReply.answers } : {}),
          optimistic: {
            afterSequence: previous.reduce(
              (last, item) => Math.max(last, item.sequence ?? -1),
              -1,
            ),
          },
        },
      ]);
    // Move this exact draft into the send transaction immediately. The HTTP
    // acknowledgement can arrive seconds after the native user-message echo.
    if (!fromQuestion) {
      draftRef.current = "";
      setDraft("");
      persistComposer({draft:""});
      attachments.take(attachedIds);
    }
    pinned.current = true;
    requestAnimationFrame(scrollBottom);
    function acknowledged(status: string) {
      if(fromBatch&&composerRef.current.key===sendStorageKey){const pending=composerRef.current.value.pending;if(pending?.id===clientId)persistComposer({pending:null,entries:composerRef.current.value.entries.filter(e=>!pending.entryIds.includes(e.id))});}
      submissionIdentity.current = null;
      setMessages((previous) =>
        previous.map((item) =>
          item.optimistic && item.client_id === clientId
            ? {
                ...item,
                optimistic: { ...item.optimistic, accepted: true },
                queued: status === "queued",
              }
            : item,
        ),
      );
      attachments.release(savedAttachments);
      // The native turn/started event can precede this HTTP acknowledgement;
      // only initialize the waiting state if a new turn has not arrived yet.
      setLiveProgress((previous) =>
        status !== "queued" && previous.stage === "idle"
          ? {
              turn_id: null,
              started_at: new Date().toISOString(),
              stage: "waiting",
            }
          : previous,
      );
      pinned.current = true;
      setRefresh((value) => value + 1);
      requestAnimationFrame(scrollBottom);
    }
    try {
      const response = accepted
        ? { status: accepted.queued ? "queued" : "submitted" }
        : await (batchParts?api.agent.sendInput(session.id,text,clientId,attached,batchParts.map(p=>({length:p.text.length,attachments:p.attachments.length}))):attached.length
            ? api.agent.sendInput(session.id, text, clientId, attached)
            : api.agent.sendInput(session.id, text, clientId));
      acknowledged(response.status);
    } catch (failure) {
      // A successful native echo is stronger evidence than a late HTTP error.
      const echoed = timelineRef.current.find(
        (item) =>
          item.role === "user" &&
          item.client_id === clientId &&
          !item.optimistic,
      );
      if (echoed) {
        acknowledged(echoed.queued ? "queued" : "submitted");
        return;
      }
      setMessages((previous) =>
        previous.filter(
          (item) => !(item.optimistic && item.client_id === clientId),
        ),
      );
      if(fromBatch&&composerRef.current.key===sendStorageKey&&failure instanceof ApiError&&(failure.submission==='rejected'||[400,401,403,404,413,422].includes(failure.status)))persistComposer({pending:null});
      if (fromQuestion) {
        setSendError(
          failure instanceof Error ? failure.message : "回答提交失败",
        );
        throw failure;
      }
      if (
        draftVersion.current === version &&
        !draftRef.current &&
        !attachments.hasDraft()
      ) {
        changeDraft(text);
        attachments.restore(savedAttachments);
      } else
        setFailedDrafts((previous) => [
          ...previous,
          { clientId, fingerprint, text, attachments: savedAttachments },
        ]);
      setSendError(
        failure instanceof ApiError &&
          ["rejected", "unknown"].includes(failure.submission || "")
          ? failure.message
          : `${failure instanceof Error ? failure.message : "发送失败"}。${sessionAgent(session).sessionHost === "managed" ? "请核对会话记录后再重试。" : "请查看原始终端确认后再重试。"}`,
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  function restoreFailedDraft(saved: FailedDraft) {
    if (sendingRef.current || draftRef.current || attachments.hasDraft())
      return;
    changeDraft(saved.text);
    attachments.restore(saved.attachments);
    submissionIdentity.current = {
      id: saved.clientId,
      fingerprint: saved.fingerprint,
    };
    setFailedDrafts((previous) =>
      previous.filter((item) => item.clientId !== saved.clientId),
    );
  }
  const agentName = sessionAgent(session).id === "codex" ? "codex" : sessionAgent(session).label;
  const lastUserTime = messages[lastUserIndex]?.timestamp;
  const currentAnswer = messages.some(
    (message, index) =>
      index > lastUserIndex &&
      message.role === "assistant" &&
      message.phase !== "error" &&
      (!liveProgress.turn_id ||
        message.turn_id === liveProgress.turn_id ||
        message.streaming),
  );
  const currentTurn = liveProgress.turn_id || messages[lastUserIndex]?.turn_id;
  const continuingAfterFollowup =
    busy &&
    !currentAnswer &&
    !!currentTurn &&
    messages.some(
      (message, index) =>
        index < lastUserIndex &&
        message.role === "assistant" &&
        message.turn_id === currentTurn,
    );
  const started = messages[lastUserIndex]?.optimistic ? null : lastUserTime || liveProgress.started_at;
  const elapsed = started
    ? Math.max(0, Math.floor((now - Date.parse(started)) / 1000))
    : 0;
  useEffect(()=>{
    if(stoppingRef.current&&(stoppingRef.current.sessionId!==session.id||!busy||liveProgress.turn_id!==stoppingRef.current.turnId)){
      stoppingRef.current=null;setStoppingTurn(null);setStopError('');
    }
  },[busy,liveProgress.turn_id,session.id]);
  const stopCurrentTurn=useCallback(async()=>{
    const turnId=liveProgress.turn_id;
    if(!turnId||stoppingRef.current||liveState!=='connected')return;
    const request={sessionId:session.id,turnId};stoppingRef.current=request;setStoppingTurn(turnId);setStopError('');
    try {await api.agent.stopTurn(session.id,turnId);}
    catch(error){
      if(stoppingRef.current!==request)return;
      if(error instanceof ApiError&&error.status>=400&&error.status<500){stoppingRef.current=null;setStoppingTurn(null);setStopError(error.message);}
      else setStopError('停止结果暂未确认，请等待会话状态更新。');
    }
  },[liveProgress.turn_id,liveState,session.id]);
  useEffect(()=>{
    if(!active||!busy||!canSend||!agentSupports(session,'stopTurn')||liveState!=='connected'||!liveProgress.turn_id)return;
    const onKeyDown=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||event.repeat||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
      if(document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]'))return;
      const target=event.target;
      if(target instanceof Element&&target.closest('select, [role="menu"], [role="listbox"], [role="combobox"]'))return;
      if(target instanceof Element&&!readingRoot.current?.contains(target)&&target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'))return;
      event.preventDefault();void stopCurrentTurn();
    };
    window.addEventListener('keydown',onKeyDown);return()=>window.removeEventListener('keydown',onKeyDown);
  },[active,busy,canSend,session,liveState,liveProgress.turn_id,stopCurrentTurn]);
  const stopButton=busy&&canSend&&agentSupports(session,'stopTurn')?<button type="button" className="session-chat-stop" aria-keyshortcuts="Escape" aria-label={stoppingTurn?'正在停止当前执行':'停止当前执行'} title={stoppingTurn?'停止请求已发送，等待状态更新':'停止当前执行（Esc），保留会话和草稿'} disabled={!!stoppingTurn||liveState!=='connected'||!liveProgress.turn_id} onClick={()=>void stopCurrentTurn()}>{stoppingTurn?<Loader2 size={17} className="animate-spin"/>:<Square size={16}/>}</button>:null;
  const waitingForText =
    !compaction.running && busy && !currentAnswer && !activeError && !waiting;
  const ignoredKey = JSON.stringify(page?.runtime?.ignored_question_ids || []);
  const ignoredIds = useMemo(
    () => JSON.parse(ignoredKey) as string[],
    [ignoredKey],
  );
  const statisticsIndex = useMemo(() => {
    const byId = new Map<string, ConversationStatistics>();
    for (const item of statistics) {
      if (item.message_id) byId.set(item.message_id, item);
      byId.set(`${item.turn_id}:${item.sequence}`, item);
    }
    return byId;
  }, [statistics]);
  const projected = useRef(
    new WeakMap<
      ConversationMessage,
      {
        ignored: string;
        stats: ConversationStatistics | undefined;
        value: ConversationMessage | null;
      }
    >(),
  );
  const displayed = useMemo(
    () =>
      messages.flatMap((message) => {
        const stats =
          statisticsIndex.get(message.id) ||
          statisticsIndex.get(`${message.turn_id}:${message.sequence}`);
        const ignored = message.async_questions?.length ? ignoredKey : "",
          cached = projected.current.get(message);
        if (cached && cached.ignored === ignored && cached.stats === stats)
          return cached.value ? [cached.value] : [];
        const questions = message.async_questions?.filter(
          (q) => !q.id || !ignoredIds.includes(q.id),
        );
        const value =
          questions && !questions.length
            ? null
            : stats || questions
              ? {
                  ...message,
                  ...(questions ? { async_questions: questions } : {}),
                  ...(stats ? { statistics: stats } : {}),
                }
              : message;
        projected.current.set(message, { ignored, stats, value });
        return value ? [value] : [];
      }),
    [messages, statisticsIndex, ignoredIds, ignoredKey],
  );
  const streamingId =
    !activeError &&
    liveState === "connected" &&
    busy &&
    !["tools", "finishing"].includes(liveProgress.stage)
      ? messages.reduce<string | null>(
          (id, message, index) =>
            index > lastUserIndex &&
            message.role === "assistant" &&
            message.streaming &&
            (!liveProgress.turn_id || message.turn_id === liveProgress.turn_id)
              ? message.id
              : id,
          null,
        )
      : null;
  const groups = groupConversationProgress(displayed);
  const displayedLastUser=displayed.reduce((index,message,current)=>message.role==='user'&&!message.queued&&!automaticConversationContext(message.text)?current:index,-1);
  const previousSegment=[...displayed.slice(0,Math.max(0,displayedLastUser))].reverse().find(message=>message.role==='assistant'&&message.statistics?.segment)?.statistics?.segment;
  const pendingSegment=continuingAfterFollowup&&previousSegment&&progressStatistics?.segment&&previousSegment.id!==progressStatistics.segment.id&&progressStatistics.turn_id===liveProgress.turn_id?progressStatistics.segment:null;
  const progressTimingVisible=busy&&!reconnectable&&!ended&&!waiting&&!activeError&&!compaction.state&&groups.at(-1)?.kind==='progress';
  const activityRunning=busy&&!reconnectable&&!ended&&!waiting&&!activeError;
  const currentActivities=liveState==='connected'&&!reconnectable&&liveProgress.stage==='tools'?liveProgress.activities||[]:[];
  const currentActivity=currentConversationActivity(currentActivities,activityRunning);
  const stepDuration=conversationActivityDuration(currentActivity,now);
  const progressActivities=liveState==='connected'&&!reconnectable?liveProgress.activities||[]:[];
  const runningTool=progressActivities.find(item=>item.status==='running');
  const callingLabel=runningTool?.label.split(' · ').slice(1).join(' · ')||null;
  const lastFinished=progressActivities.filter(item=>item.completed_at).sort((a,b)=>Date.parse(b.completed_at!)-Date.parse(a.completed_at!))[0];
  const progressPhase=liveState!=='connected'||reconnectable||(!runningTool&&!lastFinished&&liveProgress.stage==='tools')?'unknown':runningTool?'calling':'waiting';
  const phaseStart=progressPhase==='unknown'?null:runningTool?runningTool.started_at:lastFinished?.completed_at||liveProgress.started_at;
  const phaseSeconds=phaseStart&&Number.isFinite(Date.parse(phaseStart))?Math.max(0,Math.floor((now-Date.parse(phaseStart))/1000)):null;
  const turnDuration=elapsedBetween(started,now);
  const timings = conversationTimings(
    displayed.filter((message) => !message.queued),
    now,
    busy,
    liveProgress.turn_id,
  );
  const questionCache = useMemo(
    () => createConversationQuestionCache(),
    [session.id, agentNativeId(session)],
  );
  const questionIndex = questionCache.read(messages),
    submittedKey = JSON.stringify(page?.runtime?.submitted_question_ids || []);
  const pendingQuestions = useMemo(
    () =>
      questionIndex.pending(page?.runtime?.pending_questions, [
        ...ignoredIds,
        ...JSON.parse(submittedKey),
      ]),
    [questionIndex, page?.runtime?.pending_questions, ignoredIds, submittedKey],
  );
  const pendingQuestion =
    pendingQuestions.find((message) => message.id === selectedQuestion) ||
    pendingQuestions.at(-1) ||
    null;
  const questionActive =
    !!pendingQuestion && minimizedQuestion !== pendingQuestion.id;
  async function ignoreQuestions(ids: string[], ignored = true) {
    if (ignoringQuestions || !ids.length) return;
    setIgnoringQuestions(true);
    setIgnoreError("");
    try {
      const result = await api.sessions.ignoreQuestions(
        session.id,
        ids,
        ignored,
      );
      setPage((previous) =>
        previous && previous.runtime
          ? {
              ...previous,
              runtime: {
                ...previous.runtime,
                ignored_question_ids: result.ignored_question_ids,
              },
            }
          : previous,
      );
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({
        queryKey: ["project-sessions", session.project_id],
      });
      setRefresh((value) => value + 1);
    } catch (error) {
      setIgnoreError(
        error instanceof Error ? error.message : "忽略失败，请重试",
      );
    } finally {
      setIgnoringQuestions(false);
    }
  }
  const cancelRetry = useCallback(async () => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(session.id)}/conversation/retry/cancel`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("停止重试失败，请重试");
  }, [session.id]);
  async function cancelQueued(message: ConversationMessage) {
    if (!message.client_id) return;
    try {
      await api.agent.cancelQueuedInput(session.id, message.client_id);
      setMessages((previous) =>
        previous.filter(
          (item) => !(item.queued && item.client_id === message.client_id),
        ),
      );
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "取消排队失败，请刷新后重试",
      );
    }
  }
  const visibleQuestionAnswers=new Map<string,string>();
  for(const question of displayed) {
    if(!question.async_questions?.length)continue;
    const answers=questionIndex.answers(question);
    if(!answers)continue;
    question.async_questions.forEach((item,index)=>{if(item.id)visibleQuestionAnswers.set(item.id,answers[index]);});
  }
  const bubble = (message: ConversationMessage, compact = false, stableKey = message.id) =>
    message.role==='user'&&!message.queued&&!(message as TimelineMessage).optimistic&&!message.attachments?.length&&message.question_replies?.length&&message.question_replies.every(reply=>visibleQuestionAnswers.get(reply.question_id)===reply.answer) ? null :
    message.async_questions?.length ? (
      <ConversationQuestionSummary
        key={stableKey}
        message={message}
        state={questionIndex.state(
          message,
          page?.runtime?.submitted_question_ids,
        )}
        answers={questionIndex.answers(message)}
        onAnswer={openQuestion}
      />
    ) : (
      <Bubble
        key={stableKey}
        message={message}
        streaming={message.id === streamingId}
        retrying={
          message.id === activeError?.id &&
          !!busy &&
          !!message.error?.will_retry
        }
        autoRetry={Object.values(autoRetries).find((retry) =>
          retry.failed_turn_ids.includes(message.turn_id || ""),
        )}
        onCancelRetry={canSend ? cancelRetry : undefined}
        onCancelQueued={
          canSend &&
          message.queued &&
          message.client_id &&
          agentSupports(session, "cancelQueuedInput")
            ? () => cancelQueued(message)
            : undefined
        }
        compact={compact}
        durationLabel={timings.get(message.id)?.label}
        durationTitle={timings.get(message.id)?.title}
        agent={sessionAgent(session)}
        agentName={agentName}
        projectPath={projectPath}
        projectId={session.project_id}
        onOpenFile={onOpenFile}
        onNavigate={navigate}
        onRaw={onRaw}
        allowRaw={sessionAgent(session).sessionHost !== "managed"}
      />
    );
  return (
    <ConversationImagePreviewRoot active={active} onOpen={navigate}>
      <div className="session-chat-container"><div className="session-chat-layout">
      <section ref={readingRoot} className="session-chat" aria-label="会话对话">
        <ConversationPromptEnhancer
          sessionId={session.id}
          active={active}
          canEdit={canSend && !ended && !waiting}
          value={draft}
          attachments={attachments.items}
          onApply={changeDraft}
        />
        <div className="session-chat-reading">
          <div
            ref={list}
            className="session-chat-scroll"
            onScroll={() => {
              if (list.current)
                pinned.current =
                  list.current.scrollHeight -
                    list.current.scrollTop -
                    list.current.clientHeight <
                  80;
            }}
          >
            <div className={`session-chat-feed${loading && canRead && !groups.length ? " session-chat-feed-loading" : ""}`}>
              {hasMore && (
                <button
                  className="session-chat-older"
                  disabled={older}
                  onClick={() => void loadOlder()}
                >
                  {older ? "正在读取…" : "加载更早的对话"}
                </button>
              )}
              {loading && canRead && (
                <p className="session-chat-empty session-chat-loading" role="status">
                  <Loader2 size={16} className="animate-spin" />
                  Loading conversation…
                </p>
              )}
              {!canRead && !permissions.isPending && (
                <p className="session-chat-empty">
                  当前账号没有读取对话的权限。
                </p>
              )}
              {groups.map((group, groupIndex) => {
                if(group.kind === "message") return bubble(group.message,false,group.id);
                const last=group.messages.at(-1),next=groups[groupIndex+1];
                const final=next?.kind==='message'&&next.message.role==='assistant'&&next.message.phase==='final'&&!next.message.async_questions?.length&&!!next.message.turn_id&&next.message.turn_id===last?.turn_id?next.message:null;
                const saved=final?.statistics?.segment||last?.statistics?.segment;
                const live=progressStatistics?.segment;
                const part=busy&&groups.at(-1)===group&&progressStatistics?.turn_id===last?.turn_id&&saved&&live?.id===saved.id&&!!saved.start_at&&live.start_at===saved.start_at?live:saved;
                const summary=part?{...part,turn_id:last?.turn_id||''}:null;
                return (
                  <ProgressSection
                    key={`progress-${group.id}`}
                    agent={sessionAgent(session)}
                    agentName={agentName}
                    count={group.messages.length}
                    active={busy && groups.at(-1) === group}
                    stepDuration={progressTimingVisible&&groups.at(-1)===group?stepDuration:null}
                    stepRunning={currentActivity?.status==='running'}
                    phaseSeconds={phaseSeconds}
                    progressPhase={progressPhase}
                    callingLabel={callingLabel}
                    turnDuration={progressTimingVisible&&groups.at(-1)===group?(part?.start_at?elapsedBetween(part.start_at,now):turnDuration):part?.elapsed_ms??null}
                    completed={part?part.end_reason==='completed':!!final}
                    interrupted={part?.end_reason==='interrupted'}
                    progressScope="segment"
                    progress={summary}
                  >
                    {group.messages.map((message, index) => (
                      <div
                        key={message.id}
                        className="session-chat-progress-entry"
                        data-active={message.id === streamingId}
                      >
                        <span
                          className="session-chat-progress-number"
                          aria-label={`进展序号 ${index + 1}`}
                        >
                          {index + 1}
                        </span>
                        {bubble(message, true)}
                      </div>
                    ))}
                  </ProgressSection>
                );
              })}
              {waitingForText && continuingAfterFollowup && !sending && (
                <div className="session-chat-agent session-chat-progress-toggle session-chat-pending-progress" role="status">
                  <ProgressSummary agent={sessionAgent(session)} agentName={agentName} count={0} active progressScope="segment" progress={pendingSegment?{...pendingSegment,turn_id:liveProgress.turn_id||''}:null} stepDuration={stepDuration} stepRunning={currentActivity?.status==='running'} phaseSeconds={phaseSeconds} progressPhase={progressPhase} callingLabel={callingLabel} turnDuration={pendingSegment?.start_at?elapsedBetween(pendingSegment.start_at,now):turnDuration}/>
                </div>
              )}
              {waitingForText && (!continuingAfterFollowup || sending) && (
                <div className="session-chat-thinking" role="status">
                  <span aria-hidden="true" className="session-chat-thinking-icon"><AgentIcon session={{agent:sessionAgent(session)}} className="h-[13px] w-[13px]" /></span>
                  <div>
                    <div className="session-chat-thinking-summary"><span>
                      {continuingAfterFollowup
                        ? sending
                          ? "Sending follow-up…"
                          : `Follow-up sent · ${agentName} is working`
                        : liveProgress.stage === "tools"
                          ? `${agentName} is working`
                          : `Waiting for ${agentName}`}
                    </span>
                    <time className="session-chat-elapsed" style={{color:timeColor(elapsed)}}>{elapsed}s</time>
                    </div>
                    <p>
                      {continuingAfterFollowup
                        ? "The task is still running. Updates will appear here."
                        : liveProgress.stage === "tools"
                          ? "Updates will appear as work continues."
                          : "The response will appear as it arrives."}
                    </p>
                  </div>
                </div>
              )}
              {!loading && canRead && !messages.length && (
                <div className="session-chat-empty">
                  <p>这里显示你的消息、Agent 的进展说明和回答。</p>
                  <p>
                    {page?.available
                      ? "还没有对话记录。"
                      : "尚未读取到绑定的原生对话记录。"}
                    {sessionAgent(session).sessionHost !== "managed" && (
                      <button onClick={onRaw}>查看原始终端</button>
                    )}
                  </p>
                </div>
              )}
              {error && (
                <p role="alert" className="session-chat-error">
                  {error}
                  <button onClick={() => setRefresh((value) => value + 1)}>
                    重试
                  </button>
                </p>
              )}
              <div ref={bottom} />
            </div>
          </div>
          <ConversationWidthHandles
            root={readingRoot}
            scroll={list}
            active={active}
            storageKey={`agentmanager-chat-width:${userId}`}
          />
          {canRead && (
            <ConversationNavigator
              messages={displayed}
              scroll={list}
              active={active}
              hasMore={hasMore}
              loadingOlder={older}
              onLoadOlder={() => void loadOlder()}
              onNavigate={navigate}
            />
          )}
        </div>
        {unread && (
          <button className="session-chat-new" onClick={scrollBottom}>
            <ArrowDown size={14} />
            有新消息
          </button>
        )}
        {requests.length > 0 && (
          <div className="conversation-interactions">
            {requests.length > 1 && (
              <p className="conversation-interaction-queue">
                还有 {requests.length - 1} 项待处理
              </p>
            )}
            {requests.slice(0, 1).map((request) => (
              <ConversationInteraction
                key={`${connectionGeneration}:${request.id}`}
                request={request}
                storageKey={`agentmanager-question:${userId}:${session.id}:${request.id}`}
                connected={active && liveState === "connected"}
                canAnswer={canSend && !ended}
                attachmentContext={{
                  sessionId: session.id,
                  projectId: session.project_id,
                  projectPath,
                  enabled: canAttach,
                }}
                onAnswer={answerRequest}
                onRaw={onRaw}
              />
            ))}
          </div>
        )}
        {waiting && !requests.length && (
          <div className="session-chat-action" role="status">
            <strong>
              {interaction?.isPermission
                ? "Agent 需要授权"
                : "Agent 需要你确认或选择"}
            </strong>
            {interaction?.choices?.length ? (
              <p>{interaction.choices.join(" ｜ ")}</p>
            ) : null}
            <button onClick={onRaw}>切到原始终端处理</button>
          </div>
        )}
        {storageError&&<p role="alert" className="session-chat-error">{storageError}</p>}

        <footer className="session-chat-composer">
          <div className="session-chat-status" role="status">
            <span
              className={`session-chat-connection ${liveState}`}
              data-attention={!!pendingQuestion || waiting}
              aria-hidden="true"
            />
            {compaction.state ? (
              <ConversationCompactionStatus
                state={compaction.state}
                now={now}
              />
            ) : (
              <ConversationActivityLine
                key={`${session.id}:${liveState}:${liveProgress.turn_id || ""}`}
                activities={currentActivities}
                busy={activityRunning}
                now={now}
                totalElapsed={turnDuration}
                hideTiming={progressTimingVisible}
                fallback={
                  reconnecting
                    ? "Reconnecting session…"
                    : reconnectable
                      ? "Session disconnected"
                      : activeError
                        ? activeError.error?.will_retry
                          ? busy
                            ? "An error occurred; retrying…"
                            : "Retry ended"
                          : "Turn failed; resolve the error and retry"
                        : ended
                          ? "Session ended"
                          : waiting
                            ? "Waiting for your response"
                            : pendingQuestion && !busy
                              ? "Question pending · turn ended"
                              : continuingAfterFollowup
                                ? sending
                                  ? "Sending follow-up…"
                                  : "Follow-up submitted; continuing…"
                                : busy
                                  ? liveProgress.stage === "tools"
                                    ? "Running…"
                                    : waitingForText
                                      ? "Waiting for response…"
                                      : liveProgress.stage === "finishing"
                                        ? "Finishing turn…"
                                        : streamingId
                                          ? "Receiving response…"
                                          : "Processing…"
                                  : page?.session_active
                                    ? "Ready for your next message"
                                    : "Waiting for session"
                }
              />
            )}
            {observingStream && liveState === "connected" && (
              <span className="session-chat-live-label">Event stream connected</span>
            )}
            {observingStream && liveState === "connecting" && (
              <span
                className="session-chat-live-label"
                data-state="connecting"
                role="status"
              >
                {liveRetrying ? "Reconnecting live stream…" : "Connecting live stream…"}
              </span>
            )}
            {observingStream && liveState === "unavailable" && (
              <span
                className="session-chat-live-label"
                data-state={liveRetrying ? "retrying" : "unavailable"}
                title={liveReason}
              >
                {liveRetrying ? "Reconnecting live stream…" : "Live stream unavailable"}
              </span>
            )}
            {ended && onResume && (
              <button onClick={onResume} disabled={resuming}>
                {resuming
                  ? "正在恢复…"
                  : resumeFailed
                    ? "重试恢复会话"
                    : "恢复会话"}
              </button>
            )}
            {ended && onClose && <button onClick={onClose}>关闭会话</button>}
            {reconnectable && canSend && (
              <button
                type="button"
                disabled={reconnecting}
                onClick={() => void reconnect()}
              >
                {reconnecting ? "正在重新连接…" : "重新连接"}
              </button>
            )}
          </div>
          {pendingQuestion && !waiting && (
            <div className="session-chat-pending-attention">
              <span role="status">
                有{" "}
                {pendingQuestions.reduce(
                  (sum, message) =>
                    sum + (message.async_questions?.length || 0),
                  0,
                )}{" "}
                个问题待回答 ·{" "}
                {busy ? "Agent 仍在执行，可稍后回答" : "本轮已结束，可稍后回答"}
              </span>
              {canSend && (
                <button
                  type="button"
                  disabled={ignoringQuestions}
                  title="删除当前会话已有的全部待回答问题，以后不再提醒"
                  onClick={() =>
                    void ignoreQuestions(
                      pendingQuestions.flatMap(
                        (message) =>
                          message.async_questions?.flatMap((q) =>
                            q.id ? [q.id] : [],
                          ) || [],
                      ),
                    )
                  }
                >
                  {ignoringQuestions ? "正在忽略…" : "全部忽略"}
                </button>
              )}
            </div>
          )}
          {ignoreError && <p role="alert">{ignoreError}</p>}
          {stopError&&<p role="alert" className="session-chat-error">{stopError}</p>}
          {sendError && (
            <p role="alert" className="session-chat-error">
              {sendError}
            </p>
          )}
          {failedDrafts.map((saved) => (
            <div key={saved.clientId} className="session-chat-error">
              <p>
                未发送内容已保留：{saved.text.slice(0, 120)}
                {saved.attachments.length > 0 &&
                  `（${saved.attachments.length} 个附件）`}
              </p>
              <button
                type="button"
                disabled={sending || !!draft || attachments.items.length > 0}
                title="请先发送或清空当前草稿，再恢复未发送内容"
                onClick={() => restoreFailedDraft(saved)}
              >
                恢复未发送内容
              </button>
              <button
                type="button"
                onClick={() => {
                  attachments.release(saved.attachments);
                  setFailedDrafts((previous) =>
                    previous.filter((item) => item.clientId !== saved.clientId),
                  );
                }}
              >
                丢弃
              </button>
            </div>
          ))}
          {reconnectError && (
            <p role="alert" className="session-chat-error">
              {reconnectError}
            </p>
          )}
          {pendingQuestion && (
            <div className="session-chat-question-seat">
              <div hidden={!questionActive}>
                <ConversationAsyncQuestion
                  key={pendingQuestion.id}
                  message={pendingQuestion}
                  agentName={agentName}
                  storageKey={`agentmanager-question:${userId}:${session.id}:${pendingQuestion.id}`}
                  connected={active && !!page?.session_active && !ended}
                  canAnswer={canSend}
                  attachmentContext={{
                    sessionId: session.id,
                    projectId: session.project_id,
                    projectPath,
                    enabled: canAttach,
                  }}
                  onReply={send}
                  onRaw={onRaw}
                  onMinimize={() => setMinimizedQuestion(pendingQuestion.id)}
                />
              </div>
              {!questionActive && (
                <button
                  type="button"
                  className="session-chat-question-reminder"
                  onClick={() => setMinimizedQuestion(null)}
                >
                  待回答 · {pendingQuestion.async_questions?.[0].title}
                  <span>回答问题</span>
                </button>
              )}
            </div>
          )}
          {questionActive&&stopButton}
          <form
            hidden={questionActive}
            onSubmit={(event) => {
              event.preventDefault();
              if(composer.mode==='batch')stageBatch();else void send();
            }}
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.types).includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect =
                  canAttach && canSend && !ended && !sending ? "copy" : "none";
              }
            }}
            onDrop={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files"))
                return;
              event.preventDefault();
              event.stopPropagation();
              if (canAttach && canSend && !ended && !sending)
                attachments.enqueueTransfer(event.dataTransfer);
            }}
          >
            <ConversationComposerEditor
              snapshotRef={attachmentPositions}
              value={draft}
              items={attachments.items}
              disabled={!canSend || ended || waiting}
              placeholder={
                waiting
                  ? "请先处理上方交互"
                  : composer.mode==='batch'?"输入消息，Enter 加入批量，Ctrl+Enter 立即发送，Shift+Enter 换行":"输入消息，Enter 发送，Shift+Enter 换行"
              }
              projectId={session.project_id}
              projectPath={projectPath}
              onChange={changeDraft}
              onRemove={attachments.remove}
              onRetry={attachments.retry}
              onFiles={
                canAttach
                  ? attachments.enqueue
                  : () => setSendError("此 Agent 不支持附件")
              }
              onDirectSubmit={() => {if(active)void send();}}
              onSubmit={() => {if(composer.mode==='batch')stageBatch();else void send();}}
            />
            {attachments.error && (
              <p role="alert" className="session-chat-error">
                {attachments.error}
              </p>
            )}

            <div className="session-chat-input-tools">
              <ConversationAttachmentPicker
                disabled={!canAttach || !canSend || ended || sending}
                onFiles={attachments.enqueue}
              />
              <div className="session-chat-controls-slot conversation-toolbar"><label className="conversation-control-select conversation-composer-mode"><span>模式</span><select aria-label="发送模式" value={composer.mode} disabled={sending||!!composer.pending} onChange={e=>persistComposer({mode:e.target.value as ComposerState['mode']})}><option value="immediate">立即发送</option><option value="batch">批量发送</option></select><ChevronDown size={12}/></label><div ref={setToolbarTarget}/></div>
              <span className="session-chat-send-hint">{composer.mode==='batch'?'Enter 加入批量 · Ctrl+Enter 立即发送':'Enter 发送 · Shift+Enter 换行'}</span>
              <div className="session-chat-send-actions">
                <button
                  type="button"
                  className="session-chat-enhance"
                  aria-label="优化当前输入"
                  title="增强提示词"
                  disabled={
                    !canSend || ended || waiting || sending || attachments.uploading || attachments.failed || (!draft.trim() && !attachments.items.length)
                  }
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("agentmanager:enhance-native-prompt", {
                        detail: { sessionId: session.id },
                      }),
                    )
                  }
                >
                  <Sparkles size={17} />
                </button>
                {!questionActive&&stopButton}
                <button
                  type="submit"
                  aria-label={composer.mode==='batch'?'加入批量':'发送消息'}
                  disabled={
                    sending ||
                    attachments.uploading ||
                    attachments.failed ||
                    !canSend ||
                    (!draft.trim() && !attachments.items.length) ||
                    !page?.session_active ||
                    ended ||
                    waiting
                  }
                >
                  {sending ? (
                    <Loader2 size={17} className="animate-spin" />
                  ) : (
                    <ArrowUp size={18} />
                  )}
                </button>
              </div>
            </div>
          </form>
          {agentSupports(session, "controls") &&
            !!page?.native_id &&
            canRead && (
              <ConversationControls
                toolbarTarget={toolbarTarget}
                sessionId={session.id}
                active={active}
                busy={busy || sending || resuming}
                compacting={compaction.running}
                onCompact={compaction.start}
                onNewConversation={onNewConversation}
              />
            )}
        </footer>
      </section>
        {composer.mode==='batch'&&<aside className="session-chat-batch" aria-label="批量待发内容">
          <header className="session-batch-header"><span>批量待发</span><small>{composer.entries.length} 条</small></header>
          <div className="session-chat-batch-content">{composer.entries.length?composer.entries.map((entry,index)=><article key={entry.id}><header><small>消息 {index+1}</small><time dateTime={entry.createdAt} title="加入待发区时间">{formatDisplayTimestamp(entry.createdAt)}</time><button type="button" className="session-batch-recall" aria-label={`撤回第 ${index+1} 条消息`} disabled={!canSend||sending||!!composer.pending?.entryIds.includes(entry.id)||attachments.uploading||attachments.failed} onClick={()=>recallBatch(entry)}>撤回</button><button type="button" className="session-batch-delete" aria-label={`删除第 ${index+1} 条消息`} disabled={!canSend||sending||!!composer.pending?.entryIds.includes(entry.id)} onClick={()=>deleteBatch(entry)}>删除</button></header><ConversationMessageAttachments text={entry.text} items={entry.attachments} projectId={session.project_id} projectPath={projectPath} onOpenFile={onOpenFile}/></article>):<div className="session-batch-empty"><span>暂未添加消息</span><p>在输入框编写内容，按 Enter 加入这里，整理完成后一起发送。</p></div>}</div>
          {composer.pending&&<p role="status">发送结果待确认。恢复连接后自动核对，请勿重复发送。</p>}
          <footer className="session-batch-footer"><button type="button" className="session-batch-send" aria-label="发送批量内容" onClick={()=>void sendBatch()} disabled={!composer.entries.length||!!composer.pending||sending||!canSend||!page?.session_active||ended||waiting}>{sending?<Loader2 size={15} className="animate-spin"/>:<ArrowUp size={15}/>}<span>{sending?'正在发送…':'发送批量内容'}</span></button></footer>
        </aside>}
      </div></div>
    </ConversationImagePreviewRoot>
  );
}
