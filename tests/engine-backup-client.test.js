const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const AdmZip = require("adm-zip");

const {
  createEngineBackupClient,
  safeArchivePath,
  validateEntry
} = require("../src/main/engine-backup-client.js");

const MANIFEST_URL = "https://mia.example/engine-backups/manifest.json";
const ARCHIVE_URL = "https://mia.example/engine-backups/codex.zip";

function archiveBuffer() {
  const zip = new AdmZip();
  zip.addFile("payload/hello.txt", Buffer.from("new runtime\n"));
  return zip.toBuffer();
}

function manifestFor(buffer, overrides = {}) {
  return {
    schemaVersion: 1,
    engines: {
      codex: {
        version: "0.144.5",
        runtimeVersion: "1.1.4",
        targets: {
          "win32-x64": {
            url: ARCHIVE_URL,
            sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
            bytes: buffer.length,
            archiveRoot: "payload",
            ...overrides
          }
        }
      }
    }
  };
}

function clientFor(buffer, manifest = manifestFor(buffer)) {
  return createEngineBackupClient({
    manifestUrl: MANIFEST_URL,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) {
        return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === ARCHIVE_URL) {
        return new Response(buffer, { status: 200, headers: { "content-length": String(buffer.length) } });
      }
      return new Response("not found", { status: 404 });
    }
  });
}

test("engine backup download verifies SHA-256 and atomically replaces the private runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-backup-client-"));
  const destination = path.join(root, "managed", "codex");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "old.txt"), "old runtime\n");
  const progress = [];
  try {
    const buffer = archiveBuffer();
    const client = clientFor(buffer);
    await client.install({
      engineId: "codex",
      targetKey: "win32-x64",
      destination,
      expectedVersion: "0.144.5",
      expectedRuntimeVersion: "1.1.4",
      validate: async (runtimeRoot) => {
        assert.equal(fs.readFileSync(path.join(runtimeRoot, "hello.txt"), "utf8"), "new runtime\n");
      },
      onProgress: (value) => progress.push(value)
    });

    assert.equal(fs.existsSync(path.join(destination, "old.txt")), false);
    assert.equal(fs.readFileSync(path.join(destination, "hello.txt"), "utf8"), "new runtime\n");
    assert.ok(progress.some((value) => value.stage === "download"));
    assert.ok(progress.some((value) => value.stage === "verify"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checksum mismatch leaves the previous private runtime untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-backup-checksum-"));
  const destination = path.join(root, "managed", "codex");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "old.txt"), "keep me\n");
  try {
    const buffer = archiveBuffer();
    const client = clientFor(buffer, manifestFor(buffer, { sha256: "0".repeat(64) }));
    await assert.rejects(() => client.install({
      engineId: "codex",
      targetKey: "win32-x64",
      destination,
      expectedVersion: "0.144.5",
      expectedRuntimeVersion: "1.1.4",
      validate: async () => {}
    }), /checksum mismatch/);
    assert.equal(fs.readFileSync(path.join(destination, "old.txt"), "utf8"), "keep me\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("backup manifests are pinned and archive paths cannot escape extraction", () => {
  const buffer = archiveBuffer();
  const manifest = manifestFor(buffer);
  assert.throws(() => validateEntry(manifest, "codex", "win32-x64", {
    version: "0.145.0",
    runtimeVersion: "1.1.4"
  }), /version mismatch/);
  assert.equal(safeArchivePath("payload/runtime"), "payload/runtime");
  assert.equal(safeArchivePath("../outside"), "");
  assert.equal(safeArchivePath("C:\\outside"), "");
  assert.equal(safeArchivePath("/outside"), "");
});
