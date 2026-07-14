const fs = require("node:fs");
const path = require("node:path");
const {
  envWithExecutableDirFirst,
  spawnSyncExecutable
} = require("./process-launcher.js");

const ENGINE_TOOL_IDS = Object.freeze({
  hermes: ["hermes", "hermes-agent"],
  "claude-code": ["claude-agent-acp", "claude-code", "claude-acp", "claude"],
  codex: ["codex-acp", "codex"]
});

const MANAGED_RESOURCE_GROUPS = Object.freeze(["agents", "acp", "cli"]);

function runtimeKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function normalizeEngineId(value = "") {
  const id = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (id === "claude") return "claude-code";
  if (id === "openai-codex") return "codex";
  return id;
}

function pathSegments(value = "", delimiter = path.delimiter) {
  return String(value || "").split(delimiter).map((item) => item.trim()).filter(Boolean);
}

function defaultResourceRoots(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const roots = [
    ...pathSegments(env.MIA_LOCAL_MANAGED_AGENT_RESOURCES, platform === "win32" ? ";" : path.delimiter),
    ...pathSegments(env.MIA_MANAGED_AGENT_RESOURCES, platform === "win32" ? ";" : path.delimiter)
  ];
  const coreHome = String(env.MIA_CORE_HOME || env.MIA_HOME || "").trim();
  if (coreHome) roots.push(path.join(coreHome, "managed-resources"));
  const userHome = String(env.HOME || env.USERPROFILE || "").trim();
  if (userHome) roots.push(path.join(userHome, ".mia", "managed-resources"));
  const resourcesPath = String(options.resourcesPath || process.resourcesPath || "").trim();
  if (resourcesPath) {
    roots.push(path.join(resourcesPath, "managed-resources"));
    roots.push(path.join(resourcesPath, "bundled-mia-core", runtimeKey(platform, arch), "managed-resources"));
  }
  const projectRoot = String(options.projectRoot || path.join(__dirname, "..", "..", "..")).trim();
  if (projectRoot) roots.push(path.join(projectRoot, "resources", "managed-resources"));
  return [...new Set(roots.filter(Boolean))];
}

