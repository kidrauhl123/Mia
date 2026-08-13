"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CORE_SOURCE_ENTRIES = [
  "Cargo.toml",
  "Cargo.lock",
  "crates",
  path.join("packages", "shared", "skill-defaults.json")
];

function sourceFiles(rootDir, fsImpl = fs) {
  const root = path.resolve(rootDir);
  const files = [];

  function walk(candidate) {
    let stat;
    try {
      stat = fsImpl.statSync(candidate);
    } catch {
      return;
    }
    if (stat.isFile()) {
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      const segments = relative.split("/");
      const isWorkspaceFile = relative === "Cargo.toml" || relative === "Cargo.lock";
      const isSharedInput = relative === "packages/shared/skill-defaults.json";
      const isCrateBuildInput = segments[0] === "crates" && segments.length >= 3 && (
        segments[2] === "Cargo.toml"
        || segments[2] === "build.rs"
        || segments[2] === "src"
        || segments[2] === "migrations"
      );
      if (isWorkspaceFile || isSharedInput || isCrateBuildInput) files.push(candidate);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fsImpl.readdirSync(candidate, { withFileTypes: true })) {
      if (entry.name === "target" || entry.name === "node_modules") continue;
      walk(path.join(candidate, entry.name));
    }
  }

  for (const entry of CORE_SOURCE_ENTRIES) walk(path.join(root, entry));
  return files.sort((left, right) => (
    path.relative(root, left).localeCompare(path.relative(root, right))
  ));
}

function normalizedSourceBytes(filePath, fsImpl = fs) {
  return Buffer.from(fsImpl.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n"), "utf8");
}

function coreSourceFingerprintDetails(rootDir, fsImpl = fs) {
  const root = path.resolve(rootDir);
  const files = sourceFiles(root, fsImpl);
  const hash = crypto.createHash("sha256");
  for (const filePath of files) {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    const content = normalizedSourceBytes(filePath, fsImpl);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { fingerprint: hash.digest("hex"), fileCount: files.length, files };
}

function coreSourceFingerprint(rootDir, fsImpl = fs) {
  return coreSourceFingerprintDetails(rootDir, fsImpl).fingerprint;
}

module.exports = {
  CORE_SOURCE_ENTRIES,
  coreSourceFingerprint,
  coreSourceFingerprintDetails,
  sourceFiles
};
