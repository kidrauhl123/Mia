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
    bot: {
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
      bot_id: "alice",
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

test("buildRunPayload applies per-turn runtime model and control metadata", () => {
  const runs = service();
  const payload = runs.buildRunPayload({
    bot: {
      key: "alice",
      name: "Alice"
    },
    sessionId: "s1",
    model: "mia-pro",
    effortLevel: "high",
    permissionMode: "auto",
    messages: [
      { role: "system", content: "system one" },
      { role: "user", content: "last" }
    ]
  });

  assert.equal(payload.model, "mia-pro");
  assert.equal(payload.metadata.effort_level, "high");
  assert.equal(payload.metadata.permission_mode, "auto");
});

test("slashCommandText and lastUserPrompt share the same normalized message surface", () => {
  const runs = service();
  const messages = [
    { role: "user", content: " /status now " }
  ];

  assert.equal(runs.slashCommandText(messages), "/status now");
  assert.equal(runs.lastUserPrompt(messages), "/status now");
  assert.equal(runs.slashCommandText([{ role: "user", content: "hello" }]), "");
});

test("lastUserPrompt carries prior system and dialogue context for single-prompt engines", () => {
  const runs = service();
  const prompt = runs.lastUserPrompt([
    { role: "system", content: "你是剧情主持" },
    { role: "user", content: "前面我要选哪项", attachments: [{ name: "plan.png" }] },
    { role: "assistant", content: "建议选 1" },
    { role: "user", content: "那我选 1", attachments: [{ name: "choice.png" }] }
  ]);

  assert.match(prompt, /会话前文（按时间顺序）：/);
  assert.match(prompt, /系统：你是剧情主持/);
  assert.match(prompt, /用户：前面我要选哪项/);
  assert.match(prompt, /ctx:plan\.png/);
  assert.match(prompt, /助手：建议选 1/);
  assert.match(prompt, /当前用户消息：\n那我选 1/);
  assert.match(prompt, /ctx:choice\.png/);
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

test("readRunEventStream emits Hermes result_display file diffs as file_edit events", async () => {
  const emitted = [];
  const runs = service({
    fetchImpl: async () => streamResponse([
      "event: tool.completed",
      "data: {\"tool\":\"edit\",\"result_display\":{\"file_diff\":{\"path\":\"src/app.js\",\"diff\":\"@@\\n-old\\n+new\"}}}",
      "",
      "event: run.completed",
      "data: {\"final_response\":\"Done\"}",
      "",
      ""
    ].join("\n"))
  });

  await runs.readRunEventStream({
    runId: "run_1",
    signal: null,
    emit: (kind, payload) => emitted.push({ kind, payload })
  });

  assert.deepEqual(emitted.filter((event) => event.kind === "file_edit"), [{
    kind: "file_edit",
    payload: {
      id: "edit_diff_0",
      path: "src/app.js",
      action: "update",
      title: "Edited src/app.js (+1 -1)",
      diff: "@@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "completed",
      error: false
    }
  }]);
});

test("readRunEventStream normalizes generic provider configuration errors without stale UI directions", async () => {
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
    (error) => {
      assert.match(error.message, /模型/);
      assert.doesNotMatch(error.message, /右侧 Model/);
      return true;
    }
  );
});

test("readRunEventStream treats bare missing-key errors as Mia Cloud failures when runtime is Mia managed", async () => {
  const runs = service({
    fetchImpl: async () => streamResponse([
      "event: run.failed",
      "data: {\"error\":\"no API key was found\"}",
      "",
      ""
    ].join("\n"))
  });

  await assert.rejects(
    () => runs.readRunEventStream({
      runId: "run_1",
      signal: null,
      emit: null,
      runtimeContext: {
        providerConnectionId: "mia",
        modelProfileId: "mia:mia-auto",
        model: "mia-auto"
      }
    }),
    (error) => {
      assert.match(error.message, /Mia Cloud/);
      assert.match(error.message, /Auto/);
      assert.doesNotMatch(error.message, /填 API key/);
      assert.doesNotMatch(error.message, /右侧 Model/);
      return true;
    }
  );
});

test("readRunEventStream normalizes Mia managed provider configuration errors", async () => {
  const runs = service({
    fetchImpl: async () => streamResponse([
      "event: run.failed",
      "data: {\"error\":\"no API key was found for provider mia\"}",
      "",
      ""
    ].join("\n"))
  });

  await assert.rejects(
    () => runs.readRunEventStream({ runId: "run_1", signal: null, emit: null }),
    (error) => {
      assert.match(error.message, /Mia 官方模型/);
      assert.match(error.message, /Mia Cloud/);
      assert.doesNotMatch(error.message, /填 API key/);
      return true;
    }
  );
});
