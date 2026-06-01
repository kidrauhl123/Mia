const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "web", "app.js"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "..", "src", "web", "app", "index.html"), "utf8");

test("web bootstrap requests compact identity payloads before rendering conversations", () => {
  assert.match(appSource, /api\("\/api\/me\?compact=1"\)/);
  assert.match(appSource, /api\("\/api\/me\/fellows\?compact=1"\)/);
});

test("web app shell cache-busts the compact bootstrap app bundle", () => {
  assert.match(appHtml, /src="\.\.\/app\.js\?v=20260601-web-bootstrap-compact"/);
});
