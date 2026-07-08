const assert = require("node:assert/strict");
const { test } = require("node:test");

let requestGates = {};
try {
  requestGates = require("../src/main/mia-core/request-gates.js");
} catch {
  requestGates = {};
}

test("Core requests that start streaming turns require the local event bridge", () => {
  const { coreRequestRequiresStreamingEvents } = requestGates;

  assert.equal(typeof coreRequestRequiresStreamingEvents, "function");
  assert.equal(coreRequestRequiresStreamingEvents({
    method: "POST",
    route: "/api/cloud/bridge/run"
  }), true);
  assert.equal(coreRequestRequiresStreamingEvents({
    method: "POST",
    route: "/api/conversations/conv_123/messages"
  }), true);
  assert.equal(coreRequestRequiresStreamingEvents({
    method: "GET",
    route: "/api/conversations/conv_123/messages"
  }), false);
  assert.equal(coreRequestRequiresStreamingEvents({
    method: "POST",
    route: "/api/conversations/conv_123/turns/run_123/cancel"
  }), false);
  assert.equal(coreRequestRequiresStreamingEvents({
    method: "POST",
    route: "/api/cloud/events/start"
  }), false);
});
