"use strict";

const path = require("node:path");
const fs = require("node:fs");

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

// Resolves how the desktop launches its background daemon. After migration slice
// 5c the daemon is ALWAYS the standalone node Core (src/core/mia-core.js) running
// under its own non-GUI executable identity — never the Electron GUI app. The
// obsolete `legacy-gui` (Electron-as-daemon under the GUI app identity) and
// `electron-dev` targets were deleted here: they were the source of the original
// Dock/LaunchServices/auto-update instability. On a packaged build a node-core
// target MUST resolve (bundled mia-node + unpacked Core entry); if it cannot,
// assertLaunchable() fails closed rather than falling back to GUI identity.
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
    // and resolve() falls back to packaged-node derivation / bundled-cli.
    nodePath = () => "",
    // Absolute path to the standalone Mia Core entry (src/core/mia-core.js).
    coreEntry = () => path.resolve(__dirname, "..", "..", "core", "mia-core.js"),
    // process.resourcesPath under a packaged Electron app
    // (…/Contents/Resources). "" in dev. Used to derive the packaged node
    // binary + the unpacked Core entry below.
    resourcesPath = () => "",
    // Existence check for the PACKAGED-DERIVED node/core paths only. A packaged
    // build that ships a broken/incomplete bundle would otherwise resolve a
    // node-core target whose command/entry don't exist on disk → the launched
    // process never answers /health and the daemon TIMES OUT instead of failing
    // fast. Guarding the derived paths makes a missing bundle fall through to
    // `unresolved`, so assertLaunchable() throws a clear error. Injectable for
    // tests; the injected dev/test node+coreEntry paths are trusted as-is (the
    // caller already resolved them via `which node` / the on-disk Core entry).
    existsSync = (p) => fs.existsSync(p)
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
    // Injected paths (dev / tests) are trusted as-is; the DERIVED packaged paths
    // are existence-checked so a broken bundle fails fast as `unresolved` rather
    // than launching a non-existent command that just times out on /health.
    const injectedNode = String(nodePath() || "").trim();
    const injectedEntry = String(coreEntry() || "").trim();
    const derivedNode = packagedNodePath(res);
    const derivedEntry = packagedCoreEntry(res);
    const node = injectedNode || (derivedNode && existsSync(derivedNode) ? derivedNode : "");
    const entry = injectedEntry || (derivedEntry && existsSync(derivedEntry) ? derivedEntry : "");
    if (node && entry) {
      return {
        kind: "node-core",
        command: node,
        args: [entry, "--daemon"],
        workingDirectory: path.dirname(entry),
        usesGuiAppIdentity: false
      };
    }
    // No node-core target resolved. On macOS (dev or packaged) this is fail-closed
    // territory: the `legacy-gui` GUI-identity daemon was deleted in slice 5c, so
    // assertLaunchable() throws on this kind rather than launching the GUI app as
    // the daemon. In dev a real `node` is always on PATH so node-core wins above;
    // this branch is only reached on a degenerate packaged build (no bundled
    // mia-node / unpacked Core) — exactly the case we want to refuse.
    if (platform === "darwin") {
      const command = execPath();
      return {
        kind: "unresolved",
        command,
        args: ["--daemon"],
        workingDirectory: path.dirname(command),
        usesGuiAppIdentity: false
      };
    }
    // Non-darwin: no launchd. The detached process launcher spawns this command.
    // process.execPath here is the node/Electron host running this code, not a
    // GUI app identity with Dock/LaunchServices semantics.
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
    // Fail closed: a packaged build that cannot resolve the bundled node Core
    // (mia-node + unpacked mia-core.js) must NOT fall back to launching the GUI
    // app as the daemon — that GUI-identity daemon was the source of the original
    // Dock/LaunchServices/auto-update instability and is gone. node-core /
    // bundled-cli (non-darwin) pass.
    if (r.kind === "unresolved") {
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
