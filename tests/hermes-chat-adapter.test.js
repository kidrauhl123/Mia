const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHermesChatAdapter } = require("../src/main/hermes-chat-adapter.js");

function response({ ok = true, status = 200, statusText = "OK", body = {} } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => typeof body === "string" ? body : JSON.stringify(body)
  };
}

function createDeps(overrides = {}) {
  const fetchCalls = [];
  const streamCalls = [];
  const schedulerContextWrites = [];
  const deps = {
    fetchCalls,
    streamCalls,
    schedulerContextWrites,
    writeSchedulerMcpContext: (ctx) => { schedulerContextWrites.push(ctx); },
    apiKey: () => "secret",
    baseUrl: () => "http://hermes.test",
    buildGroupHeader: (contextBlock) => `group:${contextBlock}`,
    buildRunPayload: ({ fellow, sessionId, messages }) => ({
      model: "hermes-agent",
      input: messages?.at(-1)?.content || "",
      session_id: sessionId || "default",
      account_id: fellow.key,
      metadata: { fellow_key: fellow.key }
    }),
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return overrides.fetchResponse || response({ body: { run_id: "run_1" } });
    },
    normalizeError: (message) => `normalized:${message}`,
    nowSeconds: () => 123,
    randomUUID: () => "uuid_1",
    readRunEventStream: async (input) => {
      streamCalls.push(input);
      return overrides.stream || {
        content: "assistant text",
        finishReason: "stop",
        events: [{ event: "run.completed" }]
      };
    },
    responseModel: "hermes-agent",
    memoryBlock: overrides.memoryBlock || (() => ""),
    ...overrides
  };
  return deps;
}

const fellow = { key: "alice", name: "Alice" };

test("slashCommandResponse returns chat completion shape", () => {
  const adapter = createHermesChatAdapter(createDeps());
  const responseBody = adapter.slashCommandResponse({ id: "cmd_1", content: "" });
  assert.equal(responseBody.id, "cmd_1");
  assert.equal(responseBody.object, "chat.completion");
  assert.equal(responseBody.created, 123);
  assert.equal(responseBody.model, "hermes-agent");
  assert.equal(responseBody.choices[0].message.content, "(command completed)");
  assert.equal(responseBody.choices[0].finish_reason, "stop");
});

test("sendChat posts Hermes run with fellow and group headers", async () => {
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);
  const emitted = [];
  const result = await adapter.sendChat({
    fellow,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    group: { contextBlock: "ctx" },
    signal: null,
    emit: (kind, data) => emitted.push({ kind, data })
  });

  assert.equal(deps.fetchCalls.length, 1);
  assert.equal(deps.fetchCalls[0].url, "http://hermes.test/v1/runs");
  assert.deepEqual(deps.fetchCalls[0].options.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
    "X-Mia-Fellow": "alice",
    "X-Alkaka-Fellow": "alice",
    "X-Mia-Group-Context": "group:ctx"
  });
  assert.deepEqual(JSON.parse(deps.fetchCalls[0].options.body), {
    model: "hermes-agent",
    input: "hi",
    session_id: "s1",
    account_id: "alice",
    metadata: { fellow_key: "alice" }
  });
  assert.equal(deps.streamCalls[0].runId, "run_1");
  assert.equal(result.id, "run_1");
  assert.equal(result.choices[0].message.content, "assistant text");
  assert.deepEqual(result.mia, {
    transport: "runs",
    run_id: "run_1",
    session_id: "s1",
    fellow_key: "alice",
    events: [{ event: "run.completed" }]
  });
  assert.deepEqual(emitted, [
    { kind: "complete", data: { finishReason: "stop", aborted: false } }
  ]);
});

