#!/usr/bin/env node
"use strict";

// Keep the public release directories bounded.  The update feeds only need the
// current artifact, but retaining the current release plus two earlier release
// versions gives operators a small, explicit rollback window without allowing
// installers to consume the server disk indefinitely.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_KEEP_VERSIONS = 3;
const DEFAULT_PRODUCT_NAME = "Mia";
const DEFAULT_DIRECTORIES = [
  "/var/www/mia-updates",
  "/var/www/mia-web/downloads",
];
const ARTIFACT_FAMILIES = new Set(["macOS", "Windows", "Android"]);

function parseKeepVersions(value, label = "keep") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function compareVersionsDescending(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
  }
  return 0;
}

function desktopArtifactInfo(fileName, productName = DEFAULT_PRODUCT_NAME) {
  const escapedProduct = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fileName.match(new RegExp(`^${escapedProduct}-(\\d+\\.\\d+\\.\\d+)-(.+)$`));
  if (!match) return null;

  const [, version, suffix] = match;
  if (/^(?:Apple-Silicon|Intel)\.dmg$/.test(suffix) || /(?:^|-)mac\.zip(?:\.blockmap)?$/.test(suffix)) {
    return { family: "macOS", version };
  }
  if (/^(?:Setup|Update)\.exe(?:\.blockmap)?$/.test(suffix)) {
    return { family: "Windows", version };
  }
  return null;
}

function androidArtifactInfo(fileName) {
  const match = fileName.match(/^mia-android-(\d+)\.apk$/);
  if (!match) return null;
  return { family: "Android", version: Number(match[1]) };
}

function compareArtifactVersionsDescending(family, left, right) {
  if (family === "Android") return right - left;
  return compareVersionsDescending(left, right);
}

function isPlainFileName(value) {
  const name = String(value || "").trim();
  return Boolean(name) && name === path.posix.basename(name) && !name.includes("\\");
}

function normalizeRemoteDirectory(value) {
  const directory = String(value || "").trim().replace(/\/+$/, "") || "/";
  if (!/^\/[A-Za-z0-9._/-]*$/.test(directory) || directory.split("/").includes("..")) {
    throw new Error(`Remote release directory must be an absolute plain path: ${value}`);
  }
  return directory;
}

function normalizeRemoteProductName(value) {
  const productName = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(productName)) {
    throw new Error("Remote product name must contain only letters, digits, dots, underscores, or hyphens.");
  }
  return productName;
}

function normalizeArtifactFamilies(values) {
  if (values == null) return null;
  if (!Array.isArray(values)) throw new Error("Release artifact families must be an array.");
  const families = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!families.length) return null;
  for (const family of families) {
    if (!ARTIFACT_FAMILIES.has(family)) {
      throw new Error(`Unsupported release artifact family: ${family}`);
    }
  }
  return families;
}

