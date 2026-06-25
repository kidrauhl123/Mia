const { execFile: defaultExecFile, spawn: defaultSpawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { PassThrough, Readable, Writable } = require("node:stream");
const {
  execFileExecutable,
  spawnExecutable
} = require("./agent-runtime/process-launcher.js");
const {
  appendMiaMemoryBlock,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");
const { fileEditPayloadsFromAcpContent } = require("./agent-file-edit-events.js");
const { isMiaManagedRuntime } = require("./mia-core/model-runtime-resolver.js");
const { isForbiddenSchedulerToolName } = require("./scheduler-tool-guard.js");

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(String(key) + " dependency is required.");
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

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function firstTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstTextValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "body", "reply", "response", "output", "message", "finalResponse", "final_response"]) {
      const nested = firstTextValue(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

function parseOpenClawContent(stdout = "") {
  const raw = String(stdout || "").trim();
  if (!raw) return { content: "", sessionId: "" };
  try {
    const parsed = JSON.parse(raw);
    const payloadText = Array.isArray(parsed?.payloads)
      ? parsed.payloads.map((item) => firstTextValue(item)).filter(Boolean).join("\n")
      : "";
    const content = payloadText
      || firstTextValue(parsed?.result)
      || firstTextValue(parsed?.data)
      || firstTextValue(parsed);
    const sessionId = String(
      parsed?.sessionId
      || parsed?.session_id
      || parsed?.result?.sessionId
      || parsed?.result?.session_id
      || parsed?.meta?.sessionId
      || parsed?.meta?.session_id
      || parsed?.meta?.agentMeta?.sessionId
      || parsed?.meta?.agentMeta?.session_id
      || ""
    ).trim();
    return { content: String(content || "").trim(), sessionId };
  } catch {
    return { content: raw, sessionId: "" };
  }
}

function execFileAsync(execFile, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileExecutable(execFile, file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    }, { platform: process.platform });
    if (options.input != null) {
      try { child.stdin?.end(String(options.input)); } catch { /* stdin may be unavailable in tests or old CLIs */ }
    }
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        try { child.kill(); } catch { /* already exited */ }
      }, { once: true });
    }
  });
}

function openClawSessionKey(bot, sessionId) {
  const botKey = String(bot?.key || bot?.id || "bot").trim() || "bot";
  const localSession = String(sessionId || "default").trim() || "default";
  return "mia:" + botKey + ":" + localSession;
}

function openClawLegacySessionKey(bot, sessionId) {
  const digest = crypto.createHash("sha256").update(openClawSessionKey(bot, sessionId)).digest("hex").slice(0, 32);
  return "mia-" + digest;
}

function openClawAcpSessionKey(bot, sessionId, mcpFingerprint = "") {
  return [
    "openclaw",
    "mia",
    String(bot?.key || bot?.id || "bot").trim() || "bot",
    String(sessionId || "default").trim() || "default",
    String(mcpFingerprint || "").trim()
  ].filter(Boolean).join(":");
}

function shouldUseLegacyOpenClawTransport(bot = {}) {
  const config = bot.engineConfig || {};
  const transport = String(config.openclawTransport || config.transport || "").trim().toLowerCase();
  if (transport === "acp" || transport === "gateway" || transport === "openclaw-acp") return false;
  if (transport === "legacy-agent" || transport === "openclaw-cli" || transport === "agent") return true;
  return false;
}

function buildOpenClawGlobalArgs(config = {}) {
  const profile = String(config.openclawProfile || config.profile || "").trim();
  if (!profile) return [];
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error("OpenClaw profile 名称只能包含字母、数字、点、下划线和短横线。");
  }
  return ["--profile", profile];
}

function buildOpenClawArgs({
  bot = {},
  sessionId = "",
  externalSessionId = "",
  message = "",
  model = "",
  effort = "medium",
  local = false,
  json = true,
  timeoutSeconds = 600
} = {}) {
  const config = bot.engineConfig || {};
  const args = [...buildOpenClawGlobalArgs(config), "agent", "--message", String(message || "")];
  const agentId = String(config.openclawAgent || config.agent || "main").trim();
  if (agentId) args.push("--agent", agentId);
  if (externalSessionId) args.push("--session-id", externalSessionId);
  else args.push("--session-key", openClawLegacySessionKey(bot, sessionId));
  const selectedModel = String(model || config.model || "").trim();
  if (selectedModel) args.push("--model", selectedModel);
  const thinking = String(effort || config.effortLevel || "medium").trim();
  if (thinking) args.push("--thinking", thinking);
  if (local) args.push("--local");
  if (json) args.push("--json");
  if (timeoutSeconds) args.push("--timeout", String(timeoutSeconds));
  return args;
}

async function defaultImportAcpSdk() {
  return import("@agentclientprotocol/sdk");
}

