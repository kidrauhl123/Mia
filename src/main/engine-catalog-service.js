"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createEngineCatalogService({
  isEngineInstalled,
  initializeRuntime,
  runtimePaths,
  userHome,
  effectiveHermesHome,
  buildPythonPath,
  runPythonScript,
  appendEngineLog,
  timeEngineStepAsync
}) {
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
      const models = Array.isArray(parsed?.models) ? parsed.models : [];
      return models
        .filter((model) => model && typeof model.slug === "string" && model.slug && model.visibility !== "hide")
        .map((model) => ({
          slug: String(model.slug),
          displayName: String(model.display_name || model.slug),
          priority: Number.isFinite(model.priority) ? model.priority : 0
        }))
        .sort((a, b) => a.priority - b.priority);
    } catch {
      return [];
    }
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

  async function loadEngineCapabilities() {
    if (!isEngineInstalled()) {
      return { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] };
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
    return { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] };
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
  createEngineCatalogService
};
