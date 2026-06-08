const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("mobile preview APK builds auto-increment Android versionCode", () => {
  const eas = JSON.parse(fs.readFileSync(path.join(root, "apps/mobile-rn/eas.json"), "utf8"));
  assert.equal(eas.build.preview.autoIncrement, true);
  assert.equal(eas.build.preview.android.buildType, "apk");
});
