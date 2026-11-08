import { decodeClaudeText } from "./text.js";
import { conversationQuestionReply } from "../../conversation-interactions.js";
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
export function parseClaudeMessage(line: Buffer): AgentHistoryRecord | null {
  if (line.length > claudeRecordLimit(line)) return null;
  let entry: ClaudeEntry;
  try {
    entry = JSON.parse(line.toString());
  } catch {
    return null;
  }
  const message = entry.message;
  if (!message || (entry.type !== "user" && entry.type !== "assistant"))
    return null;
  if (
    entry.isSidechain === true ||
    entry.isMeta === true ||
    message.model === "<synthetic>"
  )
    return null;
  const content = message.content;
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
  const extracted = decodeClaudeText([entry], 128 * 1024).find(
    (item) => item.role === "user" || item.role === "assistant",
  );
  if (!extracted) return null;
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
  return {
    message: reply ? { ...extracted, text: reply.text } : extracted,
    recordType: "native_message",
    questionReplies: reply?.answers,
    imagePaths: [],
    itemId,
    turnId:
      extracted.role === "user"
        ? itemId
        : typeof entry.parentUuid === "string"
          ? entry.parentUuid
          : undefined,
    ...(contentBlocks?.length ? { contentBlocks } : {}),
  };
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
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string;
    content?: unknown;
  };
}

interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}
