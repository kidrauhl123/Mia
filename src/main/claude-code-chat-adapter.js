const { spawn: defaultSpawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnExecutable } = require("./agent-runtime/process-launcher.js");
const {
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");
const {
  buildContextBudgetLogLine,
  messagesAttachmentStats,
  messagesTextChars,
  textCharCount
} = require("./agent-context-budget.js");
const { personaBlockForNativeSession } = require("./native-persona-context.js");
const { skillMaterializationForNativeSession } = require("./native-skill-context.js");
const {
  buildMiaContextResource,
  mcpContextPrompt
} = require("./mia-context-resource.js");
const {
  fileEditPayloadFromUnifiedDiff,
  fileEditPayloadsFromAcpContent
} = require("./agent-file-edit-events.js");
const { promptMessagesForNativeSession } = require("./agent-prompt-messages.js");
const { mergeMcpServersWithReservedBuiltIns } = require("./mcp-reserved-servers.js");
const { schedulerDisallowedTools } = require("./scheduler-tool-guard.js");
const { buildSkillMaterializationContext } = require("../shared/skill-materializer.js");

function firstTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstTextValue).filter(Boolean).join("");
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "delta", "output", "message", "final_response"]) {
      const nested = firstTextValue(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

function claudeMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const direct = firstTextValue(message.text || message.content || message.delta);
  if (direct) return direct;
  const nested = message.message || message.data || {};
  return firstTextValue(nested.content || nested.text || nested.delta);
}

function normalizeClaudePermissionMode(value) {
  const id = String(value || "default").trim();
  if ([":danger-full-access", "danger-full-access", "yolo", "off", "never"].includes(id)) return "bypassPermissions";
  if (["default", "acceptEdits", "auto", "bypassPermissions", "plan", "dontAsk"].includes(id)) return id;
  return "default";
}

function envWithExecutableDirFirst(env = {}, executablePath = "") {
  const dir = path.dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const currentPath = String(env?.PATH || env?.Path || "");
  const delimiter = process.platform === "win32" && !currentPath.includes(";") && !/^[A-Za-z]:[\\/]/.test(currentPath)
    ? ":"
    : process.platform === "win32" ? ";" : path.delimiter;
  const parts = currentPath.split(delimiter).filter(Boolean).filter((item) => item !== dir);
  return {
    ...(env || {}),
    PATH: [dir, ...parts].join(delimiter)
  };
}

function statelessPrompt(systemPrompt, userPrompt) {
  return systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
}

function anthropicGatewayBaseUrl(managedModel = {}) {
  const explicit = String(managedModel.anthropicBaseUrl || managedModel.anthropic_base_url || "").trim();
  const fallback = String(managedModel.baseUrl || managedModel.base_url || "").trim();
  const value = explicit || fallback;
  if (!value) return "";
  return value.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function applyManagedClaudeModelEnv(baseEnv = {}, managedModel = {}) {
  const model = String(managedModel.model || "").trim();
  const apiKey = String(managedModel.apiKey || managedModel.api_key || "").trim();
  const baseUrl = anthropicGatewayBaseUrl(managedModel);
  if (!baseUrl && !apiKey && !model) return { ...baseEnv };
  const env = { ...baseEnv };
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || "1";
  }
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = model;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || "Mia";
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION || "Mia managed model";
  }
  return env;
}

function isMiaManagedClaudeModel(managedModel = {}) {
  const provider = String(managedModel.provider || "").trim();
  const authType = String(managedModel.authType || managedModel.auth_type || "").trim();
  return provider === "mia" || authType === "mia_account";
}

const managedClaudeProxySessions = new Map();

function isDurableAgentSession(sessionId, persistAgentSession) {
  return Boolean(persistAgentSession) && String(sessionId || "").startsWith("conversation:");
}

