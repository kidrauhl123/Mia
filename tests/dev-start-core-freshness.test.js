const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

test("desktop development commands build Mia Core before Electron", () => {
  assert.equal(packageJson.scripts["core:dev"], "cargo build -p mia-core-app --bin mia-core");
  assert.equal(packageJson.scripts.start, "npm run core:dev && electron .");
  assert.equal(packageJson.scripts.open, "npm run core:dev && electron .");
});
