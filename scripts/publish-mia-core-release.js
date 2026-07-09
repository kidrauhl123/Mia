#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
if (!process.env.SSH_ASKPASS) {
  process.env.SSH_ASKPASS = path.join(root, "scripts", "jms-askpass.sh");
  process.env.SSH_ASKPASS_REQUIRE = "force";
}

const releaseRoot = path.resolve(process.env.MIA_CORE_RELEASE_ROOT || path.join(root, "dist", "mia-core-release"));
const remote = String(process.env.MIA_CORE_RELEASE_REMOTE || process.env.MIA_DEPLOY_REMOTE || "").trim();
const remoteDir = String(process.env.MIA_CORE_RELEASE_REMOTE_DIR || "/var/www/mia-web/downloads/mia-core/").replace(/\/?$/, "/");
const publicBaseUrl = String(process.env.MIA_CORE_RELEASE_BASE_URL || "https://mia.gifgif.cn/downloads/mia-core").replace(/\/?$/, "/");
const shouldDeploy = process.env.MIA_CORE_RELEASE_DEPLOY === "1";

function assertReadableFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${label} not found at ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

function listReleaseFiles(dir) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(dir, fullPath));
      }
    }
  }
  walk(dir);
  return files.sort();
}

assertReadableFile(path.join(releaseRoot, "latest.json"), "Mia Core latest manifest");
const files = listReleaseFiles(releaseRoot);
const archives = files.filter((file) => /mia-core-v[^/]+\.(tar\.gz|zip)$/.test(file));
if (!archives.length) {
  throw new Error(`No Mia Core release archives found under ${releaseRoot}. Run npm run core:release first.`);
}

console.log(`Mia Core release staged: ${releaseRoot}`);
console.log(`Mia Core release base URL: ${publicBaseUrl}`);
for (const file of files) console.log(`  - ${file}`);

if (shouldDeploy) {
  if (!remote) throw new Error("Set MIA_CORE_RELEASE_REMOTE or MIA_DEPLOY_REMOTE when MIA_CORE_RELEASE_DEPLOY=1.");
  console.log(`Deploying Mia Core releases to ${remote}:${remoteDir}`);
  childProcess.execFileSync("ssh", [remote, "mkdir", "-p", remoteDir], { cwd: root, stdio: "inherit" });
  childProcess.execFileSync("rsync", ["-av", `${releaseRoot}/`, `${remote}:${remoteDir}`], { cwd: root, stdio: "inherit" });
}

console.log(`Done. Desktop packaging will download from ${publicBaseUrl}{tag}/{asset}.`);
