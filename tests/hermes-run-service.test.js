const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createHermesRunService } = require("../src/main/hermes-run-service.js");

function service(overrides = {}) {
  return createHermesRunService({
    normalizeAttachments: (attachments) => Array.isArray(attachments) ? attachments : [],
    attachmentContext: (attachments = []) => attachments.map((item) => `ctx:${item.name}`).join("\n"),
    baseUrl: () => "http://hermes.test",
    apiKey: () => "secret",
    fetchImpl: async () => {
      throw new Error("fetch not configured");
    },
    randomUUID: () => "uuid_1",
    ...overrides
  });
}

function streamResponse(text) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      }
    })
  };
}

test("buildRunPayload normalizes messages into Hermes run input, history, and metadata", () => {
  const runs = service();
  const payload = runs.buildRunPayload({
    fellow: {
      key: "alice",
      name: "Alice",
      account_id: "acct",
      route_profile: "route"
    },
    sessionId: "bad session id!*",
    messages: [
      { role: "system", content: "system one" },
      { role: "user", content: "first", attachments: [{ name: "first.png" }] },
      { role: "assistant", content: "reply" },
      { role: "user", content: "last", attachments: [{ name: "last.png" }] }
    ]
  });

  assert.deepEqual(payload, {
    model: "hermes-agent",
    input: "last\n\n附件上下文：\nctx:last.png",
    session_id: "bad_session_id_",
    account_id: "acct",
    metadata: {
      fellow_key: "alice",
      persona_key: "alice",
      account_id: "acct",
      route_profile: "route",
      display_name: "Alice"
    },
    instructions: "system one",
    conversation_history: [
      { role: "user", content: "first\n\nctx:first.png" },
      { role: "assistant", content: "reply" }
    ]
  });
});

test("slashCommandText and lastUserPrompt share the same normalized message surface", () => {
  const runs = service();
  const messages = [
    { role: "system", content: "/ignored" },
    { role: "assistant", content: "ok" },
    { role: "user", content: " /status now " }
  ];

  assert.equal(runs.slashCommandText(messages), "/status now");
  assert.equal(runs.lastUserPrompt(messages), "/status now");
  assert.equal(runs.slashCommandText([{ role: "user", content: "hello" }]), "");
});

test("readRunEventStream emits deltas and returns final run content", async () => {
  const emitted = [];
  const runs = service({
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://hermes.test/v1/runs/run_1/events");
      assert.equal(options.headers.Authorization, "Bearer secret");
      return streamResponse([
        "event: message.delta",
        "data: {\"delta\":\"Hel\"}",
        "",
        "event: message.delta",
        "data: {\"delta\":\"lo\"}",
        "",
        "event: tool.completed",
        "data: {\"tool\":\"search\",\"duration\":12}",
        "",
        "event: run.completed",
        "data: {\"final_response\":\"Done\"}",
        "",
        ""
      ].join("\n"));
    }
  });

  const result = await runs.readRunEventStream({
    runId: "run_1",
    signal: null,
    emit: (kind, payload) => emitted.push({ kind, payload })
  });

  assert.equal(result.content, "Done");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(emitted, [
    { kind: "text_delta", payload: { id: "text_uuid_1", text: "Hel" } },
    { kind: "text_delta", payload: { id: "text_uuid_1", text: "lo" } },
    { kind: "tool_call_completed", payload: { name: "search", duration: 12, error: false, matchByName: true } }
  ]);
  assert.deepEqual(result.events.map((item) => item.event), ["message.delta", "message.delta", "tool.completed", "run.completed"]);
});

test("readRunEventStream normalizes run.failed provider configuration errors", async () => {
  const runs = service({
    fetchImpl: async () => streamResponse([
      "event: run.failed",
      "data: {\"error\":\"no API key was found\"}",
      "",
      ""
    ].join("\n"))
  });

  await assert.rejects(
    () => runs.readRunEventStream({ runId: "run_1", signal: null, emit: null }),
    /请在右侧 Model 选择.*API key/
  );
});
