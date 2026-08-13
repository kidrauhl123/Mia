"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  assertExpectedBuildInfo,
  readCoreBuildInfo,
  sha256File
} = require("./mia-core-build-info.js");
const { coreSourceFingerprint } = require("./mia-core-source-fingerprint.js");

const root = path.join(__dirname, "..");
// A freshly unpacked desktop Core can take several seconds to initialize.
const DEFAULT_TIMEOUT_MS = Number(process.env.MIA_PACKAGED_CORE_VERIFY_TIMEOUT_MS || 45000);
const MANAGED_ACP_RESOURCE_SPECS = [
  { toolId: "claude-agent-acp", version: "0.59.0" },
  { toolId: "codex-acp", version: "1.1.4" }
];

function normalizeArch(arch = "") {
  const value = String(arch || "").trim().toLowerCase();
  if (value === "amd64") return "x64";
  if (value === "aarch64") return "arm64";
  return value;
}

function normalizePlatform(platform = "") {
  const value = String(platform || "").trim().toLowerCase();
  if (["mac", "macos", "darwin"].includes(value)) return "darwin";
  if (["win", "win32", "windows"].includes(value)) return "win32";
  if (value === "linux") return "linux";
  return "";
}

function defaultTargetArch() {
  return normalizeArch(os.arch()) || "x64";
}

function rustCoreBinaryName(platform = process.platform) {
  return normalizePlatform(platform) === "win32" ? "mia-core.exe" : "mia-core";
}

function canRunTargetArch({
  arch = "",
  hostArch = os.arch(),
  platform = process.platform,
  hostPlatform = process.platform
} = {}) {
  const targetArch = normalizeArch(arch);
  const currentArch = normalizeArch(hostArch);
  const targetPlatform = normalizePlatform(platform) || platform;
  const currentPlatform = normalizePlatform(hostPlatform) || hostPlatform;
  if (targetPlatform !== currentPlatform) return false;
  if (!targetArch || targetArch === currentArch) return true;
  if (targetPlatform !== "darwin") return true;
  return false;
}

function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function macAppCandidates(rootDir, arch = "") {
  const releaseDir = path.join(rootDir, "release");
  const candidates = [];
  if (arch === "arm64") {
    candidates.push(
      path.join(releaseDir, "mac-arm64", "Mia.app"),
      path.join(releaseDir, "mac", "Mia.app")
    );
  } else if (arch === "x64") {
    candidates.push(
      path.join(releaseDir, "mac", "Mia.app"),
      path.join(releaseDir, "mac-x64", "Mia.app"),
      path.join(releaseDir, "mac-intel", "Mia.app")
    );
  } else {
    candidates.push(
      path.join(releaseDir, "mac-arm64", "Mia.app"),
      path.join(releaseDir, "mac", "Mia.app"),
      path.join(releaseDir, "mac-x64", "Mia.app"),
      path.join(releaseDir, "mac-intel", "Mia.app")
    );
  }
  return candidates;
}

function resolvePackagedAppPath({ rootDir = root, appPath = "", arch = "", platform = process.platform } = {}) {
  if (appPath) return path.resolve(appPath);
  const targetPlatform = normalizePlatform(platform) || platform;
  const releaseDir = path.join(rootDir, "release");
  if (targetPlatform === "win32") {
    for (const candidate of [
      path.join(releaseDir, "win-unpacked"),
      path.join(releaseDir, "win-x64-unpacked")
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  }
  for (const candidate of macAppCandidates(rootDir, normalizeArch(arch))) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (!fs.existsSync(releaseDir)) return "";
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(releaseDir, entry.name, "Mia.app");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function resourcesForApp(appPath, platform = process.platform) {
  if ((normalizePlatform(platform) || platform) === "win32") {
    return path.join(appPath, "resources");
  }
  return path.join(appPath, "Contents", "Resources");
}

function managedResourceManifestPaths(resourcesPath, platform, arch) {
  const runtimeKey = `${normalizePlatform(platform) || platform}-${normalizeArch(arch)}`;
  const managedResourcesPath = path.join(
    resourcesPath,
    "bundled-mia-core",
    runtimeKey,
    "managed-resources"
  );
  return {
    managedResourcesPath,
    manifestPaths: MANAGED_ACP_RESOURCE_SPECS.map(({ toolId, version }) => path.join(
      managedResourcesPath,
      "acp",
      toolId,
      version,
      runtimeKey,
      "manifest.json"
    ))
  };
}

function findManagedResourceDirectories(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const found = [];
  const pending = [rootPath];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.name === "managed-resources") {
        found.push(candidate);
      } else {
        pending.push(candidate);
      }
    }
  }
  return found;
}