function safeReadDir(fsImpl, dir) {
  try {
    return fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadJson(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { error };
  }
}

function existsFile(fsImpl, filePath) {
  try {
    fsImpl.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isChildPath(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function versionDirs(fsImpl, root) {
  return safeReadDir(fsImpl, root)
    .filter((entry) => entry.isDirectory && entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function manifestLocations(fsImpl, root, engine, toolId, key) {
  const locations = [];
  const engineRoot = path.join(root, "agents", engine);
  for (const version of versionDirs(fsImpl, engineRoot)) {
    locations.push({
      group: "agents",
      toolId: engine,
      version,
      manifestPath: path.join(engineRoot, version, key, "manifest.json")
    });
  }
  for (const group of MANAGED_RESOURCE_GROUPS.filter((item) => item !== "agents")) {
    const toolRoot = path.join(root, group, toolId);
    for (const version of versionDirs(fsImpl, toolRoot)) {
      locations.push({
        group,
        toolId,
        version,
        manifestPath: path.join(toolRoot, version, key, "manifest.json")
      });
    }
  }
  const flatRoot = path.join(root, toolId);
  for (const version of versionDirs(fsImpl, flatRoot)) {
    locations.push({
      group: "",
      toolId,
      version,
      manifestPath: path.join(flatRoot, version, key, "manifest.json")
    });
  }
  return locations;
}

function normalizePathEntries(baseDir, entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry));
}

function runtimeFromManifest(fsImpl, location, options = {}) {
  if (!existsFile(fsImpl, location.manifestPath)) return { missing: location.manifestPath };
  const parsed = safeReadJson(fsImpl, location.manifestPath);
  if (parsed.error) {
    return {
      invalid: location.manifestPath,
      reason: `Invalid manifest JSON: ${parsed.error.message || parsed.error}`
    };
  }
  const manifest = parsed;
  const baseDir = path.dirname(location.manifestPath);
  const entrypoint = String(manifest.entrypoint || manifest.command || "").trim();
  if (!entrypoint) {
    return { invalid: location.manifestPath, reason: "Manifest is missing entrypoint." };
  }
  const entrypointPath = path.isAbsolute(entrypoint)
    ? path.normalize(entrypoint)
    : path.resolve(baseDir, entrypoint);
  if (!isChildPath(baseDir, entrypointPath)) {
    return { invalid: location.manifestPath, reason: "Manifest entrypoint must stay inside its runtime directory." };
  }
  if (!existsFile(fsImpl, entrypointPath)) {
    return { missing: entrypointPath };
  }
  const manifestEnv = manifest.env && typeof manifest.env === "object" && !Array.isArray(manifest.env)
    ? Object.fromEntries(Object.entries(manifest.env).map(([key, value]) => [key, String(value)]))
    : {};
  return {
    source: "managed",
    engine: options.engine,
    toolId: location.toolId,
    group: location.group,
    version: String(manifest.version || location.version || "").trim(),
    runtimeKey: options.runtimeKey,
    manifestPath: location.manifestPath,
    rootDir: baseDir,
    entrypoint,
    path: entrypointPath,
    command: entrypointPath,
    protocol: String(manifest.protocol || location.group || "cli").trim(),
    args: Array.isArray(manifest.args) ? manifest.args.map(String) : [],
    env: manifestEnv,
    pathEntries: normalizePathEntries(baseDir, manifest.path_entries || manifest.pathEntries || []),
    healthcheck: manifest.healthcheck && typeof manifest.healthcheck === "object" ? { ...manifest.healthcheck } : null,
    manifest
  };
}

function protocolAllowed(protocol, allowed = []) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const id = String(protocol || "cli").trim().toLowerCase();
  return allowed.map((item) => String(item || "").trim().toLowerCase()).includes(id);
}

function resolveManagedAgentRuntime(input = {}) {
  const fsImpl = input.fs || fs;
  const platform = input.platform || process.platform;
  const arch = input.arch || process.arch;
  const key = input.runtimeKey || runtimeKey(platform, arch);
  const engine = normalizeEngineId(input.engine);
  if (!engine) return null;
  const toolIds = input.toolIds || ENGINE_TOOL_IDS[engine] || [engine];
  const roots = Array.isArray(input.resourceRoots)
    ? input.resourceRoots
    : defaultResourceRoots({ ...input, platform, arch });
  const diagnostics = [];
  for (const root of roots) {
    for (const toolId of toolIds) {
      for (const location of manifestLocations(fsImpl, root, engine, toolId, key)) {
        const runtime = runtimeFromManifest(fsImpl, location, { engine, runtimeKey: key });
        if (runtime?.source === "managed" && protocolAllowed(runtime.protocol, input.protocols)) return runtime;
        if (runtime?.source === "managed") {
          diagnostics.push({
            invalid: location.manifestPath,
            reason: `Managed runtime protocol '${runtime.protocol || "cli"}' is not supported here.`
          });
          continue;
        }
        if (runtime?.invalid || runtime?.missing) diagnostics.push(runtime);
      }
    }
  }
  return { source: "missing", engine, runtimeKey: key, diagnostics };
}

function runtimeEnv(runtime = {}, baseEnv = {}, options = {}) {
  const platform = options.platform || process.platform;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const pathEntries = Array.isArray(runtime.pathEntries) ? runtime.pathEntries : [];
  const currentPath = String(baseEnv.PATH || baseEnv.Path || "");
  const env = {
    ...(baseEnv || {}),
    ...(runtime.env || {})
  };
  if (pathEntries.length) {
    env.PATH = [...pathEntries, ...currentPath.split(delimiter).filter(Boolean)].join(delimiter);
  }
  return envWithExecutableDirFirst(env, runtime.path, { platform });
}

function runtimeVersion(runtime = {}, deps = {}) {
  if (runtime.version) return runtime.version;
  const spawnSync = deps.spawnSync;
  if (typeof spawnSync !== "function" || !runtime.path) return "";
  const args = Array.isArray(runtime.healthcheck?.args) ? runtime.healthcheck.args.map(String) : ["--version"];
  const result = spawnSyncExecutable(spawnSync, runtime.path, args, {
    encoding: "utf8",
    timeout: Number(runtime.healthcheck?.timeoutMs || runtime.healthcheck?.timeout_ms || 2000),
    env: runtimeEnv(runtime, deps.env || process.env, { platform: deps.platform || process.platform })
  }, { platform: deps.platform || process.platform });
  if (result.error) return "";
  return String(result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() || "";
}

function createManagedAgentRuntimeService(deps = {}) {
  const fsImpl = deps.fs || fs;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const resourceRoots = Array.isArray(deps.resourceRoots)
    ? deps.resourceRoots
    : defaultResourceRoots({ ...deps, platform, arch });
  const cache = new Map();

  function resolve(engine, options = {}) {
    const id = normalizeEngineId(engine);
    if (!id) return null;
    const protocols = Array.isArray(options.protocols) ? options.protocols.map(String).sort().join(",") : "";
    const cacheKey = `${id}:${protocols}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const runtime = resolveManagedAgentRuntime({
      fs: fsImpl,
      platform,
      arch,
      engine: id,
      protocols: options.protocols,
      resourceRoots
    });
    const value = runtime?.source === "managed"
      ? { ...runtime, version: runtimeVersion(runtime, { spawnSync: deps.spawnSync, env: deps.env, platform }) }
      : null;
    cache.set(cacheKey, value);
    return value;
  }

  function diagnose(engine) {
    const id = normalizeEngineId(engine);
    return resolveManagedAgentRuntime({
      fs: fsImpl,
      platform,
      arch,
      engine: id,
      resourceRoots
    });
  }

  function resetCache() {
    cache.clear();
  }

  return {
    diagnose,
    resourceRoots: () => resourceRoots.slice(),
    resetCache,
    resolve
  };
}

module.exports = {
  ENGINE_TOOL_IDS,
  createManagedAgentRuntimeService,
  defaultResourceRoots,
  normalizeEngineId,
  resolveManagedAgentRuntime,
  runtimeEnv,
  runtimeKey,
  runtimeVersion
};
