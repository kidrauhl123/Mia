"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { mergeEngineBackups } = require("../scripts/merge-engine-backups.js");

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeTarget(root, targetId, body) {
  const fileName = `hermes-1-${targetId}.zip`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, fileName), body);
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    engines: {
      hermes: {
        version: "1",
        runtimeVersion: "1",
        targets: {
          [targetId]: {
            url: `https://mia.gifgif.cn/downloads/engine-backups/v1/${fileName}`,
            sha256: checksum(body),
            bytes: Buffer.byteLength(body),
            archiveRoot: targetId
          }
        }
      }
    }
  }, null, 2)}\n`);
}

test("mergeEngineBackups combines native target manifests and verifies archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-backup-merge-"));
  try {
    writeTarget(path.join(root, "input", "arm"), "darwin-arm64", "arm");
    writeTarget(path.join(root, "input", "intel"), "darwin-x64", "intel");
    const result = mergeEngineBackups({
      inputRoot: path.join(root, "input"),
      outputDir: path.join(root, "output"),
      requiredTargets: ["darwin-arm64", "darwin-x64"]
    });
    assert.deepEqual(Object.keys(result.manifest.engines.hermes.targets).sort(), ["darwin-arm64", "darwin-x64"]);
    assert.equal(fs.readFileSync(path.join(root, "output", "hermes-1-darwin-x64.zip"), "utf8"), "intel");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mergeEngineBackups fails when a required target is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-backup-missing-"));
  try {
    writeTarget(path.join(root, "input", "arm"), "darwin-arm64", "arm");
    assert.throws(() => mergeEngineBackups({
      inputRoot: path.join(root, "input"),
      outputDir: path.join(root, "output"),
      requiredTargets: ["darwin-arm64", "win32-x64"]
    }), /Missing hermes backup for win32-x64/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
