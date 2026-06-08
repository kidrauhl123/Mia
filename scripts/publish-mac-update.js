// Stage or deploy the macOS in-app update feed to Mia's generic HTTPS update
// source. electron-updater reads latest-mac.yml from
// https://mia.gifgif.cn/updates/ and downloads the signed .zip plus blockmap
// from the same origin. The DMG is copied too for first-time website downloads.
//
// Run AFTER `npm run dist:mac`. By default this writes dist/mia-updates/ only.
// Set MIA_UPDATE_DEPLOY=1 to rsync that directory to the VPS update root.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const releaseDir = path.join(root, "release");
const stageDir = path.resolve(process.env.MIA_UPDATE_STAGING_DIR || path.join(root, "dist", "mia-updates"));
const updateUrl = String(process.env.MIA_UPDATE_BASE_URL || pkg.build?.publish?.url || "https://mia.gifgif.cn/updates/").replace(/\/?$/, "/");
const remote = String(process.env.MIA_UPDATE_REMOTE || process.env.MIA_DEPLOY_REMOTE || "").trim();
const remoteDir = String(process.env.MIA_UPDATE_REMOTE_DIR || "/var/www/mia-updates/").replace(/\/?$/, "/");
const shouldDeploy = process.env.MIA_UPDATE_DEPLOY === "1";

const feedFiles = [
  "latest-mac.yml",
  `${productName}-${version}-arm64-mac.zip`,
  `${productName}-${version}-arm64-mac.zip.blockmap`,
];
const dmg = `${productName}-${version}-Apple-Silicon.dmg`;

function resolveOrThrow(name) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing release/${name}. Run \`npm run dist:mac\` first so the feed exists.`);
  }
  return file;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyArtifact(source) {
  const target = path.join(stageDir, path.basename(source));
  fs.copyFileSync(source, target);
  return target;
}

const feedPaths = feedFiles.map(resolveOrThrow);
const feed = yaml.load(fs.readFileSync(path.join(releaseDir, "latest-mac.yml"), "utf8"));
if (feed?.version !== version) {
  throw new Error(
    `latest-mac.yml is version ${feed?.version}, but package.json is ${version}. ` +
      "Rebuild with `npm run dist:mac` before publishing."
  );
}
if (pkg.build?.publish?.provider !== "generic" || !pkg.build?.publish?.url) {
  throw new Error("package.json build.publish must be the generic provider before publishing Mia updates.");
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const staged = feedPaths.map(copyArtifact);
const dmgPath = path.join(releaseDir, dmg);
if (fs.existsSync(dmgPath)) staged.push(copyArtifact(dmgPath));

const checksumLines = staged
  .map((file) => `${sha256File(file)}  ${path.basename(file)}`)
  .join("\n") + "\n";
fs.writeFileSync(path.join(stageDir, "SHA256SUMS"), checksumLines);

console.log(`Mia macOS update feed staged: ${stageDir}`);
console.log(`Update base URL: ${updateUrl}`);
for (const file of staged) console.log(`  - ${path.basename(file)}`);

if (shouldDeploy) {
  if (!remote) throw new Error("Set MIA_UPDATE_REMOTE or MIA_DEPLOY_REMOTE when MIA_UPDATE_DEPLOY=1.");
  console.log(`Deploying updates to ${remote}:${remoteDir}`);
  execFileSync("ssh", [remote, "mkdir", "-p", remoteDir], { cwd: root, stdio: "inherit" });
  execFileSync("rsync", ["-av", `${stageDir}/`, `${remote}:${remoteDir}`], { cwd: root, stdio: "inherit" });
}

console.log(`Done. Generic-provider clients will check ${updateUrl}latest-mac.yml.`);
