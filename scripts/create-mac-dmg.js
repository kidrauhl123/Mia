const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const appName = `${productName}.app`;
const backgroundImage = path.join(root, "build", "dmg-background.png");
// electron-builder writes to release/mac/ on the host arch, or arch-specific
// directories when a cross-arch build is requested.
const sourceCandidates = [
  { dir: "mac-x64", label: "Intel" },
  { dir: "mac-arm64", label: "Apple-Silicon" },
  { dir: "mac", label: process.arch === "x64" ? "Intel" : "Apple-Silicon" }
]
  .map((entry) => ({ ...entry, appPath: path.join(root, "release", entry.dir, appName) }))
  .filter((entry) => fs.existsSync(entry.appPath));
const sourceEntry = sourceCandidates[0];
const source = sourceEntry?.appPath;
const targetLabel = process.env.MIA_MAC_DMG_LABEL || sourceEntry?.label || "Apple-Silicon";
const target = path.join(root, "release", `${productName}-${version}-${targetLabel}.dmg`);
const windowBounds = [200, 120, 800, 540];
const appIconPosition = [180, 238];
const applicationsIconPosition = [420, 238];
const dmgPython = process.env.MIA_DMG_PYTHON ||
  path.join(os.homedir(), ".cache", "mia-build-deps", "mia-dmg-python", "bin", "python");
const defaultDmgPython = !process.env.MIA_DMG_PYTHON;

if (process.platform !== "darwin") {
  throw new Error("create-mac-dmg.js only runs on macOS.");
}

if (!source) {
  throw new Error(`Missing packaged app under release/mac{,-arm64,-x64}/${appName}`);
}

if (!fs.existsSync(backgroundImage)) {
  throw new Error(`Missing DMG background image at ${path.relative(root, backgroundImage)}`);
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function detachVolume(volumePath) {
  if (!volumePath) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      execFileSync("hdiutil", ["detach", volumePath], { stdio: "inherit" });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      execFileSync("sleep", ["1"]);
    }
  }
}

function attachImage(imagePath) {
  const output = execFileSync("hdiutil", [
    "attach",
    imagePath,
    "-noverify",
    "-noautoopen",
    "-readwrite"
  ], { cwd: root, encoding: "utf8" });
  process.stdout.write(output);
  const mountLine = output.split(/\r?\n/).find((line) => /\/Volumes\//.test(line));
  const match = mountLine && mountLine.match(/(\/Volumes\/.+)$/);
  if (!match) {
    throw new Error(`Unable to find mounted volume path in hdiutil output:\n${output}`);
  }
  return match[1].trim();
}

function applyFinderLayout(volumePath) {
  const mountedBackgroundImage = path.join(volumePath, ".background", "dmg-background.png");
  const script = `
tell application "Finder"
  tell disk ${appleScriptString(productName)}
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {${windowBounds.join(", ")}}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set text size of viewOptions to 14
    set bgFile to POSIX file ${appleScriptString(mountedBackgroundImage)} as alias
    set background picture of viewOptions to bgFile
    set position of item ${appleScriptString(appName)} of container window to {${appIconPosition.join(", ")}}
    set position of item "Applications" of container window to {${applicationsIconPosition.join(", ")}}
    update without registering applications
    delay 1
    close
  end tell
end tell
`;

  execFileSync("osascript", ["-e", script], { stdio: "inherit" });
}

function canImportDmgPythonDeps() {
  if (!fs.existsSync(dmgPython)) return false;
  try {
    execFileSync(dmgPython, ["-c", "import ds_store, mac_alias"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureDmgPython() {
  if (canImportDmgPythonDeps()) return;

  if (!defaultDmgPython) {
    throw new Error(
      `DMG Python at ${dmgPython} cannot import ds_store/mac_alias. ` +
      "Install ds-store==1.3.1 and mac-alias==2.2.2 into that interpreter."
    );
  }

  const venvDir = path.dirname(path.dirname(dmgPython));
  fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  if (!fs.existsSync(dmgPython)) {
    execFileSync("python3", ["-m", "venv", venvDir], { stdio: "inherit" });
  }
  execFileSync(dmgPython, [
    "-m",
    "pip",
    "install",
    "ds-store==1.3.1",
    "mac-alias==2.2.2"
  ], { stdio: "inherit" });

  if (!canImportDmgPythonDeps()) {
    throw new Error(`Unable to prepare DMG Python helper at ${dmgPython}`);
  }
}

function writeDsStoreLayout(volumePath) {
  ensureDmgPython();

  execFileSync(dmgPython, [
    path.join(root, "scripts", "write-dmg-ds-store.py"),
    "--volume", volumePath,
    "--background", path.join(volumePath, ".background", "dmg-background.png"),
    "--window-origin", `${windowBounds[0]},${windowBounds[1]}`,
    "--window-size", `${windowBounds[2] - windowBounds[0]},${windowBounds[3] - windowBounds[1]}`,
    "--app-position", appIconPosition.join(","),
    "--applications-position", applicationsIconPosition.join(","),
    "--icon-size", "96",
    "--text-size", "14",
    "--app-name", appName
  ], { stdio: "inherit" });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dmg-"));
const stagingDir = path.join(tempRoot, "staging");
const rwImage = path.join(tempRoot, `${productName}-rw.dmg`);
let mountedVolume = null;
fs.mkdirSync(stagingDir, { recursive: true });

try {
  execFileSync("ditto", [source, path.join(stagingDir, appName)], { stdio: "inherit" });
  fs.symlinkSync("/Applications", path.join(stagingDir, "Applications"));
  fs.mkdirSync(path.join(stagingDir, ".background"), { recursive: true });
  fs.copyFileSync(backgroundImage, path.join(stagingDir, ".background", "dmg-background.png"));

  execFileSync("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stagingDir,
    "-fs",
    "HFS+",
    "-format",
    "UDRW",
    "-ov",
    rwImage
  ], { cwd: root, stdio: "inherit" });

  mountedVolume = attachImage(rwImage);

  execFileSync("chflags", ["hidden", path.join(mountedVolume, ".background")], { stdio: "inherit" });
  writeDsStoreLayout(mountedVolume);
  applyFinderLayout(mountedVolume);
  detachVolume(mountedVolume);
  mountedVolume = null;

  fs.rmSync(target, { force: true });
  execFileSync("hdiutil", [
    "convert",
    rwImage,
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    "-o",
    target
  ], { cwd: root, stdio: "inherit" });
} finally {
  if (mountedVolume) {
    try {
      execFileSync("hdiutil", ["detach", mountedVolume, "-force"], { stdio: "ignore" });
    } catch {
      // The image may already be detached.
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(target);
