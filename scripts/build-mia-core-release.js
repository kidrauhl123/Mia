#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  miaCoreAssetName,
  normalizeArch,
  normalizePlatform,
  normalizeVersionTag,
  rustCoreBinaryName,
  rustTargetTriple,
  targetArchFromContext,
  targetPlatformFromContext
} = require("./prepare-mia-core-rs.js");
const { resolveMiaCoreVersion } = require("./resolve-mia-core-version.js");

const root = path.resolve(__dirname, "..");

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function mergeReleaseAssets(existingManifest, nextAsset) {
  const existingAssets = Array.isArray(existingManifest?.assets) ? existingManifest.assets : [];
  return [
    ...existingAssets.filter((asset) => asset?.name !== nextAsset.name),
    nextAsset
  ].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function buildMiaCoreRelease(options = {}) {
  const rootDir = path.resolve(options.rootDir || root);
  const env = options.env || process.env;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const platform = targetPlatformFromContext({ electronPlatformName: env.MIA_CORE_TARGET_PLATFORM }, env);
  const arch = targetArchFromContext({}, env);
  const tag = normalizeVersionTag(resolveMiaCoreVersion(rootDir, env));
  if (tag === "latest") {
    throw new Error("Refusing to build a Mia Core release with version 'latest'. Set MIA_CORE_VERSION or package.json miaCoreVersion.");
  }

  const target = rustTargetTriple(platform, arch);
  const binaryName = rustCoreBinaryName(platform);
  const binaryPath = path.join(rootDir, "target", target, "release", binaryName);
  const outDir = path.resolve(env.MIA_CORE_RELEASE_DIR || path.join(rootDir, "dist", "mia-core-release", tag));
  const assetName = miaCoreAssetName(platform, arch, tag);
  const assetPath = path.join(outDir, assetName);
  const skipBuild = env.MIA_CORE_RELEASE_SKIP_BUILD === "1";

  if (!skipBuild) {
    execFileSync("cargo", ["build", "--release", "--target", target, "-p", "mia-core-app", "--bin", "mia-core"], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
  }

  const stat = fs.statSync(binaryPath);
  if (!stat.isFile()) {
    throw new Error(`Mia Core release binary not found at ${binaryPath}`);
  }

  ensureDirectory(outDir);
  if (normalizePlatform(platform) === "win32") {
    const ps = `Compress-Archive -Path '${binaryPath.replace(/'/g, "''")}' -DestinationPath '${assetPath.replace(/'/g, "''")}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { cwd: rootDir, stdio: "inherit" });
  } else {
    execFileSync("tar", ["-C", path.dirname(binaryPath), "-czf", assetPath, binaryName], { cwd: rootDir, stdio: "inherit" });
  }

  const sha256 = sha256File(assetPath);
  const bytes = fs.statSync(assetPath).size;
  fs.writeFileSync(path.join(outDir, `${assetName}.sha256`), `${sha256}  ${assetName}\n`, "utf8");
  const asset = {
    name: assetName,
    platform: normalizePlatform(platform),
    arch: normalizeArch(arch),
    target,
    bytes,
    sha256
  };
  const existingManifest = readJsonIfExists(path.join(outDir, "manifest.json"));
  const assets = mergeReleaseAssets(existingManifest, asset);
  fs.writeFileSync(
    path.join(outDir, "mia-core-checksums.txt"),
    `${assets.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`,
    "utf8"
  );
  const manifest = {
    tag_name: tag,
    version: tag,
    generatedAt: new Date().toISOString(),
    assets
  };
  writeJson(path.join(outDir, "manifest.json"), manifest);
  writeJson(path.join(path.dirname(outDir), "latest.json"), manifest);
  console.log(`[build-mia-core-release] ${assetPath}`);
  console.log(`[build-mia-core-release] sha256 ${sha256}`);
  return { assetPath, assetName, sha256, bytes, platform: normalizePlatform(platform), arch: normalizeArch(arch), target, tag };
}

module.exports = { buildMiaCoreRelease };

if (require.main === module) {
  try {
    buildMiaCoreRelease();
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
