const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createLocalFellowResponder,
  shouldHandleLocalCloudRoomAi
} = require("../src/main/social/local-fellow-responder.js");

function setup(overrides = {}) {
  const calls = { engine: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalFellowResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "hi from codex" } }] };
    },
    postRoomMessageAsFellow: async (roomId, body) => {
      calls.post.push({ roomId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    ...overrides
  });
  return { responder, calls };
}

const base = {
  roomId: "g_1",
  fellowId: "codex",
  dedupKey: "m_1:codex",
  systemPrompt: "sys",
  userPrompt: "hi",
  turnId: "t_1"
};

test("respond runs the local engine and posts the reply as the fellow", async () => {
  const { responder, calls } = setup();
  await responder.respond(base);

  assert.equal(calls.engine.length, 1);
  assert.deepEqual(calls.engine[0], {
    fellowKey: "codex",
    personaKey: "codex",
    sessionId: "room:g_1",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" }
    ],
    group: true,
    utility: true,
    allowSlashCommands: false
  });
  assert.deepEqual(calls.post, [{
    roomId: "g_1",
    body: {
      fellowId: "codex",
      bodyMd: "hi from codex",
      turnId: "t_1",
      clientOpId: "op_fellow_reply_m_1_codex"
    }
  }]);
});

test("respond folds the message's skill chips into the engine turn", async () => {
  const { responder, calls } = setup();

  await responder.respond({ ...base, activeSkillIds: ["pdf-fill", "data-viz"] });

  assert.deepEqual(calls.engine[0].activeSkillIds, ["pdf-fill", "data-viz"]);
});

test("respond omits activeSkillIds when the message carried no chips", async () => {
  const { responder, calls } = setup();

  await responder.respond(base);

  assert.ok(!("activeSkillIds" in calls.engine[0]));
});

test("activeSkillIdsFromMessage parses skills_json into id list, tolerating junk", () => {
  const { activeSkillIdsFromMessage } = require("../src/main/social/local-fellow-responder.js");

  assert.deepEqual(
    activeSkillIdsFromMessage({ skills_json: JSON.stringify([{ id: "trip-planner", name: "行程" }, { id: "weekly" }]) }),
    ["trip-planner", "weekly"]
  );
  // Junk is rejected, not coerced: numbers, id-less objects, nulls dropped;
  // raw string ids accepted; duplicates deduped.
  assert.deepEqual(
    activeSkillIdsFromMessage({ skills_json: JSON.stringify([{ id: "trip-planner" }, 123, { name: "no-id" }, "raw-id", { id: "trip-planner" }, null]) }),
    ["trip-planner", "raw-id"]
  );
  assert.deepEqual(activeSkillIdsFromMessage({ skills_json: null }), []);
  assert.deepEqual(activeSkillIdsFromMessage({ skills_json: "not json" }), []);
  assert.deepEqual(activeSkillIdsFromMessage({ skills_json: JSON.stringify({ not: "an array" }) }), []);
  assert.deepEqual(activeSkillIdsFromMessage({}), []);
});

test("respond emits a transient room run start before the local engine call", async () => {
  const { responder, calls } = setup();

  await responder.respond(base);

  assert.equal(calls.cloudEvents[0].type, "cloud_agent_run_started");
  assert.equal(calls.cloudEvents[0].roomId, "g_1");
  assert.equal(calls.cloudEvents[0].fellowId, "codex");
  assert.equal(calls.cloudEvents[0].triggerMessageId, "m_1");
  assert.match(calls.cloudEvents[0].runId, /^local_/);
});

test("respond forwards runtime config to the local chat engine", async () => {
  const { responder, calls } = setup();
  await responder.respond({
    ...base,
    runtimeConfig: {
      model: "mia-pro",
      effortLevel: "high",
      permissionMode: "auto"
    }
  });

  assert.deepEqual(calls.engine[0].runtimeConfig, {
    model: "mia-pro",
    effortLevel: "high",
    permissionMode: "auto"
  });
});

test("respond uses the same clientOpId for the same dedupKey", async () => {
  const first = setup();
  const second = setup();

  await first.responder.respond(base);
  await second.responder.respond(base);

  assert.equal(first.calls.post[0].body.clientOpId, "op_fellow_reply_m_1_codex");
  assert.equal(second.calls.post[0].body.clientOpId, "op_fellow_reply_m_1_codex");
});

test("respond uses room scoped chat sessions for fellow rooms", async () => {
  const { responder, calls } = setup();

  await responder.respond({
    roomId: "fellow:u_1:alice",
    fellowId: "alice",
    dedupKey: "m_2:alice",
    systemPrompt: "You are Alice",
    userPrompt: "你好"
  });

  assert.equal(calls.engine[0].fellowKey, "alice");
  assert.equal(calls.engine[0].sessionId, "room:fellow:u_1:alice");
});

test("respond dedups by dedupKey", async () => {
  const { responder, calls } = setup();
  await responder.respond(base);
  await responder.respond(base);

  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 1);
});

test("respond retries after post failure and dedups after post success", async () => {
  const calls = { engine: [], post: [], log: [] };
  const responder = createLocalFellowResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "retry reply" } }] };
    },
    postRoomMessageAsFellow: async () => {
      calls.post.push({});
      if (calls.post.length === 1) return { ok: false, error: "temporary" };
      return { ok: true };
    },
    log: (line) => calls.log.push(line)
  });

  await responder.respond(base);
  await responder.respond(base);
  await responder.respond(base);

  assert.equal(calls.engine.length, 2);
  assert.equal(calls.post.length, 2);
  assert.equal(calls.log.some((line) => line.includes("temporary")), true);
});

test("respond posts a visible fellow error when the local engine fails", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      throw new Error("HTTP 429: Gemini quota exhausted");
    }
  });

  const result = await responder.respond(base);

  assert.equal(result, true);
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].roomId, "g_1");
  assert.equal(calls.post[0].body.fellowId, "codex");
  assert.match(calls.post[0].body.bodyMd, /模型配额已耗尽/);
  assert.deepEqual(calls.post[0].body.errorJson, {
    stage: "engine",
    message: "HTTP 429: Gemini quota exhausted"
  });
  assert.equal(calls.post[0].body.clientOpId, "op_fellow_reply_error_m_1_codex");
});

test("respond skips empty replies and incomplete invocations", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "  " } }] };
    }
  });

  await responder.respond(base);
  await responder.respond({ ...base, dedupKey: "" });
  await responder.respond({ ...base, roomId: "" });
  await responder.respond({ ...base, fellowId: "" });

  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 0);
});

test("shouldHandleLocalCloudRoomAi keeps visible desktop rooms responsive when daemon is enabled", () => {
  assert.equal(shouldHandleLocalCloudRoomAi({ isDaemon: false, daemonEnabled: true }), true);
  assert.equal(shouldHandleLocalCloudRoomAi({ isDaemon: false, daemonEnabled: false }), true);
  assert.equal(shouldHandleLocalCloudRoomAi({ isDaemon: true, daemonEnabled: true }), false);
  assert.equal(shouldHandleLocalCloudRoomAi({ isDaemon: true, daemonEnabled: false }), false);
});
