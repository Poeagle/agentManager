import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readClaudeProgress,
  readClaudeStatistics,
} from "../src/services/agents/claude/statistics.js";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claude-statistics-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("projects Claude request usage and tools through the shared statistics contract", async () => {
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    [
      {
        type: "user",
        uuid: "user-1",
        timestamp: "2026-11-15T01:00:00Z",
        message: { role: "user", content: "Inspect" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: "2026-11-15T01:00:01Z",
        message: {
          id: "assistant-message-1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "text", text: "Done" },
          ],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 3,
          },
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const result = await readClaudeStatistics(path);
  expect(result).toEqual([
    expect.objectContaining({
      message_id: "assistant-message-1",
      turn_id: "user-1",
      tokens: expect.objectContaining({
        input_tokens: 35,
        cached_input_tokens: 20,
        output_tokens: 3,
        total_tokens: 38,
      }),
      requests: 1,
      tool_calls: 1,
      tool_rounds: 1,
      complete: true,
    }),
  ]);
  expect(await readClaudeProgress(path)).toEqual({
    turn_id: "user-1",
    tokens: expect.objectContaining({ total_tokens: 38 }),
    requests: 1,
    tool_calls: 1,
    tool_rounds: 1,
    complete: true,
  });
});

it("attributes Claude multi-record turns to their user message without double-counting one API request", async () => {
  const path = join(directory, "multi-record.jsonl");
  writeFileSync(
    path,
    [
      {
        type: "user",
        uuid: "test-user",
        timestamp: "2026-11-19T00:10:14Z",
        message: { role: "user", content: "detail" },
      },
      {
        type: "assistant",
        uuid: "assistant-thinking",
        parentUuid: "test-user",
        timestamp: "2026-11-19T00:10:15Z",
        message: {
          id: "msg_same",
          role: "assistant",
          content: [{ type: "thinking", thinking: "plan" }],
          usage: { input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 10 },
        },
      },
      {
        type: "user",
        uuid: "tool-result",
        parentUuid: "assistant-thinking",
        timestamp: "2026-11-19T00:10:16Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-final",
        parentUuid: "tool-result",
        timestamp: "2026-11-19T00:10:17Z",
        message: {
          id: "msg_same",
          role: "assistant",
          content: [{ type: "text", text: "completed" }],
          usage: { input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 10 },
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const result = await readClaudeStatistics(path);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    message_id: "msg_same",
    turn_id: "test-user",
    tokens: { total_tokens: 114 },
    requests: 1,
  });
});
