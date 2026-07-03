"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createOpenClawMiaProfile } = require("./openclaw-mia-profile.js");
const { createCodexMiaProxy } = require("./codex-mia-proxy.js");

const DEFAULT_CODEX_MIA_MODEL_CATALOG = "mia-codex-model-catalog.json";
const DEFAULT_CODEX_MIA_LAUNCHER = process.platform === "win32"
  ? "mia-codex-launcher.cmd"
  : "mia-codex-launcher.sh";

function firstString(source = {}, keys = []) {
  for (const key of keys) {
    const value = String(source?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function runtimeKeyForMiaRuntime(runtime = {}) {
  const profileId = firstString(runtime, ["modelProfileId", "model_profile_id"]);
  if (profileId) return profileId.startsWith("mia:") ? profileId : `mia:${profileId}`;
  const model = firstString(runtime, ["model"]) || "mia-auto";
  return model.startsWith("mia:") ? model : `mia:${model}`;
}

function codexModelDisplayName(model = "") {
  const value = String(model || "").trim();
  if (!value || value === "mia-auto" || value === "mia-default") return "Auto";
  return value;
}

function createCodexMiaModelCatalog(model = "mia-auto") {
  const slug = String(model || "mia-auto").trim() || "mia-auto";
  const displayName = codexModelDisplayName(slug);
  return {
    models: [
      {
        slug,
        display_name: displayName,
        description: displayName,
        base_instructions: "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "none", description: "Disable Thinking" },
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced responses" },
          { effort: "high", description: "Enabled Thinking" }
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1000,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        supports_reasoning_summaries: true,
        default_reasoning_summary: "none",
        support_verbosity: false,
        truncation_policy: { mode: "bytes", limit: 10000 },
        supports_parallel_tool_calls: false,
        supports_image_detail_original: false,
        context_window: 262144,
        max_context_window: 262144,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text"],
        supports_search_tool: false
      }
    ]
  };
}

function writeCodexMiaModelCatalog(catalogPath, model = "mia-auto") {
  const target = String(catalogPath || "").trim();
  if (!target) return "";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(createCodexMiaModelCatalog(model), null, 2)}\n`, "utf8");
  return target;
}

function codexMiaLauncherScript(platform = process.platform) {
  if (platform === "win32") {
    return [
      "@echo off",
      "set \"REAL_CODEX=%MIA_CODEX_REAL_PATH%\"",
      "if \"%REAL_CODEX%\"==\"\" set \"REAL_CODEX=codex\"",
      "if \"%1\"==\"app-server\" if not \"%MIA_CODEX_MODEL_CATALOG_JSON%\"==\"\" (",
      "  \"%REAL_CODEX%\" %* -c \"model_catalog_json=\\\"%MIA_CODEX_MODEL_CATALOG_JSON%\\\"\"",
      "  exit /b %ERRORLEVEL%",
      ")",
      "\"%REAL_CODEX%\" %*",
      "exit /b %ERRORLEVEL%",
      ""
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "REAL_CODEX=\"${MIA_CODEX_REAL_PATH:-codex}\"",
    "CATALOG=\"${MIA_CODEX_MODEL_CATALOG_JSON:-}\"",
    "if [ \"${1:-}\" = \"app-server\" ] && [ -n \"$CATALOG\" ]; then",
    "  exec \"$REAL_CODEX\" \"$@\" -c \"model_catalog_json=\\\"$CATALOG\\\"\"",
    "fi",
    "exec \"$REAL_CODEX\" \"$@\"",
    ""
  ].join("\n");
}

function writeCodexMiaLauncher(launcherPath, platform = process.platform) {
  const target = String(launcherPath || "").trim();
  if (!target) return "";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, codexMiaLauncherScript(platform), "utf8");
  if (platform !== "win32") fs.chmodSync(target, 0o755);
  return target;
}

function codexConfigForMiaSession(session = {}, options = {}) {
  const baseUrl = String(session.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(session.model || "").trim();
  const modelCatalogJson = String(options.modelCatalogJson || "").trim();
  return {
    model,
    model_provider: "custom",
    ...(modelCatalogJson ? { model_catalog_json: modelCatalogJson } : {}),
    disable_response_storage: true,
    model_providers: {
      custom: {
        name: "Mia",
        base_url: baseUrl,
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        requires_openai_auth: false
      }
    }
  };
}

function createAgentSessionRuntimePreparer(options = {}) {
  const resolveManagedModelRuntime = typeof options.resolveManagedModelRuntime === "function"
    ? options.resolveManagedModelRuntime
    : () => null;
  const claudeCodeMiaProxy = options.claudeCodeMiaProxy || null;
  const codexMiaProxy = options.codexMiaProxy || createCodexMiaProxy(options.codexMiaProxyOptions || {});
  const openClawMiaProfile = options.openClawMiaProfile || createOpenClawMiaProfile(options.openClawMiaProfileOptions || {});
  const codexModelCatalogPath = String(options.codexModelCatalogPath || "").trim()
    || path.join(os.tmpdir(), DEFAULT_CODEX_MIA_MODEL_CATALOG);
  const codexLauncherPath = String(options.codexLauncherPath || "").trim()
    || path.join(os.tmpdir(), DEFAULT_CODEX_MIA_LAUNCHER);
  const codexRealPath = String(options.codexRealPath || process.env.CODEX_PATH || "codex").trim() || "codex";

  async function prepare(input = {}) {
    const engineId = String(input.engineId || "").trim();
    const runtimeConfig = input.runtimeConfig && typeof input.runtimeConfig === "object"
      ? input.runtimeConfig
      : {};

    if (engineId === "openclaw") {
      const agentEngine = firstString(runtimeConfig, ["agentEngine", "agent_engine"]) || "openclaw";
      if (agentEngine !== "openclaw") return {};
      const managedRuntime = resolveManagedModelRuntime(runtimeConfig, { engine: "openclaw" });
      if (!managedRuntime) return {};
      if (!openClawMiaProfile || typeof openClawMiaProfile.ensure !== "function") {
        throw new Error("OpenClaw Mia profile manager is not available.");
      }
      const profile = await openClawMiaProfile.ensure(managedRuntime);
      const profileName = String(profile?.profile || "").trim();
      if (!profileName) {
        throw new Error("OpenClaw Mia profile manager did not return a usable profile.");
      }
      return {
        runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
        env: {
          MIA_OPENCLAW_PROFILE: profileName
        }
      };
    }

    if (engineId === "codex") {
      const agentEngine = firstString(runtimeConfig, ["agentEngine", "agent_engine"]) || "codex";
      if (agentEngine !== "codex") return {};
      const managedRuntime = resolveManagedModelRuntime(runtimeConfig, { engine: "codex" });
      if (!managedRuntime) return {};
      if (!codexMiaProxy || typeof codexMiaProxy.createSession !== "function") {
        throw new Error("Codex Mia proxy is not available.");
      }
      const session = await codexMiaProxy.createSession(managedRuntime);
      const baseUrl = String(session?.baseUrl || "").trim();
      const apiKey = String(session?.apiKey || "").trim();
      const model = String(session?.model || "").trim();
      if (!baseUrl || !apiKey || !model) {
        throw new Error("Codex Mia proxy did not return a usable session.");
      }
      const modelCatalogJson = writeCodexMiaModelCatalog(codexModelCatalogPath, model);
      return {
        runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
        env: {
          CODEX_API_KEY: apiKey,
          CODEX_PATH: writeCodexMiaLauncher(codexLauncherPath),
          MIA_CODEX_MODEL_CATALOG_JSON: modelCatalogJson,
          MIA_CODEX_REAL_PATH: codexRealPath,
          MODEL_PROVIDER: "custom",
          CODEX_CONFIG: JSON.stringify(codexConfigForMiaSession(session, {
            modelCatalogJson
          }))
        }
      };
    }

    if (engineId !== "claude") return {};

    const agentEngine = firstString(runtimeConfig, ["agentEngine", "agent_engine"]) || "claude-code";
    if (agentEngine !== "claude-code") return {};

    const managedRuntime = resolveManagedModelRuntime(runtimeConfig, { engine: "claude-code" });
    if (!managedRuntime) return {};
    if (!claudeCodeMiaProxy || typeof claudeCodeMiaProxy.createSession !== "function") {
      throw new Error("Claude Code Mia proxy is not available.");
    }

    const session = await claudeCodeMiaProxy.createSession(managedRuntime);
    const baseUrl = String(session?.baseUrl || "").trim();
    const authToken = String(session?.authToken || "").trim();
    if (!baseUrl || !authToken) {
      throw new Error("Claude Code Mia proxy did not return a usable session.");
    }

    return {
      runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: authToken
      }
    };
  }

  return { prepare };
}

module.exports = {
  createAgentSessionRuntimePreparer,
  runtimeKeyForMiaRuntime
};
