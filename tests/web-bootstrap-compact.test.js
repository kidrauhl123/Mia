const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "web", "app.js"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "..", "src", "web", "app", "index.html"), "utf8");
const releaseBuilder = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-cloud-release.js"), "utf8");

test("web bootstrap requests compact identity payloads before rendering conversations", () => {
  assert.match(appSource, /api\("\/api\/me\?compact=1"\)/);
  assert.match(appSource, /api\("\/api\/me\/bots\?compact=1"\)/);
});

test("web bootstrap hydrates full avatar identities after the compact first paint", () => {
  assert.match(appSource, /function hydrateFullIdentities\(/);
  assert.match(appSource, /api\("\/api\/me"\)/);
  assert.match(appSource, /api\("\/api\/me\/bots"\)/);
  assert.match(appSource, /hydrateFullIdentities\(\)\.catch/);
});

test("web app shell cache-busts the avatar identity app bundle", () => {
  assert.match(appHtml, /src="\.\.\/app\.js\?v=[^"]+"/);
  assert.match(releaseBuilder, /function rewriteWebAssetVersions\(\)/);
  assert.match(releaseBuilder, /assetVersionForRelease\(\)/);
  assert.match(releaseBuilder, /source\.replace\(\s*\/\\\?v=/);
  assert.match(releaseBuilder, /location = \/app\//);
  assert.match(releaseBuilder, /add_header Cache-Control "no-cache"/);
});
