const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const appName = `${productName}.app`;
// electron-builder writes to release/mac/ on x64 host, release/mac-arm64/ on arm64.
const sourceCandidates = ["mac", "mac-arm64", "mac-x64"]
  .map((dir) => path.join(root, "release", dir, appName))
  .filter((appPath) => fs.existsSync(appPath));
const source = sourceCandidates[0];
const target = path.join(root, "release", `${productName}-${version}-Apple-Silicon.dmg`);
const electronBuilder = path.join(root, "node_modules", ".bin", "electron-builder");

if (process.platform !== "darwin") {
  throw new Error("create-mac-dmg.js only runs on macOS.");
}

if (!source) {
  throw new Error(`Missing packaged app under release/mac{,-arm64,-x64}/${appName}`);
}

execFileSync(electronBuilder, [
  "--mac",
  "dmg",
  "--prepackaged",
  source,
  "--publish",
  "never"
], { cwd: root, stdio: "inherit" });

console.log(target);
