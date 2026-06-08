#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildSshAuthorizationHelp,
  readSha256
} = require("./print-cloud-release-handoff.js");
const {
  runAuditLive
} = require("./audit-cloud-productization.js");

const root = path.resolve(__dirname, "..");

function safeSshAuthorizationHelp() {
  try {
    return buildSshAuthorizationHelp();
  } catch (error) {
    return [
      "Mia Cloud SSH authorization help",
      "",
      `Public key is not ready: ${String(error?.message || error)}`,
      "Create or point to a deployment public key before production deploy:",
      "```bash",
      "ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C mia-cloud-deploy",
      "npm run cloud:deploy:authorize-help",
      "npm run cloud:deploy:ssh-diagnose",
      "```",
      "",
      "Do not paste or transfer a private key."
    ].join("\n");
  }
}

function readReleaseIdentity(rootDir = root) {
  const manifestPath = path.join(rootDir, "dist", "mia-cloud-release", "manifest.json");
  const releaseShaPath = path.join(rootDir, "dist", "mia-cloud-release.tgz.sha256");
  const transferShaPath = path.join(rootDir, "dist", "mia-cloud-release-transfer.tgz.sha256");
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing release manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    commit: manifest.source?.gitCommit || "missing",
    builtAt: manifest.builtAt || "missing",
    dirty: Boolean(manifest.source?.gitDirty),
    releaseSha: fs.existsSync(releaseShaPath) ? readSha256(releaseShaPath) : "missing",
    transferSha: fs.existsSync(transferShaPath) ? readSha256(transferShaPath) : "missing"
  };
}

async function productionDeployComplete({
  rootDir = root,
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn"
} = {}) {
  try {
    const audit = await runAuditLive({ rootDir, publicUrl });
    return audit.requirements.find((requirement) => requirement.id === "gate.production-deploy")?.status === "pass";
  } catch {
    return false;
  }
}

async function buildCloudBlockers({
  rootDir = root,
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn"
} = {}) {
  const identity = readReleaseIdentity(rootDir);
  const productionComplete = await productionDeployComplete({ rootDir, publicUrl });
  const lines = [
    "Mia Cloud remaining blockers",
    "",
    "Current release:",
    `- commit: ${identity.commit}${identity.dirty ? "+dirty" : ""}`,
    `- builtAt: ${identity.builtAt}`,
    `- release sha256: ${identity.releaseSha}`,
    `- transfer sha256: ${identity.transferSha}`,
    ""
  ];
  if (productionComplete) {
    lines.push("No remaining blockers. Plain `npm run cloud:audit` is the completion gate.");
  }
  if (!productionComplete) {
    lines.push(
      "1. Production deploy/public smoke",
      "",
      "Run from the development Mac:",
      "```bash",
      `npm run cloud:prod:verify -- ${publicUrl}`,
      "npm run cloud:deploy:ssh-diagnose",
      "```",
      "",
      "If SSH is denied, authorize this workstation on the VPS:",
      "",
      safeSshAuthorizationHelp()
    );
  }
  lines.push("", "Do not mark the objective complete until plain `npm run cloud:audit` exits 0.");
  return lines.join("\n");
}

async function buildCloudBlockerSummary({
  rootDir = root,
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn"
} = {}) {
  const identity = readReleaseIdentity(rootDir);
  const productionComplete = await productionDeployComplete({ rootDir, publicUrl });
  const blockers = [];
  if (!productionComplete) {
    blockers.push({
      id: "gate.production-deploy",
      requiredCommands: [
        "npm run cloud:deploy",
        `npm run cloud:prod:verify -- ${publicUrl}`,
        "npm run cloud:deploy:ssh-diagnose"
      ],
      required: [
        `npm run cloud:prod:verify -- ${publicUrl}`,
        "npm run cloud:deploy:ssh-diagnose",
        "npm run cloud:deploy"
      ]
    });
  }
  return {
    release: identity,
    publicUrl,
    productionDeployComplete: productionComplete,
    blockers,
    completionCommand: "npm run cloud:audit"
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--json")) {
    console.log(JSON.stringify(await buildCloudBlockerSummary(), null, 2));
    return;
  }
  console.log(await buildCloudBlockers());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  buildCloudBlockers,
  buildCloudBlockerSummary,
  productionDeployComplete,
  readReleaseIdentity,
  safeSshAuthorizationHelp
};