function collectRequiredPaths(appPath, { platform = process.platform, arch = "" } = {}) {
  const targetPlatform = normalizePlatform(platform) || platform;
  const targetArch = normalizeArch(arch) || defaultTargetArch();
  const resourcesPath = resourcesForApp(appPath, targetPlatform);
  const packageJsonPath = path.join(resourcesPath, "app.asar.unpacked", "package.json");
  const corePath = path.join(
    resourcesPath,
    "bundled-mia-core",
    `${targetPlatform}-${targetArch}`,
    rustCoreBinaryName(targetPlatform)
  );
  const coreManifestPath = path.join(path.dirname(corePath), "manifest.json");
  const managed = managedResourceManifestPaths(resourcesPath, targetPlatform, targetArch);
  return {
    resourcesPath,
    packageJsonPath,
    corePath,
    coreManifestPath,
    managedResourcesPath: managed.managedResourcesPath,
    requiredManagedResourcePaths: managed.manifestPaths,
    forbiddenEnginePaths: [
      path.join(resourcesPath, "hermes-runtime"),
      path.join(resourcesPath, "managed-resources")
    ]
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid or unreadable at ${filePath}: ${error?.message || error}`);
  }
}

function verifyMacCodeSignature(corePath, execFileSync = childProcess.execFileSync) {
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", corePath], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"]
  });
}

function verifyStagedCoreIdentity({
  rootDir,
  packageJsonPath,
  corePath,
  coreManifestPath,
  platform = process.platform,
  verifyCodeSignature = verifyMacCodeSignature
}) {
  const packageJson = readJson(packageJsonPath, "Packaged package.json");
  const manifest = readJson(coreManifestPath, "Packaged Mia Core manifest");
  const expected = {
    releaseVersion: String(packageJson.miaCoreVersion || "").trim(),
    sourceFingerprint: coreSourceFingerprint(rootDir)
  };
  const actual = assertExpectedBuildInfo({
    releaseVersion: manifest.releaseVersion || manifest.version,
    sourceFingerprint: manifest.sourceFingerprint
  }, expected, "Packaged Mia Core manifest");
  const expectedSha256 = String(manifest.binarySha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Packaged Mia Core manifest has no verified binary checksum.");
  }
  if (sha256File(corePath) !== expectedSha256) {
    if (normalizePlatform(platform) !== "darwin") {
      throw new Error("Packaged Mia Core binary checksum does not match its manifest.");
    }
    try {
      verifyCodeSignature(corePath);
    } catch (error) {
      throw new Error(`Packaged Mia Core changed after staging and has no valid macOS code signature: ${error?.message || error}`);
    }
  }
  return actual;
}

function createNvmCodexFixture(homeDir, platform, fsImpl = fs) {
  const binDir = path.join(homeDir, ".nvm", "versions", "node", "v99.0.0", "bin");
  fsImpl.mkdirSync(binDir, { recursive: true });
  if (platform === "win32") {
    const codexPath = path.join(binDir, "codex.exe");
    fsImpl.copyFileSync(process.execPath, codexPath);
    return codexPath;
  }
  const nodePath = path.join(binDir, "node");
  const codexPath = path.join(binDir, "codex");
  fsImpl.symlinkSync(process.execPath, nodePath);
  fsImpl.writeFileSync(codexPath, "#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('codex-cli 99.0.0\\n');\n", { mode: 0o755 });
  return codexPath;
}

async function stopChild(child, timeoutMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHealth(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, child = null } = {}) {
  const startedAt = Date.now();
  let lastError = "";
  let childError = "";
  const onChildError = (error) => {
    childError = error?.message || String(error);
  };
  child?.once("error", onChildError);
  while ((Date.now() - startedAt) < timeoutMs) {
    if (childError) {
      return { ok: false, error: `packaged Mia Rust Core failed to start: ${childError}` };
    }
    if (child && child.exitCode !== null) {
      return {
        ok: false,
        error: `packaged Mia Rust Core exited before /health responded (code ${child.exitCode})`
      };
    }
    try {
      const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        return { ok: true, body };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (child && child.exitCode !== null) {
      return {
        ok: false,
        error: `packaged Mia Rust Core exited before /health responded (code ${child.exitCode})`
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (childError) {
    return { ok: false, error: `packaged Mia Rust Core failed to start: ${childError}` };
  }
  return {
    ok: false,
    error: lastError || `timed out waiting for ${baseUrl}/health`
  };
}

async function verifyPackagedMiaCore({
  rootDir = root,
  appPath = "",
  arch = "",
  managedResources = "forbidden",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  hostArch = os.arch(),
  platform = process.platform,
  hostPlatform = process.platform,
  readBuildInfo = readCoreBuildInfo,
  verifyCodeSignature = verifyMacCodeSignature
} = {}) {
  const targetPlatform = normalizePlatform(platform) || platform;
  const targetArch = normalizeArch(arch) || defaultTargetArch();
  const resolvedAppPath = resolvePackagedAppPath({ rootDir, appPath, arch: targetArch, platform: targetPlatform });
  if (!resolvedAppPath) {
    return {
      ok: false,
      error: `Unable to find packaged Mia application under ${path.join(rootDir, "release")}`
    };
  }

  const paths = collectRequiredPaths(resolvedAppPath, { platform: targetPlatform, arch: targetArch });
  const managedResourcesMode = ["required", "forbidden", "optional"].includes(managedResources)
    ? managedResources
    : "forbidden";
  const required = [
    paths.resourcesPath,
    paths.corePath,
    paths.coreManifestPath,
    paths.packageJsonPath,
    ...(managedResourcesMode === "required"
      ? [paths.managedResourcesPath, ...paths.requiredManagedResourcePaths]
      : [])
  ].filter(Boolean);
  const missing = required.filter((candidate) => !fs.existsSync(candidate));
  if (missing.length) {
    const missingCore = missing.includes(paths.corePath);
    return {
      ok: false,
      appPath: resolvedAppPath,
      corePath: paths.corePath,
      error: missingCore
        ? `Packaged Mia Core is incomplete: missing bundled Rust Core binary at ${paths.corePath}`
        : `Packaged Mia application is incomplete: missing bundled managed ACP resources or other required files: ${missing.join(", ")}`
    };
  }


  let expectedBuildInfo;
  try {
    expectedBuildInfo = verifyStagedCoreIdentity({
      rootDir,
      packageJsonPath: paths.packageJsonPath,
      corePath: paths.corePath,
      coreManifestPath: paths.coreManifestPath,
      platform: targetPlatform,
      verifyCodeSignature
    });
  } catch (error) {
    return {
      ok: false,
      appPath: resolvedAppPath,
      corePath: paths.corePath,
      error: error?.message || String(error)
    };
  }

  const embeddedManagedResources = managedResourcesMode === "forbidden"
    ? findManagedResourceDirectories(path.join(paths.resourcesPath, "bundled-mia-core"))
    : [];
  if (embeddedManagedResources.length) {
    return {
      ok: false,
      appPath: resolvedAppPath,
      corePath: paths.corePath,
      error: `Desktop package must not embed managed ACP resources: remove ${embeddedManagedResources.join(", ")}`
    };
  }

  const embeddedEngines = paths.forbiddenEnginePaths.filter((candidate) => fs.existsSync(candidate));
  if (embeddedEngines.length) {
    return {
      ok: false,
      appPath: resolvedAppPath,
      corePath: paths.corePath,
      error: `Packaged Mia must not embed legacy top-level engine backups: remove ${embeddedEngines.join(", ")}`
    };
  }

  if (!canRunTargetArch({
    arch: targetArch,
    hostArch,
    platform: targetPlatform,
    hostPlatform
  })) {
    return {
      ok: true,
      appPath: resolvedAppPath,
      corePath: paths.corePath,
      skippedRuntimeProbe: true,
      buildInfo: expectedBuildInfo,
      reason: `skipped runtime probe because target ${targetPlatform}-${targetArch} cannot run on ${hostPlatform}-${hostArch}`
    };
  }

  const verifyHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-rust-core-"));
  const workspaceDir = path.join(verifyHome, "workspace");
  const expectedCodexPath = createNvmCodexFixture(verifyHome, targetPlatform);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";

  const child = childProcess.spawn(paths.corePath, [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--data-dir",
    verifyHome,
    "--workspace-dir",
    workspaceDir,
    "--language",
    "zh"
  ], {
    cwd: path.dirname(paths.corePath),
    env: {
      ...process.env,
      HOME: verifyHome,
      USERPROFILE: verifyHome,
      PATH: targetPlatform === "win32"
        ? String(process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : "")
        : "/usr/bin:/bin:/usr/sbin:/sbin",
      MIA_CORE: "1",
      MIA_CORE_HOME: verifyHome,
      MIA_CORE_WORKSPACE_DIR: workspaceDir,
      MIA_MANAGED_AGENT_PREPARE: "0",
      MIA_MANAGED_AGENT_RESOURCES_ONLY: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    const health = await waitForHealth(baseUrl, { timeoutMs, fetchImpl, child });
    if (!health.ok) {
      await stopChild(child);
      return {
        ok: false,
        appPath: resolvedAppPath,
        corePath: paths.corePath,
        baseUrl,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: health.error
      };
    }
    let binaryBuildInfo;
    try {
      binaryBuildInfo = assertExpectedBuildInfo(
        readBuildInfo(paths.corePath, { env: process.env }),
        expectedBuildInfo,
        "Packaged Mia Core binary"
      );
    } catch (error) {
      await stopChild(child);
      return {
        ok: false,
        appPath: resolvedAppPath,
        corePath: paths.corePath,
        error: error?.message || String(error)
      };
    }
    const healthBuildInfo = {
      releaseVersion: health.body?.coreReleaseVersion,
      sourceFingerprint: health.body?.coreSourceFingerprint
    };
    try {
      assertExpectedBuildInfo(healthBuildInfo, expectedBuildInfo, "Running packaged Mia Core");
    } catch (error) {
      await stopChild(child);
      return {
        ok: false,
        appPath: resolvedAppPath,
        corePath: paths.corePath,
        error: error?.message || String(error)
      };
    }
    let inventory;
    try {
      const response = await fetchImpl(`${baseUrl}/api/engines/agents`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      inventory = await response.json();
      const codex = (inventory?.agents || []).find((agent) => agent?.id === "codex");
      if (!codex?.installed || path.resolve(String(codex.path || "")) !== path.resolve(expectedCodexPath)) {
        throw new Error("packaged Core did not detect Codex from a Finder-style nvm environment");
      }
      if (targetPlatform !== "win32" && String(codex.version || "") !== "codex-cli 99.0.0") {
        throw new Error(`packaged Core found nvm Codex but could not execute it: ${codex.version || "no version"}`);
      }
    } catch (error) {
      await stopChild(child);
      return {
        ok: false,
        appPath: resolvedAppPath,
        corePath: paths.corePath,
        error: error?.message || String(error)
      };
    }
    await stopChild(child);
    return {
      ok: true,
      appPath: resolvedAppPath,
      corePath: paths.corePath,
      baseUrl,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      health: health.body,
      buildInfo: binaryBuildInfo,
      codexPath: expectedCodexPath
    };
  } finally {
    fs.rmSync(verifyHome, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  let appPath = "";
  let arch = "";
  let platform = "";
  let managedResources = "forbidden";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--app") {
      appPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--arch") {
      arch = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--platform") {
      platform = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--managed-resources") {
      managedResources = argv[index + 1] || "forbidden";
      index += 1;
    }
  }

  if (!["required", "forbidden", "optional"].includes(managedResources)) {
    throw new Error(`Invalid --managed-resources mode: ${managedResources}`);
  }
  const result = await verifyPackagedMiaCore({
    appPath,
    arch,
    managedResources,
    platform: platform || process.platform
  });
  if (!result.ok) {
    const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    process.stderr.write(`packaged Mia Core verification failed: ${detail}\n`);
    process.exit(1);
  }
  if (result.skippedRuntimeProbe) {
    process.stdout.write(`packaged Mia Core structure verified: ${result.appPath} (${result.reason})\n`);
    return;
  }
  process.stdout.write(`packaged Mia Core verified: ${result.appPath} -> ${result.baseUrl}\n`);
}

module.exports = {
  canRunTargetArch,
  collectRequiredPaths,
  findManagedResourceDirectories,
  managedResourceManifestPaths,
  normalizeArch,
  normalizePlatform,
  resolvePackagedAppPath,
  verifyStagedCoreIdentity,
  verifyPackagedMiaCore
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`packaged Mia Core verification failed: ${error?.message || error}\n`);
    process.exit(1);
  });
}
