"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createLocalDeviceIdentity(previousId = "", randomUUID = () => crypto.randomUUID()) {
  return {
    id: `device_${String(randomUUID()).replace(/-/g, "")}`,
    createdAt: new Date().toISOString(),
    ...(previousId ? { previousId } : {})
  };
}

function writeLocalDeviceIdentity({ runtimePaths, identity, fsImpl = fs } = {}) {
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const p = runtimePaths();
  fsImpl.mkdirSync(path.dirname(p.deviceIdentity), { recursive: true });
  fsImpl.writeFileSync(p.deviceIdentity, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  return identity;
}

function defaultReadJson(file, fallback, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function localDeviceIdentity({
  runtimePaths,
  readJson = null,
  fsImpl = fs,
  randomUUID = () => crypto.randomUUID()
} = {}) {
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const p = runtimePaths();
  const saved = typeof readJson === "function"
    ? readJson(p.deviceIdentity, {})
    : defaultReadJson(p.deviceIdentity, {}, fsImpl);
  const existing = String(saved.id || saved.deviceId || "").trim();
  if (/^device_[A-Za-z0-9_-]{8,}$/.test(existing)) return { ...saved, id: existing };
  return writeLocalDeviceIdentity({
    runtimePaths,
    identity: createLocalDeviceIdentity(existing, randomUUID),
    fsImpl
  });
}

function resetLocalDeviceIdentity(options = {}) {
  const current = localDeviceIdentity(options);
  return writeLocalDeviceIdentity({
    ...options,
    identity: createLocalDeviceIdentity(current.id, options.randomUUID || (() => crypto.randomUUID()))
  });
}

function localDeviceId(options = {}) {
  return localDeviceIdentity(options).id;
}

function localDeviceName(osImpl = os) {
  const hostname = String(osImpl.hostname() || "").trim().replace(/\.local$/i, "");
  return hostname || "本机";
}

function localDeviceFingerprint({ app, osImpl = os, cryptoImpl = crypto } = {}) {
  const payload = JSON.stringify({
    hostname: osImpl.hostname(),
    platform: osImpl.platform(),
    arch: osImpl.arch(),
    userData: app.getPath("userData")
  });
  return cryptoImpl.createHash("sha256").update(payload).digest("hex").slice(0, 40);
}

module.exports = {
  createLocalDeviceIdentity,
  writeLocalDeviceIdentity,
  localDeviceIdentity,
  resetLocalDeviceIdentity,
  localDeviceId,
  localDeviceName,
  localDeviceFingerprint
};
