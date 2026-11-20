import { purgeClaudeIdentity } from "./identity.js";
import { extractClaudePromptContext } from "./prompt-context.js";
import { decodeClaudeText } from "./text.js";
import { parseClaudeMessage, claudeRecordLimit } from "./history.js";
import { NATIVE_SESSION_ID_RE } from "../native-identifiers.js";
import { join } from "path";
import { randomUUID } from "crypto";
import { conversationMessageId } from "../../conversation-reader.js";
import { resolveClaudeDir } from "./archive.js";
import {
  claudeCommand,
  claudePermissions,
  claudeResources,
} from "./commands.js";
import {
  capabilities,
  requireNative,
  type AgentConnection,
  type AgentDefinition,
} from "../types.js";
import {
  readClaudeControls,
  readClaudeRuntime,
  applyClaudeControls,
  validateClaudeControls,
  compactClaudeConversation,
  readClaudeTelemetry,
  confirmedClaudeControls,
  readClaudeSessionModelPreference,
} from "./controls.js";
import { claudeManagement } from "./management.js";
import { managedModelPreference } from "../management-store.js";
import {
  canControlClaudeEnvironment,
  canUseClaudeEnvironment,
  claudeEnvironmentId,
} from "./providers.js";
export const claudeAdapter: AgentDefinition = {
  descriptor: {
    sessionHost: "managed",
    id: "claude",
    label: "Claude",
    presentation: { icon: "claude", order: 10, color: "#D97757" },
    capabilities: capabilities([
      "history",
      "runtime",
      "input",
      "cancelQueuedInput",
      "stream",
      "controls",
      "model",
      "newConversation",
      "reload",
      "interrupt",
      "stopTurn",
      "compact",
      "usage",
      "statistics",
      "launch",
      "resume",
      "attachments",
      "sharedResources",
    ]),
  },
  identity: {
    read: (session) =>
      session.native_session_id ?? session.claude_session_id ?? null,
    legacyField: "claude_session_id",
    purge: purgeClaudeIdentity,
    matchesProcess: (args) =>
      ["claude", "claude-code"].includes(
        args[0]?.split("/").at(-1)?.toLowerCase() || "",
      ),
  },
  history: {
    file: {
      turns: extractClaudePromptContext,
      relevant: (line) => /"type"\s*:\s*"(?:user|assistant|system)"/.test(line),
      locate: async (context) => {
        if (
          !context.nativeId ||
          !NATIVE_SESSION_ID_RE.test(context.nativeId) ||
          !context.projectPath
        )
          return null;
        const directory = resolveClaudeDir(context.projectPath);
        return directory ? join(directory, `${context.nativeId}.jsonl`) : null;
      },
      decode: decodeClaudeText,
      project: parseClaudeMessage,
      recordLimit: claudeRecordLimit,
      questionCall: () => null,
    },
  },
  runtime: {
    read: async (context) =>
      (await import("./sdk-runtime.js"))
        .claudeRuntime(requireNative(context))
        ?.runtime() ?? readClaudeRuntime(context),
    subscribe: () => () => {},
  },
  controls: {
    confirmed: confirmedClaudeControls,
    read: readClaudeControls,
    validate: validateClaudeControls,
    apply: applyClaudeControls,
  },
  environment: {
    storageId: claudeEnvironmentId,
    canUse: canUseClaudeEnvironment,
    canControl: canControlClaudeEnvironment,
  },
    telemetry: {
      read: readClaudeTelemetry,
      contextBreakdown: async (context) =>
        (await import("./context-breakdown.js")).readClaudeContextBreakdown(
          context,
        ),
    },
  input: {
    supportsClientIdentity: true,
    messageId: clientId => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId) ? conversationMessageId('', 'user', clientId) : undefined,
    cancelQueued: async (context, clientId) => {
      const runtime = (await import("./sdk-runtime.js")).claudeRuntime(
        requireNative(context),
      );
      if (!runtime) throw Error("Claude managed runtime is not connected");
      await runtime.cancelQueued(clientId);
    },
    submit: async (context, text, clientId, attachments) => {
      let provider = (
        await import("./providers.js")
      ).claudeRuntimeProvider(context.session, context.environmentAccess);
      if (!provider && !context.session.agent_environment_id)
        provider = (await import("./providers.js")).claudeNativeRuntimeProvider(context.environmentAccess);
      const runtime = (await import("./sdk-runtime.js")).ensureClaudeRuntime(
        requireNative(context),
        context.projectPath!,
        undefined,
        provider
          ? {
              model: runtimeModel(
                provider,
                readClaudeSessionModelPreference(context) ??
                  managedModelPreference("claude"),
                true,
              ),
              effort: "",
            }
          : undefined,
        true,
        provider,
      );
      const userId=clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId) ? clientId : undefined;
      return runtime.submit(text, clientId, attachments, userId);
    },
    afterTerminalSubmit: async () => {},
  },
  statistics: {
    read: async (_context, path) =>
      (await import("./statistics.js")).readClaudeStatistics(path),
    readProgress: async (_context, path) =>
      (await import("./statistics.js")).readClaudeProgress(path),
  },
  stream: {
    seed: async (context) => {
      if (!context.nativeId) throw Error("Claude managed session is not bound");
      const runtime = await import("./sdk-runtime.js");
      const live = runtime.claudeRuntime(context.nativeId);
      if (live) return { messages: live.snapshot().messages, generation: null };
      const reader = await import("../../conversation-reader.js");
      const page = await reader.readConversation(
        {
          ...context.session,
          cli_type: "claude",
          project_path: context.projectPath,
          codex_session_id: null,
          claude_session_id: context.nativeId,
        },
        { limit: 80 },
      );
      return { messages: page.messages, generation: page.generation };
    },
    observe: asyncObserve,
  },
  lifecycle: {
    bind: async () => {},
    preflight: async (context) => {
      const agent = await (
        await import("../../platform-ai/agents.js")
      ).detectWorkAgent("claude", context.projectPath || undefined, true);
      if (agent.status === "unavailable") throw Error(agent.reason);
      return null;
    },
    compact: compactClaudeConversation,
    prepareFresh: async (context,instructions,preference) => {
      if(!context.projectPath)throw Error("Claude managed session is missing project context");
      const nativeId=randomUUID();
      let provider=(await import("./providers.js")).claudeRuntimeProvider(context.session,context.environmentAccess);
      if(!provider&&!context.session.agent_environment_id)provider=(await import("./providers.js")).claudeNativeRuntimeProvider(context.environmentAccess);
      const runtime=(await import("./sdk-runtime.js")).ensureClaudeRuntime(nativeId,context.projectPath,instructions,provider?{model:runtimeModel(provider,preference),effort:""}:preference,false,provider);
      if(preference)
        (await import("./controls.js")).saveClaudeSessionModelPreference(
          {...context,nativeId},
          provider?{model:runtimeModel(provider,preference),effort:""}:preference,
        );
      return nativeId;
    },
    release: async (context) => {
      if (context.nativeId)
        (await import("./sdk-runtime.js")).releaseClaudeRuntime(
          context.nativeId,
        );
    },
    stopTurn: async (context, turnId) => {
      const runtime=(await import("./sdk-runtime.js")).claudeRuntime(requireNative(context));
      return runtime ? runtime.stopTurn(turnId) : false;
    },
    interrupt: async (context) => {
      if (context.nativeId)
        await (
          await import("./sdk-runtime.js")
        )
          .claudeRuntime(context.nativeId)
          ?.interrupt();
    },
  },
  launch: {
    supportsInitialClientId: true,
    prepare: async (context, task, instructions, resume, initialClientId) => {
      const nativeId = resume ? context.nativeId || undefined : randomUUID();
      if (!nativeId || !context.projectPath)
        throw Error("Claude managed session is missing project context");
      let provider = (
        await import("./providers.js")
      ).claudeRuntimeProvider(context.session, context.environmentAccess);
      if (!provider && !context.session.agent_environment_id)
        provider = (await import("./providers.js")).claudeNativeRuntimeProvider(context.environmentAccess);
      const selectedPreference=provider
        ? {
            model: runtimeModel(
              provider,
              readClaudeSessionModelPreference({...context,nativeId}) ??
                managedModelPreference("claude"),
              !!resume,
            ),
            effort: "",
          }
        : readClaudeSessionModelPreference({...context,nativeId}) ??
          managedModelPreference("claude") ??
          undefined;
      const runtime = (await import("./sdk-runtime.js")).ensureClaudeRuntime(
        nativeId,
        context.projectPath,
        instructions,
        selectedPreference,
        !!resume,
        provider,
      );
      const userId = !resume && task.trim() && initialClientId ? randomUUID() : undefined;
      if(selectedPreference)
        (await import("./controls.js")).saveClaudeSessionModelPreference(
          {...context,nativeId},
          selectedPreference,
        );
      if (!resume && task.trim()) await runtime.submit(task, initialClientId, [], userId);
      return { nativeId, ...userId ? {initialMessageId:conversationMessageId('', 'user', userId)} : {} };
    },
    ready: async () => {},
  },
  commands: {
    configure: claudePermissions,
    build: claudeCommand,
    permissions: claudePermissions,
    sharedResources: claudeResources,
  },
  management: claudeManagement({
    sessionHost: "managed",
    id: "claude",
    label: "Claude",
    presentation: { icon: "claude", order: 10, color: "#D97757" },
    capabilities: capabilities([
      "history",
      "runtime",
      "input",
      "cancelQueuedInput",
      "stream",
      "controls",
      "model",
      "newConversation",
      "reload",
      "interrupt",
      "stopTurn",
      "compact",
      "usage",
      "statistics",
      "launch",
      "resume",
      "attachments",
      "sharedResources",
    ]),
  }),
};

