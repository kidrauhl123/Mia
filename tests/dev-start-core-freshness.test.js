const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

test("desktop development commands use the isolated launcher", () => {
  assert.equal(packageJson.scripts["core:dev"], "cargo build -p mia-core-app --bin mia-core");
  assert.equal(packageJson.scripts.start, "node scripts/start-dev.js");
  assert.equal(packageJson.scripts.open, "node scripts/start-dev.js");
  assert.equal(packageJson.scripts.dev, "node scripts/start-dev.js");
  assert.equal(packageJson.scripts["dev:multi"], "node scripts/start-dev.js --multi");
  assert.equal(packageJson.scripts["start:multi"], "node scripts/start-dev.js --multi");
});
