import { getAgent, agentContext, agentForSession } from "./agents/index.js";
import {
  type ConversationAsyncQuestion,
  type ConversationQuestionReply,
} from "./conversation-interactions.js";
import { open } from "fs/promises";
import { createHash } from "crypto";
import {
  nativeConversationFile,
  type PromptContextSession,
} from "./prompt-context.js";
import type { CliType } from "./session-identity.js";
import { type ConversationAttachment } from "./conversation-attachments.js";

import type { AgentStatistics as ConversationStatistics } from "./agents/types.js";

export type ConversationMessage = import("./agents/types.js").AgentMessage;

interface IndexedMessage extends Omit<ConversationMessage, "phase"> {
  offset: number;
  order: number;
  length: number;
  recordType: string;
  nativeItem: boolean;
  itemId?: string;
  declaredTurnId?: string;
  questionSignature?: string;
  questionCallId?: string;
  projectionIndex?: number;
  resetBefore?: boolean;
  sourceRole?: "tool_result";
  toolResult?: { toolUseId: string; result: string; failed: boolean };
  phase?: "unknown" | "commentary" | "final" | "error";
}
interface NativeQuestionCall {
  offset: number;
  id: string;
  turnId?: string;
  signature: string;
}
interface TurnBoundary {
  offset: number;
  kind: "start" | "end";
  turnId: string;
}
function questionSignature(questions: ConversationAsyncQuestion[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        questions.map((q) => ({ title: q.title, options: q.options })),
      ),
    )
    .digest("hex");
}
interface Index {
  inode: number;
  mtime: number;
  start: number;
  offset: number;
  partial: Buffer;
  messages: IndexedMessage[];
  generation: string;
  skipPartial: boolean;
  anchor: Buffer;
  questionCalls: NativeQuestionCall[];
  turnBoundaries: TurnBoundary[];
}
const WINDOW = 2 * 1024 * 1024;
const MAX_RECORD = 512 * 1024;
const MAX_INPUT_RECORD = 16 * 1024 * 1024;
function recordLimit(buffer: Buffer, kind: CliType) {
  return getAgent(kind).history.file!.recordLimit(buffer);
}
async function previousWindow(
  handle: Awaited<ReturnType<typeof open>>,
  end: number,
) {
  let length = Math.min(WINDOW, end);
  while (true) {
    const start = Math.max(0, end - length),
      buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    const newline = buffer.indexOf(10),
      skip = start ? newline + 1 : 0;
    if (
      start === 0 ||
      (newline >= 0 && newline < buffer.length - 1) ||
      length >= MAX_INPUT_RECORD + WINDOW
    )
      return {
        start,
        buffer,
        skip,
        nextStart: start + (skip >= buffer.length ? 0 : skip),
      };
    length = Math.min(MAX_INPUT_RECORD + WINDOW, length + WINDOW, end);
  }
}
const indexes = new Map<string, Index>();
const locks = new Map<string, Promise<unknown>>();

export function conversationMessageId(
  turnId: string,
  role: string,
  itemId?: string,
) {
  // Native item IDs are stable across the live protocol and the durable
  // transcript. Turn IDs are not: a provider can expose different container
  // IDs for the same item in those two channels.
  return createHash("sha256")
    .update(itemId ? `item:${role}:${itemId}` : `turn:${turnId}:${role}`)
    .digest("hex")
    .slice(0, 32);
}

function publicMessage(
  line: Buffer,
  kind: CliType,
  questionCallId?: string,
  projectionIndex?: number,
) {
  return getAgent(kind).history.file!.project(line, questionCallId, {
    replacementIndex: projectionIndex,
  });
}

