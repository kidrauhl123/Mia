"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  coreConversationRuntimeEnvelope,
  coreLocalEventEnvelope,
  createMiaCoreLocalEventsClient
} = require("../src/main/mia-core/event-client.js");

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  emit(name, payload = {}) {
    if (name === "open") this.readyState = FakeSocket.OPEN;
    if (name === "close") this.readyState = FakeSocket.CLOSED;
    this.listeners.get(name)?.(payload);
  }

  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
}
FakeSocket.instances = [];

test("Core local event envelope maps Core websocket events to renderer cloud-event shape", () => {
  assert.deepEqual(
    coreLocalEventEnvelope({ name: "conversation.messageCreated", data: { id: "m1" } }),
    {
      type: "conversation.messageCreated",
      payload: { id: "m1" },
      coreEnvelope: { name: "conversation.messageCreated", data: { id: "m1" } }
    }
  );
  assert.deepEqual(
    coreLocalEventEnvelope({ name: "events_ready", data: { cloud: { enabled: true }, serverSeq: 2 } }),
    {
      type: "events_ready",
      payload: { cloud: { enabled: true }, serverSeq: 2 },
      cloud: { enabled: true },
      coreEnvelope: { name: "events_ready", data: { cloud: { enabled: true }, serverSeq: 2 } }
    }
  );
  assert.equal(coreLocalEventEnvelope({ name: "task.updated", data: { jobId: "task_1" } }), null);
  assert.deepEqual(
    coreLocalEventEnvelope({ name: "task.runFinished", data: { jobId: "task_1", runId: "run_1" } }, { includeTaskEvents: true }),
    {
      name: "task.runFinished",
      data: { jobId: "task_1", runId: "run_1" },
      type: "finished",
      payload: { jobId: "task_1", taskId: "task_1", runId: "run_1" },
      coreEnvelope: { name: "task.runFinished", data: { jobId: "task_1", runId: "run_1" } }
    }
  );
});

test("Core conversation runtime events map to existing renderer streaming events", () => {
  assert.deepEqual(
    coreConversationRuntimeEnvelope({
      name: "conversation.runtimeStarted",
      data: { conversationId: "conv_1", turnId: "turn_1", engine: "mock-agent", botId: "mia" }
    }),
    {
      type: "cloud_agent_run_started",
      payload: {
        conversationId: "conv_1",
        runId: "turn_1",
        turnId: "turn_1",
        hermesRunId: "turn_1",
        botId: "mia",
        engine: "mock-agent"
      },
      coreEnvelope: {
        name: "conversation.runtimeStarted",
        data: { conversationId: "conv_1", turnId: "turn_1", engine: "mock-agent", botId: "mia" }
      }
    }
  );
  assert.deepEqual(
    coreConversationRuntimeEnvelope({
      name: "conversation.runtimeStdout",
      data: { conversationId: "conv_1", turnId: "turn_1", text: "hello " }
    }),
    {
      type: "cloud_agent_run_event",
      payload: {
        conversationId: "conv_1",
        runId: "turn_1",
        turnId: "turn_1",
        event: { type: "text_delta", text: "hello " }
      },
      coreEnvelope: {
        name: "conversation.runtimeStdout",
        data: { conversationId: "conv_1", turnId: "turn_1", text: "hello " }
      }
    }
  );
  assert.deepEqual(
    coreConversationRuntimeEnvelope({
      name: "conversation.runtimeFinished",
      data: { conversationId: "conv_1", turnId: "turn_1", ok: true, cancelled: false }
    }).payload.event,
    { type: "run.completed" }
  );
  assert.deepEqual(
    coreConversationRuntimeEnvelope({
      name: "conversation.messageCreated",
      data: {
        conversationId: "conv_1",
        messageId: "msg_1",
        turnId: "turn_1",
        role: "assistant",
        message: { id: "msg_1", seq: 2, sender_kind: "bot", body_md: "hello" }
      }
    }),
    {
      type: "conversation.message_appended",
      payload: {
        conversationId: "conv_1",
        message: { id: "msg_1", seq: 2, sender_kind: "bot", body_md: "hello" }
      },
      coreEnvelope: {
        name: "conversation.messageCreated",
        data: {
          conversationId: "conv_1",
          messageId: "msg_1",
          turnId: "turn_1",
          role: "assistant",
          message: { id: "msg_1", seq: 2, sender_kind: "bot", body_md: "hello" }
        }
      }
    }
  );
});

