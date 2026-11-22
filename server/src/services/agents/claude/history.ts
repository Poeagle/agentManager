import { decodeClaudeText } from "./text.js";
import { createHash } from "node:crypto";
import { claudeErrorCode } from "./errors.js";
import { conversationQuestionReply } from "../../conversation-interactions.js";
import { conversationMessageId } from "../../conversation-reader.js";
import type { AgentHistoryRecord, AgentMessage } from "../types.js";
export function claudeRecordLimit(buffer: Buffer) {
  const header = buffer.subarray(0, 4096).toString("utf8");
  return /"type"\s*:\s*"([^"]+)"/.exec(header)?.[1] === "user" &&
    !/"type"\s*:\s*"tool_result"/.test(header)
    ? 16 * 1024 * 1024
    : 512 * 1024;
}

/** Project one durable record into the generic bounded file index. Tool
 * results remain separate records until the platform projects the turn, so
 * the index can retain identities without reading or caching their bodies. */
export function parseClaudeMessage(line: Buffer, _questionCallId?: string, options?: {attachmentDigests?: boolean}): AgentHistoryRecord | null {
  if (line.length > claudeRecordLimit(line)) return null;
  let entry: ClaudeEntry;
  try {
    entry = JSON.parse(line.toString());
  } catch {
    return null;
  }
  const message = entry.message;
  if (
    entry.type === "system" &&
    entry.subtype === "compact_boundary" &&
    typeof entry.uuid === "string"
  ) {
    const duration = finiteToken(entry.compactMetadata?.durationMs);
    return {
      message: {
        role: "assistant",
        phase: "commentary",
        text: "",
        timestamp:
          typeof entry.timestamp === "string" ? entry.timestamp : null,
      },
      presentation: "compaction_summary",
      compaction: {
        before_tokens: finiteToken(entry.compactMetadata?.preTokens),
        after_tokens: finiteToken(entry.compactMetadata?.postTokens),
        duration_ms: duration,
      },
      itemId: entry.uuid,
      turnId: entry.uuid,
      recordType: "compaction_summary",
      imagePaths: [],
    };
  }
  if (!message || (entry.type !== "user" && entry.type !== "assistant"))
    return null;
  if (entry.isSidechain === true || entry.isMeta === true) return null;
  const content = message.content;
  if (entry.type === 'assistant' && entry.isApiErrorMessage === true) {
    const extracted = decodeClaudeText([entry], 8000)[0];
    if (!extracted) return null;
    const code = claudeErrorCode(extracted.text, typeof entry.error === 'string' ? entry.error : undefined);
    const itemId = typeof message.id === 'string' ? message.id : entry.uuid;
    if (typeof itemId !== 'string') return null;
    const error = { ...(code ? {code} : {}), will_retry: false };
    return {
      message: { ...extracted, phase: 'error' },
      failure: {
        ...extracted, phase: 'error', error, streaming: false,
        id: conversationMessageId('', 'assistant', itemId),
      },
      itemId, turnId: entry.parentUuid, recordType: 'native_message', imagePaths: [],
    };
  }
  if (message.model === '<synthetic>') return null;
  if (
    Array.isArray(content) &&
    content.some((block) => block?.type === "tool_result")
  ) {
    const toolResult = claudeToolResult(entry);
    if (!toolResult || typeof entry.uuid !== "string") return null;
    return {
      message: {
        role: "user",
        phase: "user",
        text: "",
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      },
      recordType: "tool_result",
      imagePaths: [],
      sourceRole: "tool_result",
      itemId: entry.uuid,
      toolResult: {
        toolUseId: toolResult.id,
        result: toolResult.result,
        failed: toolResult.failed,
      },
    };
  }
  const images = entry.type === 'user' && message.role === 'user' && Array.isArray(content)
    ? content.filter(block => block?.type === 'image') : [];
  const extracted = decodeClaudeText([entry], 128 * 1024).find(
    (item) => item.role === "user" || item.role === "assistant",
  ) ?? (images.length && (!entry.origin?.kind || entry.origin.kind === 'human') ? {
    role: 'user' as const, phase: 'user' as const, text: '请查看附件。',
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
  } : null);
  if (!extracted) return null;
  if (
    extracted.role === "user" &&
    typeof entry.promptId === "string" &&
    /^This session is being continued from a previous conversation that ran out of context\./i.test(
      extracted.text,
    )
  ) {
    return {
      message: {
        ...extracted,
        role: "assistant",
        phase: "commentary",
      },
      presentation: "compaction_summary",
      itemId: typeof entry.uuid === "string" ? entry.uuid : undefined,
      turnId: undefined,
      recordType: "compaction_summary",
      imagePaths: [],
    };
  }
  const reply =
    extracted.role === "user"
      ? conversationQuestionReply(extracted.text)
      : undefined;
  const itemId =
    extracted.role === "assistant" && typeof message.id === "string"
      ? message.id
      : typeof entry.uuid === "string"
        ? entry.uuid
        : undefined;
  const contentBlocks =
    extracted.role === "assistant" ? claudeContentBlocks(content) : undefined;
  const usage = extracted.role === "assistant" ? claudeUsage(message.usage) : null;
  const imageDigests = options?.attachmentDigests && images.length && images.length <= 8 && images.every(
    block => block.source?.type === 'base64' && typeof block.source.data === 'string' && block.source.data.length > 0,
  ) ? images.map(block => createHash('sha256').update(block.source.data, 'base64').digest('hex')) : undefined;
  return {
    message: reply ? { ...extracted, text: reply.text } : extracted,
    recordType: "native_message",
    questionReplies: reply?.answers,
    imagePaths: [],
    ...(imageDigests ? { imageDigests } : {}),
    itemId,
    turnId:
      extracted.role === "user"
        ? itemId
        : typeof entry.parentUuid === "string"
          ? entry.parentUuid
          : undefined,
    ...(contentBlocks?.length ? { contentBlocks } : {}),
    ...(usage ? { usage } : {}),
  };
}

