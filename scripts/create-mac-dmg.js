const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Aimashi";
const version = pkg.version || "0.0.0";
// electron-builder writes to release/mac/ on x64 host, release/mac-arm64/ on arm64.
const sourceCandidates = ["mac", "mac-arm64", "mac-x64"]
  .map((dir) => path.join(root, "release", dir))
  .filter((dir) => fs.existsSync(path.join(dir, `${productName}.app`)));
const source = sourceCandidates[0];
const target = path.join(root, "release", `${productName}-${version}-${process.arch}-unsigned.dmg`);

if (process.platform !== "darwin") {
  throw new Error("create-mac-dmg.js only runs on macOS.");
}

if (!source) {
  throw new Error(`Missing packaged app under release/mac{,-arm64,-x64}/${productName}.app`);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
execFileSync("hdiutil", [
  "create",
  "-volname",
  productName,
  "-srcfolder",
  source,
  "-ov",
  "-format",
  "UDZO",
  target
], { stdio: "inherit" });

console.log(target);
