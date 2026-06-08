const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APK_NAME = "mia-android-latest.apk";
const MANIFEST_NAME = "mia-mobile-update.json";

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function cleanBaseUrl(publicBaseUrl) {
  return String(publicBaseUrl || "https://mia.gifgif.cn").replace(/\/+$/, "");
}

function parseNotes(notes) {
  if (Array.isArray(notes)) return notes.map(String).filter(Boolean);
  return String(notes || "")
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInt(value, label) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function nonNegativeInt(value, label) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function createMobileAndroidManifest(options) {
  const sourceApk = path.resolve(String(options.sourceApk || ""));
  if (!fs.existsSync(sourceApk)) throw new Error(`Missing Android APK: ${sourceApk}`);
  const publicBaseUrl = cleanBaseUrl(options.publicBaseUrl);
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    android: {
      channel: String(options.channel || "preview"),
      versionName: String(options.versionName || ""),
      versionCode: positiveInt(options.versionCode, "versionCode"),
      runtimeVersion: String(options.runtimeVersion || ""),
      minSupportedVersionCode: nonNegativeInt(options.minSupportedVersionCode || 0, "minSupportedVersionCode"),
      apkUrl: `${publicBaseUrl}/downloads/${APK_NAME}`,
      apkSha256: sha256File(sourceApk),
      apkSizeBytes: fs.statSync(sourceApk).size,
      mandatory: options.mandatory === true || String(options.mandatory || "").toLowerCase() === "true",
      notes: parseNotes(options.notes),
    },
  };
}

function publishMobileAndroidDownload(options) {
  const sourceApk = path.resolve(String(options.sourceApk || ""));
  const downloadsDir = path.resolve(String(options.downloadsDir || ""));
  const manifest = createMobileAndroidManifest({ ...options, sourceApk });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.copyFileSync(sourceApk, path.join(downloadsDir, APK_NAME));
  fs.writeFileSync(path.join(downloadsDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = {
  APK_NAME,
  MANIFEST_NAME,
  sha256File,
  createMobileAndroidManifest,
  publishMobileAndroidDownload,
};
