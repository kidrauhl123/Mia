#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function normalizeTarget(value = `${process.platform}-${process.arch}`) {
  const target = String(value || "").trim().toLowerCase();
  const aliases = {
    "mac-arm64": "darwin-arm64",
    "mac-x64": "darwin-x64",
    "win-x64": "win32-x64",
    "win-arm64": "win32-arm64"
  };
  return aliases[target] || target;
}

function hermesTargetDir(target) {
  if (target.startsWith("darwin-")) return target.replace("darwin-", "mac-");
  if (target.startsWith("win32-")) return target.replace("win32-", "win-");
  return target;
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createZip(sourceDir, archivePath, hostPlatform = process.platform, execFileSync = childProcess.execFileSync) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.rmSync(archivePath, { force: true });
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);
  if (hostPlatform === "win32") {
    const command = [
      "$ErrorActionPreference='Stop'",
      `Compress-Archive -LiteralPath ${powershellLiteral(sourceDir)} -DestinationPath ${powershellLiteral(archivePath)} -CompressionLevel Optimal -Force`
    ].join("; ");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
    return;
  }
  if (hostPlatform === "darwin") {
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", sourceDir, archivePath], { stdio: "inherit" });
    return;
  }
  execFileSync("zip", ["-qry", archivePath, base], { cwd: parent, stdio: "inherit" });
}

function resourceSpecs(target) {
  const hermesVersion = String(packageJson.hermes?.version || "");
  return [
    {
      id: "hermes",
      version: hermesVersion,
      runtimeVersion: String(packageJson.hermes?.packageVersion || ""),
      source: path.join(root, "vendor", "hermes-runtime", hermesTargetDir(target))
    },
    {
      id: "claude-code",
      version: "2.1.211",
      runtimeVersion: "0.59.0",
      source: path.join(root, "resources", "managed-resources", "acp", "claude-agent-acp", "0.59.0", target)
    },
    {
      id: "codex",
      version: "0.144.5",
      runtimeVersion: "1.1.4",
      source: path.join(root, "resources", "managed-resources", "acp", "codex-acp", "1.1.4", target)
    }
  ];
}

function buildEngineBackups(options = {}) {
  const target = normalizeTarget(options.target || process.argv[2]);
  const outputDir = path.resolve(options.outputDir || process.env.MIA_ENGINE_BACKUP_OUTPUT_DIR || path.join(root, "dist", "engine-backups", "v1"));
  const baseUrl = String(options.baseUrl || process.env.MIA_ENGINE_BACKUP_BASE_URL || "https://mia.gifgif.cn/downloads/engine-backups/v1").replace(/\/$/, "");
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { schemaVersion: 1, engines: {} };
  manifest.schemaVersion = 1;
  manifest.engines ||= {};

  for (const spec of resourceSpecs(target)) {
    if (!fs.statSync(spec.source, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Prepare ${spec.id} for ${target} first; source directory is missing: ${spec.source}`);
    }
    const fileName = `${spec.id}-${spec.version}-${target}.zip`;
    const archivePath = path.join(outputDir, fileName);
    process.stdout.write(`[engine-backups] archiving ${spec.id} ${spec.version} for ${target}\n`);
    createZip(spec.source, archivePath, options.hostPlatform || process.platform);
    const stat = fs.statSync(archivePath);
    manifest.engines[spec.id] ||= { version: spec.version, runtimeVersion: spec.runtimeVersion, targets: {} };
    if (manifest.engines[spec.id].version !== spec.version || manifest.engines[spec.id].runtimeVersion !== spec.runtimeVersion) {
      throw new Error(`Existing manifest has a different pinned version for ${spec.id}. Remove ${manifestPath} before rebuilding.`);
    }
    manifest.engines[spec.id].targets[target] = {
      url: `${baseUrl}/${encodeURIComponent(fileName)}`,
      sha256: sha256(archivePath),
      bytes: stat.size,
      archiveRoot: path.basename(spec.source)
    };
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`[engine-backups] manifest ready: ${manifestPath}\n`);
  return { manifestPath, manifest, outputDir, target };
}

module.exports = {
  buildEngineBackups,
  createZip,
  hermesTargetDir,
  normalizeTarget,
  powershellLiteral,
  resourceSpecs,
  sha256
};

if (require.main === module) {
  try {
    buildEngineBackups();
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}
