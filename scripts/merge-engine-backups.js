#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function collectManifests(inputRoot) {
  const manifests = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile() && entry.name === "manifest.json") manifests.push(fullPath);
    }
  }
  walk(inputRoot);
  return manifests.sort();
}

function archiveNameFromTarget(target) {
  const parsed = new URL(String(target?.url || ""));
  const fileName = decodeURIComponent(path.posix.basename(parsed.pathname));
  if (!fileName || fileName !== path.basename(fileName) || !fileName.endsWith(".zip")) {
    throw new Error(`Invalid engine backup archive URL: ${target?.url || ""}`);
  }
  return fileName;
}

function mergeEngineBackups({ inputRoot, outputDir, requiredTargets = [] }) {
  const manifests = collectManifests(inputRoot);
  if (!manifests.length) throw new Error(`No engine backup manifests found under ${inputRoot}`);

  fs.mkdirSync(outputDir, { recursive: true });
  const merged = { schemaVersion: 1, engines: {} };

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || !manifest.engines || typeof manifest.engines !== "object") {
      throw new Error(`Unsupported engine backup manifest: ${manifestPath}`);
    }

    for (const [engineId, engine] of Object.entries(manifest.engines)) {
      const current = merged.engines[engineId];
      if (current && (current.version !== engine.version || current.runtimeVersion !== engine.runtimeVersion)) {
        throw new Error(`Pinned version mismatch for ${engineId} in ${manifestPath}`);
      }
      const destination = current || {
        version: String(engine.version || ""),
        runtimeVersion: String(engine.runtimeVersion || ""),
        targets: {}
      };
      if (!destination.version || !destination.runtimeVersion) {
        throw new Error(`Missing pinned version metadata for ${engineId} in ${manifestPath}`);
      }

      for (const [targetId, target] of Object.entries(engine.targets || {})) {
        const fileName = archiveNameFromTarget(target);
        const sourcePath = path.join(path.dirname(manifestPath), fileName);
        const stat = fs.statSync(sourcePath);
        const checksum = sha256(sourcePath);
        if (!stat.isFile() || stat.size !== target.bytes || checksum !== target.sha256) {
          throw new Error(`Archive integrity mismatch for ${engineId}/${targetId}: ${sourcePath}`);
        }
        const existing = destination.targets[targetId];
        if (existing && JSON.stringify(existing) !== JSON.stringify(target)) {
          throw new Error(`Conflicting target metadata for ${engineId}/${targetId}`);
        }
        const outputPath = path.join(outputDir, fileName);
        if (fs.existsSync(outputPath) && sha256(outputPath) !== checksum) {
          throw new Error(`Conflicting archive contents for ${fileName}`);
        }
        fs.copyFileSync(sourcePath, outputPath);
        destination.targets[targetId] = target;
      }
      merged.engines[engineId] = destination;
    }
  }

  for (const [engineId, engine] of Object.entries(merged.engines)) {
    for (const targetId of requiredTargets) {
      if (!engine.targets[targetId]) throw new Error(`Missing ${engineId} backup for ${targetId}`);
    }
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, manifestPath);
  process.stdout.write(`[merge-engine-backups] merged ${manifests.length} manifests into ${manifestPath}\n`);
  return { manifestPath, manifest: merged };
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--output", "--required-targets"].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return {
    inputRoot: path.resolve(values.input || "dist/engine-backups-input"),
    outputDir: path.resolve(values.output || "dist/engine-backups/v1"),
    requiredTargets: String(values["required-targets"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };
}

module.exports = { archiveNameFromTarget, collectManifests, mergeEngineBackups, parseArgs, sha256 };

if (require.main === module) {
  try {
    mergeEngineBackups(parseArgs());
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}
