"use strict";

const { execFile: defaultExecFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_HERMES_CAPABILITIES = Object.freeze({
  approvalModes: ["ask", "yolo", "deny"],
  effortLevels: ["low", "medium", "high"]
});

const CODEX_CAPABILITY_CACHE_TTL_MS = 30000;
const EXTERNAL_CAPABILITY_CACHE_TTL_MS = 30000;

const CLAUDE_PERMISSION_LABELS = Object.freeze({
  default: "Ask Permissions",
  acceptEdits: "Accept Edits",
  auto: "Auto Mode",
  bypassPermissions: "Bypass Permissions",
  dontAsk: "Don't Ask",
  plan: "Plan Mode"
});

const CLAUDE_PERMISSION_TITLES = Object.freeze({
  default: "Claude Code 默认权限，危险操作会询问。",
  acceptEdits: "Claude Code 自动接受文件编辑，其他危险操作仍按规则处理。",
  auto: "Claude Code 自动判断低风险操作，高风险操作仍会询问。",
  bypassPermissions: "Claude Code Bypass Permissions，只在完全信任时使用。",
  dontAsk: "Claude Code 不主动询问权限。",
  plan: "Claude Code 计划模式，只读规划。"
});

const OPENCLAW_PERMISSION_OPTIONS = Object.freeze([
  { value: "default", label: "Ask", title: "OpenClaw 通过 Mia 权限弹窗逐次确认工具调用。" },
  { value: "acceptEdits", label: "Edits", title: "OpenClaw 自动接受编辑类工具调用，其他危险操作仍按规则处理。" },
  { value: "readOnly", label: "Read", title: "OpenClaw 只读模式。" },
  { value: "bypassPermissions", label: "YOLO", title: "OpenClaw 自动允许工具调用，只在完全信任时使用。" }
]);

function normalizeCodexReasoningOption(option) {
  const effort = String(
    option?.effort
    || option?.reasoningEffort
    || option?.reasoning_effort
    || option
    || ""
  ).trim();
  if (!effort) return null;
  return {
    effort,
    description: String(option?.description || "").trim()
  };
}

function normalizeCodexModel(model = {}, index = 0) {
  const slug = String(model.slug || model.model || model.id || "").trim();
  if (!slug) return null;
  const supportedReasoningLevels = [
    ...(Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []),
    ...(Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
  ].map(normalizeCodexReasoningOption).filter(Boolean);
  return {
    slug,
    displayName: String(model.display_name || model.displayName || model.name || slug),
    description: String(model.description || "").trim(),
    priority: Number.isFinite(model.priority) ? model.priority : index,
    defaultReasoningLevel: String(model.default_reasoning_level || model.defaultReasoningEffort || "").trim(),
    supportedReasoningLevels
  };
}

function normalizeCodexModels(models = []) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => model && model.visibility !== "hide" && model.hidden !== true)
    .map((model, index) => normalizeCodexModel(model, index))
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
}

function codexEffortOptionsFromModels(models = []) {
  const seen = new Set();
  const options = [];
  for (const model of Array.isArray(models) ? models : []) {
    for (const item of Array.isArray(model?.supportedReasoningLevels) ? model.supportedReasoningLevels : []) {
      const value = String(item?.effort || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({ value, description: String(item.description || "").trim() });
    }
  }
  return options;
}

function normalizeCodexPermissionProfile(profile = {}) {
  const id = String(profile.id || profile.value || "").trim();
  if (!id) return null;
  return {
    id,
    description: profile.description == null ? null : String(profile.description)
  };
}

function normalizeCodexPermissionProfiles(profiles = []) {
  const seen = new Set();
  const result = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const normalized = normalizeCodexPermissionProfile(profile);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    result.push(normalized);
  }
  return result;
}

function execFileResult(execFile, file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const status = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
      resolve({
        status,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error || null
      });
    });
  });
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function optionHelpChunk(help = "", optionName = "") {
  const lines = String(help || "").split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(optionName));
  if (index < 0) return "";
  const chunk = [lines[index]];
  for (let i = index + 1; i < lines.length; i += 1) {
    const trimmed = String(lines[i] || "").trim();
    if (/^--?[A-Za-z0-9][A-Za-z0-9-]*/.test(trimmed)) break;
    chunk.push(lines[i]);
  }
  return chunk.join("\n");
}

