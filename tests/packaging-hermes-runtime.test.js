const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

test("desktop package scripts do not build Hermes runtime", () => {
  const pkg = packageJson();

  assert.doesNotMatch(pkg.scripts.prepack || "", /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts.pack || "", /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:mac"], /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:win"], /hermes:runtime/);
});

test("electron-builder resources exclude Hermes runtime", () => {
  const pkg = packageJson();

  assert.doesNotMatch(JSON.stringify(pkg.build.mac || {}), /vendor\/hermes-runtime/);
  assert.doesNotMatch(JSON.stringify(pkg.build.win || {}), /vendor\/hermes-runtime/);
});

test("desktop packaging scripts clean stale release artifacts before building", () => {
  const pkg = packageJson();
  const cleanCommand = "node scripts/clean-release.js";
  const tidyCommand = "node scripts/clean-release.js --tidy";

  assert.equal(pkg.scripts["clean:release"], cleanCommand);
  assert.equal(pkg.scripts["tidy:release"], tidyCommand);
  for (const scriptName of ["pack", "dist:mac", "dist:win"]) {
    assert.match(
      pkg.scripts[scriptName],
      new RegExp(`(^|&& )npm run clean:release && .*electron-builder`),
      `${scriptName} should clean release before invoking electron-builder`
    );
  }
  for (const scriptName of ["dist:mac", "dist:win"]) {
    assert.match(
      pkg.scripts[scriptName],
      /electron-builder[\s\S]*&& npm run tidy:release$/,
      `${scriptName} should tidy intermediate release artifacts after electron-builder`
    );
  }
});

test("clean release script removes stale artifacts from the configured release directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-release-clean-"));
  const releaseDir = path.join(tempDir, "release");
  fs.mkdirSync(path.join(releaseDir, "mac-arm64"), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "old.zip"), "old");
  fs.writeFileSync(path.join(releaseDir, "mac-arm64", "Mia.app"), "app");

  childProcess.execFileSync(process.execPath, [path.join(root, "scripts/clean-release.js")], {
    cwd: root,
    env: { ...process.env, MIA_RELEASE_DIR: releaseDir },
  });

  assert.deepEqual(fs.readdirSync(releaseDir), []);
});

test("tidy release script keeps current distributables and removes intermediate or misplaced artifacts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-release-tidy-"));
  const releaseDir = path.join(tempDir, "release");
  fs.mkdirSync(path.join(releaseDir, "mac-arm64"), { recursive: true });
  for (const file of [
    "latest-mac.yml",
    "Mia-0.1.1-arm64-mac.zip",
    "Mia-0.1.1-arm64-mac.zip.blockmap",
    "Mia-0.1.1-Apple-Silicon.dmg",
    "Mia-0.1.0-arm64-mac.zip",
    "Mia-0.1.0-android.apk",
    "builder-debug.yml"
  ]) {
    fs.writeFileSync(path.join(releaseDir, file), file);
  }
  fs.writeFileSync(path.join(releaseDir, "mac-arm64", "Mia.app"), "app");

  childProcess.execFileSync(process.execPath, [path.join(root, "scripts/clean-release.js"), "--tidy"], {
    cwd: root,
    env: { ...process.env, MIA_RELEASE_DIR: releaseDir },
  });

  assert.deepEqual(fs.readdirSync(releaseDir).sort(), [
    "Mia-0.1.1-Apple-Silicon.dmg",
    "Mia-0.1.1-arm64-mac.zip",
    "Mia-0.1.1-arm64-mac.zip.blockmap",
    "latest-mac.yml",
  ]);
});
