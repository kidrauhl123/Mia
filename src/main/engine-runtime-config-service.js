const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { mergeMcpServersWithReservedBuiltIns } = require("./mcp-reserved-servers.js");

function createEngineRuntimeConfigService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const readJson = deps.readJson || ((filePath, fallback) => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  });
  const randomBytes = deps.randomBytes || ((size) => crypto.randomBytes(size));
  const defaultModelSettings = deps.defaultModelSettings || (() => ({
    provider: "",
    model: "",
    apiKeyEnv: "",
    apiKey: "",
    baseUrl: "",
    apiMode: ""
  }));
  const permissionSettings = deps.permissionSettings || (() => ({ mode: "ask" }));
  const effortSettings = deps.effortSettings || (() => ({ level: "medium" }));
  const engineSource = deps.engineSource || (() => "none");
  const externalSkillDirsSource = deps.externalSkillDirs || (() => []);
  const getMiaAppMcpSpec = typeof deps.getMiaAppMcpSpec === "function"
    ? deps.getMiaAppMcpSpec
    : () => null;
  const getSchedulerMcpSpec = typeof deps.getSchedulerMcpSpec === "function"
    ? deps.getSchedulerMcpSpec
    : () => null;
  const getUserMcpSpecs = typeof deps.getUserMcpSpecs === "function"
    ? deps.getUserMcpSpecs
    : () => ({});
  const resolveModelRuntime = typeof deps.resolveModelRuntime === "function"
    ? deps.resolveModelRuntime
    : () => null;

  function runtimeMcpSpec(spec = {}) {
    if (!spec || typeof spec !== "object") return null;
    const command = String(spec.command || "").trim();
    const url = String(spec.url || "").trim();
    if (command) {
      return {
        command,
        args: Array.isArray(spec.args) ? spec.args : [],
        env: spec.env && typeof spec.env === "object" ? spec.env : {}
      };
    }
    if (url) {
      const normalized = {
        url,
        headers: spec.headers && typeof spec.headers === "object" ? spec.headers : {}
      };
      const bearer = String(spec.bearer_token_env_var || spec.bearerTokenEnvVar || "").trim();
      if (bearer) normalized.bearer_token_env_var = bearer;
      return normalized;
    }
    return null;
  }

  function effectiveHermesHome() {
    return runtimePaths().hermesHome || runtimePaths().home;
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function readYamlObject(filePath) {
    try {
      const parsed = yaml.load(fsImpl.readFileSync(filePath, "utf8"));
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const next = String(value || "").trim();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      result.push(next);
    }
    return result;
  }

  function apiKey() {
    const p = runtimePaths();
    if (!fsImpl.existsSync(p.apiKey)) {
      fsImpl.mkdirSync(path.dirname(p.apiKey), { recursive: true });
      fsImpl.writeFileSync(p.apiKey, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
      if (typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(p.apiKey, 0o600);
    }
    return fsImpl.readFileSync(p.apiKey, "utf8").trim();
  }

  function modelSettings(overrides = null) {
    if (overrides && typeof overrides === "object") {
      return { ...defaultModelSettings(), ...overrides };
    }
    const p = runtimePaths();
    const saved = readJson(p.modelSettings, {});
    if (!saved.provider && !saved.model && !saved.apiKey) return defaultModelSettings();
    return { ...defaultModelSettings(), ...saved };
  }

  function isCompactRuntimeReference(settings = {}) {
    const provider = String(settings.provider || "").trim();
    const authType = String(settings.authType || settings.auth_type || "").trim();
    const providerConnectionId = String(settings.providerConnectionId || settings.provider_connection_id || "").trim();
    const modelProfileId = String(settings.modelProfileId || settings.model_profile_id || "").trim();
    const model = String(settings.model || "").trim();
    return Boolean(
      providerConnectionId
      || modelProfileId
      || provider === "mia"
      || authType === "mia_account"
      || model === "mia-auto"
      || model === "mia-default"
    );
  }

  function defaultMiaAutoRuntimeReference() {
    return {
      provider: "mia",
      providerConnectionId: "mia",
      providerLabel: "Mia",
      authType: "mia_account",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto"
    };
  }

  function hasModelRuntimeSettings(settings = {}) {
    return Boolean(
      String(settings.provider || "").trim()
      || String(settings.providerConnectionId || settings.provider_connection_id || "").trim()
      || String(settings.modelProfileId || settings.model_profile_id || "").trim()
      || String(settings.model || "").trim()
      || String(settings.apiKey || settings.api_key || "").trim()
      || String(settings.baseUrl || settings.base_url || "").trim()
      || String(settings.apiMode || settings.api_mode || "").trim()
    );
  }

  function resolveRuntimeSettings(settings = {}, { optional = false } = {}) {
    if (!isCompactRuntimeReference(settings)) return settings;
    try {
      const runtime = resolveModelRuntime(settings, { engine: "hermes" });
      if (!runtime) return settings;
      return {
        ...settings,
        provider: runtime.provider || settings.provider || "",
        providerConnectionId: runtime.providerConnectionId || settings.providerConnectionId || runtime.provider || "",
        providerLabel: runtime.providerLabel || settings.providerLabel || runtime.provider || settings.provider || "",
        authType: runtime.authType || settings.authType || "api_key",
        model: runtime.model || settings.model || "",
        modelProfileId: runtime.modelProfileId || settings.modelProfileId || "",
        apiKeyEnv: runtime.apiKeyEnv || "",
        apiKey: runtime.apiKey || "",
        baseUrl: runtime.baseUrl || "",
        apiMode: runtime.apiMode || ""
      };
    } catch (error) {
      if (optional) return settings;
      throw error;
    }
  }

  function runtimeResolvedModelSettings(settings = {}) {
    if (!hasModelRuntimeSettings(settings)) {
      const auto = resolveRuntimeSettings(defaultMiaAutoRuntimeReference(), { optional: true });
      return hasModelRuntimeSettings(auto) && String(auto.baseUrl || "").trim() ? auto : settings;
    }
    return resolveRuntimeSettings(settings);
  }

  function clearStaleMiaOwnedModelConfig(config = {}) {
    if (!isPlainObject(config?.mia) || Number(config.mia.runtime_schema) !== 1) return;
    const modelConfig = isPlainObject(config.model) ? config.model : null;
    const staleProvider = String(modelConfig?.provider || "").trim();
    delete config.model;
    if (staleProvider && isPlainObject(config.providers)) {
      const providers = { ...config.providers };
      delete providers[staleProvider];
      if (Object.keys(providers).length) config.providers = providers;
      else delete config.providers;
    }
  }

  function externalSkillDirs() {
    const candidates = typeof externalSkillDirsSource === "function"
      ? externalSkillDirsSource()
      : externalSkillDirsSource;
    const seen = new Set();
    const result = [];
    for (const candidate of candidates || []) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        if (fsImpl.statSync(candidate).isDirectory()) result.push(candidate);
      } catch {
        // skip missing/inaccessible paths
      }
    }
    return result;
  }

  function atomicWriteFile(filePath, content, mode = 0o600) {
    const dir = path.dirname(filePath);
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fsImpl.writeFileSync(tmpPath, content, { mode });
    fsImpl.renameSync(tmpPath, filePath);
  }

  function writeRuntimeConfig(port, options = {}) {
    const p = runtimePaths();
    const settings = runtimeResolvedModelSettings(modelSettings(options.modelSettings));
    const provider = String(settings.provider || "").trim();
    const model = String(settings.model || "").trim();
    const apiKeyEnv = String(settings.apiKeyEnv || "").trim();
    const baseUrl = String(settings.baseUrl || "").trim();
    const apiMode = String(settings.apiMode || "").trim();
    const approvalsMode = permissionSettings().mode;
    const reasoningEffort = effortSettings().level;
    const configPath = path.join(effectiveHermesHome(), "config.yaml");
    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });

    fsImpl.mkdirSync(p.home, { recursive: true });
    const config = readYamlObject(configPath);
    if (!hasModelRuntimeSettings(settings)) {
      clearStaleMiaOwnedModelConfig(config);
    } else {
      const modelConfig = isPlainObject(config.model) ? { ...config.model } : {};
      if (provider) modelConfig.provider = provider;
      if (model) modelConfig.default = model;
      if (baseUrl) modelConfig.base_url = baseUrl;
      if (apiMode) modelConfig.api_mode = apiMode;
      if (Object.keys(modelConfig).length) config.model = modelConfig;
    }

    if (hasModelRuntimeSettings(settings) && provider && baseUrl) {
      const providers = isPlainObject(config.providers) ? { ...config.providers } : {};
      const providerConfig = isPlainObject(providers[provider]) ? { ...providers[provider] } : {};
      providerConfig.name = settings.providerLabel || provider;
      providerConfig.base_url = baseUrl;
      if (apiKeyEnv) providerConfig.key_env = apiKeyEnv;
      if (settings.apiKey) providerConfig.api_key = settings.apiKey;
      if (model) providerConfig.default_model = model;
      if (apiMode) providerConfig.api_mode = apiMode;
      providers[provider] = providerConfig;
      config.providers = providers;
    }

    const platforms = isPlainObject(config.platforms) ? { ...config.platforms } : {};
    platforms.api_server = {
      ...(isPlainObject(platforms.api_server) ? platforms.api_server : {}),
      enabled: true,
      host: "127.0.0.1",
      port,
      key: apiKey()
    };
    config.platforms = platforms;

    config.approvals = {
      ...(isPlainObject(config.approvals) ? config.approvals : {}),
      mode: approvalsMode,
      timeout: Number(config.approvals?.timeout || 60) || 60
    };

    const agent = isPlainObject(config.agent) ? { ...config.agent } : {};
    agent.reasoning_effort = reasoningEffort;
    agent.disabled_toolsets = uniqueStrings([
      ...(Array.isArray(agent.disabled_toolsets) ? agent.disabled_toolsets : []),
      "cronjob"
    ]);
    config.agent = agent;

    const extDirs = externalSkillDirs();
    if (extDirs.length) {
      const skills = isPlainObject(config.skills) ? { ...config.skills } : {};
      skills.external_dirs = uniqueStrings([
        ...(Array.isArray(skills.external_dirs) ? skills.external_dirs : []),
        ...extDirs
      ]);
      config.skills = skills;
    }
    const builtInMcpServers = {};
    const miaAppSpec = (() => {
      try { return getMiaAppMcpSpec(); } catch { return null; }
    })();
    const normalizedMiaAppSpec = runtimeMcpSpec(miaAppSpec);
    if (normalizedMiaAppSpec) builtInMcpServers["mia-app"] = normalizedMiaAppSpec;
    const schedulerSpec = (() => {
      try { return getSchedulerMcpSpec(); } catch { return null; }
    })();
    const normalizedSchedulerSpec = runtimeMcpSpec(schedulerSpec);
    if (normalizedSchedulerSpec) {
      // Reuse the same scheduler MCP server that Claude Code / Codex get, so
      // the Hermes bot can call schedule_* and have the app deliver the
      // reminder. Hermes reads command/args/env per mcp_servers entry and
      // infers stdio transport when no url is present (see Hermes mcp_tool).
      builtInMcpServers["mia-scheduler"] = normalizedSchedulerSpec;
    }
    const userMcpServers = {};
    for (const [name, spec] of Object.entries(getUserMcpSpecs() || {})) {
      const normalizedSpec = runtimeMcpSpec(spec);
      if (normalizedSpec) userMcpServers[name] = normalizedSpec;
    }
    const mcpServers = mergeMcpServersWithReservedBuiltIns({
      userServers: userMcpServers,
      builtInServers: builtInMcpServers
    });
    if (Object.keys(mcpServers).length) {
      config.mcp_servers = {
        ...(isPlainObject(config.mcp_servers) ? config.mcp_servers : {}),
        ...mcpServers
      };
    }
    config.mia = {
      ...(isPlainObject(config.mia) ? config.mia : {}),
      runtime_schema: 1,
      bots_manifest: p.botManifest
    };
    atomicWriteFile(configPath, yaml.dump(config, { lineWidth: 100, noRefs: true }), 0o600);
  }

  function modelRuntimeEnv(overrides = null) {
    const settings = runtimeResolvedModelSettings(modelSettings(overrides));
    const key = String(settings.apiKeyEnv || "").trim();
    const value = String(settings.apiKey || "").trim();
    return key && value ? { [key]: value } : {};
  }

  function readConfiguredPort() {
    const configPath = path.join(effectiveHermesHome(), "config.yaml");
    if (!fsImpl.existsSync(configPath)) return 18642;
    try {
      const parsed = yaml.load(fsImpl.readFileSync(configPath, "utf8"));
      const port = Number(parsed?.platforms?.api_server?.port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // fall through
    }
    return 18642;
  }

  return {
    apiKey,
    atomicWriteFile,
    effectiveHermesHome,
    externalSkillDirs,
    modelSettings,
    modelRuntimeEnv,
    readConfiguredPort,
    writeRuntimeConfig
  };
}

module.exports = {
  createEngineRuntimeConfigService
};