function parseChoiceList(value = "") {
  return uniqueStrings(String(value || "")
    .split(/[|,\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean));
}

function choicesFromHelp(help = "", optionName = "") {
  const chunk = optionHelpChunk(help, optionName);
  if (!chunk) return [];
  const quoted = uniqueStrings([...chunk.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  if (quoted.length) return quoted;
  const thinking = chunk.match(/:\s*([A-Za-z0-9_ -]+(?:\s*\|\s*[A-Za-z0-9_ -]+)+)(?:\s+where|\s*$)/i);
  if (thinking) return parseChoiceList(thinking[1].replace(/\s+where\s+supported.*$/i, ""));
  const choices = chunk.match(/choices?:?\s*\(?([^)]+)\)?/i);
  if (choices) return parseChoiceList(choices[1]);
  const parens = chunk.match(/\(([^()]+)\)/);
  return parens ? parseChoiceList(parens[1]) : [];
}

function titleCaseWords(value = "") {
  return String(value || "")
    .replace(/^:+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
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

function normalizeExternalModelEntry(entry = {}, {
  provider = "",
  providerLabel = "",
  source = "",
  index = 0
} = {}) {
  const id = String(entry.id || entry.key || entry.value || entry.model || entry.name || "").trim();
  const model = String(entry.model || entry.key || entry.id || entry.value || entry.name || "").trim();
  if (!id && !model) return null;
  const label = String(entry.label || entry.displayName || entry.display_name || entry.name || model || id).trim();
  return {
    id: id || model || `${provider || "engine"}-${index}`,
    provider: String(entry.provider || provider || "").trim(),
    providerLabel: String(entry.providerLabel || entry.provider_label || providerLabel || "").trim(),
    model,
    label: label || model || id,
    source: String(entry.source || source || "").trim(),
    description: String(entry.description || "").trim(),
    available: entry.available == null ? undefined : Boolean(entry.available),
    contextWindow: Number.isFinite(Number(entry.contextWindow ?? entry.context_window))
      ? Number(entry.contextWindow ?? entry.context_window)
      : undefined,
    tags: Array.isArray(entry.tags) ? entry.tags.map((item) => String(item)).filter(Boolean) : undefined
  };
}

function normalizeClaudeModelEntries({ help = "", currentModel = "" } = {}) {
  const entries = [];
  const current = String(currentModel || "").trim();
  if (current) {
    entries.push({
      id: `current:${current}`,
      provider: "claude-code",
      providerLabel: "Claude Code",
      model: current,
      label: `当前设置: ${current}`,
      source: "claude-sdk-settings"
    });
  }
  const chunk = optionHelpChunk(help, "--model").replace(/([A-Za-z0-9])'s\b/g, "$1s");
  const examples = uniqueStrings([...chunk.matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((match) => match[1] || match[2])
    .filter((item) => /^[A-Za-z0-9._/-]+(?:\[[^\]\s]+\])?$/.test(String(item || ""))));
  for (const example of examples) {
    if (entries.some((entry) => entry.model === example)) continue;
    entries.push({
      id: example,
      provider: "claude-code",
      providerLabel: "Claude Code",
      model: example,
      label: example.startsWith("claude-") ? example : `${titleCaseWords(example)} alias`,
      source: "claude-cli-help"
    });
  }
  return entries;
}

function permissionOptionsFromModes(modes = [], labelMap = {}, titleMap = {}) {
  return uniqueStrings(modes).map((value) => ({
    value,
    label: labelMap[value] || titleCaseWords(value) || value,
    title: titleMap[value] || ""
  }));
}

function normalizeOpenClawModels(payload = {}) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.rows)
        ? payload.rows
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (!row || row.hidden === true || row.missing === true) continue;
    const model = normalizeExternalModelEntry(row, {
      provider: "openclaw",
      providerLabel: "OpenClaw",
      source: "openclaw-models-list",
      index: result.length
    });
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

function createEngineCatalogService({
  isEngineInstalled,
  initializeRuntime,
  runtimePaths,
  userHome,
  effectiveHermesHome,
  buildPythonPath,
  runPythonScript,
  appendEngineLog,
  timeEngineStepAsync,
  shellCommandPath = () => "",
  processEnvStrings = () => process.env,
  ensureCodexHome = null,
  createCodexAppServerConnection = null,
  claudeAgentSdk = null,
  execFile = defaultExecFile,
  cwd = () => process.cwd(),
  now = () => Date.now()
}) {
  let codexCapabilityCache = { at: 0, value: null };
  let claudeCapabilityCache = { at: 0, value: null };
  let openClawCapabilityCache = { at: 0, value: null };

  function fallbackModelCatalog() {
    return [
      {
        id: "openai-codex::gpt-5.3-codex",
        provider: "openai-codex",
        providerLabel: "OpenAI Codex",
        model: "gpt-5.3-codex",
        label: "gpt-5.3-codex",
        authType: "oauth_external",
        apiKeyEnv: "",
        baseUrl: "",
        apiMode: "codex_responses"
      },
      {
        id: "xai::grok-4.1-fast",
        provider: "xai",
        providerLabel: "xAI",
        model: "grok-4.1-fast",
        label: "grok-4.1-fast",
        authType: "api_key",
        apiKeyEnv: "XAI_API_KEY",
        baseUrl: "",
        apiMode: "chat_completions"
      },
      {
        id: "openrouter::anthropic/claude-sonnet-4.6",
        provider: "openrouter",
        providerLabel: "OpenRouter",
        model: "anthropic/claude-sonnet-4.6",
        label: "anthropic/claude-sonnet-4.6",
        authType: "api_key",
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrl: "",
        apiMode: "chat_completions"
      },
      {
        id: "anthropic::claude-sonnet-4-6",
        provider: "anthropic",
        providerLabel: "Anthropic",
        model: "claude-sonnet-4-6",
        label: "claude-sonnet-4-6",
        authType: "api_key",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: "",
        apiMode: "anthropic_messages"
      },
      {
        id: "deepseek::deepseek-chat",
        provider: "deepseek",
        providerLabel: "DeepSeek",
        model: "deepseek-chat",
        label: "deepseek-chat",
        authType: "api_key",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrl: "",
        apiMode: "chat_completions"
      }
    ];
  }

  async function loadHermesModelCatalog() {
    if (!isEngineInstalled()) return fallbackModelCatalog();
    return timeEngineStepAsync("Load Hermes model catalog", () => loadHermesModelCatalogInner());
  }

  function loadCodexModels() {
    try {
      const cachePath = path.join(userHome(), ".codex", "models_cache.json");
      const raw = fs.readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeCodexModels(parsed?.models);
    } catch {
      return [];
    }
  }

  async function loadCodexRuntimeCapabilities() {
    if (codexCapabilityCache.value && (now() - codexCapabilityCache.at) < CODEX_CAPABILITY_CACHE_TTL_MS) {
      return codexCapabilityCache.value;
    }
    const empty = { models: [], permissionProfiles: [] };
    if (typeof createCodexAppServerConnection !== "function") return empty;
    const codexPath = String(shellCommandPath("codex") || "").trim();
    if (!codexPath) return empty;
    let codexHome = "";
    try {
      codexHome = typeof ensureCodexHome === "function" ? String(ensureCodexHome() || "") : "";
    } catch (error) {
      appendEngineLog(`Codex capability probe skipped: ${error?.message || error}`);
      return empty;
    }

    let connection = null;
    try {
      const baseEnv = typeof processEnvStrings === "function" ? processEnvStrings() : process.env;
      connection = createCodexAppServerConnection({
        codexPath,
        env: { ...(baseEnv || {}), ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
        appendLog: appendEngineLog
      });
      await connection.request("initialize", {
        clientInfo: { name: "mia", title: "Mia", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      });
      let modelResult = null;
      let permissionResult = null;
      try {
        modelResult = await connection.request("model/list", { cursor: null });
      } catch (error) {
        appendEngineLog(`Codex model capability probe failed: ${error?.message || error}`);
      }
      try {
        permissionResult = await connection.request("permissionProfile/list", { cursor: null, cwd: cwd() });
      } catch (error) {
        appendEngineLog(`Codex permission capability probe failed: ${error?.message || error}`);
      }
      const value = {
        models: normalizeCodexModels(modelResult?.data),
        permissionProfiles: normalizeCodexPermissionProfiles(permissionResult?.data)
      };
      codexCapabilityCache = { at: now(), value };
      return value;
    } catch (error) {
      appendEngineLog(`Codex capability probe failed: ${error?.message || error}`);
      return empty;
    } finally {
      if (connection) connection.close();
    }
  }

  async function loadClaudeRuntimeCapabilities() {
    if (claudeCapabilityCache.value && (now() - claudeCapabilityCache.at) < EXTERNAL_CAPABILITY_CACHE_TTL_MS) {
      return claudeCapabilityCache.value;
    }

    const value = {
      available: false,
      cliPath: "",
      models: [],
      currentModel: "",
      currentEffortLevel: "",
      effortLevels: [],
      effortOptions: [],
      permissionModes: [],
      permissionOptions: [],
      source: "claude-code",
      error: ""
    };

    try {
      if (typeof claudeAgentSdk === "function") {
        const sdk = await claudeAgentSdk();
        if (sdk && typeof sdk.resolveSettings === "function") {
          const settings = await sdk.resolveSettings({
            cwd: cwd(),
            settingSources: ["project", "user", "local"]
          });
          const effective = settings?.effective || settings?.settings || {};
          value.currentModel = String(effective.model || settings?.model || "").trim();
          value.currentEffortLevel = String(
            effective.effortLevel
            || effective.effort
            || effective.reasoningEffort
            || settings?.effortLevel
            || ""
          ).trim();
        }
      }
    } catch (error) {
      appendEngineLog(`Claude Code settings probe failed: ${error?.message || error}`);
      value.error = `settings: ${error?.message || error}`;
    }

    const claudePath = String(shellCommandPath("claude") || "").trim();
    value.available = Boolean(claudePath);
    value.cliPath = claudePath;
    if (!claudePath) {
      claudeCapabilityCache = { at: now(), value };
      return value;
    }

    const result = await execFileResult(execFile, claudePath, ["--help"], {
      cwd: cwd(),
      env: envWithExecutableDirFirst(
        typeof processEnvStrings === "function" ? processEnvStrings() : process.env,
        claudePath
      ),
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const help = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 0) {
      appendEngineLog(`Claude Code capability probe failed: ${result.stderr || result.error?.message || `claude --help exited ${result.status}`}`);
      value.error = [value.error, `cli-help: ${result.stderr || result.error?.message || result.status}`].filter(Boolean).join("; ");
    }

    value.models = normalizeClaudeModelEntries({ help, currentModel: value.currentModel });
    value.effortLevels = uniqueStrings([
      ...choicesFromHelp(help, "--effort"),
      value.currentEffortLevel
    ]);
    value.effortOptions = value.effortLevels.map((level) => ({
      value: level,
      label: titleCaseWords(level) || level
    }));
    value.permissionModes = choicesFromHelp(help, "--permission-mode");
    value.permissionOptions = permissionOptionsFromModes(
      value.permissionModes,
      CLAUDE_PERMISSION_LABELS,
      CLAUDE_PERMISSION_TITLES
    );

    claudeCapabilityCache = { at: now(), value };
    return value;
  }

  async function loadOpenClawRuntimeCapabilities() {
    if (openClawCapabilityCache.value && (now() - openClawCapabilityCache.at) < EXTERNAL_CAPABILITY_CACHE_TTL_MS) {
      return openClawCapabilityCache.value;
    }

    const value = {
      available: false,
      cliPath: "",
      models: [],
      effortLevels: [],
      effortOptions: [],
      permissionModes: OPENCLAW_PERMISSION_OPTIONS.map((item) => item.value),
      permissionOptions: OPENCLAW_PERMISSION_OPTIONS.map((item) => ({ ...item, source: "mia-acp-adapter" })),
      permissionSource: "mia-acp-adapter",
      source: "openclaw",
      error: ""
    };

    const openClawPath = String(shellCommandPath("openclaw") || shellCommandPath("claw") || "").trim();
    value.available = Boolean(openClawPath);
    value.cliPath = openClawPath;
    if (!openClawPath) {
      openClawCapabilityCache = { at: now(), value };
      return value;
    }

    const env = envWithExecutableDirFirst(
      typeof processEnvStrings === "function" ? processEnvStrings() : process.env,
      openClawPath
    );
    const helpOptions = {
      cwd: cwd(),
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024
    };
    let helpResult = await execFileResult(execFile, openClawPath, ["agent", "--help"], helpOptions);
    let help = `${helpResult.stdout}\n${helpResult.stderr}`;
    let thinkingLevels = helpResult.status === 0 ? choicesFromHelp(help, "--thinking") : [];
    if (!thinkingLevels.length) {
      appendEngineLog(`OpenClaw thinking capability probe failed: ${helpResult.stderr || helpResult.error?.message || `openclaw agent --help exited ${helpResult.status}`}`);
      const fallbackHelp = await execFileResult(execFile, openClawPath, ["--dev", "agent", "--help"], helpOptions);
      if (fallbackHelp.status === 0) {
        helpResult = fallbackHelp;
        help = `${fallbackHelp.stdout}\n${fallbackHelp.stderr}`;
        thinkingLevels = choicesFromHelp(help, "--thinking");
      }
      if (!thinkingLevels.length) {
        value.error = `agent-help: ${helpResult.stderr || helpResult.error?.message || helpResult.status}`;
      }
    }
    value.effortLevels = thinkingLevels;
    value.effortOptions = value.effortLevels.map((level) => ({
      value: level,
      label: titleCaseWords(level) || level
    }));

    const modelsResult = await execFileResult(execFile, openClawPath, ["models", "list", "--json"], {
      cwd: cwd(),
      env,
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024
    });
    if (modelsResult.status === 0) {
      try {
        value.models = normalizeOpenClawModels(JSON.parse(String(modelsResult.stdout || "{}")));
      } catch (error) {
        appendEngineLog(`OpenClaw model capability parse failed: ${error?.message || error}`);
        value.error = [value.error, `models-parse: ${error?.message || error}`].filter(Boolean).join("; ");
      }
    } else {
      appendEngineLog(`OpenClaw model capability probe failed: ${modelsResult.stderr || modelsResult.error?.message || `openclaw models list exited ${modelsResult.status}`}`);
      value.error = [value.error, `models-list: ${modelsResult.stderr || modelsResult.error?.message || modelsResult.status}`].filter(Boolean).join("; ");
    }

    openClawCapabilityCache = { at: now(), value };
    return value;
  }

  async function loadHermesModelCatalogInner() {
    const p = runtimePaths();
    const script = String.raw`
import json

def choose_env(envs):
    values = [str(item or "").strip() for item in (envs or []) if str(item or "").strip()]
    preferred = [item for item in values if item.endswith("_API_KEY")]
    return (preferred or values or [""])[0]

try:
    from hermes_cli.models import CANONICAL_PROVIDERS
    from hermes_cli import models as hermes_models
    from hermes_cli.providers import get_provider, determine_api_mode
except Exception:
    import models as hermes_models
    from models import CANONICAL_PROVIDERS
    from providers import get_provider, determine_api_mode

rows = []
seen = set()
static_provider_models = getattr(hermes_models, "_PROVIDER_MODELS", {}) or {}
openrouter_models = getattr(hermes_models, "OPENROUTER_MODELS", []) or []
for entry in CANONICAL_PROVIDERS:
    provider = str(entry.slug)
    pdef = get_provider(provider)
    provider_label = str(getattr(entry, "label", "") or getattr(pdef, "name", "") or provider)
    auth_type = str(getattr(pdef, "auth_type", "") or "api_key")
    api_key_env = choose_env(getattr(pdef, "api_key_env_vars", ()) if pdef else ())
    base_url = str(getattr(pdef, "base_url", "") or "")
    api_mode = determine_api_mode(provider, base_url)
    if provider == "openrouter":
        models = [item[0] if isinstance(item, (tuple, list)) and item else item for item in openrouter_models]
    else:
        models = list(static_provider_models.get(provider, []))
    if not models:
        models = [""]
    for model in models:
        model_id = str(model or "").strip()
        key = f"{provider}::{model_id}"
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "id": key,
            "provider": provider,
            "providerLabel": provider_label,
            "model": model_id,
            "label": model_id or "LM Studio 当前加载模型",
            "authType": auth_type,
            "apiKeyEnv": "" if auth_type.startswith("oauth") else api_key_env,
            "baseUrl": base_url,
            "apiMode": api_mode,
        })
print(json.dumps(rows, ensure_ascii=False))
`;
    const result = await runPythonScript(["-c", script], {
      cwd: p.engine,
      env: {
        ...process.env,
        HERMES_HOME: effectiveHermesHome(),
        MIA_HOME: p.home,
        PYTHONPATH: buildPythonPath()
      },
      encoding: "utf8",
      timeout: 15000
    });
    if (result.status !== 0) {
      appendEngineLog(`Model catalog fallback: ${result.stderr || `python exited ${result.status}`}`);
      return fallbackModelCatalog();
    }
    try {
      const rows = JSON.parse(String(result.stdout || "[]"));
      if (Array.isArray(rows) && rows.length) return rows;
    } catch (error) {
      appendEngineLog(`Model catalog parse failed: ${error.message}`);
    }
    return fallbackModelCatalog();
  }

  async function loadHermesEngineCapabilities() {
    if (!isEngineInstalled()) {
      return { ...DEFAULT_HERMES_CAPABILITIES };
    }
    const p = runtimePaths();
    const script = String.raw`
import json
result = {"approvalModes": ["ask", "yolo", "deny"], "effortLevels": ["low", "medium", "high"]}
try:
    from hermes_cli.web_server import SETTINGS_SCHEMA
    if "approvals.mode" in SETTINGS_SCHEMA and "options" in SETTINGS_SCHEMA["approvals.mode"]:
        result["approvalModes"] = list(SETTINGS_SCHEMA["approvals.mode"]["options"])
    if "agent.reasoning_effort" in SETTINGS_SCHEMA and "options" in SETTINGS_SCHEMA["agent.reasoning_effort"]:
        result["effortLevels"] = list(SETTINGS_SCHEMA["agent.reasoning_effort"]["options"])
except Exception:
    pass
print(json.dumps(result))
`;
    try {
      const result = await runPythonScript(["-c", script], {
        cwd: p.engine,
        env: {
          ...process.env,
          HERMES_HOME: effectiveHermesHome(),
          MIA_HOME: p.home,
          PYTHONPATH: buildPythonPath()
        },
        encoding: "utf8",
        timeout: 8000
      });
      if (result.status === 0) {
        const parsed = JSON.parse(String(result.stdout || "{}"));
        if (Array.isArray(parsed.approvalModes) && parsed.approvalModes.length
            && Array.isArray(parsed.effortLevels) && parsed.effortLevels.length) {
          return parsed;
        }
      }
    } catch {
      // fall through
    }
    return { ...DEFAULT_HERMES_CAPABILITIES };
  }

  async function loadEngineCapabilities() {
    const hermes = await loadHermesEngineCapabilities();
    const [codexRuntime, claudeRuntime, openClawRuntime] = await Promise.all([
      loadCodexRuntimeCapabilities(),
      loadClaudeRuntimeCapabilities(),
      loadOpenClawRuntimeCapabilities()
    ]);
    const codexModels = codexRuntime.models.length ? codexRuntime.models : loadCodexModels();
    const codexEffortOptions = codexEffortOptionsFromModels(codexModels);
    return {
      ...hermes,
      engines: {
        hermes: { ...hermes },
        "claude-code": claudeRuntime,
        codex: {
          models: codexModels,
          effortLevels: codexEffortOptions.map((item) => item.value),
          effortOptions: codexEffortOptions,
          permissionProfiles: codexRuntime.permissionProfiles
        },
        openclaw: openClawRuntime
      }
    };
  }

  function fallbackSlashCommands() {
    return [
      { command: "/new", description: "Start a new session (fresh session ID + history)" },
      { command: "/topic", description: "Enable or inspect Telegram DM topic sessions" },
      { command: "/retry", description: "Retry the last message (resend to agent)" },
      { command: "/undo", description: "Remove the last user/assistant exchange" },
      { command: "/title", description: "Set a title for the current session" },
      { command: "/branch", description: "Branch the current session (explore a different path)" },
      { command: "/compress", description: "Manually compress conversation context" },
      { command: "/rollback", description: "List or restore filesystem checkpoints" },
      { command: "/stop", description: "Kill all running background processes" },
      { command: "/status", description: "Show session info" },
      { command: "/model", description: "Switch model for this session" },
      { command: "/personality", description: "Set a predefined personality" },
      { command: "/reasoning", description: "Manage reasoning effort and display" },
      { command: "/fast", description: "Toggle fast mode" },
      { command: "/yolo", description: "Toggle YOLO mode" },
      { command: "/voice", description: "Toggle voice mode" },
      { command: "/agents", description: "Show active agents and running tasks" },
      { command: "/goal", description: "Set a standing goal Hermes works on across turns" },
      { command: "/subgoal", description: "Add or manage checklist items on the active goal" },
      { command: "/usage", description: "Show token usage and rate limits for the current session" },
      { command: "/insights", description: "Show usage insights and analytics" },
      { command: "/commands", description: "Browse all commands and skills" },
      { command: "/help", description: "Show available commands" }
    ];
  }

  async function loadHermesSlashCommands() {
    initializeRuntime();
    return timeEngineStepAsync("Load Hermes slash commands", () => loadHermesSlashCommandsInner());
  }

  async function loadHermesSlashCommandsInner() {
    const p = runtimePaths();
    const script = `
import json
try:
    from hermes_cli.commands import telegram_menu_commands
    commands, hidden = telegram_menu_commands(100)
    rows = [{"command": "/" + name, "description": desc} for name, desc in commands]
except Exception:
    rows = []
print(json.dumps(rows, ensure_ascii=False))
`;
    const result = await runPythonScript(["-c", script], {
      cwd: p.engine,
      env: {
        ...process.env,
        HERMES_HOME: effectiveHermesHome(),
        MIA_HOME: p.home,
        PYTHONPATH: buildPythonPath()
      },
      encoding: "utf8",
      timeout: 15000
    });
    if (result.status !== 0) {
      appendEngineLog(`Slash command fallback: ${result.stderr || `python exited ${result.status}`}`);
      return fallbackSlashCommands();
    }
    try {
      const rows = JSON.parse(String(result.stdout || "[]"));
      if (Array.isArray(rows) && rows.length) {
        return rows
          .filter((item) => item && item.command && item.description)
          .map((item) => ({
            command: String(item.command).startsWith("/") ? String(item.command) : `/${item.command}`,
            description: String(item.description)
          }));
      }
    } catch (error) {
      appendEngineLog(`Slash command parse failed: ${error.message}`);
    }
    return fallbackSlashCommands();
  }

  return {
    fallbackModelCatalog,
    loadHermesModelCatalog,
    loadCodexModels,
    loadEngineCapabilities,
    fallbackSlashCommands,
    loadHermesSlashCommands
  };
}

module.exports = {
  choicesFromHelp,
  codexEffortOptionsFromModels,
  createEngineCatalogService,
  normalizeClaudeModelEntries,
  normalizeCodexModels,
  normalizeCodexPermissionProfiles,
  normalizeOpenClawModels
};
