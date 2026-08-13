"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveMiaCoreVersion } = require("./resolve-mia-core-version.js");
const {
  assertExpectedBuildInfo,
  readCoreBuildInfo,
  sha256File
} = require("./mia-core-build-info.js");
const { coreSourceFingerprintDetails } = require("./mia-core-source-fingerprint.js");

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

function miaCoreManifestUrl({ rootDir, tag, env = process.env }) {
  return `${releaseBaseUrl(rootDir, env)}/${normalizeVersionTag(tag)}/manifest.json`;
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

function bundledManagedResourcesPath(rootDir, platform, arch) {
  return path.join(path.dirname(bundledRustCorePath(rootDir, platform, arch)), "managed-resources");
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

function isUsableExecutable(filePath, platform = process.platform) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    return normalizePlatform(platform) === "win32" || Boolean(stat.mode & 0o111);
  } catch {
    return false;
  }
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

function includeManagedResourcesInManifest(dest, platform) {
  const manifestPath = path.join(path.dirname(dest), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const binaryName = rustCoreBinaryName(platform);
  manifest.files = [...new Set([binaryName, "managed-resources/"])];
  writeJson(manifestPath, manifest);
}

function prepareManagedAgentResources({
  rootDir,
  corePath,
  platform,
  arch,
  env = process.env,
  execFileSync = childProcess.execFileSync,
  resourceDir = path.join(rootDir, "resources", "managed-resources")
}) {
  const mode = String(env.MIA_MANAGED_RESOURCES_PREPARE || "").trim().toLowerCase();
  const forced = mode === "1" || mode === "true";
  if (!forced) {
    return { skipped: true, reason: mode ? "disabled" : "on-demand", resourceDir: "" };
  }
  const stagingDir = path.join(resourceDir, ".staging");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-managed-resources-"));
  ensureDirectory(resourceDir);
  removeDirectorySafe(stagingDir);
  try {
    const prepareEnv = {
      ...env,
      MIA_LOCAL_MANAGED_AGENT_RESOURCES: resourceDir,
      MIA_MANAGED_AGENT_RESOURCES: resourceDir,
      MIA_MANAGED_AGENT_RESOURCES_ONLY: "1"
    };
    execFileSync(corePath, [
      "prepare-managed-resources",
      "--data-dir",
      dataDir,
      "--resource-dir",
      resourceDir
    ], {
      cwd: rootDir,
      env: prepareEnv,
      stdio: "inherit",
      timeout: Number(env.MIA_MANAGED_RESOURCES_PREPARE_TIMEOUT_MS || 1800000)
    });
    return { skipped: false, reason: "", resourceDir };
  } finally {
    removeDirectorySafe(stagingDir);
    removeDirectorySafe(dataDir);
  }
}

function runtimeKey(platform, arch) {
  return `${normalizePlatform(platform) || platform}-${normalizeArch(arch)}`;
}

function createTargetNpmWrapper({ env = process.env, platform, arch, hostPlatform = process.platform }) {
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-target-npm-"));
  const actualNpm = String(env.MIA_MANAGED_AGENT_NPM || "npm").trim() || "npm";
  const scriptPath = path.join(wrapperDir, "npm-target.js");
  const targetPlatform = normalizePlatform(platform) || platform;
  const targetArch = normalizeArch(arch);
  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const actualNpm = ${JSON.stringify(actualNpm)};
const targetPlatform = ${JSON.stringify(targetPlatform)};
const targetArch = ${JSON.stringify(targetArch)};
const rawArgs = process.argv.slice(2);
const args = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === "--os" || arg === "--cpu") {
    index += 1;
    continue;
  }
  if (arg.startsWith("--os=") || arg.startsWith("--cpu=")) continue;
  args.push(arg);
}
// Core invokes npm with --ignore-scripts and exact pinned packages. --force
// only bypasses npm's host-architecture rejection for those target packages.
args.push("--os", targetPlatform, "--cpu", targetArch, "--force");
const result = spawnSync(actualNpm, args, {
  cwd: process.cwd(),
  env: { ...process.env, npm_config_os: targetPlatform, npm_config_cpu: targetArch },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exit(typeof result.status === "number" ? result.status : 1);
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  if (normalizePlatform(hostPlatform) === "win32") {
    const commandPath = path.join(wrapperDir, "npm-target.cmd");
    const escapedNode = process.execPath.replace(/"/g, "\\\"");
    const escapedScript = scriptPath.replace(/"/g, "\\\"");
    fs.writeFileSync(commandPath, `@echo off\r\n"${escapedNode}" "${escapedScript}" %*\r\n`, "utf8");
    return { commandPath, cleanup: () => removeDirectorySafe(wrapperDir) };
  }
  return { commandPath: scriptPath, cleanup: () => removeDirectorySafe(wrapperDir) };
}

function temporaryHostCore({ rootDir, tag, env, execFileSync, hostPlatform, hostArch }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-host-core-"));
  try {
    const url = miaCoreDownloadUrl({
      rootDir,
      platform: hostPlatform,
      arch: hostArch,
      tag,
      env
    });
    const archivePath = path.join(tempDir, miaCoreAssetName(hostPlatform, hostArch, tag));
    downloadFile(url, archivePath, { platform: hostPlatform, execFileSync });
    assertNotHtmlDownload(archivePath, url);
    const extractDir = path.join(tempDir, "extracted");
    extractArchive(archivePath, extractDir, { platform: hostPlatform, execFileSync });
    const corePath = findBinaryInDir(extractDir, rustCoreBinaryName(hostPlatform));
    if (!corePath) throw new Error(`Host Mia Core binary not found in ${url}`);
    ensureExecutableMode(corePath, hostPlatform);
    return {
      corePath,
      source: url,
      cleanup: () => removeDirectorySafe(tempDir)
    };
  } catch (error) {
    removeDirectorySafe(tempDir);
    throw error;
  }
}

function resolveManagedResourcesCore({
  rootDir,
  targetCorePath,
  tag,
  env = process.env,
  execFileSync = childProcess.execFileSync,
  platform,
  arch,
  hostPlatform = process.platform,
  hostArch = os.arch()
}) {
  const normalizedHostPlatform = normalizePlatform(hostPlatform) || hostPlatform;
  const normalizedHostArch = normalizeArch(hostArch);
  const crossTarget = !canPrepareManagedResourcesForTarget({ platform, arch, hostPlatform, hostArch });
  const explicit = String(env.MIA_MANAGED_RESOURCES_CORE_BIN || "").trim();
  if (explicit) {
    const corePath = path.resolve(explicit);
    if (crossTarget && !isUsableExecutable(corePath, normalizedHostPlatform)) {
      throw new Error(`MIA_MANAGED_RESOURCES_CORE_BIN is not an executable host Mia Core: ${corePath}`);
    }
    return { corePath, source: corePath, crossTarget, cleanup: () => {} };
  }
  if (!crossTarget) {
    return { corePath: targetCorePath, source: targetCorePath, crossTarget, cleanup: () => {} };
  }

  const hostBinaryName = rustCoreBinaryName(normalizedHostPlatform);
  const candidates = [
    path.join(rootDir, "target", rustTargetTriple(normalizedHostPlatform, normalizedHostArch), "release", hostBinaryName),
    bundledRustCorePath(rootDir, normalizedHostPlatform, normalizedHostArch)
  ];
  for (const candidate of candidates) {
    if (isUsableExecutable(candidate, normalizedHostPlatform)) {
      return { corePath: candidate, source: candidate, crossTarget, cleanup: () => {} };
    }
  }
  return {
    ...temporaryHostCore({
      rootDir,
      tag,
      env,
      execFileSync,
      hostPlatform: normalizedHostPlatform,
      hostArch: normalizedHostArch
    }),
    crossTarget
  };
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

function downloadReleaseManifest({ rootDir, tag, env = process.env, execFileSync = childProcess.execFileSync }) {
  const url = String(env.MIA_CORE_RELEASE_MANIFEST_URL || miaCoreManifestUrl({ rootDir, tag, env })).trim();
  const output = execFileSync("curl", ["-fsSL", url], { encoding: "utf8", timeout: 30000 });
  let manifest;
  try {
    manifest = JSON.parse(String(output || ""));
  } catch {
    throw new Error(`Mia Core release manifest is invalid JSON: ${url}`);
  }
  return { manifest, url };
}

function releaseAssetForTarget(manifest, { tag, platform, arch, sourceFingerprint }) {
  const manifestTag = normalizeVersionTag(manifest?.tag_name || manifest?.tag || manifest?.version || "");
  const expectedTag = normalizeVersionTag(tag);
  if (manifestTag !== expectedTag) {
    throw new Error(`Mia Core release manifest ${manifestTag} does not match required ${expectedTag}.`);
  }
  const manifestFingerprint = String(manifest?.sourceFingerprint || manifest?.source_fingerprint || "").trim().toLowerCase();
  if (manifestFingerprint !== String(sourceFingerprint || "").trim().toLowerCase()) {
    throw new Error(`Mia Core ${expectedTag} was not built from the current Core source.`);
  }
  const assetName = miaCoreAssetName(platform, arch, expectedTag);
  const asset = (Array.isArray(manifest?.assets) ? manifest.assets : [])
    .find((entry) => String(entry?.name || "") === assetName);
  if (!asset) throw new Error(`Mia Core release manifest has no asset ${assetName}.`);
  const archiveSha256 = String(asset.sha256 || "").trim().toLowerCase();
  const binarySha256 = String(asset.binarySha256 || asset.binary_sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(archiveSha256) || !/^[a-f0-9]{64}$/.test(binarySha256)) {
    throw new Error(`Mia Core release asset ${assetName} has incomplete checksums.`);
  }
  return { ...asset, archiveSha256, binarySha256 };
}

function stageBinary({
  rootDir,
  platform,
  arch,
  tag,
  sourcePath,
  sourceType,
  sourceDetail = {},
  buildInfo,
  expectedBinarySha256 = ""
}) {
  const binaryName = rustCoreBinaryName(platform);
  const dest = bundledRustCorePath(rootDir, platform, arch);
  const targetDir = path.dirname(dest);
  const stat = assertReadableFile(sourcePath, "Mia Rust Core binary");
  const binarySha256 = sha256File(sourcePath);
  if (expectedBinarySha256 && binarySha256 !== String(expectedBinarySha256).trim().toLowerCase()) {
    throw new Error(`Mia Core binary checksum does not match the ${normalizeVersionTag(tag)} release manifest.`);
  }
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
    releaseVersion: buildInfo.releaseVersion,
    sourceFingerprint: buildInfo.sourceFingerprint,
    binarySha256,
    generatedAt: new Date().toISOString(),
    sourceType,
    source: sourceDetail,
    files: [binaryName]
  });
  return {
    platform,
    arch,
    source: sourcePath,
    dest,
    bytes,
    sourceType,
    tag: normalizeVersionTag(tag),
    buildInfo,
    binarySha256
  };
}

function stageArchive({
  rootDir,
  platform,
  arch,
  tag,
  archivePath,
  sourceType,
  sourceDetail,
  buildInfo,
  expectedBinarySha256,
  execFileSync,
  extractionPlatform = process.platform
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-prepare-"));
  const extractDir = path.join(tempDir, "extracted");
  try {
    // The archive describes the target, but extraction must be performed by
    // tools available on the host that is running electron-builder. In
    // particular, macOS cross-packaging a Windows Core must use `unzip`, not
    // ask macOS to spawn Windows PowerShell.
    extractArchive(archivePath, extractDir, { platform: extractionPlatform, execFileSync });
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
      sourceDetail,
      buildInfo,
      expectedBinarySha256
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
  const hostPlatform = normalizePlatform(options.hostPlatform || process.platform) || process.platform;
  const hostArch = normalizeArch(options.hostArch || os.arch()) || os.arch();
  const explicitSource = String(env.MIA_CORE_RS_BIN || "").trim();
  let tag = normalizeVersionTag(resolveMiaCoreVersion(rootDir, env));
  const sourceIdentity = coreSourceFingerprintDetails(rootDir);
  const expectedBuildInfo = {
    releaseVersion: tag,
    sourceFingerprint: sourceIdentity.fingerprint
  };
  const readBuildInfo = options.readCoreBuildInfo || readCoreBuildInfo;

  if (tag === "latest") {
    tag = resolveLatestTag({ rootDir, env, execFileSync });
    expectedBuildInfo.releaseVersion = tag;
  }

  let result;
  if (explicitSource) {
    const sourcePath = path.resolve(explicitSource);
    const buildInfo = assertExpectedBuildInfo(
      readBuildInfo(sourcePath, { env, execFileSync }),
      expectedBuildInfo,
      `Mia Core local binary ${sourcePath}`
    );
    result = stageBinary({
      rootDir,
      platform,
      arch,
      tag,
      sourcePath,
      sourceType: "local-binary",
      sourceDetail: { path: sourcePath },
      buildInfo
    });
  } else {
    const explicitArchive = String(env.MIA_CORE_RELEASE_ARCHIVE || "").trim();
    if (explicitArchive) {
      const manifestPath = String(env.MIA_CORE_RELEASE_MANIFEST || "").trim();
      if (!manifestPath) {
        throw new Error("MIA_CORE_RELEASE_MANIFEST is required with MIA_CORE_RELEASE_ARCHIVE.");
      }
      const releaseManifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
      const releaseAsset = releaseAssetForTarget(releaseManifest, {
        tag,
        platform,
        arch,
        sourceFingerprint: sourceIdentity.fingerprint
      });
      const archivePath = path.resolve(explicitArchive);
      if (sha256File(archivePath) !== releaseAsset.archiveSha256) {
        throw new Error(`Mia Core archive checksum does not match the ${tag} release manifest.`);
      }
      result = stageArchive({
        rootDir,
        platform,
        arch,
        tag,
        archivePath,
        sourceType: "local-archive",
        sourceDetail: { path: archivePath, manifest: path.resolve(manifestPath) },
        buildInfo: expectedBuildInfo,
        expectedBinarySha256: releaseAsset.binarySha256,
        execFileSync,
        extractionPlatform: hostPlatform
      });
    } else {
      const url = miaCoreDownloadUrl({ rootDir, platform, arch, tag, env });
      const manifestResult = options.releaseManifest
        ? { manifest: options.releaseManifest, url: "injected" }
        : downloadReleaseManifest({ rootDir, tag, env, execFileSync });
      const releaseAsset = releaseAssetForTarget(manifestResult.manifest, {
        tag,
        platform,
        arch,
        sourceFingerprint: sourceIdentity.fingerprint
      });
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-download-"));
      const archivePath = path.join(tempDir, miaCoreAssetName(platform, arch, tag));
      try {
        // The URL and archive name are target-specific, while the downloader
        // is necessarily host-specific during cross-platform packaging.
        downloadFile(url, archivePath, { platform: hostPlatform, execFileSync });
        assertNotHtmlDownload(archivePath, url);
        if (sha256File(archivePath) !== releaseAsset.archiveSha256) {
          throw new Error(`Mia Core archive checksum does not match the ${tag} release manifest.`);
        }
        result = stageArchive({
          rootDir,
          platform,
          arch,
          tag,
          archivePath,
          sourceType: "download",
          sourceDetail: { url, manifestUrl: manifestResult.url },
          buildInfo: expectedBuildInfo,
          expectedBinarySha256: releaseAsset.binarySha256,
          execFileSync,
          extractionPlatform: hostPlatform
        });
      } finally {
        removeDirectorySafe(tempDir);
      }
    }
  }

  console.log(`[prepare-mia-core-rs] staged Rust Core (${result.bytes} bytes) for ${platform}-${arch} from ${result.source} -> ${result.dest}`);
  const bundledResources = bundledManagedResourcesPath(rootDir, platform, arch);
  const managedResourcesMode = String(env.MIA_MANAGED_RESOURCES_PREPARE || "").trim().toLowerCase();
  const bundleManagedResources = managedResourcesMode === "1" || managedResourcesMode === "true";
  let managedResources = { skipped: true, reason: "on-demand", resourceDir: "" };
  if (bundleManagedResources) {
    const managedResourcesCore = resolveManagedResourcesCore({
      rootDir,
      targetCorePath: result.dest,
      tag,
      env,
      execFileSync,
      platform,
      arch,
      hostPlatform,
      hostArch
    });
    const npmWrapper = managedResourcesCore.crossTarget
      ? createTargetNpmWrapper({ env, platform, arch, hostPlatform })
      : null;
    const managedResourcesEnv = {
      ...env,
      MIA_MANAGED_AGENT_RUNTIME_KEY: runtimeKey(platform, arch),
      ...(npmWrapper ? { MIA_MANAGED_AGENT_NPM: npmWrapper.commandPath } : {})
    };
    try {
      if (managedResourcesCore.crossTarget) {
        console.log(`[prepare-mia-core-rs] preparing ${runtimeKey(platform, arch)} ACP resources with host Core ${managedResourcesCore.source}`);
      }
      managedResources = prepareManagedAgentResources({
        rootDir,
        corePath: managedResourcesCore.corePath,
        platform,
        arch,
        env: managedResourcesEnv,
        execFileSync,
        resourceDir: bundledResources
      });
    } finally {
      npmWrapper?.cleanup();
      managedResourcesCore.cleanup();
    }
  } else if (managedResourcesMode) {
    managedResources.reason = "disabled";
  }
  if (!managedResources.skipped) {
    includeManagedResourcesInManifest(result.dest, platform);
    result.managedResources = {
      ...managedResources,
      bundledResourceDir: bundledResources
    };
  } else {
    result.managedResources = managedResources;
  }
  console.log(managedResources.skipped
    ? `[prepare-mia-core-rs] managed ACP resources skipped: ${managedResources.reason}`
    : `[prepare-mia-core-rs] managed ACP resources bundled at ${managedResources.resourceDir}`);
  return result;
}

module.exports = prepareMiaCoreRs;
Object.assign(module.exports, {
  bundledRustCorePath,
  bundledManagedResourcesPath,
  canPrepareManagedResourcesForTarget,
  createTargetNpmWrapper,
  assertNotHtmlDownload,
  downloadFile,
  extractArchive,
  findBinaryInDir,
  miaCoreAssetName,
  miaCoreDownloadUrl,
  miaCoreManifestUrl,
  normalizeArch,
  normalizePlatform,
  normalizeVersionTag,
  prepareManagedAgentResources,
  prepareMiaCoreRs,
  resolveManagedResourcesCore,
  releaseBaseUrl,
  resolveLatestTag,
  releaseAssetForTarget,
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
