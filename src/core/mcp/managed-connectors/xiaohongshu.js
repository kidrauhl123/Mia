"use strict";

const DEFAULT_ENDPOINT = "http://127.0.0.1:18060/mcp";
const REPO_URL = "https://github.com/xpzouying/xiaohongshu-mcp";

function createXiaohongshuManagedConnector(deps = {}) {
  const fs = deps.fs || require("node:fs");
  const path = deps.path || require("node:path");
  const childProcess = deps.childProcess || require("node:child_process");
  const runtimePaths = deps.runtimePaths;
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
      const child = spawn("go", ["run", "."], { cwd: dir });
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
