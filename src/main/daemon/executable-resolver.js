"use strict";

const path = require("node:path");

const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// Packaged-build layout (see package.json `build`). In a packaged Electron app
// the standalone node Core cannot live inside app.asar (a plain `node` binary
// cannot require out of Electron's asar VFS), so the build:
//   - copies a real `node` binary into extraResources → <resources>/mia-node
//   - asarUnpack's the Core entry + its require graph → app.asar.unpacked/src/...
// These two derivations are pure (resourcesPath → absolute path) so they can be
// wired from main.js in packaged mode AND unit-tested without a real build.
const PACKAGED_NODE_BASENAME = process.platform === "win32" ? "mia-node.exe" : "mia-node";

function packagedNodePath(resourcesPath) {
  const base = String(resourcesPath || "").trim();
  if (!base) return "";
  return path.join(base, PACKAGED_NODE_BASENAME);
}

function packagedCoreEntry(resourcesPath) {
  const base = String(resourcesPath || "").trim();
  if (!base) return "";
  return path.join(base, "app.asar.unpacked", "src", "core", "mia-core.js");
}

// Resolves how the desktop launches its background daemon. This is the seam the
// Mia Core migration plugs into: today it classifies the in-tree Electron daemon
// launch (behaviour-preserving), and the launcher-integration slice will add a
// `node-core` target that points launchd/spawn at the standalone Mia Core
// process (src/core/mia-core.js) instead of the GUI app executable.
// See docs/superpowers/plans/2026-06-24-mia-core-migration.md.
function createMiaCoreResolver(deps = {}) {
  const {
    runtimePaths,
    effectiveHermesHome,
    appPath = () => "",
    execPath = () => process.execPath,
    defaultApp = () => Boolean(process.defaultApp),
    platform = process.platform,
    env = process.env,
    // Absolute path to a real `node` binary. process.execPath under Electron is
    // the GUI app executable, NOT node — so this must be injected (main.js wires
    // it from a `which node` lookup). When it cannot be resolved it returns "",
    // and resolve() falls back to the electron-dev / legacy-gui / bundled-cli path.
    nodePath = () => "",
    // Absolute path to the standalone Mia Core entry (src/core/mia-core.js).
    coreEntry = () => path.resolve(__dirname, "..", "..", "core", "mia-core.js"),
    // process.resourcesPath under a packaged Electron app
    // (…/Contents/Resources). "" in dev. Used to derive the packaged node
    // binary + the unpacked Core entry below.
    resourcesPath = () => ""
  } = deps;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");

  function resolve() {
    // Preferred target: launch the standalone node Core as the daemon. This is a
    // pure-node process with its own (non-GUI) executable identity — no Dock, no
    // LaunchServices semantics. Requires both a real node binary and the Core entry.
    //
    // In DEV the caller injects nodePath (a `which node` lookup) + the on-disk
    // Core entry. In a PACKAGED build neither is injected; we derive both from
    // process.resourcesPath: the bundled `node` (extraResources → <resources>/
    // mia-node) + the unpacked Core entry (app.asar.unpacked/src/core/mia-core.js).
    // A plain node binary CANNOT require out of app.asar, so the packaged Core MUST
    // be the unpacked copy — never the in-asar path.
    const res = String(resourcesPath() || "").trim();
    const node = String(nodePath() || "").trim() || packagedNodePath(res);
    const entry = String(coreEntry() || "").trim() || packagedCoreEntry(res);
    if (node && entry) {
      return {
        kind: "node-core",
        command: node,
        args: [entry, "--daemon"],
        workingDirectory: path.dirname(entry),
        usesGuiAppIdentity: false
      };
    }
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
      // Today's shipping behaviour: the daemon is still the GUI app executable.
      // The node-core launcher slice replaces this; the legacy-gui guard
      // (assertLaunchable) activates once that target is wired in.
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
    // Stamp the resolved target identity into the launched daemon's env so it can
    // describe its own target (control-server /health daemonTarget) WITHOUT
    // re-resolving process.resourcesPath — which is unavailable/misleading in a
    // plain-node Core process (closes NO-SHIP #2).
    const r = resolve();
    return {
      MIA_DAEMON: "1",
      MIA_USER_DATA_DIR: path.join(p.root || path.dirname(path.dirname(p.home)), "daemon-profile"),
      HERMES_HOME: effectiveHermesHome(),
      MIA_HOME: p.home,
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PYTHONUNBUFFERED: "1",
      MIA_DAEMON_TARGET_KIND: r.kind,
      MIA_DAEMON_USES_GUI_IDENTITY: r.usesGuiAppIdentity ? "1" : "0"
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

  return { resolve, daemonEnvOverlay, assertLaunchable, describe };
}

module.exports = { createMiaCoreResolver, DEFAULT_PATH, packagedNodePath, packagedCoreEntry };