function acpUpdateText(update) {
  if (!update || typeof update !== "object") return "";
  return firstTextValue(update.content || update.text || update.delta || update.message);
}

function commandPreview(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value || "").slice(0, 4000);
  }
}

function rememberChunk(chunks, chunk, limit = 12000) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  if (!text) return;
  chunks.push(text);
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > limit && chunks.length > 1) {
    const removed = chunks.shift() || "";
    total -= removed.length;
  }
}

function optionByKind(options = [], kinds = []) {
  for (const kind of kinds) {
    const found = options.find((option) => option?.kind === kind);
    if (found) return found;
  }
  return options[0] || null;
}

function acpPermissionFallback(params = {}, { permissionMode = "default" } = {}) {
  const options = Array.isArray(params.options) ? params.options : [];
  const normalized = String(permissionMode || "default").trim();
  const allow = normalized === "bypassPermissions" || normalized === "yolo" || normalized === "off" || normalized === "never";
  const selected = allow
    ? optionByKind(options, ["allow_once", "allow_always"])
    : optionByKind(options, ["reject_once", "reject_always"]);
  if (!selected?.optionId) return { outcome: { outcome: "cancelled" } };
  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId
    }
  };
}

async function acpPermissionResponse(params = {}, context = {}) {
  const { permissionCoordinator, permissionMode = "default", engine, bot, sessionId, signal, emit } = context;
  if (signal?.aborted) return { outcome: { outcome: "cancelled" } };
  const tool = params.toolCall || {};
  const toolName = [tool.kind, tool.title, tool.name].filter(Boolean).join(".");
  if (isForbiddenSchedulerToolName(toolName)) {
    const selected = optionByKind(Array.isArray(params.options) ? params.options : [], ["reject_once", "reject_always"]);
    return selected?.optionId
      ? { outcome: { outcome: "selected", optionId: selected.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  const normalized = String(permissionMode || "default").trim();
  const canAsk = permissionCoordinator && typeof permissionCoordinator.requestPermission === "function"
    && normalized !== "bypassPermissions"
    && normalized !== "yolo"
    && normalized !== "off"
    && normalized !== "never";
  if (!canAsk) return acpPermissionFallback(params, { permissionMode: normalized });

  const preview = commandPreview(tool.rawInput ?? tool.rawOutput ?? tool.content);
  const decision = await permissionCoordinator.requestPermission({
    engine,
    botKey: bot.key,
    sessionId,
    signal,
    emit,
    toolName: String(tool.kind || tool.title || "openclaw-tool"),
      title: tool.title || String(bot.name || "OpenClaw") + " 想使用工具",
    description: tool.status || "",
    preview,
    input: tool.rawInput ?? tool.content ?? {}
  });
  const options = Array.isArray(params.options) ? params.options : [];
  const selected = decision?.decision === "allow"
    ? optionByKind(options, [decision.scope === "always" ? "allow_always" : "allow_once", "allow_once", "allow_always"])
    : optionByKind(options, [decision?.scope === "always" ? "reject_always" : "reject_once", "reject_once", "reject_always"]);
  if (!selected?.optionId) return { outcome: { outcome: "cancelled" } };
  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId
    }
  };
}

function childFailurePromise(child, outputChunks, isExpectedExit) {
  const promise = new Promise((_, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (isExpectedExit()) return;
      if (code && code !== 0) {
        const details = outputChunks.join("").trim();
        const suffix = details ? "\n" + details : "";
        reject(new Error("OpenClaw ACP 进程退出失败：code=" + code + (signal ? " signal=" + signal : "") + suffix));
      }
    });
  });
  promise.catch(() => {});
  return promise;
}

async function withChildFailure(promise, failurePromise) {
  return Promise.race([promise, failurePromise]);
}

function buildOpenClawAcpArgs(bot = {}) {
  const config = bot.engineConfig || {};
  const args = [...buildOpenClawGlobalArgs(config), "acp", "--no-prefix-cwd"];
  const gatewayUrl = String(config.openclawGatewayUrl || config.gatewayUrl || "").trim();
  if (gatewayUrl) args.push("--url", gatewayUrl);
  const tokenFile = String(config.openclawGatewayTokenFile || "").trim();
  if (tokenFile) args.push("--token-file", tokenFile);
  const passwordFile = String(config.openclawGatewayPasswordFile || "").trim();
  if (passwordFile) args.push("--password-file", passwordFile);
  return args;
}

function selectedOpenClawModelOverride(config = {}, managedModel = null) {
  if (isMiaManagedRuntime(managedModel)) {
    const model = String(config.model || managedModel.model || "mia-auto").trim() || "mia-auto";
    return "mia/" + model;
  }
  return String(config.model || "").trim();
}

function selectedOpenClawEffort(config = {}, managedModel = null, normalizeEffortLevel = (level) => level) {
  const effort = normalizeEffortLevel(config.effortLevel || "medium", "openclaw");
  const model = selectedOpenClawModelOverride(config, managedModel).toLowerCase();
  if (isMiaManagedRuntime(managedModel) && model === "mia/mia-auto") return "off";
  return effort;
}

