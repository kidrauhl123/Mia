const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { buildHelperInfoPlist, helperLayout } = require("../build/afterpack-mia-core-helper.js");

test("helper Info.plist declares ai.mia.core identity with no Dock presence", () => {
  const plist = buildHelperInfoPlist({ appName: "Mia Core" });
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>ai\.mia\.core<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Mia Core<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});

test("helper layout nests under Resources and copies the packed executable", () => {
  const layout = helperLayout("/out/mac/Mia.app", "Mia");
  assert.equal(
    layout.helperExecPath,
    path.join("/out/mac/Mia.app", "Contents", "Resources", "Mia Core.app", "Contents", "MacOS", "Mia Core")
  );
  assert.equal(layout.sourceExecPath, path.join("/out/mac/Mia.app", "Contents", "MacOS", "Mia"));
  assert.equal(
    layout.helperInfoPlistPath,
    path.join("/out/mac/Mia.app", "Contents", "Resources", "Mia Core.app", "Contents", "Info.plist")
  );
});
