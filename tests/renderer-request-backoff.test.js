"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { createRequestBackoff } = require("../src/renderer/request-backoff.js");

const root = path.resolve(__dirname, "..");

test("request backoff spaces repeated failures and resets after success", () => {
  let now = 10_000;
  const backoff = createRequestBackoff({
    now: () => now,
    baseDelayMs: 1_000,
    maxDelayMs: 4_000
  });

  assert.equal(backoff.canRun("runtime"), true);
  assert.deepEqual(backoff.fail("runtime"), {
    failures: 1,
    retryAt: 11_000,
    delayMs: 1_000
  });
  assert.equal(backoff.canRun("runtime"), false);

  now = 11_000;
  assert.equal(backoff.canRun("runtime"), true);
  assert.equal(backoff.fail("runtime").delayMs, 2_000);

  now = 13_000;
  assert.equal(backoff.fail("runtime").delayMs, 4_000);
  now = 17_000;
  assert.equal(backoff.fail("runtime").delayMs, 4_000);

  backoff.succeed("runtime");
  assert.equal(backoff.canRun("runtime"), true);
  assert.equal(backoff.state("runtime").failures, 0);
});

test("renderer request paths use backoff and only re-render for a changed model catalog", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const modelSettings = fs.readFileSync(path.join(root, "src/renderer/settings/model-settings.js"), "utf8");

  assert.match(html, /request-backoff\.js[\s\S]*model-settings\.js[\s\S]*app\.js/);
  assert.match(app, /runtimeRequestBackoff\.canRun\(backoffKey\)/);
  assert.match(app, /runtimeRequestBackoff\.canRun\(runtimeBindingBackoffKey\)/);
  assert.match(app, /loadPlatformModelCatalog\(\)\.then\(\(result\) => \{\s*if \(!result\?\.changed\) return;/);
  assert.match(modelSettings, /runtimeOptionsBackoff\.canRun\(RUNTIME_OPTIONS_REQUEST_KEY\)/);
});
