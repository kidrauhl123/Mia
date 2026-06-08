const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const appName = `${productName}.app`;
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

if (process.platform !== "darwin") {
  throw new Error("create-mac-dmg.js only runs on macOS.");
}

if (!source) {
  throw new Error(`Missing packaged app under release/mac{,-arm64,-x64}/${appName}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dmg-"));
const stagingDir = path.join(tempRoot, "staging");
fs.mkdirSync(stagingDir, { recursive: true });

try {
  fs.cpSync(source, path.join(stagingDir, appName), { recursive: true });
  fs.symlinkSync("/Applications", path.join(stagingDir, "Applications"));
  fs.rmSync(target, { force: true });
  execFileSync("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stagingDir,
    "-ov",
    "-format",
    "UDZO",
    target
  ], { cwd: root, stdio: "inherit" });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(target);
