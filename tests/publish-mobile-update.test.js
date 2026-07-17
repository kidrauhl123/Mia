"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { latestApkAliasCommand } = require("../scripts/publish-mobile-update.js");

test("mobile update publisher atomically repoints latest without overwriting the prior version", () => {
  const command = latestApkAliasCommand({
    downloadsDir: "/var/www/mia-web/downloads",
    apkName: "mia-android-27.apk",
    latestApkName: "mia-android-latest.apk",
    nonce: "test",
  });

  assert.match(command, /ln -sfn 'mia-android-27\.apk'/);
  assert.match(command, /mv -fT/);
  assert.match(command, /\.mia-android-latest\.apk\.test\.tmp/);
  assert.doesNotMatch(command, /\bcp\b/);
});
