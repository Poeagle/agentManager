import { readClaudeControls } from "./controls.js";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { resolveClaudeDir } from "./archive.js";
import type {
  AgentContext,
  AgentContextBreakdown,
} from "../types.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 200_000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

const names: Record<string, string> = {
  system: "系统提示",
  injections: "上下文注入",
  tools: "工具 schemas",
  user: "用户消息",
  assistant: "助手回复（纯文本）",
  calls: "助手工具调用",
  results: "工具结果",
};

function tokens(text: string) {
  return text ? Math.max(1, Math.ceil(text.length / 3)) : 0;
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as Record<string, unknown>;
      if (value.type === "tool_result") return [contentText(value.content)];
      return typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

export async function readClaudeContextBreakdown(
  context: AgentContext,
): Promise<AgentContextBreakdown> {
  if (!context.nativeId || !context.projectPath)
    throw Error("会话尚未绑定 Claude 原生记录");
  const directory = resolveClaudeDir(context.projectPath);
  if (!directory) throw Error("找不到 Claude 历史目录");
  const path = join(directory, `${context.nativeId}.jsonl`);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw Error("Claude 原生记录暂不可用");
  const start = Math.max(0, info.size - MAX_BYTES);
  const bytes = await readFile(path);
  const text = bytes
    .subarray(start)
    .toString("utf8")
    .split("\n");
  const categories = new Map<
    string,
    {
      id: string;
      name: string;
      tokens: number;
      count: number;
      detail: Map<string, { name: string; tokens: number; count: number }>;
    }
  >();
  let records = 0;
  let read = 0;
  let partial = start > 0;
  let observedAt: string | null = null;
  let model: string | null = null;
  let compactions = 0;
  const add = (id: string, value: string, detail?: string) => {
    if (!value) return;
    const count = tokens(value);
    const category = categories.get(id) ?? {
      id,
      name: names[id],
      tokens: 0,
      count: 0,
      detail: new Map(),
    };
    category.tokens += count;
    category.count++;
    if (detail) {
      const key = detail.slice(0, 120);
      const entry = category.detail.get(key) ?? {
        name: key,
        tokens: 0,
        count: 0,
      };
      entry.tokens += count;
      entry.count++;
      category.detail.set(key, entry);
    }
    categories.set(id, category);
  };
  for (const line of text) {
    read += Buffer.byteLength(line) + 1;
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      partial = true;
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      partial = true;
      continue;
    }
    records++;
    if (records > MAX_RECORDS) {
      partial = true;
      break;
    }
    if (typeof record.timestamp === "string") observedAt = record.timestamp;
    if (
      record.type === "system" &&
      record.subtype === "compact_boundary"
    ) {
      compactions++;
      continue;
    }
    const message = record.message;
    if (!message) continue;
    if (
      record.type === "assistant" &&
      typeof message.model === "string" &&
      !message.model.startsWith("<")
    )
      model = message.model;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        add(
          "calls",
          JSON.stringify({ name: block.name, input: block.input }),
          String(block.name || "工具"),
        );
      }
      if (block.type === "tool_result") {
        add("results", contentText(block.content));
      }
    }
    if (
      record.type === "user" &&
      !content.some((block: any) => block?.type === "tool_result")
    )
      add(
        "user",
        contentText(message.content),
        /^# AGENTS\.md instructions/.test(
          contentText(message.content),
        )
          ? "项目规则"
          : undefined,
      );
    else if (
      record.type === "assistant" &&
      Array.isArray(message.content)
    )
      add("assistant", contentText(message.content));
  }
  const controls = await readClaudeControls(context).catch(() => null);
  const result: AgentContextBreakdown = {
    source: "jsonl",
    exact: false,
    method: "characters_div_3",
    checked_at: new Date().toISOString(),
    observed_at: observedAt,
    model,
    usage: controls?.usage ?? null,
    partial,
    warnings: partial ? ["较早历史未纳入分类"] : [],
    files_read: 1,
    records_read: records,
    bytes_read: read,
    compactions,
    categories: [...categories.values()].map((category) => ({
      id: category.id,
      name: category.name,
      tokens: category.tokens,
      count: category.count,
      detail: [...category.detail.values()].slice(0, 100),
    })),
  };
  return result;
}
