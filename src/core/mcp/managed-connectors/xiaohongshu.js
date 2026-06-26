"use strict";

const { sanitizeSecretText } = require("../records.js");

const DEFAULT_ENDPOINT = "http://127.0.0.1:18060/mcp";
const REPO_URL = "https://github.com/xpzouying/xiaohongshu-mcp";
const RELEASE_DOWNLOAD_BASE = "https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download";

function createXiaohongshuManagedConnector(deps = {}) {
  const fs = deps.fs || require("node:fs");
  const path = deps.path || require("node:path");
  const childProcess = deps.childProcess || require("node:child_process");
  const AdmZip = deps.AdmZip || require("adm-zip");
  const fetch = deps.fetch;
  const downloadFetch = deps.downloadFetch || fetch;
  const listTools = deps.listTools;
  const testTools = deps.testTools;
  const runtimePaths = deps.runtimePaths;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const releaseDownloadBase = String(deps.releaseDownloadBase || RELEASE_DOWNLOAD_BASE).replace(/\/+$/, "");
  const healthPollAttempts = Number.isInteger(deps.healthPollAttempts) && deps.healthPollAttempts > 0 ? deps.healthPollAttempts : 5;
  const healthPollIntervalMs = Number.isFinite(deps.healthPollIntervalMs) && deps.healthPollIntervalMs >= 0 ? deps.healthPollIntervalMs : 250;
  const downloadTimeoutMs = Number.isFinite(Number(deps.downloadTimeoutMs)) && Number(deps.downloadTimeoutMs) > 0
    ? Number(deps.downloadTimeoutMs)
    : 20 * 60 * 1000;
  const sleep = typeof deps.sleep === "function"
    ? deps.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  function managedRoot() {
    const paths = runtimePaths();
    return path.join(paths.home || paths.runtime, "managed-mcp");
  }

  function installDir(_record = {}) {
    return path.join(managedRoot(), "xiaohongshu-mcp");
  }

  function hasCheckout(dir) {
    return fs.existsSync(path.join(dir, "go.mod"));
  }

  function runtimeBinDir(dir) {
    return path.join(dir, ".mia-runtime", "bin");
  }

  function platformPackage() {
    const osName = platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : "";
    const archName = arch === "arm64"
      ? "arm64"
      : arch === "x64"
        ? "amd64"
        : "";
    if (!osName || !archName) {
      throw new Error(`Xiaohongshu runtime is not available for ${platform}-${arch}.`);
    }
    const ext = osName === "windows" ? "zip" : "tar.gz";
    const exe = osName === "windows" ? ".exe" : "";
    return {
      osName,
      archName,
      archiveName: `xiaohongshu-mcp-${osName}-${archName}.${ext}`,
      loginBinary: `xiaohongshu-login-${osName}-${archName}${exe}`,
      serverBinary: `xiaohongshu-mcp-${osName}-${archName}${exe}`,
      isZip: osName === "windows"
    };
  }

  function findFileByName(root, fileName, depth = 4) {
    if (!root || !fs.existsSync(root) || depth < 0) return "";
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name === fileName) return fullPath;
      if (entry.isDirectory()) {
        const found = findFileByName(fullPath, fileName, depth - 1);
        if (found) return found;
      }
    }
    return "";
  }

  function runtimeBinary(dir, kind) {
    const pkg = platformPackage();
    const fileName = kind === "login" ? pkg.loginBinary : pkg.serverBinary;
    return findFileByName(runtimeBinDir(dir), fileName) || findFileByName(dir, fileName, 2);
  }

  function chmodExecutable(filePath) {
    if (!filePath || platform === "win32") return;
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {
      // Best effort; the following spawn will report a permission error if chmod failed.
    }
  }

  function removeStaleInstallDir(dir) {
    if (!fs.existsSync(dir) || hasCheckout(dir) || runtimeBinary(dir, "login") || runtimeBinary(dir, "server")) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function execFile(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleReject = (error, stdout = "", stderr = "") => {
        if (settled) return;
        settled = true;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      };
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = childProcess.execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          settleReject(error, stdout, stderr);
          return;
        }
        settleResolve({ stdout, stderr });
      });
      drainChild(child);
      child?.once?.("error", (error) => settleReject(error));
    });
  }

  function spawn(command, args, options = {}) {
    const child = childProcess.spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    drainChild(child);
    child?.on?.("error", () => {});
    return child;
  }

  function drainChild(child) {
    child?.stdout?.resume?.();
    child?.stderr?.resume?.();
  }

  function spawnErrorMessage(label, error) {
    const message = sanitizeSecretText(error?.message || error || "unknown error");
    return `${label} failed to start: ${message}`;
  }

  function earlyExitMessage(label, code, signal) {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    return `${label} exited before it became ready (${detail}).`;
  }

  function waitForInitialSpawn(child, label, options = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child?.off?.("error", onError);
        child?.off?.("exit", onExit);
      };
      const done = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onError = (error) => done(reject, new Error(spawnErrorMessage(label, error)));
      const onExit = (code, signal) => {
        if (options.allowCleanExit && Number(code) === 0 && !signal) {
          done(resolve);
          return;
        }
        done(reject, new Error(earlyExitMessage(label, code, signal)));
      };
      child?.once?.("error", onError);
      child?.once?.("exit", onExit);
      setImmediate(() => done(resolve));
    });
  }

  async function waitForReadiness(child, readinessPromise, label) {
    let settled = false;
    let cleanup = () => {};
    const earlyFailure = new Promise((_, reject) => {
      const onError = (error) => {
        if (settled) return;
        reject(new Error(spawnErrorMessage(label, error)));
      };
      const onExit = (code, signal) => {
        if (settled) return;
        reject(new Error(earlyExitMessage(label, code, signal)));
      };
      child?.once?.("error", onError);
      child?.once?.("exit", onExit);
      cleanup = () => {
        child?.off?.("error", onError);
        child?.off?.("exit", onExit);
      };
    });
    try {
      await Promise.race([readinessPromise, earlyFailure]);
      settled = true;
    } finally {
      settled = true;
      cleanup();
    }
  }

  function assertInstalled(dir) {
    if (!hasCheckout(dir) && !runtimeBinary(dir, "login") && !runtimeBinary(dir, "server")) {
      throw new Error("Xiaohongshu managed runtime is not installed.");
    }
  }

  async function fetchRuntimeArchive(url) {
    let timeoutId = null;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      if (controller) {
        timeoutId = setTimeout(() => controller.abort(), downloadTimeoutMs);
      }
      return await downloadFetch(url, controller ? { signal: controller.signal } : undefined);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Xiaohongshu runtime download timed out.");
      }
      throw error;
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
    }
  }

  async function downloadRuntimeBundle(dir) {
    if (runtimeBinary(dir, "login") && runtimeBinary(dir, "server")) return;
    if (typeof downloadFetch !== "function") {
      throw new Error("Xiaohongshu runtime download is not available.");
    }
    const pkg = platformPackage();
    const binDir = runtimeBinDir(dir);
    const archivePath = path.join(dir, ".mia-runtime", pkg.archiveName);
    const url = `${releaseDownloadBase}/${encodeURIComponent(pkg.archiveName)}`;
    fs.mkdirSync(binDir, { recursive: true });

    const response = await fetchRuntimeArchive(url);
    if (!response || response.ok !== true) {
      const status = Number(response?.status);
      const detail = Number.isFinite(status) ? `HTTP ${status}` : "request failed";
      throw new Error(`Xiaohongshu runtime download failed (${detail}).`);
    }
    if (typeof response.arrayBuffer !== "function") {
      throw new Error("Xiaohongshu runtime download returned an unreadable response.");
    }
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

    if (pkg.isZip) {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(binDir, true);
    } else {
      await execFile("tar", ["-xzf", archivePath, "-C", binDir], { cwd: binDir });
    }

    const loginBinary = runtimeBinary(dir, "login");
    const serverBinary = runtimeBinary(dir, "server");
    if (!loginBinary || !serverBinary) {
      throw new Error("Xiaohongshu runtime archive did not contain the expected binaries.");
    }
    chmodExecutable(loginBinary);
    chmodExecutable(serverBinary);
  }

  async function runtimeCommand(dir, kind) {
    const binary = runtimeBinary(dir, kind);
    if (binary) {
      chmodExecutable(binary);
      return { command: binary, args: [] };
    }
    await downloadRuntimeBundle(dir);
    const downloaded = runtimeBinary(dir, kind);
    if (downloaded) {
      chmodExecutable(downloaded);
      return { command: downloaded, args: [] };
    }
    throw new Error("Xiaohongshu runtime archive did not contain the expected binaries.");
  }

  async function checkEndpointHealth(endpoint) {
    if (typeof fetch !== "function") {
      throw new Error("fetch dependency is required.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= healthPollAttempts; attempt += 1) {
      try {
        const response = await fetch(endpoint);
        if (response && (response.ok === true || Number(response.status) === 405)) return;
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
    const tools = extractTools(await verifyTools());
    const actualCount = Array.isArray(tools) ? tools.length : 0;
    if (actualCount < expectedToolCount) {
      throw new Error(`Xiaohongshu managed runtime expected ${expectedToolCount} tools but reported ${actualCount}.`);
    }
  }

  function extractTools(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    const candidates = [
      payload.tools,
      payload.data?.tools,
      payload.data?.server?.tools,
      payload.server?.tools,
      payload.record?.tools,
      payload.data?.record?.tools
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  async function status(record = {}) {
    const dir = installDir(record);
    const installed = hasCheckout(dir) || Boolean(runtimeBinary(dir, "login") && runtimeBinary(dir, "server"));
    return {
      state: installed ? String(record.managedRuntime?.state || "installed") : "not_installed",
      installed,
      running: false,
      endpoint: String(record.managedRuntime?.endpoint || DEFAULT_ENDPOINT),
      message: installed ? "Xiaohongshu MCP runtime is present." : "Xiaohongshu MCP runtime is not installed."
    };
  }

  async function runAction(record = {}, action = "") {
    const dir = installDir(record);
    const endpoint = String(record.managedRuntime?.endpoint || DEFAULT_ENDPOINT);
    if (action === "install") {
      fs.mkdirSync(managedRoot(), { recursive: true });
      removeStaleInstallDir(dir);
      if (!hasCheckout(dir)) {
        await execFile("git", ["clone", REPO_URL, dir], { cwd: runtimePaths().runtime });
      }
      await downloadRuntimeBundle(dir);
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
      const command = await runtimeCommand(dir, "login");
      const child = spawn(command.command, command.args, { cwd: dir });
      await waitForInitialSpawn(child, "Xiaohongshu login command", { allowCleanExit: true });
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
      const command = await runtimeCommand(dir, "server");
      const child = spawn(command.command, command.args, { cwd: dir });
      try {
        await waitForReadiness(child, checkEndpointHealth(endpoint), "Xiaohongshu MCP service");
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