function scan(
  buffer: Buffer,
  base: number,
  kind: CliType,
  questionCalls: NativeQuestionCall[],
  turnBoundaries: TurnBoundary[],
  context?: { nativeId?: string | null },
): IndexedMessage[] {
  const result: IndexedMessage[] = [],
    codec = getAgent(kind).history.file!;
  const addProjection = (
    record: Buffer,
    offset: number,
    length: number,
    projectionIndex?: number,
    order = offset,
    resetBefore = false,
  ) => {
    const parsed = codec.project(record, undefined, {
      ...context,
      ...(projectionIndex === undefined
        ? {}
        : { replacementIndex: projectionIndex }),
    });
    if (!parsed) return false;
    const { message, failure, recordType, turnId, itemId, clientId } = parsed;
    const id =
      failure?.id ||
      (itemId
        ? conversationMessageId("", message.role, itemId)
        : turnId && message.role === "assistant"
          ? conversationMessageId(
              turnId,
              message.role,
              recordType === "completion_echo" ? undefined : String(offset),
            )
          : createHash("sha256")
              .update(`${offset}:${message.role}`)
              .digest("hex")
              .slice(0, 32));
    const compacted =
      parsed.compaction && parsed.compaction.after_tokens === null
        ? {
            ...parsed.compaction,
            after_tokens:
              tokenCounts.find((item) => item.offset > offset)?.tokens ?? null,
          }
        : parsed.compaction;
    result.push({
      id,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      turn_id: turnId,
      ...(clientId ? { client_id: clientId } : {}),
      ...(parsed.contentBlocks?.length
        ? { content_blocks: parsed.contentBlocks }
        : {}),
      ...(message.role === "assistant"
        ? {
            phase:
              message.phase === "error"
                ? ("error" as const)
                : message.phase === "final"
                  ? ("final" as const)
                  : message.phase === "commentary"
                    ? ("commentary" as const)
                    : ("unknown" as const),
          }
        : {}),
      ...(failure ? { error: failure.error } : {}),
      offset,
      order,
      length,
      recordType,
      nativeItem: !!itemId,
      itemId,
      declaredTurnId: turnId,
      sourceRole: parsed.sourceRole,
      toolResult: parsed.toolResult,
      ...(parsed.presentation ? { presentation: parsed.presentation } : {}),
      ...(compacted ? { compaction: compacted } : {}),
      ...(parsed.asyncQuestions
        ? { questionSignature: questionSignature(parsed.asyncQuestions) }
        : {}),
      ...(projectionIndex === undefined ? {} : { projectionIndex }),
      ...(resetBefore ? { resetBefore: true } : {}),
    });
    return true;
  };
  const tokenCounts: Array<{ offset: number; tokens: number }> = [];
  for (let cursor = 0; cursor < buffer.length;) {
    const end = buffer.indexOf(10, cursor);
    if (end < 0) break;
    const record = buffer.subarray(cursor, end);
    if (
      /"type"\s*:\s*"token_count"/.test(
        record.subarray(0, 400).toString("utf8"),
      )
    ) {
      try {
        const entry = JSON.parse(record.toString("utf8")),
          value = entry.payload?.info?.last_token_usage?.total_tokens;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          tokenCounts.push({ offset: base + cursor, tokens: value });
      } catch {
        /* Ignore malformed telemetry records. */
      }
    }
    cursor = end + 1;
  }
  const boundaryOffsets = new Set(turnBoundaries.map((item) => item.offset));
  let start = 0;
  for (
    let end = buffer.indexOf(10);
    end >= 0;
    end = buffer.indexOf(10, start)
  ) {
    const record = buffer.subarray(start, end);
    const boundary = codec.turnBoundary?.(record);
    if (boundary && !boundaryOffsets.has(base + start)) {
      turnBoundaries.push({ ...boundary, offset: base + start });
      boundaryOffsets.add(base + start);
    }
    // Older native rollouts put async metadata on agent_message without an ID.
    // Bind it to the actual preceding request call, never infer from prose or
    // parse quoted tool results as interactive input.
    const call = codec.questionCall(record);
    if (call && !questionCalls.some((item) => item.offset === base + start))
      questionCalls.push({ ...call, offset: base + start });
    const offset = base + start,
      length = end - start;
    const replacements = codec.replacementHistory?.(record);
    if (replacements) {
      const projected: IndexedMessage[] = [];
      for (const [
        replacementOrder,
        replacementIndex,
      ] of replacements.entries()) {
        const previousLength = result.length;
        addProjection(
          record,
          offset,
          length,
          replacementIndex,
          offset + (replacementOrder + 1) / (replacements.length + 1),
          false,
        );
        if (result.length > previousLength) {
          const item = result.pop()!;
          if (item.presentation === "compaction_summary") projected.push(item);
        }
      }
      const hasSummary = projected.some(
        (message) => message.presentation === "compaction_summary",
      );
      let fallback: IndexedMessage | undefined;
      if (!hasSummary) {
        if (addProjection(record, offset, length, undefined, offset + 1))
          fallback = result.pop();
      }
      result.push(...projected);
      if (fallback) result.push(fallback);
      start = end + 1;
      continue;
    }
    addProjection(record, offset, length);
    start = end + 1;
  }
  return result;
}
function appendScanned(
  messages: IndexedMessage[],
  scanned: IndexedMessage[],
  resetOld: boolean,
) {
  const resetAt = scanned.findIndex((message) => message.resetBefore);
  if (resetOld && resetAt >= 0) messages.length = 0;
  for (const message of scanned) {
    delete message.resetBefore;
    messages.push(message);
  }
}
function projectToolResults(messages: IndexedMessage[]): IndexedMessage[] {
  const visible = messages.filter(
    (message) => message.sourceRole !== "tool_result",
  );
  const results = new Map<string, { result: string; failed: boolean }>();
  for (const message of messages) {
    if (message.sourceRole !== "tool_result") continue;
    if (message.toolResult)
      results.set(message.toolResult.toolUseId, {
        result: message.toolResult.result,
        failed: message.toolResult.failed,
      });
  }
  if (!results.size) return visible;
  return visible.map((message) =>
    message.content_blocks?.some((block) => block.type === "tool_use")
      ? {
          ...message,
          content_blocks: message.content_blocks.map((block) => {
            if (block.type !== "tool_use") return block;
            const result = results.get(block.id);
            if (!result) return block;
            return {
              ...block,
              status: result.failed
                ? ("failed" as const)
                : ("completed" as const),
              result: result.result,
              ...(result.failed ? { is_error: true } : {}),
            };
          }),
        }
      : message,
  );
}
function compactTurnMessages(messages: IndexedMessage[]): IndexedMessage[] {
  const result: IndexedMessage[] = [];
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.recordType === "native_message" &&
      message.content_blocks?.length
    ) {
      const previous = result.at(-1);
      if (
        previous?.role === "assistant" &&
        previous.recordType === "native_message" &&
        (!previous.turn_id ||
          !message.turn_id ||
          previous.turn_id === message.turn_id)
      ) {
        previous.text = "";
        previous.content_blocks = [
          ...(previous.content_blocks || []),
          ...message.content_blocks.map((block, index) => ({
            ...block,
            index: (previous.content_blocks?.length || 0) + index,
          })),
        ];
        previous.phase = message.phase;
        previous.timestamp = message.timestamp;
        continue;
      }
    }
    result.push(message);
  }
  return result;
}
function bindTurnBoundaries(
  messages: IndexedMessage[],
  boundaries: TurnBoundary[],
) {
  boundaries.sort((a, b) => a.offset - b.offset);
  let cursor = 0,
    active: string | undefined;
  for (const message of messages) {
    if (message.sourceRole === "tool_result") continue;
    if (
      message.presentation === "compaction_summary" ||
      message.projectionIndex !== undefined
    )
      continue;
    while (
      cursor < boundaries.length &&
      boundaries[cursor].offset < message.offset
    ) {
      const boundary = boundaries[cursor++];
      active = boundary.kind === "start" ? boundary.turnId : undefined;
    }
    while (
      cursor < boundaries.length &&
      boundaries[cursor].offset === message.offset &&
      boundaries[cursor].kind === "start"
    )
      active = boundaries[cursor++].turnId;
    // A bounded cold window may start inside a completed turn. Its closing
    // boundary still identifies that prefix without reading the whole rollout.
    const next = boundaries[cursor];
    const canonical =
      active ||
      message.declaredTurnId ||
      (next?.kind === "end" ? next.turnId : undefined);
    if (canonical && message.turn_id !== canonical) {
      message.turn_id = canonical;
      if (
        message.phase !== "error" &&
        (message.role === "assistant" || message.itemId)
      )
        message.id = conversationMessageId(
          canonical,
          message.role,
          message.questionCallId ||
            message.itemId ||
            (message.recordType === "completion_echo"
              ? undefined
              : String(message.offset)),
        );
    }
    while (
      cursor < boundaries.length &&
      boundaries[cursor].offset === message.offset
    ) {
      const boundary = boundaries[cursor++];
      active = boundary.kind === "start" ? boundary.turnId : undefined;
    }
  }
  return messages;
}
function bindQuestionCalls(
  messages: IndexedMessage[],
  calls: NativeQuestionCall[],
) {
  calls.sort((a, b) => a.offset - b.offset);
  for (const message of messages) {
    if (!message.questionSignature || message.nativeItem) continue;
    let source: NativeQuestionCall | undefined;
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (
        call.offset < message.offset &&
        call.signature === message.questionSignature &&
        (!message.turn_id || !call.turnId || message.turn_id === call.turnId)
      ) {
        source = call;
        break;
      }
    }
    if (source) {
      message.questionCallId = source.id;
      message.turn_id ||= source.turnId;
      message.id = conversationMessageId(
        message.turn_id || "async",
        message.role,
        source.id,
      );
      message.nativeItem = true;
    }
  }
  return messages;
}
function dedupe(messages: IndexedMessage[]): IndexedMessage[] {
  const result: IndexedMessage[] = [];
  const indexes = new Map<string, number>();
  const priority = (message: IndexedMessage) =>
    message.recordType === "compaction_summary"
      ? 7
      : message.recordType === "async_question"
        ? 6
        : message.recordType === "shared_context"
          ? 5
          : message.recordType === "event_user_item"
            ? 4
            : message.recordType === "native_message"
              ? 3
              : message.recordType === "event_message"
                ? 2
                : 1;
  for (const message of messages) {
    if (message.sourceRole === "tool_result") {
      result.push(message);
      continue;
    }
    if (message.phase === "error") {
      const existing = indexes.get(message.id);
      if (existing === undefined) {
        indexes.set(message.id, result.length);
        result.push(message);
      } else result[existing] = message;
      continue;
    }
    const existing = indexes.get(message.id);
    if (existing === undefined) {
      indexes.set(message.id, result.length);
      result.push(message);
    } else if (priority(message) >= priority(result[existing]))
      result[existing] = message;
  }

  const turns: IndexedMessage[][] = [];
  let turn: IndexedMessage[] = [];
  let hasAssistant = false;
  for (const message of result) {
    if (!turn.length || (message.role === "user" && hasAssistant)) {
      turn = [];
      turns.push(turn);
      hasAssistant = false;
    }
    turn.push(message);
    if (message.role === "assistant") hasAssistant = true;
  }
  const omit = new Set<IndexedMessage>();
  for (const turn of turns) {
    // Codex can persist the same user item as a response_item and later as an
    // item_completed event with a different native ID. Pair only exact records
    // from the same turn, in order and within two seconds, one for one.
    // Retain the first public ID so incremental readers can reconcile it.
    const nativeUsers=turn.filter(message=>message.role==='user'&&message.recordType==='native_message');
    const matched=new Set<IndexedMessage>();
    for(const event of turn.filter(message=>message.role==='user'&&message.recordType==='event_user_item')){
      const native=[...nativeUsers].reverse().find(item=>{
        const elapsed=Date.parse(event.timestamp||'')-Date.parse(item.timestamp||'');
        return !matched.has(item)&&item.offset<event.offset&&elapsed>=0&&elapsed<=2000&&item.turn_id===event.turn_id&&item.text===event.text;
      });
      if(!native)continue;
      matched.add(native);native.client_id ||= event.client_id;
      if(!native.image_paths?.length&&event.image_paths?.length)native.image_paths=event.image_paths;
      omit.add(event);
    }
    const completed = turn.some(
      (message) =>
        message.recordType === "completion_echo" && message.phase !== "error",
    );
    const questions = turn.filter(
      (message) => message.recordType === "async_question",
    );
    if (questions.length) {
      const firstQuestion = turn.indexOf(questions[0]);
      for (const message of turn) {
        if (
          message.role !== "assistant" ||
          message.recordType === "async_question" ||
          message.phase === "error"
        )
          continue;
        if (
          completed ||
          (message.recordType === "event_message" &&
            turn.indexOf(message) < firstQuestion)
        )
          omit.add(message);
      }
      continue;
    }
    for (const role of ["user", "assistant"] as const) {
      const native = turn.filter(
        (message) =>
          message.role === role && message.recordType === "native_message",
      );
      const events = turn.filter(
        (message) =>
          message.role === role &&
          (message.recordType === "event_message" ||
            (role === "user" && message.recordType === "event_user_item")),
      );
      if (native.length)
        for (const message of events) {
          if (role === "user") {
            if (message.recordType !== "event_user_item") omit.add(message);
          } else if (
            message.phase !== "commentary" ||
            native.some((item) => item.phase === "commentary")
          )
            omit.add(message);
        }
      if (role === "assistant" && completed) {
        const authoritative = native.length ? native : events;
        if (authoritative.length) {
          for (const message of turn)
            if (
              message.recordType === "completion_echo" &&
              message.phase !== "error"
            )
              omit.add(message);
          const last = authoritative.at(-1)!;
          if (last.phase === "unknown") last.phase = "final";
        }
      }
    }
  }
  return result.filter((message) => !omit.has(message));
}

