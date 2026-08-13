"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256File(filePath, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  hash.update(fsImpl.readFileSync(filePath));
  return hash.digest("hex");
}

function normalizeBuildInfo(value = {}) {
  return {
    releaseVersion: String(value.releaseVersion || value.release_version || "").trim(),
    sourceFingerprint: String(value.sourceFingerprint || value.source_fingerprint || "").trim().toLowerCase()
  };
}

function assertValidBuildInfo(value, label = "Mia Core") {
  const info = normalizeBuildInfo(value);
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(info.releaseVersion)) {
    throw new Error(`${label} has no verified release version.`);
  }
  if (!/^[a-f0-9]{64}$/.test(info.sourceFingerprint)) {
    throw new Error(`${label} has no verified source fingerprint.`);
  }
  return info;
}

function readCoreBuildInfo(binaryPath, {
  env = process.env,
  execFileSync = childProcess.execFileSync
} = {}) {
  let output;
  try {
    output = execFileSync(binaryPath, ["build-info"], {
      cwd: path.dirname(binaryPath),
      encoding: "utf8",
      env,
      timeout: 10000,
      windowsHide: true
    });
  } catch (error) {
    throw new Error(`Cannot read Mia Core build identity from ${binaryPath}: ${error?.message || error}`);
  }
  try {
    return assertValidBuildInfo(JSON.parse(String(output || "")), `Mia Core at ${binaryPath}`);
  } catch (error) {
    if (/Mia Core at .* has no verified/.test(String(error?.message || ""))) throw error;
    throw new Error(`Mia Core at ${binaryPath} returned invalid build identity.`);
  }
}

function assertExpectedBuildInfo(actual, expected, label = "Mia Core") {
  const verified = assertValidBuildInfo(actual, label);
  const wanted = assertValidBuildInfo(expected, "Expected Mia Core");
  if (verified.releaseVersion !== wanted.releaseVersion) {
    throw new Error(`${label} release ${verified.releaseVersion} does not match required ${wanted.releaseVersion}.`);
  }
  if (verified.sourceFingerprint !== wanted.sourceFingerprint) {
    throw new Error(`${label} source fingerprint does not match the current Core source.`);
  }
  return verified;
}

module.exports = {
  assertExpectedBuildInfo,
  assertValidBuildInfo,
  normalizeBuildInfo,
  readCoreBuildInfo,
  sha256File
};
