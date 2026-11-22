import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseClaudeMessage } from "../src/services/agents/claude/history.js";
import { conversationMessageId } from "../src/services/conversation-reader.js";
import { readConversation } from "../src/services/conversation-reader.js";
import { projectAttachmentDirectory } from "../src/services/attachment-storage.js";
import { rememberConversationAttachments } from "../src/services/conversation-attachments.js";
import { prepareBriefSend, parseBriefContext } from "../src/shared/conversation-brief.js";
import { createTestDatabase } from "./helpers/database.js";
import { getDb } from "../src/db/index.js";

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
  it('restores embedded screenshots into brief context without matching by repeated text alone', async () => {
    const fixture=createTestDatabase();
    try {
      paths.directory=join(fixture.dir,'transcripts');mkdirSync(paths.directory);
      const project=join(fixture.dir,'project');mkdirSync(project);
      const sessionId='brief-session',nativeId='019ff001-1212-7212-8212-121212121212';
      getDb().prepare("INSERT INTO projects(id,name,path) VALUES('p','P',?)").run(project);
      getDb().prepare("INSERT INTO sessions(id,project_id,task,status,claude_session_id) VALUES(?,'p','Test','running',?)").run(sessionId,nativeId);
      const directory=projectAttachmentDirectory(project,true);
      const bytes=Buffer.from('screenshot');
      const image={kind:'image' as const,name:'screen.png',path:join(directory,'screen.png')};
      const other={kind:'image' as const,name:'other.png',path:join(directory,'other.png')};
      writeFileSync(image.path,bytes);writeFileSync(other.path,'different screenshot');
      rememberConversationAttachments(sessionId,'browser-screen','看图',[image],true);
      rememberConversationAttachments(sessionId,'browser-other','看图',[other],true);
      const content=[{type:'image',source:{type:'base64',data:bytes.toString('base64')}},{type:'text',text:'看图'}];
      writeFileSync(join(paths.directory,`${nativeId}.jsonl`),[
        {type:'user',uuid:'text-only',message:{role:'user',content:'看图'}},
        {type:'user',uuid:'image-input',message:{role:'user',content}},
      ].map(value=>JSON.stringify(value)+'\n').join(''));
      const page=await readConversation({id:sessionId,cli_type:'claude',claude_session_id:nativeId,codex_session_id:null,project_path:project});
      expect(page.messages[0]).not.toHaveProperty('attachments');
      expect(page.messages[1].attachments).toEqual([image]);
      const result=await prepareBriefSend(sessionId,nativeId,{input:'继续'},async()=>({...page,session_id:sessionId,native_id:nativeId}));
      expect(parseBriefContext(result.input)?.context.turns[1].attachments).toEqual([image]);
      expect(result.attachments).toBeUndefined();
      expect(result.input).not.toContain(bytes.toString('base64'));
    } finally { fixture.cleanup(); }
  });
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
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 3,
        },
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
    expect(page.messages[1].content_blocks).toEqual([
      { type: "text", index: 0, text: "开始检查。" },
    ]);
    expect(page.messages[1].id).toBe(
      conversationMessageId("", "assistant", "assistant-message"),
    );
    expect(page.statistics).toEqual([
      expect.objectContaining({
        message_id: page.messages[1].id,
        turn_id: "user-record",
        requests: 1,
        tool_calls: 1,
        tokens: {
          input_tokens: 30,
          cached_input_tokens: 20,
          output_tokens: 3,
          reasoning_output_tokens: 0,
          total_tokens: 33,
        },
      }),
    ]);
    expect(page.messages[1].statistics).toEqual(page.statistics![0]);
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
