import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedAgentStream } from "../src/services/agents/stream-hub.js";
import type {
  AgentContext,
  AgentStreamPort,
} from "../src/services/agents/types.js";
import type {
  AgentStreamFrame,
  AgentStreamSnapshot,
} from "../src/services/agents/events.js";
const context: AgentContext = {
  session: { id: "one", created_by_user_id: "owner" },
  nativeId: "native",
  projectPath: "/project",
  streamFormat: "incremental",
};
const snapshot: AgentStreamSnapshot = {
  type: "snapshot",
  messages: [],
  interactions: [],
  activities: [],
  compaction: null,
  busy: true,
  connected: true,
  turn_id: "turn",
  started_at: null,
  completed_at: null,
  stage: "answering",
};
let stop: ReturnType<typeof vi.fn>,
  emit: (frame: AgentStreamFrame) => void,
  source: AgentStreamPort,
  hub: AgentStreamPort;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  stop = vi.fn();
  source = {
    observe: vi.fn((_context, send) => {
      emit = send;
      return Object.assign(stop, { respond: vi.fn() });
    }),
  };
  hub = sharedAgentStream(source);
});
afterEach(async () => {
  await hub.shutdown?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("shared native stream", () => {
  it("shares a native subscription across viewers and monitors, replaying a complete baseline to a late viewer", () => {
    const first = vi.fn(),
      second = vi.fn(),
      monitor = vi.fn();
    const one = hub.observe(context, first);
    emit({
      ...snapshot,
      messages: [
        {
          id: "text",
          role: "assistant",
          text: "first",
          timestamp: null,
          streaming: true,
        },
      ],
    });
    const two = hub.observe(
      { ...context, session: { ...context.session, id: "second-tab" } },
      second,
    );
    hub.observe({ ...context, streamFormat: "state" }, monitor);
    expect(source.observe).toHaveBeenCalledOnce();
    expect(second).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "snapshot",
        baseline: true,
        messages: [expect.objectContaining({ text: "first" })],
      }),
    );
    const before = monitor.mock.calls.length;
    emit({
      type: "patch",
      upserts: [],
      deltas: [{ id: "text", offset: 5, text: " next" }],
    });
    expect(first).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "patch" }),
    );
    expect(monitor).toHaveBeenCalledTimes(before);
    const late = vi.fn();
    const third = hub.observe(context, late);
    expect(late).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ text: "first next" })],
      }),
    );
    one();
    two();
    third();
    expect(stop).not.toHaveBeenCalled();
  });
  it("keeps credentials isolated even when native IDs match", () => {
    hub.observe(context, vi.fn());
    hub.observe(
      {
        ...context,
        session: { id: "other", created_by_user_id: "other-user" },
      },
      vi.fn(),
    );
    expect(source.observe).toHaveBeenCalledTimes(2);
  });
  it("recovers failed initialization with backoff and never submits or recreates a native turn", async () => {
    const failedStop = vi.fn(),
      calls: AgentStreamFrame[] = [];
    vi.mocked(source.observe).mockImplementationOnce((_context, send) => {
      send({ type: "unavailable", reason: "transient", reconnect: true });
      return Object.assign(failedStop, { respond: vi.fn() });
    });
    hub = sharedAgentStream(source);
    const unsubscribe = hub.observe(context, (frame) => calls.push(frame));
    expect(failedStop).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toMatchObject({
      type: "unavailable",
      retrying: true,
      reconnect: false,
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(source.observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.observe).toHaveBeenCalledTimes(2);
    emit(snapshot);
    expect(calls.at(-1)).toMatchObject({ type: "snapshot" });
    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("cancels a recovery timer when the last subscriber leaves", async () => {
    vi.mocked(source.observe).mockImplementation((_context, send) => {
      send({ type: "unavailable", reason: "offline", reconnect: true });
      return Object.assign(stop, { respond: vi.fn() });
    });
    hub = sharedAgentStream(source);
    const close = hub.observe(context, vi.fn());
    close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(source.observe).toHaveBeenCalledOnce();
  });
  it("bounds replay history while retaining the actively streaming message", () => {
    const first = vi.fn();
    hub.observe(context, first);
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      role: "assistant" as const,
      text: "x".repeat(8192),
      timestamp: null,
      streaming: i === 0,
    }));
    emit({ ...snapshot, messages });
    const late = vi.fn();
    hub.observe(context, late);
    const replay = late.mock.calls.at(-1)![0] as AgentStreamSnapshot;
    expect(
      replay.messages.reduce((sum, message) => sum + message.text.length, 0),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(replay.messages.some((message) => message.id === "0")).toBe(true);
    expect(replay.messages.length).toBeLessThan(200);
  });
});
