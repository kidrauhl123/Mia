const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
const { skillMaterializationForNativeSession } = require("./native-skill-context.js");
const {
  buildMiaContextResource
} = require("./mia-context-resource.js");
const { promptMessagesForNativeSession } = require("./agent-prompt-messages.js");
const { mergeMcpServersWithReservedBuiltIns } = require("./mcp-reserved-servers.js");
const { buildSkillMaterializationContext } = require("../shared/skill-materializer.js");

const CODEX_MANAGED_PROTOCOLS = Object.freeze(["cli", "codex-cli", "codex-app-server"]);

function elapsedMs(startedAt) {
  return `${Math.max(0, Date.now() - startedAt)}ms`;
}

function mapCodexPermissionMode(value) {
  const id = String(value || "default").trim();
  if (id === ":read-only") {
    return { permissionProfile: ":read-only", sandboxMode: "read-only", approvalPolicy: "never" };
  }
  if (id === ":workspace") {
    return { permissionProfile: ":workspace", sandboxMode: "workspace-write", approvalPolicy: "never" };
  }
  if (id === ":danger-full-access") {
    return { permissionProfile: ":danger-full-access", sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (id === "acceptEdits") return { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
  if (id === "bypassPermissions" || id === "yolo" || id === "off" || id === "never") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (id === "readOnly") return { sandboxMode: "read-only", approvalPolicy: "never" };
  return { sandboxMode: "workspace-write", approvalPolicy: "untrusted" };
}

function statelessPrompt(systemPrompt, userPrompt) {
  return systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
}

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function generatedImagesRoot(env = {}) {
  const codexHome = String(env.CODEX_HOME || "").trim();
  if (codexHome) return path.join(codexHome, "generated_images");
  const home = String(env.HOME || "").trim() || os.homedir();
  return path.join(home, ".codex", "generated_images");
}

function recentGeneratedImagePaths(sessionId, { env = {}, startedAtMs = 0, max = 8 } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const dir = path.join(generatedImagesRoot(env), id);
  if (!fs.existsSync(dir)) return [];
  const since = Number(startedAtMs) - 5000;
  return fs.readdirSync(dir)
    .filter((name) => /\.(?:png|jpe?g|webp)$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item) => item && item.mtimeMs >= since)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-max)
    .map((item) => item.filePath);
}

function contentWithGeneratedImages(content, imagePaths = []) {
  const text = String(content || "").trim();
  const paths = imagePaths.filter(Boolean);
  if (!paths.length) return text;
  return text;
}

function mimeForImagePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function generatedImageAttachments(imagePaths = []) {
  return imagePaths.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return null;
      const mime = mimeForImagePath(filePath);
      const dataUrl = `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
      return {
        id: `generated:${crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16)}`,
        name: path.basename(filePath),
        path: filePath,
        mime,
        size: stat.size,
        kind: "image",
        thumbnailDataUrl: dataUrl,
        dataUrl
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
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

function isMiaManagedCodexModel(managedModel = {}) {
  const provider = String(managedModel.provider || "").trim();
  const authType = String(managedModel.authType || managedModel.auth_type || "").trim();
  return provider === "mia" || authType === "mia_account";
}

const managedCodexProxySessions = new Map();

function isDurableAgentSession(sessionId, persistAgentSession) {
  return Boolean(persistAgentSession) && String(sessionId || "").startsWith("conversation:");
}

function secretDigest(value = "") {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function managedCodexProxyKey(managedModel = {}, { bot, sessionId } = {}) {
  return JSON.stringify({
    engine: "codex",
    bot: String(bot?.key || bot?.id || ""),
    sessionId: String(sessionId || ""),
    provider: String(managedModel.provider || ""),
    authType: String(managedModel.authType || managedModel.auth_type || ""),
    model: String(managedModel.model || ""),
    baseUrl: String(managedModel.baseUrl || managedModel.base_url || ""),
    apiKey: secretDigest(managedModel.apiKey || managedModel.api_key || "")
  });
}

async function createOrReuseManagedCodexProxy(factory, managedModel, context, { cache = false } = {}) {
  if (!cache) {
    return { session: await factory(managedModel, context), cached: false };
  }
  const key = managedCodexProxyKey(managedModel, context);
  const existing = managedCodexProxySessions.get(key);
  if (existing) return { session: existing, cached: true };
  const session = await factory(managedModel, context);
  managedCodexProxySessions.set(key, session);
  return { session, cached: true };
}

function closeManagedCodexProxySessions() {
  for (const session of managedCodexProxySessions.values()) {
    try { session?.release?.(); } catch { /* ignore proxy cleanup */ }
  }
  managedCodexProxySessions.clear();
}

function createCodexChatAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const resolveAgentRuntime = deps.resolveAgentRuntime || (() => null);
  const agentRuntimeEnv = deps.agentRuntimeEnv || null;
  const currentUserPrompt = requireDependency(deps, "currentUserPrompt");
  const expandLeadingSkillCommand = requireDependency(deps, "expandLeadingSkillCommand");
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readBotPersona = requireDependency(deps, "readBotPersona");
  const runCodexAppServerTurn = requireDependency(deps, "runCodexAppServerTurn");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const getAgentSessionId = deps.getAgentSessionId || (() => "");
  const setAgentSessionId = deps.setAgentSessionId || (() => {});
  const getAgentSessionEntry = deps.getAgentSessionEntry || ((engine, botId, localSessionId) => ({
    id: getAgentSessionId(engine, botId, localSessionId),
    fingerprint: ""
  }));
  const setAgentSessionEntry = deps.setAgentSessionEntry || ((engine, botId, localSessionId, externalId) => {
    setAgentSessionId(engine, botId, localSessionId, externalId);
  });
  const clearAgentSessionEntry = deps.clearAgentSessionEntry || (() => false);
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const ensureCodexHome = requireDependency(deps, "ensureCodexHome");
  const writeSchedulerMcpContext = requireDependency(deps, "writeSchedulerMcpContext");
  const getMiaAppMcpSpec = deps.getMiaAppMcpSpec || (() => null);
  const getSchedulerMcpSpec = deps.getSchedulerMcpSpec || (() => null);
  const getUserMcpSpecs = deps.getUserMcpSpecs || (() => ({}));
  const getMcpFingerprint = deps.getMcpFingerprint || (() => "");
  const ensureUserMcpReady = deps.ensureUserMcpReady || (async () => {});
  const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
  const ensureMiaCodexProxy = deps.ensureMiaCodexProxy || null;
  const permissionCoordinator = deps.permissionCoordinator || null;
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const enginePermissionMode = deps.enginePermissionMode || (() => "default");
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const cwd = deps.cwd || (() => process.cwd());

  async function timeCodexPhase(label, fn) {
    const startedAt = Date.now();
    try {
      const value = await fn();
      appendEngineLog(`[codex] ${label}: ${elapsedMs(startedAt)}`);
      return value;
    } catch (error) {
      appendEngineLog(`[codex] ${label}: failed after ${elapsedMs(startedAt)} (${error?.message || error})`);
      throw error;
    }
  }

  function resolveCodexRuntimeCommand() {
    const runtime = resolveAgentRuntime("codex", { protocols: CODEX_MANAGED_PROTOCOLS });
    const commandPath = runtime?.path || shellCommandPath("codex");
    return { runtime, commandPath };
  }

  function envForCodexRuntime(baseEnv, runtime, commandPath) {
    if (runtime?.path && typeof agentRuntimeEnv === "function") {
      return agentRuntimeEnv("codex", baseEnv, { protocols: CODEX_MANAGED_PROTOCOLS });
    }
    return envWithExecutableDirFirst(baseEnv, commandPath);
  }

  async function sendChat({ bot, sessionId, messages, group, signal, emit = null, utility = false, scheduledFire = false, persistAgentSession = !utility, runtimeConfig = null, skillMaterialization = null }) {
    const chatStartedAt = Date.now();
    const engine = "codex";
    const shouldPersistAgentSession = Boolean(persistAgentSession);
    const turnConfig = {
      ...(bot.engineConfig && typeof bot.engineConfig === "object" ? bot.engineConfig : {}),
      ...(runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : {})
    };
    const { runtime: codexRuntime, commandPath } = resolveCodexRuntimeCommand();
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    try {
      await timeCodexPhase("mcp-ready", () => ensureUserMcpReady());
    } catch (error) {
      appendEngineLog(`MCP bridge initialization incomplete before Codex chat: ${error?.message || error}`);
    }
    const mcpFingerprint = getMcpFingerprint();
    const savedEntry = shouldPersistAgentSession ? getAgentSessionEntry(engine, bot.key, sessionId) : { id: "", fingerprint: "" };
    const externalSessionId = savedEntry.id && savedEntry.fingerprint === mcpFingerprint
      ? savedEntry.id
      : "";
    const nativeSessionCacheKey = [
      engine,
      String(bot.key || bot.id || "bot"),
      String(sessionId || "default"),
      String(mcpFingerprint || "")
    ].join(":");
    const resetNativeSession = Boolean(savedEntry.id && !externalSessionId);
    const lastUser = currentUserPrompt(promptMessagesForNativeSession(messages, shouldPersistAgentSession));
    // Best-effort: grab id from last user message for scheduler context
    const lastUserMessage = Array.isArray(messages) ? [...messages].reverse().find((m) => m?.role === "user") : null;
    const originMessageId = String(lastUserMessage?.id || "");
    try {
      writeSchedulerMcpContext({ botId: bot.key, sessionId, originMessageId });
    } catch {
      // Non-fatal; scheduler MCP context missing means tool works without context defaults
    }
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
      runtimeConfig: turnConfig,
      modePrefix: "codex",
      mcpAvailable: Boolean(miaAppMcpSpec),
      runtimePrompt: runtimeContext
    });
    const nativeContextMode = miaContext.nativeContextMode;
    const miaMemory = miaContext.memory.prompt;
    const snapshotContext = miaContext.mcp.snapshotInstruction;
    const runtimeInstructions = (() => {
      const parts = [];
      if (externalSessionId && (!utility || group)) parts.push(runtimeContext);
      if (snapshotContext) {
        if (!parts.length) parts.push(runtimeContext);
        parts.push(snapshotContext);
      }
      return parts.filter(Boolean).join("\n\n");
    })();
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "inline" }) || lastUser);
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
    const userText = [runtimeInstructions, skillContext, expandedPrompt]
      .filter(Boolean)
      .join("\n\n");
    const persona = nativeContextMode === "prompt" && !externalSessionId
      ? withMiaRuntimeContext(readBotPersona(bot.key, bot.name, bot.bio), { scheduledFire }).trim()
      : "";
    const prompt = (() => {
      if (!persona) return userText;
      const sections = [];
      sections.push([
        "以下是 Mia 给当前 Bot 的人设，请在本次对话中遵守：",
        "",
        persona
      ].join("\n"));
      sections.push(["用户消息：", userText].join("\n"));
      return sections.join("\n\n");
    })();
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const codexPrompt = promptWithGroup;
    const baseEnv = processEnvStrings();
    let codexHomePath = "";
    try {
      codexHomePath = await timeCodexPhase("codex-home", async () => ensureCodexHome());
    } catch (error) {
      throw new Error(`Mia Codex home setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex home setup failed: missing CODEX_HOME.");
    const env = envForCodexRuntime({ ...baseEnv, CODEX_HOME: codexHomePath }, codexRuntime, commandPath);
    const modelRuntime = resolveModelRuntime(turnConfig, { engine: "codex", bot });
    let effectiveManagedModel = modelRuntime || null;
    let miaProxySession = null;
    let releaseMiaProxyAfterTurn = true;
    if (isMiaManagedCodexModel(modelRuntime || {})) {
      if (typeof ensureMiaCodexProxy !== "function") {
        throw new Error("Mia Codex proxy is not available.");
      }
      const proxy = await timeCodexPhase("mia-model-proxy", () => createOrReuseManagedCodexProxy(
        ensureMiaCodexProxy,
        modelRuntime,
        { engine, bot, sessionId },
        { cache: isDurableAgentSession(sessionId, shouldPersistAgentSession) }
      ));
      miaProxySession = proxy.session;
      releaseMiaProxyAfterTurn = !proxy.cached;
      effectiveManagedModel = {
        ...(modelRuntime || {}),
        baseUrl: miaProxySession.baseUrl,
        apiKey: miaProxySession.apiKey,
        model: miaProxySession.model || modelRuntime?.model
      };
    }
    const permission = mapCodexPermissionMode(enginePermissionMode("codex") || "default");
    const effectivePermission = typeof emit === "function"
      ? permission
      : { ...permission, approvalPolicy: "never" };
    const mcpServers = mergeMcpServersWithReservedBuiltIns({
      userServers: getUserMcpSpecs(),
      builtInServers: {
        ...(miaAppMcpSpec ? { "mia-app": miaAppMcpSpec } : {}),
        ...(schedulerMcpSpec ? { "mia-scheduler": schedulerMcpSpec } : {})
      }
    });
    const threadOptions = {
      workingDirectory: cwd(),
      skipGitRepoCheck: true,
      modelReasoningEffort: normalizeEffortLevel(turnConfig.effortLevel || "medium", "codex"),
      ...effectivePermission
    };
    if (effectiveManagedModel?.model || turnConfig.model) threadOptions.model = String(effectiveManagedModel?.model || turnConfig.model);
    const startedAtMs = Date.now();
    let turn;
    let capturedSessionId = externalSessionId;
    const transport = "codex-app-server";
    const runtimeReuseKey = isDurableAgentSession(sessionId, shouldPersistAgentSession)
      ? [
          "codex",
          String(bot.key || ""),
          String(sessionId || ""),
          mcpFingerprint,
          String(codexHomePath || ""),
          String(commandPath || ""),
          String(effectiveManagedModel?.baseUrl || ""),
          secretDigest(effectiveManagedModel?.apiKey || ""),
          String(effectiveManagedModel?.model || turnConfig.model || "")
        ].join("|")
      : "";
    try {
      const visibleHistoryMessages = Array.isArray(messages)
        ? messages.filter((message) => message !== lastUserMessage)
        : [];
      const attachments = messagesAttachmentStats(messages);
      appendEngineLog(buildContextBudgetLogLine({
        engine,
        botId: bot.key,
        sessionId,
        nativeSessionId: externalSessionId || nativeSessionCacheKey,
        transport,
        historyMode: "native",
        nativeHistory: shouldPersistAgentSession,
        promptChars: textCharCount(codexPrompt),
        currentUserChars: textCharCount(expandedPrompt),
        systemChars: textCharCount(runtimeInstructions),
        personaChars: textCharCount(persona),
        memoryChars: textCharCount(miaMemory),
        skillIndexChars: textCharCount(effectiveSkillMaterialization?.indexBlock),
        loadedSkillChars: skillDeliveryMode === "mcp" ? 0 : textCharCount(effectiveSkillMaterialization?.loadedBlock),
        visibleHistoryChars: messagesTextChars(visibleHistoryMessages),
        includedHistoryChars: 0,
        groupChars: textCharCount(group?.contextBlock),
        attachmentCount: attachments.count,
        attachmentBytes: attachments.bytes
      }));
      appendEngineLog(`[codex] turn dispatch transport=${transport} model=${String(effectiveManagedModel?.model || turnConfig.model || "default")} effort=${String(threadOptions.modelReasoningEffort || "")}`);
      turn = await timeCodexPhase("app-server-turn", () => runCodexAppServerTurn({
        codexPath: commandPath,
        env,
        baseUrl: effectiveManagedModel?.baseUrl || "",
        apiKey: effectiveManagedModel?.apiKey || "",
        threadId: externalSessionId,
        prompt: codexPrompt,
        options: threadOptions,
        signal,
        emit,
        permissionCoordinator,
        botKey: bot.key,
        sessionId,
        mcpServers,
        reuseKey: runtimeReuseKey,
        appendLog: appendEngineLog
      }));
      capturedSessionId = externalSessionId || turn?.threadId || "";
    } finally {
      if (releaseMiaProxyAfterTurn) {
        try { miaProxySession?.release?.(); } catch { /* ignore */ }
      }
    }
    appendEngineLog(`[codex] chat total: ${elapsedMs(chatStartedAt)} transport=${transport}`);
    const imagePaths = recentGeneratedImagePaths(capturedSessionId, { env, startedAtMs });
    if (shouldPersistAgentSession && externalSessionId && !String(turn?.finalResponse || "").trim()) {
      try { clearAgentSessionEntry(engine, bot.key, sessionId); } catch { /* ignore session cleanup failures */ }
    }
    if (capturedSessionId && !externalSessionId && shouldPersistAgentSession) {
      setAgentSessionEntry(engine, bot.key, sessionId, capturedSessionId, mcpFingerprint);
    }
    if (signal?.aborted) throw stoppedError();
    return chatCompletionResponse({
      id: capturedSessionId || `codex_${randomUUID()}`,
      model: "codex-cli",
      content: contentWithGeneratedImages(turn?.finalResponse, imagePaths),
      attachments: generatedImageAttachments(imagePaths),
      mia: {
        transport,
        engine,
        session_id: capturedSessionId || "",
        bot_id: bot.key
      }
    });
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const { runtime: codexRuntime, commandPath } = resolveCodexRuntimeCommand();
    if (!commandPath) throw new Error("本机没有检测到 Codex CLI。请先安装并确认 `codex --version` 可用。");
    let codexHomePath = "";
    try {
      codexHomePath = ensureCodexHome();
    } catch (error) {
      throw new Error(`Mia Codex home setup failed: ${error?.message || error}`);
    }
    if (!codexHomePath) throw new Error("Mia Codex home setup failed: missing CODEX_HOME.");
    const turn = await runCodexAppServerTurn({
      codexPath: commandPath,
      env: envForCodexRuntime({ ...processEnvStrings(), CODEX_HOME: codexHomePath }, codexRuntime, commandPath),
      prompt: statelessPrompt(systemPrompt, userPrompt),
      options: {
        workingDirectory: cwd(),
        skipGitRepoCheck: true,
        modelReasoningEffort: normalizeEffortLevel("medium", "codex"),
        ...mapCodexPermissionMode("default"),
        approvalPolicy: "never"
      },
      signal,
      emit: null,
      permissionCoordinator: null,
      botKey: "stateless",
      sessionId: "",
      mcpServers: {},
      appendLog: appendEngineLog
    });
    if (signal?.aborted) throw stoppedError();
    return { content: String(turn?.finalResponse || "").trim() };
  }

  return { sendChat, sendStateless };
}

module.exports = {
  closeManagedCodexProxySessions,
  createCodexChatAdapter,
  mapCodexPermissionMode
};
