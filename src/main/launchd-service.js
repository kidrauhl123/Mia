const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile: defaultExecFile } = require("node:child_process");
const { createMiaCoreResolver, DEFAULT_PATH } = require("./mia-core/process-resolver.js");

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

function corePathEnv(env = {}, options = {}) {
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
    coreServiceLabel,
    runtimePaths,
    enginePython,
    effectiveHermesHome
  } = deps;
  const serviceLabel = coreServiceLabel;
  if (!gatewayServiceLabel) throw new Error("gatewayServiceLabel dependency is required.");
  if (!serviceLabel) throw new Error("coreServiceLabel dependency is required.");
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof enginePython !== "function") throw new Error("enginePython dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");

  const appPath = typeof deps.appPath === "function" ? deps.appPath : () => "";
  const execPath = typeof deps.execPath === "function" ? deps.execPath : () => process.execPath;
  const defaultApp = typeof deps.defaultApp === "function" ? deps.defaultApp : () => Boolean(process.defaultApp);
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const coreSettings = typeof deps.coreSettings === "function" ? deps.coreSettings : () => ({});
  const appVersion = typeof deps.appVersion === "function" ? deps.appVersion : () => "";
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
    env,
    coreSettings,
    appVersion,
    parentPid: () => 0
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

  function runExecFile(command, args, { ignoreFailure = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (output && command !== "ps") appendLog(`${command} ${args.join(" ")}: ${output}`);
        if (error && !ignoreFailure) {
          reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}`));
          return;
        }
        resolve({ stdout, stderr, error: error || null });
      });
    });
  }

  function legacyNodeCoreLaunchAgent(plistPath) {
    try {
      const source = fs.readFileSync(plistPath, "utf8");
      return /MIA_DAEMON|MIA_DAEMON_TARGET_KIND|node-core|src\/core\/mia-core\.js/.test(source);
    } catch {
      return false;
    }
  }

  function legacyNodeCoreCommand(command) {
    const value = String(command || "").trim();
    if (!value) return false;
    const executable = value.split(/\s+/)[0] || "";
    return path.basename(executable) === "node"
      && value.includes("src/core/mia-core.js")
      && /(?:^|\s)--daemon(?:\s|$)/.test(value);
  }

  function parseProcessList(stdout) {
    return String(stdout || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = String(line || "").match(/^\s*(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter((entry) => entry && Number.isInteger(entry.pid) && entry.pid > 0);
  }

  async function killLegacyNodeCoreProcesses() {
    const result = await runExecFile("ps", ["-axo", "pid=,command="], { ignoreFailure: true });
    const killedPids = [];
    for (const entry of parseProcessList(result.stdout)) {
      if (entry.pid === process.pid) continue;
      if (!legacyNodeCoreCommand(entry.command)) continue;
      await runExecFile("kill", ["-TERM", String(entry.pid)], { ignoreFailure: true });
      killedPids.push(entry.pid);
    }
    return killedPids;
  }

  async function cleanupLegacyNodeCore() {
    const summary = { removedLaunchAgent: false, killedPids: [] };
    if (platform !== "darwin") return { ...summary, skipped: true };
    const p = runtimePaths();
    const plistPath = p.coreLaunchAgent || p.daemonLaunchAgent;
    const domain = launchdDomain();
    if (domain && legacyNodeCoreLaunchAgent(plistPath)) {
      appendLog(`Removing legacy Node Core LaunchAgent at ${plistPath}.`);
      await stopJob({ plistPath, label: serviceLabel });
      await runLaunchctl(["remove", serviceLabel], { ignoreFailure: true });
      try {
        fs.rmSync(plistPath, { force: true });
        summary.removedLaunchAgent = true;
      } catch (error) {
        appendLog(`Failed to remove legacy Node Core LaunchAgent ${plistPath}: ${error?.message || error}`);
      }
    }
    summary.killedPids = await killLegacyNodeCoreProcesses();
    if (summary.killedPids.length) {
      appendLog(`Stopped legacy Node Core process(es): ${summary.killedPids.join(", ")}.`);
    }
    return summary;
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

  function coreProgramArguments() {
    const r = resolver.resolve();
    return [r.command, ...r.args];
  }

  function coreEnvironment() {
    return { ...resolver.coreEnvOverlay(), PATH: corePathEnv(env) };
  }

  // launchd chdir()s into WorkingDirectory before exec; the resolver always
  // returns a real directory (never the asar archive) in both dev and packaged
  // builds, so anchoring there avoids EX_CONFIG (exit 78).
  function coreWorkingDirectory() {
    return resolver.resolve().workingDirectory;
  }

  function coreLaunchAgentPlist() {
    const p = runtimePaths();
    return renderLaunchAgentPlist({
      label: serviceLabel,
      programArguments: coreProgramArguments(),
      workingDirectory: coreWorkingDirectory(),
      environment: coreEnvironment(),
      stdoutPath: path.join(p.logsDir, "daemon.log"),
      stderrPath: path.join(p.logsDir, "daemon.error.log")
    });
  }

  function writeCoreLaunchAgentPlist() {
    const p = runtimePaths();
    const plistPath = p.coreLaunchAgent || p.daemonLaunchAgent;
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(p.logsDir, { recursive: true });
    fs.writeFileSync(plistPath, coreLaunchAgentPlist(), { mode: 0o600 });
    return plistPath;
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

  function stopCore() {
    const p = runtimePaths();
    return stopJob({ plistPath: p.coreLaunchAgent || p.daemonLaunchAgent, label: serviceLabel });
  }

  function startCore() {
    const p = runtimePaths();
    return startJob({
      plistPath: p.coreLaunchAgent || p.daemonLaunchAgent,
      label: serviceLabel,
      writePlist: writeCoreLaunchAgentPlist,
      errorMessage: "Mia Core LaunchAgent is currently implemented for macOS launchd."
    });
  }

  return {
    appPath,
    coreEnvironment,
    coreLaunchAgentPlist,
    coreProgramArguments,
    cleanupLegacyNodeCore,
    gatewayProgramArguments,
    launchdDomain,
    runLaunchctl,
    startCore,
    stopCore,
    stopGateway,
    writeCoreLaunchAgentPlist
  };
}

module.exports = {
  createLaunchdService,
  corePathEnv,
  renderLaunchAgentPlist,
  xmlEscape
};
