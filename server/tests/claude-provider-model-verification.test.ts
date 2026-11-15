import { afterEach, expect, it, vi } from "vitest";
import { verifyClaudeProviderModel } from "../src/services/agents/claude/providers.js";

const provider = {
  id: "provider-a",
  name: "Provider A",
  baseUrl: "https://a.example",
  authToken: "secret",
  models: ["claude-opus-4-8", "claude-sonnet-4-6"],
  defaultModel: "claude-opus-4-8",
  contextWindow: null,
  maxOutputTokens: null,
};
afterEach(() => vi.unstubAllGlobals());

it("requires the upstream response model to match the selected model", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ model: "claude-opus-4-8" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    verifyClaudeProviderModel(provider, "claude-opus-4-8"),
  ).resolves.toBe("claude-opus-4-8");
  expect(fetch).toHaveBeenCalledWith(
    "https://a.example/v1/messages",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "x-api-key": "secret",
        Authorization: "Bearer secret",
      }),
      body: expect.stringContaining('"model":"claude-opus-4-8"'),
    }),
  );
});

it("rejects a provider route that silently returns another model", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ model: "grok-4.6" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  await expect(
    verifyClaudeProviderModel(provider, "claude-opus-4-8"),
  ).rejects.toThrow("实际返回模型 grok-4.6");
});

it("rejects a model outside the selected provider before making a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    verifyClaudeProviderModel(provider, "claude-haiku-5-5"),
  ).rejects.toThrow("不属于 Provider");
  expect(fetch).not.toHaveBeenCalled();
});
