#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "skills", "_builtin", "officecli-sources.json");

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sourceRecords(manifest) {
  return [
    ...Object.entries(manifest.skills || {}),
    ...Object.entries(manifest.artifacts || {})
  ].map(([id, source]) => ({ id, ...source }));
}

function targetPath(relativePath) {
  const resolved = path.resolve(ROOT, String(relativePath || ""));
  const prefix = `${ROOT}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`OfficeCLI source path escapes the repository: ${relativePath}`);
  return resolved;
}

function verifyBytes(record, bytes) {
  const actual = sha256(bytes);
  if (actual !== record.sha256) {
    throw new Error(`${record.id} SHA-256 mismatch: expected ${record.sha256}, received ${actual}`);
  }
}

function verifyLocal(records) {
  for (const record of records) {
    const destination = targetPath(record.path);
    if (!fs.existsSync(destination)) throw new Error(`${record.id} is missing at ${record.path}`);
    verifyBytes(record, fs.readFileSync(destination));
  }
}

async function download(record) {
  const response = await fetch(record.url, {
    headers: { "user-agent": "Mia-OfficeCLI-vendor-sync/1" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${record.id} download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyBytes(record, bytes);
  return bytes;
}

function atomicWrite(destination, bytes) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.mia-officecli-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function update(records) {
  const downloads = [];
  for (const record of records) downloads.push([record, await download(record)]);
  for (const [record, bytes] of downloads) atomicWrite(targetPath(record.path), bytes);
}

async function main() {
  const action = process.argv[2] || "--check";
  if (!new Set(["--check", "--update"]).has(action)) {
    throw new Error("Usage: node scripts/sync-officecli-skills.js [--check|--update]");
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const records = sourceRecords(manifest);
  if (!records.length) throw new Error("OfficeCLI source manifest contains no files");
  if (action === "--update") await update(records);
  verifyLocal(records);
  process.stdout.write(`OfficeCLI vendored skills verified (${records.length} files).\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { sha256, sourceRecords, targetPath, verifyBytes, verifyLocal };
