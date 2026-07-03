const { spawn: defaultSpawn } = require("node:child_process");
const path = require("node:path");
const { spawnExecutable } = require("./agent-runtime/process-launcher.js");
const { mergeAssistantText } = require("../shared/assistant-content-blocks.js");

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

function stoppedError() {
  const stopped = new Error("生成已停止");
  stopped.code = "MIA_STOPPED";
  return stopped;
}

function sameTrimmedText(left, right) {
  return String(left || "").trim() === String(right || "").trim();
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

function createClaudeCodeStatelessAdapter(deps = {}) {
  const shellCommandPath = requireDependency(deps, "shellCommandPath");
  const claudeAgentSdk = requireDependency(deps, "claudeAgentSdk");
  const processEnvStrings = requireDependency(deps, "processEnvStrings");
  const cwd = deps.cwd || (() => process.cwd());
  const appendEngineLog = deps.appendEngineLog || (() => {});
  const spawnClaudeCodeProcess = deps.spawnClaudeCodeProcess || createClaudeCodeProcessSpawner({
    appendEngineLog,
    platform: deps.platform || process.platform,
    spawn: deps.spawn || defaultSpawn
  });

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
    let assistantText = "";
    let lastAssistantSnapshot = "";
    for await (const message of stream) {
      if (signal?.aborted) break;
      if (message?.type === "assistant") {
        const text = claudeMessageText(message);
        if (text && !sameTrimmedText(lastAssistantSnapshot, text)) {
          assistantText = mergeAssistantText(assistantText, text).text;
          lastAssistantSnapshot = text;
        }
      }
    }
    if (signal?.aborted) throw stoppedError();
    return { content: assistantText.trim() };
  }

  return { sendStateless };
}

module.exports = {
  claudeMessageText,
  createClaudeCodeProcessSpawner,
  createClaudeCodeStatelessAdapter,
  normalizeClaudePermissionMode
};
