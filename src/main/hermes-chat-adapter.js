const crypto = require("node:crypto");
const {
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof
} = require("./mia-runtime-context.js");
const {
  buildContextBudgetLogLine,
  messageTextChars,
  messagesAttachmentStats,
  messagesTextChars,
  textCharCount
} = require("./agent-context-budget.js");
const { skillMaterializationForNativeSession } = require("./native-skill-context.js");
const {
  buildMiaContextResource
} = require("./mia-context-resource.js");
const { buildSkillMaterializationContext } = require("../shared/skill-materializer.js");

function defaultNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") {
    throw new Error(`${key} dependency is required.`);
  }
  return deps[key];
}

function parseErrorMessage(text) {
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function runtimeConfigValue(config = {}, keys = []) {
  for (const key of keys) {
    const value = String(config?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function hasRuntimeModelReference(config = {}) {
  return Boolean(
    runtimeConfigValue(config, ["providerConnectionId", "provider_connection_id", "provider", "modelProvider", "model_provider"])
    || runtimeConfigValue(config, ["modelProfileId", "model_profile_id"])
    || runtimeConfigValue(config, ["model"])
    || runtimeConfigValue(config, ["authType", "auth_type"])
  );
}

function defaultMiaAutoRuntimeReference(config = {}) {
  return {
    ...config,
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto"
  };
}

function hermesSkillIndexModeFromConfig(bot = {}, runtimeConfig = null) {
  const botConfig = bot?.engineConfig || bot?.engine_config || {};
  const runtime = runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {};
  return runtime.hermesSkillIndexMode
    || runtime.hermes_skill_index_mode
    || runtime.nativeSkillIndexMode
    || runtime.native_skill_index_mode
    || runtime.skillIndexMode
    || runtime.skill_index_mode
    || botConfig.hermesSkillIndexMode
    || botConfig.hermes_skill_index_mode
    || botConfig.nativeSkillIndexMode
    || botConfig.native_skill_index_mode
    || botConfig.skillIndexMode
    || botConfig.skill_index_mode
    || "";
}

function hermesApiUnreachableError(error, stage) {
  const message = String(error?.message || error || "unknown error");
  const wrapped = new Error(`Hermes API is unreachable: ${message}`);
  wrapped.code = "HERMES_API_UNREACHABLE";
  wrapped.stage = stage;
  wrapped.retryable = true;
  wrapped.cause = error;
  return wrapped;
}

function createHermesChatAdapter(deps = {}) {
  const apiKey = requireDependency(deps, "apiKey");
  const baseUrl = requireDependency(deps, "baseUrl");
  const buildGroupHeader = requireDependency(deps, "buildGroupHeader");
  const buildRunPayload = requireDependency(deps, "buildRunPayload");
  const normalizeError = requireDependency(deps, "normalizeError");
  const readRunEventStream = requireDependency(deps, "readRunEventStream");
  const writeSchedulerMcpContext = requireDependency(deps, "writeSchedulerMcpContext");
  const writeMiaAppMcpContext = deps.writeMiaAppMcpContext || (() => {});
  const getMiaAppMcpSpec = deps.getMiaAppMcpSpec || (() => null);
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const fetchImpl = deps.fetch || fetch;
  const nowSeconds = deps.nowSeconds || defaultNowSeconds;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const responseModel = deps.responseModel || "hermes-agent";
  const runtimeSystemPrompt = deps.runtimeSystemPrompt || miaRuntimeSystemPrompt;
  const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
  const writeModelRuntimeConfig = deps.writeModelRuntimeConfig || (() => {});

  function resolveTurnRuntimeConfig(bot, runtimeConfig) {
    const botConfig = bot?.engineConfig || bot?.engine_config || {};
    const merged = {
      ...(botConfig && typeof botConfig === "object" ? botConfig : {}),
      ...(runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {})
    };
    const runtimeInput = Object.keys(merged).length && !hasRuntimeModelReference(merged)
      ? defaultMiaAutoRuntimeReference(merged)
      : merged;
    let resolved = null;
    try {
      resolved = resolveModelRuntime(runtimeInput, { engine: "hermes", bot });
    } catch (error) {
      throw error;
    }
    if (!resolved) return runtimeConfig;
    writeModelRuntimeConfig({
      provider: resolved.provider,
      providerLabel: resolved.providerLabel || resolved.provider,
      authType: resolved.authType || "api_key",
      model: resolved.model,
      apiKeyEnv: resolved.apiKeyEnv || "",
      apiKey: resolved.apiKey || "",
      baseUrl: resolved.baseUrl || "",
      apiMode: resolved.apiMode || ""
    });
    return {
      ...(runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {}),
      ...(runtimeInput && typeof runtimeInput === "object" ? runtimeInput : {}),
      provider: resolved.provider,
      providerConnectionId: resolved.providerConnectionId || resolved.provider,
      modelProfileId: resolved.modelProfileId || "",
      model: resolved.model
    };
  }

  function slashCommandResponse({ id, content }) {
    return {
      id,
      object: "chat.completion",
      created: nowSeconds(),
      model: responseModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || "(command completed)"
          },
          finish_reason: "stop"
        }
      ]
    };
  }

  async function createRun({ body, headers, signal, runtimeContext = {} }) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl()}/v1/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw hermesApiUnreachableError(error, "create_run");
    }
    const text = await response.text();
    if (!response.ok) {
      const message = parseErrorMessage(text);
      throw new Error(normalizeError(message, runtimeContext) || `${response.status} ${response.statusText}`);
    }
    const run = JSON.parse(text);
    const runId = run.run_id || run.id;
    if (!runId) throw new Error("Hermes did not return a run_id.");
    return runId;
  }

  async function sendChat({ bot, sessionId, messages, group, signal, emit, scheduledFire = false, persistAgentSession = true, runtimeConfig = null, skillMaterialization = null }) {
    // Tell the scheduler MCP which bot/session this turn belongs to, so a
    // schedule_create call fires the reminder back into this conversation.
    const lastUserMessage = Array.isArray(messages)
      ? [...messages].reverse().find((m) => m?.role === "user")
      : null;
    const originMessageId = String(lastUserMessage?.id || "");
    try {
      writeSchedulerMcpContext({ botId: bot.key, sessionId, originMessageId });
    } catch (error) {
      appendEngineLog(`Scheduler MCP context write failed: ${error?.message || error}`);
    }
    try {
      writeMiaAppMcpContext({ botId: bot.key, sessionId, originMessageId });
    } catch (error) {
      appendEngineLog(`Mia app MCP context write failed: ${error?.message || error}`);
    }
    const effectiveRuntimeConfig = resolveTurnRuntimeConfig(bot, runtimeConfig);
    const nativeSessionCacheKey = [
      effectiveRuntimeConfig?.hermesSessionScope
      || effectiveRuntimeConfig?.hermes_session_scope
      || effectiveRuntimeConfig?.sessionScope
      || effectiveRuntimeConfig?.session_scope
      || "bot-conversation",
      sessionId
    ].join(":");
    const runtimeContext = String(runtimeSystemPrompt({ scheduledFire }) || "").trim();
    const miaAppMcpAvailable = (() => {
      try {
        return Boolean(getMiaAppMcpSpec({ botId: bot.key, sessionId, originMessageId }));
      } catch {
        return false;
      }
    })();
    const miaContext = buildMiaContextResource({
      engine: "hermes",
      bot,
      sessionId,
      runtimeConfig: effectiveRuntimeConfig,
      modePrefix: "hermes",
      mcpAvailable: miaAppMcpAvailable,
      runtimePrompt: runtimeContext
    });
    const nativeContextMode = miaContext.nativeContextMode;
    const effectiveSkillMaterialization = skillMaterializationForNativeSession({
      engine: "hermes",
      botId: bot.key,
      sessionId,
      nativeSessionId: nativeSessionCacheKey,
      persistAgentSession,
      skillMaterialization,
      skillIndexMode: hermesSkillIndexModeFromConfig(bot, effectiveRuntimeConfig)
    });
    const skillDeliveryMode = miaContext.skills.deliveryMode;
    const skillContext = buildSkillMaterializationContext(effectiveSkillMaterialization, {
      deliveryMode: skillDeliveryMode
    });
    const skillMessages = skillContext && lastUserMessage
      ? messages.map((m) => (m === lastUserMessage
          ? {
              ...m,
              content: `${skillContext}\n\n${m.content != null ? m.content : (m.text || "")}`,
              text: `${skillContext}\n\n${m.text != null ? m.text : (m.content || "")}`
            }
          : m))
      : messages;
    const sanitizedMessages = skillMessages.map((message) => ({
      ...message,
      ...(typeof message?.content === "string" ? { content: sanitizeMiaMemorySpoof(message.content) } : {}),
      ...(typeof message?.text === "string" ? { text: sanitizeMiaMemorySpoof(message.text) } : {})
    }));
    const snapshotContext = miaContext.mcp.snapshotInstruction;
    const baseSystemContext = [runtimeContext, snapshotContext].filter(Boolean).join("\n\n");
    const miaMemory = miaContext.memory.prompt;
    const systemContext = baseSystemContext;
    const runMessages = systemContext
      ? [{ role: "system", content: systemContext }, ...sanitizedMessages]
      : sanitizedMessages;
    const runBody = buildRunPayload({
      bot,
      sessionId,
      messages: runMessages,
      model: effectiveRuntimeConfig?.model,
      effortLevel: effectiveRuntimeConfig?.effortLevel,
      permissionMode: effectiveRuntimeConfig?.permissionMode,
      sessionScope: effectiveRuntimeConfig?.hermesSessionScope
        || effectiveRuntimeConfig?.hermes_session_scope
        || effectiveRuntimeConfig?.sessionScope
        || effectiveRuntimeConfig?.session_scope
    });
    let lastUserIndex = -1;
    for (let index = sanitizedMessages.length - 1; index >= 0; index -= 1) {
      if (sanitizedMessages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const visibleHistoryMessages = lastUserIndex >= 0
      ? sanitizedMessages.filter((_, index) => index !== lastUserIndex)
      : sanitizedMessages.slice(0, -1);
    const currentUserChars = lastUserIndex >= 0
      ? messageTextChars(sanitizedMessages[lastUserIndex])
      : messageTextChars(sanitizedMessages.at(-1));
    const visibleHistoryChars = messagesTextChars(visibleHistoryMessages);
    const attachments = messagesAttachmentStats(sanitizedMessages);
    appendEngineLog(buildContextBudgetLogLine({
      engine: "hermes",
      botId: bot.key,
      sessionId,
      nativeSessionId: runBody.session_id || sessionId,
      historyMode: persistAgentSession ? "native" : "stateless",
      nativeHistory: persistAgentSession,
      promptChars: textCharCount(systemContext) + currentUserChars,
      currentUserChars,
      systemChars: textCharCount(systemContext),
      personaChars: 0,
      memoryChars: textCharCount(miaMemory),
      skillIndexChars: textCharCount(effectiveSkillMaterialization?.indexBlock),
      loadedSkillChars: skillDeliveryMode === "mcp" ? 0 : textCharCount(effectiveSkillMaterialization?.loadedBlock),
      visibleHistoryChars,
      includedHistoryChars: 0,
      groupChars: textCharCount(group?.contextBlock),
      attachmentCount: attachments.count,
      attachmentBytes: attachments.bytes
    }));
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
      "X-Mia-Bot": bot.key,
      "X-Alkaka-Bot": bot.key
    };
    if (group && group.contextBlock) {
      headers["X-Mia-Group-Context"] = buildGroupHeader(group.contextBlock);
    }
    const runId = await createRun({ body: runBody, headers, signal, runtimeContext: effectiveRuntimeConfig });
    const stream = await readRunEventStream({ runId, signal, emit, runtimeContext: effectiveRuntimeConfig });
    if (emit) emit("complete", { finishReason: stream.finishReason || "stop", aborted: false });
    return {
      id: runId,
      object: "chat.completion",
      created: nowSeconds(),
      model: responseModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: stream.content || ""
          },
          finish_reason: stream.finishReason
        }
      ],
      mia: {
        transport: "runs",
        run_id: runId,
        session_id: runBody.session_id,
        bot_id: bot.key,
        events: stream.events
      }
    };
  }

  async function sendStateless({ bot, systemPrompt, userPrompt, signal }) {
    const accountId = bot.account_id || bot.key;
    const routeProfile = bot.route_profile || accountId;
    const runBody = {
      model: responseModel,
      input: userPrompt,
      session_id: `_stateless_${randomUUID()}`,
      account_id: accountId,
      metadata: {
        bot_id: bot.key,
        persona_key: bot.key,
        account_id: accountId,
        route_profile: routeProfile,
        display_name: bot.name
      }
    };
    if (systemPrompt) runBody.instructions = systemPrompt;
    const runId = await createRun({
      body: runBody,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`
      },
      signal
    });
    const stream = await readRunEventStream({ runId, signal, emit: null });
    return { content: stream.content || "" };
  }

  return {
    sendChat,
    sendStateless,
    slashCommandResponse
  };
}

module.exports = {
  createHermesChatAdapter
};
