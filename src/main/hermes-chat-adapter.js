const crypto = require("node:crypto");
const {
  appendMiaMemoryBlock,
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof
} = require("./mia-runtime-context.js");

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

function createHermesChatAdapter(deps = {}) {
  const apiKey = requireDependency(deps, "apiKey");
  const baseUrl = requireDependency(deps, "baseUrl");
  const buildGroupHeader = requireDependency(deps, "buildGroupHeader");
  const buildRunPayload = requireDependency(deps, "buildRunPayload");
  const normalizeError = requireDependency(deps, "normalizeError");
  const readRunEventStream = requireDependency(deps, "readRunEventStream");
  const writeSchedulerMcpContext = requireDependency(deps, "writeSchedulerMcpContext");
  const writeMiaAppMcpContext = deps.writeMiaAppMcpContext || (() => {});
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const fetchImpl = deps.fetch || fetch;
  const nowSeconds = deps.nowSeconds || defaultNowSeconds;
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const responseModel = deps.responseModel || "hermes-agent";
  const buildEnabledSkillsContext = deps.buildEnabledSkillsContext || (() => "");
  const memoryBlock = deps.memoryBlock || (() => "");
  const runtimeSystemPrompt = deps.runtimeSystemPrompt || miaRuntimeSystemPrompt;
  const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
  const writeModelRuntimeConfig = deps.writeModelRuntimeConfig || (() => {});

  function resolveTurnRuntimeConfig(bot, runtimeConfig) {
    const botConfig = bot?.engineConfig || bot?.engine_config || {};
    const merged = {
      ...(botConfig && typeof botConfig === "object" ? botConfig : {}),
      ...(runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {})
    };
    let resolved = null;
    try {
      resolved = resolveModelRuntime(merged, { engine: "hermes", bot });
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

  async function createRun({ body, headers, signal }) {
    const response = await fetchImpl(`${baseUrl()}/v1/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
    const text = await response.text();
    if (!response.ok) {
      const message = parseErrorMessage(text);
      throw new Error(normalizeError(message) || `${response.status} ${response.statusText}`);
    }
    const run = JSON.parse(text);
    const runId = run.run_id || run.id;
    if (!runId) throw new Error("Hermes did not return a run_id.");
    return runId;
  }

  async function sendChat({ bot, sessionId, messages, group, signal, emit, scheduledFire = false, runtimeConfig = null }) {
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
    // Inject the bot's enabled skills into the user turn so Hermes uses them.
    const enabledSkills = buildEnabledSkillsContext(bot);
    const skillMessages = enabledSkills && lastUserMessage
      ? messages.map((m) => (m === lastUserMessage
          ? {
              ...m,
              content: `${enabledSkills}\n\n${m.content != null ? m.content : (m.text || "")}`,
              text: `${enabledSkills}\n\n${m.text != null ? m.text : (m.content || "")}`
            }
          : m))
      : messages;
    const sanitizedMessages = skillMessages.map((message) => ({
      ...message,
      ...(typeof message?.content === "string" ? { content: sanitizeMiaMemorySpoof(message.content) } : {}),
      ...(typeof message?.text === "string" ? { text: sanitizeMiaMemorySpoof(message.text) } : {})
    }));
    const runtimeContext = String(runtimeSystemPrompt({ scheduledFire }) || "").trim();
    const miaMemory = memoryBlock({ botId: bot.key, sessionId });
    const systemContext = appendMiaMemoryBlock(runtimeContext, miaMemory);
    const runMessages = systemContext
      ? [{ role: "system", content: systemContext }, ...sanitizedMessages]
      : sanitizedMessages;
    const effectiveRuntimeConfig = resolveTurnRuntimeConfig(bot, runtimeConfig);
    const runBody = buildRunPayload({
      bot,
      sessionId,
      messages: runMessages,
      model: effectiveRuntimeConfig?.model,
      effortLevel: effectiveRuntimeConfig?.effortLevel,
      permissionMode: effectiveRuntimeConfig?.permissionMode
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
      "X-Mia-Bot": bot.key,
      "X-Alkaka-Bot": bot.key
    };
    if (group && group.contextBlock) {
      headers["X-Mia-Group-Context"] = buildGroupHeader(group.contextBlock);
    }
    const runId = await createRun({ body: runBody, headers, signal });
    const stream = await readRunEventStream({ runId, signal, emit });
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
