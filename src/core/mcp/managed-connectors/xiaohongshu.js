"use strict";

const DEFAULT_ENDPOINT = "http://127.0.0.1:18060/mcp";
const REPO_URL = "https://github.com/xpzouying/xiaohongshu-mcp";

function createXiaohongshuManagedConnector(deps = {}) {
  const fs = deps.fs || require("node:fs");
  const path = deps.path || require("node:path");
  const childProcess = deps.childProcess || require("node:child_process");
  const fetch = deps.fetch;
  const listTools = deps.listTools;
  const testTools = deps.testTools;
  const runtimePaths = deps.runtimePaths;
  const healthPollAttempts = Number.isInteger(deps.healthPollAttempts) && deps.healthPollAttempts > 0 ? deps.healthPollAttempts : 5;
  const healthPollIntervalMs = Number.isFinite(deps.healthPollIntervalMs) && deps.healthPollIntervalMs >= 0 ? deps.healthPollIntervalMs : 250;
  const sleep = typeof deps.sleep === "function"
    ? deps.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  function installDir(record = {}) {
    const existing = String(record.managedRuntime?.installDir || "").trim();
    if (existing) return existing;
    return path.join(runtimePaths().runtime, "managed-mcp", "xiaohongshu-mcp");
  }

  function hasCheckout(dir) {
    return fs.existsSync(path.join(dir, "go.mod"));
  }

  function execFile(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  function spawn(command, args, options = {}) {
    return childProcess.spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  function assertInstalled(dir) {
    if (!hasCheckout(dir)) throw new Error("Xiaohongshu managed checkout is not installed.");
  }

  async function checkEndpointHealth(endpoint) {
    if (typeof fetch !== "function") {
      throw new Error("fetch dependency is required.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= healthPollAttempts; attempt += 1) {
      try {
        const response = await fetch(endpoint);
        if (response && response.ok === true) return;
        const status = Number(response?.status);
        const detail = Number.isFinite(status) ? ` Status ${status}.` : "";
        lastError = new Error(`Xiaohongshu endpoint health check failed for ${endpoint}.${detail}`);
      } catch (error) {
        const reason = String(error?.message || error || "").trim();
        const suffix = reason ? ` ${reason}` : "";
        lastError = new Error(`Xiaohongshu endpoint health check failed for ${endpoint}.${suffix}`.trim());
      }
      if (attempt < healthPollAttempts) {
        await sleep(healthPollIntervalMs);
      }
    }
    throw lastError || new Error(`Xiaohongshu endpoint health check failed for ${endpoint}.`);
  }

  async function verifyExpectedTools(record, endpoint) {
    const expectedToolCount = Number(record?.managedRuntime?.expectedToolCount || 0);
    if (expectedToolCount <= 0) return;
    const verifyTools = typeof listTools === "function"
      ? () => listTools(endpoint, record)
      : typeof testTools === "function"
        ? () => testTools(record)
        : null;
    if (!verifyTools) {
      throw new Error("Expected tool verification dependency is required.");
    }
    const tools = await verifyTools();
    const actualCount = Array.isArray(tools) ? tools.length : 0;
    if (actualCount < expectedToolCount) {
      throw new Error(`Xiaohongshu managed runtime expected ${expectedToolCount} tools but reported ${actualCount}.`);
    }
  }

  async function status(record = {}) {
    const dir = installDir(record);
    const installed = hasCheckout(dir);
    return {
      state: installed ? String(record.managedRuntime?.state || "installed") : "not_installed",
      installed,
      running: false,
      endpoint: String(record.managedRuntime?.endpoint || DEFAULT_ENDPOINT),
      message: installed ? "Xiaohongshu MCP checkout is present." : "Xiaohongshu MCP checkout is not installed."
    };
  }

  async function runAction(record = {}, action = "") {
    const dir = installDir(record);
    const endpoint = String(record.managedRuntime?.endpoint || DEFAULT_ENDPOINT);
    if (action === "install") {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      if (!hasCheckout(dir)) {
        await execFile("git", ["clone", REPO_URL, dir], { cwd: runtimePaths().runtime });
      }
      return {
        ok: true,
        state: "installed",
        message: "Xiaohongshu MCP is installed.",
        recordPatch: {
          managedRuntime: {
            ...record.managedRuntime,
            installDir: dir,
            endpoint,
            state: "installed",
            lastAction: "install"
          }
        }
      };
    }
    if (action === "login") {
      assertInstalled(dir);
      const child = spawn("go", ["run", "cmd/login/main.go"], { cwd: dir });
      return {
        ok: true,
        state: "login_started",
        child,
        message: "Xiaohongshu login was started.",
        recordPatch: {
          managedRuntime: {
            ...record.managedRuntime,
            installDir: dir,
            endpoint,
            state: "login_started",
            lastAction: "login"
          }
        }
      };
    }
    if (action === "start") {
      assertInstalled(dir);
      const child = spawn("go", ["run", "."], { cwd: dir });
      try {
        await checkEndpointHealth(endpoint);
      } catch (error) {
        child.kill?.();
        throw error;
      }
      return {
        ok: true,
        state: "running",
        child,
        message: "Xiaohongshu MCP service is running.",
        recordPatch: {
          managedRuntime: {
            ...record.managedRuntime,
            installDir: dir,
            endpoint,
            state: "running",
            lastAction: "start"
          }
        }
      };
    }
    if (action === "test") {
      assertInstalled(dir);
      await checkEndpointHealth(endpoint);
      await verifyExpectedTools(record, endpoint);
      return {
        ok: true,
        state: "healthy",
        message: "Xiaohongshu MCP endpoint is healthy.",
        recordPatch: {
          managedRuntime: {
            ...record.managedRuntime,
            installDir: dir,
            endpoint,
            state: "healthy",
            lastAction: "test"
          }
        }
      };
    }
    throw new Error(`Unsupported xiaohongshu managed action: ${action}`);
  }

  return {
    id: "xiaohongshu",
    installDir,
    status,
    runAction
  };
}

module.exports = { createXiaohongshuManagedConnector };
