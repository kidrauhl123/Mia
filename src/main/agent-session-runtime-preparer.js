"use strict";

const { createOpenClawMiaProfile } = require("./openclaw-mia-profile.js");
const { createCodexMiaProxy } = require("./codex-mia-proxy.js");

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

function codexConfigForMiaSession(session = {}) {
  const baseUrl = String(session.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(session.model || "").trim();
  return {
    model,
    model_provider: "custom",
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
      return {
        runtimeKey: runtimeKeyForMiaRuntime(managedRuntime),
        env: {
          CODEX_API_KEY: apiKey,
          MODEL_PROVIDER: "custom",
          CODEX_CONFIG: JSON.stringify(codexConfigForMiaSession(session))
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
