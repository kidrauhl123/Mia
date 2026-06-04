const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const defaultReleaseDir = path.join(root, "release");
const releaseDir = path.resolve(process.env.MIA_RELEASE_DIR || defaultReleaseDir);
const tempDir = path.resolve(os.tmpdir());
const tidyOnly = process.argv.includes("--tidy");

function isAllowedTarget(target) {
  return target === defaultReleaseDir || target.startsWith(`${tempDir}${path.sep}`);
}

if (!isAllowedTarget(releaseDir)) {
  throw new Error(`Refusing to clean unexpected release directory: ${releaseDir}`);
}

function removeEntry(entryPath) {
  fs.rmSync(entryPath, { recursive: true, force: true });
}

if (!tidyOnly) {
  removeEntry(releaseDir);
  fs.mkdirSync(releaseDir, { recursive: true });
  console.log(`Cleaned release directory: ${releaseDir}`);
  process.exit(0);
}

const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = process.env.MIA_RELEASE_VERSION || pkg.version || "0.0.0";
const productVersionPattern = new RegExp(
  `^${productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+\\.\\d+\\.\\d+)`
);

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
  console.log(`Tidied release directory: ${releaseDir}`);
  process.exit(0);
}

for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
  const entryPath = path.join(releaseDir, entry.name);
  if (entry.isDirectory()) {
    removeEntry(entryPath);
    continue;
  }
  if (entry.name === "builder-debug.yml" || entry.name.endsWith(".apk")) {
    removeEntry(entryPath);
    continue;
  }
  const match = entry.name.match(productVersionPattern);
  if (match && match[1] !== version) {
    removeEntry(entryPath);
  }
}

console.log(`Tidied release directory: ${releaseDir}`);