function protectedFeedArtifacts(directory) {
  const protectedNames = new Set();
  for (const feedName of ["latest-mac.yml", "latest.yml", "mia-mobile-update.json"]) {
    const feedPath = path.join(directory, feedName);
    if (!fs.existsSync(feedPath)) continue;
    const source = fs.readFileSync(feedPath, "utf8");
    const references = feedName === "mia-mobile-update.json"
      ? [...source.matchAll(/"apkUrl"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
      : [...source.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)].map((match) => match[1]);
    for (const reference of references) {
      const name = path.posix.basename(String(reference).split(/[?#]/, 1)[0]);
      if (!isPlainFileName(name)) continue;
      protectedNames.add(name);
      if (feedName !== "mia-mobile-update.json") protectedNames.add(`${name}.blockmap`);
    }
  }
  return protectedNames;
}

function readArtifactEntries(directory, productName) {
  if (!fs.existsSync(directory)) return { exists: false, entries: [], protectedNames: new Set() };
  const protectedNames = protectedFeedArtifacts(directory);
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const desktop = desktopArtifactInfo(entry.name, productName);
      const android = androidArtifactInfo(entry.name);
      const info = desktop || android;
      if (!info) return null;
      const fullPath = path.join(directory, entry.name);
      return {
        fileName: entry.name,
        fullPath,
        size: fs.statSync(fullPath).size,
        ...info,
        protectedByFeed: protectedNames.has(entry.name),
      };
    })
    .filter(Boolean);
  return { exists: true, entries, protectedNames };
}

function planReleaseArtifactPrune({
  directories = DEFAULT_DIRECTORIES,
  keepVersions = DEFAULT_KEEP_VERSIONS,
  productName = DEFAULT_PRODUCT_NAME,
  families,
} = {}) {
  const keep = parseKeepVersions(keepVersions);
  const selectedFamilies = normalizeArtifactFamilies(families);
  const selectedFamilySet = selectedFamilies ? new Set(selectedFamilies) : null;
  if (!Array.isArray(directories) || !directories.length) throw new Error("At least one release directory is required.");

  return directories.map((directoryValue) => {
    const directory = path.resolve(String(directoryValue));
    const inventory = readArtifactEntries(directory, productName);
    const versionSets = new Map();
    for (const entry of inventory.entries) {
      if (selectedFamilySet && !selectedFamilySet.has(entry.family)) continue;
      if (!versionSets.has(entry.family)) versionSets.set(entry.family, new Set());
      versionSets.get(entry.family).add(entry.version);
    }
    const retainedVersions = new Map([...versionSets].map(([family, versions]) => [
      family,
      new Set([...versions].sort((left, right) => compareArtifactVersionsDescending(family, left, right)).slice(0, keep)),
    ]));
    const retained = inventory.entries.filter((entry) => (
      (selectedFamilySet && !selectedFamilySet.has(entry.family))
      || entry.protectedByFeed
      || retainedVersions.get(entry.family)?.has(entry.version)
    ));
    const removed = inventory.entries.filter((entry) => (
      (!selectedFamilySet || selectedFamilySet.has(entry.family))
      && !entry.protectedByFeed
      && !retainedVersions.get(entry.family)?.has(entry.version)
    ));

    return {
      directory,
      exists: inventory.exists,
      keep,
      families: selectedFamilies,
      retainedVersions,
      retained,
      removed,
      bytesToRemove: removed.reduce((sum, entry) => sum + entry.size, 0),
    };
  });
}

function applyReleaseArtifactPrune(plans) {
  for (const plan of plans) {
    for (const entry of plan.removed) {
      const stat = fs.lstatSync(entry.fullPath, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error(`Refusing to remove a changed release artifact: ${entry.fullPath}`);
      fs.unlinkSync(entry.fullPath);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

function printPrunePlan(plans, { apply = false } = {}) {
  const mode = apply ? "removed" : "would remove";
  for (const plan of plans) {
    if (!plan.exists) {
      console.log(`[release-retention] skipped missing directory: ${plan.directory}`);
      continue;
    }
    const retained = [...plan.retainedVersions]
      .map(([family, versions]) => `${family}=${[...versions].join(",") || "none"}`)
      .join(" ");
    const scope = plan.families?.join(",") || "all platforms";
    console.log(`[release-retention] ${plan.directory}: scope ${scope}; retain ${retained || "no managed artifacts"}`);
    console.log(`[release-retention] ${mode} ${plan.removed.length} artifact(s), ${formatBytes(plan.bytesToRemove)}`);
  }
}

function runRemoteReleaseArtifactPrune({
  remote,
  directories = DEFAULT_DIRECTORIES,
  keepVersions = DEFAULT_KEEP_VERSIONS,
  productName = DEFAULT_PRODUCT_NAME,
  families,
  apply = false,
  cwd,
  spawnSync = childProcess.spawnSync,
} = {}) {
  const target = String(remote || "").trim();
  if (!target) throw new Error("A remote SSH target is required for remote release-artifact retention.");
  const keep = parseKeepVersions(keepVersions);
  const safeProductName = normalizeRemoteProductName(productName);
  const safeDirectories = directories.map(normalizeRemoteDirectory);
  const safeFamilies = normalizeArtifactFamilies(families);
  const args = ["-", "--keep", String(keep), "--product", safeProductName];
  for (const directory of safeDirectories) args.push("--dir", directory);
  for (const family of safeFamilies || []) args.push("--family", family);
  if (apply) args.push("--apply");
  const result = spawnSync("ssh", [target, "node", ...args], {
    cwd,
    input: fs.readFileSync(__filename),
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Remote release-artifact retention failed with exit status ${result.status}.`);
}

function parseArgs(argv) {
  const options = { directories: [], families: [], keepVersions: DEFAULT_KEEP_VERSIONS, productName: DEFAULT_PRODUCT_NAME, apply: false, remote: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--keep") {
      options.keepVersions = parseKeepVersions(argv[++index], "--keep");
    } else if (argument === "--product") {
      options.productName = String(argv[++index] || "").trim();
      if (!options.productName) throw new Error("--product requires a value.");
    } else if (argument === "--dir") {
      const directory = String(argv[++index] || "").trim();
      if (!directory) throw new Error("--dir requires a value.");
      options.directories.push(directory);
    } else if (argument === "--family") {
      const family = String(argv[++index] || "").trim();
      if (!family) throw new Error("--family requires a value.");
      options.families.push(family);
    } else if (argument === "--remote") {
      options.remote = String(argv[++index] || "").trim();
      if (!options.remote) throw new Error("--remote requires an SSH target.");
    } else if (argument === "--help") {
      console.log("Usage: node scripts/prune-release-artifacts.js [--dir <path>] [--family <macOS|Windows|Android>] [--keep <count>] [--apply] [--remote <ssh-target>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.directories.length) options.directories = [...DEFAULT_DIRECTORIES];
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.remote) {
    runRemoteReleaseArtifactPrune({ ...options });
    return;
  }
  const plans = planReleaseArtifactPrune(options);
  if (options.apply) applyReleaseArtifactPrune(plans);
  printPrunePlan(plans, options);
  if (!options.apply) console.log("[release-retention] dry run only; add --apply to delete the listed historical artifacts.");
}

// `node -` is used for the SSH self-transfer path; stdin modules do not set
// require.main consistently across supported Node releases.
if (require.main === module || process.argv[1] === "-") main();

module.exports = {
  DEFAULT_DIRECTORIES,
  DEFAULT_KEEP_VERSIONS,
  applyReleaseArtifactPrune,
  androidArtifactInfo,
  ARTIFACT_FAMILIES,
  desktopArtifactInfo,
  normalizeArtifactFamilies,
  normalizeRemoteDirectory,
  parseKeepVersions,
  planReleaseArtifactPrune,
  runRemoteReleaseArtifactPrune,
};
