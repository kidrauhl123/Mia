// Stage or deploy the Windows in-app update feed to Mia's generic HTTPS update
// source. electron-updater reads latest.yml from https://mia.gifgif.cn/updates/
// and downloads the NSIS setup .exe plus blockmap from the same origin.
//
// Run AFTER `npm run dist:win`. By default this writes dist/mia-updates/ only.
// Set MIA_UPDATE_DEPLOY=1 to rsync that directory to the VPS update root.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { attachDesktopReleaseNotes } = require("./desktop-release-notes.js");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const releaseDir = path.resolve(process.env.MIA_RELEASE_DIR || path.join(root, "release"));
const stageDir = path.resolve(process.env.MIA_UPDATE_STAGING_DIR || path.join(root, "dist", "mia-updates"));
const updateUrl = String(process.env.MIA_UPDATE_BASE_URL || pkg.build?.publish?.url || "https://mia.gifgif.cn/updates/").replace(/\/?$/, "/");
const remote = String(process.env.MIA_UPDATE_REMOTE || process.env.MIA_DEPLOY_REMOTE || "").trim();
const remoteDir = String(process.env.MIA_UPDATE_REMOTE_DIR || "/var/www/mia-updates/").replace(/\/?$/, "/");
const shouldDeploy = process.env.MIA_UPDATE_DEPLOY === "1";

const feedFiles = [
  "latest.yml",
  `${productName}-${version}-Setup.exe`,
  `${productName}-${version}-Setup.exe.blockmap`,
];

function resolveOrThrow(name) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing release/${name}. Run \`npm run dist:win\` first so the feed exists.`);
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

const feedPath = resolveOrThrow("latest.yml");
const feedPaths = [feedPath, ...feedFiles.slice(1).map(resolveOrThrow)];
const feed = yaml.load(fs.readFileSync(feedPath, "utf8"));
if (feed?.version !== version) {
  throw new Error(
    `latest.yml is version ${feed?.version}, but package.json is ${version}. ` +
      "Rebuild with `npm run dist:win` before publishing."
  );
}
if (pkg.build?.publish?.provider !== "generic" || !pkg.build?.publish?.url) {
  throw new Error("package.json build.publish must be the generic provider before publishing Mia updates.");
}
const withNotes = attachDesktopReleaseNotes(feed, root, version);
fs.writeFileSync(feedPath, yaml.dump(withNotes.feed, { lineWidth: -1 }));

fs.mkdirSync(stageDir, { recursive: true });

const staged = feedPaths.map(copyArtifact);
const checksumLines = staged
  .map((file) => `${sha256File(file)}  ${path.basename(file)}`)
  .join("\n") + "\n";
// Keep this platform-specific: the macOS publisher writes SHA256SUMS in the
// same shared update directory, so Windows must not overwrite that manifest.
fs.writeFileSync(path.join(stageDir, "SHA256SUMS-WINDOWS"), checksumLines);

console.log(`Mia Windows update feed staged: ${stageDir}`);
console.log(`Update base URL: ${updateUrl}`);
console.log(`Release notes: ${path.relative(root, withNotes.file)}`);
for (const file of staged) console.log(`  - ${path.basename(file)}`);

if (shouldDeploy) {
  if (!remote) throw new Error("Set MIA_UPDATE_REMOTE or MIA_DEPLOY_REMOTE when MIA_UPDATE_DEPLOY=1.");
  console.log(`Deploying updates to ${remote}:${remoteDir}`);
  execFileSync("ssh", [remote, "mkdir", "-p", remoteDir], { cwd: root, stdio: "inherit" });
  execFileSync("rsync", ["-av", `${stageDir}/`, `${remote}:${remoteDir}`], { cwd: root, stdio: "inherit" });
}

console.log(`Done. Generic-provider clients will check ${updateUrl}latest.yml.`);
