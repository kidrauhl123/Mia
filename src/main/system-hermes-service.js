const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const SYSTEM_CLI_PATH_SEGMENTS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

function commandNameOnly(command) {
  const value = String(command || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return "";
  return value;
}

function shebangWords(line) {
  const body = String(line || "").replace(/^#!/, "").trim();
  const matches = body.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function isPythonToken(value) {
  const base = path.basename(String(value || ""));
  return /^python(?:\d+(?:\.\d+)*)?$/.test(base);
}

function readShebangPython(filePath, fsImpl = fs) {
  if (!filePath) return "";
  let firstLine = "";
  try {
    firstLine = String(fsImpl.readFileSync(filePath, "utf8")).split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
  if (!firstLine.startsWith("#!")) return "";
  const words = shebangWords(firstLine);
  if (!words.length) return "";
  const first = words[0];
  if (isPythonToken(first)) return first;
  if (path.basename(first) !== "env") return "";
  const rest = words.slice(1);
  const start = rest[0] === "-S" ? 1 : 0;
  for (let i = start; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("-")) continue;
    if (isPythonToken(token)) return token;
    break;
  }
  return "";
}

function createSystemHermesService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const envSource = deps.env || process.env;
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
  const platform = deps.platform || process.platform;
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const readJson = deps.readJson || ((filePath, fallback) => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  });
  const now = typeof deps.now === "function" ? deps.now : () => new Date();
  const resetAgentEngineCache = typeof deps.resetAgentEngineCache === "function"
    ? deps.resetAgentEngineCache
    : () => {};

  function currentEnv() {
    return typeof envSource === "function" ? (envSource() || {}) : envSource;
  }

  function cachePath() {
    return path.join(runtimePaths().home, "mia-system-hermes.json");
  }

  function loadCache() {
    const cached = readJson(cachePath(), null);
    if (!cached || typeof cached !== "object") {
      return { available: false, pending: true };
    }
    return cached;
  }

  function persistCache(value) {
    const filePath = cachePath();
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    if (typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(filePath, 0o600);
  }

  function cliPathSegments() {
    const home = String(homeDir() || "").trim();
    const userSegments = home ? [
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".deno", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "Library", "pnpm")
    ] : [];
    return [...userSegments, ...SYSTEM_CLI_PATH_SEGMENTS];
  }

  function cliPathEnv() {
    const current = String(currentEnv().PATH || "");
    const segments = [
      ...cliPathSegments(),
      ...current.split(path.delimiter)
    ].filter(Boolean);
    return [...new Set(segments)].join(path.delimiter);
  }

  function processEnvWithCliPath() {
    return {
      ...currentEnv(),
      PATH: cliPathEnv()
    };
  }

  function executablePath(filePath) {
    try {
      fsImpl.accessSync(filePath, fs.constants.X_OK);
      return filePath;
    } catch {
      return "";
    }
  }

  function windowsCommandPath(name) {
    const result = spawnSync("where", [name], {
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    });
    if (!result.error && result.status === 0) {
      return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
    }
    return "";
  }

  function shellCommandPath(command) {
    const name = commandNameOnly(command);
    if (!name) return "";
    if (platform === "win32") return windowsCommandPath(name);
    const result = spawnSync("zsh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      timeout: 1500,
      env: processEnvWithCliPath()
    });
    if (!result.error && result.status === 0) {
      const found = String(result.stdout || "").split(/\r?\n/)[0]?.trim() || "";
      if (found) return found;
    }
    for (const dir of cliPathSegments()) {
      const found = executablePath(path.join(dir, name));
      if (found) return found;
    }
    return "";
  }

  function commandVersion(commandPath) {
    if (!commandPath) return "";
    const result = spawnSync(commandPath, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      env: processEnvWithCliPath()
    });
    if (result.error) return "";
    return String(result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() || "";
  }

  function probe() {
    const commandPath = shellCommandPath("hermes");
    const pythonPath = readShebangPython(commandPath, fsImpl);
    return {
      available: Boolean(commandPath && pythonPath),
      pending: false,
      source: "system",
      commandPath,
      pythonPath,
      version: commandVersion(commandPath),
      usesMiaHome: true,
      checkedAt: now().toISOString()
    };
  }

  async function refresh() {
    persistCache(probe());
    resetAgentEngineCache();
  }

  function currentStatus() {
    const cached = loadCache();
    if (cached.available && cached.pythonPath) return cached;
    return probe();
  }

  function commandPath() {
    const status = currentStatus();
    return status.available ? String(status.commandPath || "") : "";
  }

  function pythonPath() {
    const status = currentStatus();
    return status.available ? String(status.pythonPath || "") : "";
  }

  function userHomePath() {
    return "";
  }

  function loadDotenv() {
    return {};
  }

  return {
    cachePath,
    commandPath,
    loadCache,
    loadDotenv,
    persistCache,
    probe,
    pythonPath,
    refresh,
    shellCommandPath,
    userHomePath
  };
}

module.exports = {
  commandNameOnly,
  createSystemHermesService,
  readShebangPython,
  shebangWords
};
