const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

function withHermesConfig() {
  return JSON.parse(fs.readFileSync(path.join(root, "electron-builder.with-hermes.json"), "utf8"));
}

test("default desktop package scripts do not build Hermes runtime", () => {
  const pkg = packageJson();

  assert.doesNotMatch(pkg.scripts.prepack || "", /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts.pack || "", /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:mac"], /hermes:runtime/);
  assert.doesNotMatch(pkg.scripts["dist:win"], /hermes:runtime/);
  assert.match(pkg.scripts["dist:mac:with-hermes"], /hermes:runtime:mac-arm64/);
  assert.match(pkg.scripts["dist:win:with-hermes"], /hermes:runtime:win-x64/);
});

test("default electron-builder resources exclude Hermes runtime", () => {
  const pkg = packageJson();
  const fallback = withHermesConfig();

  assert.doesNotMatch(JSON.stringify(pkg.build.mac || {}), /vendor\/hermes-runtime/);
  assert.doesNotMatch(JSON.stringify(pkg.build.win || {}), /vendor\/hermes-runtime/);
  assert.match(JSON.stringify(fallback), /vendor\/hermes-runtime/);
});
