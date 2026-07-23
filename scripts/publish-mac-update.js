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
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { attachDesktopReleaseNotes } = require("./desktop-release-notes.js");
const { syncDesktopWebDownloads } = require("./publish-desktop-web-downloads.js");

const root = path.resolve(__dirname, "..");
if (!process.env.SSH_ASKPASS) {
  process.env.SSH_ASKPASS = path.join(root, "scripts", "jms-askpass.sh");
  process.env.SSH_ASKPASS_REQUIRE = "force";
}

const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const releaseDir = path.resolve(process.env.MIA_RELEASE_DIR || path.join(root, "release"));
const stageDir = path.resolve(process.env.MIA_UPDATE_STAGING_DIR || path.join(root, "dist", "mia-updates"));
const updateUrl = String(process.env.MIA_UPDATE_BASE_URL || pkg.build?.publish?.url || "https://mia.gifgif.cn/updates/").replace(/\/?$/, "/");
const remote = String(process.env.MIA_UPDATE_REMOTE || process.env.MIA_DEPLOY_REMOTE || "").trim();
const remoteDir = String(process.env.MIA_UPDATE_REMOTE_DIR || "/var/www/mia-updates/").replace(/\/?$/, "/");
const shouldDeploy = process.env.MIA_UPDATE_DEPLOY === "1";
const shouldSyncWebDownloads = process.env.MIA_UPDATE_SYNC_WEB_DOWNLOADS !== "0";

function resolveOrThrow(name) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing release/${name}. Run a macOS dist command first so the feed exists.`);
  }
  return file;
}

function readFeed(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyArtifact(source, name = path.basename(source)) {
  const target = path.join(stageDir, name);
  fs.copyFileSync(source, target);
  return target;
}

function maybeSnapshotExistingStage() {
  const previousFeedPath = path.join(stageDir, "latest-mac.yml");
  if (!fs.existsSync(previousFeedPath)) return "";
  const previousFeed = readFeed(previousFeedPath);
  if (previousFeed?.version !== version) return "";

  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-mac-update-stage-"));
  fs.cpSync(stageDir, snapshot, { recursive: true });
  return snapshot;
}

function listFeedFiles(feed) {
  if (Array.isArray(feed?.files) && feed.files.length) return feed.files;
  if (feed?.path) {
    return [{
      url: feed.path,
      sha2: feed.sha2,
      sha512: feed.sha512,
      size: feed.size,
    }];
  }
  return [];
}

function archRank(name) {
  if (name.includes("arm64")) return 0;
  if (name.includes("x64")) return 1;
  return 2;
}

function sourceForArtifact(name, previousStageDir) {
  const candidates = [
    path.join(releaseDir, name),
    previousStageDir ? path.join(previousStageDir, name) : "",
  ].filter(Boolean);
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) {
    throw new Error(`Missing macOS update artifact ${name}. Rebuild the missing architecture before publishing.`);
  }
  return source;
}

function listVersionDmgs(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file === `${productName}-${version}-Apple-Silicon.dmg` || file === `${productName}-${version}-Intel.dmg`);
}

const feedPath = resolveOrThrow("latest-mac.yml");
const previousStageDir = maybeSnapshotExistingStage();
process.on("exit", () => {
  if (previousStageDir) fs.rmSync(previousStageDir, { recursive: true, force: true });
});

const feed = readFeed(feedPath);
if (feed?.version !== version) {
  throw new Error(
    `latest-mac.yml is version ${feed?.version}, but package.json is ${version}. ` +
      "Rebuild with a macOS dist command before publishing."
  );
}
if (pkg.build?.publish?.provider !== "generic" || !pkg.build?.publish?.url) {
  throw new Error("package.json build.publish must be the generic provider before publishing Mia updates.");
}

const feeds = [];
const previousFeedPath = previousStageDir ? path.join(previousStageDir, "latest-mac.yml") : "";
if (previousFeedPath && fs.existsSync(previousFeedPath)) feeds.push(readFeed(previousFeedPath));
feeds.push(feed);
const fileMap = new Map();
for (const candidateFeed of feeds) {
  if (candidateFeed?.version !== version) continue;
  for (const file of listFeedFiles(candidateFeed)) {
    if (!file?.url) continue;
    fileMap.set(file.url, file);
  }
}
const files = [...fileMap.values()].sort((a, b) => {
  const aRank = archRank(a.url);
  const bRank = archRank(b.url);
  if (aRank !== bRank) return aRank - bRank;
  return a.url.localeCompare(b.url);
});
if (!files.length) throw new Error("No macOS update zip files found in latest-mac.yml.");

for (const file of files) {
  sourceForArtifact(file.url, previousStageDir);
  sourceForArtifact(`${file.url}.blockmap`, previousStageDir);
}

const combinedFeed = {
  ...feed,
  files,
  path: files[0].url,
  sha512: files[0].sha512,
};
if (files[0].size != null) combinedFeed.size = files[0].size;
const withNotes = attachDesktopReleaseNotes(combinedFeed, root, version);
fs.writeFileSync(feedPath, yaml.dump(withNotes.feed, { lineWidth: -1 }));

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const staged = [copyArtifact(feedPath)];
for (const file of files) {
  staged.push(copyArtifact(sourceForArtifact(file.url, previousStageDir), file.url));
  staged.push(copyArtifact(sourceForArtifact(`${file.url}.blockmap`, previousStageDir), `${file.url}.blockmap`));
}
const dmgNames = [...new Set([
  ...listVersionDmgs(previousStageDir),
  ...listVersionDmgs(releaseDir),
])].sort();
for (const dmgName of dmgNames) staged.push(copyArtifact(sourceForArtifact(dmgName, previousStageDir), dmgName));

const checksumLines = staged
  .map((file) => `${sha256File(file)}  ${path.basename(file)}`)
  .join("\n") + "\n";
fs.writeFileSync(path.join(stageDir, "SHA256SUMS"), checksumLines);

console.log(`Mia macOS update feed staged: ${stageDir}`);
console.log(`Update base URL: ${updateUrl}`);
console.log(`Release notes: ${path.relative(root, withNotes.file)}`);
for (const file of staged) console.log(`  - ${path.basename(file)}`);

if (shouldDeploy) {
  if (!remote) throw new Error("Set MIA_UPDATE_REMOTE or MIA_DEPLOY_REMOTE when MIA_UPDATE_DEPLOY=1.");
  console.log(`Deploying updates to ${remote}:${remoteDir}`);
  execFileSync("ssh", [remote, "mkdir", "-p", remoteDir], { cwd: root, stdio: "inherit" });
  execFileSync("rsync", ["-av", `${stageDir}/`, `${remote}:${remoteDir}`], { cwd: root, stdio: "inherit" });
  if (shouldSyncWebDownloads && dmgNames.length) {
    console.log("Syncing macOS website download aliases.");
    syncDesktopWebDownloads({
      remote,
      remoteDir,
      cwd: root,
      artifacts: dmgNames.map((fileName) => ({
        fileName,
        aliases: fileName.endsWith("-Apple-Silicon.dmg")
          ? ["mia-macos-apple-silicon-latest.dmg", "mia-macos-arm64-latest.dmg"]
          : ["mia-macos-intel-latest.dmg", "mia-macos-x64-latest.dmg"],
      })),
    });
  }
}

console.log(`Done. Generic-provider clients will check ${updateUrl}latest-mac.yml.`);
