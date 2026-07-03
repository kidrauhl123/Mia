const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile: defaultExecFile } = require("node:child_process");
const { createMiaCoreResolver, DEFAULT_PATH } = require("./daemon/executable-resolver.js");

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

function uniquePathEntries(entries = []) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const value = String(entry || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function daemonPathEnv(env = {}, options = {}) {
  const delimiter = options.delimiter || path.delimiter;
  const home = String(env.HOME || options.home || os.homedir() || "").trim();
  const userEntries = home
    ? [
        path.join(home, ".local", "bin"),
        path.join(home, ".bun", "bin"),
        path.join(home, ".cargo", "bin")
      ]
    : [];
  return uniquePathEntries([
    ...userEntries,
    ...DEFAULT_PATH.split(":"),
    ...String(env.PATH || "").split(delimiter)
  ]).join(delimiter);
}

function createLaunchdService(deps = {}) {
  const {
    gatewayServiceLabel,
    daemonServiceLabel,
    runtimePaths,
    enginePython,
    effectiveHermesHome
  } = deps;
  if (!gatewayServiceLabel) throw new Error("gatewayServiceLabel dependency is required.");
  if (!daemonServiceLabel) throw new Error("daemonServiceLabel dependency is required.");
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof enginePython !== "function") throw new Error("enginePython dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");

  const appPath = typeof deps.appPath === "function" ? deps.appPath : () => "";
  const execPath = typeof deps.execPath === "function" ? deps.execPath : () => process.execPath;
  const defaultApp = typeof deps.defaultApp === "function" ? deps.defaultApp : () => Boolean(process.defaultApp);
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const getuid = typeof deps.getuid === "function" ? deps.getuid : () => (typeof process.getuid === "function" ? process.getuid() : null);
  const execFile = deps.execFile || defaultExecFile;
  const appendLog = typeof deps.appendLog === "function" ? deps.appendLog : () => {};

  const resolver = deps.resolver || createMiaCoreResolver({
    runtimePaths,
    effectiveHermesHome,
    appPath,
    execPath,
    defaultApp,
    platform,
    env
  });

  function launchdDomain() {
    const uid = getuid();
    if (uid === null || uid === undefined || uid === "") return "";
    return `gui/${uid}`;
  }

  // Async on purpose: these run in the Electron main process, and a synchronous
  // launchctl call freezes the whole UI (beachball) for however long launchd
  // takes — seconds when a job is mid start/stop.
  function runLaunchctl(args, { ignoreFailure = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile("launchctl", args, { encoding: "utf8" }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (output) appendLog(`launchctl ${args.join(" ")}: ${output}`);
        if (error && !ignoreFailure) {
          reject(new Error(`launchctl ${args.join(" ")} failed: ${error.message}`));
          return;
        }
        resolve({ stdout, stderr, error: error || null });
      });
    });
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

  function daemonProgramArguments() {
    const r = resolver.resolve();
    return [r.command, ...r.args];
  }

  function daemonEnvironment() {
    return { ...resolver.daemonEnvOverlay(), PATH: daemonPathEnv(env) };
  }

  // launchd chdir()s into WorkingDirectory before exec; the resolver always
  // returns a real directory (never the asar archive) in both dev and packaged
  // builds, so anchoring there avoids EX_CONFIG (exit 78).
  function daemonWorkingDirectory() {
    return resolver.resolve().workingDirectory;
  }

  function daemonLaunchAgentPlist() {
    const p = runtimePaths();
    return renderLaunchAgentPlist({
      label: daemonServiceLabel,
      programArguments: daemonProgramArguments(),
      workingDirectory: daemonWorkingDirectory(),
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

  async function stopJob({ plistPath, label }) {
    if (platform !== "darwin") return;
    const domain = launchdDomain();
    if (!domain) return;
    await runLaunchctl(["bootout", domain, plistPath], { ignoreFailure: true });
    await runLaunchctl(["bootout", `${domain}/${label}`], { ignoreFailure: true });
  }

  async function startJob({ plistPath, label, writePlist, errorMessage }) {
    const domain = launchdDomain();
    if (platform !== "darwin" || !domain) {
      throw new Error(errorMessage);
    }
    const plist = writePlist();
    await stopJob({ plistPath, label });
    await runLaunchctl(["enable", `${domain}/${label}`]);
    await runLaunchctl(["bootstrap", domain, plist]);
    await runLaunchctl(["kickstart", "-k", `${domain}/${label}`], { ignoreFailure: true });
  }

  function stopGateway() {
    return stopJob({ plistPath: runtimePaths().launchAgent, label: gatewayServiceLabel });
  }

  function stopDaemon() {
    return stopJob({ plistPath: runtimePaths().daemonLaunchAgent, label: daemonServiceLabel });
  }

  function startDaemon() {
    return startJob({
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
    gatewayProgramArguments,
    launchdDomain,
    runLaunchctl,
    startDaemon,
    stopDaemon,
    stopGateway,
    writeDaemonLaunchAgentPlist
  };
}

module.exports = {
  createLaunchdService,
  daemonPathEnv,
  renderLaunchAgentPlist,
  xmlEscape
};
