"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");

const DEFAULT_PROFILE = "mia";
const DEFAULT_GATEWAY_PORT = 18790;
const DEFAULT_CONTEXT_WINDOW = 200000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonIfChanged(filePath, value) {
  const next = stableJson(value);
  return writeTextIfChanged(filePath, next);
}

function writeTextIfChanged(filePath, next) {
  try {
    if (fs.readFileSync(filePath, "utf8") === next) return false;
  } catch {
    // Missing files are written below.
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, { mode: 0o600 });
  return true;
}

function assertSafeProfile(profile = "") {
  const value = String(profile || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("OpenClaw profile 名称只能包含字母、数字、点、下划线和短横线。");
  }
  return value;
}

function canonicalMiaModel(model = "") {
  const raw = String(model || "").trim().replace(/^mia:/, "");
  return raw === "mia-default" || !raw ? "mia-auto" : raw;
}

function providerForRuntime(runtime = {}) {
  const baseUrl = String(runtime.baseUrl || runtime.base_url || "").trim();
  const apiKey = String(runtime.apiKey || runtime.api_key || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Error("OpenClaw Mia profile requires a Mia model baseUrl and apiKey.");
  }
  const model = canonicalMiaModel(runtime.model || "mia-auto");
  return {
    baseUrl,
    apiKey,
    auth: "token",
    api: "openai-completions",
    agentRuntime: { id: "openclaw" },
    models: [{
      id: model,
      name: model === "mia-auto" ? "Auto" : model,
      input: ["text"],
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      agentRuntime: { id: "openclaw" }
    }]
  };
}

function profileRootFor(homeDir, profile) {
  return path.join(homeDir, `.openclaw-${profile}`);
}

function gatewayTokenForConfig(config = {}, options = {}) {
  const configured = String(options.gatewayToken || "").trim();
  if (configured) return configured;
  const auth = config?.gateway?.auth;
  if (auth && typeof auth === "object") {
    const existing = String(auth.token || "").trim();
    if (existing) return existing;
  }
  const legacy = String(config?.gateway?.token || "").trim();
  if (legacy) return legacy;
  return randomBytes(32).toString("hex");
}

function scopesIncludeAdmin(scopes = []) {
  return Array.isArray(scopes) && scopes.includes("operator.admin");
}

function resetStaleDevicePairing(root) {
  const devicesDir = path.join(root, "devices");
  const pairedPath = path.join(devicesDir, "paired.json");
  const pendingPath = path.join(devicesDir, "pending.json");
  const paired = safeReadJson(pairedPath);
  const pending = safeReadJson(pendingPath);
  const pairedEntries = paired && typeof paired === "object" ? Object.values(paired) : [];
  const pendingEntries = pending && typeof pending === "object" ? Object.values(pending) : [];
  const hasPendingUpgrade = pendingEntries.length > 0;
  const hasStaleOperatorPairing = pairedEntries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const roles = Array.isArray(entry.roles) ? entry.roles : [entry.role].filter(Boolean);
    if (!roles.includes("operator")) return false;
    return !scopesIncludeAdmin(entry.scopes) && !scopesIncludeAdmin(entry.approvedScopes);
  });
  if (!hasPendingUpgrade && !hasStaleOperatorPairing) return false;
  fs.rmSync(pairedPath, { force: true });
  fs.rmSync(pendingPath, { force: true });
  return true;
}

