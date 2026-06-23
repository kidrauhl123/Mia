"use strict";

const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");

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

  function daemonProgramArguments() {
    const args = [execPath()];
    if (defaultApp()) args.push(appPath());
    args.push("--daemon");
    return args;
  }

  function daemonEnvironment() {
    const p = runtimePaths();
    return {
      ...env,
      MIA_DAEMON: "1",
      MIA_USER_DATA_DIR: path.join(p.root || path.dirname(path.dirname(p.home)), "daemon-profile"),
      HERMES_HOME: effectiveHermesHome(),
      MIA_HOME: p.home,
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PYTHONUNBUFFERED: "1"
    };
  }

  function daemonWorkingDirectory() {
    return path.dirname(execPath());
  }

  async function start() {
    const [command, ...args] = daemonProgramArguments();
    const child = spawn(command, args, {
      cwd: daemonWorkingDirectory(),
      detached: true,
      stdio: "ignore",
      env: daemonEnvironment()
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
