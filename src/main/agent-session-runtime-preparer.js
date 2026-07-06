"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const { normalizeAcpMcpServer, normalizeAcpMcpServers } = require("./agent-session/acp-mcp-servers.js");
const { buildMiaContextResource, mcpContextPrompt } = require("./mia-context-resource.js");
const { createOpenClawMiaProfile } = require("./openclaw-mia-profile.js");
const { createCodexMiaProxy } = require("./codex-mia-proxy.js");
const {
  DEFAULT_CODEX_MIA_MODEL_CATALOG,
  codexMiaSessionConfig,
  writeCodexMiaModelCatalog
} = require("./codex-mia-runtime-config.js");

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

function hashRuntimePart(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function userMcpEngineId(engineId = "") {
  return engineId === "claude" ? "claude-code" : engineId;
}

function mergeRuntimeParts(base = {}, extra = {}) {
  const merged = { ...(base || {}), ...(extra || {}) };
  if (base.env || extra.env) {
    merged.env = {
      ...(base.env || {}),
      ...(extra.env || {})
    };
  }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return value != null && value !== "";
  }));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepClone(entry)])
    );
  }
  return value;
}

function readYamlObject(filePath) {
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function valueFromOption(source, fallback = "") {
  const resolved = typeof source === "function" ? source() : source;
  const value = String(resolved || "").trim();
  return value || fallback;
}

function runtimeKeyForResolvedRuntime(runtime = {}) {
  const profileId = firstString(runtime, ["modelProfileId", "model_profile_id"]);
  if (profileId) return profileId;
  const provider = firstString(runtime, ["providerConnectionId", "provider_connection_id", "provider"]);
  const model = firstString(runtime, ["model"]);
  if (provider && model) return `${provider}:${model}`;
  return model || provider;
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

function createAgentSessionRuntimePreparer(options = {}) {
  const resolveManagedModelRuntime = typeof options.resolveManagedModelRuntime === "function"
    ? options.resolveManagedModelRuntime
    : () => null;
  const resolveModelRuntime = typeof options.resolveModelRuntime === "function"
    ? options.resolveModelRuntime
    : null;
  const claudeCodeMiaProxy = options.claudeCodeMiaProxy || null;
  const codexMiaProxy = options.codexMiaProxy || createCodexMiaProxy(options.codexMiaProxyOptions || {});
  const openClawMiaProfile = options.openClawMiaProfile || createOpenClawMiaProfile(options.openClawMiaProfileOptions || {});
  const codexModelCatalogPath = String(options.codexModelCatalogPath || "").trim()
    || path.join(os.tmpdir(), DEFAULT_CODEX_MIA_MODEL_CATALOG);
  const codexLauncherPath = String(options.codexLauncherPath || "").trim()
    || path.join(os.tmpdir(), DEFAULT_CODEX_MIA_LAUNCHER);
  const codexRealPath = String(options.codexRealPath || process.env.CODEX_PATH || "codex").trim() || "codex";
  const hermesHomePath = options.hermesHomePath || (() => process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"));
  const miaHomePath = options.miaHomePath || (() => process.env.MIA_HOME || "");
  const hermesSessionProfilesRoot = options.hermesSessionProfilesRoot || path.join(os.tmpdir(), "mia-hermes-session-profiles");
  const getMiaAppMcpSpec = typeof options.getMiaAppMcpSpec === "function" ? options.getMiaAppMcpSpec : () => null;
  const getSchedulerMcpSpec = typeof options.getSchedulerMcpSpec === "function" ? options.getSchedulerMcpSpec : () => null;
  const getUserMcpServers = typeof options.getUserMcpServers === "function" ? options.getUserMcpServers : () => [];
  const getMcpFingerprint = typeof options.getMcpFingerprint === "function" ? options.getMcpFingerprint : () => "";
  const writeMiaAppMcpContext = typeof options.writeMiaAppMcpContext === "function" ? options.writeMiaAppMcpContext : () => {};
  const writeSchedulerMcpContext = typeof options.writeSchedulerMcpContext === "function" ? options.writeSchedulerMcpContext : () => {};

  function resolvedHermesRuntime(runtimeConfig = {}) {
    if (resolveModelRuntime) {
      return resolveModelRuntime(runtimeConfig, { engine: "hermes" });
    }
    return resolveManagedModelRuntime(runtimeConfig, { engine: "hermes" });
  }

  function hermesProfileDirFor(runtime = {}, runtimeConfig = {}) {
    const runtimeKey = runtimeKeyForResolvedRuntime(runtime) || "default";
    const safeRuntimeKey = runtimeKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "default";
    const fingerprint = hashRuntimePart({
      runtimeKey,
      provider: firstString(runtime, ["providerConnectionId", "provider_connection_id", "provider"]),
      model: firstString(runtime, ["model"]),
      baseUrl: firstString(runtime, ["baseUrl", "base_url"]),
      apiMode: firstString(runtime, ["apiMode", "api_mode"]),
      permissionMode: firstString(runtimeConfig, ["permissionMode", "permission_mode"]),
      effortLevel: firstString(runtimeConfig, ["effortLevel", "effort_level"])
    });
    return path.join(hermesSessionProfilesRoot, `${safeRuntimeKey}-${fingerprint}`);
  }

  function ensureHermesSessionProfile(runtime = {}, runtimeConfig = {}) {
    const sourceHome = valueFromOption(hermesHomePath, path.join(os.homedir(), ".hermes"));
    const targetHome = hermesProfileDirFor(runtime, runtimeConfig);
    const sourceConfig = readYamlObject(path.join(sourceHome, "config.yaml"));
    const config = deepClone(sourceConfig);
    const provider = firstString(runtime, ["providerConnectionId", "provider_connection_id", "provider"]) || "mia";
    const providerLabel = firstString(runtime, ["providerLabel", "provider_label"]) || provider;
    const model = firstString(runtime, ["model"]) || "mia-auto";
    const apiKeyEnv = firstString(runtime, ["apiKeyEnv", "api_key_env"]) || "MIA_CLOUD_MODEL_TOKEN";
    const apiKey = firstString(runtime, ["apiKey", "api_key"]);
    const baseUrl = firstString(runtime, ["baseUrl", "base_url"]);
    const apiMode = firstString(runtime, ["apiMode", "api_mode"]) || "chat_completions";
    const permissionMode = firstString(runtimeConfig, ["permissionMode", "permission_mode"]);
    const effortLevel = firstString(runtimeConfig, ["effortLevel", "effort_level"]);
    const nextModel = isPlainObject(config.model) ? { ...config.model } : {};
    nextModel.provider = provider;
    nextModel.default = model;
    if (baseUrl) nextModel.base_url = baseUrl;
    if (apiMode) nextModel.api_mode = apiMode;
    config.model = nextModel;
    const providers = isPlainObject(config.providers) ? { ...config.providers } : {};
    const providerConfig = isPlainObject(providers[provider]) ? { ...providers[provider] } : {};
    providerConfig.name = providerLabel;
    if (baseUrl) providerConfig.base_url = baseUrl;
    if (apiKeyEnv) providerConfig.key_env = apiKeyEnv;
    if (apiKey) providerConfig.api_key = apiKey;
    providerConfig.default_model = model;
    if (apiMode) providerConfig.api_mode = apiMode;
    providers[provider] = providerConfig;
    config.providers = providers;
    if (permissionMode) {
      config.approvals = {
        ...(isPlainObject(config.approvals) ? config.approvals : {}),
        mode: permissionMode
      };
    }
    if (effortLevel) {
      config.agent = {
        ...(isPlainObject(config.agent) ? config.agent : {}),
        reasoning_effort: effortLevel
      };
    }
    const resolvedMiaHome = valueFromOption(miaHomePath);
    if (resolvedMiaHome) {
      config.mia = {
        ...(isPlainObject(config.mia) ? config.mia : {}),
        runtime_schema: 1,
        bots_manifest: path.join(resolvedMiaHome, "bots", "manifest.json")
      };
    }
    fs.mkdirSync(targetHome, { recursive: true });
    fs.writeFileSync(
      path.join(targetHome, "config.yaml"),
      yaml.dump(config, { lineWidth: 100, noRefs: true }),
      { mode: 0o600 }
    );
    return {
      runtimeKey: runtimeKeyForResolvedRuntime(runtime),
      env: {
        HERMES_HOME: targetHome,
        ...(resolvedMiaHome ? { MIA_HOME: resolvedMiaHome } : {}),
        ...(apiKeyEnv && apiKey ? { [apiKeyEnv]: apiKey } : {})
      }
    };
  }

  function mcpContextFor(input = {}) {
    return {
      botId: String(input.botId || input.botKey || "").trim(),
      sessionId: String(input.conversationId || input.sessionId || "").trim()
    };
  }

  function prepareMcpRuntime(input = {}, engineId = "") {
    const context = mcpContextFor(input);
    const userServers = normalizeAcpMcpServers(getUserMcpServers(userMcpEngineId(engineId), {
      supportsHttp: false,
      supportsSse: false
    }));
    const miaAppServer = normalizeAcpMcpServer("mia-app", getMiaAppMcpSpec(context));
    const schedulerServer = normalizeAcpMcpServer("mia-scheduler", getSchedulerMcpSpec(context));
    const byName = new Map();
    for (const server of [...userServers, miaAppServer, schedulerServer].filter(Boolean)) {
      byName.set(server.name, server);
    }
    const mcpServers = Array.from(byName.values());
    if (!mcpServers.length) return {};

    const resource = buildMiaContextResource({
      engine: engineId,
      botId: context.botId,
      sessionId: context.sessionId,
      mcpAvailable: true
    });
    const initialPromptPrefix = mcpContextPrompt(resource, { includeRuntime: false });
    const userFingerprint = String(getMcpFingerprint() || "").trim();

    return {
      mcpServers,
      mcpFingerprint: `mcp:${hashRuntimePart({ mcpServers, userFingerprint })}`,
      initialPromptPrefix,
      refreshMcpContext(turn = {}) {
        const originMessageId = String(turn.turnId || turn.originMessageId || "").trim();
        const payload = {
          botId: context.botId,
          sessionId: context.sessionId,
          ...(originMessageId ? { originMessageId } : {})
        };
        writeMiaAppMcpContext(payload);
        writeSchedulerMcpContext(payload);
      }
    };
  }

  async function prepare(input = {}) {
    const engineId = String(input.engineId || "").trim();
    const runtimeConfig = input.runtimeConfig && typeof input.runtimeConfig === "object"
      ? input.runtimeConfig
      : {};
    const mcpRuntime = prepareMcpRuntime(input, engineId);

    if (engineId === "hermes") {
      const agentEngine = firstString(runtimeConfig, ["agentEngine", "agent_engine"]) || "hermes";
      if (agentEngine !== "hermes") return mcpRuntime;
      const runtime = resolvedHermesRuntime(runtimeConfig);
      if (!runtime) return mcpRuntime;
      return mergeRuntimeParts(mcpRuntime, ensureHermesSessionProfile(runtime, runtimeConfig));
    }

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
      const gatewayUrl = String(profile?.gatewayUrl || "").trim();
      const gatewayTokenFile = String(profile?.gatewayTokenFile || "").trim();
      if (!profileName) {
        throw new Error("OpenClaw Mia profile manager did not return a usable profile.");
      }
      const env = {
        MIA_OPENCLAW_PROFILE: profileName,
        ...(gatewayUrl ? { MIA_OPENCLAW_GATEWAY_URL: gatewayUrl } : {}),
        ...(gatewayTokenFile ? { MIA_OPENCLAW_GATEWAY_TOKEN_FILE: gatewayTokenFile } : {})
      };
      return mergeRuntimeParts({}, {
        runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
        env
      });
    }

    if (engineId === "codex") {
      const agentEngine = firstString(runtimeConfig, ["agentEngine", "agent_engine"]) || "codex";
      if (agentEngine !== "codex") return mcpRuntime;
      const managedRuntime = resolveManagedModelRuntime(runtimeConfig, { engine: "codex" });
      if (!managedRuntime) return mcpRuntime;
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
      return mergeRuntimeParts(mcpRuntime, {
        runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
        env: {
          CODEX_API_KEY: apiKey,
          CODEX_PATH: writeCodexMiaLauncher(codexLauncherPath),
          MIA_CODEX_MODEL_CATALOG_JSON: modelCatalogJson,
          MIA_CODEX_REAL_PATH: codexRealPath,
          MODEL_PROVIDER: "custom",
          CODEX_CONFIG: JSON.stringify(codexMiaSessionConfig(session, {
            modelCatalogJson
          }))
        }
      });
    }

    if (engineId !== "claude") return mcpRuntime;

    const agentEngine = firstString(runtimeConfig, ["agentEngine", "agent_engine"]) || "claude-code";
    if (agentEngine !== "claude-code") return mcpRuntime;

    const managedRuntime = resolveManagedModelRuntime(runtimeConfig, { engine: "claude-code" });
    if (!managedRuntime) return mcpRuntime;
    if (!claudeCodeMiaProxy || typeof claudeCodeMiaProxy.createSession !== "function") {
      throw new Error("Claude Code Mia proxy is not available.");
    }

    const session = await claudeCodeMiaProxy.createSession(managedRuntime);
    const baseUrl = String(session?.baseUrl || "").trim();
    const authToken = String(session?.authToken || "").trim();
    if (!baseUrl || !authToken) {
      throw new Error("Claude Code Mia proxy did not return a usable session.");
    }

    return mergeRuntimeParts(mcpRuntime, {
      runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: authToken
      }
    });
  }

  return { prepare };
}

module.exports = {
  createAgentSessionRuntimePreparer,
  runtimeKeyForMiaRuntime,
  runtimeKeyForResolvedRuntime
};
