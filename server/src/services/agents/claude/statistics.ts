import { open } from "fs/promises";
import { publicTokenCounters } from "../../conversation-usage.js";
import type {
  AgentProgressStatistics,
  AgentStatistics,
} from "../types.js";

const MAX_BYTES = 32 * 1024 * 1024;
interface State {
  inode: number;
  size: number;
  records: Array<{
    key: string;
    turnId: string;
    role: "user" | "assistant";
    timestamp: string | null;
    usage: Record<string, number | null> | null;
    tools: number;
    seq: number;
    text: string;
  }>;
}
const cache = new Map<string, State>();

export async function readClaudeStatistics(
  path: string,
): Promise<AgentStatistics[]> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const previous = cache.get(path);
    if (
      previous &&
      previous.inode === stat.ino &&
      previous.size === stat.size
    )
      return project(previous);
    const start = Math.max(0, stat.size - MAX_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    await file.read(bytes, 0, bytes.length, start);
    const records: State["records"] = [];
    let seq = 0;
    let turnId = "claude";
    let lastUser: string | null = null;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        entry.isSidechain === true ||
        entry.isMeta === true ||
        entry.message?.model === "<synthetic>"
      )
        continue;
      if (entry.type === "user") {
        if (
          Array.isArray(entry.message?.content) &&
          entry.message.content.some((block: any) => block?.type === "tool_result")
        )
          continue;
        lastUser = typeof entry.uuid === "string" ? entry.uuid : null;
        turnId = lastUser ?? turnId;
      }
      if (entry.type !== "assistant" && entry.type !== "user") continue;
      const content = entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.flatMap((block: any) =>
                typeof block?.text === "string" ? [block.text] : [],
              ).join("\n")
            : "";
      const tools = Array.isArray(content)
        ? content.filter((block: any) => block?.type === "tool_use").length
        : 0;
      const usage =
        entry.type === "assistant"
          ? claudeUsage(entry.message?.usage)
          : null;
      records.push({
        key:
          entry.type === "assistant" && typeof entry.message?.id === "string"
            ? entry.message.id
            : typeof entry.uuid === "string"
              ? entry.uuid
              : `${path}:${seq}`,
        turnId: entry.type === "assistant" ? entry.parentUuid ?? turnId : turnId,
        role: entry.type,
        timestamp:
          typeof entry.timestamp === "string" ? entry.timestamp : null,
        usage,
        tools,
        seq: seq++,
        text,
      });
    }
    const state = { inode: stat.ino, size: stat.size, records };
    cache.set(path, state);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return project(state);
  } finally {
    await file.close();
  }
}

function project(state: State): AgentStatistics[] {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let requests = 0;
  let tools = 0;
  return state.records.flatMap((record) => {
    if (record.usage) {
      requests++;
      tools += record.tools;
      for (const key of Object.keys(totals) as Array<keyof typeof totals>)
        totals[key] += record.usage[key] ?? 0;
    }
    if (record.role !== "assistant") return [];
    return [
      {
        sequence: record.seq,
        message_id: record.key,
        turn_id: record.turnId,
        tokens: record.usage ? { ...totals } : null,
        requests,
        tool_calls: tools,
        tool_rounds: requests,
        complete: true,
      },
    ];
  });
}

export async function readClaudeProgress(
  path: string,
): Promise<AgentProgressStatistics | null> {
  const stats = await readClaudeStatistics(path);
  const last = stats.at(-1);
  if (!last) return null;
  return {
    turn_id: last.turn_id,
    tokens: last.tokens,
    requests: last.requests,
    tool_calls: last.tool_calls,
    tool_rounds: last.tool_rounds,
    complete: true,
  };
}

function claudeUsage(value: unknown): Record<string, number | null> | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const number = (key: string) =>
    typeof usage[key] === "number" && Number.isFinite(usage[key])
      ? (usage[key] as number)
      : null;
  const input = number("input_tokens");
  const read = number("cache_read_input_tokens") ?? 0;
  const write = number("cache_creation_input_tokens") ?? 0;
  const output = number("output_tokens");
  if (input === null && output === null) return null;
  return {
    input_tokens: input === null ? null : input + read + write,
    cached_input_tokens: read,
    output_tokens: output,
    reasoning_output_tokens: null,
    total_tokens: (input ?? 0) + read + write + (output ?? 0),
  };
}
