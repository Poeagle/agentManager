import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readClaudeContextBreakdown } from "../src/services/agents/claude/context-breakdown.js";

const paths = vi.hoisted(() => ({ directory: "" }));
vi.mock("../src/services/agents/claude/archive.js", async () => ({
  ...(await vi.importActual("../src/services/agents/claude/archive.js")),
  resolveClaudeDir: () => paths.directory,
}));
vi.mock("../src/services/agents/claude/controls.js", () => ({
  readClaudeControls: async () => ({ usage: null }),
}));

const native = "019ff001-1212-7212-8212-121212121212";
beforeEach(() => {
  paths.directory = mkdtempSync(join(tmpdir(), "claude-context-"));
});
afterEach(() => {
  rmSync(paths.directory, { recursive: true, force: true });
});

it("reads Claude's native JSONL into the shared context category contract", async () => {
  writeFileSync(
    join(paths.directory, `${native}.jsonl`),
    [
      {
        type: "user",
        timestamp: "2026-11-15T01:00:00Z",
        message: { role: "user", content: "Inspect the project" },
      },
      {
        type: "assistant",
        timestamp: "2026-11-15T01:01:00Z",
        message: {
          model: "claude-opus-4-8",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Read the files." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "README.md" },
            },
            { type: "text", text: "Inspection complete." },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-11-15T01:01:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "# Project",
            },
          ],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        timestamp: "2026-11-15T01:02:00Z",
        compactMetadata: {
          preTokens: 1000,
          postTokens: 200,
          durationMs: 3000,
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const result = await readClaudeContextBreakdown({
    nativeId: native,
    projectPath: "/project",
    session: { id: "session" },
  });
  expect(result).toMatchObject({
    source: "jsonl",
    exact: false,
    method: "characters_div_3",
    model: "claude-opus-4-8",
    compactions: 1,
    records_read: 4,
  });
  expect(result.categories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "user", count: 1 }),
      expect.objectContaining({ id: "assistant", count: 1 }),
      expect.objectContaining({ id: "calls", count: 1 }),
      expect.objectContaining({ id: "results", count: 1 }),
    ]),
  );
});
