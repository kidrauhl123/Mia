#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function usage() {
  return [
    "Usage: node scripts/verify-cloud-production.js [cloud-url]",
    "",
    "Runs production doctor and smoke against the public Cloud URL using the",
    "expected release commit and builtAt from dist/mia-cloud-release/manifest.json.",
    "",
    "Examples:",
    "  node scripts/verify-cloud-production.js https://mia.gifgif.cn",
    "  MIA_DOCTOR_REMOTE=root@mia.gifgif.cn npm run cloud:prod:verify",
    "",
    "Environment:",
    "  MIA_CLOUD_PUBLIC_URL=<url>  Cloud URL when no positional URL is passed.",
    "  MIA_DOCTOR_REMOTE=<ssh>     Optional SSH target passed through to doctor-cloud.js.",
    "  MIA_DEPLOY_SUDO=\"sudo -n\"   Optional privilege command passed through to doctor-cloud.js.",
    "  MIA_SMOKE_REQUIRE_BRIDGE=1   Require the smoke script to run through an online desktop bridge.",
    "  MIA_SMOKE_USERNAME=<account> Required with MIA_SMOKE_REQUIRE_BRIDGE=1.",
    "  MIA_SMOKE_PASSWORD=<secret>  Required with MIA_SMOKE_REQUIRE_BRIDGE=1."
  ].join("\n");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(usage());
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Cloud URL must be http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readExpectedRelease({
  manifestPath = path.join(root, "dist", "mia-cloud-release", "manifest.json")
} = {}) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing release manifest: ${manifestPath}. Run npm run cloud:release first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const gitCommit = String(manifest.source?.gitCommit || "").trim();
  const builtAt = String(manifest.builtAt || "").trim();
  if (!gitCommit || !builtAt) {
    throw new Error(`Release manifest is missing source.gitCommit or builtAt: ${manifestPath}`);
  }
  return { gitCommit, builtAt, manifestPath };
}

function commandEnv(baseEnv, prefix, expectedRelease) {
  return {
    ...baseEnv,
    [`MIA_${prefix}_EXPECT_RELEASE_COMMIT`]: expectedRelease.gitCommit,
    [`MIA_${prefix}_EXPECT_RELEASE_BUILT_AT`]: expectedRelease.builtAt
  };
}

function assertBridgeSmokeEnv(env = process.env) {
  if (String(env.MIA_SMOKE_REQUIRE_BRIDGE || "") !== "1") return;
  if (!String(env.MIA_SMOKE_USERNAME || "").trim() || !String(env.MIA_SMOKE_PASSWORD || "")) {
    throw new Error("MIA_SMOKE_USERNAME and MIA_SMOKE_PASSWORD are required when MIA_SMOKE_REQUIRE_BRIDGE=1. Log the desktop bridge into that same smoke account before running production e2e verification.");
  }
}

function runChecked(spawnSync, label, command, args, options) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit status ${result.status ?? "unknown"}.`);
  }
}

function verifyProduction({
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn",
  manifestPath,
  spawnSync = childProcess.spawnSync,
  baseEnv = process.env,
  cwd = root,
  stdio = "inherit"
} = {}) {
  const baseUrl = normalizeBaseUrl(publicUrl);
  assertBridgeSmokeEnv(baseEnv);
  const expectedRelease = readExpectedRelease({ manifestPath });
  console.log(`Mia production verification target: ${baseUrl}`);
  console.log(`Expected release commit: ${expectedRelease.gitCommit}`);
  console.log(`Expected release builtAt: ${expectedRelease.builtAt}`);

  runChecked(
    spawnSync,
    "Running production doctor",
    process.execPath,
    [path.join(cwd, "scripts", "doctor-cloud.js"), baseUrl],
    {
      cwd,
      stdio,
      env: commandEnv(baseEnv, "DOCTOR", expectedRelease)
    }
  );

  runChecked(
    spawnSync,
    "Running production smoke",
    process.execPath,
    [path.join(cwd, "scripts", "smoke-cloud.js"), baseUrl],
    {
      cwd,
      stdio,
      env: commandEnv(baseEnv, "SMOKE", expectedRelease)
    }
  );

  console.log(`Mia production verification passed: ${baseUrl}`);
  return { baseUrl, expectedRelease };
}

function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const positional = process.argv.slice(2).filter((arg) => !String(arg).startsWith("-"));
  try {
    verifyProduction({ publicUrl: positional[0] || process.env.MIA_CLOUD_PUBLIC_URL });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  assertBridgeSmokeEnv,
  commandEnv,
  normalizeBaseUrl,
  readExpectedRelease,
  verifyProduction
};
