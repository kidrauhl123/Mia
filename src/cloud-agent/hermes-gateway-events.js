"use strict";

const EVENT_TYPE_MAP = Object.freeze({
  "reasoning.delta": "reasoning_delta",
  "thinking.delta": "thinking_delta",
  "tool.start": "tool.started",
  "tool.progress": "tool.delta",
  "tool.complete": "tool.completed"
});

function normalizeGatewayEvent(event = {}) {
  const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
  return {
    ...payload,
    type: EVENT_TYPE_MAP[event.type] || String(event.type || ""),
    session_id: String(event.session_id || ""),
    rawGatewayEvent: event
  };
}

module.exports = {
  normalizeGatewayEvent
};
