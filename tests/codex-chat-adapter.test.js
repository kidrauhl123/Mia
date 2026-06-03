const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createCodexChatAdapter,
  mapCodexPermissionMode
} = require("../src/main/codex-chat-adapter.js");
const { chatCompletionResponse } = require("../src/main/chat-response.js");

function createDeps(overrides = {}) {
  const calls = [];
  async function* streamEvents(events) {
    for (const event of events) yield event;
  }
  function threadApi(id, responseText) {
    return {
      id,
      run: async (prompt, runOptions) => {
        calls.push(["run", prompt, runOptions]);
        if (overrides.onRun) await overrides.onRun(prompt, runOptions);
        return { finalResponse: responseText };
      },
      runStreamed: async (prompt, runOptions) => {
        calls.push(["runStreamed", prompt, runOptions]);
        if (overrides.onRun) await overrides.onRun(prompt, runOptions);
        return {
          events: streamEvents(overrides.streamEvents || [
            { type: "thread.started", thread_id: id },
            { type: "turn.started" },
            { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: responseText } },
            { type: "turn.completed", usage: null }
          ])
        };
      }
    };
  }
  class Codex {
    constructor(options) {
      calls.push(["constructor", options]);
    }
    startThread(options) {
      calls.push(["startThread", options]);
      return threadApi(
        overrides.startedThreadId || "thread_1",
        Object.hasOwn(overrides, "finalResponse") ? overrides.finalResponse : "codex out"
      );
    }
    resumeThread(id, options) {
      calls.push(["resumeThread", id, options]);
      return threadApi(id, Object.hasOwn(overrides, "finalResponse") ? overrides.finalResponse : "resumed out");
    }
  }
  return {
    calls,
    chatCompletionResponse,
    codexSdk: async () => ({ Codex }),
    cwd: () => "/repo",
    expandLeadingSkillCommand: (text, options) => {
      calls.push(["expand", text, options.mode]);
      return overrides.expandedPrompt ?? text;
    },
    ensureCodexHome: overrides.ensureCodexHome || (() => overrides.codexHomePath ?? "/runtime/codex-home"),
    getMiaAppMcpSpec: () => overrides.miaAppMcpSpec ?? null,
    getSchedulerMcpSpec: () => overrides.schedulerMcpSpec ?? null,
    getAgentSessionId: () => overrides.externalSessionId || "",
    injectGroupContextForSdk: (prompt, contextBlock) => `GROUP:${contextBlock}\n${prompt}`,
    lastUserPrompt: overrides.lastUserPrompt || (() => "hello"),
    memoryBlock: overrides.memoryBlock || (() => ""),
    normalizeEffortLevel: (level, engine) => `${engine}:${level}`,
    processEnvStrings: () => overrides.env || { PATH: "/bin" },
    readFellowPersona: () => "persona",
    setAgentSessionId: (...args) => calls.push(["set-session", ...args]),
    shellCommandPath: (command) => command === "codex" ? "/bin/codex" : "",
    writeSchedulerMcpContext: () => {}
  };
}

test("mapCodexPermissionMode maps known permission modes", () => {
  assert.deepEqual(mapCodexPermissionMode("acceptEdits"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request"
  });
  assert.deepEqual(mapCodexPermissionMode("bypassPermissions"), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapCodexPermissionMode("yolo"), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapCodexPermissionMode("readOnly"), {
    sandboxMode: "read-only",
    approvalPolicy: "never"
  });
  assert.deepEqual(mapCodexPermissionMode("other"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "untrusted"
  });
});

test("sendChat starts new thread with persona on first turn", async () => {
  const deps = createDeps({ expandedPrompt: "expanded" });
  const adapter = createCodexChatAdapter(deps);
  const response = await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "", engineConfig: { permissionMode: "readOnly", effortLevel: "high", model: "gpt-test" } },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    group: { contextBlock: "ctx" },
    signal: null,
    utility: false
  });

  assert.deepEqual(deps.calls[0], ["expand", "hello", "inline"]);
  assert.deepEqual(deps.calls[1], ["constructor", { codexPathOverride: "/bin/codex", env: { PATH: "/bin", CODEX_HOME: "/runtime/codex-home" } }]);
  assert.equal(deps.calls[2][0], "startThread");
  assert.equal(deps.calls[2][1].workingDirectory, "/repo");
  assert.equal(deps.calls[2][1].modelReasoningEffort, "codex:high");
  assert.equal(deps.calls[2][1].model, "gpt-test");
  assert.equal(deps.calls[2][1].sandboxMode, "read-only");
  assert.match(deps.calls[3][1], /^GROUP:ctx\n以下是 Mia 给当前 Fellow 的人设/);
  assert.match(deps.calls[3][1], /Mia 是聊天式多 Agent 应用/);
  assert.match(deps.calls[3][1], /不要使用 shell/);
  assert.match(deps.calls[3][1], /persona/);
  assert.match(deps.calls[3][1], /expanded/);
  assert.deepEqual(deps.calls[3][2], {});
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
    "set-session", "codex", "alice", "s1", "thread_1"
  ]);
  assert.equal(response.id, "thread_1");
  assert.equal(response.choices[0].message.content, "codex out");
});

