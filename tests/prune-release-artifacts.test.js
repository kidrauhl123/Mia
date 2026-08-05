const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  applyReleaseArtifactPrune,
  normalizeRemoteDirectory,
  parseKeepVersions,
  planReleaseArtifactPrune,
  runRemoteReleaseArtifactPrune,
} = require("../scripts/prune-release-artifacts.js");

function writeArtifact(directory, name, contents = name) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), contents);
}

function removedNames(plan) {
  return plan.removed.map((entry) => entry.fileName).sort();
}

test("release retention keeps current plus two rollback versions and protects active feeds", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mia-release-retention-"));
  const updates = path.join(temporary, "updates");
  const downloads = path.join(temporary, "downloads");
  try {
    for (const version of ["0.1.9", "0.1.10", "0.1.11", "0.1.12", "0.1.13"]) {
      writeArtifact(updates, `Mia-${version}-arm64-mac.zip`);
      writeArtifact(updates, `Mia-${version}-arm64-mac.zip.blockmap`);
      writeArtifact(updates, `Mia-${version}-Update.exe`);
      writeArtifact(updates, `Mia-${version}-Update.exe.blockmap`);
    }
    writeArtifact(updates, "latest-mac.yml", "version: 0.1.10\npath: Mia-0.1.10-arm64-mac.zip\n");
    writeArtifact(updates, "latest.yml", "version: 0.1.10\npath: Mia-0.1.10-Update.exe\n");
    writeArtifact(updates, "latest-mac.yml.hold-old", "hold");

    for (const versionCode of [1, 2, 3, 4, 5]) {
      writeArtifact(downloads, `mia-android-${versionCode}.apk`);
    }
    writeArtifact(downloads, "mia-android-dev-arm64.apk");
    writeArtifact(downloads, "mia-android-latest.apk");
    writeArtifact(downloads, "mia-mobile-update.json", JSON.stringify({
      android: { apkUrl: "https://mia.gifgif.cn/downloads/mia-android-2.apk?cache=1" },
    }));

    const [updatePlan, downloadPlan] = planReleaseArtifactPrune({
      directories: [updates, downloads],
      keepVersions: 3,
    });

    assert.deepEqual(removedNames(updatePlan), [
      "Mia-0.1.9-Update.exe",
      "Mia-0.1.9-Update.exe.blockmap",
      "Mia-0.1.9-arm64-mac.zip",
      "Mia-0.1.9-arm64-mac.zip.blockmap",
    ]);
    assert.deepEqual(removedNames(downloadPlan), ["mia-android-1.apk"]);
    assert.ok(updatePlan.retained.some((entry) => entry.fileName === "Mia-0.1.10-arm64-mac.zip" && entry.protectedByFeed));
    assert.ok(downloadPlan.retained.some((entry) => entry.fileName === "mia-android-2.apk" && entry.protectedByFeed));

    applyReleaseArtifactPrune([updatePlan, downloadPlan]);
    for (const entry of [...updatePlan.removed, ...downloadPlan.removed]) assert.equal(fs.existsSync(entry.fullPath), false);
    assert.equal(fs.existsSync(path.join(updates, "Mia-0.1.10-arm64-mac.zip")), true);
    assert.equal(fs.existsSync(path.join(downloads, "mia-android-2.apk")), true);
    assert.equal(fs.existsSync(path.join(downloads, "mia-android-dev-arm64.apk")), true);
    assert.equal(fs.existsSync(path.join(downloads, "mia-android-latest.apk")), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("release retention rejects unsafe windows and streams the same helper to a remote node process", () => {
  assert.throws(() => parseKeepVersions(0), /positive integer/);
  assert.throws(() => normalizeRemoteDirectory("/var/www/../root"), /absolute plain path/);
  const calls = [];
  runRemoteReleaseArtifactPrune({
    remote: "mia-jms-deploy",
    directories: ["/updates", "/downloads"],
    keepVersions: 3,
    apply: true,
    cwd: "/tmp/mia",
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args.slice(0, 4), ["mia-jms-deploy", "node", "-", "--keep"]);
  assert.ok(calls[0].args.includes("--apply"));
  assert.match(String(calls[0].options.input), /planReleaseArtifactPrune/);
});

test("all standard publish and Cloud install paths enforce the release-artifact window", () => {
  const root = path.resolve(__dirname, "..");
  const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source("scripts/publish-mac-update.js"), /pruneRemoteReleaseArtifacts\(Math\.max\(1, releaseArtifactKeep - 1\), "pre-publish"\)/);
  assert.match(source("scripts/publish-mac-update.js"), /pruneRemoteReleaseArtifacts\(releaseArtifactKeep, "post-publish"\)/);
  assert.match(source("scripts/publish-win-update.js"), /runRemoteReleaseArtifactPrune/);
  assert.match(source("scripts/publish-mobile-update.js"), /runRemoteReleaseArtifactPrune/);
  assert.match(source("scripts/build-cloud-release.js"), /copyFile\("scripts\/prune-release-artifacts\.js"/);
  assert.match(source("scripts/install-cloud-release-local.sh"), /prune-release-artifacts\.js[\s\S]*?--keep "\$RELEASE_ARTIFACT_KEEP"/);
  assert.match(source("scripts/deploy-cloud-release.sh"), /prune-release-artifacts\.js[\s\S]*?--keep "\\\$RELEASE_ARTIFACT_KEEP"/);
});
