const { execFile: defaultExecFile, spawn: defaultSpawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable, Writable } = require("node:stream");
const {
  execFileExecutable,
  isWindowsShellShim,
  spawnExecutable
} = require("./agent-runtime/process-launcher.js");
const {
  appendMiaMemoryBlock,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
} = require("./mia-runtime-context.js");
const {
  buildContextBudgetLogLine,
  messagesAttachmentStats,
  messagesTextChars,
  textCharCount
} = require("./agent-context-budget.js");
const { memoryBlockForNativeSession } = require("./native-memory-context.js");
const { personaBlockForNativeSession } = require("./native-persona-context.js");
const { skillMaterializationForNativeSession } = require("./native-skill-context.js");
const {
  contextSnapshotInstruction,
  nativeContextModeFromConfig,
  selectNativeContextMode
} = require("./native-context-snapshot.js");
const { fileEditPayloadsFromAcpContent } = require("./agent-file-edit-events.js");
const { isMiaManagedRuntime } = require("./mia-core/model-runtime-resolver.js");
const { isForbiddenSchedulerToolName } = require("./scheduler-tool-guard.js");
const { buildSkillMaterializationContext } = require("../shared/skill-materializer.js");

const OPENCLAW_MIA_AGENT_ID = "mia";
const OPENCLAW_MIA_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md"
];

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

