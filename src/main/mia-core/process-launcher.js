"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const path = require("node:path");
const { createMiaCoreResolver } = require("./process-resolver.js");

function coreStartErrorMessage(command, error) {
  const program = String(command || "").trim() || "(unknown)";
  const detail = String(error?.message || error || "unknown error");
  const message = `Failed to start Mia Core process "${program}": ${detail}`;
  const base = path.basename(program).toLowerCase();
  if (error?.code === "ENOENT" && (base === "mia-core" || base === "mia-core.exe")) {
    return `${message}. Mia Core is packaged as a prebuilt executable; run npm run core:prepare or set MIA_CORE_BIN to a prepared mia-core executable.`;
  }
  return message;
}

function waitForInitialSpawn(child, command, timeoutMs = 75) {
  if (!child || typeof child.once !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (typeof child.removeListener === "function") {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onSpawn = () => finish();
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(coreStartErrorMessage(command, error)));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    timer = setTimeout(finish, timeoutMs);
  });
}

function createMiaCoreProcessLauncher(deps = {}) {
  const {
    runtimePaths,
    effectiveHermesHome,
    appPath,
    execPath = () => process.execPath,
    defaultApp = () => Boolean(process.defaultApp),
    env = process.env,
    coreSettings = () => ({}),
    appVersion = () => "",
    spawn = defaultSpawn,
    killProcess = (pid, signal) => process.kill(pid, signal),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    appendLog = () => {}
  } = deps;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");
  if (typeof appPath !== "function") throw new Error("appPath dependency is required.");

  const resolver = deps.resolver || createMiaCoreResolver({
    runtimePaths,
    effectiveHermesHome,
    appPath,
    execPath,
    defaultApp,
    env,
    coreSettings,
    appVersion
  });
  let currentChild = null;
  let currentPid = 0;
  let currentExited = true;

  function coreProgramArguments() {
    const r = resolver.resolve();
    return [r.command, ...r.args];
  }

  function coreEnvironment() {
    const overlay = resolver.coreEnvOverlay();
    return { ...env, ...overlay };
  }

  function coreWorkingDirectory() {
    return resolver.resolve().workingDirectory;
  }

  function shouldCaptureCoreOutput() {
    const target = resolver.resolve();
    return env.MIA_CORE_CAPTURE_STDIO === "1"
      || env.MIA_CORE_START_MODE === "process"
      || defaultApp()
      || path.basename(String(target.command || "")).startsWith("mia-core");
  }

  function attachOutputLog(stream, label) {
    if (!stream || typeof stream.on !== "function") return;
    if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
    let pending = "";
    stream.on("data", (chunk) => {
      pending += String(chunk || "");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) appendLog(`Mia Core ${label}: ${line}`);
      }
    });
    stream.on("end", () => {
      if (pending.trim()) appendLog(`Mia Core ${label}: ${pending}`);
      pending = "";
    });
  }

  async function start() {
    if (currentChild && !currentExited && currentPid > 0) {
      appendLog(`Mia Core process pid ${currentPid} is already starting.`);
      return { pid: currentPid, reused: true };
    }
    const [command, ...args] = coreProgramArguments();
    const captureOutput = shouldCaptureCoreOutput();
    const child = spawn(command, args, {
      cwd: coreWorkingDirectory(),
      detached: true,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      env: coreEnvironment(),
      ...(process.platform === "win32" ? { windowsHide: true } : {})
    });
    if (captureOutput) {
      attachOutputLog(child.stdout, "stdout");
      attachOutputLog(child.stderr, "stderr");
    }
    if (typeof child.once === "function") {
      child.once("error", (error) => {
        currentExited = true;
        if (currentChild === child) {
          currentChild = null;
          currentPid = 0;
        }
        appendLog(`Mia Core process error: ${error?.message || error}`);
      });
      child.once("exit", (code, signal) => {
        currentExited = true;
        if (currentChild === child) {
          currentChild = null;
          currentPid = 0;
        }
        appendLog(`Mia Core process exited code=${code ?? ""} signal=${signal || ""}`);
      });
    }
    currentChild = child;
    currentPid = child.pid || 0;
    currentExited = false;
    await waitForInitialSpawn(child, command);
    if (typeof child.unref === "function") child.unref();
    appendLog(`Started Mia Core process pid ${child.pid || "(unknown)"}.`);
    return { pid: child.pid || 0 };
  }

  async function stopObservedProcess(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 0 || value === process.pid) {
      return { stopped: false, pid: 0 };
    }
    try {
      killProcess(value, "SIGTERM");
      await sleep(150);
      appendLog(`Stopped stale Mia Core process pid ${value}.`);
      return { stopped: true, pid: value };
    } catch (error) {
      appendLog(`Failed to stop stale Mia Core process pid ${value}: ${error?.message || error}`);
      return { stopped: false, pid: value, error: error?.message || String(error) };
    }
  }

  async function stopCurrentProcess() {
    if (!currentChild || currentExited || !currentPid) {
      return { stopped: false, pid: 0 };
    }
    const pid = currentPid;
    currentChild = null;
    currentPid = 0;
    currentExited = true;
    return stopObservedProcess(pid);
  }

  return {
    coreEnvironment,
    coreProgramArguments,
    coreWorkingDirectory,
    stopCurrentProcess,
    stopObservedProcess,
    start
  };
}

module.exports = {
  createMiaCoreProcessLauncher,
  coreStartErrorMessage
};
