import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseClaudeMessage } from "../src/services/agents/claude/history.js";
import { conversationMessageId } from "../src/services/conversation-reader.js";
import { readConversation } from "../src/services/conversation-reader.js";

const paths = vi.hoisted(() => ({ directory: "" }));
vi.mock("../src/services/agents/claude/archive.js", async () => ({
  ...(await vi.importActual("../src/services/agents/claude/archive.js")),
  resolveClaudeDir: () => paths.directory,
}));
afterEach(() => {
  if (paths.directory)
    rmSync(paths.directory, { recursive: true, force: true });
  paths.directory = "";
});

const record = (uuid: string, messageId: string, text: string) =>
  Buffer.from(
    JSON.stringify({
      type: "assistant",
      uuid,
      parentUuid: "user-turn",
      timestamp: "2026-11-08T10:00:00Z",
      message: {
        id: messageId,
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
    }) + "\n",
  );

describe("Claude history identity", () => {
  it("uses the API message ID shared by multiple JSONL records", () => {
    const first = parseClaudeMessage(
      record("record-one", "api-message-one", "回复"),
    );
    const mirror = parseClaudeMessage(
      record("record-two", "api-message-one", "回复"),
    );
    expect(first?.itemId).toBe("api-message-one");
    expect(mirror?.itemId).toBe("api-message-one");
    expect(conversationMessageId("", first!.message.role, first!.itemId)).toBe(
      conversationMessageId("", mirror!.message.role, mirror!.itemId),
    );
  });
  it("projects ordered text and tool blocks from persisted assistant messages", () => {
    const parsed = parseClaudeMessage(
      Buffer.from(
        JSON.stringify({
          type: "assistant",
          uuid: "record-with-tool",
          parentUuid: "user-turn",
          timestamp: "2026-11-08T10:00:00Z",
          message: {
            id: "api-message-tool",
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "先检查。" },
              {
                type: "tool_use",
                id: "tool-use-1",
                name: "Bash",
                input: { command: "pwd" },
              },
            ],
          },
        }),
      ),
    );
    expect(parsed?.contentBlocks).toEqual([
      { type: "text", index: 0, text: "先检查。" },
      {
        type: "tool_use",
        index: 1,
        id: "tool-use-1",
        name: "Bash",
        input: { command: "pwd" },
        status: "completed",
      },
    ]);
  });
});

describe("Claude durable conversation projection", () => {
  it("uses the generic bounded index and folds tool results into tool cards", async () => {
    paths.directory = mkdtempSync(join(tmpdir(), "claude-history-"));
    const native = "019ff001-1212-7212-8212-121212121212";
    const file = join(paths.directory, `${native}.jsonl`);
    const user = {
      type: "user",
      uuid: "user-record",
      parentUuid: null,
      timestamp: "2026-11-08T10:00:00Z",
      message: { role: "user", content: "检查项目" },
    };
    const assistant = {
      type: "assistant",
      uuid: "assistant-record",
      parentUuid: "user-record",
      timestamp: "2026-11-08T10:00:01Z",
      message: {
        id: "assistant-message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "开始检查。" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "pwd" },
          },
        ],
      },
    };
    const result = {
      type: "user",
      uuid: "result-record",
      parentUuid: "assistant-record",
      timestamp: "2026-11-08T10:00:02Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "/workspace" },
        ],
      },
    };
    writeFileSync(
      file,
      [user, assistant, result]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const page = await readConversation({
      cli_type: "claude",
      claude_session_id: native,
      codex_session_id: null,
      project_path: "/fixture",
    });
    expect(page.available).toBe(true);
    expect(page.messages.map((message) => message.text)).toEqual([
      "检查项目",
      "开始检查。",
    ]);
    expect(page.messages.map((message) => message.text)).toEqual([
      "检查项目",
      "开始检查。",
    ]);
    expect(page.messages[1].content_blocks).toEqual([
      { type: "text", index: 0, text: "开始检查。" },
      {
        type: "tool_use",
        index: 1,
        id: "tool-1",
        name: "Bash",
        input: { command: "pwd" },
        status: "completed",
        result: "/workspace",
      },
    ]);
    expect(page.messages[1].id).toBe(
      conversationMessageId("", "assistant", "assistant-message"),
    );
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        uuid: "final-record",
        parentUuid: "result-record",
        timestamp: "2026-11-08T10:00:03Z",
        message: {
          id: "final-message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "检查完成。" }],
        },
      }) + "\n",
    );
    const next = await readConversation(
      {
        cli_type: "claude",
        claude_session_id: native,
        codex_session_id: null,
        project_path: "/fixture",
      },
      { after: page.messages.at(-1)!.id },
    );
    expect(next.messages.map((message) => message.text)).toEqual([
      "检查完成。",
    ]);
  });
});
