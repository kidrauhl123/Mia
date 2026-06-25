"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const coreProcess = require("../src/main/mia-core/local-process-control.js");

test("mia core process control exports core-named compatibility APIs", () => {
  assert.equal(typeof coreProcess.createMiaCoreControlServer, "function");
  assert.equal(typeof coreProcess.createMiaCoreTasksClient, "function");
  assert.equal(typeof coreProcess.createMiaCoreLocalEventsClient, "function");
  assert.equal(typeof coreProcess.createMiaCoreProcessLauncher, "function");
  assert.equal(typeof coreProcess.coreNeedsReplacement, "function");
});
