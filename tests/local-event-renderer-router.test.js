const assert = require("node:assert/strict");
const { test } = require("node:test");

const { rendererChannelForLocalEvent } = require("../src/main/daemon/local-event-renderer-router.js");

test("chat local events route to the renderer chat channel", () => {
  assert.equal(
    rendererChannelForLocalEvent(
      { type: "chat:event", payload: {} },
      { ChatEvent: "chat:event", CloudEvent: "cloud:event" }
    ),
    "chat:event"
  );
});

test("non-chat local events route to the renderer cloud channel", () => {
  assert.equal(
    rendererChannelForLocalEvent(
      { type: "cloud_agent_run_started", payload: {} },
      { ChatEvent: "chat:event", CloudEvent: "cloud:event" }
    ),
    "cloud:event"
  );
});
