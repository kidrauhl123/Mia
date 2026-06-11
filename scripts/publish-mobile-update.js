#!/usr/bin/env node
"use strict";

// Publish a mobile in-app update: upload the Android APK + the update manifest
// (mia-mobile-update.json) to the cloud /downloads/ dir so the app's
// UpdateProvider detects it. One command per release.
//
// Usage:
//   EXPO_TOKEN=... node scripts/publish-mobile-update.js --build <easBuildId> [--mandatory] [--notes "a|b"]
//   node scripts/publish-mobile-update.js --apk path/to/app.apk --version-code 4 --version-name 1.0.0 [...]
//
// Auth to the server reuses the JumpServer alias + Keychain askpass (see
// scripts/jms-askpass.sh); EAS lookups need EXPO_TOKEN.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const REMOTE = process.env.MIA_DEPLOY_REMOTE || "mia-jms-deploy";
const DOWNLOADS_DIR = process.env.MIA_WEB_DOWNLOADS_DIR || "/var/www/mia-web/downloads";
const PUBLIC_BASE = (process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn").replace(/\/+$/, "");
const CHANNEL = arg("channel", "preview");
const RUNTIME = arg("runtime-version", "2");
const MIN_SUPPORTED = Number(arg("min-supported", "1"));
const MANDATORY = flag("mandatory");
const NOTES = arg("notes") ? arg("notes").split("|").map((s) => s.trim()).filter(Boolean) : [];

// Reuse the Keychain-backed askpass so ssh/scp run without a password prompt.
if (!process.env.SSH_ASKPASS) {
  process.env.SSH_ASKPASS = path.join(ROOT, "scripts", "jms-askpass.sh");
  process.env.SSH_ASKPASS_REQUIRE = "force";
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
}

function eas(args) {
  return run("npx", ["-y", "eas-cli@latest", ...args], { cwd: path.join(ROOT, "apps", "mobile-rn") });
}

function resolveFromBuild(buildId) {
  console.log(`[publish] looking up EAS build ${buildId}…`);
  const json = JSON.parse(eas(["build:view", buildId, "--json", "--non-interactive"]));
  const url = json?.artifacts?.applicationArchiveUrl || json?.artifacts?.buildUrl;
  if (!url) throw new Error("EAS build has no downloadable artifact yet (still building?)");
  const versionCode = Number(json.appBuildVersion || json.runtimeVersion);
  const versionName = String(json.appVersion || "");
  const dest = path.join(os.tmpdir(), `mia-android-${versionCode || "build"}.apk`);
  console.log(`[publish] downloading APK → ${dest}`);
  run("curl", ["-fSL", "-o", dest, url], { stdio: "inherit" });
  return { apkPath: dest, versionCode, versionName };
}

function main() {
  let apkPath = arg("apk");
  let versionCode = Number(arg("version-code", "0"));
  let versionName = arg("version-name", "");
  const buildId = arg("build");

  if (buildId) {
    const r = resolveFromBuild(buildId);
    apkPath = apkPath || r.apkPath;
    versionCode = versionCode || r.versionCode;
    versionName = versionName || r.versionName;
  }

  if (!apkPath || !fs.existsSync(apkPath)) throw new Error("APK not found — pass --apk <path> or --build <id>");
  if (!Number.isFinite(versionCode) || versionCode <= 0) throw new Error("missing/invalid --version-code");
  if (!versionName) throw new Error("missing --version-name");

  const bytes = fs.readFileSync(apkPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const apkName = `mia-android-${versionCode}.apk`;
  const apkUrl = `${PUBLIC_BASE}/downloads/${apkName}`;

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    android: {
      channel: CHANNEL,
      versionName,
      versionCode,
      runtimeVersion: RUNTIME,
      minSupportedVersionCode: MIN_SUPPORTED,
      apkUrl,
      apkSha256: sha256,
      apkSizeBytes: bytes.length,
      mandatory: MANDATORY,
      notes: NOTES,
    },
  };

  const manifestPath = path.join(os.tmpdir(), "mia-mobile-update.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`[publish] versionCode=${versionCode} name=${versionName} mandatory=${MANDATORY}`);
  console.log(`[publish] sha256=${sha256} size=${(bytes.length / 1e6).toFixed(1)}MB`);

  // Upload APK first, then the manifest last, so the manifest never points at a
  // not-yet-uploaded APK.
  console.log(`[publish] uploading APK → ${REMOTE}:${DOWNLOADS_DIR}/${apkName}`);
  run("scp", [apkPath, `${REMOTE}:${DOWNLOADS_DIR}/${apkName}`], { stdio: "inherit" });
  console.log(`[publish] uploading manifest → ${REMOTE}:${DOWNLOADS_DIR}/mia-mobile-update.json`);
  run("scp", [manifestPath, `${REMOTE}:${DOWNLOADS_DIR}/mia-mobile-update.json`], { stdio: "inherit" });

  // Verify both are publicly reachable.
  const manifestHttp = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `${PUBLIC_BASE}/downloads/mia-mobile-update.json`]).trim();
  const apkHttp = run("curl", ["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", apkUrl]).trim();
  console.log(`[publish] verify manifest=${manifestHttp} apk=${apkHttp}`);
  if (manifestHttp !== "200" || apkHttp !== "200") throw new Error("post-upload verification failed");
  console.log(`[publish] done — clients on a lower versionCode will now see the update.`);
}

main();