function jsonFragmentFromText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const starts = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "{" || raw[i] === "[") starts.push(i);
  }
  for (const start of starts) {
    const opener = raw[start];
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const char = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }
      if (char !== "}" && char !== "]") continue;
      const last = stack.pop();
      if ((char === "}" && last !== "{") || (char === "]" && last !== "[")) break;
      if (!stack.length) {
        const fragment = raw.slice(start, i + 1);
        if (opener === "{" || opener === "[") {
          try {
            JSON.parse(fragment);
            return fragment;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function parseOpenClawContent(stdout = "") {
  const raw = String(stdout || "").trim();
  if (!raw) return { content: "", sessionId: "" };
  try {
    const parsed = JSON.parse(jsonFragmentFromText(raw) || raw);
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

function childProcessOptions(options = {}, platform = process.platform) {
  const next = { ...(options || {}) };
  if (!next.signal) delete next.signal;
  if (platform === "win32") next.windowsHide = true;
  return next;
}

function openClawCommandSpec(file, args = [], runtimeOptions = {}) {
  const platform = runtimeOptions.platform || process.platform;
  if (isWindowsShellShim(file, platform)) {
    const script = path.join(path.dirname(file), "node_modules", "openclaw", "openclaw.mjs");
    if (fs.existsSync(script)) {
      return {
        file: runtimeOptions.nodePath || process.execPath,
        args: [script, ...(Array.isArray(args) ? args : [])]
      };
    }
  }
  return {
    file,
    args: Array.isArray(args) ? args.slice() : []
  };
}

function execFileAsync(execFile, file, args, options = {}, runtimeOptions = {}) {
  return new Promise((resolve, reject) => {
    const platform = runtimeOptions.platform || process.platform;
    const spec = openClawCommandSpec(file, args, runtimeOptions);
    const child = execFileExecutable(execFile, spec.file, spec.args, childProcessOptions(options, platform), (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    }, { platform });
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

function spawnOpenClaw(spawn, file, args, options = {}, runtimeOptions = {}) {
  const platform = runtimeOptions.platform || process.platform;
  const spec = openClawCommandSpec(file, args, runtimeOptions);
  return spawnExecutable(spawn, spec.file, spec.args, childProcessOptions(options, platform), { platform });
}

function normalizeOpenClawAgentId(value, fallback = OPENCLAW_MIA_AGENT_ID) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)) return raw.toLowerCase();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64);
  return normalized || fallback;
}

function openClawMiaAgentId(config = {}) {
  return normalizeOpenClawAgentId(config.openclawMiaAgentId || config.openclawAgentId || OPENCLAW_MIA_AGENT_ID);
}

function openClawAcpSessionKey(bot, sessionId, mcpFingerprint = "", options = {}) {
  const agentId = String(options.agentId || "").trim();
  const body = [
    "mia",
    String(bot?.key || bot?.id || "bot").trim() || "bot",
    String(sessionId || "default").trim() || "default",
    String(mcpFingerprint || "").trim()
  ].filter(Boolean);
  if (agentId) return ["agent", normalizeOpenClawAgentId(agentId), ...body].join(":");
  return ["openclaw", ...body].join(":");
}

function shouldUseLegacyOpenClawTransport(bot = {}) {
  const config = bot.engineConfig || {};
  const transport = String(config.openclawTransport || config.transport || "").trim().toLowerCase();
  if (transport === "acp" || transport === "gateway" || transport === "openclaw-acp") return false;
  if (transport === "legacy-agent" || transport === "openclaw-cli" || transport === "agent") return true;
  return false;
}

function shouldAllowOpenClawLocalFallback(bot = {}) {
  const config = bot.engineConfig || {};
  return config.openclawAllowLocalFallback === true || config.allowOpenClawLocalFallback === true;
}

function openClawSkillIndexMode(bot = {}) {
  const config = bot.engineConfig || {};
  return config.openclawSkillIndexMode
    || config.openclaw_skill_index_mode
    || config.nativeSkillIndexMode
    || config.native_skill_index_mode
    || config.skillIndexMode
    || config.skill_index_mode
    || "";
}

function openClawMemoryInjectionMode(bot = {}) {
  const config = bot.engineConfig || {};
  return config.openclawMemoryInjectionMode
    || config.openclaw_memory_injection_mode
    || config.nativeMemoryInjectionMode
    || config.native_memory_injection_mode
    || config.memoryInjectionMode
    || config.memory_injection_mode
    || "";
}

function openClawPersonaInjectionMode(bot = {}) {
  const config = bot.engineConfig || {};
  return config.openclawPersonaInjectionMode
    || config.openclaw_persona_injection_mode
    || config.nativePersonaInjectionMode
    || config.native_persona_injection_mode
    || config.personaInjectionMode
    || config.persona_injection_mode
    || "";
}

function openClawNativeContextSessionKey({
  bot = {},
  sessionId = "",
  mcpFingerprint = "",
  modelRuntime = null,
  persistAgentSession = true
} = {}) {
  const botKey = String(bot?.key || bot?.id || "bot").trim() || "bot";
  const localSessionId = String(sessionId || "default").trim() || "default";
  const fingerprint = String(mcpFingerprint || "").trim();
  if (!persistAgentSession) {
    return ["turn", "openclaw", botKey, localSessionId, fingerprint].filter(Boolean).join(":");
  }
  if (shouldUseLegacyOpenClawTransport(bot)) {
    return ["legacy", "openclaw", botKey, localSessionId, fingerprint].filter(Boolean).join(":");
  }
  return openClawAcpSessionKey(bot, localSessionId, fingerprint, {
    agentId: isMiaManagedRuntime(modelRuntime) ? openClawMiaAgentId(bot.engineConfig || {}) : ""
  });
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
  const args = [...buildOpenClawGlobalArgs(config), "agent"];
  const agentId = String(config.openclawAgent || config.agent || "main").trim();
  if (agentId) args.push("--agent", agentId);
  if (externalSessionId) args.push("--session-id", externalSessionId);
  args.push("--message", String(message || ""));
  const thinking = String(effort || config.effortLevel || "medium").trim();
  if (thinking) args.push("--thinking", thinking);
  if (local) args.push("--local");
  if (json) args.push("--json");
  if (timeoutSeconds) args.push("--timeout", String(timeoutSeconds));
  return args;
}

function normalizeOpenClawGatewayUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!/^wss?:$/i.test(url.protocol)) return raw;
    const hostname = String(url.hostname || "").toLowerCase();
    const port = url.port || (url.protocol === "wss:" ? "443" : "80");
    return url.protocol + "//" + hostname + ":" + port + (url.pathname || "");
  } catch {
    return raw;
  }
}

function isLoopbackOpenClawGatewayUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return true;
  try {
    const url = new URL(raw);
    const host = String(url.hostname || "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function openClawGatewayPortFromConfig(config = {}) {
  const explicit = Number(config.openclawGatewayPort || config.gatewayPort || 0);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 65535) return String(explicit);
  const gatewayUrl = String(config.openclawGatewayUrl || config.gatewayUrl || "").trim();
  if (!gatewayUrl) return "";
  try {
    const url = new URL(gatewayUrl);
    const port = Number(url.port || 0);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return String(port);
  } catch {
    // Ignore invalid URLs here; the ACP command will report the bad value later.
  }
  return "";
}

function shouldAutoStartOpenClawGateway(bot = {}, platform = process.platform) {
  const config = bot.engineConfig || {};
  if (config.openclawAutoStartGateway === false || config.autoStartOpenClawGateway === false) return false;
  const gatewayUrl = String(config.openclawGatewayUrl || config.gatewayUrl || "").trim();
  if (!isLoopbackOpenClawGatewayUrl(gatewayUrl)) return false;
  if (config.openclawAutoStartGateway === true || config.autoStartOpenClawGateway === true) return true;
  return platform === "win32";
}

function buildOpenClawGatewayProbeArgs(bot = {}) {
  const config = bot.engineConfig || {};
  const args = [...buildOpenClawGlobalArgs(config), "gateway", "status", "--json", "--timeout", "5000"];
  const gatewayUrl = String(config.openclawGatewayUrl || config.gatewayUrl || "").trim();
  if (gatewayUrl) args.push("--url", gatewayUrl);
  return args;
}

function buildOpenClawGatewayCallArgs(bot = {}, method = "", params = {}, timeoutMs = 10000) {
  const config = bot.engineConfig || {};
  const args = [
    ...buildOpenClawGlobalArgs(config),
    "gateway",
    "call",
    String(method || ""),
    "--json",
    "--timeout",
    String(timeoutMs),
    "--params",
    JSON.stringify(params && typeof params === "object" ? params : {})
  ];
  const gatewayUrl = String(config.openclawGatewayUrl || config.gatewayUrl || "").trim();
  if (gatewayUrl) args.push("--url", gatewayUrl);
  return args;
}

function buildOpenClawGatewayRunArgs(bot = {}) {
  const config = bot.engineConfig || {};
  const args = [...buildOpenClawGlobalArgs(config), "gateway", "run", "--allow-unconfigured", "--ws-log", "compact"];
  const port = openClawGatewayPortFromConfig(config);
  if (port) args.push("--port", port);
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

function delay(ms, signal = null) {
  if (signal?.aborted) return Promise.reject(stoppedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(stoppedError());
    }, { once: true });
  });
}

