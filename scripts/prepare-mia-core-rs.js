"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

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

function bundledRustCorePath(rootDir, platform, arch) {
  return path.join(
    rootDir,
    "resources",
    "bundled-mia-core",
    `${targetPlatformFromContext({ electronPlatformName: platform }, {})}-${normalizeArch(arch)}`,
    rustCoreBinaryName(platform)
  );
}

function releaseRustCorePath(rootDir, platform = process.platform) {
  return path.join(rootDir, "target", "release", rustCoreBinaryName(platform));
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

async function prepareMiaCoreRs(context = {}, options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT);
  const env = options.env || process.env;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const platform = targetPlatformFromContext(context, env);
  const arch = targetArchFromContext(context, env);
  const explicitSource = String(env.MIA_CORE_RS_BIN || "").trim();
  let source = explicitSource ? path.resolve(explicitSource) : "";

  if (!source) {
    execFileSync("cargo", ["build", "--release", "-p", "mia-core-app", "--bin", "mia-core"], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    source = releaseRustCorePath(rootDir, platform);
  }

  const stat = assertReadableFile(source, "Mia Rust Core binary");
  const dest = bundledRustCorePath(rootDir, platform, arch);
  fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
  const bytes = fs.statSync(dest).size;
  console.log(`[prepare-mia-core-rs] staged Rust Core (${bytes} bytes) for ${platform}-${arch} from ${source} -> ${dest}`);
  return { platform, arch, source, dest, bytes: bytes || stat.size };
}

module.exports = prepareMiaCoreRs;
Object.assign(module.exports, {
  bundledRustCorePath,
  normalizeArch,
  normalizePlatform,
  prepareMiaCoreRs,
  releaseRustCorePath,
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
