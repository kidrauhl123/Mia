const { execFile: defaultExecFile, spawn: defaultSpawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { PassThrough, Readable, Writable } = require("node:stream");
const {
  appendMiaMemoryBlock,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");
const { fileEditPayloadsFromAcpContent } = require("./agent-file-edit-events.js");
const { isForbiddenSchedulerToolName } = require("./scheduler-tool-guard.js");

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(`${key} dependency is required.`);
  return deps[key];
}

function envWithExecutableDirFirst(env = {}, executablePath = "") {
  const dir = path.dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const currentPath = String(env?.PATH || env?.Path || "");
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
      || ""
    ).trim();
    return { content: String(content || "").trim(), sessionId };
  } catch {
    return { content: raw, sessionId: "" };
  }
}

function execFileAsync(execFile, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
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
  return `mia:${botKey}:${localSession}`;
}

function shouldUseLegacyOpenClawTransport(bot = {}) {
  const config = bot.engineConfig || {};
  const transport = String(config.openclawTransport || config.transport || "").trim().toLowerCase();
  if (transport === "legacy-agent" || transport === "openclaw-cli" || transport === "agent") return true;
  return config.openclawLocal === true || config.local === true;
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
  const agentId = String(config.openclawAgent || config.agent || "").trim();
  if (agentId) args.push("--agent", agentId);
  if (externalSessionId) args.push("--session-id", externalSessionId);
  else args.push("--session-id", openClawSessionKey(bot, sessionId));
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
    title: tool.title || `${bot.name || "OpenClaw"} 想使用工具`,
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
        const suffix = details ? `\n${details}` : "";
        reject(new Error(`OpenClaw ACP 进程退出失败：code=${code}${signal ? ` signal=${signal}` : ""}${suffix}`));
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

function decorateOpenClawAcpError(error, output = "") {
  if (error?.code === "MIA_STOPPED") return error;
  const raw = String(output || "").trim();
  const message = String(error?.message || error || "").trim();
  const text = `${message}\n${raw}`;
  if (/ECONNREFUSED|gateway client error|gateway closed before ready|not connected to gateway/i.test(text)) {
    return new Error([
      "OpenClaw Gateway 没有运行或不可连接。",
      "请先完成 `openclaw setup` / `openclaw configure`，并启动 `openclaw gateway`；如果你的 Gateway 不在默认地址，请在 Bot 配置里设置 openclawGatewayUrl。",
      raw || message
    ].filter(Boolean).join("\n"));
  }
  if (/Failed to parse JSON message|ACP connection closed/i.test(text) && raw) {
    return new Error(`OpenClaw ACP 启动失败：${raw}`);
  }
  return error instanceof Error ? error : new Error(message || "OpenClaw ACP 启动失败。");
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
  const chatCompletionResponse = requireDependency(deps, "chatCompletionResponse");
  const memoryBlock = deps.memoryBlock || (() => "");
  const resolveManagedModelRuntime = deps.resolveManagedModelRuntime || (() => null);
  const permissionCoordinator = deps.permissionCoordinator || null;
  const enginePermissionMode = deps.enginePermissionMode || (() => "default");
  const randomUUID = deps.randomUUID || (() => crypto.randomUUID());
  const execFile = deps.execFile || defaultExecFile;
  const spawn = deps.spawn || defaultSpawn;
  const importAcpSdk = deps.importAcpSdk || defaultImportAcpSdk;
  const cwd = deps.cwd || (() => process.cwd());
  const timeoutSeconds = Number.isFinite(Number(deps.timeoutSeconds)) ? Number(deps.timeoutSeconds) : 600;

  async function runOpenClawLegacy({ bot, sessionId, message, signal, persistAgentSession = true } = {}) {
    const commandPath = shellCommandPath("openclaw") || shellCommandPath("claw");
    if (!commandPath) throw new Error("本机没有检测到 OpenClaw CLI。请先安装并确认 `openclaw --version` 可用。");
    const externalSessionId = persistAgentSession ? getAgentSessionId("openclaw", bot.key, sessionId) : "";
    const effort = normalizeEffortLevel(bot.engineConfig?.effortLevel || "medium", "openclaw");
    const forceLocal = bot.engineConfig?.openclawLocal === true || bot.engineConfig?.local === true;
    const managedModel = resolveManagedModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    if (managedModel?.provider === "mia") {
      throw new Error("OpenClaw 的 Mia 托管模型还没有安全接入：OpenClaw 需要先有对应 provider/baseUrl 配置。请先选择 OpenClaw 默认模型。");
    }
    const args = buildOpenClawArgs({
      bot,
      sessionId,
      externalSessionId,
      message,
      effort,
      local: forceLocal,
      timeoutSeconds
    });
    const result = await execFileAsync(execFile, commandPath, args, {
      cwd: cwd(),
      env: envWithExecutableDirFirst(processEnvStrings(), commandPath),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      signal
    });
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

  async function runOpenClawAcp({ bot, sessionId, message, signal, emit = null, persistAgentSession = true } = {}) {
    const commandPath = shellCommandPath("openclaw") || shellCommandPath("claw");
    if (!commandPath) throw new Error("本机没有检测到 OpenClaw CLI。请先安装并确认 `openclaw --version` 可用。");
    const managedModel = resolveManagedModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    if (managedModel?.provider === "mia") {
      throw new Error("OpenClaw 的 Mia 托管模型还没有安全接入：OpenClaw 需要先有对应 provider/baseUrl 配置。请先选择 OpenClaw 默认模型。");
    }

    const storedSessionKey = persistAgentSession ? getAgentSessionId("openclaw", bot.key, sessionId) : "";
    const sessionKey = storedSessionKey || openClawSessionKey(bot, sessionId);
    const effort = normalizeEffortLevel(bot.engineConfig?.effortLevel || "medium", "openclaw");
    const stdoutChunks = [];
    const stderrChunks = [];
    const outputChunks = [];
    let expectedExit = false;
    let acpSessionId = "";
    const args = buildOpenClawAcpArgs(bot);
    const child = spawn(commandPath, args, {
      cwd: cwd(),
      env: envWithExecutableDirFirst(processEnvStrings(), commandPath),
      stdio: ["pipe", "pipe", "pipe"]
    });
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
    const textId = `text_${randomUUID()}`;
    const reasoningId = `reasoning_${randomUUID()}`;
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
            const id = String(update.toolCallId || `tool_${randomUUID()}`);
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
            const id = String(update.toolCallId || `tool_${randomUUID()}`);
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

      await withChildFailure(client.initialize({
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
      const session = await withChildFailure(client.newSession({
        cwd: cwd(),
        mcpServers: [],
        _meta: {
          sessionKey,
          sessionLabel: bot.engineConfig?.openclawSessionLabel || undefined,
          resetSession: bot.engineConfig?.openclawResetSession === true,
          requireExisting: bot.engineConfig?.openclawRequireExisting === true,
          prefixCwd: false
        }
      }), failure);
      acpSessionId = String(session?.sessionId || "");
      if (!acpSessionId) throw new Error("OpenClaw ACP 没有返回 sessionId。");
      if (persistAgentSession && !storedSessionKey) {
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
      const response = await withChildFailure(client.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: String(message || "") }],
        _meta: {
          thinking: effort,
          timeoutMs: timeoutSeconds * 1000,
          prefixCwd: false
        }
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
    if (shouldUseLegacyOpenClawTransport(bot)) {
      return runOpenClawLegacy({ bot, sessionId, message, signal, persistAgentSession });
    }
    return runOpenClawAcp({ bot, sessionId, message, signal, emit, persistAgentSession });
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
      id: result.sessionId || `openclaw_${randomUUID()}`,
      model: "openclaw-acp",
      content: result.content,
      mia: {
        transport: "acp-backend",
        agent_type: "acp",
        backend: "openclaw",
        compatibility_transport: shouldUseLegacyOpenClawTransport(bot) ? "openclaw-cli" : "",
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
      sessionId: `stateless-${randomUUID()}`,
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
  createOpenClawChatAdapter,
  parseOpenClawContent,
  shouldUseLegacyOpenClawTransport
};