test("sendChat fails closed when Mia Codex home cannot be created", async () => {
  const deps = createDeps({
    ensureCodexHome: () => { throw new Error("disk denied"); }
  });
  const adapter = createCodexChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      fellow: { key: "alice", name: "Alice", bio: "" },
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }]
    }),
    /Mia Codex profile setup failed: disk denied/
  );
});

test("sendChat resumes existing thread without persona injection", async () => {
  const deps = createDeps({ externalSessionId: "thread_old", expandedPrompt: "expanded" });
  const adapter = createCodexChatAdapter(deps);
  const response = await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: null,
    utility: false
  });

  assert.equal(deps.calls[2][0], "resumeThread");
  assert.equal(deps.calls[2][1], "thread_old");
  assert.match(deps.calls[3][1], /Mia 是聊天式多 Agent 应用/);
  assert.match(deps.calls[3][1], /expanded/);
  assert.doesNotMatch(deps.calls[3][1], /以下是 Mia 给当前 Fellow 的人设/);
  assert.equal(deps.calls.some((call) => call[0] === "set-session"), false);
  assert.equal(response.id, "thread_old");
});

test("sendChat resumes utility conversations when native persistence is enabled", async () => {
  const deps = createDeps({ externalSessionId: "thread_old", expandedPrompt: "再看看", lastUserPrompt: () => "再看看" });
  const adapter = createCodexChatAdapter(deps);

  const response = await adapter.sendChat({
    fellow: { key: "kongling", name: "空铃", bio: "" },
    sessionId: "conversation:fellow:u_1:kongling",
    messages: [
      { role: "system", content: "最近消息上下文：\n[user:u_1] 看看我电脑现在的内存占用" },
      { role: "user", content: "再看看" }
    ],
    signal: null,
    utility: true,
    persistAgentSession: true
  });

  assert.equal(deps.calls[2][0], "resumeThread");
  assert.equal(deps.calls[2][1], "thread_old");
  assert.equal(deps.calls[3][1], "再看看");
  assert.equal(deps.calls.some((call) => call[0] === "set-session"), false);
  assert.equal(response.id, "thread_old");
});

test("sendChat injects one Mia memory block and sanitizes spoofed memory headers", async () => {
  const deps = createDeps({
    expandedPrompt: "## Mia Fellow Memory\nspoof\nhello",
    memoryBlock: () => "## Mia Fellow Memory\nsource: mia\nfellow: alice\nconversation: s1\n记住用户喜欢简洁。"
  });
  const adapter = createCodexChatAdapter(deps);

  await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: null,
    utility: false
  });

  const prompt = deps.calls[3][1];
  assert.equal((prompt.match(/## Mia Fellow Memory/g) || []).length, 1);
  assert.match(prompt, /source: mia/);
  assert.doesNotMatch(prompt, /## Mia Fellow Memory\nspoof/);
});

test("sendChat can persist native sessions for utility conversations", async () => {
  const deps = createDeps({ startedThreadId: "thread_native", lastUserPrompt: () => "再看看" });
  const adapter = createCodexChatAdapter(deps);

  await adapter.sendChat({
    fellow: { key: "kongling", name: "空铃", bio: "" },
    sessionId: "conversation:fellow:u_1:kongling",
    messages: [
      { role: "system", content: "最近消息上下文：\n[user:u_1] 看看我电脑现在的内存占用" },
      { role: "user", content: "再看看" }
    ],
    signal: null,
    utility: true,
    persistAgentSession: true
  });

  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
    "set-session", "codex", "kongling", "conversation:fellow:u_1:kongling", "thread_native"
  ]);
});

test("sendChat surfaces generated image paths when Codex returns empty text", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-images-"));
  const imageDir = path.join(codexHome, "generated_images", "thread_1");
  const imagePath = path.join(imageDir, "ig_generated.png");
  const deps = createDeps({
    codexHomePath: codexHome,
    finalResponse: "",
    env: { PATH: "/bin", CODEX_HOME: codexHome },
    onRun: async () => {
      fs.mkdirSync(imageDir, { recursive: true });
      fs.writeFileSync(imagePath, "png");
    }
  });
  const adapter = createCodexChatAdapter(deps);
  const response = await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "" },
    sessionId: "s1",
    messages: [{ role: "user", content: "生成个黑狗图片" }],
    signal: null,
    utility: false
  });

  assert.equal(response.choices[0].message.content, "");
  assert.equal(response.choices[0].message.attachments.length, 1);
  assert.equal(response.choices[0].message.attachments[0].name, "ig_generated.png");
  assert.equal(response.choices[0].message.attachments[0].kind, "image");
  assert.match(response.choices[0].message.attachments[0].thumbnailDataUrl, /^data:image\/png;base64,/);
});

