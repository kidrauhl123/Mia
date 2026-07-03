#!/usr/bin/env node
"use strict";

// Publish a mobile in-app update: place the Android APK + the update manifest
// (mia-mobile-update.json) in the cloud /downloads/ dir so the app's
// UpdateProvider detects it. One command per release.
//
// Usage:
//   EXPO_TOKEN=... node scripts/publish-mobile-update.js --build <easBuildId> [--mandatory] [--notes "a|b"]
//   node scripts/publish-mobile-update.js --apk path/to/app.apk --version-code 4 --version-name 1.0.0 [...]
//
// Transfer goes through the JumpServer ssh alias (mia-jms-deploy) + Keychain
// askpass. scp/sftp are unreliable through the bastion, so the APK is pulled
// server-side from the EAS CDN (with --build) or piped over ssh stdin (--apk),
// and the authoritative sha256/size are read back from the server.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MOBILE_CONFIG = path.join(ROOT, "apps", "mobile-rn", "app.config.ts");

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function currentMobileRuntimeVersion() {
  const source = fs.readFileSync(MOBILE_CONFIG, "utf8");
  const match = source.match(/\bruntimeVersion\s*:\s*["']([^"']+)["']/);
  if (!match) throw new Error(`unable to read runtimeVersion from ${MOBILE_CONFIG}`);
  return match[1];
}

const REMOTE = process.env.MIA_DEPLOY_REMOTE || "mia-jms-deploy";
const DOWNLOADS_DIR = process.env.MIA_WEB_DOWNLOADS_DIR || "/var/www/mia-web/downloads";
const PUBLIC_BASE = (process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn").replace(/\/+$/, "");
const CHANNEL = arg("channel", "preview");
const RUNTIME = arg("runtime-version", currentMobileRuntimeVersion());
const MIN_SUPPORTED = Number(arg("min-supported", "1"));
const MANDATORY = flag("mandatory");
const NOTES = arg("notes") ? arg("notes").split("|").map((s) => s.trim()).filter(Boolean) : [];

if (!process.env.SSH_ASKPASS) {
  process.env.SSH_ASKPASS = path.join(ROOT, "scripts", "jms-askpass.sh");
  process.env.SSH_ASKPASS_REQUIRE = "force";
}

function out(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
}
function sshRun(remoteCmd, opts = {}) {
  return execFileSync("ssh", [REMOTE, remoteCmd], { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...opts });
}

function resolveBuild(buildId) {
  console.log(`[publish] looking up EAS build ${buildId}…`);
  const json = JSON.parse(out("npx", ["-y", "eas-cli@latest", "build:view", buildId, "--json"], { cwd: path.join(ROOT, "apps", "mobile-rn") }));
  const url = json?.artifacts?.applicationArchiveUrl || json?.artifacts?.buildUrl;
  if (!url) throw new Error("EAS build has no downloadable artifact yet (still building?)");
  return { url, versionCode: Number(json.appBuildVersion), versionName: String(json.appVersion || "") };
}

function main() {
  const buildId = arg("build");
  let sourceUrl = "";
  let localApk = arg("apk");
  let versionCode = Number(arg("version-code", "0"));
  let versionName = arg("version-name", "");

  if (buildId) {
    const b = resolveBuild(buildId);
    sourceUrl = b.url;
    versionCode = versionCode || b.versionCode;
    versionName = versionName || b.versionName;
  }
  if (!Number.isFinite(versionCode) || versionCode <= 0) throw new Error("missing/invalid --version-code");
  if (!versionName) throw new Error("missing --version-name");
  if (!sourceUrl && !(localApk && fs.existsSync(localApk))) throw new Error("need --build <id> or --apk <path>");

  const apkName = `mia-android-${versionCode}.apk`;
  const latestApkName = "mia-android-latest.apk";
  const dest = `${DOWNLOADS_DIR}/${apkName}`;
  const latestDest = `${DOWNLOADS_DIR}/${latestApkName}`;
  const apkUrl = `${PUBLIC_BASE}/downloads/${apkName}`;
  const latestApkUrl = `${PUBLIC_BASE}/downloads/${latestApkName}`;

  // Put the APK on the server.
  if (sourceUrl) {
    console.log(`[publish] server pulling APK from EAS CDN → ${dest}`);
    sshRun(`curl -fSL -o '${dest}' '${sourceUrl}'`, { stdio: ["pipe", "inherit", "inherit"] });
  } else {
    console.log(`[publish] piping local APK over ssh → ${dest}`);
    execFileSync("ssh", [REMOTE, `cat > '${dest}'`], { input: fs.readFileSync(localApk), stdio: ["pipe", "inherit", "inherit"] });
  }
  console.log(`[publish] updating website latest APK → ${latestDest}`);
  sshRun(`cp '${dest}' '${latestDest}'`, { stdio: ["pipe", "inherit", "inherit"] });

  // Read the authoritative sha256 + size back from the served file.
  const stat = sshRun(`sha256sum '${dest}' | awk '{print $1}'; stat -c %s '${dest}'`).trim().split(/\s+/);
  const sha256 = stat[0];
  const sizeBytes = Number(stat[1]);
  if (!/^[a-f0-9]{64}$/i.test(sha256) || !sizeBytes) throw new Error(`bad server stat: ${stat.join(" ")}`);

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
      apkSizeBytes: sizeBytes,
      mandatory: MANDATORY,
      notes: NOTES,
    },
  };
  const manifestPath = path.join(os.tmpdir(), "mia-mobile-update.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`[publish] versionCode=${versionCode} name=${versionName} mandatory=${MANDATORY} sha256=${sha256} size=${(sizeBytes / 1e6).toFixed(1)}MB`);
  console.log(`[publish] uploading manifest → ${dest.replace(apkName, "mia-mobile-update.json")}`);
  execFileSync("ssh", [REMOTE, `cat > '${DOWNLOADS_DIR}/mia-mobile-update.json'`], { input: fs.readFileSync(manifestPath), stdio: ["pipe", "inherit", "inherit"] });

  const manifestHttp = out("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `${PUBLIC_BASE}/downloads/mia-mobile-update.json`]).trim();
  const apkHttp = out("curl", ["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", apkUrl]).trim();
  const latestApkHttp = out("curl", ["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", latestApkUrl]).trim();
  console.log(`[publish] verify manifest=${manifestHttp} apk=${apkHttp} latest=${latestApkHttp}`);
  if (manifestHttp !== "200" || apkHttp !== "200" || latestApkHttp !== "200") throw new Error("post-upload verification failed");
  console.log("[publish] done — clients on a lower versionCode will now see the update.");
}

main();
