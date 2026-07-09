const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { buildMiaCoreRelease } = require("../scripts/build-mia-core-release.js");

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

    buildMiaCoreRelease({
      rootDir,
      execFileSync,
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

    const checksums = fs.readFileSync(path.join(releaseDir, "mia-core-checksums.txt"), "utf8");
    assert.match(checksums, /mia-core-v9\.9\.9-aarch64-apple-darwin\.tar\.gz/);
    assert.match(checksums, /mia-core-v9\.9\.9-x86_64-apple-darwin\.tar\.gz/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
