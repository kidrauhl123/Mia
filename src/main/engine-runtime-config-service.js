const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

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

  function effectiveHermesHome() {
    return runtimePaths().home;
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

  function modelSettings() {
    const p = runtimePaths();
    const saved = readJson(p.modelSettings, {});
    if (!saved.provider && !saved.model && !saved.apiKey) return defaultModelSettings();
    return { ...defaultModelSettings(), ...saved };
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

  function writeRuntimeConfig(port) {
    const p = runtimePaths();
    const settings = modelSettings();
    const provider = String(settings.provider || "").trim();
    const model = String(settings.model || "").trim();
    const apiKeyEnv = String(settings.apiKeyEnv || "").trim();
    const baseUrl = String(settings.baseUrl || "").trim();
    const apiMode = String(settings.apiMode || "").trim();
    const approvalsMode = permissionSettings().mode;
    const reasoningEffort = effortSettings().level;
    const source = engineSource();
    const configPath = path.join(effectiveHermesHome(), "config.yaml");
    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });

    fsImpl.mkdirSync(p.home, { recursive: true });
    const lines = [
      "model:",
      `  provider: ${JSON.stringify(provider)}`,
      `  default: ${JSON.stringify(model)}`,
    ];
    if (baseUrl) lines.push(`  base_url: ${JSON.stringify(baseUrl)}`);
    if (apiMode) lines.push(`  api_mode: ${JSON.stringify(apiMode)}`);
    if (provider && baseUrl) {
      lines.push(
        "",
        "providers:",
        `  ${JSON.stringify(provider)}:`,
        `    name: ${JSON.stringify(settings.providerLabel || provider)}`,
        `    base_url: ${JSON.stringify(baseUrl)}`,
        ...(apiKeyEnv ? [`    key_env: ${JSON.stringify(apiKeyEnv)}`] : []),
        ...(model ? [`    default_model: ${JSON.stringify(model)}`] : []),
        ...(apiMode ? [`    api_mode: ${JSON.stringify(apiMode)}`] : [])
      );
    }
    lines.push(
      "",
      "platforms:",
      "  api_server:",
      "    enabled: true",
      "    host: 127.0.0.1",
      `    port: ${port}`,
      `    key: ${apiKey()}`,
      "  feishu:",
      "    enabled: false",
      "  telegram:",
      "    enabled: false",
      "  discord:",
      "    enabled: false",
      "",
      "approvals:",
      `  mode: ${JSON.stringify(approvalsMode)}`,
      "  timeout: 60",
      "",
      "agent:",
      `  reasoning_effort: ${JSON.stringify(reasoningEffort)}`,
      // Scheduling is owned by mia's app-maintained scheduler (the
      // mia-scheduler MCP below), which delivers reminders back into the
      // chat. Disable Hermes' built-in cronjob toolset so the bot routes
      // through the app scheduler instead of Hermes' own cron (whose output
      // never reaches the desktop UI).
      "  disabled_toolsets:",
      "    - cronjob",
      ""
    );
    const extDirs = externalSkillDirs();
    if (extDirs.length) {
      lines.push("skills:");
      lines.push("  external_dirs:");
      for (const dir of extDirs) lines.push(`    - ${JSON.stringify(dir)}`);
      lines.push("");
    }
    const mcpServers = {};
    const miaAppSpec = (() => {
      try { return getMiaAppMcpSpec(); } catch { return null; }
    })();
    if (miaAppSpec && miaAppSpec.command) {
      mcpServers["mia-app"] = {
        command: miaAppSpec.command,
        args: miaAppSpec.args || [],
        env: miaAppSpec.env || {}
      };
    }
    const schedulerSpec = (() => {
      try { return getSchedulerMcpSpec(); } catch { return null; }
    })();
    if (schedulerSpec && schedulerSpec.command) {
      // Reuse the same scheduler MCP server that Claude Code / Codex get, so
      // the Hermes bot can call schedule_* and have the app deliver the
      // reminder. Hermes reads command/args/env per mcp_servers entry and
      // infers stdio transport when no url is present (see Hermes mcp_tool).
      mcpServers["mia-scheduler"] = {
        command: schedulerSpec.command,
        args: schedulerSpec.args || [],
        env: schedulerSpec.env || {}
      };
    }
    if (Object.keys(mcpServers).length) {
      const mcpYaml = yaml.dump({ mcp_servers: mcpServers }).trimEnd();
      lines.push(mcpYaml, "");
    }
    lines.push(
      "mia:",
      "  runtime_schema: 1",
      "  bots_manifest: bots/manifest.json",
      ""
    );
    atomicWriteFile(configPath, lines.join("\n"), 0o600);
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
    readConfiguredPort,
    writeRuntimeConfig
  };
}

module.exports = {
  createEngineRuntimeConfigService
};
