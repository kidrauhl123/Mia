const { execFile: defaultExecFile, spawn: defaultSpawn } = require("node:child_process");
const crypto = require("node:crypto");
const { PassThrough, Readable, Writable } = require("node:stream");
const {
  buildOpenClawAcpArgs,
  buildOpenClawGlobalArgs,
  execFileAsync,
  spawnOpenClaw
} = require("./agent-session/acp-engine-specs.js");

function requireDependency(deps, key) {
  if (typeof deps[key] !== "function") throw new Error(String(key) + " dependency is required.");
  return deps[key];
}

function envWithExecutableDirFirst(env = {}, executablePath = "") {
  const dir = require("node:path").dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const currentPath = String(env?.PATH || env?.Path || "");
  const delimiter = process.platform === "win32" && !currentPath.includes(";") && !/^[A-Za-z]:[\\/]/.test(currentPath)
    ? ":"
    : process.platform === "win32" ? ";" : require("node:path").delimiter;
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
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
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
        try {
          JSON.parse(fragment);
          return fragment;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function rememberChunk(chunks, chunk, limit = 12000) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  if (!text) return;
  chunks.push(text);
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > limit && chunks.length > 1) {
    total -= (chunks.shift() || "").length;
  }
}

function childFailurePromise(child, outputChunks, isExpectedExit) {
  const promise = new Promise((_, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (isExpectedExit()) return;
      if (code && code !== 0) {
        const details = outputChunks.join("").trim();
        reject(new Error("OpenClaw ACP 进程退出失败：code=" + code + (signal ? " signal=" + signal : "") + (details ? "\n" + details : "")));
      }
    });
  });
  promise.catch(() => {});
  return promise;
}

function withChildFailure(promise, failurePromise) {
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
    // Invalid values surface later from the CLI.
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
      return new Error(["OpenClaw agent 运行失败。", errorMessage || "OpenClaw 返回错误但没有提供错误详情。"].join("\n"));
    }
  }
  return null;
}

function openClawTranscriptAssistantText(payload = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] || {};
    if (String(message.role || "").trim() !== "assistant") continue;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => !block?.type || block.type === "text")
        .map((block) => firstTextValue(block))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
      continue;
    }
    const text = firstTextValue(message.content || message).trim();
    if (text) return text;
  }
  return "";
}

const openClawGatewayRuntimePool = new Map();

function openClawGatewayRuntimeKey(parts = {}) {
  return JSON.stringify({
    commandPath: String(parts.commandPath || ""),
    args: Array.isArray(parts.args) ? parts.args : [],
    cwd: String(parts.cwd || ""),
    gatewayUrl: normalizeOpenClawGatewayUrl(parts.gatewayUrl || ""),
    envPath: String(parts.env?.PATH || parts.env?.Path || "")
  });
}

function closeOpenClawGatewayRuntimeEntry(entry) {
  if (!entry) return;
  openClawGatewayRuntimePool.delete(entry.key);
  entry.expectedExit = true;
  try { entry.child?.kill?.(); } catch {}
}

function closeOpenClawAcpRuntimes() {
  for (const entry of openClawGatewayRuntimePool.values()) {
    closeOpenClawGatewayRuntimeEntry(entry);
  }
  openClawGatewayRuntimePool.clear();
}

async function defaultImportAcpSdk() {
  return import("@agentclientprotocol/sdk");
}

function createOpenClawStatelessAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const appendEngineLog = typeof deps.appendEngineLog === "function" ? deps.appendEngineLog : () => {};
  const execFile = deps.execFile || defaultExecFile;
  const spawn = deps.spawn || defaultSpawn;
  const importAcpSdk = deps.importAcpSdk || defaultImportAcpSdk;
  const platform = deps.platform || process.platform;
  const nodePath = deps.nodePath || process.execPath;
  const cwd = typeof deps.cwd === "function" ? deps.cwd : () => process.cwd();
  const timeoutSeconds = Number.isFinite(Number(deps.timeoutSeconds)) ? Number(deps.timeoutSeconds) : 600;

  async function probeOpenClawGateway(commandPath, bot, env, signal) {
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

  async function readOpenClawGatewaySession(commandPath, bot, env, sessionKey, signal) {
    const result = await execFileAsync(execFile, commandPath, buildOpenClawGatewayCallArgs(bot, "sessions.get", { key: sessionKey }, 10000), {
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

  async function recoverOpenClawAcpEmptyContent({ commandPath, bot, env, sessionKey, content, signal }) {
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

  async function ensureOpenClawGateway(commandPath, bot, env, signal) {
    if (!shouldAutoStartOpenClawGateway(bot, platform)) return;
    if (await probeOpenClawGateway(commandPath, bot, env, signal)) return;

    const args = buildOpenClawGatewayRunArgs(bot);
    const gatewayUrl = String(bot.engineConfig?.openclawGatewayUrl || bot.engineConfig?.gatewayUrl || "").trim();
    const key = openClawGatewayRuntimeKey({ commandPath, args, cwd: cwd(), gatewayUrl, env });
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
      exited: false
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
    child.once("exit", () => {
      entry.exited = true;
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

  async function runStatelessAcp({ message, signal }) {
    const bot = { key: "stateless", name: "OpenClaw", engineConfig: {} };
    const commandPath = shellCommandPath("openclaw") || shellCommandPath("claw");
    if (!commandPath) throw new Error("本机没有检测到 OpenClaw CLI。请先安装并确认 openclaw --version 可用。");
    const sessionKey = "openclaw:mia:stateless:stateless-" + crypto.randomUUID();
    const env = envWithExecutableDirFirst(processEnvStrings(), commandPath);
    await ensureOpenClawGateway(commandPath, bot, env, signal);

    const args = buildOpenClawAcpArgs(bot, { sessionKey });
    const outputChunks = [];
    let expectedExit = false;
    const child = spawnOpenClaw(spawn, commandPath, args, {
      cwd: cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }, { platform, nodePath });
    if (!child.stdin || !child.stdout) {
      try { child.kill(); } catch {}
      throw new Error("OpenClaw ACP 无法创建 stdio 通道。");
    }

    const acpStdout = new PassThrough();
    child.stdout.on("data", (chunk) => rememberChunk(outputChunks, chunk));
    child.stdout.pipe(acpStdout);
    child.stderr?.on("data", (chunk) => rememberChunk(outputChunks, chunk));
    const failure = childFailurePromise(child, outputChunks, () => expectedExit);

    let acpSessionId = "";
    let client = null;
    const chunks = [];
    const abortHandler = () => {
      if (client && acpSessionId) {
        client.cancel({ sessionId: acpSessionId }).catch(() => {});
      }
      try { child.kill(); } catch {}
    };
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });

    try {
      if (signal?.aborted) throw stoppedError();
      const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = await importAcpSdk();
      client = new ClientSideConnection(() => ({
        sessionUpdate: async (params = {}) => {
          const update = params.update || {};
          if (update.sessionUpdate !== "agent_message_chunk") return;
          const text = firstTextValue(update.content || update.text || update.delta || update.message);
          if (text) chunks.push(text);
        }
      }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(acpStdout)));

      await withChildFailure(client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
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
          prefixCwd: false
        }
      }), failure);
      acpSessionId = String(session?.sessionId || "");
      if (!acpSessionId) throw new Error("OpenClaw ACP 没有返回 sessionId。");

      const response = await withChildFailure(client.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: String(message || "") }],
        _meta: {
          timeoutMs: timeoutSeconds * 1000,
          prefixCwd: false
        }
      }), failure);
      if (signal?.aborted || response?.stopReason === "cancelled") throw stoppedError();

      return {
        content: await recoverOpenClawAcpEmptyContent({
          commandPath,
          bot,
          env,
          sessionKey,
          content: chunks.join("").trim(),
          signal
        })
      };
    } catch (error) {
      if (signal?.aborted) throw stoppedError();
      throw decorateOpenClawAcpError(error, outputChunks.join(""));
    } finally {
      if (signal) signal.removeEventListener("abort", abortHandler);
      expectedExit = true;
      try { child.stdin?.end(); } catch {}
      try { child.kill(); } catch {}
    }
  }

  async function sendStateless({ systemPrompt, userPrompt, signal }) {
    const message = [systemPrompt, userPrompt].filter(Boolean).join("\n\n");
    return runStatelessAcp({ message, signal });
  }

  return { sendStateless };
}

module.exports = {
  closeOpenClawAcpRuntimes,
  createOpenClawStatelessAdapter
};
