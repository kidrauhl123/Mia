// Runtime paths (main process)
// Extracted from src/main.js. Owns the layout of the on-disk runtime
// directory under app.getPath("userData") — every JSON file path, every
// runtime subdirectory, and the bundled Hermes Python runtime lookup.
//
// CommonJS factory pattern: createRuntimePaths({...deps}) returns the
// runtimePaths() function + the small bundled-runtime helpers. Engine
// installation lifecycle is owned by engine-install-service.

const path = require("node:path");

function createRuntimePaths(deps = {}) {
  const {
    app,
    runtimeResources,
    AIMASHI_GATEWAY_SERVICE_LABEL,
    AIMASHI_DAEMON_SERVICE_LABEL,
  } = deps;

  function runtimePaths() {
    const root = app.getPath("userData");
    const runtime = path.join(root, "runtime");
    const engine = path.join(runtime, "hermes-engine");
    const home = path.join(runtime, "engine-home");
    const pluginsDir = path.join(runtime, "aimashi-plugins");
    return {
      root,
      runtime,
      engine,
      home,
      pluginsDir,
      config: path.join(home, "config.yaml"),
      soul: path.join(home, "SOUL.md"),
      fellowManifest: path.join(home, "fellows", "manifest.json"),
      fellowDir: path.join(home, "fellows"),
      legacyPersonaManifest: path.join(home, "personas", "manifest.json"),
      legacyPersonaDir: path.join(home, "personas", "accounts"),
      personaManifest: path.join(home, "fellows", "manifest.json"),
      personaDir: path.join(home, "fellows"),
      apiKey: path.join(home, "api-server.key"),
      authJson: path.join(home, "auth.json"),
      userProfile: path.join(home, "aimashi-user.json"),
      modelSettings: path.join(home, "aimashi-model.json"),
      providerConnections: path.join(home, "aimashi-providers.json"),
      permissionSettings: path.join(home, "aimashi-permissions.json"),
      effortSettings: path.join(home, "aimashi-effort.json"),
      agentSessions: path.join(home, "aimashi-agent-sessions.json"),
      daemonSettings: path.join(home, "aimashi-daemon.json"),
      daemonToken: path.join(home, "aimashi-daemon.key"),
      relaySettings: path.join(home, "aimashi-relay.json"),
      cloudSettings: path.join(home, "aimashi-cloud.json"),
      cloudWorkspace: path.join(home, "aimashi-cloud-workspace.json"),
      petRemoteSettings: path.join(home, "aimashi-pet-remote.json"),
      appearanceSettings: path.join(home, "aimashi-appearance.json"),
      chatSessions: path.join(home, "aimashi-sessions.json"),
      tasks: path.join(home, "aimashi-tasks.json"),
      attachmentsDir: path.join(home, "attachments"),
      groupsDir: path.join(home, "groups"),
      petDir: path.join(home, "pets"),
      petJobsDir: path.join(home, "pet-jobs"),
      logsDir: path.join(home, "logs"),
      launchAgent: path.join(app.getPath("home"), "Library", "LaunchAgents", `${AIMASHI_GATEWAY_SERVICE_LABEL}.plist`),
      daemonLaunchAgent: path.join(app.getPath("home"), "Library", "LaunchAgents", `${AIMASHI_DAEMON_SERVICE_LABEL}.plist`)
    };
  }

  function venvPythonPath() {
    return path.join(runtimePaths().engine, ".venv", "bin", "python");
  }

  // Bundled runtime: vendor/hermes-runtime/<target>/ → app.asar.unpacked/resources/hermes-runtime
  function bundledHermesRuntimeDir() {
    return runtimeResources.bundledHermesRuntimeDir({
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      cwd: process.cwd(),
      platform: process.platform,
      arch: process.arch
    });
  }

  function bundledPython() {
    const root = bundledHermesRuntimeDir();
    return runtimeResources.bundledPython(root, { platform: process.platform });
  }

  function bundledSitePackages() {
    const root = bundledHermesRuntimeDir();
    return runtimeResources.bundledSitePackages(root);
  }

  function buildPythonPath() {
    const p = runtimePaths();
    const parts = [p.pluginsDir];
    const sitePackages = bundledSitePackages();
    if (sitePackages) parts.push(sitePackages);
    if (process.env.PYTHONPATH) parts.push(process.env.PYTHONPATH);
    return parts.join(":");
  }

  function engineMarkerPath() {
    return path.join(runtimePaths().engine, "aimashi-runtime.json");
  }

  return {
    runtimePaths,
    venvPythonPath,
    bundledHermesRuntimeDir,
    bundledPython,
    bundledSitePackages,
    buildPythonPath,
    engineMarkerPath,
  };
}

module.exports = { createRuntimePaths };
