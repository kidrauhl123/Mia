const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  claudeMessageText,
  createClaudeCodeChatAdapter,
  normalizeClaudePermissionMode
} = require("../src/main/claude-code-chat-adapter.js");
const { chatCompletionResponse } = require("../src/main/chat-response.js");

async function* streamOf(items) {
  for (const item of items) yield item;
}

function createDeps(messages, overrides = {}) {
  const calls = [];
  return {
    calls,
    appendEngineLog: (line) => calls.push(["log", line]),
    chatCompletionResponse,
    claudeAgentSdk: async () => ({
      query: (input) => {
        calls.push(["query", input]);
        return streamOf(messages);
      }
    }),
    cwd: () => "/repo",
    ensureClaudeBridgePlugin: () => overrides.bridge || ({ path: "/bridge", fingerprint: "fp1" }),
    expandLeadingSkillCommand: (text, options) => {
      calls.push(["expand", text, options.mode]);
      return overrides.expandedPrompt ?? text;
    },
    getAgentSessionEntry: () => overrides.savedEntry || {},
    getSchedulerMcpSpec: () => overrides.schedulerMcpSpec ?? null,
    injectGroupContextForSdk: (prompt, contextBlock) => `GROUP:${contextBlock}\n${prompt}`,
    lastUserPrompt: () => "hello",
    normalizeEffortLevel: (level, engine) => `${engine}:${level}`,
    processEnvStrings: () => ({ PATH: "/bin" }),
    readFellowPersona: () => "persona",
    setAgentSessionEntry: (...args) => calls.push(["set-session", ...args]),
    shellCommandPath: (command) => command === "claude" ? "/bin/claude" : "",
    writeSchedulerMcpContext: () => {}
  };
}

test("normalizeClaudePermissionMode preserves supported modes", () => {
  assert.equal(normalizeClaudePermissionMode("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeClaudePermissionMode("nope"), "default");
});

test("claudeMessageText extracts nested assistant text", () => {
  assert.equal(claudeMessageText({ message: { content: [{ text: "hi" }] } }), "hi");
  assert.equal(claudeMessageText({ delta: "chunk" }), "chunk");
});

test("sendChat streams partials, stores session, and returns chat response", async () => {
  const deps = createDeps([
    { session_id: "sess_1" },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } } },
    { type: "assistant", message: { content: [{ type: "text", text: "hello final" }] } }
  ], { expandedPrompt: "expanded" });
  const adapter = createClaudeCodeChatAdapter(deps);
  const emitted = [];
  const response = await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "", engineConfig: { permissionMode: "bypassPermissions", effortLevel: "high", model: "sonnet" } },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    group: { contextBlock: "ctx" },
    signal: null,
    abortController: { abort() {} },
    emit: (kind, data) => emitted.push({ kind, data }),
    utility: false
  });

  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.equal(queryCall.prompt, "GROUP:ctx\nexpanded");
  assert.equal(queryCall.options.cwd, "/repo");
  assert.equal(queryCall.options.pathToClaudeCodeExecutable, "/bin/claude");
  assert.equal(queryCall.options.systemPrompt.append, "persona");
  assert.equal(queryCall.options.plugins[0].path, "/bridge");
  assert.equal(queryCall.options.model, "sonnet");
  assert.equal(queryCall.options.effort, "claude-code:high");
  assert.equal(queryCall.options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
    "set-session", "claude-code", "alice", "s1", "sess_1", "fp1"
  ]);
  assert.equal(response.id, "sess_1");
  assert.equal(response.choices[0].message.content, "hello final");
  assert.deepEqual(response.mia, {
    transport: "claude-agent-sdk",
    engine: "claude-code",
    session_id: "sess_1",
    fellow_key: "alice"
  });
  assert.equal(emitted[0].kind, "text_delta");
  assert.equal(emitted.at(-1).kind, "complete");
});

test("sendChat resumes only when bridge fingerprint matches", async () => {
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "resumed" }] } }
  ], { savedEntry: { id: "old_session", fingerprint: "fp1" } });
  const adapter = createClaudeCodeChatAdapter(deps);
  await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: null,
    abortController: {},
    emit: null,
    utility: false
  });
  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.equal(queryCall.options.resume, "old_session");
});

test("sendStateless uses prompt without persona append or resume", async () => {
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "stateless out" }] } }
  ]);
  const adapter = createClaudeCodeChatAdapter(deps);
  const response = await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    signal: null
  });
  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.equal(queryCall.prompt, "sys\n\nuser");
  assert.deepEqual(queryCall.options.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.equal(queryCall.options.resume, undefined);
  assert.deepEqual(response, { content: "stateless out" });
});