test("Core Codex stdout mapper suppresses status noise and extracts JSONL text", () => {
  assert.equal(
    coreConversationRuntimeEnvelope({
      name: "conversation.runtimeStdout",
      data: {
        conversationId: "conv_1",
        turnId: "turn_1",
        engine: "codex",
        text: "Reading prompt from stdin...\n"
      }
    }),
    null
  );

  assert.deepEqual(
    coreConversationRuntimeEnvelope({
      name: "conversation.runtimeStdout",
      data: {
        conversationId: "conv_1",
        turnId: "turn_1",
        engine: "codex",
        text: JSON.stringify({ type: "agent_message_delta", delta: "hello" }) + "\n"
      }
    }).payload.event,
    { type: "message.delta", text: "hello" }
  );
});

test("Core cloud bridge message events target the renderer cloud conversation", () => {
  const coreEnvelope = {
    name: "conversation.messageCreated",
    data: {
      conversationId: "cloud_bridge_botc_u_a_mia",
      cloudConversationId: "botc_u_a_mia",
      cloudBridgeRunId: "car_1",
      messageId: "local_msg_1",
      turnId: "turn_1",
      role: "assistant",
      message: {
        id: "local_msg_1",
        conversation_id: "cloud_bridge_botc_u_a_mia",
        seq: 2,
        sender_kind: "bot",
        sender_ref: "mia",
        body_md: "done",
      }
    }
  };

  assert.deepEqual(coreConversationRuntimeEnvelope(coreEnvelope), {
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_u_a_mia",
      message: {
        id: "local_msg_1",
        conversation_id: "botc_u_a_mia",
        local_conversation_id: "cloud_bridge_botc_u_a_mia",
        seq: 2,
        sender_kind: "bot",
        sender_ref: "mia",
        body_md: "done",
        _cloudBridgeRunId: "car_1",
        _localCoreConversationId: "cloud_bridge_botc_u_a_mia"
      }
    },
    coreEnvelope
  });
});

test("Mia Core local events client subscribes to Rust Core /ws and reports connection state", () => {
  FakeSocket.instances = [];
  const envelopes = [];
  const states = [];
  const timers = [];
  const client = createMiaCoreLocalEventsClient({
    baseUrl: () => "http://127.0.0.1:27862",
    enabled: () => true,
    WebSocketImpl: FakeSocket,
    onEnvelope: (envelope) => envelopes.push(envelope),
    onStateChange: (connected) => states.push(connected),
    setTimeoutFn: (fn, delayMs) => {
      timers.push({ fn, delayMs });
      return timers.length;
    },
    clearTimeoutFn: () => {}
  });

  client.start();
  assert.equal(FakeSocket.instances[0].url, "ws://127.0.0.1:27862/ws");
  FakeSocket.instances[0].emit("open");
  FakeSocket.instances[0].emit("message", {
    data: JSON.stringify({ name: "conversation.runtimeStdout", data: { conversationId: "conv_1", turnId: "turn_1", text: "hi" } })
  });
  FakeSocket.instances[0].emit("message", {
    data: JSON.stringify({ name: "task.runFinished", data: { jobId: "task_1" } })
  });
  FakeSocket.instances[0].emit("message", { data: "not json" });

  assert.deepEqual(states, [true]);
  assert.deepEqual(envelopes, [{
    type: "cloud_agent_run_event",
    payload: {
      conversationId: "conv_1",
      runId: "turn_1",
      turnId: "turn_1",
      event: { type: "text_delta", text: "hi" }
    },
    coreEnvelope: { name: "conversation.runtimeStdout", data: { conversationId: "conv_1", turnId: "turn_1", text: "hi" } }
  }]);
  assert.equal(client.status().connected, true);

  FakeSocket.instances[0].emit("close");
  assert.equal(client.status().connected, false);
  assert.equal(timers[0].delayMs, 1000);
  timers[0].fn();
  assert.equal(FakeSocket.instances[1].url, "ws://127.0.0.1:27862/ws");

  client.stop();
  assert.equal(FakeSocket.instances[1].closed, true);
  assert.deepEqual(states, [true, false]);
});

test("Mia Core local events client stays idle when Core is disabled or unresolved", () => {
  FakeSocket.instances = [];
  const timers = [];
  const client = createMiaCoreLocalEventsClient({
    baseUrl: () => "",
    enabled: () => false,
    WebSocketImpl: FakeSocket,
    setTimeoutFn: (fn, delayMs) => {
      timers.push({ fn, delayMs });
      return timers.length;
    },
    clearTimeoutFn: () => {}
  });

  client.start();
  assert.equal(FakeSocket.instances.length, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1000);
});
