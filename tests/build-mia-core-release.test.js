const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { buildMiaCoreRelease } = require("../scripts/build-mia-core-release.js");
const {
  embeddedBuildInfoMarker,
  readCoreBuildInfo
} = require("../scripts/mia-core-build-info.js");
const { coreSourceFingerprint } = require("../scripts/mia-core-source-fingerprint.js");

function writeExecutable(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { mode: 0o755 });
}

test("buildMiaCoreRelease preserves existing architecture assets in manifests", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-release-merge-"));
  try {
    const releaseDir = path.join(rootDir, "dist", "mia-core-release", "v9.9.9");
    writeExecutable(path.join(rootDir, "target", "x86_64-apple-darwin", "release", "mia-core"), "x64 core\n");
    writeExecutable(path.join(rootDir, "target", "aarch64-apple-darwin", "release", "mia-core"), "arm64 core\n");

    const execFileSync = (command, args) => {
      assert.equal(command, "tar");
      const assetPath = args[args.indexOf("-czf") + 1];
      fs.writeFileSync(assetPath, `archive ${path.basename(assetPath)}\n`);
    };
    const buildInfo = {
      releaseVersion: "v9.9.9",
      sourceFingerprint: coreSourceFingerprint(rootDir)
    };

    buildMiaCoreRelease({
      rootDir,
      execFileSync,
      readCoreBuildInfo: () => buildInfo,
      env: {
        MIA_CORE_VERSION: "v9.9.9",
        MIA_CORE_RELEASE_SKIP_BUILD: "1",
        MIA_CORE_RELEASE_DIR: releaseDir,
        MIA_CORE_TARGET_PLATFORM: "darwin",
        MIA_CORE_TARGET_ARCH: "x64"
      }
    });
    buildMiaCoreRelease({
      rootDir,
      execFileSync,
      readCoreBuildInfo: () => buildInfo,
      env: {
        MIA_CORE_VERSION: "v9.9.9",
        MIA_CORE_RELEASE_SKIP_BUILD: "1",
        MIA_CORE_RELEASE_DIR: releaseDir,
        MIA_CORE_TARGET_PLATFORM: "darwin",
        MIA_CORE_TARGET_ARCH: "arm64"
      }
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "manifest.json"), "utf8"));
    const latest = JSON.parse(fs.readFileSync(path.join(rootDir, "dist", "mia-core-release", "latest.json"), "utf8"));
    const names = manifest.assets.map((asset) => asset.name);
    assert.deepEqual(names, [
      "mia-core-v9.9.9-aarch64-apple-darwin.tar.gz",
      "mia-core-v9.9.9-x86_64-apple-darwin.tar.gz"
    ]);
    assert.deepEqual(latest.assets.map((asset) => asset.name), names);
    assert.equal(manifest.sourceFingerprint, buildInfo.sourceFingerprint);

    const checksums = fs.readFileSync(path.join(releaseDir, "mia-core-checksums.txt"), "utf8");
    assert.match(checksums, /mia-core-v9\.9\.9-aarch64-apple-darwin\.tar\.gz/);
    assert.match(checksums, /mia-core-v9\.9\.9-x86_64-apple-darwin\.tar\.gz/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readCoreBuildInfo verifies an embedded identity for a cross-architecture binary", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-cross-build-info-"));
  try {
    const binaryPath = path.join(rootDir, "mia-core");
    const expectedBuildInfo = {
      releaseVersion: "v9.9.9",
      sourceFingerprint: "a".repeat(64)
    };
    fs.writeFileSync(binaryPath, Buffer.concat([
      Buffer.from("binary-prefix\0"),
      Buffer.from(embeddedBuildInfoMarker(expectedBuildInfo)),
      Buffer.from("\0binary-suffix")
    ]));

    const actual = readCoreBuildInfo(binaryPath, {
      execFileSync() {
        throw new Error("unsupported architecture");
      },
      allowEmbeddedFallback: true,
      expectedBuildInfo
    });

    assert.deepEqual(actual, expectedBuildInfo);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
