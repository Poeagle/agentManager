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
import type {
  AgentConnection,
  AgentMessage,
  AgentRuntime,
  AgentStreamPort,
  ModelPreference,
} from "../types.js";
import type { AgentStreamSnapshot } from "../events.js";

type Listener = (frame: AgentStreamSnapshot) => void;
type Pending = {
  text: string;
  clientId?: string;
  attachments: ConversationAttachment[];
  userId: string;
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
    uuid: pending.userId as `${string}-${string}-${string}-${string}-${string}`,
  };
}

class ClaudeRuntime {
  private listeners = new Set<Listener>();
  private messages: AgentMessage[] = [];
  private activities = new Map<string, ConversationActivity>();
  private queue: Pending[] = [];
  private active: Query | null = null;
  private abort: AbortController | null = null;
  private busy = false;
  private stage: AgentStreamSnapshot["stage"] = "idle";
  private turnId: string | null = null;
  private startedAt: string | null = null;
  private completedAt: string | null = null;
  private assistantIds = new Set<string>();
  private assistantOrdinal = 0;
  private currentAssistant: AssistantEnvelope | null = null;
  private completedAssistants: AssistantEnvelope[] = [];
  private model: string | undefined;
  private lastActivity: string | null = null;
  private resumeOnNextQuery: boolean;

  constructor(
    readonly id: string,
    readonly cwd: string,
    private instructions?: string,
    preference?: ModelPreference,
    resume = false,
  ) {
    this.model = preference?.model || undefined;
    this.resumeOnNextQuery = resume;
  }

  snapshot(): AgentStreamSnapshot {
    return {
      type: "snapshot",
      messages: this.messages.slice(-128),
      interactions: [],
      activities: [...this.activities.values()],
      compaction: null,
      busy: this.busy,
      connected: true,
      turn_id: this.turnId,
      started_at: this.startedAt,
      completed_at: this.completedAt,
      stage: this.stage,
    };
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
  ): Promise<boolean | "queued"> {
    const pending = { text, clientId, attachments, userId: randomUUID() };
    if (this.busy) {
      this.queue.push(pending);
      return "queued";
    }
    void this.run(pending);
    return true;
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
        content_blocks: old.content_blocks,
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
      if (
        block?.type !== "text" ||
        typeof block.text !== "string" ||
        !block.text
      )
        continue;
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

  private consume(message: SDKMessage) {
    this.lastActivity = new Date().toISOString();
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
          streaming: false,
          error: { will_retry: false },
        });
      }
    }
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
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.assistantIds.clear();
    this.activities.clear();
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
      streaming: false,
    });
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    const sessionId = this.id;
    const prompt = (async function* () {
      yield await userMessage(pending, sessionId);
    })();
    const resume = this.resumeOnNextQuery;
    this.resumeOnNextQuery = true;
    const options: Options = {
      cwd: this.cwd,
      includePartialMessages: true,
      abortController: abort,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      tools: { type: "preset", preset: "claude_code" },
      persistSession: true,
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
    const conversation = query({ prompt, options });
    this.active = conversation;
    try {
      for await (const message of conversation) this.consume(message);
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
      this.active = null;
      this.abort = null;
      this.busy = false;
      this.stage = "idle";
      this.completedAt = new Date().toISOString();
      for (const id of this.assistantIds) {
        const message = this.messages.find((item) => item.id === id);
        if (message)
          this.upsert({
            ...message,
            phase: "final",
            streaming: false,
            timestamp: this.completedAt,
          });
      }
      for (const [id, activity] of this.activities)
        if (activity.status === "running") this.finishTool(id);
      this.publish();
      const next = this.queue.shift();
      if (next) void this.run(next);
    }
  }

  async stopTurn(turnId:string):Promise<boolean> {
    if(!this.busy||this.turnId!==turnId)return false;
    await this.interrupt();
    return true;
  }
  async interrupt() {
    this.abort?.abort();
    try {
      await this.active?.interrupt();
    } catch {
      /* Abort is authoritative. */
    }
  }
  setModel(preference: ModelPreference) {
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
      observed_at: new Date().toISOString(),
      reason: "Claude Agent SDK structured event stream",
      pending_question_count: 0,
      pending_questions: [],
    };
  }
}

const runtimes = new Map<string, ClaudeRuntime>();

export function ensureClaudeRuntime(
  id: string,
  cwd: string,
  instructions?: string,
  preference?: ModelPreference,
  resume = false,
) {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = new ClaudeRuntime(id, cwd, instructions, preference, resume);
    runtimes.set(id, runtime);
  }
  return runtime;
}
export function claudeRuntime(id: string) {
  return runtimes.get(id);
}
export function releaseClaudeRuntime(id: string) {
  const runtime = runtimes.get(id);
  if (runtime) {
    void runtime.interrupt();
    runtimes.delete(id);
  }
}
export const observeClaudeSDK: AgentStreamPort["observe"] = (context, emit) => {
  if (!context.nativeId || !context.projectPath)
    throw Error("Claude managed session is not bound");
  return ensureClaudeRuntime(
    context.nativeId,
    context.projectPath,
    undefined,
    undefined,
    true,
  ).observe(emit);
};
