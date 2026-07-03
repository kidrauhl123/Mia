const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_CLOUD_CLAUDE_CODE_MODEL, normalizeCloudClaudeCodeModel } = require("./cloud-claude-code-model.js");

const DEFAULT_AGENT_ROOT = path.join(os.tmpdir(), "mia-cloud-claude-code");
const DEFAULT_DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_AGENT_PYTHON_VENV = "/opt/mia-agent-runtime/python";
const DEFAULT_PIP_INDEX_URL = "https://mirrors.tencent.com/pypi/simple";

function envFlag(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function envDisabled(value) {
  return ["0", "false", "no", "off"].includes(String(value ?? "").trim().toLowerCase());
}

function safePathSegment(value, fallback = "user") {
  const segment = String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96).replace(/\.\./g, "__");
  if (segment === "." || segment === "..") return fallback;
  return segment || fallback;
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function deepSeekAnthropicBaseUrl(options = {}) {
  return String(
    options.anthropicBaseUrl
      || options.baseUrl
      || process.env.MIA_CLOUD_CLAUDE_CODE_BASE_URL
      || process.env.MIA_DEEPSEEK_ANTHROPIC_BASE_URL
      || DEFAULT_DEEPSEEK_ANTHROPIC_BASE_URL
  ).trim().replace(/\/+$/, "");
}

function deepSeekApiKey(options = {}) {
  return String(
    options.apiKey
      || options.authToken
      || process.env.MIA_CLOUD_CLAUDE_CODE_API_KEY
      || process.env.MIA_DEEPSEEK_API_KEY
      || process.env.DEEPSEEK_API_KEY
      || ""
  ).trim();
}

function agentPythonVenv(options = {}) {
  const value = options.pythonVenv !== undefined
    ? options.pythonVenv
    : (process.env.MIA_CLOUD_AGENT_PYTHON_VENV || process.env.MIA_AGENT_PYTHON_VENV || DEFAULT_AGENT_PYTHON_VENV);
  if (value === false || envDisabled(value)) return "";
  return String(value || "").trim();
}

function prependPathEntry(basePath, entry) {
  const cleanEntry = String(entry || "").trim();
  const parts = String(basePath || "").split(path.delimiter).filter(Boolean);
  if (!cleanEntry) return parts.join(path.delimiter);
  return [cleanEntry, ...parts.filter((part) => part !== cleanEntry)].join(path.delimiter);
}

function baseClaudeCodeEnv(options = {}) {
  const baseUrl = deepSeekAnthropicBaseUrl(options);
  const apiKey = deepSeekApiKey(options);
  const pythonVenv = agentPythonVenv(options);
  const pipIndexUrl = String(options.pipIndexUrl || process.env.MIA_PIP_INDEX_URL || DEFAULT_PIP_INDEX_URL).trim();
  const pipExtraIndexUrl = String(options.pipExtraIndexUrl || process.env.MIA_PIP_EXTRA_INDEX_URL || "").trim();
  const env = {
    PATH: prependPathEntry(process.env.PATH || "", pythonVenv ? path.join(pythonVenv, "bin") : ""),
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
    SHELL: process.env.SHELL || "/bin/sh",
    VIRTUAL_ENV: pythonVenv || undefined,
    MIA_CLOUD_AGENT_PYTHON_VENV: pythonVenv || undefined,
    PIP_INDEX_URL: pipIndexUrl || undefined,
    PIP_EXTRA_INDEX_URL: pipExtraIndexUrl || undefined,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey || undefined,
    ANTHROPIC_API_KEY: apiKey || undefined,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "mia-cloud/claude-code-sandbox"
  };
  return { env, baseUrl, apiKey };
}

function defaultSandboxSettings(options = {}) {
  const enabled = options.sandboxEnabled !== undefined
    ? Boolean(options.sandboxEnabled)
    : !envDisabled(process.env.MIA_CLOUD_CLAUDE_CODE_SANDBOX);
  const failIfUnavailable = options.sandboxRequired !== undefined
    ? Boolean(options.sandboxRequired)
    : !envDisabled(process.env.MIA_CLOUD_CLAUDE_CODE_SANDBOX_REQUIRED);
  return {
    enabled,
    failIfUnavailable,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false
  };
}

function createCloudClaudeCodeSandboxManager(options = {}) {
  const root = path.resolve(String(options.root || process.env.MIA_CLOUD_AGENT_ROOT || DEFAULT_AGENT_ROOT));
  const defaultModel = normalizeCloudClaudeCodeModel(
    options.model || process.env.MIA_CLOUD_CLAUDE_CODE_MODEL || "",
    { defaultModel: DEFAULT_CLOUD_CLAUDE_CODE_MODEL }
  );
  const platformModel = String(options.platformModel || process.env.MIA_PLATFORM_MODEL_ID || "mia-auto").trim() || "mia-auto";
  const modelProvider = String(options.modelProvider || "deepseek").trim() || "deepseek";
  const permissionMode = String(
    options.permissionMode
      || process.env.MIA_CLOUD_CLAUDE_CODE_PERMISSION_MODE
      || "bypassPermissions"
  ).trim() || "bypassPermissions";
  const sandboxSettings = options.sandboxSettings || defaultSandboxSettings(options);
  const { env: sharedEnv, baseUrl, apiKey } = baseClaudeCodeEnv(options);

  function pathsForUser(userId) {
    const userRoot = path.join(root, "users", safePathSegment(userId));
    return {
      root: userRoot,
      home: path.join(userRoot, "home"),
      workspace: path.join(userRoot, "workspace"),
      attachments: path.join(userRoot, "attachments"),
      logs: path.join(userRoot, "logs"),
      tmp: path.join(userRoot, "tmp"),
      cache: path.join(userRoot, "home", ".cache"),
      pythonUserBase: path.join(userRoot, "home", ".local"),
      agentHome: path.join(userRoot, "home", ".claude"),
      schedulerHome: path.join(userRoot, "home", ".mia")
    };
  }

  async function ensureWorker(userId) {
    const paths = pathsForUser(userId);
    for (const dir of [paths.root, paths.home, paths.workspace, paths.attachments, paths.logs, paths.tmp, paths.cache, paths.pythonUserBase, paths.agentHome, paths.schedulerHome]) {
      mkdirPrivate(dir);
    }
    return {
      kind: "claude-code",
      runtimeKind: "cloud-claude-code",
      userId,
      model: defaultModel,
      platformModel,
      workerModel: platformModel,
      modelProvider,
      baseUrl,
      hasApiKey: Boolean(apiKey),
      permissionMode,
      sandboxSettings,
      paths,
      env: {
        ...sharedEnv,
        HOME: paths.home,
        TMPDIR: paths.tmp,
        CLAUDE_CONFIG_DIR: paths.agentHome,
        MIA_CLOUD_AGENT_DATA_ROOT: paths.root,
        MIA_CLOUD_AGENT_PUBLIC_ROOT: "/data",
        XDG_CACHE_HOME: paths.cache,
        MPLCONFIGDIR: path.join(paths.cache, "matplotlib"),
        PIP_CACHE_DIR: path.join(paths.cache, "pip"),
        PYTHONUSERBASE: paths.pythonUserBase
      }
    };
  }

  return {
    kind: "claude-code",
    runtimeKind: "cloud-claude-code",
    root,
    mode: "claude-code-sdk-sandbox",
    defaultModel,
    platformModel,
    modelProvider,
    permissionMode,
    sandboxSettings,
    ensureWorker
  };
}

module.exports = {
  DEFAULT_AGENT_ROOT,
  DEFAULT_DEEPSEEK_ANTHROPIC_BASE_URL,
  DEFAULT_AGENT_PYTHON_VENV,
  DEFAULT_PIP_INDEX_URL,
  baseClaudeCodeEnv,
  createCloudClaudeCodeSandboxManager
};
