"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const { createMiaCoreResolver } = require("./executable-resolver.js");

function createDaemonProcessLauncher(deps = {}) {
  const {
    runtimePaths,
    effectiveHermesHome,
    appPath,
    execPath = () => process.execPath,
    defaultApp = () => Boolean(process.defaultApp),
    env = process.env,
    spawn = defaultSpawn,
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
    env
  });

  function daemonProgramArguments() {
    const r = resolver.resolve();
    return [r.command, ...r.args];
  }

  function daemonEnvironment() {
    return { ...env, ...resolver.daemonEnvOverlay() };
  }

  function daemonWorkingDirectory() {
    return resolver.resolve().workingDirectory;
  }

  async function start() {
    const [command, ...args] = daemonProgramArguments();
    const child = spawn(command, args, {
      cwd: daemonWorkingDirectory(),
      detached: true,
      stdio: "ignore",
      env: daemonEnvironment(),
      ...(process.platform === "win32" ? { windowsHide: true } : {})
    });
    if (typeof child.unref === "function") child.unref();
    appendLog(`Started Mia daemon process pid ${child.pid || "(unknown)"}.`);
    return { pid: child.pid || 0 };
  }

  return {
    daemonEnvironment,
    daemonProgramArguments,
    daemonWorkingDirectory,
    start
  };
}

module.exports = {
  createDaemonProcessLauncher
};
