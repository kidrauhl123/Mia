// Publish the Windows in-app update feed to the GitHub release.
//
// Mirror of publish-mac-update.js for the NSIS target. electron-updater on
// Windows reads `latest.yml` from the GitHub release named after
// `build.publish`, finds the Setup `.exe` it points at, and downloads it
// (block-level diff via `.blockmap`). If those three files are missing from the
// release, every installed client checks for updates and silently gets nothing
// — so this uploads the whole feed, not just a human-facing installer.
//
// Run AFTER `npm run dist:win` has produced release/ artifacts. Intended to run
// on a Windows host (GitHub Actions windows-latest), since the NSIS target and
// the win-x64 Hermes runtime are both built natively there. macOS stays on
// publish-mac-update.js; both publish to the same `v<version>` release so a mac
// client reads latest-mac.yml and a Windows client reads latest.yml off it.

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

// The update feed electron-updater actually consumes. The Setup .exe doubles as
// the first-time website download, so unlike mac there is no separate DMG.
const feedFiles = [
  "latest.yml",
  `${productName}-${version}-Setup.exe`,
  `${productName}-${version}-Setup.exe.blockmap`,
];

function resolveOrThrow(name) {
  const file = path.join(releaseDir, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing release/${name}. Run \`npm run dist:win\` first so the feed exists.`
    );
  }
  return file;
}

const feedPaths = feedFiles.map(resolveOrThrow);

// Catch the #1 footgun: publishing a stale build whose feed version doesn't
// match package.json. electron-updater compares versions, so a mismatch means
// clients either never update or chase a version that isn't really new.
const feed = yaml.load(fs.readFileSync(path.join(releaseDir, "latest.yml"), "utf8"));
if (feed?.version !== version) {
  throw new Error(
    `latest.yml is version ${feed?.version}, but package.json is ${version}. ` +
      `Rebuild with \`npm run dist:win\` before publishing.`
  );
}

const uploadPaths = [...feedPaths];

function gh(args, opts = {}) {
  return execFileSync("gh", args, { cwd: root, stdio: "inherit", ...opts });
}

const repo = `${pkg.build.publish.owner}/${pkg.build.publish.repo}`;

function releaseExists() {
  try {
    execFileSync("gh", ["release", "view", tag, "-R", repo], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

if (!releaseExists()) {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  console.log(`Creating release ${tag} at ${sha.slice(0, 8)} on ${repo}`);
  gh(["release", "create", tag, "-R", repo, "--target", sha, "--title", `${productName} ${version}`, "--notes", `${productName} ${version}`]);
}

console.log(`Uploading Windows update feed to ${repo} ${tag}:`);
for (const p of uploadPaths) console.log(`  - ${path.basename(p)}`);
gh(["release", "upload", tag, "-R", repo, "--clobber", ...uploadPaths]);

console.log(`Done. Windows clients on < ${version} will now auto-update.`);
