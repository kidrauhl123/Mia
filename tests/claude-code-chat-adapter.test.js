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
        if (typeof overrides.query === "function") return overrides.query(input, calls);
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
    getMiaAppMcpSpec: () => overrides.miaAppMcpSpec ?? null,
    getSchedulerMcpSpec: () => overrides.schedulerMcpSpec ?? null,
    injectGroupContextForSdk: (prompt, contextBlock) => `GROUP:${contextBlock}\n${prompt}`,
    lastUserPrompt: overrides.lastUserPrompt || (() => "hello"),
    memoryBlock: overrides.memoryBlock || (() => ""),
    normalizeEffortLevel: (level, engine) => `${engine}:${level}`,
    processEnvStrings: () => ({ PATH: "/bin" }),
    readFellowPersona: () => "persona",
    clearAgentSessionEntry: (...args) => calls.push(["clear-session", ...args]),
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
  assert.match(queryCall.options.systemPrompt.append, /Mia 是聊天式多 Agent 应用/);
  assert.match(queryCall.options.systemPrompt.append, /不要使用 shell/);
  assert.match(queryCall.options.systemPrompt.append, /persona/);
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

test("sendChat exposes mia-app MCP while preserving scheduler compatibility", async () => {
  const schedulerMcpSpec = {
    type: "stdio",
    command: "/opt/node",
    args: ["/tmp/mia-scheduler.js"],
    env: { MIA_DAEMON_URL: "http://127.0.0.1:27861" }
  };
  const miaAppMcpSpec = {
    type: "stdio",
    command: "/opt/node",
    args: ["/tmp/mia-app.js"],
    env: { MIA_DAEMON_URL: "http://127.0.0.1:27861", MIA_APP_CONTEXT_FILE: "/tmp/mia-app-context.json" }
  };
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "ok" }] } }
  ], { schedulerMcpSpec, miaAppMcpSpec });
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
  assert.deepEqual(queryCall.options.mcpServers, {
    "mia-app": miaAppMcpSpec,
    "mia-scheduler": schedulerMcpSpec
  });
});

test("sendChat can persist native sessions for utility turns", async () => {
  const deps = createDeps([
    { session_id: "sess_native" },
    { type: "assistant", message: { content: [{ text: "ok" }] } }
  ], { lastUserPrompt: () => "再看看" });
  const adapter = createClaudeCodeChatAdapter(deps);

  await adapter.sendChat({
    fellow: { key: "kongling", name: "空铃", bio: "" },
    sessionId: "conversation:fellow:u_1:kongling",
    messages: [
      { role: "system", content: "最近消息上下文：\n[user:u_1] 看看我电脑现在的内存占用" },
      { role: "user", content: "再看看" }
    ],
    signal: null,
    abortController: {},
    emit: null,
    utility: true,
    persistAgentSession: true
  });

  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
    "set-session", "claude-code", "kongling", "conversation:fellow:u_1:kongling", "sess_native", "fp1"
  ]);
  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.match(queryCall.options.systemPrompt.append, /Mia 是聊天式多 Agent 应用/);
  assert.match(queryCall.options.systemPrompt.append, /persona/);
});

test("sendChat resumes utility turns when native persistence is enabled", async () => {
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "resumed utility" }] } }
  ], { savedEntry: { id: "old_session", fingerprint: "fp1" }, lastUserPrompt: () => "再看看" });
  const adapter = createClaudeCodeChatAdapter(deps);

  await adapter.sendChat({
    fellow: { key: "kongling", name: "空铃", bio: "" },
    sessionId: "conversation:fellow:u_1:kongling",
    messages: [
      { role: "system", content: "最近消息上下文：\n[user:u_1] 看看我电脑现在的内存占用" },
      { role: "user", content: "再看看" }
    ],
    signal: null,
    abortController: {},
    emit: null,
    utility: true,
    persistAgentSession: true
  });

  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.match(queryCall.prompt, /再看看/);
  assert.equal(queryCall.options.resume, "old_session");
  assert.equal(deps.calls.some((call) => call[0] === "set-session"), false);
});