function asyncObserve(
  context: Parameters<NonNullable<AgentDefinition["stream"]["observe"]>>[0],
  emit: Parameters<NonNullable<AgentDefinition["stream"]["observe"]>>[1],
) {
  let stop:
      | AgentConnection
      | undefined,
    closed = false;
  void import("./sdk-runtime.js").then(async (module) => {
    if (closed) return;
    let provider = (
      await import("./providers.js")
    ).claudeRuntimeProvider(context.session, context.environmentAccess);
    if (!provider && !context.session.agent_environment_id)
      provider = (await import("./providers.js")).claudeNativeRuntimeProvider(
        context.environmentAccess,
      );
    if (closed) return;
    const runtime = module.ensureClaudeRuntime(
      context.nativeId!,
      context.projectPath!,
      undefined,
      provider
        ? {
            model: runtimeModel(
              provider,
              readClaudeSessionModelPreference(context) ??
                managedModelPreference("claude"),
              true,
            ),
            effort: "",
          }
        : undefined,
      true,
      provider,
    );
    if (!closed) stop = runtime.observe(emit);
  });
  return Object.assign(
    () => {
      closed = true;
      stop?.();
    },
    {
      respond: (id: string, answer: unknown) => {
        if (!stop) throw Error("Claude 实时连接尚未就绪");
        return stop.respond(id, answer);
      },
    },
  );
}

function runtimeModel(
  provider: { models: string[]; defaultModel: string | null },
  preference: { model?: string } | null | undefined,
  restore = false,
): string {
  const configured = preference && typeof preference.model === "string"
    ? preference.model
    : "";
  if (provider.models.includes(configured)) return configured;
  if (!configured && provider.defaultModel && provider.models.includes(provider.defaultModel))
    return provider.defaultModel;
  if (!configured && provider.models[0]) return provider.models[0];
  // A recovered native session may predate the Provider's current catalog.
  // Keep its exact persisted model instead of silently switching. New or
  // user-selected turns still reject a model outside the active catalog.
  if (restore && configured) return configured;
  throw Error(
    configured
      ? `所选模型 ${configured} 不在当前 Provider 的模型中`
      : "Claude Provider 没有默认模型",
  );
}