function openClawMiaProviderPatch(managedModel = {}, config = {}) {
  const model = String(config.model || managedModel.model || "mia-auto").trim() || "mia-auto";
  const baseUrl = String(managedModel.baseUrl || managedModel.base_url || config.baseUrl || config.base_url || "").trim();
  const apiKey = String(managedModel.apiKey || managedModel.api_key || config.apiKey || config.api_key || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Error("OpenClaw 的 Mia 托管模型缺少 Mia Cloud 连接信息，请先登录 Mia Cloud。");
  }
  return {
    models: {
      mode: "merge",
      providers: {
        mia: {
          baseUrl,
          apiKey,
          auth: "token",
          api: "openai-completions",
          agentRuntime: { id: "openclaw" },
          models: [{
            id: model,
            name: model === "mia-auto" ? "Auto" : model,
            input: ["text"],
            contextWindow: 200000,
            agentRuntime: { id: "openclaw" }
          }]
        }
      }
    }
  };
}

function decorateOpenClawAcpError(error, output = "") {
  if (error?.code === "MIA_STOPPED") return error;
  const raw = String(output || "").trim();
  const message = String(error?.message || error || "").trim();
  const text = message + "\n" + raw;
  if (/ECONNREFUSED|gateway client error|gateway closed before ready|not connected to gateway/i.test(text)) {
    return new Error([
      "OpenClaw Gateway 没有运行或不可连接。",
      "请先完成 openclaw setup / openclaw configure，并启动 openclaw gateway；如果 Gateway 不在默认地址，请在 Bot 配置里设置 openclawGatewayUrl。",
      raw || message
    ].filter(Boolean).join("\n"));
  }
  if (/Failed to parse JSON message|ACP connection closed/i.test(text) && raw) {
    return new Error("OpenClaw ACP 启动失败：" + raw);
  }
  return error instanceof Error ? error : new Error(message || "OpenClaw ACP 启动失败。");
}

function isOpenClawGatewayUnavailableError(error) {
  const text = String(error?.message || error || "");
  return /OpenClaw Gateway 没有运行|ACP bridge failed|ECONNREFUSED|gateway client error|gateway closed before ready|not connected to gateway|ACP connection closed/i.test(text);
}

function decorateOpenClawLegacyError(error) {
  if (error?.code === "MIA_STOPPED") return error;
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  const rawMessage = String(error?.message || error || "").trim();
  const detail = stderr || stdout || rawMessage.replace(/^Command failed:[^\n]*(?:\n|$)/i, "").trim();
  const safeDetail = detail && !/^Command failed:/i.test(detail) ? detail : "";
  return new Error([
    "OpenClaw agent 运行失败。",
    safeDetail || "OpenClaw CLI 没有返回可展示的错误详情。"
  ].join("\n"));
}

function truthyCapability(value) {
  return value === true || value === "true" || value === "http" || value === "sse";
}

function transportListHas(value, transport) {
  if (!Array.isArray(value)) return false;
  return value.map((item) => String(item || "").toLowerCase()).includes(transport);
}

function acpMcpCapabilityOptions(metadata = {}) {
  const capabilities = metadata?.agentCapabilities || metadata?.capabilities || metadata || {};
  const mcp = capabilities.mcp || capabilities.mcpServers || capabilities.mcp_servers || {};
  const transports = mcp.transports || mcp.supportedTransports || mcp.supported_transports || capabilities.mcpTransports || [];
  return {
    supportsHttp: truthyCapability(mcp.http)
      || truthyCapability(mcp.supportsHttp)
      || truthyCapability(mcp.supports_http)
      || transportListHas(transports, "http")
      || transportListHas(transports, "streamable_http"),
    supportsSse: truthyCapability(mcp.sse)
      || truthyCapability(mcp.supportsSse)
      || truthyCapability(mcp.supports_sse)
      || transportListHas(transports, "sse")
  };
}

const openClawAcpRuntimePool = new Map();

function isDurableOpenClawSession(sessionId, persistAgentSession) {
  return Boolean(persistAgentSession) && String(sessionId || "").startsWith("conversation:");
}

function openClawAcpRuntimeKey(parts = {}) {
  return JSON.stringify({
    commandPath: String(parts.commandPath || ""),
    args: Array.isArray(parts.args) ? parts.args : [],
    cwd: String(parts.cwd || ""),
    sessionKey: String(parts.sessionKey || ""),
    effort: String(parts.effort || ""),
    model: String(parts.model || ""),
    envPath: String(parts.env?.PATH || parts.env?.Path || "")
  });
}

function closeOpenClawAcpRuntimeEntry(entry) {
  if (!entry) return;
  openClawAcpRuntimePool.delete(entry.key);
  entry.expectedExit = true;
  try { entry.child?.stdin?.end?.(); } catch { /* already closed */ }
  try { entry.child?.kill?.(); } catch { /* already exited */ }
}