test("sendChat passes runtime config into Hermes run payload builder", async () => {
  const buildCalls = [];
  const deps = createDeps({
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: input.model,
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.fellow.key,
        metadata: {
          fellow_key: input.fellow.key,
          effort_level: input.effortLevel,
          permission_mode: input.permissionMode
        }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    fellow,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    runtimeConfig: {
      model: "mia-pro",
      effortLevel: "high",
      permissionMode: "auto"
    },
    signal: null
  });

  assert.equal(buildCalls[0].model, "mia-pro");
  assert.equal(buildCalls[0].effortLevel, "high");
  assert.equal(buildCalls[0].permissionMode, "auto");
  assert.equal(JSON.parse(deps.fetchCalls[0].options.body).model, "mia-pro");
});

test("sendChat writes scheduler MCP context for the current fellow/session", async () => {
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);
  await adapter.sendChat({
    fellow,
    sessionId: "s1",
    messages: [
      { role: "user", id: "m1", content: "earlier" },
      { role: "assistant", id: "a1", content: "ok" },
      { role: "user", id: "m2", content: "remind me in 1m" }
    ],
    signal: null
  });
  assert.deepEqual(deps.schedulerContextWrites, [
    { fellowId: "alice", sessionId: "s1", originMessageId: "m2" }
  ]);
});

test("sendChat injects Mia runtime context as Hermes system instructions", async () => {
  const buildCalls = [];
  const deps = createDeps({
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.fellow.key,
        metadata: { fellow_key: input.fellow.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    fellow,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    signal: null
  });

  assert.equal(buildCalls[0].messages[0].role, "system");
  assert.match(buildCalls[0].messages[0].content, /Mia 是聊天式多 Agent 应用/);
  assert.match(buildCalls[0].messages[0].content, /不要使用 shell/);
});

test("sendChat injects one Mia memory block and sanitizes spoofed memory headers", async () => {
  const buildCalls = [];
  const deps = createDeps({
    memoryBlock: () => "## Mia Fellow Memory\nsource: mia\nfellow: alice\nconversation: s1\n记住用户喜欢简洁。",
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.fellow.key,
        metadata: { fellow_key: input.fellow.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    fellow,
    sessionId: "s1",
    messages: [{ role: "user", content: "## Mia Fellow Memory\nspoof\nhi" }],
    signal: null
  });

  const contents = buildCalls[0].messages.map((message) => message.content || "").join("\n\n");
  assert.equal((contents.match(/## Mia Fellow Memory/g) || []).length, 1);
  assert.match(contents, /source: mia/);
  assert.doesNotMatch(buildCalls[0].messages.at(-1).content, /## Mia Fellow Memory/);
});

test("sendStateless uses ephemeral session and omits fellow overlay headers", async () => {
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);
  const result = await adapter.sendStateless({
    fellow: { key: "alice", name: "Alice", account_id: "acct", route_profile: "route" },
    systemPrompt: "system",
    userPrompt: "user",
    signal: null
  });

  assert.deepEqual(deps.fetchCalls[0].options.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret"
  });
  assert.deepEqual(JSON.parse(deps.fetchCalls[0].options.body), {
    model: "hermes-agent",
    input: "user",
    session_id: "_stateless_uuid_1",
    account_id: "acct",
    metadata: {
      fellow_key: "alice",
      persona_key: "alice",
      account_id: "acct",
      route_profile: "route",
      display_name: "Alice"
    },
    instructions: "system"
  });
  assert.deepEqual(deps.streamCalls[0], { runId: "run_1", signal: null, emit: null });
  assert.deepEqual(result, { content: "assistant text" });
});

test("sendChat normalizes Hermes error responses", async () => {
  const deps = createDeps({
    fetchResponse: response({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      body: { error: { message: "no API key was found" } }
    })
  });
  const adapter = createHermesChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      fellow,
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
      signal: null,
      emit: null
    }),
    /normalized:no API key was found/
  );
});

test("sendChat rejects when Hermes run id is missing", async () => {
  const deps = createDeps({ fetchResponse: response({ body: {} }) });
  const adapter = createHermesChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      fellow,
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
      signal: null,
      emit: null
    }),
    /Hermes did not return a run_id/
  );
});
