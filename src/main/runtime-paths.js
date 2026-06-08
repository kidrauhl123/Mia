// Runtime paths (main process)
// Extracted from src/main.js. Owns the layout of the on-disk runtime
// directory under MIA_HOME/app.getPath("userData") — every JSON file path,
// every runtime subdirectory, and the bundled Hermes Python runtime lookup.
//
// CommonJS factory pattern: createRuntimePaths({...deps}) returns the
// runtimePaths() function + the small bundled-runtime helpers. Engine
// installation lifecycle is owned by engine-install-service.

const path = require("node:path");

function createRuntimePaths(deps = {}) {
  const {
    app,
    MIA_GATEWAY_SERVICE_LABEL,
    MIA_DAEMON_SERVICE_LABEL,
    env = process.env,
  } = deps;

  function runtimePaths() {
    const configuredHome = String(env.MIA_HOME || "").trim();
    const home = configuredHome ? path.resolve(configuredHome) : path.join(app.getPath("userData"), "runtime", "engine-home");
    const runtime = path.dirname(home);
    const root = path.dirname(runtime);
    const engine = path.join(runtime, "hermes-engine");
    const pluginsDir = path.join(runtime, "mia-plugins");
    return {
      root,
      runtime,
      engine,
      home,
      pluginsDir,
      // Default agent working directory. A Mia-owned, non-protected location so
      // local agents (claude/codex) never default to `/` or the user's home and
      // trip macOS TCC prompts for Desktop/Documents/Downloads/Photos. Real
      // user folders are opted into explicitly via the workspace setting.
      workspace: path.join(home, "workspace"),
      // Persisted override for the agent working directory (a user-picked folder).
      workspaceSettings: path.join(home, "mia-workspace.json"),
      config: path.join(home, "config.yaml"),
      soul: path.join(home, "SOUL.md"),
      botManifest: path.join(home, "bots", "manifest.json"),
      botDir: path.join(home, "bots"),
      legacyPersonaManifest: path.join(home, "personas", "manifest.json"),
      legacyPersonaDir: path.join(home, "personas", "accounts"),
      apiKey: path.join(home, "api-server.key"),
      authJson: path.join(home, "auth.json"),
      userProfile: path.join(home, "mia-user.json"),
      modelSettings: path.join(home, "mia-model.json"),
      memory: path.join(home, "mia-memory.json"),
      providerConnections: path.join(home, "mia-providers.json"),
      permissionSettings: path.join(home, "mia-permissions.json"),
      agentPermissionRules: path.join(home, "mia-agent-permissions.json"),
      effortSettings: path.join(home, "mia-effort.json"),
      agentSessions: path.join(home, "mia-agent-sessions.json"),
      daemonSettings: path.join(home, "mia-daemon.json"),
      daemonToken: path.join(home, "mia-daemon.key"),
      cloudSettings: path.join(home, "mia-cloud.json"),
      cloudWorkspace: path.join(home, "mia-cloud-workspace.json"),
      petRemoteSettings: path.join(home, "mia-pet-remote.json"),
      appearanceSettings: path.join(home, "mia-appearance.json"),
      windowSettings: path.join(home, "mia-window.json"),
      tasks: path.join(home, "mia-tasks.json"),
      attachmentsDir: path.join(home, "attachments"),
      groupsDir: path.join(home, "groups"),
      petDir: path.join(home, "pets"),
      petJobsDir: path.join(home, "pet-jobs"),
      logsDir: path.join(home, "logs"),
      launchAgent: path.join(app.getPath("home"), "Library", "LaunchAgents", `${MIA_GATEWAY_SERVICE_LABEL}.plist`),
      daemonLaunchAgent: path.join(app.getPath("home"), "Library", "LaunchAgents", `${MIA_DAEMON_SERVICE_LABEL}.plist`)
    };
  }

  function buildPythonPath() {
    const p = runtimePaths();
    const parts = [p.pluginsDir];
    if (process.env.PYTHONPATH) parts.push(process.env.PYTHONPATH);
    // path.delimiter is ";" on Windows, ":" elsewhere — a hardcoded ":" would
    // collapse the whole PYTHONPATH into one bogus entry on Windows, so the
    // mia_plugins overlay would never import.
    return parts.join(path.delimiter);
  }

  function engineMarkerPath() {
    return path.join(runtimePaths().engine, "mia-runtime.json");
  }

  return {
    runtimePaths,
    buildPythonPath,
    engineMarkerPath,
  };
}

module.exports = { createRuntimePaths };
