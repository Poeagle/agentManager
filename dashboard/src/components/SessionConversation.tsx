import {useConversationSendGuard} from '../lib/use-conversation-send-guard';
import {useConversationNotificationVisibility} from '../lib/use-conversation-notification-visibility';
import type {ConversationFocus} from '../lib/notifications';
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
import { ConversationCacheDrop, MetadataTime } from "./ConversationCacheDrop";
import {mergeCacheTimeline,unassignedUsageDescription,unassignedUsageLabel,type CacheTimeline,type SessionCacheDrop,type SessionMetadata} from '../lib/session-metadata';
import { ConversationAutomaticContext, ConversationSessionContext } from "./ConversationAutomaticContext";
import { ConversationBriefContext } from "./ConversationBriefContext";
import { ConversationDialogCard } from "./ConversationDialogCard";
import { ConversationQuote } from "./ConversationQuote";
import { makeConversationQuote, parseConversationQuote, quotePrefix, shiftInputOffsets, splitQuotedInput, type ConversationQuote as QuoteData } from "../lib/conversation-quote";
import { automaticConversationContext, omitRepeatedSharedResourceNotices, sessionContextParts } from "../lib/conversation-context";
import { parseBriefContext, prependBriefPayload } from "../lib/conversation-brief-context";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  TerminalSquare,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Loader2,
  Sparkles,
  Square,
  ChevronDown,
  CalendarClock,
  MessagesSquare,
  Clock3,
  Quote,
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
  type SendGuardPayload,
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
import {ConversationAttachmentPicker, ConversationMessageAttachments} from "./ConversationAttachments";
import {useConversationAttachments} from '../lib/use-conversation-attachments';
import type {DraftAttachment} from '../lib/conversation-attachments';
import {ConversationBatchResizeHandle} from "./ConversationBatchResizeHandle";
import { ConversationMarkdown } from "./ConversationMarkdown";
import {
  ConversationWidthHandles,
  ConversationNavigator,
} from "./ConversationReadingTools";
import { hasPermission, usePermissions } from "../lib/permissions";
import {
  conversationClientId,
  isWaitingConversationInput,
  mergeConversationTimeline,
  readWaitingInputs,
  updateWaitingInputs,
  waitingInputKey,
  type TimelineMessage,
} from "../lib/conversation-timeline";
import { finalThinking, groupConversationProgress, isEmptyProgress, isThinkingOnly, progressSteps, progressThinking, mergeConversationStatistics, pendingProgressStatistics, progressGroupStatistics, splitProgressSegments, withObservedToolCounts, withPrecedingThinking } from "../lib/conversation-progress";
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
import { ConversationProgressPending } from "./ConversationProgressPending";
import { conversationHistoryCursor } from '../../../server/src/shared/conversation-history-cursor';
import { ConversationThinking } from "./ConversationThinking";
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

function activityAfterRetry(activity: ConversationActivity, notice: ConversationMessage) {
  if (activity.turn_id !== notice.turn_id) return false;
  const started = Date.parse(activity.started_at ?? "");
  const failed = Date.parse(notice.timestamp ?? "");
  if (Number.isFinite(started) && Number.isFinite(failed) && started !== failed)
    return started > failed;
  return activity.after_message_id === notice.id;
}

interface FailedDraft {
  clientId: string;
  fingerprint: string;
  text: string;
  quote?: QuoteData;
  attachments: DraftAttachment[];
}

const timeColor=(seconds:number)=>seconds>=60?'var(--error)':seconds>=30?'#e57b18':'var(--text-muted)';

interface ProgressSummaryProps {
  agent: AgentDescriptor; agentName: string; count: number; active: boolean; timestamp?: string | null;
  progress?: import('../lib/api').ConversationProgressStatistics | null;
  progressScope?: 'total'|'turn'|'segment'; completed?: boolean; interrupted?: boolean;
  stepDuration?: number|null; stepRunning?: boolean; phaseSeconds?: number|null;
  progressPhase: 'calling'|'waiting'|'unknown'; turnDuration?: number|null; showStatistics?:boolean;
}

function ProgressSection({
  agent,
  agentName,
  count,
  active,
  timestamp,
  progress,
  progressScope,
  completed,
  interrupted,
  stepDuration,
  stepRunning,
  phaseSeconds,
  progressPhase,
  turnDuration,
  showStatistics=true,
  cacheNotices,
  children,
}: ProgressSummaryProps & {cacheNotices?: ReactNode; children: ReactNode}) {
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
          <ProgressSummary agent={agent} agentName={agentName} count={count} active={active} timestamp={timestamp} progress={progress} progressScope={progressScope} completed={completed} interrupted={interrupted} stepDuration={stepDuration} stepRunning={stepRunning} phaseSeconds={phaseSeconds} progressPhase={progressPhase} turnDuration={turnDuration} showStatistics={showStatistics}/>
          <ChevronDown size={14} className="session-chat-progress-chevron" />
        </summary>
        <div className="session-chat-progress-content">
          {open && cacheNotices}
          {children}
        </div>
      </details>
      {!open && cacheNotices}
    </section>
  );
}

function ProgressSummary({agent,agentName,count,active,timestamp,progress,progressScope='total',completed,interrupted,stepDuration,stepRunning,phaseSeconds,progressPhase,turnDuration,showStatistics=true}:ProgressSummaryProps) {
  return <>
          <span aria-hidden="true"><AgentIcon session={{agent}} className="h-[13px] w-[13px]" /></span>
          <span>{agentName}</span>
          <span className="session-chat-kind">progress</span>
          {showStatistics&&<span className="session-chat-progress-count">{count} {count === 1 ? "item" : "items"}</span>}
          {showStatistics&&timestamp&&<span className="session-chat-progress-time" aria-label="进展时间"><MetadataTime at={timestamp}/></span>}
          {showStatistics&&(progress||progressScope==='segment')&&<ConversationStatisticsLabel progress interval={!!progress&&!('segment' in progress)} statistics={progress?{...progress,sequence:0}:null}/>}
          {showStatistics&&active&&stepDuration!=null&&<time className="session-chat-progress-time" title={stepRunning?'Elapsed time for the current tool step':'Duration of the most recently completed tool step'}>Step {formatElapsedEnglish(stepDuration)}</time>}
          {showStatistics&&active&&<span className="session-chat-progress-time">{progressPhase}: <time style={{color:phaseSeconds==null?undefined:timeColor(phaseSeconds)}}>{phaseSeconds==null?'—':`${phaseSeconds}s`}</time></span>}
          {showStatistics&&(turnDuration!=null?<time className="session-chat-progress-time" style={{color:timeColor(turnDuration/1000)}} title="Elapsed time for this progress segment">Elapsed {formatElapsedEnglish(turnDuration)}</time>:progressScope==='segment'?<span className="session-chat-progress-time" title="Segment timing is unavailable">Elapsed —</span>:null)}
          {active ? <span className="session-chat-progress-live">In progress</span> : interrupted ? <span className="session-chat-progress-time">Interrupted</span> : completed ? <span className="session-chat-progress-time">Completed</span> : null}
  </>;
}