function closeOpenClawAcpRuntimes() {
  for (const entry of openClawAcpRuntimePool.values()) {
    closeOpenClawAcpRuntimeEntry(entry);
  }
  openClawAcpRuntimePool.clear();
}

function enqueueOpenClawAcpRuntime(entry, run) {
  const previous = entry.queue.catch(() => {});
  const current = previous.then(run);
  entry.queue = current.catch(() => {});
  return current;
}

function createOpenClawChatAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const lastUserPrompt = requireDependency(deps, "lastUserPrompt");
  const expandLeadingSkillCommand = requireDependency(deps, "expandLeadingSkillCommand");
  const buildEnabledSkillsContext = deps.buildEnabledSkillsContext || (() => "");
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readBotPersona = requireDependency(deps, "readBotPersona");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const getAgentSessionId = requireDependency(deps, "getAgentSessionId");
  const setAgentSessionId = requireDependency(deps, "setAgentSessionId");
  const getUserMcpServers = deps.getUserMcpServers || (() => []);
  const getMcpFingerprint = deps.getMcpFingerprint || (() => "");
  const ensureUserMcpReady = deps.ensureUserMcpReady || (async () => {});
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const memoryBlock = deps.memoryBlock || (() => "");
  const resolveModelRuntime = deps.resolveModelRuntime || deps.resolveManagedModelRuntime || (() => null);
  const permissionCoordinator = deps.permissionCoordinator || null;
  const enginePermissionMode = deps.enginePermissionMode || (() => "default");
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const execFile = deps.execFile || defaultExecFile;
  const spawn = deps.spawn || defaultSpawn;
  const importAcpSdk = deps.importAcpSdk || defaultImportAcpSdk;
  const cwd = deps.cwd || (() => process.cwd());
  const timeoutSeconds = Number.isFinite(Number(deps.timeoutSeconds)) ? Number(deps.timeoutSeconds) : 600;

  async function syncOpenClawManagedModelConfig(commandPath, managedModel = {}, config = {}, signal = null) {
    const patch = openClawMiaProviderPatch(managedModel, config);
    await execFileAsync(execFile, commandPath, ["config", "patch", "--stdin"], {
      cwd: cwd(),
      env: envWithExecutableDirFirst(processEnvStrings(), commandPath),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      input: JSON.stringify(patch),
      signal
    });
  }

  async function runOpenClawLegacy({ bot, sessionId, message, signal, persistAgentSession = true, managedModel = null } = {}) {
    const commandPath = shellCommandPath("openclaw") || shellCommandPath("claw");
    if (!commandPath) throw new Error("本机没有检测到 OpenClaw CLI。请先安装并确认 openclaw --version 可用。");
    const externalSessionId = persistAgentSession ? getAgentSessionId("openclaw", bot.key, sessionId) : "";
    const effectiveRuntime = managedModel || resolveModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    const effort = selectedOpenClawEffort(bot.engineConfig || {}, effectiveRuntime, normalizeEffortLevel);
    const forceLocal = bot.engineConfig?.openclawLocal === true || bot.engineConfig?.local === true || isMiaManagedRuntime(effectiveRuntime);
    if (isMiaManagedRuntime(effectiveRuntime)) await syncOpenClawManagedModelConfig(commandPath, effectiveRuntime, bot.engineConfig || {}, signal);
    const model = selectedOpenClawModelOverride(bot.engineConfig || {}, effectiveRuntime);
    const args = buildOpenClawArgs({
      bot,
      sessionId,
      externalSessionId,
      message,
      model,
      effort,
      local: forceLocal,
      timeoutSeconds
    });
    let result = null;
    try {
      result = await execFileAsync(execFile, commandPath, args, {
        cwd: cwd(),
        env: envWithExecutableDirFirst(processEnvStrings(), commandPath),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        signal
      });
    } catch (error) {
      throw decorateOpenClawLegacyError(error);
    }
    if (signal?.aborted) throw stoppedError();
    const parsed = parseOpenClawContent(result.stdout);
    if (parsed.sessionId && !externalSessionId && persistAgentSession) {
      setAgentSessionId("openclaw", bot.key, sessionId, parsed.sessionId);
    }
    return {
      content: parsed.content || String(result.stderr || "").trim(),
      sessionId: parsed.sessionId || externalSessionId
    };
  }

  async function createOpenClawAcpRuntimeEntry(context = {}) {
    const {
      key,
      commandPath,
      args,
      cwdValue,
      env,
      sessionKey,
      storedSessionKey,
      persistAgentSession,
      bot,
      sessionId,
      effort,
      modelOverride,
      signal
    } = context;
    if (signal?.aborted) throw stoppedError();
    const stdoutChunks = [];
    const outputChunks = [];
    const entry = {
      key,
      child: null,
      client: null,
      acpSessionId: "",
      sessionKey,
      currentTurn: null,
      expectedExit: false,
      failure: null,
      ready: null,
      queue: Promise.resolve()
    };
    const child = spawnExecutable(spawn, commandPath, args, {
      cwd: cwdValue,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }, { platform: process.platform });
    entry.child = child;
    if (!child.stdin || !child.stdout) {
      try { child.kill(); } catch { /* already exited */ }
      throw new Error("OpenClaw ACP 无法创建 stdio 通道。");
    }
    const acpStdout = new PassThrough();
    child.stdout.on("data", (chunk) => {
      rememberChunk(stdoutChunks, chunk);
      rememberChunk(outputChunks, chunk);
    });
    child.stdout.pipe(acpStdout);
    child.stderr?.on("data", (chunk) => {
      rememberChunk(outputChunks, chunk);
    });
    entry.failure = childFailurePromise(child, outputChunks, () => entry.expectedExit);
    entry.failure.catch(() => closeOpenClawAcpRuntimeEntry(entry));

    const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = await importAcpSdk();
    entry.client = new ClientSideConnection(() => ({
      sessionUpdate: async (params = {}) => {
        const ctx = entry.currentTurn;
        if (!ctx) return;
        const update = params.update || {};
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = acpUpdateText(update);
          if (text) {
            ctx.chunks.push(text);
            if (typeof ctx.emit === "function") ctx.emit("text_delta", { id: ctx.textId, text });
          }
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = acpUpdateText(update);
          if (text && typeof ctx.emit === "function") ctx.emit("reasoning_delta", { id: ctx.reasoningId, text });
          return;
        }
        if (update.sessionUpdate === "tool_call") {
          const id = String(update.toolCallId || ("tool_" + randomUUID()));
          const name = String(update.title || update.kind || "OpenClaw tool");
          ctx.toolNames.set(id, name);
          if (typeof ctx.emit === "function") {
            ctx.emit("tool_call_started", {
              id,
              name,
              preview: commandPreview(update.rawInput)
            });
          }
          return;
        }
        if (update.sessionUpdate === "tool_call_update" && typeof ctx.emit === "function") {
          const id = String(update.toolCallId || ("tool_" + randomUUID()));
          const payload = {
            id,
            name: ctx.toolNames.get(id) || String(update.title || update.kind || "OpenClaw tool"),
            preview: commandPreview(update.rawOutput || update.content),
            status: update.status || "",
            error: update.status === "failed"
          };
          if (update.status === "completed" || update.status === "failed") {
            ctx.emit("tool_call_completed", payload);
            for (const fileEdit of fileEditPayloadsFromAcpContent(update.content || update.rawOutput, {
              idPrefix: id,
              status: payload.status || "completed",
              error: payload.error
            })) {
              ctx.emit("file_edit", fileEdit);
            }
          } else {
            ctx.emit("tool_call_delta", payload);
          }
        }
      },
      requestPermission: (params) => {
        const ctx = entry.currentTurn;
        return acpPermissionResponse(params, ctx || {
          permissionCoordinator,
          permissionMode: enginePermissionMode("openclaw") || "default",
          engine: "openclaw",
          bot,
          sessionId,
          signal,
          emit: null
        });
      }
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(acpStdout)));

    const initialized = await withChildFailure(entry.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false
      },
      clientInfo: {
        name: "mia-openclaw-acp-client",
        version: "1.0.0"
      }
    }), entry.failure);
    try {
      await ensureUserMcpReady();
    } catch (error) {
      appendEngineLog("MCP bridge initialization incomplete before OpenClaw chat: " + (error?.message || error));
    }
    const userMcpServers = getUserMcpServers(acpMcpCapabilityOptions(initialized));
    const sessionMeta = {
      sessionKey,
      sessionLabel: bot.engineConfig?.openclawSessionLabel || undefined,
      resetSession: bot.engineConfig?.openclawResetSession === true,
      requireExisting: bot.engineConfig?.openclawRequireExisting === true,
      prefixCwd: false
    };
    if (modelOverride) sessionMeta.model = modelOverride;
    const session = await withChildFailure(entry.client.newSession({
      cwd: cwdValue,
      mcpServers: userMcpServers,
      _meta: sessionMeta
    }), entry.failure);
    entry.acpSessionId = String(session?.sessionId || "");
    if (!entry.acpSessionId) throw new Error("OpenClaw ACP 没有返回 sessionId。");
    if (persistAgentSession && storedSessionKey !== sessionKey) {
      setAgentSessionId("openclaw", bot.key, sessionId, sessionKey);
    }
    if (effort) {
      try {
        await withChildFailure(entry.client.setSessionMode({ sessionId: entry.acpSessionId, modeId: effort }), entry.failure);
      } catch {
        // OpenClaw also accepts thinking in prompt _meta; older builds may reject unknown modes.
      }
    }
    return entry;
  }

  async function getOpenClawAcpRuntimeEntry(context = {}) {
    const existing = openClawAcpRuntimePool.get(context.key);
    if (existing && existing.ready) {
      await existing.ready;
      return existing;
    }
    if (existing) closeOpenClawAcpRuntimeEntry(existing);
    const entry = {
      key: context.key,
      queue: Promise.resolve(),
      ready: null
    };
    openClawAcpRuntimePool.set(context.key, entry);
    entry.ready = createOpenClawAcpRuntimeEntry(context)
      .then((readyEntry) => {
        const ready = entry.ready;
        Object.assign(entry, readyEntry);
        entry.ready = ready;
        return entry;
      })
      .catch((error) => {
        closeOpenClawAcpRuntimeEntry(entry);
        throw error;
      });
    await entry.ready;
    return entry;
  }

  async function promptOpenClawAcpRuntime(entry, context = {}) {
    await entry.ready;
    if (context.signal?.aborted) throw stoppedError();
    const chunks = [];
    entry.currentTurn = {
      permissionCoordinator,
      permissionMode: enginePermissionMode("openclaw") || "default",
      engine: "openclaw",
      bot: context.bot,
      sessionId: context.sessionId,
      signal: context.signal,
      emit: context.emit,
      chunks,
      textId: "text_" + randomUUID(),
      reasoningId: "reasoning_" + randomUUID(),
      toolNames: new Map()
    };
    let rejectAbort = null;
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
    const abortHandler = () => {
      entry.client?.cancel?.({ sessionId: entry.acpSessionId }).catch(() => {});
      closeOpenClawAcpRuntimeEntry(entry);
      rejectAbort(stoppedError());
    };
    if (context.signal) context.signal.addEventListener("abort", abortHandler, { once: true });
    const promptMeta = {
      thinking: context.effort,
      timeoutMs: timeoutSeconds * 1000,
      prefixCwd: false
    };
    if (context.modelOverride) promptMeta.model = context.modelOverride;
    try {
      const response = await Promise.race([
        withChildFailure(entry.client.prompt({
          sessionId: entry.acpSessionId,
          prompt: [{ type: "text", text: String(context.message || "") }],
          _meta: promptMeta
        }), entry.failure),
        abortPromise
      ]);
      if (context.signal?.aborted || response?.stopReason === "cancelled") throw stoppedError();
      return {
        content: chunks.join("").trim(),
        sessionId: entry.sessionKey,
        stopReason: response?.stopReason || ""
      };
    } catch (error) {
      if (context.signal?.aborted) throw stoppedError();
      closeOpenClawAcpRuntimeEntry(entry);
      throw decorateOpenClawAcpError(error, "");
    } finally {
      if (context.signal) context.signal.removeEventListener("abort", abortHandler);
      entry.currentTurn = null;
    }
  }

  async function runOpenClawAcpPooled(context = {}) {
    const entry = await getOpenClawAcpRuntimeEntry(context);
    return enqueueOpenClawAcpRuntime(entry, () => promptOpenClawAcpRuntime(entry, context));
  }

  async function runOpenClawAcp({ bot, sessionId, message, signal, emit = null, persistAgentSession = true, managedModel: providedManagedModel = null } = {}) {
    const commandPath = shellCommandPath("openclaw") || shellCommandPath("claw");
    if (!commandPath) throw new Error("本机没有检测到 OpenClaw CLI。请先安装并确认 openclaw --version 可用。");
    const effectiveRuntime = providedManagedModel || resolveModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    if (isMiaManagedRuntime(effectiveRuntime)) {
      await syncOpenClawManagedModelConfig(commandPath, effectiveRuntime, bot.engineConfig || {}, signal);
    }
    const modelOverride = selectedOpenClawModelOverride(bot.engineConfig || {}, effectiveRuntime);

    const mcpFingerprint = getMcpFingerprint();
    const desiredSessionKey = openClawAcpSessionKey(bot, sessionId, mcpFingerprint);
    const storedSessionKey = persistAgentSession ? getAgentSessionId("openclaw", bot.key, sessionId) : "";
    const sessionKey = storedSessionKey === desiredSessionKey ? storedSessionKey : desiredSessionKey;
    const effort = selectedOpenClawEffort(bot.engineConfig || {}, effectiveRuntime, normalizeEffortLevel);
    const stdoutChunks = [];
    const stderrChunks = [];
    const outputChunks = [];
    let expectedExit = false;
    let acpSessionId = "";
    const args = buildOpenClawAcpArgs(bot);
    const cwdValue = cwd();
    const env = envWithExecutableDirFirst(processEnvStrings(), commandPath);
    const runtimeKey = openClawAcpRuntimeKey({
      commandPath,
      args,
      cwd: cwdValue,
      env,
      sessionKey,
      effort,
      model: modelOverride
    });
    if (isDurableOpenClawSession(sessionId, persistAgentSession) && bot.engineConfig?.openclawResetSession !== true) {
      return runOpenClawAcpPooled({
        key: runtimeKey,
        commandPath,
        args,
        cwdValue,
        env,
        sessionKey,
        storedSessionKey,
        persistAgentSession,
        bot,
        sessionId,
        effort,
        modelOverride,
        signal,
        emit,
        message
      });
    }
    const child = spawnExecutable(spawn, commandPath, args, {
      cwd: cwdValue,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }, { platform: process.platform });
    if (!child.stdin || !child.stdout) {
      try { child.kill(); } catch { /* already exited */ }
      throw new Error("OpenClaw ACP 无法创建 stdio 通道。");
    }
    const acpStdout = new PassThrough();
    child.stdout.on("data", (chunk) => {
      rememberChunk(stdoutChunks, chunk);
      rememberChunk(outputChunks, chunk);
    });
    child.stdout.pipe(acpStdout);
    child.stderr?.on("data", (chunk) => {
      rememberChunk(stderrChunks, chunk);
      rememberChunk(outputChunks, chunk);
    });
    const failure = childFailurePromise(child, outputChunks, () => expectedExit);
    const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = await importAcpSdk();
    let client = null;
    const textId = "text_" + randomUUID();
    const reasoningId = "reasoning_" + randomUUID();
    const toolNames = new Map();
    const cancel = async () => {
      if (client && acpSessionId) {
        try { await client.cancel({ sessionId: acpSessionId }); } catch { /* best effort */ }
      }
      try { child.kill(); } catch { /* already exited */ }
    };
    const abortHandler = () => { cancel(); };
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });
    const chunks = [];
    try {
      if (signal?.aborted) throw stoppedError();
      client = new ClientSideConnection(() => ({
        sessionUpdate: async (params = {}) => {
          const update = params.update || {};
          if (update.sessionUpdate === "agent_message_chunk") {
            const text = acpUpdateText(update);
            if (text) {
              chunks.push(text);
              if (typeof emit === "function") emit("text_delta", { id: textId, text });
            }
            return;
          }
          if (update.sessionUpdate === "agent_thought_chunk") {
            const text = acpUpdateText(update);
            if (text && typeof emit === "function") emit("reasoning_delta", { id: reasoningId, text });
            return;
          }
          if (update.sessionUpdate === "tool_call") {
            const id = String(update.toolCallId || ("tool_" + randomUUID()));
            const name = String(update.title || update.kind || "OpenClaw tool");
            toolNames.set(id, name);
            if (typeof emit === "function") {
              emit("tool_call_started", {
                id,
                name,
                preview: commandPreview(update.rawInput)
              });
            }
            return;
          }
          if (update.sessionUpdate === "tool_call_update" && typeof emit === "function") {
            const id = String(update.toolCallId || ("tool_" + randomUUID()));
            const payload = {
              id,
              name: toolNames.get(id) || String(update.title || update.kind || "OpenClaw tool"),
              preview: commandPreview(update.rawOutput || update.content),
              status: update.status || "",
              error: update.status === "failed"
            };
            if (update.status === "completed" || update.status === "failed") {
              emit("tool_call_completed", payload);
              for (const fileEdit of fileEditPayloadsFromAcpContent(update.content || update.rawOutput, {
                idPrefix: id,
                status: payload.status || "completed",
                error: payload.error
              })) {
                emit("file_edit", fileEdit);
              }
            } else {
              emit("tool_call_delta", payload);
            }
          }
        },
        requestPermission: (params) => acpPermissionResponse(params, {
          permissionCoordinator,
          permissionMode: enginePermissionMode("openclaw") || "default",
          engine: "openclaw",
          bot,
          sessionId,
          signal,
          emit
        })
      }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(acpStdout)));

      const initialized = await withChildFailure(client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false
          },
          terminal: false
        },
        clientInfo: {
          name: "mia-openclaw-acp-client",
          version: "1.0.0"
        }
      }), failure);
      try {
        await ensureUserMcpReady();
      } catch (error) {
        appendEngineLog("MCP bridge initialization incomplete before OpenClaw chat: " + (error?.message || error));
      }
      const userMcpServers = getUserMcpServers(acpMcpCapabilityOptions(initialized));
      const sessionMeta = {
        sessionKey,
        sessionLabel: bot.engineConfig?.openclawSessionLabel || undefined,
        resetSession: bot.engineConfig?.openclawResetSession === true,
        requireExisting: bot.engineConfig?.openclawRequireExisting === true,
        prefixCwd: false
      };
      if (modelOverride) sessionMeta.model = modelOverride;
      const session = await withChildFailure(client.newSession({
        cwd: cwdValue,
        mcpServers: userMcpServers,
        _meta: sessionMeta
      }), failure);
      acpSessionId = String(session?.sessionId || "");
    if (!acpSessionId) throw new Error("OpenClaw ACP 没有返回 sessionId。");
      if (persistAgentSession && storedSessionKey !== sessionKey) {
        setAgentSessionId("openclaw", bot.key, sessionId, sessionKey);
      }
      if (effort) {
        try {
          await withChildFailure(client.setSessionMode({ sessionId: acpSessionId, modeId: effort }), failure);
        } catch {
          // OpenClaw also accepts thinking in prompt _meta; older builds may reject unknown modes.
        }
      }
      if (signal?.aborted) throw stoppedError();
      const promptMeta = {
        thinking: effort,
        timeoutMs: timeoutSeconds * 1000,
        prefixCwd: false
      };
      if (modelOverride) promptMeta.model = modelOverride;
      const response = await withChildFailure(client.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: String(message || "") }],
        _meta: promptMeta
      }), failure);
      if (signal?.aborted || response?.stopReason === "cancelled") throw stoppedError();
      return {
        content: chunks.join("").trim(),
        sessionId: sessionKey,
        stopReason: response?.stopReason || ""
      };
    } catch (error) {
      if (signal?.aborted) throw stoppedError();
      throw decorateOpenClawAcpError(error, outputChunks.join(""));
    } finally {
      if (signal) signal.removeEventListener("abort", abortHandler);
      expectedExit = true;
      try { child.stdin?.end(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* already exited */ }
    }
  }

  async function runOpenClaw({ bot, sessionId, message, signal, emit = null, persistAgentSession = true } = {}) {
    const modelRuntime = resolveModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    const useLegacy = shouldUseLegacyOpenClawTransport(bot, modelRuntime);
    if (useLegacy) {
      const result = await runOpenClawLegacy({ bot, sessionId, message, signal, persistAgentSession, managedModel: modelRuntime });
      return {
        ...result,
        compatibilityTransport: "openclaw-cli"
      };
    }
    try {
      const result = await runOpenClawAcp({ bot, sessionId, message, signal, emit, persistAgentSession, managedModel: modelRuntime });
      return {
        ...result,
        compatibilityTransport: ""
      };
    } catch (error) {
      if (!isMiaManagedRuntime(modelRuntime) || !isOpenClawGatewayUnavailableError(error)) throw error;
      appendEngineLog("OpenClaw ACP Gateway unavailable; falling back to local CLI for Mia-managed model.");
      const result = await runOpenClawLegacy({ bot, sessionId, message, signal, persistAgentSession, managedModel: modelRuntime });
      return {
        ...result,
        compatibilityTransport: "openclaw-cli-fallback"
      };
    }
  }

  async function sendChat({ bot, sessionId, messages, group, signal, emit = null, utility = false, scheduledFire = false, persistAgentSession = !utility }) {
    const lastUser = lastUserPrompt(messages);
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "inline" }) || lastUser);
    const miaMemory = memoryBlock({ botId: bot.key, sessionId });
    const persona = appendMiaMemoryBlock(
      withMiaRuntimeContext(readBotPersona(bot.key, bot.name, bot.bio), { scheduledFire }),
      miaMemory
    ).trim();
    const prompt = [
      persona ? ["以下是 Mia 给当前 Bot 的人设，请在本次对话中遵守：", "", persona].join("\n") : "",
      buildEnabledSkillsContext(bot),
      ["用户消息：", expandedPrompt].join("\n")
    ].filter(Boolean).join("\n\n");
    const promptWithGroup = group && group.contextBlock
      ? injectGroupContextForSdk(prompt, group.contextBlock)
      : prompt;
    const result = await runOpenClaw({
      bot,
      sessionId,
      message: promptWithGroup,
      signal,
      emit,
      persistAgentSession
    });
    return chatCompletionResponse({
      id: result.sessionId || ("openclaw_" + randomUUID()),
      model: "openclaw-acp",
      content: result.content,
      mia: {
        transport: "acp-backend",
        agent_type: "acp",
        backend: "openclaw",
        compatibility_transport: result.compatibilityTransport || "",
        engine: "openclaw",
        session_id: result.sessionId || "",
        bot_id: bot.key
      }
    });
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const bot = {
      key: "stateless",
      name: "OpenClaw",
      engineConfig: {}
    };
    const message = [systemPrompt, userPrompt].filter(Boolean).join("\n\n");
    const result = await runOpenClaw({
      bot,
      sessionId: "stateless-" + randomUUID(),
      message,
      signal,
      persistAgentSession: false
    });
    return { content: result.content };
  }

  return { sendChat, sendStateless };
}

module.exports = {
  acpPermissionFallback,
  buildOpenClawAcpArgs,
  buildOpenClawArgs,
  buildOpenClawGlobalArgs,
  closeOpenClawAcpRuntimes,
  createOpenClawChatAdapter,
  parseOpenClawContent,
  shouldUseLegacyOpenClawTransport
};
