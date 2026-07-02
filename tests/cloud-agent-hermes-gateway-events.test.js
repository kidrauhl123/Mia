const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeGatewayEvent } = require("../src/cloud-agent/hermes-gateway-events.js");

test("normalizeGatewayEvent preserves message.delta and lifts payload.text onto the event", () => {
  const raw = {
    type: "message.delta",
    session_id: "sess_1",
    payload: {
      text: "hello",
      message_id: "msg_1"
    }
  };

  assert.deepEqual(normalizeGatewayEvent(raw), {
    type: "message.delta",
    session_id: "sess_1",
    rawGatewayEvent: raw,
    text: "hello",
    message_id: "msg_1"
  });
});

test("normalizeGatewayEvent maps Hermes gateway event names to Mia collector event names", () => {
  assert.equal(normalizeGatewayEvent({ type: "reasoning.delta", session_id: "sess_1", payload: {} }).type, "reasoning_delta");
  assert.equal(normalizeGatewayEvent({ type: "thinking.delta", session_id: "sess_1", payload: {} }).type, "thinking_delta");
  assert.equal(normalizeGatewayEvent({ type: "tool.start", session_id: "sess_1", payload: {} }).type, "tool.started");
  assert.equal(normalizeGatewayEvent({ type: "tool.progress", session_id: "sess_1", payload: {} }).type, "tool.delta");
  assert.equal(normalizeGatewayEvent({ type: "tool.complete", session_id: "sess_1", payload: {} }).type, "tool.completed");
  assert.equal(normalizeGatewayEvent({ type: "message.complete", session_id: "sess_1", payload: {} }).type, "message.complete");
  assert.equal(normalizeGatewayEvent({ type: "approval.request", session_id: "sess_1", payload: {} }).type, "approval.request");
  assert.equal(normalizeGatewayEvent({ type: "error", session_id: "sess_1", payload: {} }).type, "error");
});

test("normalizeGatewayEvent keeps normalized top-level fields when payload has conflicting keys", () => {
  const raw = {
    type: "tool.progress",
    session_id: "sess_1",
    payload: {
      type: "bad.type",
      session_id: "bad_session",
      rawGatewayEvent: "bad_raw",
      delta: "working"
    }
  };

  assert.deepEqual(normalizeGatewayEvent(raw), {
    type: "tool.delta",
    session_id: "sess_1",
    rawGatewayEvent: raw,
    delta: "working"
  });
});
