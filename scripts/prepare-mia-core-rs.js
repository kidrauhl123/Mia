"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveMiaCoreVersion } = require("./resolve-mia-core-version.js");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RELEASE_BASE_URL = "https://mia.gifgif.cn/downloads/mia-core";

function normalizeArch(arch = "") {
  const value = String(arch || "").trim().toLowerCase();
  if (value === "amd64") return "x64";
  if (value === "aarch64") return "arm64";
  return value;
}

function targetArchFromContext(context = {}, env = process.env) {
  const map = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
  const archIndex = typeof context.arch === "number" ? context.arch : null;
  if (archIndex != null && map[archIndex]) return map[archIndex];
  const explicit = normalizeArch(env.MIA_CORE_TARGET_ARCH);
  if (explicit) return explicit;
  return normalizeArch(os.arch()) || "x64";
}

function normalizePlatform(platform = "") {
  const value = String(platform || "").trim().toLowerCase();
  if (["mac", "macos", "darwin"].includes(value)) return "darwin";
  if (["win", "win32", "windows"].includes(value)) return "win32";
  if (value === "linux") return "linux";
  return "";
}

function targetPlatformFromContext(context = {}, env = process.env) {
  const explicit = normalizePlatform(env.MIA_CORE_TARGET_PLATFORM);
  if (explicit) return explicit;
  const candidates = [
    context.electronPlatformName,
    context.packager?.platform?.nodeName,
    context.packager?.platform?.name,
    context.platform?.nodeName,
    context.platform?.name
  ];
  for (const candidate of candidates) {
    const normalized = normalizePlatform(candidate);
    if (normalized) return normalized;
  }
  return normalizePlatform(process.platform) || process.platform;
}

function rustCoreBinaryName(platform = process.platform) {
  return normalizePlatform(platform) === "win32" ? "mia-core.exe" : "mia-core";
}

function canPrepareManagedResourcesForTarget({
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = os.arch()
} = {}) {
  return (normalizePlatform(platform) || platform) === (normalizePlatform(hostPlatform) || hostPlatform)
    && normalizeArch(arch) === normalizeArch(hostArch);
}

function rustTargetTriple(platform = process.platform, arch = process.arch) {
  const normalizedPlatform = normalizePlatform(platform) || platform;
  const normalizedArch = normalizeArch(arch);
  const archPrefix = { x64: "x86_64", arm64: "aarch64" }[normalizedArch];
  if (!archPrefix) {
    throw new Error(`Unsupported Mia Core target arch: ${arch}`);
  }
  const platformSuffix = {
    darwin: "apple-darwin",
    linux: "unknown-linux-gnu",
    win32: "pc-windows-msvc"
  }[normalizedPlatform];
  if (!platformSuffix) {
    throw new Error(`Unsupported Mia Core target platform: ${platform}`);
  }
  return `${archPrefix}-${platformSuffix}`;
}

function normalizeVersionTag(version = "") {
  const value = String(version || "").trim();
  if (!value) return "latest";
  if (value === "latest") return value;
  return value.startsWith("v") ? value : `v${value}`;
}

function releaseBaseUrl(rootDir, env = process.env) {
  const explicit = String(env.MIA_CORE_RELEASE_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const pinned = String(pkg.miaCoreReleaseBaseUrl || "").trim();
    if (pinned) return pinned.replace(/\/+$/, "");
  } catch {
    // Use the public Mia download origin below.
  }
  return DEFAULT_RELEASE_BASE_URL;
}

function miaCoreAssetName(platform, arch, tag) {
  const target = rustTargetTriple(platform, arch);
  const ext = normalizePlatform(platform) === "win32" ? ".zip" : ".tar.gz";
  return `mia-core-${normalizeVersionTag(tag)}-${target}${ext}`;
}

function miaCoreDownloadUrl({ rootDir, platform, arch, tag, env = process.env }) {
  const assetName = miaCoreAssetName(platform, arch, tag);
  const template = String(env.MIA_CORE_RELEASE_URL_TEMPLATE || "").trim();
  if (template) {
    return template
      .replace(/\{tag\}/g, normalizeVersionTag(tag))
      .replace(/\{asset\}/g, assetName)
      .replace(/\{target\}/g, rustTargetTriple(platform, arch));
  }
  return `${releaseBaseUrl(rootDir, env)}/${normalizeVersionTag(tag)}/${assetName}`;
}

function bundledRustCorePath(rootDir, platform, arch) {
  return path.join(
    rootDir,
    "resources",
    "bundled-mia-core",
    `${targetPlatformFromContext({ electronPlatformName: platform }, {})}-${normalizeArch(arch)}`,
    rustCoreBinaryName(platform)
  );
}

function assertReadableFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${label} not found at ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
  return stat;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDirectorySafe(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function ensureExecutableMode(filePath, platform = process.platform) {
  if (normalizePlatform(platform) === "win32") return;
  fs.chmodSync(filePath, 0o755);
}

function downloadFile(url, outputPath, { platform = process.platform, execFileSync = childProcess.execFileSync } = {}) {
  ensureDirectory(path.dirname(outputPath));
  if (normalizePlatform(platform) === "win32") {
    const ps = `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${outputPath.replace(/'/g, "''")}'`;
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 120000 });
    return;
  }
  try {
    execFileSync("curl", ["-L", "--fail", "--silent", "--show-error", "-o", outputPath, url], { timeout: 120000 });
  } catch {
    execFileSync("wget", ["-q", "-O", outputPath, url], { timeout: 120000 });
  }
}

function assertNotHtmlDownload(filePath, url) {
  const fd = fs.openSync(filePath, "r");
  let prefix = "";
  try {
    const buffer = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead).toString("utf8").trimStart().toLowerCase();
  } finally {
    fs.closeSync(fd);
  }
  if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html")) {
    throw new Error(`Mia Core release download returned an HTML page instead of an archive: ${url}`);
  }
}

function extractArchive(archivePath, outputDir, { platform = process.platform, execFileSync = childProcess.execFileSync } = {}) {
  ensureDirectory(outputDir);
  if (normalizePlatform(platform) === "win32" || archivePath.endsWith(".zip")) {
    if (normalizePlatform(platform) === "win32") {
      const ps = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`;
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    } else {
      execFileSync("unzip", ["-o", archivePath, "-d", outputDir]);
    }
    return;
  }
  execFileSync("tar", ["-xzf", archivePath, "-C", outputDir]);
}

function findBinaryInDir(dir, binaryName) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === binaryName) return fullPath;
    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName);
      if (found) return found;
    }
  }
  return "";
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function prepareManagedAgentResources({
  rootDir,
  corePath,
  platform,
  arch,
  env = process.env,
  execFileSync = childProcess.execFileSync,
  hostPlatform = process.platform,
  hostArch = os.arch()
}) {
  const mode = String(env.MIA_MANAGED_RESOURCES_PREPARE || "").trim();
  const forced = mode === "1" || mode.toLowerCase() === "true";
  if ((mode === "0" || mode.toLowerCase() === "false") && !forced) {
    return { skipped: true, reason: "disabled", resourceDir: "" };
  }
  if (!forced && !canPrepareManagedResourcesForTarget({ platform, arch, hostPlatform, hostArch })) {
    return {
      skipped: true,
      reason: `target ${platform}-${arch} cannot be prepared on host ${hostPlatform}-${hostArch}`,
      resourceDir: ""
    };
  }
  const resourceDir = path.join(rootDir, "resources", "managed-resources");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-managed-resources-"));
  ensureDirectory(resourceDir);
  try {
    execFileSync(corePath, [
      "prepare-managed-resources",
      "--data-dir",
      dataDir,
      "--resource-dir",
      resourceDir
    ], {
      cwd: rootDir,
      env,
      stdio: "inherit",
      timeout: Number(env.MIA_MANAGED_RESOURCES_PREPARE_TIMEOUT_MS || 600000)
    });
    return { skipped: false, reason: "", resourceDir };
  } finally {
    removeDirectorySafe(dataDir);
  }
}

function resolveLatestTag({ rootDir, env = process.env, execFileSync = childProcess.execFileSync } = {}) {
  const explicit = String(env.MIA_CORE_LATEST_MANIFEST_URL || "").trim();
  const url = explicit || `${releaseBaseUrl(rootDir, env)}/latest.json`;
  const output = execFileSync("curl", ["-fsSL", url], { encoding: "utf8", timeout: 30000 });
  const manifest = JSON.parse(output);
  const tag = String(manifest.tag_name || manifest.tag || manifest.version || "").trim();
  if (!tag) {
    throw new Error(`Mia Core latest manifest has no tag: ${url}`);
  }
  return normalizeVersionTag(tag);
}

function stageBinary({ rootDir, platform, arch, tag, sourcePath, sourceType, sourceDetail = {} }) {
  const binaryName = rustCoreBinaryName(platform);
  const dest = bundledRustCorePath(rootDir, platform, arch);
  const targetDir = path.dirname(dest);
  const stat = assertReadableFile(sourcePath, "Mia Rust Core binary");
  removeDirectorySafe(targetDir);
  ensureDirectory(targetDir);
  fs.copyFileSync(sourcePath, dest);
  ensureExecutableMode(dest, platform);
  const bytes = fs.statSync(dest).size || stat.size;
  writeJson(path.join(targetDir, "manifest.json"), {
    platform,
    arch,
    target: rustTargetTriple(platform, arch),
    version: normalizeVersionTag(tag),
    generatedAt: new Date().toISOString(),
    sourceType,
    source: sourceDetail,
    files: [binaryName]
  });
  return { platform, arch, source: sourcePath, dest, bytes, sourceType, tag: normalizeVersionTag(tag) };
}

function stageArchive({ rootDir, platform, arch, tag, archivePath, sourceType, sourceDetail, execFileSync }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-prepare-"));
  const extractDir = path.join(tempDir, "extracted");
  try {
    extractArchive(archivePath, extractDir, { platform, execFileSync });
    const binaryName = rustCoreBinaryName(platform);
    const binaryPath = findBinaryInDir(extractDir, binaryName);
    if (!binaryPath) {
      throw new Error(`Binary ${binaryName} not found in Mia Core archive: ${archivePath}`);
    }
    return stageBinary({
      rootDir,
      platform,
      arch,
      tag,
      sourcePath: binaryPath,
      sourceType,
      sourceDetail
    });
  } finally {
    removeDirectorySafe(tempDir);
  }
}

async function prepareMiaCoreRs(context = {}, options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT);
  const env = options.env || process.env;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const platform = targetPlatformFromContext(context, env);
  const arch = targetArchFromContext(context, env);
  const explicitSource = String(env.MIA_CORE_RS_BIN || "").trim();
  let tag = normalizeVersionTag(resolveMiaCoreVersion(rootDir, env));

  if (tag === "latest") {
    tag = resolveLatestTag({ rootDir, env, execFileSync });
  }

  let result;
  if (explicitSource) {
    result = stageBinary({
      rootDir,
      platform,
      arch,
      tag,
      sourcePath: path.resolve(explicitSource),
      sourceType: "local-binary",
      sourceDetail: { path: path.resolve(explicitSource) }
    });
  } else {
    const explicitArchive = String(env.MIA_CORE_RELEASE_ARCHIVE || "").trim();
    if (explicitArchive) {
      result = stageArchive({
        rootDir,
        platform,
        arch,
        tag,
        archivePath: path.resolve(explicitArchive),
        sourceType: "local-archive",
        sourceDetail: { path: path.resolve(explicitArchive) },
        execFileSync
      });
    } else {
      const url = miaCoreDownloadUrl({ rootDir, platform, arch, tag, env });
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-download-"));
      const archivePath = path.join(tempDir, miaCoreAssetName(platform, arch, tag));
      try {
        downloadFile(url, archivePath, { platform, execFileSync });
        assertNotHtmlDownload(archivePath, url);
        result = stageArchive({
          rootDir,
          platform,
          arch,
          tag,
          archivePath,
          sourceType: "download",
          sourceDetail: { url },
          execFileSync
        });
      } finally {
        removeDirectorySafe(tempDir);
      }
    }
  }

  console.log(`[prepare-mia-core-rs] staged Rust Core (${result.bytes} bytes) for ${platform}-${arch} from ${result.source} -> ${result.dest}`);
  const managedResources = prepareManagedAgentResources({
    rootDir,
    corePath: result.dest,
    platform,
    arch,
    env,
    execFileSync,
    hostPlatform: options.hostPlatform || process.platform,
    hostArch: options.hostArch || os.arch()
  });
  if (managedResources.skipped) {
    console.log(`[prepare-mia-core-rs] skipped managed ACP resources: ${managedResources.reason}`);
  } else {
    console.log(`[prepare-mia-core-rs] prepared managed ACP resources -> ${managedResources.resourceDir}`);
  }
  result.managedResources = managedResources;
  return result;
}

module.exports = prepareMiaCoreRs;
Object.assign(module.exports, {
  bundledRustCorePath,
  canPrepareManagedResourcesForTarget,
  assertNotHtmlDownload,
  downloadFile,
  extractArchive,
  findBinaryInDir,
  miaCoreAssetName,
  miaCoreDownloadUrl,
  normalizeArch,
  normalizePlatform,
  normalizeVersionTag,
  prepareManagedAgentResources,
  prepareMiaCoreRs,
  releaseBaseUrl,
  resolveLatestTag,
  rustTargetTriple,
  rustCoreBinaryName,
  targetArchFromContext,
  targetPlatformFromContext
});

if (require.main === module) {
  const arch = process.argv[2] || "";
  const platform = process.argv[3] || "";
  prepareMiaCoreRs(
    {
      arch: arch ? { ia32: 0, x64: 1, armv7l: 2, arm64: 3, universal: 4 }[normalizeArch(arch)] : undefined,
      electronPlatformName: platform
    },
    { env: { ...process.env, ...(arch ? { MIA_CORE_TARGET_ARCH: arch } : {}), ...(platform ? { MIA_CORE_TARGET_PLATFORM: platform } : {}) } }
  ).catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