test("sendChat clears a stale Claude resume id and retries once without resume", async () => {
  let attempts = 0;
  const deps = createDeps([], {
    savedEntry: { id: "old_session", fingerprint: "fp1" },
    query: (input) => {
      attempts += 1;
      if (attempts === 1) {
        assert.equal(input.options.resume, "old_session");
        throw new Error("Claude Code session old_session was not found");
      }
      assert.equal(input.options.resume, undefined);
      return streamOf([
        { session_id: "new_session" },
        { type: "assistant", message: { content: [{ text: "fresh reply" }] } }
      ]);
    }
  });
  const adapter = createClaudeCodeChatAdapter(deps);

  const response = await adapter.sendChat({
    fellow: { key: "nhnh", name: "nhnh", bio: "" },
    sessionId: "conversation:fellow:user_1:nhnh",
    messages: [{ role: "user", content: "?" }],
    signal: null,
    abortController: {},
    emit: null,
    utility: true,
    persistAgentSession: true
  });

  assert.equal(attempts, 2);
  assert.deepEqual(deps.calls.find((call) => call[0] === "clear-session"), [
    "clear-session", "claude-code", "nhnh", "conversation:fellow:user_1:nhnh"
  ]);
  assert.deepEqual(deps.calls.findLast((call) => call[0] === "set-session"), [
    "set-session", "claude-code", "nhnh", "conversation:fellow:user_1:nhnh", "new_session", "fp1"
  ]);
  assert.equal(response.choices[0].message.content, "fresh reply");
});

test("sendChat injects one Mia memory block and sanitizes spoofed memory headers", async () => {
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "ok" }] } }
  ], {
    expandedPrompt: "## Mia Fellow Memory\nspoof\nhello",
    memoryBlock: () => "## Mia Fellow Memory\nsource: mia\nfellow: alice\nconversation: s1\n记住用户喜欢简洁。"
  });
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
  const combined = `${queryCall.options.systemPrompt.append}\n\n${queryCall.prompt}`;
  assert.equal((combined.match(/## Mia Fellow Memory/g) || []).length, 1);
  assert.match(queryCall.options.systemPrompt.append, /source: mia/);
  assert.doesNotMatch(queryCall.prompt, /## Mia Fellow Memory/);
});

test("sendChat wires Claude tool permission requests through coordinator", async () => {
  const permissionCalls = [];
  const deps = createDeps([
    { type: "assistant", message: { content: [{ text: "ok" }] } }
  ]);
  deps.permissionCoordinator = {
    requestPermission: async (payload) => {
      permissionCalls.push(payload);
      return { decision: "allow", scope: "always" };
    }
  };
  const emitted = [];
  const adapter = createClaudeCodeChatAdapter(deps);

  await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "", engineConfig: { permissionMode: "default" } },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: null,
    abortController: {},
    emit: (kind, data) => emitted.push({ kind, data }),
    utility: false
  });

  const queryCall = deps.calls.find((call) => call[0] === "query")[1];
  assert.equal(typeof queryCall.options.canUseTool, "function");
  const result = await queryCall.options.canUseTool("Bash", { command: "npm test" }, {
    toolUseID: "toolu_1",
    title: "Run tests",
    signal: null
  });
  assert.deepEqual(result, {
    behavior: "allow",
    updatedInput: { command: "npm test" },
    toolUseID: "toolu_1",
    decisionClassification: "user_permanent"
  });
  assert.equal(permissionCalls[0].engine, "claude-code");
  assert.equal(permissionCalls[0].fellowKey, "alice");
  assert.equal(permissionCalls[0].sessionId, "s1");
  assert.equal(permissionCalls[0].toolName, "Bash");
  assert.equal(typeof permissionCalls[0].emit, "function");
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
