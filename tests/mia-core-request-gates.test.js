const assert = require("node:assert/strict");
const { test } = require("node:test");

let requestGates = {};
try {
  requestGates = require("../src/main/mia-core/request-gates.js");
} catch {
  requestGates = {};
}

test("Core requests that start bridge streaming turns warm the local event bridge", () => {
  const {
    coreRequestRequiresStreamingEvents,
    coreRequestShouldWaitForStreamingEvents
  } = requestGates;
  const shouldWait = coreRequestShouldWaitForStreamingEvents || coreRequestRequiresStreamingEvents;

  assert.equal(typeof shouldWait, "function");
  assert.equal(shouldWait({
    method: "POST",
    route: "/api/cloud/bridge/run"
  }), true);
  assert.equal(shouldWait({
    method: "POST",
    route: "/api/conversations/conv_123/messages"
  }), false);
  assert.equal(shouldWait({
    method: "GET",
    route: "/api/conversations/conv_123/messages"
  }), false);
  assert.equal(shouldWait({
    method: "POST",
    route: "/api/conversations/conv_123/turns/run_123/cancel"
  }), false);
  assert.equal(shouldWait({
    method: "POST",
    route: "/api/cloud/events/start"
  }), false);
});
