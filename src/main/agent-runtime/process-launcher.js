const path = require("node:path");

function executableExt(filePath = "") {
  return path.extname(String(filePath || "")).toLowerCase();
}

function isWindowsShellShim(filePath = "", platform = process.platform) {
  if (platform !== "win32") return false;
  return [".cmd", ".bat", ".ps1"].includes(executableExt(filePath));
}

function isWindowsDirectExecutable(filePath = "", platform = process.platform) {
  if (platform !== "win32") return Boolean(filePath);
  return [".exe", ".com"].includes(executableExt(filePath));
}

function quoteCmdArg(value = "") {
  const text = String(value);
  if (!text) return "\"\"";
  return `"${text.replace(/"/g, '\\"')}"`;
}

function windowsCmdArgs(filePath, args = []) {
  return ["/d", "/s", "/c", "call", filePath, ...args];
}

function spawnSpecForExecutable(filePath, args = [], options = {}) {
  const platform = options.platform || process.platform;
  const ext = executableExt(filePath);
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    return {
      command: "cmd.exe",
      args: windowsCmdArgs(filePath, args),
      wrapper: "cmd.exe",
      wrapped: true
    };
  }
  if (platform === "win32" && ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath, ...args],
      wrapper: "powershell.exe",
      wrapped: true
    };
  }
  return {
    command: filePath,
    args: Array.isArray(args) ? args.slice() : [],
    wrapper: "",
    wrapped: false
  };
}

function spawnExecutable(spawn, filePath, args = [], options = {}, runtimeOptions = {}) {
  const spec = spawnSpecForExecutable(filePath, args, runtimeOptions);
  return spawn(spec.command, spec.args, options);
}

function spawnSyncExecutable(spawnSync, filePath, args = [], options = {}, runtimeOptions = {}) {
  const spec = spawnSpecForExecutable(filePath, args, runtimeOptions);
  return spawnSync(spec.command, spec.args, options);
}

function execFileExecutable(execFile, filePath, args = [], options = {}, callback = () => {}, runtimeOptions = {}) {
  const spec = spawnSpecForExecutable(filePath, args, runtimeOptions);
  return execFile(spec.command, spec.args, options, callback);
}

function envWithExecutableDirFirst(env = {}, executablePath = "", options = {}) {
  const dir = path.dirname(String(executablePath || ""));
  if (!dir || dir === ".") return env || {};
  const delimiter = options.platform === "win32" ? ";" : path.delimiter;
  const currentPath = String(env?.PATH || env?.Path || "");
  const parts = currentPath.split(delimiter).filter(Boolean).filter((item) => item !== dir);
  return {
    ...(env || {}),
    PATH: [dir, ...parts].join(delimiter)
  };
}

module.exports = {
  envWithExecutableDirFirst,
  execFileExecutable,
  isWindowsDirectExecutable,
  isWindowsShellShim,
  quoteCmdArg,
  spawnExecutable,
  spawnSpecForExecutable,
  spawnSyncExecutable,
  windowsCmdArgs
};