function secretDigest(value = "") {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function managedClaudeProxyKey(managedModel = {}, { bot, sessionId } = {}) {
  return JSON.stringify({
    engine: "claude-code",
    bot: String(bot?.key || bot?.id || ""),
    sessionId: String(sessionId || ""),
    provider: String(managedModel.provider || ""),
    authType: String(managedModel.authType || managedModel.auth_type || ""),
    model: String(managedModel.model || ""),
    baseUrl: String(managedModel.baseUrl || managedModel.base_url || managedModel.anthropicBaseUrl || managedModel.anthropic_base_url || ""),
    apiKey: secretDigest(managedModel.apiKey || managedModel.api_key || "")
  });
}

async function createOrReuseManagedClaudeProxy(factory, managedModel, context, { cache = false } = {}) {
  if (!cache) {
    return { session: await factory(managedModel, context), cached: false };
  }
  const key = managedClaudeProxyKey(managedModel, context);
  const existing = managedClaudeProxySessions.get(key);
  if (existing) return { session: existing, cached: true };
  const session = await factory(managedModel, context);
  managedClaudeProxySessions.set(key, session);
  return { session, cached: true };
}

function closeManagedClaudeProxySessions() {
  for (const session of managedClaudeProxySessions.values()) {
    try { session?.release?.(); } catch { /* ignore proxy cleanup */ }
  }
  managedClaudeProxySessions.clear();
}

function applyMiaClaudeProxyEnv(baseEnv = {}, proxySession = {}) {
  const baseUrl = String(proxySession.baseUrl || "").trim().replace(/\/+$/, "");
  const authToken = String(proxySession.authToken || "").trim();
  if (!baseUrl || !authToken) return { ...baseEnv };
  const env = { ...baseEnv };
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = authToken;
  env.ANTHROPIC_API_KEY = authToken;
  delete env.ANTHROPIC_MODEL;
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  delete env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  delete env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME;
  delete env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  return env;
}

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function isStaleClaudeResumeError(error) {
  const message = String(error?.message || error || "");
  if (!message) return false;
  const referencesResume = /\b(resume|session|conversation|thread)\b/i.test(message);
  const staleSignal = /(not\s+found|missing|invalid|unknown|does\s+not\s+exist|no\s+conversation|cannot\s+resume|can't\s+resume|failed\s+to\s+resume|unable\s+to\s+resume)/i.test(message);
  return referencesResume && staleSignal;
}

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
}

function createClaudeCodeProcessSpawner({
  appendEngineLog = () => {},
  platform = process.platform,
  spawn = defaultSpawn
} = {}) {
  return ({ command, args = [], cwd, env, signal } = {}) => {
    const debug = Boolean(env?.DEBUG_CLAUDE_AGENT_SDK || env?.DEBUG);
    const options = {
      cwd,
      env,
      stdio: ["pipe", "pipe", debug ? "pipe" : "ignore"]
    };
    if (signal) options.signal = signal;
    if (platform === "win32") options.windowsHide = true;
    const child = spawnExecutable(spawn, command, args, {
      ...options
    }, { platform });
    if (debug && child.stderr) {
      child.stderr.on("data", (chunk) => {
        for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
          appendEngineLog(`[ClaudeCode] ${line}`);
        }
      });
    }
    return child;
  };
}

function createClaudeCodeChatAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const lastUserPrompt = requireDependency(deps, "lastUserPrompt");
  const expandLeadingSkillCommand = requireDependency(deps, "expandLeadingSkillCommand");
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readBotPersona = requireDependency(deps, "readBotPersona");
  const claudeAgentSdk = requireDependency(deps, "claudeAgentSdk");
  const ensureClaudeBridgePlugin = requireDependency(deps, "ensureClaudeBridgePlugin");
  const appendEngineLog = requireDependency(deps, "appendEngineLog");
  const getAgentSessionEntry = requireDependency(deps, "getAgentSessionEntry");
  const setAgentSessionEntry = requireDependency(deps, "setAgentSessionEntry");
  const clearAgentSessionEntry = deps.clearAgentSessionEntry || (() => false);
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const getMiaAppMcpSpec = deps.getMiaAppMcpSpec || (() => null);
  const getSchedulerMcpSpec = requireDependency(deps, "getSchedulerMcpSpec");
  const getUserMcpSpecs = deps.getUserMcpSpecs || (() => ({}));
  const getMcpFingerprint = deps.getMcpFingerprint || (() => "");
  const ensureUserMcpReady = deps.ensureUserMcpReady || (async () => {});
  const writeSchedulerMcpContext = requireDependency(deps, "writeSchedulerMcpContext");
  const resolveManagedModelRuntime = deps.resolveManagedModelRuntime || (() => null);
  const ensureMiaClaudeProxy = deps.ensureMiaClaudeProxy || null;
  const permissionCoordinator = deps.permissionCoordinator || null;
  const enginePermissionMode = deps.enginePermissionMode || (() => "default");
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const cwd = deps.cwd || (() => process.cwd());
  const spawnClaudeCodeProcess = deps.spawnClaudeCodeProcess || createClaudeCodeProcessSpawner({
    appendEngineLog,
    platform: deps.platform || process.platform,
    spawn: deps.spawn || defaultSpawn
  });

  async function sendChat({ bot, sessionId, messages, group, signal, abortController, emit, utility = false, scheduledFire = false, persistAgentSession = !utility, runtimeConfig = null, skillMaterialization = null }) {
    const engine = "claude-code";
    const shouldPersistAgentSession = Boolean(persistAgentSession);
    const commandPath = shellCommandPath("claude");
    if (!commandPath) throw new Error("本机没有检测到 Claude Code CLI。请先安装并确认 `claude --version` 可用。");
    try {
      await ensureUserMcpReady();
    } catch (error) {
      appendEngineLog(`MCP bridge initialization incomplete before Claude Code chat: ${error?.message || error}`);
    }
    const lastUser = lastUserPrompt(promptMessagesForNativeSession(messages, shouldPersistAgentSession));
    // Best-effort: grab id from last user message for scheduler context
    const lastUserMessage = Array.isArray(messages) ? [...messages].reverse().find((m) => m?.role === "user") : null;
    const originMessageId = String(lastUserMessage?.id || "");
    try {
      writeSchedulerMcpContext({ botId: bot.key, sessionId, originMessageId });
    } catch (error) {
      appendEngineLog(`Scheduler MCP context write failed: ${error?.message || error}`);
    }
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "native" }) || lastUser);
    const schedulerMcpSpec = (() => {
      try { return getSchedulerMcpSpec(); } catch { return null; }
    })();
    const miaAppMcpSpec = (() => {
      try { return getMiaAppMcpSpec({ botId: bot.key, sessionId, originMessageId }); } catch { return null; }
    })();
    const runtimeContext = String(miaRuntimeSystemPrompt({ scheduledFire }) || "").trim();
    const miaContext = buildMiaContextResource({
      engine,
      bot,
      sessionId,
      runtimeConfig,
      modePrefix: "claude",
      mcpAvailable: Boolean(miaAppMcpSpec),
      runtimePrompt: runtimeContext
    });
    const nativeContextMode = miaContext.nativeContextMode;
    const rawPersona = nativeContextMode === "mcp"
      ? mcpContextPrompt(miaContext, { includeRuntime: true })
      : nativeContextMode === "prompt"
        ? withMiaRuntimeContext(readBotPersona(bot.key, bot.name, bot.bio), { scheduledFire })
        : "";
    const { query } = await claudeAgentSdk();
    let bridgePluginPath = "";
    let bridgeFingerprint = "";
    try {
      const bridge = ensureClaudeBridgePlugin();
      bridgePluginPath = bridge.path;
      bridgeFingerprint = bridge.fingerprint;
    } catch (error) {
      appendEngineLog(`Claude bridge plugin refresh failed: ${error?.message || error}`);
    }
    const mcpFingerprint = getMcpFingerprint();
    const sessionFingerprint = [bridgeFingerprint, mcpFingerprint].filter(Boolean).join(":");
    const savedEntry = shouldPersistAgentSession ? getAgentSessionEntry(engine, bot.key, sessionId) : {};
    const externalSessionId = savedEntry.id && savedEntry.fingerprint === sessionFingerprint
      ? savedEntry.id
      : "";
    const nativeSessionCacheKey = [
      engine,
      String(bot.key || bot.id || "bot"),
      String(sessionId || "default"),
      String(sessionFingerprint || "")
    ].join(":");
    const resetNativeSession = Boolean(savedEntry.id && !externalSessionId);
    function nativeSystemParts({ reset = false } = {}) {
      const nativePersona = personaBlockForNativeSession({
        engine,
        botId: bot.key,
        sessionId,
        nativeSessionId: nativeSessionCacheKey,
        persistAgentSession: shouldPersistAgentSession,
        personaBlock: rawPersona,
        resetNativeSession: reset
      });
      const nativeMemory = "";
      return {
        nativePersona,
        nativeMemory,
        systemAppend: nativePersona.trim()
      };
    }
    const initialNativeSystem = nativeSystemParts({ reset: resetNativeSession });
    const systemAppend = initialNativeSystem.systemAppend;
    const effectiveSkillMaterialization = skillMaterializationForNativeSession({
      engine,
      botId: bot.key,
      sessionId,
      nativeSessionId: nativeSessionCacheKey,
      persistAgentSession: shouldPersistAgentSession,
      skillMaterialization,
      resetNativeSession
    });
    const skillDeliveryMode = miaContext.skills.deliveryMode;
    const skillContext = buildSkillMaterializationContext(effectiveSkillMaterialization, {
      deliveryMode: skillDeliveryMode
    });
    const prompt = [skillContext, expandedPrompt]
      .filter(Boolean)
      .join("\n\n");
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const userMcpServers = getUserMcpSpecs();
    const turnConfig = {
      ...(bot.engineConfig && typeof bot.engineConfig === "object" ? bot.engineConfig : {}),
      ...(runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {})
    };
    const managedModel = resolveManagedModelRuntime(turnConfig, { engine, bot });
    const selectedModel = String(managedModel?.model || turnConfig.model || "").trim();
    let selectedModelForClaude = selectedModel;
    let releaseManagedModelSession = null;
    let releaseManagedModelAfterTurn = true;
    let managedEnv = processEnvStrings();
    if (isMiaManagedClaudeModel(managedModel || {})) {
      if (typeof ensureMiaClaudeProxy !== "function") {
        throw new Error("Mia Claude Code model proxy is unavailable.");
      }
      const proxy = await createOrReuseManagedClaudeProxy(
        ensureMiaClaudeProxy,
        managedModel,
        { engine, bot, sessionId },
        { cache: isDurableAgentSession(sessionId, shouldPersistAgentSession) }
      );
      const proxySession = proxy.session;
      releaseManagedModelSession = typeof proxySession.release === "function" ? proxySession.release : null;
      releaseManagedModelAfterTurn = !proxy.cached;
      managedEnv = applyMiaClaudeProxyEnv(managedEnv, proxySession);
      selectedModelForClaude = "";
    } else {
      managedEnv = applyManagedClaudeModelEnv(managedEnv, managedModel || {});
    }
    const env = envWithExecutableDirFirst(
      managedEnv,
      commandPath
    );
    const mcpServers = mergeMcpServersWithReservedBuiltIns({
      userServers: userMcpServers,
      builtInServers: {
        ...(miaAppMcpSpec ? { "mia-app": miaAppMcpSpec } : {}),
        ...(schedulerMcpSpec ? { "mia-scheduler": schedulerMcpSpec } : {})
      }
    });
    const options = {
      abortController,
      cwd: cwd(),
      pathToClaudeCodeExecutable: commandPath,
      env,
      spawnClaudeCodeProcess,
      tools: { type: "preset", preset: "claude_code" },
      disallowedTools: schedulerDisallowedTools(),
      settingSources: ["project", "user", "local"],
      permissionMode: normalizeClaudePermissionMode(enginePermissionMode(engine) || "default"),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemAppend
      },
      includePartialMessages: Boolean(emit),
      ...(bridgePluginPath ? { plugins: [{ type: "local", path: bridgePluginPath }], skills: "all" } : {}),
      ...(Object.keys(mcpServers).length ? { mcpServers } : {})
    };
    if (externalSessionId) options.resume = externalSessionId;
    if (selectedModelForClaude) options.model = selectedModelForClaude;
    options.effort = normalizeEffortLevel(turnConfig.effortLevel || "medium", "claude-code");
    if (options.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (permissionCoordinator && options.permissionMode !== "bypassPermissions") {
      options.canUseTool = async (toolName, input = {}, context = {}) => {
        let preview = "";
        try { preview = input ? JSON.stringify(input, null, 2).slice(0, 4000) : ""; } catch { preview = ""; }
        const decision = await permissionCoordinator.requestPermission({
          engine,
          botKey: bot.key,
          sessionId,
          signal: context.signal || signal,
          emit,
          toolName,
          title: context.title || `${bot.name || "Claude Code"} 想使用 ${context.displayName || toolName}`,
          description: context.description || context.decisionReason || "",
          preview,
          input
        });
        if (decision.decision === "allow") {
          return {
            behavior: "allow",
            updatedInput: input,
            toolUseID: context.toolUseID,
            decisionClassification: decision.scope === "always" ? "user_permanent" : "user_temporary"
          };
        }
        return {
          behavior: "deny",
          message: decision.message || "用户拒绝了工具权限。",
          toolUseID: context.toolUseID,
          decisionClassification: "user_reject"
        };
      };
    }
    const visibleHistoryMessages = Array.isArray(messages)
      ? messages.filter((message) => message !== lastUserMessage)
      : [];
    const attachments = messagesAttachmentStats(messages);
    appendEngineLog(buildContextBudgetLogLine({
      engine,
      botId: bot.key,
      sessionId,
      nativeSessionId: externalSessionId || nativeSessionCacheKey,
      transport: "claude-agent-sdk",
      historyMode: shouldPersistAgentSession ? "native" : "stateless",
      nativeHistory: shouldPersistAgentSession,
      promptChars: textCharCount(systemAppend) + textCharCount(promptWithGroup),
      currentUserChars: textCharCount(expandedPrompt),
      systemChars: textCharCount(systemAppend),
      personaChars: textCharCount(initialNativeSystem.nativePersona),
      memoryChars: textCharCount(initialNativeSystem.nativeMemory),
      skillIndexChars: textCharCount(effectiveSkillMaterialization?.indexBlock),
      loadedSkillChars: skillDeliveryMode === "mcp" ? 0 : textCharCount(effectiveSkillMaterialization?.loadedBlock),
      visibleHistoryChars: messagesTextChars(visibleHistoryMessages),
      includedHistoryChars: 0,
      groupChars: textCharCount(group?.contextBlock),
      attachmentCount: attachments.count,
      attachmentBytes: attachments.bytes
    }));

    let capturedSessionId = externalSessionId;
    const chunks = [];
    let activeTextId = null;
    const reasoningId = `reasoning_${randomUUID()}`;
    const blockIndex = new Map();
    let processedStreamMessage = false;

    async function consumeClaudeStream(runOptions) {
      const stream = query({ prompt: promptWithGroup, options: runOptions });
      for await (const message of stream) {
        if (signal?.aborted) break;
        processedStreamMessage = true;
        if (message?.session_id && !capturedSessionId) {
          capturedSessionId = message.session_id;
          if (shouldPersistAgentSession) setAgentSessionEntry(engine, bot.key, sessionId, capturedSessionId, sessionFingerprint);
        }

        if (emit && message?.type === "stream_event") {
          const ev = message.event;
          if (!ev) continue;
          if (ev.type === "content_block_start" && ev.content_block) {
            const idx = ev.index;
            const block = ev.content_block;
            if (block.type === "text") {
              if (!activeTextId) activeTextId = `text_${randomUUID()}`;
              blockIndex.set(idx, { kind: "text", id: activeTextId });
            } else if (block.type === "thinking") {
              blockIndex.set(idx, { kind: "thinking", id: reasoningId });
            } else if (block.type === "tool_use") {
              const toolId = String(block.id || `tool_${idx}`);
              const toolName = String(block.name || "tool");
              const preview = block.input ? JSON.stringify(block.input, null, 2) : "";
              blockIndex.set(idx, { kind: "tool_use", id: toolId, name: toolName, input: preview });
              emit("tool_call_started", { id: toolId, name: toolName, preview });
            }
          } else if (ev.type === "content_block_delta" && ev.delta) {
            const meta = blockIndex.get(ev.index);
            if (!meta) continue;
            if (ev.delta.type === "text_delta" && meta.kind === "text") {
              emit("text_delta", { id: meta.id, text: String(ev.delta.text || "") });
            } else if (ev.delta.type === "thinking_delta" && meta.kind === "thinking") {
              emit("reasoning_delta", { id: meta.id, text: String(ev.delta.thinking || "") });
            } else if (ev.delta.type === "input_json_delta" && meta.kind === "tool_use") {
              meta.input = `${meta.input || ""}${String(ev.delta.partial_json || "")}`;
              emit("tool_call_delta", {
                id: meta.id,
                name: meta.name,
                preview: meta.input.slice(0, 4000)
              });
            }
          }
          continue;
        }

        if (message?.type === "assistant") {
          const beta = message.message;
          const contentBlocks = Array.isArray(beta?.content) ? beta.content : [];
          const text = claudeMessageText(message);
          if (text) chunks.push(text);
          if (!emit) continue;
          activeTextId = null;
          if (!runOptions.includePartialMessages && text) {
            emit("text_delta", { id: `text_${randomUUID()}`, text });
          }
          for (const block of contentBlocks) {
            if (block?.type === "tool_use" && !runOptions.includePartialMessages) {
              const toolId = String(block.id || `tool_${randomUUID()}`);
              const toolName = String(block.name || "tool");
              const preview = block.input ? JSON.stringify(block.input).slice(0, 160) : "";
              emit("tool_call_started", { id: toolId, name: toolName, preview });
            }
          }
          continue;
        }

        if (emit && message?.type === "user") {
          const beta = message.message;
          const contentBlocks = Array.isArray(beta?.content) ? beta.content : [];
          for (const block of contentBlocks) {
            if (block?.type === "tool_result") {
              const toolId = String(block.tool_use_id || "");
              const resultPreview = firstTextValue(block.content).slice(0, 4000);
              const status = block.is_error ? "failed" : "completed";
              emit("tool_call_completed", {
                id: toolId,
                name: "",
                preview: resultPreview,
                duration: null,
                error: Boolean(block.is_error)
              });
              const contentDiffs = fileEditPayloadsFromAcpContent(block.content, {
                idPrefix: toolId || "claude_tool",
                status,
                error: Boolean(block.is_error)
              });
              const parsedDiff = fileEditPayloadFromUnifiedDiff(resultPreview, {
                id: `${toolId || "claude_tool"}_diff_0`,
                status,
                error: Boolean(block.is_error)
              });
              const fileEdits = contentDiffs.length ? contentDiffs : (parsedDiff ? [parsedDiff] : []);
              for (const fileEdit of fileEdits) emit("file_edit", fileEdit);
            }
          }
        }
      }
    }

    try {
      try {
        await consumeClaudeStream(options);
      } catch (error) {
        if (!processedStreamMessage && externalSessionId && isStaleClaudeResumeError(error)) {
          appendEngineLog(`Claude Code resume session failed; clearing saved session and retrying without resume: ${error?.message || error}`);
          try {
            clearAgentSessionEntry(engine, bot.key, sessionId);
          } catch (clearError) {
            appendEngineLog(`Claude Code saved session cleanup failed: ${clearError?.message || clearError}`);
          }
          capturedSessionId = "";
          activeTextId = null;
          blockIndex.clear();
          const retryOptions = {
            ...options,
            systemPrompt: {
              ...options.systemPrompt,
              append: nativeSystemParts({ reset: true }).systemAppend
            }
          };
          delete retryOptions.resume;
          await consumeClaudeStream(retryOptions);
        } else {
          throw error;
        }
      }
    } finally {
      try {
        if (releaseManagedModelAfterTurn && releaseManagedModelSession) releaseManagedModelSession();
      } catch {
        // Ignore cleanup failures; the proxy also expires idle sessions.
      }
    }
    if (capturedSessionId && !externalSessionId && shouldPersistAgentSession) {
      setAgentSessionEntry(engine, bot.key, sessionId, capturedSessionId, sessionFingerprint);
    }
    if (signal?.aborted) {
      if (emit) emit("complete", { finishReason: "cancelled", aborted: true });
      throw stoppedError();
    }
    if (emit) emit("complete", { finishReason: "stop", aborted: false });
    return chatCompletionResponse({
      id: capturedSessionId || `claude_${randomUUID()}`,
      model: "claude-code",
      content: chunks.join("\n").trim(),
      mia: {
        transport: "claude-agent-sdk",
        engine,
        session_id: capturedSessionId || "",
        bot_id: bot.key
      }
    });
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const commandPath = shellCommandPath("claude");
    if (!commandPath) throw new Error("本机没有检测到 Claude Code CLI。请先安装并确认 `claude --version` 可用。");
    const { query } = await claudeAgentSdk();
    const fullPrompt = statelessPrompt(systemPrompt, userPrompt);
    const options = {
      cwd: cwd(),
      pathToClaudeCodeExecutable: commandPath,
      env: envWithExecutableDirFirst(processEnvStrings(), commandPath),
      spawnClaudeCodeProcess,
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "user", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" }
    };
    const stream = query({ prompt: fullPrompt, options });
    const chunks = [];
    for await (const message of stream) {
      if (signal?.aborted) break;
      if (message?.type === "assistant") {
        const text = claudeMessageText(message);
        if (text) chunks.push(text);
      }
    }
    if (signal?.aborted) throw stoppedError();
    return { content: chunks.join("\n").trim() };
  }

  return { sendChat, sendStateless };
}

module.exports = {
  claudeMessageText,
  closeManagedClaudeProxySessions,
  createClaudeCodeProcessSpawner,
  createClaudeCodeChatAdapter,
  isMiaManagedClaudeModel,
  normalizeClaudePermissionMode
};