function InputDeliveryStatus({message}:{message:TimelineMessage}) {
  const pending=message.optimistic;
  const label=message.queued?'排队中':pending?.uncertain?'发送结果待确认':pending?.accepted?'等待 Agent 接收':pending?'提交中':'已发送';
  const delivered=label==='已发送';
  return <span className={`session-chat-input-delivery${delivered?' delivered':''}`} role="status" aria-label={label}
    title={delivered?'Agent 已接收':label}>
    {delivered?<Check size={13} aria-hidden="true"/>:<><Clock3 size={13} aria-hidden="true"/>{label}</>}
  </span>;
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
  showStatistics = true,
  agent,
  agentName,
  projectPath,
  projectId,
  onOpenFile,
  onNavigate,
  onQuote,
  onQuoteJump,
  durationLabel,
  onRaw,
  active,
  beforeAnswer,
}: {
  active: boolean;
  beforeAnswer?: ReactNode;
  allowRaw?: boolean;
  durationLabel?: string;
  retrying?: boolean;
  autoRetry?: ConversationRetry;
  onCancelRetry?: () => Promise<void>;
  onCancelQueued?: () => Promise<void>;
  onRaw: () => void;
  message: ConversationMessage;
  streaming: boolean;
  compact?: boolean;
  showStatistics?:boolean;
  agent: AgentDescriptor;
  agentName: string;
  projectPath?: string;
  projectId: string | null;
  onOpenFile?: (path: string) => void;
  onNavigate: () => void;
  onQuote?: (quote: QuoteData) => void;
  onQuoteJump: (messageId: string) => void;
}) {
  const timeZone = useDisplayClock();
  const [copied, setCopied] = useState(false),
    [cancelling, setCancelling] = useState(false);
  const visibleText = questionReplyDisplayText(message);
  const waitingInput = isWaitingConversationInput(message);
  const observedAt = compact ? message.statistics?.item_at ?? message.timestamp : message.timestamp;
  const rawParsed =
    message.role === "user"
      ? message.attachments
        ? { text: visibleText, attachments: message.attachments }
        : parseConversationInput(visibleText)
      : { text: message.text, attachments: [] };
  const brief = message.role === 'user' ? parseBriefContext(rawParsed.text) : null;
  const briefCard = brief && (
    <ConversationBriefContext context={brief.context} messageId={message.id} active={active}
      projectId={projectId} projectPath={projectPath} onNavigate={onNavigate} />
  );
  const currentInput = brief ? {text: brief.input, attachments: shiftInputOffsets(rawParsed.attachments, -brief.prefixLength)} : rawParsed;
  const parsed = message.role === 'user' && !message.batch?.length
    ? splitQuotedInput(currentInput.text,currentInput.attachments) : {...currentInput,quote:undefined};
  const displayBatch = message.batch?.map((part,index) => brief && index === 0 ? {...part,
    text: part.text.slice(brief.prefixLength), attachments: shiftInputOffsets(part.attachments, -brief.prefixLength)} : part);
  const quoteButton = onQuote && !streaming && !message.streaming && !message.queued && !waitingInput &&
    message.phase !== 'error' && !message.presentation && !message.input_source &&
    (parsed.text.trim() || parsed.attachments.length || message.content_blocks?.some(block => block.type === 'text' && block.text.trim()))
    ? <button type="button" className="session-chat-quote-action" aria-label="引用这条消息" title="引用" onClick={() => {
        const source = displayBatch?.length ? displayBatch.map(part =>
          part.text.slice(parseConversationQuote(part.text)?.prefixLength ?? 0) || part.attachments.map(item => item.name).join('、'),
        ).join('\n\n') : parsed.text.trim() || parsed.attachments.map(item => item.name).join('、') ||
          message.content_blocks?.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
        const quote = source && makeConversationQuote(message.id, message.role, source);
        if (quote) onQuote(quote);
      }}><Quote size={13}/></button>
    : null;
  const quoteCard = parsed.quote && <ConversationQuote quote={parsed.quote} agentName={agentName} onJump={onQuoteJump}/>;
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
    compact && streaming ? (
      <span className="session-chat-message-meta">
        <span className="session-chat-progress-updating">Streaming</span>
        {showStatistics&&<ConversationStatisticsLabel statistics={message.statistics??null} interval/>}
      </span>
    ) : (
      <span className="session-chat-message-meta">
        {message.queued && onCancelQueued && (
              <button
                type="button"
                className="conversation-action-button conversation-action-button--compact conversation-action-button--danger"
                disabled={cancelling}
                aria-busy={cancelling}
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
        {observedAt && Number.isFinite(Date.parse(observedAt)) ? (
          <time
            aria-label={compact ? "进展完成时间" : undefined}
            dateTime={observedAt}
            title={waitingInput?'提交时间':metadataTimestampTitle({...message,timestamp:observedAt}, compact)}
          >
            {formatConversationTimestamp(observedAt)}
          </time>
        ) : compact ? (
          <span className="session-chat-progress-time-unknown">
            Time pending
          </span>
        ) : null}
        {showStatistics && message.role === "assistant" && (message.statistics || compact || message.phase === "final") && (
          <ConversationStatisticsLabel
            statistics={message.statistics??null}
            interval={message.phase === "commentary"||!!message.streaming}
          />
        )}
        {showStatistics && durationLabel && (
          <span
            className="session-chat-message-duration"
            title={metadataDurationTitle(message.phase)}
          >
            {englishMetadataDuration(durationLabel)}
          </span>
        )}
        {compact && streaming && (
          <span className="session-chat-progress-updating">Streaming</span>
        )}
        {message.role==='user'&&<InputDeliveryStatus message={message}/>}
        {quoteButton}
        {!compact && message.role==='assistant' && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="复制Agent 回复"
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
          source: agent.label,
        }}
        copied={copied}
        onCopy={() => void copy()}
        projectPath={projectPath}
        projectId={projectId}
        onNavigate={onNavigate}
        active={active}
      />
    );
  if (message.role === 'user' && message.input_source) {
    const scheduled = message.input_source.kind === 'scheduled';
    const handoff = message.input_source.kind === 'agent_handoff';
    const sourceLabel = scheduled ? '定时任务' : '平台消息';
    return <>
      {briefCard}
      <article className="session-chat-sourced" data-input-source={message.input_source.kind} data-chat-message-id={message.id}>
        <ConversationDialogCard
          active={active}
          title={handoff ? message.input_source.label : `${sourceLabel} · ${message.input_source.label}`}
          summary={
            <>
              {handoff ? <MessagesSquare size={14} /> : <CalendarClock size={14} />}
              {!handoff && <span>{sourceLabel}</span>}
              <strong title={message.input_source.label}>{message.input_source.label}</strong>
              {(scheduled || handoff) && message.timestamp && Number.isFinite(Date.parse(message.timestamp)) && (
                <time dateTime={message.timestamp} title="发送时间">
                  {formatConversationTimestamp(message.timestamp)}
                </time>
              )}
              {message.queued && <span>已排队</span>}
              <span className="conversation-question-expand">查看详情</span>
            </>
          }
        >
          <div className="session-chat-sourced-content">
            {quoteCard}
            {parsed.text && <ConversationMarkdown content={parsed.text} messageId={message.id}
              projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile} onNavigate={onNavigate} />}
            <ConversationMessageAttachments items={parsed.attachments} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile} />
            {metadata}
          </div>
        </ConversationDialogCard>
      </article>
    </>;
  }
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
        active={active}
      />
    );
  const thinking = progressThinking([message]);
  const contentBlocks = message.content_blocks?.filter(
    block => block.type !== "thinking" && (block.type === "tool_use" || block.text.length > 0),
  ) ?? [];
  const lastBlock = message.content_blocks?.at(-1);
  if (
    message.role === "assistant" &&
    !message.text &&
    !contentBlocks.length &&
    !thinking &&
    !streaming
  )
    return null;
  if (message.phase === "error") {
    const summary = message.text.trim().split(/\r?\n/, 1)[0];
    const reconnect = message.error?.will_retry && summary.match(/^Reconnecting(?:\.\.\.|…)\s+(\d+\/\d+)$/i);
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
          {autoRetry ? (
            <ConversationRetryStatus retry={autoRetry} onCancel={onCancelRetry} />
          ) : (
            <strong title={reconnect ? message.text : undefined}>
              {reconnect
                ? `${retrying ? "正在重连" : "重连"} ${reconnect[1]}${retrying ? "" : " 已结束"}`
                : message.error?.will_retry
                  ? retrying ? "执行遇到错误，正在自动重试" : "重试已结束"
                  : "本轮执行出错"}
            </strong>
          )}
          {message.timestamp && (
            <time
              dateTime={message.timestamp}
              title={`原生消息记录时间：${formatConversationTimestamp(message.timestamp)}（浏览器时间 · ${timeZone}）；不代表阶段开始时间`}
            >
              {formatConversationTimestamp(message.timestamp)}
            </time>
          )}
        </div>
        {!reconnect && summary && (
          <span className="session-chat-error-original" title={message.text}>{summary}</span>
        )}
        {!autoRetry && !message.error?.will_retry ? (
          <span className="session-chat-error-hint">
            {/insufficient_balance|insufficient balance/i.test(message.text)
              ? "当前 Provider 余额不足，本轮已停止。请在 Agent 配置中充值或切换到其他 Provider，然后新开会话。"
              : message.error?.code === "rate_limit"
                ? "上游服务因额度或速率限制拒绝了请求。"
                : message.error?.code === "provider_connection_failed"
                  ? "无法连接当前 Provider。请检查网络、代理和 Provider 地址，然后重试。"
                : message.error?.code === "provider_unavailable" ||
                    /no available accounts|api error:\s*503/i.test(message.text)
                ? "当前 Claude Provider 暂无可用账号，本轮未执行。请更新 Provider 凭据或切换到其他模型，然后重试。"
              : message.error?.code === "server_overloaded" ||
                    /at capacity/i.test(message.text)
                ? "当前模型繁忙，本轮已停止。可稍后重试，或在原始终端切换模型。"
                : /selected model.*(?:does not exist|may not exist|access)/i.test(message.text)
                  ? "当前模型不存在或该 Provider 无访问权限，请检查 Provider 模型配置。"
                  : message.error?.code === "model_mismatch"
                    ? "Provider 实际路由到了不同模型。该结果未被当作所选模型，请检查 Provider 的模型映射或上游路由。"
                  : "本轮已停止。请根据错误信息处理后再试。"}
          </span>
        ) : null}
        <div className="session-chat-error-actions">
          {allowRaw && (
            <button type="button" onClick={onRaw} aria-label="查看原始终端" title="查看原始终端">
              <TerminalSquare size={14} aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={() => void copy()} aria-label={copied ? "已复制" : "复制错误信息"} title={copied ? "已复制" : "复制错误信息"}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
        </div>
      </article>
    );
  }
  return <>
    {briefCard}
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
      <div className={displayBatch?.length ? "session-chat-body session-chat-body--batch" : "session-chat-body"}>
        {message.role === "user" ? (
          <>
            <div className="session-chat-user-text">
              {quoteCard}
              {displayBatch?.length?<ConversationBatchCard sentAt={message.timestamp} parts={displayBatch} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile} agentName={agentName} onQuoteJump={onQuoteJump}/>:<ConversationMessageAttachments
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
            {thinking && <ConversationThinking agentName={agentName} text={thinking.body} previewText={thinking.text}
              streaming={streaming && !message.text && lastBlock?.type === 'thinking'}/>}
            {beforeAnswer}
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
            ) : message.text ? (
              <ConversationMarkdown
                content={message.text}
                messageId={message.id}
                streaming={streaming}
                projectPath={projectPath}
                projectId={projectId}
                onOpenFile={onOpenFile}
                onNavigate={onNavigate}
              />
            ) : null}
          </>
        )}
        {streaming && !isThinkingOnly(message) && (
          <span className="session-chat-caret" aria-label="正在输出" />
        )}
      </div>
    </article>
  </>;
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
  focusTarget,
  onFocusTargetVisible,
  draftScope,
  presentation="full",
}: {
  session: Session;
  active: boolean;
  onRaw: () => void;
  onResume?: () => void;
  onNewConversation?: (
    preference?: import("../lib/api").AgentModelPreference,
    expectedNativeId?: string,
    environmentId?: string,
  ) => Promise<string|void>;
  onClose?: () => void;
  resuming?: boolean;
  resumeFailed?: boolean;
  userId?: string;
  projectPath?: string;
  onOpenFile?: (path: string) => void;
  focusTarget?:ConversationFocus|null;
  onFocusTargetVisible?:()=>void;
  draftScope?:string;
  presentation?:"full"|"notification";
}) {
  const compaction = useConversationCompaction(
    session.id,
    agentNativeId(session),
  );
  const sendGuard=useConversationSendGuard(session.id,active,compaction,onNewConversation?(expectedNativeId,preference,environmentId)=>expectedNativeId?(environmentId?onNewConversation(preference,expectedNativeId,environmentId):onNewConversation(preference,expectedNativeId)):onNewConversation():undefined);
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const liveUsageQuery=useQuery<ConversationUsageUpdate|null>({queryKey:["conversation-usage",session.id],queryFn:async()=>null,enabled:false});
  const canRead = hasPermission(permissions.data, "agent_api");
  const canSend = hasPermission(permissions.data, "agent_api", "write");
  const canAttach = agentSupports(session, "attachments");
  const inputStorageKey=waitingInputKey(userId,session.id,agentNativeId(session));
  const notificationView=presentation==="notification";
  const [composerOptionsOpen,setComposerOptionsOpen]=useState(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [autoRetries, setAutoRetries] = useState<
    Record<string, ConversationRetry>
  >({});
  useEffect(() => setAutoRetries({}), [session.id, agentNativeId(session)]);
  const [statistics, setStatistics] = useState<ConversationStatistics[]>([]);
  const [metadata, setMetadata] = useState<CacheTimeline|null>(null);
  const acceptMetadata=useCallback((summary:SessionMetadata|null|undefined,drops:SessionCacheDrop[]=[])=>
    {if(summary)setMetadata(previous=>mergeCacheTimeline(previous,summary,drops));},[]);
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
  const storageKey = composerKey(draftScope?`${userId}:${draftScope}`:userId,session.id);
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
  // A confirmed compact-and-send keeps its original subscription through dispatch,
  // even while another tab or the raw terminal is visible.
  const receiveUpdates=active||sendGuard.background||sending;
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
  // A terminal live stage is authoritative until a new turn starts, even if
  // a delayed page poll still carries the previous running state.
  const completedTurn = useRef<string | null>(null);
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
  const chatLayout = useRef<HTMLDivElement>(null);
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
  const changeDraft = useCallback((text: string, extra?: Pick<ComposerState, 'draftQuote'>) => {
    draftVersion.current++;
    draftRef.current = text;
    setDraft(text);
    persistComposer({draft:text,...extra});
  }, []);
  const setDraftQuote = useCallback((quote?: QuoteData) => {
    if (!persistComposer({draftQuote:quote})) return;
    draftVersion.current++;
    readingRoot.current?.querySelector<HTMLElement>('.session-chat-editor')?.focus({preventScroll:true});
  }, []);
  useEffect(()=>{
    const pending=composerRef.current.value.pending;
    if(pending&&messages.some(m=>m.role==='user'&&m.client_id===pending.id&&!m.optimistic)){
      persistComposer({pending:null,entries:composerRef.current.value.entries.filter(e=>!pending.entryIds.includes(e.id))});
    }
  },[messages]);
  function stageBatch(){
    if(!canSend||sendGuard.blocking||attachments.uploading||attachments.failed||sendingRef.current)return;
    const text=draftRef.current,values=attachments.values().map((a,index)=>({...a,offset:attachmentPositions.current?.().get(attachments.items.filter(i=>i.status==='ready'&&i.path)[index]?.id)??text.length}));
    if(!text.trim()&&!values.length)return;
    const quote=composerRef.current.value.draftQuote,prefix=quote?quotePrefix(quote):'';
    const entries=[...composerRef.current.value.entries,{id:conversationClientId(),createdAt:new Date(estimatedServerNow()).toISOString(),text:prefix+text,attachments:shiftInputOffsets(values,prefix.length)}];
    const combined=combinedBatch(entries);
    if(entries.length>100||new TextEncoder().encode(combined.text).byteLength>64*1024||combined.attachments.length>8){setSendError('批量内容最多 100 条、64 KB、8 个附件，请先发送已有内容。');return;}
    if(!persistComposer({entries,draft:'',draftQuote:undefined,draftAttachments:[]}))return;
    draftVersion.current++;draftRef.current='';setDraft('');
    attachments.release(attachments.take(attachments.items.map(i=>i.id)));
    // The add button becomes disabled when the draft clears; keep keyboard
    // focus in the editor rather than letting the browser move it to body.
    readingRoot.current?.querySelector<HTMLElement>('.session-chat-editor')?.focus({preventScroll:true});
  }
  function recallBatch(entry:BatchEntry){
    if(sendGuard.blocking||composerRef.current.value.pending?.entryIds.includes(entry.id)||sendingRef.current||attachments.uploading||attachments.failed)return;
    if(attachments.items.length+entry.attachments.length>8){setSendError('输入框最多支持 8 个附件，请先处理现有输入。');return;}
    const quote=parseConversationQuote(entry.text),draftQuote=composerRef.current.value.draftQuote;
    if(quote&&draftQuote){setSendError('请先移除当前草稿的引用，再取回这条批量消息。');return;}
    const current=draftRef.current,prefix=current?current+'\n\n':'',body=entry.text.slice(quote?.prefixLength??0);
    const text=prefix+body;
    const restored=entry.attachments.map(item=>({...item,offset:prefix.length+Math.max(0,(item.offset??entry.text.length)-(quote?.prefixLength??0))}));
    if(!persistComposer({draft:text,draftQuote:quote?.quote??draftQuote,draftAttachments:[...attachments.values(),...restored],entries:composerRef.current.value.entries.filter(e=>e.id!==entry.id)}))return;
    draftVersion.current++;draftRef.current=text;setDraft(text);
    attachments.restore(restored.map(a=>({...a,id:conversationClientId(),size:0,status:'ready' as const})));
  }
  function deleteBatch(entry:BatchEntry){
    if(!canSend||sendGuard.blocking||sendingRef.current||composerRef.current.value.pending?.entryIds.includes(entry.id))return;
    persistComposer({entries:composerRef.current.value.entries.filter(e=>e.id!==entry.id)});
  }
  async function sendBatch(brief=false){
    const value=composerRef.current.value;
    if(value.pending||!value.entries.length)return;
    const combined=combinedBatch(value.entries);
    try{await send(combined.text,combined.attachments,true,brief);}catch{/* Durable batch remains available for reconciliation. */}
  }
  function submitWithShortcut(){
    if(!active)return;
    // Uploaded or still-uploading attachments belong to the input draft too.
    // Never send another batch merely because its text editor is empty.
    if(composerRef.current.value.mode==='batch'&&!draftRef.current.trim()&&!attachments.hasDraft())void sendBatch();
    else void send();
  }
  const bottom = useRef<HTMLDivElement>(null);
  const focusedQuestion = useRef<string | null>(null);
  const timelineRef = useRef(messages);
  timelineRef.current = messages;
  const conversationIdentity = useRef<{
    sessionId: string;
    nativeId: string | null;
    userId?: string;
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
      previous.userId !== userId ||
      (!!previous.nativeId && !!nativeId && previous.nativeId !== nativeId);
    conversationIdentity.current = { sessionId: session.id, nativeId, userId };
    if (!identityChanged) return;
    cursor.current = undefined;
    generation.current = null;
    pushAvailable.current = false;
    reconnectAttempted.current = false;
    setReconnectError("");
    setMessages(readWaitingInputs(inputStorageKey).map(message=>message.optimistic?.accepted||message.queued?message:{
      ...message,optimistic:{...message.optimistic!,uncertain:true},
    }));
    setStatistics([]);
    setMetadata(null);
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
  }, [session.id, agentNativeId(session), session.claude_session_id, inputStorageKey, userId]);
  const receivedInputKey=JSON.stringify(messages.filter(message=>message.role==='user'&&!isWaitingConversationInput(message))
    .flatMap(message=>[message.client_id,message.native_client_id].filter(Boolean)));
  useEffect(()=>{
    if(!inputStorageKey)return;
    const received=new Set<string>(JSON.parse(receivedInputKey));
    updateWaitingInputs(inputStorageKey,rows=>rows.some(row=>row.client_id&&received.has(row.client_id))
      ? rows.filter(row=>!row.client_id||!received.has(row.client_id)) : rows);
  },[inputStorageKey,receivedInputKey]);
  const ended = ["completed", "failed", "cancelled"].includes(session.status);
  const pausedForMemory = ended && session.stop_reason === "memory_pressure";
  const observingStream =
    receiveUpdates &&
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
      !isWaitingConversationInput(message) &&
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
  const latestUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const completedWithoutNewInput = Boolean(
    latestUser &&
      latestAssistant?.phase === "final" &&
      !latestAssistant.streaming &&
      latestAssistant.timestamp &&
      latestUser.timestamp &&
      Date.parse(latestAssistant.timestamp) >= Date.parse(latestUser.timestamp),
  );
  // A tool can start after a native retry without adding a transcript message.
  // Compare starts so an older tool finishing during the retry cannot clear it.
  const resumedAfterRetry =
    latestAssistant?.phase === "error" &&
    latestAssistant.error?.will_retry &&
    latestAssistant.turn_id &&
    latestAssistant.turn_id === liveProgress.turn_id &&
    liveProgress.stage !== "waiting" &&
    liveProgress.activities?.some((activity) => activityAfterRetry(activity, latestAssistant))
      ? latestAssistant
      : null;
  const activeError =
    latestAssistant?.phase === "error" &&
    !resumedAfterRetry &&
    (liveState !== "connected" ||
      !liveProgress.turn_id ||
      !latestAssistant.turn_id ||
      latestAssistant.turn_id === liveProgress.turn_id)
      ? latestAssistant
      : null;
  const busy =
    !completedWithoutNewInput &&
    !(activeError && !activeError.error?.will_retry) &&
    !(completedTurn.current && completedTurn.current === liveProgress.turn_id) &&
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
    if (!receiveUpdates || !canRead) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let pageActive = false;
      try {
        let result = await api.agent.conversation(
          session.id,
          cursor.current ? { after: cursor.current } : { include_context: "true" },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        // A replaced history file changes generation while its old cursor can
        // still be valid. Never replace the timeline with that incremental
        // tail: obtain a complete baseline before resetting visible history.
        if (cursor.current && (result.reset ||
          generation.current !== null && result.generation !== generation.current)) {
          result = await api.agent.conversation(session.id, { include_context: "true" }, controller.signal);
          if (controller.signal.aborted) return;
          result = { ...result, reset: true };
        }
        acceptMetadata(result.metadata,result.cache_drops);
        pageActive = result.session_active;
        const reset =
          result.reset ||
          (generation.current !== null &&
            result.generation !== generation.current);
        const first = !cursor.current || reset;
        generation.current = result.generation;
        setPage((previous) => {
          const sameNative = previous !== null && previous.native_id === result.native_id;
          const keepRuntime = sameNative && Date.parse(previous.runtime?.observed_at || "") > Date.parse(result.runtime?.observed_at || "");
          return {
            ...result,
            runtime: keepRuntime ? previous.runtime : result.runtime,
            startup_context: result.startup_context ?? (sameNative && previous.generation === result.generation ? previous.startup_context : undefined),
          };
        });
        if (reset || result.statistics)
          setStatistics((previous) =>
            reset
              ? result.statistics ?? []
              : mergeConversationStatistics(previous, result.statistics ?? []),
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
          cursor.current = conversationHistoryCursor(result.messages);
        } else if (result.messages.length) {
          setMessages((previous) =>
            mergeConversationTimeline(previous, result.messages),
          );
          cursor.current = conversationHistoryCursor(result.messages) ?? cursor.current;
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
    receiveUpdates,
    canRead,
    session.id,
    session.status,
    agentNativeId(session),
    session.claude_session_id,
    refresh,
  ]);

  useEffect(() => {
    if (
      !receiveUpdates ||
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
      if (!frame.busy && frame.stage && !["waiting", "tools", "answering", "finishing"].includes(frame.stage))
        completedTurn.current = frame.turn_id || null;
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
          metadata?: SessionMetadata;
          cache_drops?: SessionCacheDrop[];
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
        if(frame.type==='progress_statistics'&&frame.native_id===agentNativeId(session)){setProgressStatistics(frame.progress??null);return;}
        if(frame.type==='session_metadata'){
          if(frame.native_id===agentNativeId(session))acceptMetadata(frame.metadata,frame.cache_drops);
          return;
        }
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
          setStatistics((previous) => mergeConversationStatistics(previous, frame.statistics!));
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
  }, [receiveUpdates, canRead, session.id, session.cli_type, agentNativeId(session), page?.native_id, ended]);

  async function loadOlder() {
    if (older) return;
    setOlder(true);
    const previousHeight = list.current?.scrollHeight || 0;
    const previousTop = list.current?.scrollTop || 0;
    try {
      const identity = conversationIdentity.current;
      const result = await api.agent.conversation(session.id, {
        before: messages[0]?.id || "0".repeat(32),
      });
      if(conversationIdentity.current.sessionId!==identity.sessionId||conversationIdentity.current.nativeId!==identity.nativeId)return;
      if(result.reset||result.generation!==generation.current){setRefresh(value=>value+1);return;}
      acceptMetadata(result.metadata,result.cache_drops);
      if (result.statistics)
        setStatistics((previous) => mergeConversationStatistics(previous, result.statistics!));
      setMessages((previous) =>
        mergeConversationTimeline(previous, result.messages, "prepend"),
      );
      setHasMore(result.has_more);
      setError("");
      if (!cursor.current) cursor.current = conversationHistoryCursor(result.messages);
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
    brief = false,
  ) {
    const fromQuestion = questionReply !== undefined;
    const sendStorageKey=composerRef.current.key;
    const quote = fromQuestion ? undefined : composerRef.current.value.draftQuote;
    const prefix = quote ? quotePrefix(quote) : '';
    const draftText = questionReply ?? draftRef.current;
    const text = brief && !fromQuestion && !draftText.trim() && !attachments.hasDraft()
      ? '请阅读以上历史记录，等待我的下一条需求。' : draftText;
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
      resuming ||
      sendGuard.blocking ||
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
    const input = prefix + text;
    if (new TextEncoder().encode(input).byteLength > 64 * 1024) {
      if (fromQuestion) throw new Error("回答超过 64 KB，请缩短后发送");
      setSendError("消息超过 64 KB，请缩短后发送。");
      return;
    }
    const guardVersion=draftVersion.current,guardEntries=JSON.stringify(composerRef.current.value.entries.map(e=>e.id));
    let guardToken:string|undefined,sendNativeId=agentNativeId(session);
    let sendPayload:SendGuardPayload={input,attachments:shiftInputOffsets(attached,prefix.length),...fromBatch?{batch:composerRef.current.value.entries.map(e=>({length:e.text.length,attachments:e.attachments.length}))}:{}};
    const inputIdentity=JSON.stringify(sendPayload);
    const savedBrief=(!fromQuestion||fromBatch)?composerRef.current.value.briefContext:undefined;
    if(savedBrief){
      if(savedBrief.nativeId!==(page?.native_id??agentNativeId(session))){setSendError('待发送的简要历史属于另一个对话，请返回原对话或移除简要历史。');return;}
      if(savedBrief.inputIdentity!==inputIdentity){setSendError('当前内容与简要历史关联的原草稿不同，请恢复原草稿或移除简要历史。');return;}
      try{sendPayload=prependBriefPayload(sendPayload,savedBrief.prefix);}catch(failure){setSendError(failure instanceof Error?failure.message:'简要历史不可用');return;}
    }
    if(!fromQuestion||fromBatch){
      try{const confirmation=await sendGuard.confirm(sendPayload,brief?'brief':undefined);if(confirmation===null)return;guardToken=confirmation.token;sendNativeId=confirmation.nativeId??sendNativeId;sendPayload=confirmation.payload;}
      catch(failure){setSendError(failure instanceof Error?failure.message:'发送前检查失败，草稿已保留');return;}
    }
    if(!fromQuestion&&draftVersion.current!==guardVersion||fromBatch&&guardEntries!==JSON.stringify(composerRef.current.value.entries.map(e=>e.id))){setSendError('输入内容已变化，请重新发送以检查最新草稿。');return;}
    sendingRef.current = true;
    setSending(true);
    setSendError("");
    const sendText=sendPayload.input,sendAttachments=sendPayload.attachments??[];
    const prefixLength=sendText.length-input.length;
    const sentBrief=parseBriefContext(sendText);
    if(sentBrief&&sendNativeId&&prefixLength>0&&!persistComposer({briefContext:{prefix:sendText.slice(0,prefixLength),nativeId:sendNativeId,inputIdentity}})){
      sendingRef.current=false;setSending(false);setSendError('简要历史保存失败，草稿已保留；请检查浏览器存储后从原会话重试。');return;
    }
    const fingerprint = JSON.stringify([
      fromBatch,
      sendNativeId,
      sendText,
      sendAttachments,
    ]);
    const clientId =
      submissionIdentity.current?.fingerprint === fingerprint
        ? submissionIdentity.current.id
        : conversationClientId();
    if(fromBatch&&!persistComposer({pending:{id:clientId,entryIds:composerRef.current.value.entries.map(e=>e.id),nativeId:sendNativeId}})){
      sendingRef.current=false;setSending(false);return;
    }
    submissionIdentity.current = { fingerprint, id: clientId };
    const parsedReply = decodeQuestionReply(sendText);
    const timestamp = new Date(estimatedServerNow()).toISOString(),
      visibleText =
        parsedReply?.text ??
        (sendText.trim() ? sendText : sendAttachments.length ? "请查看附件。" : sendText),
      attachedIds = fromQuestion
        ? []
        : attachments.items.map((item) => item.id);
    const batchParts=fromBatch?composerRef.current.value.entries.map(({text:partText,attachments},index)=>({
      text:index===0&&prefixLength>0?sendText.slice(0,prefixLength)+partText:partText,
      attachments:index===0&&prefixLength>0?attachments.map(item=>({...item,...(item.offset===undefined?{}:{offset:item.offset+prefixLength})})):attachments,
    })):undefined;
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
    const sendWaitingKey=waitingInputKey(userId,session.id,sendNativeId);
    const matchesPending=(item:TimelineMessage)=>!!item.optimistic&&item.client_id===clientId;
    if (!accepted) {
      const pending:TimelineMessage={
          id: `pending-${clientId}`,
          client_id: clientId,
          role: "user",
          text: visibleText,
          attachments: sendAttachments,
          ...(batchParts?{batch:batchParts}:{}),
          timestamp,
          ...(parsedReply ? { question_replies: parsedReply.answers } : {}),
          optimistic: {
            afterSequence: timelineRef.current.reduce(
              (last, item) => Math.max(last, item.sequence ?? -1),
              -1,
            ),
          },
      };
      const remember=(previous:TimelineMessage[])=>previous.some(matchesPending)
        ? previous.map(item=>matchesPending(item)?pending:item) : [...previous,pending];
      setMessages(remember);
      updateWaitingInputs(sendWaitingKey,remember);
    }
    // Move this exact draft into the send transaction immediately. The HTTP
    // acknowledgement can arrive seconds after the native user-message echo.
    if (!fromQuestion) {
      draftRef.current = "";
      setDraft("");
      persistComposer({draft:"",draftQuote:undefined});
      attachments.take(attachedIds);
    }
    pinned.current = true;
    requestAnimationFrame(scrollBottom);
    function acknowledged(status: string) {
      if(fromBatch&&composerRef.current.key===sendStorageKey){const pending=composerRef.current.value.pending;if(pending?.id===clientId)persistComposer({pending:null,entries:composerRef.current.value.entries.filter(e=>!pending.entryIds.includes(e.id))});}
      if(sentBrief&&composerRef.current.key===sendStorageKey&&composerRef.current.value.briefContext?.prefix===sendText.slice(0,prefixLength))persistComposer({briefContext:undefined});
      submissionIdentity.current = null;
      const settle=(previous:TimelineMessage[])=>previous.some(matchesPending)
        ? previous.map((item) =>
          matchesPending(item)
            ? {
                ...item,
                optimistic: { ...item.optimistic!, accepted: true, uncertain:false },
                queued: status === "queued",
              }
            : item,
        ) : previous;
      setMessages(settle);
      updateWaitingInputs(sendWaitingKey,settle);
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
        : await (guardToken?api.agent.sendInput(session.id,sendText,clientId,sendAttachments,sendPayload.batch,guardToken):batchParts?api.agent.sendInput(session.id,sendText,clientId,sendAttachments,sendPayload.batch):sendAttachments.length
            ? api.agent.sendInput(session.id, sendText, clientId, sendAttachments)
            : api.agent.sendInput(session.id, sendText, clientId));
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
      const rejected=failure instanceof ApiError&&(failure.submission==='rejected'||
        failure.submission!=='unknown'&&[400,401,403,404,409,413,422].includes(failure.status));
      const settle=(previous:TimelineMessage[])=>rejected?previous.filter(item=>!matchesPending(item)):
        previous.map(item=>matchesPending(item)?{...item,optimistic:{...item.optimistic!,uncertain:true}}:item);
      setMessages(settle);
      updateWaitingInputs(sendWaitingKey,settle);
      if(fromBatch&&composerRef.current.key===sendStorageKey&&rejected)persistComposer({pending:null});
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
        changeDraft(text,{draftQuote:quote});
        attachments.restore(savedAttachments);
      } else
        setFailedDrafts((previous) => [
          ...previous,
          { clientId, fingerprint, text, quote, attachments: savedAttachments },
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
    if (sendingRef.current || draftRef.current || composerRef.current.value.draftQuote || attachments.hasDraft())
      return;
    changeDraft(saved.text,{draftQuote:saved.quote});
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
  const started = lastUserTime || liveProgress.started_at;
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
  const { transcript, injected } = useMemo(() => {
    const transcript: TimelineMessage[] = [];
    const injected: TimelineMessage[] = [];
    for (const message of messages) {
      if (message.role === 'user' && !message.input_source && !isWaitingConversationInput(message)
        && sessionContextParts(message.text).length > 0) injected.push(message);
      else transcript.push(message);
    }
    return { transcript, injected };
  }, [messages]);
  const contextEntries = useMemo(() => omitRepeatedSharedResourceNotices(
    mergeConversationTimeline(page?.startup_context ?? [], injected).flatMap(message =>
      sessionContextParts(message.text).map(({ context, text }, index) => ({
        ...message, context, text, id: `${message.id}:${index}`,
      })),
    ),
  ), [page?.startup_context, injected]);
  const displayed = useMemo(
    () =>
      omitRepeatedSharedResourceNotices(transcript.flatMap((message) => {
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
      })),
    [transcript, statisticsIndex, ignoredIds, ignoredKey],
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
  const splitSegments = splitProgressSegments(groups);
  const displayedLastUser=displayed.reduce((index,message,current)=>message.role==='user'&&!isWaitingConversationInput(message)&&!automaticConversationContext(message.text)?current:index,-1);
  const previousSegment=[...displayed.slice(0,Math.max(0,displayedLastUser))].reverse().find(message=>message.role==='assistant'&&message.statistics?.segment)?.statistics?.segment;
  const liveSegment=progressStatistics?.turn_id===liveProgress.turn_id?progressStatistics?.segment:undefined;
  const liveStep=progressStatistics?.step;
  const inputBoundary=displayed[displayedLastUser]?.timestamp;
  const firstStepAfterInput=!!liveSegment&&liveStep?.segment_id===liveSegment.id&&liveStep.after_message_id===null&&liveStep.after_sequence===null&&
    !!inputBoundary&&!!liveSegment.start_at&&Date.parse(liveSegment.start_at)>=Date.parse(inputBoundary);
  const pendingSegment=liveSegment&&(firstStepAfterInput||continuingAfterFollowup&&previousSegment&&previousSegment.id!==liveSegment.id)?liveSegment:null;
  // This slot is presentation only: native messages remain the sole history.
  // Queued input must not close the running segment before it is accepted.
  const tailIndex=groups.reduce((index,group,current)=>group.kind==='progress'||!isWaitingConversationInput(group.message)?current:index,-1);
  const tail=groups[tailIndex];
  const tailMessage=tail?.kind==='progress'?tail.messages.at(-1):tail?.message;
  const liveTurn=liveProgress.turn_id;
  const canShowLiveProgress=busy&&!ended&&!waiting&&!activeError&&!compaction.state&&!!liveTurn&&
    liveProgress.stage!=='finishing'&&!(tailMessage?.role==='assistant'&&(!tailMessage.turn_id||tailMessage.turn_id===liveTurn)&&
      (tailMessage.phase==='final'||tailMessage.streaming&&liveProgress.stage!=='tools'))&&
    !(tailMessage?.role==='assistant'&&tailMessage.turn_id&&tailMessage.turn_id!==liveTurn&&liveProgress.stage==='answering');
  const activityRunning=busy&&!reconnectable&&!ended&&!waiting&&!activeError;
  const currentActivities=liveState==='connected'&&!reconnectable&&liveProgress.stage==='tools'?liveProgress.activities||[]:[];
  const currentActivity=currentConversationActivity(currentActivities,activityRunning);
  const stepDuration=conversationActivityDuration(currentActivity,now);
  const progressActivities=liveState==='connected'&&!reconnectable?liveProgress.activities||[]:[];
  // Activities are transient state, not history: keep one latest row per
  // native tool ID so streamed updates cannot grow a vertical stack.
  const latestActivities=Array.from(
    progressActivities.reduce((items,item)=>items.set(item.id,item),new Map<string,ConversationActivity>()).values(),
  );
  const inputTime=latestUser?.timestamp&&(!latestUser.turn_id||latestUser.turn_id===liveTurn)
    ?Date.parse(latestUser.timestamp):NaN;
  const slotMessage=tailMessage&&isThinkingOnly(tailMessage)
    ? displayed.slice(0,displayed.indexOf(tailMessage)).reverse().find(message=>!isThinkingOnly(message)&&!isWaitingConversationInput(message))
    : tailMessage;
  const slotBoundary=slotMessage?.turn_id&&slotMessage.turn_id!==liveTurn?null:slotMessage?.id??null;
  const hiddenBoundaries=new Set(displayed.slice(tailMessage?displayed.indexOf(tailMessage)+1:0)
    .filter(message=>isEmptyProgress(message)&&message.turn_id===liveTurn).map(message=>message.id));
  const slotActivities=latestActivities.filter(item=>{
    if(item.turn_id&&item.turn_id!==liveTurn)return false;
    if(tailMessage?.id===resumedAfterRetry?.id&&resumedAfterRetry&&activityAfterRetry(item,resumedAfterRetry))return true;
    const startedAt=item.started_at?Date.parse(item.started_at):NaN;
    if(item.request_message_id&&item.status==='running'&&item.turn_id===liveTurn&&
      (!Number.isFinite(startedAt)||!Number.isFinite(inputTime)||startedAt>=inputTime))return true;
    if(Object.hasOwn(item,'after_message_id')){
      const anchor=item.after_message_id;
      if(anchor&&(anchor===slotBoundary||hiddenBoundaries.has(anchor)||
        anchor===tailMessage?.id&&tailMessage.turn_id===liveTurn))return true;
      // Tool-only assistant messages can be removed from snapshots while their activity keeps that message ID.
      const anchorMissing=!anchor||!messages.some(message=>message.id===anchor);
      if(anchorMissing&&item.turn_id&&item.turn_id===liveTurn){
        return !Number.isFinite(startedAt)||!Number.isFinite(inputTime)||startedAt>=inputTime;
      }
      return anchor===null&&(slotBoundary===null||slotMessage?.role==='user'&&!!slotMessage.timestamp&&
        startedAt>=Date.parse(slotMessage.timestamp));
    }
    // Older adapters can supply real timing instead of an explicit boundary.
    if(!tailMessage)return true;
    return !!tailMessage.timestamp&&startedAt>Date.parse(tailMessage.timestamp);
  });
  const latestSlotActivity=[...slotActivities].reverse().find(item=>item.status==='running')||slotActivities.at(-1);
  const showLiveProgress=canShowLiveProgress&&slotActivities.length>0;
  let pendingGroupId:string|null=null;
  if(showLiveProgress){
    if(tail?.kind==='progress'&&(!tailMessage?.turn_id||tailMessage.turn_id===liveTurn))pendingGroupId=tail.id;
    else {const id=`live-${liveTurn}-${tailMessage?.id||'start'}`;groups.splice(tailIndex+1,0,{kind:'progress',id,messages:[]});pendingGroupId=id;}
  }
  const progressTimingVisible=busy&&!reconnectable&&!ended&&!waiting&&!activeError&&!compaction.state&&(!!pendingGroupId||tail?.kind==='progress');
  const hideFooterExecutionStatus=liveState==='connected'&&!reconnectable&&!compaction.state&&(showLiveProgress||progressTimingVisible);
  const requestCount = (activities: ConversationActivity[]) => new Set(activities.flatMap(item => item.request_message_id ? [item.request_message_id] : [])).size;
  const observedTurnActivities = latestActivities.filter(item => item.request_message_id && item.turn_id === liveTurn &&
    (!Number.isFinite(inputTime) || !item.started_at || Date.parse(item.started_at) >= inputTime));
  const pendingHasPrevious=tail?.kind==='progress'&&!firstStepAfterInput;
  const recordedPending=pendingProgressStatistics(progressStatistics?.turn_id===liveTurn&&(!continuingAfterFollowup||tail?.kind==='progress'||!!pendingSegment)?progressStatistics:null,
    pendingHasPrevious?slotMessage?.statistics?.segment:undefined,pendingHasPrevious,slotMessage);
  const latestUsage=liveUsageQuery.data;
  const pendingLiveUsage=latestUsage&&latestUsage.native_id===agentNativeId(session)&&liveProgress.started_at&&
    Date.parse(latestUsage.observed_at)>=Date.parse(liveProgress.started_at)?latestUsage:null;
  const streamingIndex=displayed.findIndex(message=>message.id===streamingId);
  const streamingPrevious=streamingIndex>=0?displayed.slice(0,streamingIndex).filter(message=>!isWaitingConversationInput(message)).at(-1):undefined;
  const streamingStatistics=streamingIndex>=0&&progressStatistics?.turn_id===liveTurn&&progressStatistics?.revision==null?
    pendingProgressStatistics(progressStatistics,streamingPrevious?.statistics?.segment,streamingPrevious?.role==='assistant',streamingPrevious):null;
  useEffect(()=>{
    if(!pendingGroupId)return;
    if(!pinned.current){setUnread(true);return;}
    const frame=requestAnimationFrame(()=>{if(pinned.current)bottom.current?.scrollIntoView({block:'nearest'});});
    return ()=>cancelAnimationFrame(frame);
  },[pendingGroupId,liveProgress.activities]);
  const runningTool=progressActivities.find(item=>item.status==='running');
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
  const focusProgress=useRef({request:0,pages:0,done:false});
  const quoteRequest=useRef(0);
  const [quoteFocus,setQuoteFocus]=useState<{sessionId:string;target:ConversationFocus;previous?:ConversationFocus|null}|null>(null);
  const focusNativeId=agentNativeId(session)??page?.native_id;
  const focusedQuote=quoteFocus?.sessionId===session.id&&quoteFocus.previous===focusTarget&&quoteFocus.target.nativeId===focusNativeId
    ? quoteFocus.target : null;
  const messageFocus=focusedQuote??focusTarget;
  const jumpToQuote=useCallback((messageId:string)=>{
    if(!focusNativeId)return;
    setQuoteFocus({sessionId:session.id,previous:focusTarget,target:{nativeId:focusNativeId,messageId,requestId:--quoteRequest.current}});
  },[session.id,focusTarget,focusNativeId]);
  const [notificationFocusMissing,setNotificationFocusMissing]=useState(false);
  const focusVisible=useRef(onFocusTargetVisible);focusVisible.current=onFocusTargetVisible;
  const loadNotificationHistory=useRef(loadOlder);loadNotificationHistory.current=loadOlder;
  useConversationNotificationVisibility(readingRoot,session.id,agentNativeId(session),active,
    JSON.stringify([messages.map(m=>[m.id,m.phase]),requests.map(r=>r.id),pendingQuestion?.id,questionActive]));
  useEffect(()=>{
    const focusTarget=messageFocus;
    if(!active||!focusTarget||focusTarget.nativeId!==focusNativeId||loading)return;
    if(focusProgress.current.request!==focusTarget.requestId){
      focusProgress.current={request:focusTarget.requestId,pages:0,done:false};setNotificationFocusMissing(false);
      readingRoot.current?.querySelectorAll<HTMLElement>('[data-notification-focus]').forEach(node=>delete node.dataset.notificationFocus);
    }
    const progress=focusProgress.current;if(progress.done)return;
    const source=focusTarget.sourceId?.replace(/^question:/,'');
    const pending=pendingQuestions.find(message=>message.async_questions?.some(question=>question.id===source));
    if(pending&&(selectedQuestion!==pending.id||minimizedQuestion===pending.id)){
      setSelectedQuestion(pending.id);setMinimizedQuestion(null);return;
    }
    const node=[...(readingRoot.current?.querySelectorAll<HTMLElement>('[data-chat-message-id],[data-interaction-id]')||[])].find(node=>
      !!focusTarget.messageId&&(node.dataset.chatMessageId===focusTarget.messageId||node.dataset.interactionId===focusTarget.messageId)
      ||!!source&&JSON.parse(node.dataset.questionIds||'[]').includes(source));
    if(node){
      pinned.current=false;setNotificationFocusMissing(false);
      const frame=requestAnimationFrame(()=>{
        if(focusedQuote)node.closest<HTMLDetailsElement>('details:not([open])')?.setAttribute('open','');
        node.scrollIntoView({block:'center'});
        node.dataset.notificationFocus='true';progress.done=true;
        if(!focusedQuote)focusVisible.current?.();
      });
      return()=>cancelAnimationFrame(frame);
    }
    if(!older&&hasMore&&focusTarget.messageId&&!focusTarget.sourceId?.startsWith('interaction:')&&progress.pages<20){progress.pages++;void loadNotificationHistory.current();}
    else if(!older&&!pending&&!requests.some(request=>request.id===focusTarget.messageId))setNotificationFocusMissing(true);
  },[active,messageFocus,focusedQuote,loading,older,hasMore,messages,requests,pendingQuestions,selectedQuestion,minimizedQuestion,focusNativeId]);
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
      updateWaitingInputs(inputStorageKey,rows=>rows.filter(item=>item.client_id!==message.client_id));
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
  const retriesByTurn = new Map(Object.values(autoRetries).flatMap(retry =>
    retry.failed_turn_ids.map(turnId => [turnId, retry] as const),
  ));
  const retriesByMessage = new Map<string, ConversationRetry>();
  const assignedRetries = new Set<ConversationRetry>();
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (group.kind !== 'message' || group.message.phase !== 'error' || group.message.error?.will_retry) continue;
    const retry = retriesByTurn.get(group.message.turn_id ?? '');
    if (retry && !assignedRetries.has(retry)) {
      retriesByMessage.set(group.message.id, retry);
      assignedRetries.add(retry);
    }
  }
  const bubble = (
    message: ConversationMessage,
    compact = false,
    stableKey = message.id,
    beforeAnswer?: ReactNode,
  ) =>
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
        active={active}
        beforeAnswer={beforeAnswer}
        message={message.id===streamingId&&streamingStatistics?{...message,statistics:streamingStatistics}:message}
        streaming={message.id === streamingId}
        retrying={
          message.id === activeError?.id &&
          !!busy &&
          !!message.error?.will_retry
        }
        autoRetry={retriesByMessage.get(message.id)}
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
        showStatistics={!notificationView}
        durationLabel={timings.get(message.id)?.label}
        agent={sessionAgent(session)}
        agentName={agentName}
        projectPath={projectPath}
        projectId={session.project_id}
        onOpenFile={onOpenFile}
        onNavigate={navigate}
        onQuote={active&&canSend&&!ended&&!waiting&&!questionActive&&!sending&&!sendGuard.blocking?setDraftQuote:undefined}
        onQuoteJump={jumpToQuote}
        onRaw={onRaw}
        allowRaw={sessionAgent(session).sessionHost !== "managed"}
      />
    );
  const currentMetadata=metadata?.summary.native_id===(agentNativeId(session)??page?.native_id)?metadata:null;
  const dropsByMessage = new Map<string, SessionCacheDrop[]>();
  const compactionMessages = new Map(displayed.flatMap(message => message.presentation === 'compaction_summary' && message.timestamp
    ? [[Date.parse(message.timestamp), message.id] as const] : []));
  const visibleIds = new Set(groups.flatMap(group => group.kind === 'progress' ? group.messages.map(message => message.id) : [group.message.id]));
  const itemsByInput = new Map<string, ConversationMessage[]>();
  let inputId: string | undefined;
  for (const message of displayed) {
    if (isWaitingConversationInput(message) || !visibleIds.has(message.id)) continue;
    if (message.role === 'user') inputId = message.id;
    else if (inputId && message.presentation !== 'compaction_summary' && message.phase !== 'error') {
      const items = itemsByInput.get(inputId) ?? [];
      items.push(message);
      itemsByInput.set(inputId, items);
    }
  }
  const pendingCacheAnchor = pendingGroupId ? `pending-cache:${pendingGroupId}` : null;
  if (!notificationView) for (const drop of currentMetadata?.drops.values() ?? []) {
    const compact = drop.compaction_at ? compactionMessages.get(Date.parse(drop.compaction_at)) : undefined;
    const input = drop.current.input_id;
    const at = Date.parse(drop.current.request_at ?? drop.at);
    const items = input ? itemsByInput.get(input) ?? [] : [];
    const next = items.find(item => Date.parse(item.statistics?.item_at ?? item.timestamp ?? '') >= at);
    const pending = input === latestUser?.id ? pendingCacheAnchor : null;
    const owner = drop.message_id && visibleIds.has(drop.message_id) ? drop.message_id : null;
    const anchor = owner ?? compact ?? next?.id ?? pending ?? items.at(-1)?.id ?? input;
    if (!anchor) continue;
    const list = dropsByMessage.get(anchor) ?? [];
    list.push(drop);
    dropsByMessage.set(anchor, list);
  }
  const cacheNotices = (ids: string[]) => ids.flatMap(id => dropsByMessage.get(id) ?? [])
    .sort((left, right) => left.at.localeCompare(right.at))
    .map(drop => <ConversationCacheDrop key={drop.id} drop={drop}/>);
  return (
    <ConversationImagePreviewRoot active={active} onOpen={navigate}>
      <div className="session-chat-container" onKeyDownCapture={event=>{
        if(!active||event.key!=='Enter'||!(event.ctrlKey||event.metaKey)||event.nativeEvent.isComposing||document.querySelector('[aria-modal="true"]'))return;
        if(!(event.target instanceof HTMLElement)||event.target.closest('.session-chat-editor,input,textarea,select,[contenteditable],.session-batch-send'))return;
        event.preventDefault();event.stopPropagation();if(!event.repeat)submitWithShortcut();
      }}><div ref={chatLayout} className="session-chat-layout">
      <section ref={readingRoot} className="session-chat" aria-label="会话对话" data-session-id={session.id} data-presentation={presentation}>
        {notificationFocusMissing&&messageFocus&&<p className="session-pane-warning" role="status">{focusedQuote?'引用的原消息不在当前可读历史中。':'通知对应的消息不在当前可读历史中，可继续加载更早的对话核对。'}</p>}
        {(!notificationView||composerOptionsOpen)&&<ConversationPromptEnhancer
          sessionId={session.id}
          active={active}
          canEdit={canSend && !ended && !waiting && !sendGuard.blocking}
          value={draft}
          attachments={attachments.items}
          onApply={changeDraft}
        />}
        <div className="session-chat-reading">
          {active && canRead && contextEntries.length > 0 && <ConversationSessionContext
            key={`${session.id}:${page?.native_id ?? agentNativeId(session)}:${page?.generation}`}
            entries={contextEntries}
            projectPath={projectPath}
            projectId={session.project_id}
            onNavigate={navigate}
          />}
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
                if(group.kind === "message") {
                  const thinking = finalThinking(groups[groupIndex-1],group.message);
                  const message = withPrecedingThinking(group.message, thinking);
                  const notices = cacheNotices([...thinking.map(item => item.id), message.id]);
                  if (message.phase === 'final' && !message.async_questions?.length) {
                    return bubble(message, false, group.id, notices.length ? notices : undefined);
                  }
                  return notices.length ? <div key={group.id}>
                    {bubble(message,false,group.id)}
                    {notices}
                  </div> : bubble(message,false,group.id);
                }
                const last=[...group.messages].reverse().find(message=>!isThinkingOnly(message))??group.messages.at(-1),next=groups[groupIndex+1];
                const pending=group.id===pendingGroupId;
                const nextMessage=next?.kind==='message'?next.message:undefined;
                const final=nextMessage?.role==='assistant'&&nextMessage.phase==='final'&&!nextMessage.async_questions?.length?nextMessage:null;
                const scope=last?.statistics?.progress_id??group.messages.find(message=>message.statistics?.progress_id)?.statistics?.progress_id;
                const savedMessage=[...group.messages].reverse().find(message=>{
                  const segment=message.statistics?.segment;
                  return !!segment&&(!scope||segment.id===scope);
                });
                const finalSegment=final?.statistics?.segment;
                const saved=savedMessage?.statistics?.segment??
                  (finalSegment&&(scope?finalSegment.id===scope:!finalSegment.coverage)?finalSegment:undefined)??(pending?pendingSegment:null);
                const live=progressStatistics?.segment;
                const step=progressStatistics?.step;
                const activeGroup=busy&&(pending||tail===group);
                const savedScope=scope??saved?.id;
                const boundaryMatches=!step?.after_message_id||group.messages.some(message=>
                  message.id===step.after_message_id||(step.after_sequence!=null&&message.sequence===step.after_sequence));
                const liveIsCurrent=progressStatistics?.revision==null||progressStatistics.revision>=(savedMessage?.statistics?.revision??0);
                const liveMatches=progressStatistics?.turn_id===(last?.statistics?.turn_id||last?.turn_id||liveTurn)&&live&&
                  liveIsCurrent&&(activeGroup&&firstStepAfterInput|| (savedScope?live.id===savedScope&&boundaryMatches:last?step?.after_message_id===last.id||
                    step?.after_sequence!=null&&step.after_sequence===last.sequence:
                    !!pendingSegment||!continuingAfterFollowup));
                const part=activeGroup&&liveMatches?live:saved;
                const summarySegment=activeGroup&&liveMatches?live:savedMessage?undefined:saved??undefined;
                const groupedStatistics=progressGroupStatistics(group.messages,final,summarySegment,splitSegments.get(group.id));
                const activities = activeGroup ? observedTurnActivities.filter(item => !part?.start_at ||
                  !item.started_at || Date.parse(item.started_at) >= Date.parse(part.start_at)) : [];
                const summary=withObservedToolCounts(groupedStatistics?{...groupedStatistics,turn_id:last?.turn_id||liveTurn||'',sequence:0}:null,
                  activities.length || (pending ? slotActivities.length : 0),liveTurn||'',requestCount(activities));
                const execution=groupedStatistics?.segment?.unassigned;
                const executionStats=execution?{...execution,sequence:0,turn_id:last?.turn_id||liveTurn||'',interval:execution}:null;
                const finalParts=final ? finalThinking(group,final) : [];
                const messages=group.messages.slice(0,group.messages.length-finalParts.length);
                const {steps,trailing}=progressSteps(messages);
                const lastThought=trailing.at(-1);
                if (lastThought && !pending) {
                  steps.push({key:trailing[0].id,message:withPrecedingThinking(lastThought,trailing.slice(0,-1))});
                }
                const pendingThinking=pending ? progressThinking(trailing) : null;
                const showExecution=!pending&&!notificationView&&!!executionStats&&
                  (steps.length>0||!final||executionStats.tool_calls>0);
                if (!steps.length&&!pending&&!showExecution) return null;
                const notices = cacheNotices([
                  ...messages.map(message => message.id),
                  ...(pending && pendingCacheAnchor ? [pendingCacheAnchor] : []),
                ]);
                return (
                  <ProgressSection
                    key={`progress-${group.id}`}
                    cacheNotices={notices.length > 0 && <div className="session-chat-progress-cache-notices">{notices}</div>}
                    showStatistics={!notificationView}
                    agent={sessionAgent(session)}
                    agentName={agentName}
                    count={steps.length+Number(pending||showExecution)}
                    active={activeGroup}
                    timestamp={part?.last_request_at??part?.end_at??part?.start_at??
                      (last?.streaming?null:last?.timestamp)??(pending?liveProgress.started_at:null)}
                    stepDuration={progressTimingVisible&&(pending||tail===group)?stepDuration:null}
                    stepRunning={currentActivity?.status==='running'}
                    phaseSeconds={phaseSeconds}
                    progressPhase={progressPhase}
                    turnDuration={progressTimingVisible&&(pending||tail===group)?(part?.start_at?elapsedBetween(part.start_at,now):turnDuration):part?.elapsed_ms??null}
                    completed={part?part.end_reason==='completed':!!final}
                    interrupted={part?.end_reason==='interrupted'}
                    progressScope="segment"
                    progress={summary}
                  >
                    {steps.map(({key,message}, index) => (
                      <div
                        key={key}
                        className="session-chat-progress-entry"
                        data-active={message.id === streamingId}
                      >
                        <span
                          className="session-chat-progress-number"
                          aria-label={`进展序号 ${index + 1}`}
                        >
                          {index + 1}
                        </span>
                        {bubble(message, true, key)}
                      </div>
                    ))}
                    {pending&&<ConversationProgressPending number={steps.length+1} tool={latestSlotActivity}
                      thinking={pendingThinking && <ConversationThinking agentName={agentName} text={pendingThinking.body} previewText={pendingThinking.text}
                        streaming={lastThought?.id===streamingId}/>}
                      startedAt={tailMessage?.turn_id&&tailMessage.turn_id!==liveTurn?liveProgress.started_at:tailMessage?.timestamp||liveProgress.started_at}
                      statistics={withObservedToolCounts(recordedPending??(liveMatches?executionStats:null),slotActivities.length,liveTurn||'',requestCount(slotActivities))} liveUsage={pendingLiveUsage} now={now} connected={liveState==='connected'} showStatistics={!notificationView}/>}
                    {showExecution&&executionStats&&<div className="session-chat-progress-entry">
                      <span className="session-chat-progress-number" aria-label={`进展序号 ${steps.length+1}`}>{steps.length+1}</span>
                      <div className="session-chat-message-meta">
                        <span title={unassignedUsageDescription}>{unassignedUsageLabel}</span>
                        <ConversationStatisticsLabel interval statistics={executionStats}/>
                      </div>
                    </div>}
                  </ProgressSection>
                );
              })}
              {waitingForText && !showLiveProgress && (!continuingAfterFollowup || sending) && (
                <div className="session-chat-thinking" role="status">
                  <span aria-hidden="true" className="session-chat-thinking-icon"><AgentIcon session={{agent:sessionAgent(session)}} className="h-[13px] w-[13px]" /></span>
                  <div>
                    <div className="session-chat-thinking-summary"><span>
                      {continuingAfterFollowup
                        ? "Sending follow-up…"
                        : liveProgress.stage === "tools"
                          ? `${agentName} is working`
                          : `Waiting for ${agentName}`}
                    </span>
                    {!notificationView&&<time className="session-chat-elapsed" style={{color:timeColor(elapsed)}}>{elapsed}s</time>}
                    </div>
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
          {!notificationView&&<ConversationWidthHandles
            root={readingRoot}
            scroll={list}
            active={active}
            storageKey={`agentmanager-chat-width:${userId}`}
          />}
          {canRead && !notificationView && (
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
            {(requests.some(request=>request.id===focusTarget?.messageId)?requests.filter(request=>request.id===focusTarget?.messageId):requests.slice(0, 1)).map((request) => (
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
          <div className="session-chat-status" role="status" hidden={notificationView&&liveState==='connected'&&!ended&&!reconnectable&&!compaction.state}>
            <div className="session-chat-execution-status" hidden={hideFooterExecutionStatus}>
            <span
              className={`session-chat-connection ${liveState}`}
              data-attention={!!pendingQuestion || waiting}
              aria-hidden="true"
            />
            {pausedForMemory ? <span>内存压力过高，会话已暂停</span> : compaction.state ? (
              <ConversationCompactionStatus
                state={compaction.state}
                now={now}
              />
            ) : (
              <ConversationActivityLine
                key={`${session.id}:${liveState}:${liveProgress.turn_id || ""}`}
                activities={[]}
                busy={activityRunning}
                now={now}
                totalElapsed={turnDuration}
                hideTiming={progressTimingVisible||showLiveProgress}
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
            </div>
            {observingStream && liveState === "connected" && (
              <span className="session-chat-live-label" data-state="connected">Event stream connected</span>
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
          {sendGuard.notice}
          {stopError&&<p role="alert" className="session-chat-error">{stopError}</p>}
          {composer.briefContext&&<div className="session-chat-guard-status" role="status"><span>简要历史已保留，将与原草稿一起发送。</span><button type="button" disabled={sending||sendGuard.blocking} onClick={()=>persistComposer({briefContext:undefined})}>移除简要历史</button></div>}
          {sendError && (
            <p role="alert" className="session-chat-error">
              {sendError}
            </p>
          )}
          {failedDrafts.map((saved) => (
            <div key={saved.clientId} className="session-chat-error">
              <p>
                未发送内容已保留：{saved.text.slice(0, 120)}
                {saved.quote && '（含引用）'}
                {saved.attachments.length > 0 &&
                  `（${saved.attachments.length} 个附件）`}
              </p>
              <button
                type="button"
                disabled={sending || !!draft || !!composer.draftQuote || attachments.items.length > 0}
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
                  canAttach && canSend && !ended && !sending && !sendGuard.blocking ? "copy" : "none";
              }
            }}
            onDrop={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files"))
                return;
              event.preventDefault();
              event.stopPropagation();
              if (canAttach && canSend && !ended && !sending && !sendGuard.blocking)
                attachments.enqueueTransfer(event.dataTransfer);
            }}
          >
            {composer.draftQuote&&<ConversationQuote quote={composer.draftQuote} agentName={agentName} onRemove={()=>setDraftQuote()}/>}
            <ConversationComposerEditor
              snapshotRef={attachmentPositions}
              value={draft}
              items={attachments.items}
              disabled={!canSend || ended || waiting || sendGuard.blocking}
              placeholder={
                waiting
                  ? "请先处理上方交互"
                  : composer.mode==='batch'?"输入消息，Enter 加入批量，Ctrl+Enter 发送（空输入发送待发批次），Shift+Enter 换行":"输入消息，Enter 发送，Shift+Enter 换行"
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
              onDirectSubmit={submitWithShortcut}
              onSubmit={() => {if(composer.mode==='batch')stageBatch();else void send();}}
            />
            {attachments.error && (
              <p role="alert" className="session-chat-error">
                {attachments.error}
              </p>
            )}

            <div className="session-chat-input-tools">
              <ConversationAttachmentPicker
                disabled={!canAttach || !canSend || ended || sending || sendGuard.blocking}
                onFiles={attachments.enqueue}
              />
              {notificationView&&<button type="button" className="session-chat-more" aria-label="更多回复选项" aria-expanded={composerOptionsOpen} aria-controls={`notification-composer-options-${session.id}`} onClick={()=>setComposerOptionsOpen(value=>!value)}>{composer.mode==='batch'?'批量 · 更多':'更多'}<ChevronDown size={12}/></button>}
              {(!notificationView||composerOptionsOpen)&&<div id={`notification-composer-options-${session.id}`} className="session-chat-controls-slot conversation-toolbar"><label className="conversation-control-select conversation-composer-mode"><span>模式</span><select aria-label="发送模式" value={composer.mode} disabled={sending||sendGuard.blocking||!!composer.pending} onChange={e=>persistComposer({mode:e.target.value as ComposerState['mode']})}><option value="immediate">立即发送</option><option value="batch">批量发送</option></select><ChevronDown size={12}/></label><div ref={setToolbarTarget}/></div>}
              {!sending&&!sendGuard.checking&&<span className="session-chat-send-hint">{resuming?'会话连接后可以发送':composer.mode==='batch'?'Enter 加入批量 · Ctrl+Enter 发送':'Enter 发送 · Shift+Enter 换行'}</span>}
              <div className="session-chat-send-actions" data-pending={sending||sendGuard.checking||undefined}>
                {composer.mode!=='batch'&&(sending||sendGuard.checking)&&<span className="session-chat-send-status" role="status">
                  {sendGuard.checking?'检查中…':'正在发送…'}
                </span>}
                {(!notificationView||composerOptionsOpen)&&<button
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
                </button>}
                {!questionActive&&stopButton}
                <button
                  type="submit"
                  aria-label={composer.mode==='batch'?'加入批量':'发送消息'}
                  disabled={
                    sending || sendGuard.blocking ||
                    (resuming && composer.mode!=='batch') ||
                    attachments.uploading ||
                    attachments.failed ||
                    !canSend ||
                    (!draft.trim() && !attachments.items.length) ||
                    !page?.session_active ||
                    ended ||
                    waiting
                  }
                >
                  {sending || sendGuard.checking ? (
                    <Loader2 size={17} className="animate-spin" />
                  ) : (
                    <ArrowUp size={18} />
                  )}
                </button>
              </div>
            </div>
          </form>
          {(!notificationView||composerOptionsOpen) && agentSupports(session, "controls") &&
            !!page?.native_id &&
            canRead && (
              <ConversationControls
                toolbarTarget={toolbarTarget}
                sessionId={session.id}
                active={active}
                busy={busy || sending || resuming || sendGuard.blocking}
                replacing={resuming || sendGuard.blocking}
                compacting={compaction.running}
                onCompact={compaction.start}
                onBrief={onNewConversation?()=>{
                  if(composerRef.current.value.mode==='batch'&&!draftRef.current.trim()&&!attachments.hasDraft()&&composerRef.current.value.entries.length)void sendBatch(true);
                  else void send(undefined,[],false,true);
                }:undefined}
                briefDisabled={!canSend||!page?.session_active||ended||waiting||attachments.uploading||attachments.failed||!!composer.pending||!!composer.briefContext}
                onNewConversation={onNewConversation}
                metadata={currentMetadata?.summary}
              />
            )}
        </footer>
      </section>
        {composer.mode==='batch'&&(composer.entries.length>0||composer.pending)&&<aside className="session-chat-batch" aria-label="批量待发内容">
          <ConversationBatchResizeHandle layout={chatLayout} active={active} storageKey={`agentmanager-batch-width:${userId}`}/>
          <header className="session-batch-header"><span>批量待发</span><small>{composer.entries.length} 条</small></header>
          <div className="session-chat-batch-content">
            {composer.entries.length?composer.entries.map((entry,index)=>{
              const {quote,text,attachments:items}=splitQuotedInput(entry.text,entry.attachments);
              return <article key={entry.id}>
                <header><small>消息 {index+1}</small><time dateTime={entry.createdAt} title="加入待发区时间">{formatDisplayTimestamp(entry.createdAt)}</time>
                  <button type="button" className="session-batch-recall" aria-label={`撤回第 ${index+1} 条消息`} disabled={!canSend||sending||sendGuard.blocking||!!composer.pending?.entryIds.includes(entry.id)||attachments.uploading||attachments.failed} onClick={()=>recallBatch(entry)}>撤回</button>
                  <button type="button" className="session-batch-delete" aria-label={`删除第 ${index+1} 条消息`} disabled={!canSend||sending||sendGuard.blocking||!!composer.pending?.entryIds.includes(entry.id)} onClick={()=>deleteBatch(entry)}>删除</button>
                </header>
                {quote&&<ConversationQuote quote={quote} agentName={agentName} onJump={jumpToQuote}/>}
                <ConversationMessageAttachments text={text} items={items} projectId={session.project_id} projectPath={projectPath} onOpenFile={onOpenFile}/>
              </article>;
            }):<div className="session-batch-empty"><span>暂未添加消息</span><p>在输入框编写内容，按 Enter 加入这里，整理完成后一起发送。</p></div>}
          </div>
          {composer.pending&&<p role="status">发送结果待确认。恢复连接后自动核对，请勿重复发送。</p>}
          <footer className="session-batch-footer"><button type="button" className="session-batch-send" aria-label="发送批量内容" aria-keyshortcuts="Control+Enter Meta+Enter" onKeyDown={event=>{if(active&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){event.preventDefault();if(!event.repeat)void sendBatch();}}} onClick={()=>void sendBatch()} disabled={!composer.entries.length||!!composer.pending||sending||resuming||sendGuard.blocking||!canSend||!page?.session_active||ended||waiting}>{sending||sendGuard.checking?<Loader2 size={15} className="animate-spin"/>:<ArrowUp size={15}/>}<span>{sendGuard.checking?'检查中…':sending?'正在发送…':'发送批量内容'}</span><kbd title="输入框为空时使用">Ctrl ↵</kbd></button></footer>
        </aside>}
      </div></div>
      {sendGuard.dialog}
    </ConversationImagePreviewRoot>
  );
}
