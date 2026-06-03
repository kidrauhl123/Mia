// Publish the macOS in-app update feed to the GitHub release.
//
// electron-updater (src/main/updater/auto-update-service.js) reads
// `latest-mac.yml` from the GitHub release named after `build.publish`, finds
// the `.zip` it points at, and downloads it (block-level diff via `.blockmap`).
// If those three files are missing from the release, every installed client
// checks for updates and silently gets nothing — so this script uploads the
// whole feed, not just the human-facing DMG.
//
// Run AFTER `npm run dist:mac` has produced release/ artifacts. Kept separate
// from dist:mac on purpose: dist:mac is the routine local rebuild (CLAUDE.md),
// so it must never touch the live release. Publishing is an explicit step.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || "Mia";
const version = pkg.version || "0.0.0";
const tag = `v${version}`;
const releaseDir = path.join(root, "release");

// The update feed electron-updater actually consumes. The DMG is only for
// first-time downloads from the website and is optional here.
const feedFiles = [
  "latest-mac.yml",
  `${productName}-${version}-arm64-mac.zip`,
  `${productName}-${version}-arm64-mac.zip.blockmap`,
];
const dmg = `${productName}-${version}-Apple-Silicon.dmg`;

function resolveOrThrow(name) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing release/${name}. Run \`npm run dist:mac\` first so the feed exists.`
    );
  }
  return file;
}

const feedPaths = feedFiles.map(resolveOrThrow);

// Catch the #1 footgun: publishing a stale build whose feed version doesn't
// match package.json. electron-updater compares versions, so a mismatch means
// clients either never update or chase a version that isn't really new.
const feed = yaml.load(fs.readFileSync(path.join(releaseDir, "latest-mac.yml"), "utf8"));
if (feed?.version !== version) {
  throw new Error(
    `latest-mac.yml is version ${feed?.version}, but package.json is ${version}. ` +
      `Rebuild with \`npm run dist:mac\` before publishing.`
  );
}

const uploadPaths = [...feedPaths];
const dmgPath = path.join(releaseDir, dmg);
if (fs.existsSync(dmgPath)) uploadPaths.push(dmgPath);

function gh(args, opts = {}) {
  return execFileSync("gh", args, { cwd: root, stdio: "inherit", ...opts });
}

function releaseExists() {
  try {
    execFileSync("gh", ["release", "view", tag, "-R", `${pkg.build.publish.owner}/${pkg.build.publish.repo}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const repo = `${pkg.build.publish.owner}/${pkg.build.publish.repo}`;

if (!releaseExists()) {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  console.log(`Creating release ${tag} at ${sha.slice(0, 8)} on ${repo}`);
  gh(["release", "create", tag, "-R", repo, "--target", sha, "--title", `${productName} ${version}`, "--notes", `${productName} ${version}`]);
}

console.log(`Uploading update feed to ${repo} ${tag}:`);
for (const p of uploadPaths) console.log(`  - ${path.basename(p)}`);
gh(["release", "upload", tag, "-R", repo, "--clobber", ...uploadPaths]);

console.log(`Done. Clients on < ${version} will now auto-update.`);
