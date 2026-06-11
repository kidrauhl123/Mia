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
  assert.doesNotMatch(pkg.scripts["dist:mac:intel"], /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:mac:x64"], /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:win"], /hermes:runtime/);
});

test("electron-builder resources exclude Hermes runtime", () => {
  const pkg = packageJson();

  assert.doesNotMatch(JSON.stringify(pkg.build.mac || {}), /vendor\/hermes-runtime/);
  assert.doesNotMatch(JSON.stringify(pkg.build.win || {}), /vendor\/hermes-runtime/);
});

test("desktop auto-update uses Mia generic update source instead of GitHub", () => {
  const pkg = packageJson();
  assert.deepEqual(pkg.build.publish, {
    provider: "generic",
    url: "https://mia.gifgif.cn/updates/"
  });

  const macPublisher = fs.readFileSync(path.join(root, "scripts/publish-mac-update.js"), "utf8");
  const winPublisher = fs.readFileSync(path.join(root, "scripts/publish-win-update.js"), "utf8");
  for (const source of [macPublisher, winPublisher]) {
    assert.match(source, /dist", "mia-updates"/);
    assert.match(source, /MIA_UPDATE_DEPLOY/);
    assert.match(source, /\/var\/www\/mia-updates\//);
    assert.doesNotMatch(source, /gh\(["']release|github release/i);
  }
});

test("desktop packaging scripts clean stale release artifacts before building", () => {
  const pkg = packageJson();
  const cleanCommand = "node scripts/clean-release.js";
  const tidyCommand = "node scripts/clean-release.js --tidy";

  assert.equal(pkg.scripts["clean:release"], cleanCommand);
  assert.equal(pkg.scripts["tidy:release"], tidyCommand);
  for (const scriptName of ["pack", "dist:mac", "dist:mac:intel", "dist:win"]) {
    if (scriptName === "dist:win") {
      assert.equal(pkg.scripts[scriptName], "node scripts/build-win.js");
      continue;
    }
    assert.match(
      pkg.scripts[scriptName],
      new RegExp(`(^|&& )npm run clean:release && .*electron-builder`),
      `${scriptName} should clean release before invoking electron-builder`
    );
  }
  for (const scriptName of ["dist:mac", "dist:mac:intel", "dist:win"]) {
    if (scriptName === "dist:win") {
      assert.equal(pkg.scripts[scriptName], "node scripts/build-win.js");
      continue;
    }
    assert.match(
      pkg.scripts[scriptName],
      /electron-builder[\s\S]*&& npm run tidy:release$/,
      `${scriptName} should tidy intermediate release artifacts after electron-builder`
    );
  }
  assert.match(pkg.scripts["dist:mac"], /electron-builder\.mac-arm64\.js/);
  assert.match(pkg.scripts["dist:mac"], /--arm64/);
  assert.match(pkg.scripts["dist:mac"], /--mac dir zip/);
  assert.match(pkg.scripts["dist:mac"], /MIA_MAC_DMG_LABEL=Apple-Silicon node scripts\/create-mac-dmg\.js/);
  assert.match(pkg.scripts["dist:mac:intel"], /electron-builder\.mac-intel\.js/);
  assert.match(pkg.scripts["dist:mac:intel"], /--x64/);
  assert.match(pkg.scripts["dist:mac:intel"], /--mac dir zip/);
  assert.match(pkg.scripts["dist:mac:intel"], /MIA_MAC_DMG_LABEL=Intel node scripts\/create-mac-dmg\.js/);
  assert.match(pkg.scripts["dist:mac:x64"], /dist:mac:intel/);

  const winBuilder = fs.readFileSync(path.join(root, "scripts", "build-win.js"), "utf8");
  assert.match(winBuilder, /clean-release\.js/);
  assert.match(winBuilder, /electron-builder/);
  assert.match(winBuilder, /"--win", "nsis", "--publish", "never"/);
  assert.match(winBuilder, /"--tidy"/);
  assert.match(winBuilder, /ELECTRON_MIRROR/);
  assert.match(winBuilder, /ELECTRON_BUILDER_BINARIES_MIRROR/);
});

test("base DMG artifact name uses the real architecture by default", () => {
  const pkg = packageJson();

  assert.equal(pkg.build.dmg.artifactName, "${productName}-${version}-${arch}.${ext}");
});

test("Apple Silicon macOS build config labels DMG artifacts for Apple Silicon Macs", () => {
  const source = fs.readFileSync(path.join(root, "electron-builder.mac-arm64.js"), "utf8");

  assert.match(source, /artifactName:\s*"\$\{productName\}-\$\{version\}-Apple-Silicon\.\$\{ext\}"/);
  assert.match(source, /target:\s*\["dir", "zip"\]/);
});

test("Intel macOS build config labels DMG artifacts for Intel Macs", () => {
  const source = fs.readFileSync(path.join(root, "electron-builder.mac-intel.js"), "utf8");

  assert.match(source, /artifactName:\s*"\$\{productName\}-\$\{version\}-Intel\.\$\{ext\}"/);
  assert.match(source, /target:\s*\["dir", "zip"\]/);
  assert.match(source, /identity:\s*"XiaoChuan Technology Co\., Ltd\. \(S4NWU843M5\)"/);
  assert.match(source, /hardenedRuntime:\s*true/);
});

test("custom macOS DMG script writes a Finder drag-to-Applications layout", () => {
  const pkg = packageJson();
  const dmg = pkg.build.dmg;
  const dmgScript = fs.readFileSync(path.join(root, "scripts", "create-mac-dmg.js"), "utf8");
  const dsStoreScript = fs.readFileSync(path.join(root, "scripts", "write-dmg-ds-store.py"), "utf8");

  assert.equal(dmg.background, "build/dmg-background.png");
  assert.equal(dmg.iconSize, 96);
  assert.equal(dmg.iconTextSize, 14);
  assert.deepEqual(dmg.window, { width: 600, height: 420 });
  assert.deepEqual(dmg.contents, [
    { x: 180, y: 238, type: "file" },
    { x: 420, y: 238, type: "link", path: "/Applications" }
  ]);
  assert.match(dmgScript, /writeDsStoreLayout/);
  assert.match(dmgScript, /python3", \["-m", "venv", venvDir\]/);
  assert.match(dmgScript, /"ds-store==1\.3\.1"/);
  assert.match(dmgScript, /"mac-alias==2\.2\.2"/);
  assert.match(dmgScript, /write-dmg-ds-store\.py/);
  assert.match(dmgScript, /MIA_DMG_PYTHON/);
  assert.match(dsStoreScript, /DSStore\.open/);
  assert.match(dsStoreScript, /Bookmark\.for_file\(background_path\)\.to_bytes\(\)/);
  assert.match(dsStoreScript, /"backgroundImageAlias": background_bookmark/);
  assert.match(dsStoreScript, /"ShowToolbar": False/);
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
    "Mia-0.1.1-Intel.dmg",
    "Mia-0.1.1-Setup.exe",
    "Mia-0.1.1-Setup.exe.blockmap",
    "Mia-0.1.0-arm64-mac.zip",
    "Mia-0.1.0-Intel.dmg",
    "Mia-0.1.0-Setup.exe",
    "Mia-0.1.0-android.apk",
    "latest.yml",
    "builder-debug.yml"
  ]) {
    fs.writeFileSync(path.join(releaseDir, file), file);
  }
  fs.writeFileSync(path.join(releaseDir, "mac-arm64", "Mia.app"), "app");

  childProcess.execFileSync(process.execPath, [path.join(root, "scripts/clean-release.js"), "--tidy"], {
    cwd: root,
    // Pin the version so the fixture (0.1.1 distributables) is bump-independent.
    env: { ...process.env, MIA_RELEASE_DIR: releaseDir, MIA_RELEASE_VERSION: "0.1.1" },
  });

  assert.deepEqual(fs.readdirSync(releaseDir).sort(), [
    "Mia-0.1.1-Apple-Silicon.dmg",
    "Mia-0.1.1-Intel.dmg",
    "Mia-0.1.1-Setup.exe",
    "Mia-0.1.1-Setup.exe.blockmap",
    "Mia-0.1.1-arm64-mac.zip",
    "Mia-0.1.1-arm64-mac.zip.blockmap",
    "latest-mac.yml",
    "latest.yml",
  ]);
});