function buildOpenClawAcpArgs(bot = {}, options = {}) {
  const config = bot.engineConfig || {};
  const args = [...buildOpenClawGlobalArgs(config), "acp", "--no-prefix-cwd"];
  const sessionKey = String(options.sessionKey || "").trim();
  if (sessionKey) args.push("--session", sessionKey);
  const sessionLabel = String(config.openclawSessionLabel || "").trim();
  if (sessionLabel) args.push("--session-label", sessionLabel);
  if (config.openclawResetSession === true) args.push("--reset-session");
  if (config.openclawRequireExisting === true) args.push("--require-existing");
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

function openClawMiaModelRef(managedModel = {}, config = {}) {
  const model = String(config.model || managedModel.model || "mia-auto").trim() || "mia-auto";
  return "mia/" + model;
}

function openClawMiaWorkspaceDir(config = {}, runtimePaths = null, platform = process.platform) {
  const explicit = String(config.openclawMiaWorkspace || config.openclawWorkspace || "").trim();
  if (explicit) return explicit;
  let paths = null;
  try {
    paths = typeof runtimePaths === "function" ? runtimePaths() : null;
  } catch {
    paths = null;
  }
  if (paths?.home) return path.join(paths.home, "openclaw-workspace");
  const appData = String(process.env.APPDATA || "").trim();
  if (platform === "win32" && appData) return path.join(appData, "Mia", "runtime", "engine-home", "openclaw-workspace");
  return path.join(os.homedir(), ".mia", "openclaw-workspace");
}

function ensureOpenClawMiaWorkspace(workspaceDir = "") {
  const dir = String(workspaceDir || "").trim();
  if (!dir) return "";
  fs.mkdirSync(dir, { recursive: true });
  for (const fileName of OPENCLAW_MIA_BOOTSTRAP_FILES) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", { encoding: "utf8", mode: 0o600 });
  }
  return dir;
}

function openClawMiaAgentConfig(managedModel = {}, config = {}, runtimePaths = null, platform = process.platform) {
  return {
    id: openClawMiaAgentId(config),
    default: false,
    name: "Mia",
    workspace: openClawMiaWorkspaceDir(config, runtimePaths, platform),
    model: {
      primary: openClawMiaModelRef(managedModel, config),
      fallbacks: []
    },
    thinkingDefault: "off",
    reasoningDefault: "off",
    fastModeDefault: true,
    skills: [],
    memorySearch: {
      enabled: false,
      sources: []
    },
    tools: {
      allow: ["session_status"]
    }
  };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeOpenClawMiaAgentsList(existingAgents = [], miaAgent = {}) {
  const list = Array.isArray(existingAgents)
    ? existingAgents.filter((entry) => isPlainObject(entry))
    : [];
  const seeded = list.length > 0 ? list : [{ id: "main", default: true, name: "Main" }];
  const miaAgentId = normalizeOpenClawAgentId(miaAgent.id || OPENCLAW_MIA_AGENT_ID);
  let replaced = false;
  const next = seeded.map((entry) => {
    if (normalizeOpenClawAgentId(entry.id || "") !== miaAgentId) return entry;
    replaced = true;
    return {
      ...entry,
      ...miaAgent,
      id: miaAgentId,
      default: false
    };
  });
  if (!replaced) next.push({ ...miaAgent, id: miaAgentId, default: false });
  return next;
}

function openClawMiaProviderSetEntries(managedModel = {}, config = {}, agentsList = [], runtimePaths = null, platform = process.platform) {
  const patch = openClawMiaProviderPatch(managedModel, config);
  const providers = patch?.models?.providers || {};
  const miaAgent = openClawMiaAgentConfig(managedModel, config, runtimePaths, platform);
  const mergedAgentsList = mergeOpenClawMiaAgentsList(agentsList, miaAgent);
  return {
    patch,
    miaAgent,
    entries: [
      ...Object.entries(providers).map(([providerId, provider]) => ({
        path: "models.providers." + providerId,
        value: sanitizeOpenClawProviderForConfigSet(provider)
      })),
      {
        path: "agents.list",
        value: mergedAgentsList
      }
    ]
  };
}

function sanitizeOpenClawProviderForConfigSet(provider = {}) {
  const next = { ...(provider || {}) };
  delete next.agentRuntime;
  if (Array.isArray(provider.models)) {
    next.models = provider.models.map((model) => {
      const item = { ...(model || {}) };
      delete item.agentRuntime;
      return item;
    });
  }
  return next;
}

function writeOpenClawConfigBatchFile(entries = [], tempRoot = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tempRoot, "mia-openclaw-config-"));
  const filePath = path.join(dir, "batch.json");
  fs.writeFileSync(filePath, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

function cleanupOpenClawConfigBatchFile(tempFile = null) {
  if (!tempFile?.dir) return;
  try { fs.rmSync(tempFile.dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
}

function isOpenClawConfigPathNotFoundError(error) {
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout
  ].filter(Boolean).join("\n");
  return /Config path not found/i.test(text);
}

function isOpenClawConfigSetUnavailableError(error) {
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout
  ].filter(Boolean).join("\n");
  return /unknown command ['"]?set/i.test(text)
    || /unknown option ['"]?--batch-file/i.test(text)
    || /unknown option ['"]?--batch-json/i.test(text);
}

function isOpenClawConfigGetUnavailableError(error) {
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout
  ].filter(Boolean).join("\n");
  return /unknown command ['"]?get/i.test(text);
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
  if (/pairing required|NOT_PAIRED|not[-_ ]paired/i.test(text)) {
    return new Error([
      "OpenClaw Gateway 需要批准本机 ACP/CLI 设备。",
      "请在 OpenClaw 控制台批准 pending device，或运行 openclaw devices list 后执行 openclaw devices approve --latest。",
      raw || message
    ].filter(Boolean).join("\n"));
  }
  if (/Failed to parse JSON message|ACP connection closed/i.test(text) && raw) {
    return new Error("OpenClaw ACP 启动失败：" + raw);
  }
  return error instanceof Error ? error : new Error(message || "OpenClaw ACP 启动失败。");
}

function compactOpenClawErrorMessage(value = "") {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function openClawTranscriptFailureError(payload = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] || {};
    const stopReason = String(message.stopReason || message.stop_reason || "").trim().toLowerCase();
    const errorMessage = compactOpenClawErrorMessage(message.errorMessage || message.error_message || "");
    if (stopReason === "error" || errorMessage) {
      return new Error([
        "OpenClaw agent 运行失败。",
        errorMessage || "OpenClaw 返回错误但没有提供错误详情。"
      ].join("\n"));
    }
  }
  return null;
}

function openClawTranscriptAssistantText(payload = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] || {};
    if (String(message.role || "").trim() !== "assistant") continue;
    const content = message.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => !block?.type || block.type === "text")
        .map((block) => firstTextValue(block))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
      continue;
    }
    const text = firstTextValue(content || message).trim();
    if (text) return text;
  }
  return "";
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

