import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "fs/promises";
import { extname } from "path";
import { randomUUID } from "crypto";
import { conversationMessageId } from "../../conversation-reader.js";
import {
  formatConversationInput,
  type ConversationAttachment,
} from "../../conversation-attachments.js";
import type { ConversationActivity } from "../../conversation-activity.js";
import {
  activityResultPreview,
  type ConversationActivity as AgentActivity,
} from "../../conversation-activity.js";
import type {
  AgentConnection,
  AgentMessage,
  AgentRuntime,
  AgentStreamPort,
  ModelPreference,
} from "../types.js";
import type { AgentCompaction, AgentStreamSnapshot } from "../events.js";
import type { ClaudeProviderRuntime } from "./providers.js";

type Listener = (frame: AgentStreamSnapshot) => void;
type Pending = {
  text: string;
  clientId?: string;
  attachments: ConversationAttachment[];
  userId: string;
  clientGenerated: boolean;
  nativeUuid?: string;
  priority?: SDKUserMessage["priority"];
};
type AssistantEnvelope = {
  ordinal: number;
  nativeId?: string;
  blocks: Map<number, NonNullable<AgentMessage["content_blocks"]>[number]>;
  inputDeltas: Map<number, string>;
  sawText: boolean;
};

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block &&
      typeof block === "object" &&
      (block as any).type === "text" &&
      typeof (block as any).text === "string"
        ? [(block as any).text]
        : [],
    )
    .join("");
}

function toolLabel(name: string, input: unknown): string {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const short = (item: unknown) =>
    String(item || "")
      .replace(/\s+/g, " ")
      .slice(0, 160);
  if (name === "Bash")
    return `运行命令 · ${short(value.command) || "终端命令"}`;
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(name))
    return `${name === "Read" ? "读取" : "修改"}文件 · ${short(value.file_path || value.notebook_path) || "项目文件"}`;
  if (["Glob", "Grep"].includes(name))
    return `搜索文件 · ${short(value.pattern) || name}`;
  if (name === "WebSearch") return `搜索 · ${short(value.query) || "网页搜索"}`;
  if (name === "WebFetch") return `读取网页 · ${short(value.url) || "网页"}`;
  return `调用工具 · ${name}`;
}

async function userMessage(
  pending: Pending,
  sessionId: string,
  priority?: SDKUserMessage["priority"],
): Promise<SDKUserMessage> {
  const files = pending.attachments.filter((item) => item.kind === "file");
  const images = pending.attachments.filter((item) => item.kind === "image");
  const body = formatConversationInput(pending.text, files, true);
  let content: any = body;
  if (images.length) {
    content = [];
    for (const image of images) {
      const extension = extname(image.path).toLowerCase();
      const media_type =
        extension === ".png"
          ? "image/png"
          : extension === ".gif"
            ? "image/gif"
            : extension === ".webp"
              ? "image/webp"
              : "image/jpeg";
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type,
          data: (await readFile(image.path)).toString("base64"),
        },
      });
    }
    if (body.trim()) content.push({ type: "text", text: body });
  }
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
    ...(priority ? { priority } : {}),
    ...(pending.nativeUuid
      ? { uuid: pending.nativeUuid as `${string}-${string}-${string}-${string}-${string}` }
      : {}),
  };
}