/** A bounded incremental byte index. Cached metadata never contains message
 * bodies or tool output; only the requested page's public text is read. */
export async function readConversation(
  session: PromptContextSession,
  query: { after?: string; before?: string; limit?: number } = {},
) {
  const nativePage = await agentForSession(session).history.read(
    agentContext(session),
    query,
  );
  if (nativePage) return nativePage;
  const file = await nativeConversationFile(session);
  const empty = {
    messages: [] as ConversationMessage[],
    statistics: [] as ConversationStatistics[],
    has_more: false,
    reset: false,
    available: false,
    generation: null as string | null,
  };
  if (!file) return empty;
  const previous = locks.get(file.path) || Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      const handle = await open(file.path, "r");
      try {
        const stats = await handle.stat();
        let index = indexes.get(file.path);
        let reset = false;
        if (index && index.offset > 0 && stats.size >= index.offset) {
          const anchor = Buffer.alloc(index.anchor.length);
          await handle.read(
            anchor,
            0,
            anchor.length,
            index.offset - anchor.length,
          );
          if (!anchor.equals(index.anchor)) {
            index = undefined;
            reset = true;
          }
        }
        if (
          !index ||
          index.inode !== stats.ino ||
          stats.size < index.offset ||
          (stats.size === index.offset && stats.mtimeMs !== index.mtime)
        ) {
          reset ||= !!index;
          const { start, buffer, skip, nextStart } = await previousWindow(
            handle,
            stats.size,
          );
          const data = buffer.subarray(skip);
          const end = data.lastIndexOf(10) + 1;
          const questionCalls: NativeQuestionCall[] = [],
            turnBoundaries: TurnBoundary[] = [];
          const messages = scan(
            data.subarray(0, end),
            start + skip,
            file.kind,
            questionCalls,
            turnBoundaries,
            agentContext(session),
          );
          for (const message of messages) delete message.resetBefore;
          index = {
            inode: stats.ino,
            mtime: stats.mtimeMs,
            start: nextStart,
            offset: stats.size,
            partial: Buffer.from(data.subarray(end)),
            messages,
            generation: `${stats.ino}:${stats.birthtimeMs}`,
            skipPartial: false,
            anchor: Buffer.alloc(0),
            questionCalls,
            turnBoundaries,
          };
          if (index.partial.length > recordLimit(index.partial, file.kind)) {
            index.partial = Buffer.alloc(0);
            index.skipPartial = true;
          }
          if (indexes.size >= 32 && !indexes.has(file.path))
            indexes.delete(indexes.keys().next().value!);
          indexes.set(file.path, index);
        } else if (stats.size > index.offset) {
          // Read append-only output in small chunks, dropping oversized tool lines.
          while (index.offset < stats.size) {
            const length = Math.min(WINDOW, stats.size - index.offset);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(
              buffer,
              0,
              length,
              index.offset,
            );
            if (!bytesRead) break;
            let data = Buffer.concat([
              index.partial,
              buffer.subarray(0, bytesRead),
            ]);
            let base = index.offset - index.partial.length;
            if (index.skipPartial) {
              const newline = data.indexOf(10);
              if (newline < 0) {
                index.partial = Buffer.alloc(0);
                index.offset += bytesRead;
                continue;
              }
              base += newline + 1;
              data = data.subarray(newline + 1);
              index.skipPartial = false;
            }
            const end = data.lastIndexOf(10) + 1;
            appendScanned(
              index.messages,
              scan(
                data.subarray(0, end),
                base,
                file.kind,
                index.questionCalls,
                index.turnBoundaries,
                agentContext(session),
              ),
              true,
            );
            index.partial = Buffer.from(data.subarray(end));
            if (index.partial.length > recordLimit(index.partial, file.kind)) {
              index.partial = Buffer.alloc(0);
              index.skipPartial = true;
            }
            index.offset += bytesRead;
          }
          index.mtime = stats.mtimeMs;
        }
        index.anchor = Buffer.alloc(Math.min(128, index.offset));
        await handle.read(
          index.anchor,
          0,
          index.anchor.length,
          index.offset - index.anchor.length,
        );
        const bind = (messages: IndexedMessage[]) =>
          compactTurnMessages(
            projectToolResults(
              dedupe(
                bindQuestionCalls(
                  bindTurnBoundaries(messages, index!.turnBoundaries),
                  index!.questionCalls,
                ),
              ),
            ),
          );
        index.messages = bind(index.messages);
        const prependWindow = async () => {
          const { start, buffer, skip, nextStart } = await previousWindow(
            handle,
            index!.start,
          );
          const older = scan(
            buffer.subarray(skip),
            start + skip,
            file.kind,
            index!.questionCalls,
            index!.turnBoundaries,
            agentContext(session),
          );
          for (const message of older) delete message.resetBefore;
          index!.messages = bind([...older, ...index!.messages]);
          index!.start = nextStart;
        };
        // A cold window can begin between an async request and its message.
        // Fetch the preceding window before exposing a question without its ID.
        for (
          let scan = 0;
          index.start > 0 &&
          scan < 2 &&
          index.messages
            .slice(-80)
            .some(
              (message) => message.questionSignature && !message.nativeItem,
            );
          scan++
        )
          await prependWindow();
        // A large trailing tool result must not hide the last real conversation.
        // Bound cold discovery; older pages can continue backwards on demand.
        const limit = Math.max(1, Math.min(80, query.limit || 40));
        for (
          let scan = 0;
          index.messages.length < limit && index.start > 0 && scan < 4;
          scan++
        )
          await prependWindow();
        let before = query.before
          ? index.messages.findIndex((message) => message.id === query.before)
          : index.messages.length;
        // Older pages expand the index backwards only on explicit demand.
        if (query.before && before < limit && index.start > 0) {
          await prependWindow();
          before = index.messages.findIndex(
            (message) => message.id === query.before,
          );
        }
        let selected: IndexedMessage[];
        if (before < 0) {
          before = index.messages.length;
          reset = true;
        }
        if (query.after && !reset) {
          const after = index.messages.findIndex(
            (message) => message.id === query.after,
          );
          reset ||= after < 0;
          selected =
            after < 0
              ? index.messages.slice(-limit)
              : index.messages.slice(after + 1, after + 1 + limit);
        } else {
          selected = index.messages.slice(
            Math.max(0, before - limit),
            before < 0 ? undefined : before,
          );
        }
        const messages: ConversationMessage[] = [];
        const statistics = await getAgent(file.kind)
          .statistics.read(agentContext(session), file.path)
          .catch(() => []);
        const byOffset = new Map(
          statistics.map((item) => [item.sequence, item]),
        );
        let sourceOffset = -1,
          sourceBuffer: Buffer | undefined;
        for (const item of selected) {
          if (sourceOffset !== item.offset) {
            sourceBuffer = Buffer.alloc(item.length);
            await handle.read(
              sourceBuffer,
              0,
              sourceBuffer.length,
              item.offset,
            );
            sourceOffset = item.offset;
          }
          const buffer = sourceBuffer!;
          const parsed = publicMessage(
            buffer,
            file.kind,
            item.questionCallId,
            item.projectionIndex,
          );
          if (parsed)
            messages.push({
              id: item.id,
              role: item.role,
              text: parsed.message.text,
              timestamp: item.timestamp,
              turn_id: item.turn_id,
              ...(item.client_id ? { client_id: item.client_id } : {}),
              ...(item.content_blocks?.length
                ? { content_blocks: item.content_blocks }
                : parsed.contentBlocks?.length
                  ? { content_blocks: parsed.contentBlocks }
                  : {}),
              phase: item.phase === "unknown" ? "commentary" : item.phase,
              ...(parsed.presentation
                ? { presentation: parsed.presentation }
                : {}),
              ...(item.compaction ? { compaction: item.compaction } : {}),
              ...(byOffset.has(item.offset)
                ? { statistics: byOffset.get(item.offset) }
                : {}),
              ...(parsed.questionReplies
                ? { question_replies: parsed.questionReplies }
                : {}),
              ...(parsed.asyncQuestions
                ? { async_questions: parsed.asyncQuestions }
                : {}),
              ...(item.error ? { error: item.error } : {}),
              sequence: item.order,
              ...(parsed.imagePaths.length
                ? { image_paths: parsed.imagePaths }
                : {}),
            });
        }
        const first = selected[0];
        return {
          messages,
          statistics,
          has_more:
            index.start > 0 || (!!first && index.messages[0]?.id !== first.id),
          reset,
          available: true,
          generation: index.generation,
        };
      } finally {
        await handle.close();
      }
    })
    .catch(() => empty);
  locks.set(file.path, work);
  try {
    return await work;
  } finally {
    if (locks.get(file.path) === work) locks.delete(file.path);
  }
}