function objectCapability(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function acpMcpCapabilityOptions(metadata = {}) {
  const capabilities = metadata?.agentCapabilities || metadata?.capabilities || metadata || {};
  const explicitMcp = objectCapability(capabilities.mcp)
    || objectCapability(capabilities.mcpCapabilities)
    || objectCapability(capabilities.mcp_capabilities)
    || objectCapability(capabilities.mcpServers)
    || objectCapability(capabilities.mcp_servers);
  const mcp = explicitMcp || {};
  const mcpServerFlag = capabilities.mcpServers ?? capabilities.mcp_servers;
  const transports = mcp.transports || mcp.supportedTransports || mcp.supported_transports || capabilities.mcpTransports || capabilities.mcp_transports || [];
  const hasExplicitMcpCapabilities = Boolean(explicitMcp)
    || mcpServerFlag != null
    || Array.isArray(capabilities.mcpTransports)
    || Array.isArray(capabilities.mcp_transports);
  return {
    supportsHttp: truthyCapability(mcp.http)
      || truthyCapability(mcp.supportsHttp)
      || truthyCapability(mcp.supports_http)
      || transportListHas(transports, "http")
      || transportListHas(transports, "streamable_http"),
    supportsSse: truthyCapability(mcp.sse)
      || truthyCapability(mcp.supportsSse)
      || truthyCapability(mcp.supports_sse)
      || transportListHas(transports, "sse"),
    supportsSessionServers: truthyCapability(mcp.sessionServers)
      || truthyCapability(mcp.session_servers)
      || truthyCapability(mcp.perSessionServers)
      || truthyCapability(mcp.per_session_servers)
      || truthyCapability(mcp.perSession)
      || truthyCapability(mcp.per_session)
      || truthyCapability(mcpServerFlag)
      || !hasExplicitMcpCapabilities
  };
}

const openClawAcpRuntimePool = new Map();
const openClawGatewayRuntimePool = new Map();
const openClawManagedConfigSyncCache = new Map();

function openClawGatewayRuntimeKey(parts = {}) {
  return JSON.stringify({
    commandPath: String(parts.commandPath || ""),
    args: Array.isArray(parts.args) ? parts.args : [],
    cwd: String(parts.cwd || ""),
    gatewayUrl: normalizeOpenClawGatewayUrl(parts.gatewayUrl || ""),
    envPath: String(parts.env?.PATH || parts.env?.Path || "")
  });
}

function parseOpenClawGatewayProbeOk(stdout = "") {
  const raw = String(stdout || "").trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(jsonFragmentFromText(raw) || raw);
    if (parsed?.ok === true) return true;
    if (parsed?.rpc?.ok === true) return true;
    const targets = Array.isArray(parsed?.targets) ? parsed.targets : [];
    return targets.some((target) => target?.connect?.ok === true && target?.connect?.rpcOk !== false);
  } catch {
    return false;
  }
}

function closeOpenClawGatewayRuntimeEntry(entry) {
  if (!entry) return;
  openClawGatewayRuntimePool.delete(entry.key);
  entry.expectedExit = true;
  try { entry.child?.kill?.(); } catch { /* already exited */ }
}

function closeOpenClawGatewayRuntimes() {
  for (const entry of openClawGatewayRuntimePool.values()) {
    closeOpenClawGatewayRuntimeEntry(entry);
  }
  openClawGatewayRuntimePool.clear();
}

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
  closeOpenClawGatewayRuntimes();
}

function openClawEnvArray(env = {}) {
  return Object.entries(env && typeof env === "object" ? env : {})
    .filter(([, value]) => value != null)
    .map(([name, value]) => ({ name, value: String(value) }));
}

function openClawStdioMcpServer(name, spec = {}) {
  if (!spec || spec.type !== "stdio" || !spec.command) return null;
  return {
    name,
    command: spec.command,
    args: Array.isArray(spec.args) ? spec.args.slice() : [],
    env: openClawEnvArray(spec.env)
  };
}

