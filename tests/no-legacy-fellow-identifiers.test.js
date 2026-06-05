const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const scannedRoots = ["src", "packages", "apps/mobile-rn/src", "scripts"];
const scannedExtension = /\.(js|ts|tsx|css|html|json|md)$/;
const legacyFellowIdentifier = /fellow/i;

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (scannedExtension.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectLegacyFellowIdentifiers() {
  const offenders = [];
  for (const scannedRoot of scannedRoots) {
    const fullRoot = path.join(root, scannedRoot);
    if (!fs.existsSync(fullRoot)) continue;
    for (const file of walkFiles(fullRoot)) {
      const relativePath = path.relative(root, file);
      offenders.push(...collectLegacyFellowIdentifiersInFile(relativePath, fs.readFileSync(file, "utf8")));
    }
  }
  return offenders;
}

function collectLegacyFellowIdentifiersInFile(relativePath, source) {
  const offenders = [];
  if (legacyFellowIdentifier.test(relativePath)) {
    offenders.push(`${relativePath}: path contains legacy fellow identifier`);
  }
  const lines = String(source || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (legacyFellowIdentifier.test(line)) {
      offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    }
  });
  return offenders;
}

test("legacy identifier guard catches camelCase content and path names", () => {
  assert.deepEqual(
    collectLegacyFellowIdentifiersInFile("src/main/bot-runtime-control.js", "const fellowKey = 'mia';"),
    ["src/main/bot-runtime-control.js:1: const fellowKey = 'mia';"]
  );
  assert.deepEqual(
    collectLegacyFellowIdentifiersInFile("src/shared/fellow-runtime-control.js", "const botKey = 'mia';"),
    ["src/shared/fellow-runtime-control.js: path contains legacy fellow identifier"]
  );
});

test("production source does not contain legacy bot-era identifiers", () => {
  const offenders = collectLegacyFellowIdentifiers();
  assert.deepEqual(offenders, [], `Legacy fellow identifiers found:\n${offenders.join("\n")}`);
});