function createOpenClawMiaProfile(options = {}) {
  const profile = assertSafeProfile(options.profile || DEFAULT_PROFILE);
  const gatewayPort = Number(options.gatewayPort || DEFAULT_GATEWAY_PORT);
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
  const homeDir = typeof options.homeDir === "function" ? options.homeDir : () => os.homedir();
  const command = String(options.command || "openclaw").trim() || "openclaw";
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  const gatewayHealthCheck = typeof options.gatewayHealthy === "function" ? options.gatewayHealthy : null;
  const healthTimeoutMs = Number(options.healthTimeoutMs || 1000);
  const startupTimeoutMs = Number(options.startupTimeoutMs || 10000);
  const startupPollMs = Number(options.startupPollMs || 250);

  let foregroundGateway = null;
  let cleanupRegistered = false;

  async function gatewayHealthy() {
    if (gatewayHealthCheck) {
      return Boolean(await gatewayHealthCheck({ profile, gatewayPort, gatewayUrl }));
    }
    return new Promise((resolve) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: gatewayPort,
        path: "/healthz",
        method: "GET",
        timeout: healthTimeoutMs
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024) request.destroy();
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            resolve(response.statusCode === 200 && parsed?.ok === true);
          } catch {
            resolve(false);
          }
        });
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => resolve(false));
      request.end();
    });
  }

  function stopForegroundGateway() {
    const child = foregroundGateway;
    foregroundGateway = null;
    if (!child) return;
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    if (child.signalCode) return;
    try { child.kill("SIGTERM"); } catch {}
  }

  function registerCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.once("exit", stopForegroundGateway);
  }

  async function waitForGatewayHealthy(child) {
    const deadline = Date.now() + startupTimeoutMs;
    let spawnError = null;
    if (child && typeof child.once === "function") {
      child.once("error", (error) => {
        spawnError = error;
      });
    }

    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child && child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error(`OpenClaw Mia Gateway exited before becoming healthy (exit ${child.exitCode}).`);
      }
      if (child?.signalCode) {
        throw new Error(`OpenClaw Mia Gateway exited before becoming healthy (signal ${child.signalCode}).`);
      }
      if (await gatewayHealthy()) return;
      await delay(startupPollMs);
    }
    throw new Error(`OpenClaw Mia Gateway did not become healthy on ${gatewayUrl}.`);
  }

  async function startForegroundGateway() {
    stopForegroundGateway();
    registerCleanup();
    const args = [
      "--profile", profile,
      "gateway", "run",
      "--port", String(gatewayPort),
      "--bind", "loopback",
      "--auth", "token",
      "--force",
      "--compact"
    ];
    const child = spawnProcess(command, args, {
      cwd: homeDir(),
      env: { ...process.env, HOME: homeDir() },
      stdio: ["ignore", "ignore", "ignore"]
    });
    foregroundGateway = child;
    if (child && typeof child.once === "function") {
      child.once("exit", () => {
        if (foregroundGateway === child) foregroundGateway = null;
      });
    }
    if (child && typeof child.unref === "function") child.unref();
    await waitForGatewayHealthy(child);
  }

  async function ensure(runtime = {}) {
    const root = profileRootFor(homeDir(), profile);
    const provider = providerForRuntime(runtime);
    const openclawConfigPath = path.join(root, "openclaw.json");
    const modelsConfigPath = path.join(root, "agents", "main", "agent", "models.json");
    const gatewayTokenFile = path.join(root, "gateway-token");

    const existingConfig = safeReadJson(openclawConfigPath);
    const gatewayToken = gatewayTokenForConfig(existingConfig, options);
    const nextConfig = {
      ...existingConfig,
      gateway: {
        ...(existingConfig.gateway && typeof existingConfig.gateway === "object" ? existingConfig.gateway : {}),
        mode: "local",
        bind: "loopback",
        port: gatewayPort,
        auth: { mode: "token", token: gatewayToken }
      },
      models: {
        ...(existingConfig.models && typeof existingConfig.models === "object" ? existingConfig.models : {}),
        mode: "merge",
        providers: {
          ...((existingConfig.models && typeof existingConfig.models.providers === "object") ? existingConfig.models.providers : {}),
          mia: provider
        }
      }
    };

    const existingModels = safeReadJson(modelsConfigPath);
    const nextModels = {
      ...existingModels,
      providers: {
        ...(existingModels.providers && typeof existingModels.providers === "object" ? existingModels.providers : {}),
        mia: provider
      }
    };

    const changed = [
      writeJsonIfChanged(openclawConfigPath, nextConfig),
      writeJsonIfChanged(modelsConfigPath, nextModels),
      writeTextIfChanged(gatewayTokenFile, `${gatewayToken}\n`),
      resetStaleDevicePairing(root)
    ].some(Boolean);

    if (changed) {
      await startForegroundGateway();
    } else if (!(await gatewayHealthy())) {
      await startForegroundGateway();
    }

    return { profile, gatewayUrl, gatewayTokenFile };
  }

  return { ensure, stop: stopForegroundGateway };
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PROFILE,
  createOpenClawMiaProfile,
  providerForRuntime
};