function mergeOpenClawMcpServers(userServers = [], builtInServers = []) {
  const builtIns = (Array.isArray(builtInServers) ? builtInServers : []).filter(Boolean);
  if (!builtIns.length) return Array.isArray(userServers) ? userServers : [];
  const reserved = new Set(builtIns.map((server) => String(server.name || "").trim()).filter(Boolean));
  const users = (Array.isArray(userServers) ? userServers : [])
    .filter((server) => !reserved.has(String(server?.name || "").trim()));
  return [...users, ...builtIns];
}

function hasOpenClawMiaAppMcpServer(mcpServers = []) {
  return (Array.isArray(mcpServers) ? mcpServers : [])
    .some((server) => String(server?.name || "").trim() === "mia-app");
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
  const injectGroupContextForSdk = requireDependency(deps, "injectGroupContextForSdk");
  const readBotPersona = requireDependency(deps, "readBotPersona");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const normalizeEffortLevel = requireDependency(deps, "normalizeEffortLevel");
  const getAgentSessionId = requireDependency(deps, "getAgentSessionId");
  const setAgentSessionId = requireDependency(deps, "setAgentSessionId");
  const getUserMcpServers = deps.getUserMcpServers || (() => []);
  const getMiaAppMcpSpec = deps.getMiaAppMcpSpec || (() => null);
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
  const platform = deps.platform || process.platform;
  const nodePath = deps.nodePath || process.execPath;
  const runtimePaths = typeof deps.runtimePaths === "function" ? deps.runtimePaths : null;
  const cwd = deps.cwd || (() => process.cwd());
  const timeoutSeconds = Number.isFinite(Number(deps.timeoutSeconds)) ? Number(deps.timeoutSeconds) : 600;

  function builtInOpenClawMcpServers({ bot, sessionId, originMessageId = "" } = {}) {
    const miaAppSpec = (() => {
      try {
        return getMiaAppMcpSpec({ botId: bot?.key || bot?.id || "", sessionId, originMessageId });
      } catch {
        return null;
      }
    })();
    return [
      openClawStdioMcpServer("mia-app", miaAppSpec)
    ].filter(Boolean);
  }

  async function openClawAcpSessionMcpServers(initialized, { bot, sessionId, originMessageId = "" } = {}) {
    const capabilities = acpMcpCapabilityOptions(initialized);
    if (!capabilities.supportsSessionServers) {
      appendEngineLog("OpenClaw ACP does not advertise per-session MCP server support; skipping Mia MCP injection for this session.");
      return [];
    }
    try {
      await ensureUserMcpReady();
    } catch (error) {
      appendEngineLog("MCP bridge initialization incomplete before OpenClaw chat: " + (error?.message || error));
    }
    const userMcpServers = getUserMcpServers({
      supportsHttp: capabilities.supportsHttp,
      supportsSse: capabilities.supportsSse
    });
    return mergeOpenClawMcpServers(
      userMcpServers,
      builtInOpenClawMcpServers({ bot, sessionId, originMessageId })
    );
  }

  async function readOpenClawConfigJsonPath(commandPath, configPath = "", commonOptions = {}) {
    try {
      const result = await execFileAsync(execFile, commandPath, ["config", "get", configPath, "--json"], commonOptions, { platform, nodePath });
      const raw = String(result.stdout || "").trim();
      if (!raw) return undefined;
      return JSON.parse(jsonFragmentFromText(raw) || raw);
    } catch (error) {
      if (isOpenClawConfigPathNotFoundError(error) || isOpenClawConfigGetUnavailableError(error)) return undefined;
      throw error;
    }
  }

  async function syncOpenClawManagedModelConfig(commandPath, managedModel = {}, config = {}, signal = null) {
    const commonOptions = {
      cwd: cwd(),
      env: envWithExecutableDirFirst(processEnvStrings(), commandPath),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      signal
    };
    const agentsList = await readOpenClawConfigJsonPath(commandPath, "agents.list", commonOptions);
    const { patch, entries, miaAgent } = openClawMiaProviderSetEntries(
      managedModel,
      config,
      Array.isArray(agentsList) ? agentsList : [],
      runtimePaths,
      platform
    );
    ensureOpenClawMiaWorkspace(miaAgent.workspace);
    const cacheKey = JSON.stringify({
      commandPath: String(commandPath || ""),
      entries
    });
    if (openClawManagedConfigSyncCache.get(commandPath) === cacheKey) return { applied: false, miaAgent };
    let tempFile = null;
    try {
      tempFile = writeOpenClawConfigBatchFile(entries);
      await execFileAsync(execFile, commandPath, ["config", "set", "--batch-file", tempFile.filePath], commonOptions, { platform, nodePath });
    } catch (error) {
      if (!isOpenClawConfigSetUnavailableError(error)) throw error;
      appendEngineLog("OpenClaw config set --batch-file unavailable; falling back to config patch --stdin.");
      await execFileAsync(execFile, commandPath, ["config", "patch", "--stdin"], {
        ...commonOptions,
        input: JSON.stringify(patch)
      }, { platform, nodePath });
    } finally {
      cleanupOpenClawConfigBatchFile(tempFile);
    }
    openClawManagedConfigSyncCache.set(commandPath, cacheKey);
    return { applied: true, miaAgent };
  }

  async function probeOpenClawGateway(commandPath, bot = {}, env = {}, signal = null) {
    try {
      const result = await execFileAsync(execFile, commandPath, buildOpenClawGatewayProbeArgs(bot), {
        cwd: cwd(),
        env,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        signal
      }, { platform, nodePath });
      return parseOpenClawGatewayProbeOk(result.stdout);
    } catch (error) {
      if (parseOpenClawGatewayProbeOk(error?.stdout)) return true;
      return false;
    }
  }

  async function readOpenClawGatewaySession(commandPath, bot = {}, env = {}, sessionKey = "", signal = null) {
    const key = String(sessionKey || "").trim();
    if (!key) return null;
    const result = await execFileAsync(execFile, commandPath, buildOpenClawGatewayCallArgs(bot, "sessions.get", { key }, 10000), {
      cwd: cwd(),
      env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      signal
    }, { platform, nodePath });
    const raw = String(result.stdout || "").trim();
    if (!raw) return null;
    return JSON.parse(jsonFragmentFromText(raw) || raw);
  }

  async function recoverOpenClawAcpEmptyContent({ commandPath, bot, env, sessionKey, content, signal } = {}) {
    const existing = String(content || "").trim();
    if (existing) return existing;
    try {
      const transcript = await readOpenClawGatewaySession(commandPath, bot, env, sessionKey, signal);
      const failure = openClawTranscriptFailureError(transcript);
      if (failure) throw failure;
      const recovered = openClawTranscriptAssistantText(transcript);
      if (recovered) {
        appendEngineLog("Recovered OpenClaw ACP text from Gateway transcript after empty ACP chunks.");
        return recovered;
      }
    } catch (error) {
      if (error?.code === "MIA_STOPPED" || error?.message?.startsWith?.("OpenClaw agent 运行失败。")) throw error;
      appendEngineLog("Unable to inspect OpenClaw session after empty ACP response: " + (error?.message || error));
    }
    return existing;
  }

  async function waitForOpenClawGatewayReady({ commandPath, bot, env, signal, entry }) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw stoppedError();
      if (await probeOpenClawGateway(commandPath, bot, env, signal)) return;
      if (entry?.exited) {
        const output = entry.outputChunks.join("").trim();
        throw new Error("OpenClaw Gateway 启动失败：" + (output || "gateway run 进程已退出。"));
      }
      await delay(500, signal);
    }
    const output = entry?.outputChunks?.join("")?.trim?.() || "";
    throw new Error("OpenClaw Gateway 启动后仍不可连接。" + (output ? "\n" + output : ""));
  }

  async function ensureOpenClawGateway(commandPath, bot = {}, env = {}, signal = null) {
    if (!shouldAutoStartOpenClawGateway(bot, platform)) return;
    if (await probeOpenClawGateway(commandPath, bot, env, signal)) return;

    const args = buildOpenClawGatewayRunArgs(bot);
    const gatewayUrl = String(bot.engineConfig?.openclawGatewayUrl || bot.engineConfig?.gatewayUrl || "").trim();
    const key = openClawGatewayRuntimeKey({
      commandPath,
      args,
      cwd: cwd(),
      gatewayUrl,
      env
    });
    const existing = openClawGatewayRuntimePool.get(key);
    if (existing && !existing.exited) {
      await waitForOpenClawGatewayReady({ commandPath, bot, env, signal, entry: existing });
      return;
    }

    const outputChunks = [];
    const entry = {
      key,
      child: null,
      outputChunks,
      expectedExit: false,
      exited: false,
      exitCode: null,
      exitSignal: ""
    };
    openClawGatewayRuntimePool.set(key, entry);
    appendEngineLog("OpenClaw Gateway is not reachable; starting local gateway runtime.");
    const child = spawnOpenClaw(spawn, commandPath, args, {
      cwd: cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    }, { platform, nodePath });
    entry.child = child;
    child.stdout?.on("data", (chunk) => rememberChunk(outputChunks, chunk));
    child.stderr?.on("data", (chunk) => rememberChunk(outputChunks, chunk));
    child.once("error", (error) => {
      entry.exited = true;
      rememberChunk(outputChunks, error?.message || error);
    });
    child.once("exit", (code, signalName) => {
      entry.exited = true;
      entry.exitCode = code;
      entry.exitSignal = signalName || "";
      if (!entry.expectedExit) openClawGatewayRuntimePool.delete(key);
    });

    try {
      await waitForOpenClawGatewayReady({ commandPath, bot, env, signal, entry });
      appendEngineLog("OpenClaw Gateway local runtime is ready.");
    } catch (error) {
      closeOpenClawGatewayRuntimeEntry(entry);
      throw error;
    }
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
      }, { platform, nodePath });
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
      originMessageId,
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
    const child = spawnOpenClaw(spawn, commandPath, args, {
      cwd: cwdValue,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }, { platform, nodePath });
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
    const mcpServers = await openClawAcpSessionMcpServers(initialized, { bot, sessionId, originMessageId });
    entry.mcpContextAvailable = hasOpenClawMiaAppMcpServer(mcpServers);
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
      mcpServers,
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
    builtInOpenClawMcpServers(context);
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
    const message = typeof context.messageBuilder === "function"
      ? context.messageBuilder({
          mcpAvailable: entry.mcpContextAvailable === true,
          transport: "acp"
        })
      : context.message;
    try {
      const response = await Promise.race([
        withChildFailure(entry.client.prompt({
          sessionId: entry.acpSessionId,
          prompt: [{ type: "text", text: String(message || "") }],
          _meta: promptMeta
        }), entry.failure),
        abortPromise
      ]);
      if (context.signal?.aborted || response?.stopReason === "cancelled") throw stoppedError();
      const content = await recoverOpenClawAcpEmptyContent({
        commandPath: context.commandPath,
        bot: context.bot,
        env: context.env,
        sessionKey: entry.sessionKey,
        content: chunks.join("").trim(),
        signal: context.signal
      });
      return {
        content,
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

  async function runOpenClawAcp({ bot, sessionId, message, messageBuilder = null, signal, emit = null, persistAgentSession = true, managedModel: providedManagedModel = null, originMessageId = "" } = {}) {
    const commandPath = shellCommandPath("openclaw") || shellCommandPath("claw");
    if (!commandPath) throw new Error("本机没有检测到 OpenClaw CLI。请先安装并确认 openclaw --version 可用。");
    const effectiveRuntime = providedManagedModel || resolveModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    const isManagedOpenClaw = isMiaManagedRuntime(effectiveRuntime);
    let managedConfigSync = null;
    if (isManagedOpenClaw) {
      managedConfigSync = await syncOpenClawManagedModelConfig(commandPath, effectiveRuntime, bot.engineConfig || {}, signal);
      if (managedConfigSync?.applied) closeOpenClawAcpRuntimes();
    }
    const modelOverride = selectedOpenClawModelOverride(bot.engineConfig || {}, effectiveRuntime);

    const mcpFingerprint = getMcpFingerprint();
    const desiredSessionKey = openClawAcpSessionKey(bot, sessionId, mcpFingerprint, {
      agentId: isManagedOpenClaw ? openClawMiaAgentId(bot.engineConfig || {}) : ""
    });
    const storedSessionKey = persistAgentSession ? getAgentSessionId("openclaw", bot.key, sessionId) : "";
    const sessionKey = storedSessionKey === desiredSessionKey ? storedSessionKey : desiredSessionKey;
    const effort = selectedOpenClawEffort(bot.engineConfig || {}, effectiveRuntime, normalizeEffortLevel);
    const stdoutChunks = [];
    const stderrChunks = [];
    const outputChunks = [];
    let expectedExit = false;
    let acpSessionId = "";
    const cwdValue = cwd();
    const env = envWithExecutableDirFirst(processEnvStrings(), commandPath);
    await ensureOpenClawGateway(commandPath, bot, env, signal);
    const args = buildOpenClawAcpArgs(bot, { sessionKey });
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
        originMessageId,
        effort,
        modelOverride,
        signal,
        emit,
        message,
        messageBuilder
      });
    }
    const child = spawnOpenClaw(spawn, commandPath, args, {
      cwd: cwdValue,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }, { platform, nodePath });
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
      const mcpServers = await openClawAcpSessionMcpServers(initialized, { bot, sessionId, originMessageId });
      const mcpContextAvailable = hasOpenClawMiaAppMcpServer(mcpServers);
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
        mcpServers,
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
      const finalMessage = typeof messageBuilder === "function"
        ? messageBuilder({ mcpAvailable: mcpContextAvailable, transport: "acp" })
        : message;
      const response = await withChildFailure(client.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: String(finalMessage || "") }],
        _meta: promptMeta
      }), failure);
      if (signal?.aborted || response?.stopReason === "cancelled") throw stoppedError();
      const content = await recoverOpenClawAcpEmptyContent({
        commandPath,
        bot,
        env,
        sessionKey,
        content: chunks.join("").trim(),
        signal
      });
      return {
        content,
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

  async function runOpenClaw({ bot, sessionId, message, messageBuilder = null, signal, emit = null, persistAgentSession = true, originMessageId = "", modelRuntime: providedModelRuntime = null } = {}) {
    const modelRuntime = providedModelRuntime || resolveModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    const useLegacy = shouldUseLegacyOpenClawTransport(bot, modelRuntime);
    if (useLegacy) {
      const finalMessage = typeof messageBuilder === "function"
        ? messageBuilder({ mcpAvailable: false, transport: "openclaw-cli" })
        : message;
      const result = await runOpenClawLegacy({ bot, sessionId, message: finalMessage, signal, persistAgentSession, managedModel: modelRuntime });
      return {
        ...result,
        compatibilityTransport: "openclaw-cli"
      };
    }
    try {
      const result = await runOpenClawAcp({ bot, sessionId, message, messageBuilder, signal, emit, persistAgentSession, managedModel: modelRuntime, originMessageId });
      return {
        ...result,
        compatibilityTransport: ""
      };
    } catch (error) {
      if (!isMiaManagedRuntime(modelRuntime) || !isOpenClawGatewayUnavailableError(error)) throw error;
      if (!shouldAllowOpenClawLocalFallback(bot)) {
        appendEngineLog("OpenClaw ACP Gateway unavailable; local CLI fallback disabled to avoid OpenClaw embedded bootstrap prompt.");
        const guarded = new Error(
          "OpenClaw ACP/Gateway 不可用。Mia 没有自动降级到 OpenClaw 本地 embedded agent，以避免注入完整 OpenClaw 工作区上下文并产生高 token 消耗。请修复 OpenClaw Gateway/ACP，或显式开启 openclawAllowLocalFallback。原始错误：" + (error?.message || error)
        );
        guarded.cause = error;
        throw guarded;
      }
      appendEngineLog("OpenClaw ACP Gateway unavailable; falling back to local CLI for Mia-managed model because openclawAllowLocalFallback is enabled.");
      const finalMessage = typeof messageBuilder === "function"
        ? messageBuilder({ mcpAvailable: false, transport: "openclaw-cli-fallback" })
        : message;
      const result = await runOpenClawLegacy({ bot, sessionId, message: finalMessage, signal, persistAgentSession, managedModel: modelRuntime });
      return {
        ...result,
        compatibilityTransport: "openclaw-cli-fallback"
      };
    }
  }

  async function sendChat({ bot, sessionId, messages, group, signal, emit = null, utility = false, scheduledFire = false, persistAgentSession = !utility, skillMaterialization = null }) {
    const lastUserMessage = Array.isArray(messages) ? [...messages].reverse().find((m) => m?.role === "user") : null;
    const originMessageId = String(lastUserMessage?.id || "");
    const lastUser = lastUserPrompt(messages);
    const expandedPrompt = sanitizeMiaMemorySpoof(expandLeadingSkillCommand(lastUser, { mode: "inline" }) || lastUser);
    const memoryMcpFingerprint = getMcpFingerprint();
    const modelRuntime = resolveModelRuntime(bot.engineConfig || {}, { engine: "openclaw", bot });
    const nativeSessionCacheKey = openClawNativeContextSessionKey({
      bot,
      sessionId,
      mcpFingerprint: memoryMcpFingerprint,
      modelRuntime,
      persistAgentSession
    });
    const requestedContextMode = nativeContextModeFromConfig(bot, null, "openclaw");
    const resetNativeSession = bot.engineConfig?.openclawResetSession === true;
    let lastUserIndex = -1;
    const visibleMessages = Array.isArray(messages) ? messages : [];
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      if (visibleMessages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const visibleHistoryMessages = lastUserIndex >= 0
      ? visibleMessages.filter((_, index) => index !== lastUserIndex)
      : visibleMessages.slice(0, -1);
    const attachments = messagesAttachmentStats(visibleMessages);
    const promptCache = new Map();
    const buildOpenClawPrompt = ({ mcpAvailable = false, transport = "" } = {}) => {
      const cacheKey = JSON.stringify({ mcpAvailable: Boolean(mcpAvailable), transport: String(transport || "") });
      if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);
      const nativeContextMode = selectNativeContextMode({
        requestedMode: requestedContextMode,
        mcpAvailable
      });
      const rawMiaMemory = nativeContextMode === "prompt"
        ? memoryBlock({ botId: bot.key, sessionId })
        : "";
      const miaMemory = memoryBlockForNativeSession({
        engine: "openclaw",
        botId: bot.key,
        sessionId,
        nativeSessionId: nativeSessionCacheKey,
        persistAgentSession,
        memoryBlock: rawMiaMemory,
        memoryInjectionMode: openClawMemoryInjectionMode(bot),
        resetNativeSession
      });
      const rawPersona = nativeContextMode === "mcp"
        ? contextSnapshotInstruction({ engine: "openclaw", botId: bot.key, sessionId })
        : nativeContextMode === "prompt"
          ? withMiaRuntimeContext(readBotPersona(bot.key, bot.name, bot.bio), { scheduledFire })
          : "";
      const nativePersona = personaBlockForNativeSession({
        engine: "openclaw",
        botId: bot.key,
        sessionId,
        nativeSessionId: nativeSessionCacheKey,
        persistAgentSession,
        personaBlock: rawPersona,
        personaInjectionMode: openClawPersonaInjectionMode(bot),
        resetNativeSession
      });
      const nativeContext = appendMiaMemoryBlock(nativePersona, miaMemory).trim();
      const effectiveSkillMaterialization = skillMaterializationForNativeSession({
        engine: "openclaw",
        botId: bot.key,
        sessionId,
        nativeSessionId: nativeSessionCacheKey,
        persistAgentSession,
        skillMaterialization,
        skillIndexMode: openClawSkillIndexMode(bot),
        resetNativeSession
      });
      const skillContext = buildSkillMaterializationContext(effectiveSkillMaterialization);
      const prompt = [
        nativeContext ? ["Mia native context for the current bot/session:", "", nativeContext].join("\n") : "",
        skillContext,
        ["用户消息：", expandedPrompt].join("\n")
      ].filter(Boolean).join("\n\n");
      const promptWithGroup = group && group.contextBlock
        ? injectGroupContextForSdk(prompt, group.contextBlock)
        : prompt;
      appendEngineLog(buildContextBudgetLogLine({
        engine: "openclaw",
        botId: bot.key,
        sessionId,
        nativeSessionId: nativeSessionCacheKey,
        transport: transport || (shouldUseLegacyOpenClawTransport(bot) ? "openclaw-cli" : "acp"),
        historyMode: "native",
        nativeHistory: persistAgentSession,
        promptChars: textCharCount(promptWithGroup),
        currentUserChars: textCharCount(expandedPrompt),
        personaChars: textCharCount(nativePersona),
        memoryChars: textCharCount(miaMemory),
        skillIndexChars: textCharCount(effectiveSkillMaterialization?.indexBlock),
        loadedSkillChars: textCharCount(effectiveSkillMaterialization?.loadedBlock),
        visibleHistoryChars: messagesTextChars(visibleHistoryMessages),
        includedHistoryChars: 0,
        groupChars: textCharCount(group?.contextBlock),
        attachmentCount: attachments.count,
        attachmentBytes: attachments.bytes
      }));
      promptCache.set(cacheKey, promptWithGroup);
      return promptWithGroup;
    };
    const result = await runOpenClaw({
      bot,
      sessionId,
      messageBuilder: buildOpenClawPrompt,
      signal,
      emit,
      persistAgentSession,
      originMessageId,
      modelRuntime
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