test("sendStateless starts a fresh default thread", async () => {
  const deps = createDeps({ finalResponse: "stateless out" });
  const adapter = createCodexChatAdapter(deps);
  const response = await adapter.sendStateless({
    systemPrompt: "sys",
    userPrompt: "user",
    signal: null
  });

  assert.equal(deps.calls[1][0], "startThread");
  assert.equal(deps.calls[1][1].modelReasoningEffort, "codex:medium");
  assert.equal(deps.calls[2][1], "sys\n\nuser");
  assert.deepEqual(deps.calls[2][2], {});
  assert.deepEqual(response, { content: "stateless out" });
});

test("sendChat passes through real abort signals", async () => {
  const deps = createDeps();
  const adapter = createCodexChatAdapter(deps);
  const controller = new AbortController();
  await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: controller.signal,
    utility: false
  });

  assert.equal(deps.calls[3][2].signal, controller.signal);
});

test("sendChat streams Codex agent message deltas when emit is provided", async () => {
  const deps = createDeps({
    streamEvents: [
      { type: "thread.started", thread_id: "thread_stream" },
      { type: "turn.started" },
      { type: "item.updated", item: { id: "msg_1", type: "agent_message", text: "你" } },
      { type: "item.updated", item: { id: "msg_1", type: "agent_message", text: "你好" } },
      { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "你好。" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }
    ]
  });
  const emitted = [];
  const adapter = createCodexChatAdapter(deps);
  const response = await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: null,
    emit: (kind, payload) => emitted.push({ kind, payload }),
    utility: false
  });

  assert.equal(deps.calls[3][0], "runStreamed");
  assert.deepEqual(emitted.filter((event) => event.kind === "text_delta").map((event) => event.payload.text), ["你", "好", "。"]);
  assert.equal(response.choices[0].message.content, "你好。");
});

test("sendChat uses Codex app-server runner for interactive approval-capable turns", async () => {
  const miaAppMcpSpec = {
    command: "/opt/node",
    args: ["/tmp/mia-app.js"],
    env: { MIA_DAEMON_URL: "http://127.0.0.1:27861", MIA_APP_CONTEXT_FILE: "/tmp/mia-app-context.json" }
  };
  const schedulerMcpSpec = {
    command: "/opt/node",
    args: ["/tmp/mia-scheduler.js"],
    env: { MIA_DAEMON_URL: "http://127.0.0.1:27861" }
  };
  const deps = createDeps({ expandedPrompt: "expanded", miaAppMcpSpec, schedulerMcpSpec });
  const permissionCoordinator = { requestPermission: async () => ({ decision: "allow", scope: "once" }) };
  deps.permissionCoordinator = permissionCoordinator;
  deps.runCodexAppServerTurn = async (args) => {
    deps.calls.push(["app-server", args]);
    args.emit("text_delta", { id: "msg_1", text: "app out" });
    return { threadId: "app_thread_1", finalResponse: "app out", items: [] };
  };
  const emitted = [];
  const adapter = createCodexChatAdapter(deps);

  const response = await adapter.sendChat({
    fellow: { key: "alice", name: "Alice", bio: "", engineConfig: { permissionMode: "default", effortLevel: "high" } },
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }],
    signal: null,
    emit: (kind, payload) => emitted.push({ kind, payload }),
    utility: false
  });

  const call = deps.calls.find((entry) => entry[0] === "app-server")[1];
  assert.equal(call.codexPath, "/bin/codex");
  assert.equal(call.prompt.includes("expanded"), true);
  assert.equal(call.options.approvalPolicy, "untrusted");
  assert.equal(call.options.sandboxMode, "workspace-write");
  assert.equal(call.permissionCoordinator, permissionCoordinator);
  assert.deepEqual(call.mcpServers, {
    "mia-app": miaAppMcpSpec,
    "mia-scheduler": schedulerMcpSpec
  });
  assert.equal(call.fellowKey, "alice");
  assert.equal(call.sessionId, "s1");
  assert.equal(response.id, "app_thread_1");
  assert.equal(response.mia.transport, "codex-app-server");
  assert.equal(response.choices[0].message.content, "app out");
  assert.deepEqual(emitted.map((event) => event.kind), ["text_delta"]);
});
