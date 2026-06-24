"use strict";

// Mia Core — standalone Node.js backend process (vertical slice #1).
//
// This is the real Mia Core direction (not the abandoned Electron-helper
// wrapper): a pure-node process with its own executable identity — no window,
// no Dock, no LaunchServices GUI semantics — that owns the runtime home and
// serves the local daemon control API (health/status/control HTTP + SSE).
//
// Slice #1 scope: control server + runtime-paths/settings/daemon-token
// ownership, reusing the SAME pure-node factories the Electron daemon uses
// (no second write path to single-owner data). Cloud sockets, scheduler, and
// bot execution are later vertical slices — see
// docs/superpowers/plans/2026-06-24-mia-core-migration.md. They are wired as
// inert stubs here so the control surface boots and is verifiable today.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createRuntimePaths } = require("../main/runtime-paths.js");
const { createSettingsStore } = require("../main/settings-store.js");
const { createDaemonControlServer } = require("../main/daemon/control-server.js");

const MIA_GATEWAY_SERVICE_LABEL = "ai.mia.hermes.gateway";
const MIA_DAEMON_SERVICE_LABEL = "ai.mia.daemon";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function createMiaCore(options = {}) {
  const env = options.env || process.env;
  const version = String(options.version || "");
  const defaultPort = Number(env.MIA_DAEMON_PORT || 27861);
  const cloudUrl = env.MIA_CLOUD_URL || "https://mia.gifgif.cn";

  // runtime-paths only needs app.getPath("userData"|"home"); MIA_HOME bypasses
  // userData entirely. A node process supplies these from the OS + env, with no
  // Electron dependency.
  const appShim = {
    getPath(key) {
      if (key === "userData") {
        return env.MIA_USER_DATA_DIR ? path.resolve(env.MIA_USER_DATA_DIR) : path.join(os.homedir(), ".mia");
      }
      return os.homedir();
    }
  };

  const { runtimePaths } = createRuntimePaths({
    app: appShim,
    MIA_GATEWAY_SERVICE_LABEL,
    MIA_DAEMON_SERVICE_LABEL,
    env
  });

  // Daemon settings/host/port persistence reuses the real settings-store. The
  // engine/effort write deps it also accepts are never reached by the daemon
  // settings methods (verified: settings-store.js:312,356 are engine paths),
  // so inert values here keep single-owner persistence correct.
  const settingsStore = createSettingsStore({
    runtimePaths,
    readJson,
    writeRuntimeConfig: () => {},
    readConfiguredPort: () => defaultPort,
    getEngineState: () => ({}),
    MIA_DAEMON_DEFAULT_PORT: defaultPort,
    MIA_CLOUD_DEFAULT_URL: cloudUrl
  });

  let cachedToken = "";
  function daemonToken() {
    if (cachedToken) return cachedToken;
    const tokenPath = runtimePaths().daemonToken;
    const existing = readJsonToken(tokenPath);
    if (existing) {
      cachedToken = existing;
      return cachedToken;
    }
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    cachedToken = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, cachedToken + "\n", { mode: 0o600 });
    return cachedToken;
  }

  function readJsonToken(tokenPath) {
    try {
      return String(fs.readFileSync(tokenPath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  function describeDaemonTarget() {
    return {
      kind: "node-core",
      command: path.basename(process.execPath),
      usesGuiAppIdentity: false,
      workingDirectory: process.cwd()
    };
  }

  const controlServer = createDaemonControlServer({
    isDaemonProcess: true,
    serviceLabel: MIA_DAEMON_SERVICE_LABEL,
    daemonToken,
    appVersion: () => version,
    describeDaemonTarget,
    runtimePaths,
    getDaemonSettings: () => settingsStore.daemonSettings(),
    writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
    normalizeDaemonHost: settingsStore.normalizeDaemonHost,
    normalizeDaemonPort: settingsStore.normalizeDaemonPort,
    choosePort: async (preferred) => preferred,
    // Inert until later vertical slices migrate these capabilities into Core.
    initializeRuntime: () => {},
    initSchedulerSubsystem: () => {},
    remoteRouter: () => ({ matches: () => false, route: async () => ({ handled: false }) }),
    tasksRoutes: () => ({ handle: async () => false, handleEventsStream: () => {} })
  });

  function start() {
    return controlServer.start(settingsStore.daemonSettings());
  }

  return {
    start,
    stop: () => controlServer.stop(),
    status: () => controlServer.status(),
    daemonSettings: () => settingsStore.daemonSettings(),
    writeDaemonSettings: (settings) => settingsStore.writeDaemonSettings(settings),
    runtimePaths,
    daemonToken,
    describeDaemonTarget
  };
}

module.exports = { createMiaCore };

if (require.main === module) {
  const core = createMiaCore({ version: require("../../package.json").version });
  core.start().then((status) => {
    process.stdout.write(`mia-core listening at ${status.baseUrl} (home ${core.runtimePaths().home})\n`);
  }).catch((error) => {
    process.stderr.write(`mia-core failed to start: ${error && error.message}\n`);
    process.exit(1);
  });
}
