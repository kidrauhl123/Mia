"use strict";

const path = require("node:path");
const { existsSync: defaultExistsSync } = require("node:fs");

const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function createMiaCoreResolver(deps = {}) {
  const {
    runtimePaths,
    effectiveHermesHome,
    appPath = () => "",
    execPath = () => process.execPath,
    defaultApp = () => Boolean(process.defaultApp),
    platform = process.platform,
    env = process.env,
    resourcesPath = () => process.resourcesPath || "",
    existsSync = defaultExistsSync
  } = deps;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");

  function helperExecutablePath() {
    return path.join(resourcesPath(), "Mia Core.app", "Contents", "MacOS", "Mia Core");
  }

  function resolve() {
    if (defaultApp()) {
      const command = execPath();
      return {
        kind: "electron-dev",
        command,
        args: [appPath(), "--daemon"],
        workingDirectory: path.dirname(command),
        usesGuiAppIdentity: false
      };
    }
    if (platform === "darwin") {
      const helper = helperExecutablePath();
      if (existsSync(helper)) {
        return {
          kind: "packaged-helper",
          command: helper,
          args: ["--daemon"],
          workingDirectory: path.dirname(helper),
          usesGuiAppIdentity: false
        };
      }
      const command = execPath();
      return {
        kind: "legacy-gui",
        command,
        args: ["--daemon"],
        workingDirectory: path.dirname(command),
        usesGuiAppIdentity: true
      };
    }
    const command = execPath();
    return {
      kind: "bundled-cli",
      command,
      args: ["--daemon"],
      workingDirectory: path.dirname(command),
      usesGuiAppIdentity: false
    };
  }

  function daemonEnvOverlay() {
    const p = runtimePaths();
    return {
      MIA_DAEMON: "1",
      MIA_USER_DATA_DIR: path.join(p.root || path.dirname(path.dirname(p.home)), "daemon-profile"),
      HERMES_HOME: effectiveHermesHome(),
      MIA_HOME: p.home,
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PYTHONUNBUFFERED: "1"
    };
  }

  function assertLaunchable() {
    const r = resolve();
    if (r.kind === "legacy-gui") {
      throw new Error(
        "Mia Core daemon executable not found in this packaged build; refusing to start the daemon under the GUI app identity. Reinstall Mia."
      );
    }
    return r;
  }

  function describe() {
    const r = resolve();
    return {
      kind: r.kind,
      command: path.basename(r.command),
      usesGuiAppIdentity: r.usesGuiAppIdentity,
      workingDirectory: r.workingDirectory
    };
  }

  return { resolve, daemonEnvOverlay, assertLaunchable, describe, helperExecutablePath };
}

module.exports = { createMiaCoreResolver, DEFAULT_PATH };
