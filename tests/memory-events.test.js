const assert = require("node:assert/strict");
const { test } = require("node:test");

const { MemoryEvent, memoryChangedEnvelope } = require("../src/shared/memory-events.js");

test("memoryChangedEnvelope publishes compact metadata without memory text", () => {
  const envelope = memoryChangedEnvelope("remember", {
    status: "active",
    memoryId: "mem_1",
    effectiveScope: "bot",
    memory: {
      id: "mem_1",
      text: "User private preference must not be in the event",
      botId: "mei",
      sessionId: "s1",
      revision: 3
    }
  }, {
    eventSource: "agent_tool"
  });

  assert.equal(envelope.type, MemoryEvent.Updated);
  assert.deepEqual(envelope.payload, {
    type: "memory.updated",
    reason: "remember",
    source: "agent_tool",
    memory: {
      id: "mem_1",
      status: "active",
      scope: "bot",
      botId: "mei",
      sessionId: "s1",
      revision: 3
    }
  });
  assert.doesNotMatch(JSON.stringify(envelope), /private preference/);
});

test("memoryChangedEnvelope marks hard deletes as memory.deleted", () => {
  const envelope = memoryChangedEnvelope("delete", {
    status: "deleted",
    memoryId: "mem_2",
    count: 3
  }, {
    eventSource: "ui"
  });

  assert.equal(envelope.type, MemoryEvent.Deleted);
  assert.equal(envelope.payload.source, "ui");
  assert.equal(envelope.payload.memory.id, "mem_2");
  assert.equal(envelope.payload.count, 3);
});