function claudeUsage(value: unknown): Record<string,number|null>|null {
  if (!value || typeof value !== "object") return null;
  const usage=value as Record<string,unknown>;
  const number=(key:string)=>typeof usage[key]==="number"&&Number.isFinite(usage[key])?usage[key] as number:null;
  const input=number("input_tokens"),read=number("cache_read_input_tokens")??0,write=number("cache_creation_input_tokens")??0,output=number("output_tokens");
  if(input===null&&output===null)return null;
  return {
    input_tokens:input===null?null:input+read+write,
    cached_input_tokens:read,
    output_tokens:output,
    total_tokens:input===null&&output===null?null:(input??0)+read+write+(output??0),
  };
}

function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function claudeToolResult(
  entry: ClaudeEntry,
): { id: string; result: string; failed: boolean } | null {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const result = content.find(
    (block): block is ClaudeToolResult =>
      block?.type === "tool_result" && typeof block.tool_use_id === "string",
  );
  if (!result) return null;
  return {
    id: result.tool_use_id,
    result:
      typeof result.content === "string"
        ? result.content
        : Array.isArray(result.content)
          ? result.content
              .filter(
                (block) =>
                  block?.type === "text" && typeof block.text === "string",
              )
              .map((block) => block.text)
              .join("\n")
          : JSON.stringify(result.content ?? ""),
    failed: result.is_error === true,
  };
}

function claudeContentBlocks(
  content: unknown,
): NonNullable<AgentMessage["content_blocks"]> | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap(
    (block, index): NonNullable<AgentMessage["content_blocks"]> => {
      if (block?.type === "text" && typeof block.text === "string")
        return [{ type: "text", index, text: block.text }];
      if (block?.type === "tool_use" && typeof block.id === "string")
        return [
          {
            type: "tool_use",
            index,
            id: block.id,
            name: String(block.name || "工具"),
            input: block.input ?? {},
            status: "completed",
          },
        ];
      return [];
    },
  );
  return blocks.length ? blocks : undefined;
}

interface ClaudeEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  promptId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  origin?: {kind?: string};
  isApiErrorMessage?: boolean;
  error?: unknown;
  timestamp?: string;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  };
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string;
    content?: unknown;
    usage?: unknown;
  };
}

interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}
