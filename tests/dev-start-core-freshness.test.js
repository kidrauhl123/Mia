const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const openCommand = fs.readFileSync(path.join(__dirname, "..", "open-mia.command"), "utf8");

test("desktop development commands use the isolated launcher", () => {
  assert.equal(packageJson.scripts["core:dev"], "cargo build -p mia-core-app --bin mia-core");
  assert.equal(packageJson.scripts.start, "node scripts/start-dev.js");
  assert.equal(packageJson.scripts.open, "node scripts/start-dev.js");
  assert.equal(packageJson.scripts.dev, "node scripts/start-dev.js");
  assert.equal(packageJson.scripts["dev:multi"], "node scripts/start-dev.js --multi");
  assert.equal(packageJson.scripts["start:multi"], "node scripts/start-dev.js --multi");
});

test("double-click launcher validates Electron and delegates Core build to start-dev", () => {
  assert.match(openCommand, /require\("electron"\)/);
  assert.match(openCommand, /existsSync\(electron\)/);
  assert.match(openCommand, /npm install --include=dev/);
  assert.match(openCommand, /exec npm run open/);
  assert.doesNotMatch(openCommand, /\[ ! -d "node_modules\/electron" \]/);
  assert.doesNotMatch(openCommand, /core:prepare|CORE_CANDIDATES|cargo build/);
});
