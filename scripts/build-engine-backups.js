#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");

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

function isChildPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkTree(root, onEntry) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      onEntry(entryPath, stat);
      if (stat.isDirectory()) stack.push(entryPath);
    }
  }
}

function modeBits(stat) {
  return Number(stat.mode || 0) & 0o777;
}

function copyTreeDereferencingLinks(source, destination, sourceRealPath, ancestors = new Set()) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const resolved = fs.realpathSync(source);
    if (!isChildPath(sourceRealPath, resolved)) {
      throw new Error(`Refusing to archive symbolic link outside source: ${source}`);
    }
    return copyTreeDereferencingLinks(resolved, destination, sourceRealPath, ancestors);
  }
  if (stat.isDirectory()) {
    const realDirectory = fs.realpathSync(source);
    if (ancestors.has(realDirectory)) {
      throw new Error(`Refusing recursive symbolic link while staging engine backup: ${source}`);
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(realDirectory);
    fs.mkdirSync(destination, { recursive: false, mode: modeBits(stat) });
    for (const entry of fs.readdirSync(source)) {
      copyTreeDereferencingLinks(
        path.join(source, entry),
        path.join(destination, entry),
        sourceRealPath,
        nextAncestors
      );
    }
    fs.chmodSync(destination, modeBits(stat));
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, modeBits(stat));
    return;
  }
  throw new Error(`Unsupported special file in engine backup source: ${source}`);
}

// Python build-standalone intentionally ships convenience symlinks such as
// python3 -> python3.11. End-user backup extraction rejects every symlink, so
// make a private, dereferenced staging tree before archiving. We first assert
// each link resolves inside the build output: a packaging job must never pull
// arbitrary host files into a signed backup.
function materializeArchiveSource(sourceDir) {
  const source = path.resolve(sourceDir);
  const sourceRealPath = fs.realpathSync(source);
  walkTree(source, (entryPath, stat) => {
    if (!stat.isSymbolicLink()) return;
    const resolved = fs.realpathSync(entryPath);
    if (!isChildPath(sourceRealPath, resolved)) {
      throw new Error(`Refusing to archive symbolic link outside source: ${entryPath}`);
    }
  });

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-backup-stage-"));
  const stagedSource = path.join(stagingRoot, path.basename(source));
  try {
    copyTreeDereferencingLinks(source, stagedSource, sourceRealPath);
    walkTree(stagedSource, (entryPath, stat) => {
      if (stat.isSymbolicLink()) {
        throw new Error(`Engine backup staging unexpectedly retained symbolic link: ${entryPath}`);
      }
    });
    return { stagingRoot, stagedSource };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function archiveSymbolicLinks(archivePath) {
  const zip = new AdmZip(archivePath);
  return zip.getEntries().filter((entry) => {
    const unixMode = (Number(entry.header?.attr || 0) >>> 16) & 0xffff;
    return (unixMode & 0o170000) === 0o120000;
  });
}

function assertArchiveHasNoSymlinks(archivePath) {
  const links = archiveSymbolicLinks(archivePath);
  if (links.length) {
    throw new Error(`Engine backup archive must not contain symbolic links: ${links[0].entryName}`);
  }
}

function createZip(sourceDir, archivePath, hostPlatform = process.platform, execFileSync = childProcess.execFileSync) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.rmSync(archivePath, { force: true });
  const { stagingRoot, stagedSource } = materializeArchiveSource(sourceDir);
  try {
    const parent = path.dirname(stagedSource);
    const base = path.basename(stagedSource);
    if (hostPlatform === "win32") {
      const command = [
        "$ErrorActionPreference='Stop'",
        `Compress-Archive -LiteralPath ${powershellLiteral(stagedSource)} -DestinationPath ${powershellLiteral(archivePath)} -CompressionLevel Optimal -Force`
      ].join("; ");
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
    } else if (hostPlatform === "darwin") {
      execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", stagedSource, archivePath], { stdio: "inherit" });
    } else {
      execFileSync("zip", ["-qry", archivePath, base], { cwd: parent, stdio: "inherit" });
    }
    // Keep the build-time rule identical to the install-time guard. A future
    // archiver change cannot silently publish an unusable stable runtime.
    if (fs.existsSync(archivePath)) assertArchiveHasNoSymlinks(archivePath);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function resourceSpecs(target) {
  const hermesVersion = String(packageJson.hermes?.version || "");
  return [
    {
      id: "hermes",
      version: hermesVersion,
      runtimeVersion: String(packageJson.hermes?.packageVersion || ""),
      target: hermesTargetDir(target),
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

function validateHermesRuntimeBuild(spec) {
  const buildInfoPath = path.join(spec.source, "runtime-build-info.json");
  let buildInfo;
  try {
    buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  } catch {
    throw new Error(`Hermes runtime is missing build metadata: ${buildInfoPath}`);
  }
  const expected = {
    target: spec.target,
    hermesVersion: spec.version,
    hermesPackageVersion: spec.runtimeVersion,
    pythonVersion: String(packageJson.hermes?.pythonVersion || ""),
    pbsRelease: String(packageJson.hermes?.pbsRelease || ""),
    hermesWheelSha256: String(packageJson.hermes?.wheelSha256 || ""),
    ddgsVersion: String(packageJson.hermes?.ddgsVersion || "")
  };
  for (const [field, value] of Object.entries(expected)) {
    if (!value) continue;
    if (String(buildInfo?.[field] || "") !== value) {
      throw new Error(`Hermes runtime ${field} mismatch: expected ${value}. Rebuild ${spec.target} before publishing backups.`);
    }
  }
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
    if (spec.id === "hermes") validateHermesRuntimeBuild(spec);
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
  archiveSymbolicLinks,
  assertArchiveHasNoSymlinks,
  buildEngineBackups,
  copyTreeDereferencingLinks,
  createZip,
  hermesTargetDir,
  materializeArchiveSource,
  normalizeTarget,
  powershellLiteral,
  resourceSpecs,
  sha256,
  validateHermesRuntimeBuild
};

if (require.main === module) {
  try {
    buildEngineBackups();
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}
