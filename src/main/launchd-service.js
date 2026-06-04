const fs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderLaunchAgentPlist({
  label,
  programArguments,
  workingDirectory,
  environment,
  stdoutPath,
  stderrPath
}) {
  const envEntries = Object.entries(environment || {})
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const args = (programArguments || [])
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xmlEscape(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    args,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(workingDirectory)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envEntries,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(stderrPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n");
}

function createLaunchdService(deps = {}) {
  const {
    gatewayServiceLabel,
    daemonServiceLabel,
    runtimePaths,
    enginePython,
    effectiveHermesHome,
    buildPythonPath
  } = deps;
  if (!gatewayServiceLabel) throw new Error("gatewayServiceLabel dependency is required.");
  if (!daemonServiceLabel) throw new Error("daemonServiceLabel dependency is required.");
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof enginePython !== "function") throw new Error("enginePython dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");
  if (typeof buildPythonPath !== "function") throw new Error("buildPythonPath dependency is required.");

  const appPath = typeof deps.appPath === "function" ? deps.appPath : () => "";
  const execPath = typeof deps.execPath === "function" ? deps.execPath : () => process.execPath;
  const defaultApp = typeof deps.defaultApp === "function" ? deps.defaultApp : () => Boolean(process.defaultApp);
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const getuid = typeof deps.getuid === "function" ? deps.getuid : () => (typeof process.getuid === "function" ? process.getuid() : null);
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const appendLog = typeof deps.appendLog === "function" ? deps.appendLog : () => {};

  function launchdDomain() {
    const uid = getuid();
    if (uid === null || uid === undefined || uid === "") return "";
    return `gui/${uid}`;
  }

  function runLaunchctl(args, { ignoreFailure = false } = {}) {
    const result = spawnSync("launchctl", args, { encoding: "utf8" });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) appendLog(`launchctl ${args.join(" ")}: ${output}`);
    if (result.error) {
      if (ignoreFailure) return result;
      throw result.error;
    }
    if (result.status !== 0 && !ignoreFailure) {
      throw new Error(`launchctl ${args.join(" ")} exited with code ${result.status}`);
    }
    return result;
  }

  function gatewayEnvironment() {
    const p = runtimePaths();
    return {
      HERMES_HOME: effectiveHermesHome(),
      MIA_HOME: p.home,
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      HERMES_ACCEPT_HOOKS: "1",
      GATEWAY_ALLOW_ALL_USERS: "true",
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: buildPythonPath()
    };
  }

  function gatewayProgramArguments() {
    return [
      enginePython(),
      "-m",
      "mia_plugins",
      "gateway",
      "run",
      "--replace",
      "--accept-hooks"
    ];
  }

  function gatewayLaunchAgentPlist() {
    const p = runtimePaths();
    return renderLaunchAgentPlist({
      label: gatewayServiceLabel,
      programArguments: gatewayProgramArguments(),
      workingDirectory: p.engine,
      environment: gatewayEnvironment(),
      stdoutPath: path.join(p.logsDir, "gateway.log"),
      stderrPath: path.join(p.logsDir, "gateway.error.log")
    });
  }

  function writeGatewayLaunchAgentPlist() {
    const p = runtimePaths();
    fs.mkdirSync(path.dirname(p.launchAgent), { recursive: true });
    fs.mkdirSync(p.logsDir, { recursive: true });
    fs.writeFileSync(p.launchAgent, gatewayLaunchAgentPlist(), { mode: 0o600 });
    return p.launchAgent;
  }

  function daemonProgramArguments() {
    const args = [execPath()];
    if (defaultApp()) args.push(appPath());
    args.push("--daemon");
    return args;
  }

  function daemonEnvironment() {
    const p = runtimePaths();
    return {
      MIA_DAEMON: "1",
      MIA_USER_DATA_DIR: path.join(p.root || path.dirname(path.dirname(p.home)), "daemon-profile"),
      HERMES_HOME: effectiveHermesHome(),
      MIA_HOME: p.home,
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PATH: env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      PYTHONUNBUFFERED: "1"
    };
  }

  function daemonLaunchAgentPlist() {
    const p = runtimePaths();
    return renderLaunchAgentPlist({
      label: daemonServiceLabel,
      programArguments: daemonProgramArguments(),
      workingDirectory: appPath(),
      environment: daemonEnvironment(),
      stdoutPath: path.join(p.logsDir, "daemon.log"),
      stderrPath: path.join(p.logsDir, "daemon.error.log")
    });
  }

  function writeDaemonLaunchAgentPlist() {
    const p = runtimePaths();
    fs.mkdirSync(path.dirname(p.daemonLaunchAgent), { recursive: true });
    fs.mkdirSync(p.logsDir, { recursive: true });
    fs.writeFileSync(p.daemonLaunchAgent, daemonLaunchAgentPlist(), { mode: 0o600 });
    return p.daemonLaunchAgent;
  }

  function stopJob({ plistPath, label }) {
    if (platform !== "darwin") return;
    const domain = launchdDomain();
    if (!domain) return;
    runLaunchctl(["bootout", domain, plistPath], { ignoreFailure: true });
    runLaunchctl(["bootout", `${domain}/${label}`], { ignoreFailure: true });
  }

  function startJob({ plistPath, label, writePlist, errorMessage }) {
    const domain = launchdDomain();
    if (platform !== "darwin" || !domain) {
      throw new Error(errorMessage);
    }
    const plist = writePlist();
    stopJob({ plistPath, label });
    runLaunchctl(["bootstrap", domain, plist]);
    runLaunchctl(["kickstart", "-k", `${domain}/${label}`], { ignoreFailure: true });
  }

  function stopGateway() {
    stopJob({ plistPath: runtimePaths().launchAgent, label: gatewayServiceLabel });
  }

  function startGateway() {
    startJob({
      plistPath: runtimePaths().launchAgent,
      label: gatewayServiceLabel,
      writePlist: writeGatewayLaunchAgentPlist,
      errorMessage: "Mia background service is currently implemented for macOS launchd."
    });
  }

  function stopDaemon() {
    stopJob({ plistPath: runtimePaths().daemonLaunchAgent, label: daemonServiceLabel });
  }

  function startDaemon() {
    startJob({
      plistPath: runtimePaths().daemonLaunchAgent,
      label: daemonServiceLabel,
      writePlist: writeDaemonLaunchAgentPlist,
      errorMessage: "Mia daemon LaunchAgent is currently implemented for macOS launchd."
    });
  }

  return {
    appPath,
    daemonEnvironment,
    daemonLaunchAgentPlist,
    daemonProgramArguments,
    gatewayEnvironment,
    gatewayLaunchAgentPlist,
    gatewayProgramArguments,
    launchdDomain,
    runLaunchctl,
    startDaemon,
    startGateway,
    stopDaemon,
    stopGateway,
    writeDaemonLaunchAgentPlist,
    writeGatewayLaunchAgentPlist
  };
}

module.exports = {
  createLaunchdService,
  renderLaunchAgentPlist,
  xmlEscape
};