class ClaudeInputStream {
  private values: SDKUserMessage[] = [];
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(value: SDKUserMessage) {
    if (this.closed) throw Error("Claude input stream is closed");
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ done: false, value });
    } else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>(
        (resolve) => (this.waiting = resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

class ClaudeRuntime {
  private listeners = new Set<Listener>();
  private messages: AgentMessage[] = [];
  private activities = new Map<string, ConversationActivity>();
  /** Latest native activity by ID; tool updates replace this state rather than
   * accumulating another visible item. */
  private liveActivities = new Map<string, AgentActivity>();
  private progressBoundary: string | null = null;
  private input: ClaudeInputStream | null = null;
  /** Follow-ups accepted into the same SDK query for native ordering and echo correlation. */
  private submitted: Pending[] = [];
  private currentClientId: string | undefined;
  private currentInputUuid: string | undefined;
  private currentNativeUserSeen = false;
  private active: Query | null = null;
  private abort: AbortController | null = null;
  private busy = false;
  private running: Promise<void> | null = null;
  private stage: AgentStreamSnapshot["stage"] = "idle";
  private turnId: string | null = null;
  private completedTurnId: string | null = null;
  private startedAt: string | null = null;
  private completedAt: string | null = null;
  private assistantIds = new Set<string>();
  private assistantOrdinal = 0;
  private currentAssistant: AssistantEnvelope | null = null;
  private completedAssistants: AssistantEnvelope[] = [];
  private pending: Pending[] = [];
  private model: string | undefined;
  private lastActivity: string | null = null;
  private compaction: AgentCompaction | null = null;
  private pendingModelMismatch: string | null = null;
  private resumeOnNextQuery: boolean;
  private provider: ClaudeProviderRuntime | null;

  constructor(
    readonly id: string,
    readonly cwd: string,
    private instructions?: string,
    preference?: ModelPreference,
    resume = false,
    provider: ClaudeProviderRuntime | null = null,
  ) {
    this.model = preference?.model || undefined;
    this.resumeOnNextQuery = resume;
    this.provider = provider;
  }

  private observedTurnId() {
    return this.currentClientId ?? this.turnId;
  }

  configure(
    provider: ClaudeProviderRuntime | null,
    preference?: ModelPreference,
  ) {
    if (!provider) return;
    if (
      this.provider &&
      this.provider.id !== provider.id
    )
      throw Error("Claude 会话正在使用另一个 Provider，完成后才能切换");
    if (!this.provider) this.provider = provider;
    else if (this.provider.id !== provider.id) {
      throw Error(
        `Claude 会话已绑定 Provider ${this.provider.name}，不能切换到 ${provider.name}`,
      );
    }
    if (preference?.model) this.model = preference.model;
  }

  snapshot(): AgentStreamSnapshot {
    return {
      type: "snapshot",
      messages: this.messages.slice(-128),
      interactions: [],
      activities: [...this.liveActivities.values()],
      compaction: this.compaction,
      busy: this.busy,
      connected: true,
      turn_id: this.turnId,
      started_at: this.startedAt,
      completed_at: this.completedAt,
      stage: this.stage,
    };
  }
  private compactionSummary(message: SDKMessage) {
    if (
      (message as any).type !== "system" ||
      (message as any).subtype !== "compact_boundary"
    ) return;
    if (!(message as any).uuid) return;
    const metadata = (message as any).compact_metadata;
    if (!metadata || typeof metadata !== "object") return;
    const timestamp = new Date().toISOString();
    this.upsert({
      id: conversationMessageId("", "assistant", message.uuid),
      role: "assistant",
      text: "",
      timestamp,
      phase: "commentary",
      streaming: false,
      presentation: "compaction_summary",
      compaction: {
        before_tokens:
          typeof metadata.pre_tokens === "number" ? metadata.pre_tokens : null,
        after_tokens:
          typeof metadata.post_tokens === "number"
            ? metadata.post_tokens
            : null,
        duration_ms:
          typeof metadata.duration_ms === "number"
            ? metadata.duration_ms
            : null,
      },
    });
  }
  private recordObservedModel(model: unknown) {
    if (
      !this.model ||
      typeof model !== "string" ||
      !model ||
      model.startsWith("<") ||
      model === this.model
    ) return;
    this.pendingModelMismatch = model;
  }

  private publish() {
    const frame = this.snapshot();
    for (const listener of this.listeners) listener(frame);
  }

  observe(emit: Listener): AgentConnection {
    this.listeners.add(emit);
    emit(this.snapshot());
    return Object.assign(() => this.listeners.delete(emit), {
      respond: () => {
        throw Error("Claude 当前没有待处理的结构化提问");
      },
    });
  }

  async submit(
    text: string,
    clientId?: string,
    attachments: ConversationAttachment[] = [],
    userId?: string,
  ): Promise<boolean | "queued"> {
    const pending: Pending = {
      text,
      clientId,
      attachments,
      userId: userId || randomUUID(),
      clientGenerated: !userId,
      nativeUuid: userId ? userId : undefined,
    };
    if (this.busy && this.input && this.active) {
      // Claude can continue the same streaming query after interrupt(); the
      // next user message starts the continuation turn in that same session.
      let accepted = false;
      try {
        this.input.push(await userMessage(pending, this.id));
        this.submitted.push(pending);
        accepted = true;
      } catch {
        // Fall through to the queue path without creating a second identity.
      }
      if (!accepted) {
        this.pending.unshift(pending);
        this.upsert({
          id: conversationMessageId("", "user", pending.userId),
          role: "user",
          text: pending.text.trim() || "请查看附件。",
          timestamp: new Date().toISOString(),
          turn_id: this.turnId || pending.userId,
          client_id: pending.clientId,
          queued: true,
          streaming: false,
        });
        this.publish();
        return "queued";
      }
      this.upsert({
        id: conversationMessageId("", "user", pending.userId),
        role: "user",
        text: pending.text.trim() || "请查看附件。",
        timestamp: new Date().toISOString(),
        turn_id: this.turnId || pending.userId,
        client_id: pending.clientId,
        queued: false,
        streaming: false,
      });
      this.publish();
      const active = this.active;
      try {
        await active.interrupt();
      } catch {
        // The continuation input is already in the same query stream.
      }
      return true;
    }
    if (this.busy || this.running) {
      this.pending.push(pending);
      this.upsert({
        id: conversationMessageId("", "user", pending.userId),
        role: "user",
        text: pending.text.trim() || "请查看附件。",
        timestamp: new Date().toISOString(),
        turn_id: this.turnId || pending.userId,
        client_id: pending.clientId,
        queued: true,
        streaming: false,
      });
      this.publish();
      return "queued";
    }
    if (userId) pending.nativeUuid = userId;
    this.start(pending);
    return true;
  }

  async cancelQueued(clientId: string) {
    const index = this.pending.findIndex(
      (pending) => pending.clientId === clientId,
    );
    if (index < 0)
      throw Object.assign(Error("该消息已开始或不在等待队列中"), {
        statusCode: 409,
      });
    const [removed] = this.pending.splice(index, 1);
    this.messages = this.messages.filter(
      (message) =>
        !(
          message.role === "user" &&
          message.client_id === removed.clientId &&
          message.queued
        ),
    );
    this.publish();
  }

  private start(pending: Pending) {
    if (this.busy) {
      this.pending.push(pending);
      return;
    }
    this.running = this.run(pending).finally(() => {
      this.running = null;
      const next = this.pending.shift();
      if (next) this.start(next);
    });
  }

  private upsert(message: AgentMessage) {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index < 0) this.messages.push(message);
    else this.messages[index] = { ...this.messages[index], ...message };
    if (this.messages.length > 256)
      this.messages.splice(0, this.messages.length - 256);
  }

  private assistant(nativeId: string) {
    const id = conversationMessageId("", "assistant", nativeId);
    let message = this.messages.find((item) => item.id === id);
    if (!message) {
      message = {
        id,
        role: "assistant",
        text: "",
        timestamp: new Date().toISOString(),
        turn_id: this.turnId || undefined,
        phase: "commentary",
        streaming: true,
      };
      this.messages.push(message);
      this.assistantIds.add(id);
    }
    return message;
  }

  private bindNativeId(envelope: AssistantEnvelope, nativeId: string) {
    const oldKey = envelope.nativeId;
    const oldId = conversationMessageId(
      "",
      "assistant",
      oldKey ?? `turn:${this.turnId || "claude"}:assistant:${envelope.ordinal}`,
    );
    const newId = conversationMessageId("", "assistant", nativeId);
    envelope.nativeId = nativeId;
    if (oldId === newId) return;
    const index = this.messages.findIndex((message) => message.id === oldId);
    if (index < 0) return;
    const old = this.messages[index],
      existing = this.messages.find((message) => message.id === newId);
    if (existing && existing !== old) {
      this.messages[this.messages.indexOf(existing)] = {
        ...old,
        ...existing,
        id: newId,
        content_blocks: existing.content_blocks?.length
          ? existing.content_blocks
          : old.content_blocks,
      };
      this.messages.splice(index, 1);
    } else this.messages[index] = { ...old, id: newId };
    this.assistantIds.delete(oldId);
    this.assistantIds.add(newId);
  }

  private beginAssistant(): AssistantEnvelope {
    const envelope = {
      ordinal: this.assistantOrdinal++,
      blocks: new Map<
        number,
        NonNullable<AgentMessage["content_blocks"]>[number]
      >(),
      inputDeltas: new Map<number, string>(),
      sawText: false,
    };
    this.currentAssistant = envelope;
    return envelope;
  }

  private assistantEnvelope() {
    return this.currentAssistant ?? this.beginAssistant();
  }

  private appendThinking(envelope: AssistantEnvelope, index: number, text: string) {
    if (!text) return;
    const existing = envelope.blocks.get(index);
    const previous =
      existing?.type === "thinking" ? existing.text : "";
    envelope.blocks.set(index, {
      type: "thinking",
      index,
      text: previous + text,
    });
    const message = this.assistant(this.textBlock(envelope, index));
    this.upsert({
      ...message,
      content_blocks: [...envelope.blocks.values()].sort(
        (a, b) => a.index - b.index,
      ),
      streaming: true,
    });
  }

  private finishAssistantEnvelope() {
    const envelope = this.currentAssistant;
    if (!envelope) return;
    this.completedAssistants.push(envelope);
    this.currentAssistant = null;
  }

  private textBlock(envelope: AssistantEnvelope, index: number) {
    if (envelope.nativeId) return envelope.nativeId;
    return `turn:${this.turnId || "claude"}:assistant:${envelope.ordinal}`;
  }

  private startTool(
    envelope: AssistantEnvelope,
    index: number,
    id: string,
    name: string,
    input: unknown,
  ) {
    const old = this.activities.get(id);
    if (!old) {
      this.activities.set(id, {
        id,
        label: toolLabel(name, input),
        status: "running",
        started_at: new Date().toISOString(),
        completed_at: null,
        duration_ms: null,
      });
    }
    const previous = [...envelope.blocks.values()].find(
      (block) => block.type === "tool_use" && block.id === id,
    );
    envelope.blocks.set(index, {
      ...(previous?.type === "tool_use" ? previous : {}),
      type: "tool_use",
      index,
      id,
      name,
      input: {
        ...(previous?.type === "tool_use" &&
        previous.input &&
        typeof previous.input === "object"
          ? previous.input
          : {}),
        ...(input && typeof input === "object" ? input : {}),
      },
      status:
        previous?.type === "tool_use" ? previous.status : ("running" as const),
    });
    envelope.inputDeltas.delete(index);
    const message = this.assistant(this.textBlock(envelope, index));
    this.upsert({
      ...message,
      content_blocks: [...envelope.blocks.values()].sort(
        (a, b) => a.index - b.index,
      ),
    });
    this.stage = "tools";
    this.publishActivity(envelope, id, name, input, false);
  }

  private publishActivity(
    envelope: AssistantEnvelope,
    id: string,
    name: string,
    input: unknown,
    completed: boolean,
    result?: unknown,
  ) {
    const previous = this.liveActivities.get(id);
    const started = previous?.started_at ?? new Date().toISOString();
    const ended = completed ? new Date().toISOString() : null;
    const value = input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
    const detail =
      name === "Bash" ? value.command :
      value.file_path ?? value.path ?? value.pattern ?? value.query ?? value.description;
    this.liveActivities.set(id, {
      id,
      label: toolLabel(name, input),
      status: completed ? "completed" : "running",
      started_at: started,
      completed_at: ended,
      duration_ms: ended ? Math.max(0, Date.parse(ended) - Date.parse(started)) : null,
      ...(typeof detail === "string" && detail.trim()
        ? { input_preview: activityResultPreview(detail.trim()) }
        : {}),
      ...(result !== undefined
        ? { result_preview: activityResultPreview(
            typeof result === "string" ? result : textContent(result),
          ) }
        : {}),
      turn_id: this.turnId,
      after_message_id: this.progressBoundary ??= this.assistant(
        this.textBlock(envelope, Math.max(0, envelope.blocks.size - 1)),
      ).id,
    });
  }

  private mergeCompletedAssistant(
    envelope: AssistantEnvelope,
    nativeId: string | undefined,
    content: unknown,
  ) {
    if (!envelope.nativeId && nativeId) this.bindNativeId(envelope, nativeId);
    const blocks = Array.isArray(content) ? content : [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index] as any;
      if (block?.type === "tool_use") {
        this.startTool(envelope, index, block.id, block.name, block.input);
        continue;
      }
      if (block?.type === "thinking" && typeof block.thinking === "string") {
        const existing = envelope.blocks.get(index);
        const previous = existing?.type === "thinking" ? existing.text : "";
        const current = block.thinking;
        if (current !== previous)
          this.appendThinking(
            envelope,
            index,
            current.startsWith(previous) ? current.slice(previous.length) : current,
          );
        continue;
      }
      if (
        block?.type !== "text" ||
        typeof block.text !== "string"
      )
        continue;
      if (!block.text) continue;
      const existing = envelope.blocks.get(index);
      const duplicateText = [...envelope.blocks.values()].some(
        (item) => item.type === "text" && item.text === block.text,
      );
      if (!duplicateText && (!envelope.sawText || !existing))
        this.appendText(envelope, index, block.text);
    }
    if (!envelope.nativeId) return;
    const target = this.assistant(envelope.nativeId);
    const value = textContent(content);
    this.upsert({
      ...target,
      ...(value && !target.text ? { text: value } : {}),
      content_blocks: [...envelope.blocks.values()].sort(
        (a, b) => a.index - b.index,
      ),
    });
  }

  private finishTool(id: string, failed = false, result?: string) {
    const old = this.activities.get(id);
    if (!old) return;
    const completed_at = new Date().toISOString();
    this.activities.set(id, {
      ...old,
      status: failed ? "failed" : "completed",
      completed_at,
      duration_ms: old.started_at
        ? Math.max(0, Date.parse(completed_at) - Date.parse(old.started_at))
        : null,
    });
    const live = this.liveActivities.get(id);
    if (live) {
      const completed_at = this.activities.get(id)!.completed_at;
      this.liveActivities.set(id, {
        ...live,
        status: failed ? "failed" : "completed",
        completed_at,
        duration_ms: this.activities.get(id)!.duration_ms,
        ...(result !== undefined
          ? { result_preview: activityResultPreview(result) }
          : {}),
      });
    }
    for (const message of this.messages) {
      if (
        message.role !== "assistant" ||
        !message.content_blocks?.some(
          (block) => block.type === "tool_use" && block.id === id,
        )
      )
        continue;
      const content_blocks = message.content_blocks.map((block) =>
        block.type === "tool_use" && block.id === id
          ? {
              ...block,
              status: failed ? ("failed" as const) : ("completed" as const),
              ...(result !== undefined ? { result } : {}),
              ...(failed ? { is_error: true } : {}),
            }
          : block,
      );
      this.upsert({ ...message, content_blocks });
    }
  }

  private consume(message: SDKMessage, currentTurnUser = false) {
    this.lastActivity = new Date().toISOString();
    if (message.type === "system" && message.subtype === "status") {
      if (message.status === "compacting") {
        this.compaction = {
          id: this.compaction?.status === "running"
            ? this.compaction.id
            : `compact:${new Date().toISOString()}`,
          status: "running",
          started_at: this.compaction?.status === "running"
            ? this.compaction.started_at
            : new Date().toISOString(),
          completed_at: null,
          duration_ms: null,
        };
      } else if (this.compaction?.status === "running" && message.compact_result) {
        const completed_at = new Date().toISOString();
        this.compaction = {
          ...this.compaction,
          status: message.compact_result === "success" ? "completed" : "failed",
          completed_at,
          duration_ms: this.compaction.started_at
            ? Math.max(0, Date.parse(completed_at) - Date.parse(this.compaction.started_at))
            : null,
        };
      }
      this.publish();
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      this.compactionSummary(message);
      const startedAt = this.compaction?.started_at ?? null;
      this.compaction = {
        id: message.uuid,
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: message.compact_metadata.duration_ms ?? null,
      };
      this.publish();
      return;
    }
    if (message.type === "user" && !message.parent_tool_use_id && message.uuid) {
      if (currentTurnUser) {
        const previousTurnId = this.turnId;
        this.turnId = message.uuid;
        const index = this.messages.findIndex(
          (item) =>
            item.role === "user" &&
            (
              item.id === conversationMessageId("", "user", message.uuid) ||
              item.turn_id === previousTurnId ||
              item.turn_id === this.currentClientId
            ),
        );
        if (index >= 0) {
          this.messages[index] = {
            ...this.messages[index],
            id: conversationMessageId("", "user", message.uuid),
            turn_id: message.uuid,
            ...(this.currentClientId
              ? { native_client_id: this.currentClientId }
              : {}),
          };
        }
        this.publish();
        return;
      }
      const nativeText = textContent(message.message.content);
      const submitted = this.submitted.find(
        (item) =>
          (!item.clientGenerated && item.nativeUuid === message.uuid) ||
          message.uuid === item.nativeUuid ||
          message.uuid === item.userId ||
          (item === this.submitted[0] && nativeText === item.text),
      );
      if (submitted) {
        this.submitted.splice(this.submitted.indexOf(submitted), 1);
        this.linkNativeUserMessage(submitted, message.uuid);
      }
    }
    if (message.type === "stream_event") {
      const event: any = message.event;
      if (event?.type === "message_start") {
        if (this.currentAssistant) this.finishAssistantEnvelope();
        const envelope = this.beginAssistant();
        if (typeof event.message?.id === "string")
          envelope.nativeId = event.message.id;
      } else if (event?.type === "message_stop") {
        this.finishAssistantEnvelope();
      } else if (
        event?.type === "content_block_start" &&
        event.content_block?.type === "thinking" &&
        message.parent_tool_use_id === null
      ) {
        this.appendThinking(
          this.assistantEnvelope(),
          event.index,
          String(event.content_block.thinking || ""),
        );
      } else if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "thinking_delta" &&
        message.parent_tool_use_id === null
      ) {
        this.appendThinking(
          this.assistantEnvelope(),
          event.index,
          String(event.delta.thinking || ""),
        );
      } else if (
        event?.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      ) {
        const envelope = this.assistantEnvelope();
        this.startTool(
          envelope,
          event.index,
          event.content_block.id,
          event.content_block.name || "工具",
          event.content_block.input,
        );
      } else if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        const envelope = this.assistantEnvelope();
        const partial =
          (envelope.inputDeltas.get(event.index) || "") +
          String(event.delta.partial_json || "");
        envelope.inputDeltas.set(event.index, partial);
        const tool = envelope.blocks.get(event.index);
        if (tool?.type === "tool_use") {
          try {
            const value = JSON.parse(partial);
            if (value && typeof value === "object" && !Array.isArray(value)) {
              envelope.blocks.set(event.index, {
                ...tool,
                input: {
                  ...(tool.input && typeof tool.input === "object"
                    ? tool.input
                    : {}),
                  ...value,
                },
              });
              const target = this.assistant(
                this.textBlock(envelope, event.index),
              );
              this.upsert({
                ...target,
                content_blocks: [...envelope.blocks.values()].sort(
                  (a, b) => a.index - b.index,
                ),
              });
            }
          } catch {
            /* Claudian keeps the last valid tool snapshot until JSON is complete. */
          }
        }
      } else if (
        event?.type === "content_block_start" &&
        event.content_block?.type === "text" &&
        message.parent_tool_use_id === null
      ) {
        const envelope = this.assistantEnvelope();
        const value = String(event.content_block.text || "");
        if (value) this.appendText(envelope, event.index, value);
      } else if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        message.parent_tool_use_id === null
      ) {
        const envelope = this.assistantEnvelope();
        const value = String(event.delta.text || "");
        if (value) this.appendText(envelope, event.index, value);
      }
      this.publish();
      return;
    }
    if (message.type === "assistant") {
      const isSubagent = (message.parent_tool_use_id ?? null) !== null;
      if (isSubagent) {
        this.publish();
        return;
      }
      const nativeId =
        typeof message.message.id === "string" ? message.message.id : undefined;
      this.recordObservedModel(message.message.model);
      const envelope =
        (nativeId
          ? this.completedAssistants.find(
              (candidate) => candidate.nativeId === nativeId,
            )
          : undefined) ??
        this.currentAssistant ??
        this.completedAssistants.shift() ??
        this.beginAssistant();
      this.mergeCompletedAssistant(
        envelope,
        nativeId,
        message.message.content,
      );
      this.publish();
      return;
    }
    if (message.type === "user") {
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : [];
      const results = content.filter(
        (block: any) =>
          block?.type === "tool_result" &&
          typeof block.tool_use_id === "string",
      );
      for (const block of results)
        this.finishTool(
          (block as any).tool_use_id,
          !!(block as any).is_error,
          textContent((block as any).content),
        );
      if (!results.length && message.parent_tool_use_id) {
        const rawResult = (message as any).tool_use_result;
        const resultText =
          typeof rawResult === "string"
            ? rawResult
            : textContent(rawResult) || textContent(message.message.content);
        this.finishTool(message.parent_tool_use_id, false, resultText);
      }
      this.publish();
      return;
    }
    if (message.type === "tool_progress") {
      const envelope = this.assistantEnvelope();
      this.startTool(
        envelope,
        envelope.blocks.size,
        message.tool_use_id,
        message.tool_name,
        {},
      );
      this.publish();
      return;
    }
    if (message.type === "result") {
      if (message.subtype !== "success") {
        const text =
          "errors" in message && message.errors.length
            ? message.errors.join("\n")
            : "Claude 执行失败";
        const code = /insufficient_balance|insufficient balance/i.test(text)
          ? "insufficient_balance"
          : /\b503\b|no available accounts|service unavailable|api_error/i.test(text)
            ? "provider_unavailable"
            : /\b400\b|invalid_request_error|requires adaptive thinking/i.test(text)
              ? "invalid_request"
            : /selected model.*(?:does not exist|may not exist|access)/i.test(text)
              ? "model_unavailable"
              : undefined;
        this.upsert({
          id: conversationMessageId(
            this.turnId || "claude",
            "assistant",
            message.uuid,
          ),
          role: "assistant",
          text,
          timestamp: new Date().toISOString(),
          turn_id: this.turnId || undefined,
          phase: "error",
          presentation: undefined,
          streaming: false,
          error: { ...(code ? { code } : {}), will_retry: false },
        });
      }
    }
  }

  private linkNativeUserMessage(pending: Pending, nativeId: string) {
    const linked = pending as Pending & { nativeLinked?: boolean };
    if (linked.nativeLinked) return;
    linked.nativeLinked = true;
    const optimisticId = conversationMessageId("", "user", pending.userId);
    const nativeMessageId = conversationMessageId("", "user", nativeId);
    const index = this.messages.findIndex((message) => message.id === optimisticId);
    if (index < 0 || optimisticId === nativeMessageId) return;
    const existing = this.messages.findIndex(
      (message) => message.id === nativeMessageId,
    );
    const message = {
      ...this.messages[index],
      id: nativeMessageId,
      turn_id: nativeId,
      ...(pending.clientId ? { native_client_id: pending.clientId } : {}),
    };
    if (existing >= 0 && existing !== index) this.messages[existing] = message;
    else this.messages[index] = message;
    if (existing >= 0 && existing !== index) this.messages.splice(index, 1);
    this.publish();
  }

  private appendText(envelope: AssistantEnvelope, index: number, text: string) {
    envelope.sawText = true;
    this.stage = "answering";
    const current = this.assistant(this.textBlock(envelope, index));
    const old = envelope.blocks.get(index),
      previous = old?.type === "text" ? old.text : "";
    envelope.blocks.set(index, { type: "text", index, text: previous + text });
    this.upsert({
      ...current,
      text: current.text + text,
      content_blocks: [...envelope.blocks.values()].sort(
        (a, b) => a.index - b.index,
      ),
      streaming: true,
    });
  }

  private async run(pending: Pending) {
    this.busy = true;
    this.stage = "waiting";
    this.turnId = pending.userId;
    this.currentClientId = pending.clientId;
    this.currentInputUuid = undefined;
    this.currentNativeUserSeen = false;
    this.completedTurnId = null;
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.assistantIds.clear();
    this.activities.clear();
    this.liveActivities.clear();
    this.progressBoundary = null;
    this.assistantOrdinal = 0;
    this.currentAssistant = null;
    this.completedAssistants = [];
    this.upsert({
      id: conversationMessageId("", "user", pending.userId),
      role: "user",
      text: pending.text.trim() || "请查看附件。",
      timestamp: this.startedAt,
      turn_id: pending.userId,
      client_id: pending.clientId,
      queued: false,
      streaming: false,
    });
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    const sessionId = this.id;
    const input = new ClaudeInputStream();
    this.input = input;
    if (!pending.nativeUuid)
      pending.nativeUuid = randomUUID() as Pending["nativeUuid"];
    const currentInput = await userMessage(pending, sessionId, pending.priority);
    input.push(currentInput);
    const resume = this.resumeOnNextQuery;
    this.resumeOnNextQuery = true;
    const providerEnvironment = this.provider
      ? (await import("./providers.js")).claudeProviderEnvironment(
          this.provider,
          this.model,
        )
      : undefined;
    const options: Options = {
      cwd: this.cwd,
      includePartialMessages: true,
      abortController: abort,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      tools: { type: "preset", preset: "claude_code" },
      persistSession: true,
      ...(providerEnvironment ? { env: providerEnvironment } : {}),
      ...(this.provider?.adaptiveThinking
        ? { thinking: { type: "adaptive" as const } }
        : {}),
      ...(this.instructions
        ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: this.instructions,
            },
          }
        : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(resume ? { resume: this.id } : { sessionId: this.id }),
    };
    this.currentInputUuid = currentInput.uuid;
    const conversation = query({ prompt: input, options });
    this.active = conversation;
    let completed = false;
    let completedSuccessfully = false;
    try {
      for await (const message of conversation) {
        const current =
          message.type === "user" &&
          !message.parent_tool_use_id &&
          !this.currentNativeUserSeen &&
          (
            !this.currentInputUuid ||
            message.uuid === this.currentInputUuid ||
            textContent(message.message.content) ===
              textContent(currentInput.message.content)
          );
        if (current) this.currentNativeUserSeen = true;
        this.consume(message, current);
        if (message.type === "result") {
          if (this.submitted.length && !this.currentNativeUserSeen) {
            continue;
          }
          completed = true;
          completedSuccessfully = message.subtype === "success";
          // A Claude result is the end of the current native turn. The SDK
          // input stream can remain open after it, so do not wait for closure
          // before releasing the runtime or starting an accepted follow-up.
          break;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const text = error instanceof Error ? error.message : "Claude 连接失败";
        this.upsert({
          id: conversationMessageId(
            this.turnId || "claude",
            "assistant",
            `error:${this.turnId}`,
          ),
          role: "assistant",
          text,
          timestamp: new Date().toISOString(),
          turn_id: this.turnId || undefined,
          phase: "error",
          streaming: false,
          error: { will_retry: false },
        });
      }
    } finally {
      if (this.pendingModelMismatch && this.model) {
        const observed = this.pendingModelMismatch;
        this.pendingModelMismatch = null;
        this.upsert({
          id: conversationMessageId(
            this.turnId || "claude",
            "assistant",
            `model-mismatch:${this.turnId}`,
          ),
          role: "assistant",
          text: `Provider 实际返回模型 ${observed}，与所选模型 ${this.model} 不一致。该结果未按所选模型执行，请检查 Provider 路由或模型目录。`,
          timestamp: new Date().toISOString(),
          turn_id: this.turnId || undefined,
          phase: "error",
          streaming: false,
          error: { code: "model_mismatch", will_retry: false },
        });
      }
      const active = this.active;
      this.active = null;
      if (completed && active) {
        try {
          active.close();
        } catch {
          // The result is authoritative; closing a released stream is optional.
        }
      }
      input.close();
      if (this.input === input) this.input = null;
      this.abort = null;
      this.busy = false;
      this.stage = "idle";
      this.completedAt = new Date().toISOString();
      this.completedTurnId = this.observedTurnId();
      this.finalizeAssistantMessages(completedSuccessfully);
      for (const [id, activity] of this.activities)
        if (activity.status === "running") this.finishTool(id);
      this.publish();
    }
  }

  /** Claude emits assistant protocol messages for commentary and tool rounds as
   * well as the conclusion. Only a successful final text message represents the
   * answer; tools stay in the shared progress transcript. */
  private finalizeAssistantMessages(success: boolean) {
    const assistants = [...this.assistantIds].flatMap((id) => {
      const message = this.messages.find((item) => item.id === id);
      return message && message.role === "assistant" ? [message] : [];
    });
    let finalMessage: AgentMessage | undefined;
    if (success) {
      for (let index = assistants.length - 1; index >= 0; index--) {
        const message = assistants[index];
        if (
          message.phase !== "error" &&
          !!message.text.trim() &&
          message.content_blocks?.some(
            (block) => block.type === "text" && !!block.text.trim(),
          ) === true
        ) {
          finalMessage = message;
          break;
        }
      }
    }
    for (const message of assistants) {
      if (message.phase === "error") {
        this.upsert({ ...message, streaming: false });
        continue;
      }
      const final = message === finalMessage;
      this.upsert({
        ...message,
        phase: final ? "final" : "commentary",
        streaming: false,
        ...(final && this.completedAt ? { timestamp: this.completedAt } : {}),
      });
    }
  }

  async stopTurn(turnId:string):Promise<boolean> {
    if(!this.busy)return false;
    if(
      turnId!==this.turnId &&
      turnId!==this.currentClientId &&
      turnId!==this.id
    )return false;
    await this.interrupt();
    return true;
  }
  async interrupt() {
    const turnId = this.turnId;
    if (!this.busy || !turnId) return;
    const active = this.active;
    this.closeActiveQuery();
    try {
      await active?.interrupt();
    } catch {
      /* Closing the query is authoritative. */
    } finally {
      // The SDK may finish a transport close asynchronously. The user's stop
      // request and the closed query remain authoritative for UI state.
      this.active = null;
      this.abort = null;
      this.busy = false;
      this.stage = "idle";
      this.completedAt = new Date().toISOString();
      this.completedTurnId = this.observedTurnId();
      for (const [id, activity] of this.activities)
        if (activity.status === "running") this.finishTool(id);
      this.publish();
    }
  }
  private closeActiveQuery() {
    const active = this.active;
    const abort = this.abort;
    this.active = null;
    this.abort = null;
    try {
      active?.close();
    } catch {
      // The SDK process may already have exited.
    }
    try {
      abort?.abort();
    } catch {
      // Query close is the primary lifecycle boundary.
    }
  }
  close() {
    this.closeActiveQuery();
    this.input?.close();
    this.input = null;
    this.pending.length = 0;
    this.busy = false;
    this.stage = "idle";
  }
  async compact() {
    if (this.busy || this.running)
      throw Object.assign(
        Error("当前任务仍在运行，请在本轮结束后再压缩"),
        { submission: "rejected" },
      );
    this.compaction = {
      id: `compact:${new Date().toISOString()}`,
      status: "running",
      started_at: new Date().toISOString(),
      completed_at: null,
      duration_ms: null,
    };
    this.publish();
    const pending: Pending = {
      text: "/compact",
      attachments: [],
      userId: randomUUID(),
      clientGenerated: true,
    };
    void this.run(pending);
  }
  setModel(preference: ModelPreference) {
    if (
      this.provider &&
      !this.provider.models.includes(preference.model)
    )
      throw Error(
        `所选模型 ${preference.model} 不属于当前 Provider ${this.provider.name}`,
      );
    this.model = preference.model || undefined;
    const query = this.active as
      (Query & { setModel?: (model: string) => Promise<void> | void }) | null;
    if (query?.setModel && this.model)
      void Promise.resolve(query.setModel(this.model)).catch(() => {});
  }
  runtime(): AgentRuntime {
    return {
      source: "claude_agent_sdk",
      session_id: this.id,
      state: this.busy ? "running" : "idle",
      last_activity_at: this.lastActivity,
      last_turn_ended_at: this.completedAt,
      ...(this.completedTurnId ? { completed_turn_id: this.completedTurnId } : {}),
      observed_at: new Date().toISOString(),
      reason: "Claude Agent SDK structured event stream",
      pending_question_count: 0,
      pending_questions: [],
    };
  }
  selectedModel(): string | null {
    return this.model || this.provider?.defaultModel || null;
  }
}

const runtimes = new Map<string, ClaudeRuntime>();

export function ensureClaudeRuntime(
  id: string,
  cwd: string,
  instructions?: string,
  preference?: ModelPreference,
  resume = false,
  provider: ClaudeProviderRuntime | null = null,
) {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = new ClaudeRuntime(id, cwd, instructions, preference, resume, provider);
    runtimes.set(id, runtime);
  } else {
    runtime.configure(provider, preference);
  }
  return runtime;
}
export function claudeRuntime(id: string) {
  return runtimes.get(id);
}
export function releaseClaudeRuntime(id: string) {
  const runtime = runtimes.get(id);
  if (runtime) {
    runtime.close();
    runtimes.delete(id);
  }
}
