const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  acpPermissionFallback,
  buildOpenClawAcpArgs,
  buildOpenClawArgs,
  buildOpenClawGlobalArgs,
  closeOpenClawAcpRuntimes,
  createOpenClawChatAdapter,
  parseOpenClawContent,
  shouldUseLegacyOpenClawTransport
} = require("../src/main/openclaw-chat-adapter.js");
const { chatCompletionResponse } = require("../src/main/chat-response.js");

function fakeChildProcess(calls) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    calls.push(["kill"]);
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

function fakeAcpSdk(calls, overrides = {}) {
  class FakeClientSideConnection {
    constructor(toClient, stream) {
      calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
      this.handlers = toClient(this);
    }

    async initialize(params) {
      calls.push(["acp-initialize", params]);
      return overrides.initializeResult || {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
        agentInfo: { name: "openclaw-acp", version: "test" }
      };
    }

    async newSession(params) {
      calls.push(["acp-new-session", params]);
      return {
        sessionId: overrides.acpSessionId || "acp-session",
        configOptions: [],
        modes: { currentModeId: "adaptive", availableModes: [] }
      };
    }

    async setSessionMode(params) {
      calls.push(["acp-set-mode", params]);
      return {};
    }

    async prompt(params) {
      calls.push(["acp-prompt", params]);
      await this.handlers.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: overrides.reply || "OpenClaw reply" }
        }
      });
      return { stopReason: "end_turn" };
    }

    async cancel(params) {
      calls.push(["acp-cancel", params]);
    }
  }

  return {
    ClientSideConnection: FakeClientSideConnection,
    PROTOCOL_VERSION: 1,
    ndJsonStream: (writable, readable) => ({ writable, readable })
  };
}

function createDeps(overrides = {}) {
  const calls = [];
  const sessions = new Map();
  return {
    calls,
    chatCompletionResponse,
    cwd: () => "/tmp/mia-workspace",
    expandLeadingSkillCommand: (text) => text,
    enginePermissionMode: overrides.enginePermissionMode || (() => overrides.enginePermissionModeValue || "default"),
    getAgentSessionId: (engine, botKey, sessionId) => sessions.get(`${engine}:${botKey}:${sessionId}`) || "",
    getMcpFingerprint: () => overrides.mcpFingerprint || "",
    getUserMcpServers: (options) => {
      calls.push(["get-user-mcp-servers", options]);
      return overrides.userMcpServers ?? [];
    },
    injectGroupContextForSdk: (prompt, contextBlock) => `${contextBlock}\n\n${prompt}`,
    lastUserPrompt: (messages) => [...messages].reverse().find((message) => message.role === "user")?.content || "",
    memoryBlock: () => "Mia 记忆",
    normalizeEffortLevel: (level) => `normalized-${level}`,
    processEnvStrings: () => ({ PATH: "/usr/local/bin" }),
    readBotPersona: (key, name) => `${name} 的人设`,
    setAgentSessionId: (engine, botKey, sessionId, externalId) => {
      sessions.set(`${engine}:${botKey}:${sessionId}`, externalId);
      calls.push(["set-session", engine, botKey, sessionId, externalId]);
    },
    shellCommandPath: (command) => (command === "openclaw" ? "/bin/openclaw" : ""),
    importAcpSdk: async () => fakeAcpSdk(calls, overrides),
    spawn: (file, args, options) => {
      calls.push(["spawn", file, args, options.cwd, options.env.PATH]);
      return fakeChildProcess(calls);
    },
    execFile: (file, args, options, callback) => {
      calls.push(["exec", file, args, options.cwd, options.env.PATH, options.input || ""]);
      callback(null, overrides.stdout || JSON.stringify({ response: "OpenClaw reply", session_id: "oc-session" }), "");
      return { kill() {} };
    },
    ...overrides
  };
}

test("buildOpenClawArgs prefers OpenClaw default routing and only forces local when requested", () => {
  const args = buildOpenClawArgs({
    bot: { key: "mia" },
    sessionId: "s1",
    message: "hello",
    effort: "medium"
  });

  assert.equal(args[0], "agent");
  assert.equal(args[1], "--message");
  assert.equal(args[2], "hello");
  assert.equal(args[3], "--agent");
  assert.equal(args[4], "main");
  assert.equal(args[5], "--session-key");
  assert.match(args[6], /^mia-[a-f0-9]{32}$/);
  assert.deepEqual(args.slice(7), ["--thinking", "medium", "--json", "--timeout", "600"]);
  assert.equal(args.includes("--local"), false);
  assert.equal(buildOpenClawArgs({ message: "hello", local: true }).includes("--local"), true);
  assert.equal(shouldUseLegacyOpenClawTransport({ engineConfig: {} }, { provider: "mia" }), false);
  assert.equal(shouldUseLegacyOpenClawTransport({ engineConfig: { openclawTransport: "acp" } }, { provider: "mia" }), false);
  assert.equal(shouldUseLegacyOpenClawTransport({ engineConfig: { openclawLocal: true } }, { provider: "mia" }), false);
  assert.equal(shouldUseLegacyOpenClawTransport({ engineConfig: { openclawTransport: "legacy-agent" } }, { provider: "mia" }), true);
});

test("OpenClaw command builders support an isolated profile before the subcommand", () => {
  assert.deepEqual(buildOpenClawGlobalArgs({ openclawProfile: "mia" }), ["--profile", "mia"]);
  assert.deepEqual(buildOpenClawArgs({
    bot: { key: "claw", engineConfig: { openclawProfile: "mia" } },
    sessionId: "s1",
    message: "hello",
    effort: "medium"
  }).slice(0, 4), ["--profile", "mia", "agent", "--message"]);
  assert.deepEqual(buildOpenClawAcpArgs({
    engineConfig: {
      openclawProfile: "mia",
      openclawGatewayUrl: "ws://127.0.0.1:18789",
      openclawGatewayTokenFile: "/tmp/token"
    }
  }), [
    "--profile",
    "mia",
    "acp",
    "--no-prefix-cwd",
    "--url",
    "ws://127.0.0.1:18789",
    "--token-file",
    "/tmp/token"
  ]);
  assert.throws(() => buildOpenClawGlobalArgs({ openclawProfile: "../default" }), /profile 名称/);
});

test("parseOpenClawContent accepts OpenClaw JSON and plain text", () => {
  assert.deepEqual(parseOpenClawContent(JSON.stringify({
    response: "hello",
    meta: { session_id: "s2" }
  })), { content: "hello", sessionId: "s2" });
  assert.deepEqual(parseOpenClawContent(JSON.stringify({
    payloads: [{ text: "payload reply" }],
    meta: { agentMeta: { sessionId: "agent-session" } }
  })), { content: "payload reply", sessionId: "agent-session" });
  assert.deepEqual(parseOpenClawContent("plain reply"), { content: "plain reply", sessionId: "" });
});

test("acpPermissionFallback never grants tools unless the bot is explicitly yolo", () => {
  const params = {
    options: [
      { optionId: "allow-1", kind: "allow_once", name: "Allow" },
      { optionId: "reject-1", kind: "reject_once", name: "Reject" }
    ]
  };
  assert.deepEqual(acpPermissionFallback(params, { permissionMode: "default" }), {
    outcome: { outcome: "selected", optionId: "reject-1" }
  });
  assert.deepEqual(acpPermissionFallback(params, { permissionMode: "bypassPermissions" }), {
    outcome: { outcome: "selected", optionId: "allow-1" }
  });
});

test("sendChat uses engine-level OpenClaw permission for ACP fallback decisions", async () => {
  const permissionResponses = [];
  function permissionAcpSdk(calls) {
    class FakeClientSideConnection {
      constructor(toClient, stream) {
        calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
        this.handlers = toClient(this);
      }

      async initialize(params) {
        calls.push(["acp-initialize", params]);
        return {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: true } },
          agentInfo: { name: "openclaw-acp", version: "test" }
        };
      }

      async newSession(params) {
        calls.push(["acp-new-session", params]);
        return { sessionId: "acp-session", configOptions: [], modes: { currentModeId: "adaptive", availableModes: [] } };
      }

      async setSessionMode(params) {
        calls.push(["acp-set-mode", params]);
        return {};
      }

      async prompt(params) {
        calls.push(["acp-prompt", params]);
        permissionResponses.push(await this.handlers.requestPermission({
          sessionId: params.sessionId,
          toolCall: { kind: "shell", title: "Shell", rawInput: { command: "pwd" } },
          options: [
            { optionId: "allow-1", kind: "allow_once", name: "Allow" },
            { optionId: "reject-1", kind: "reject_once", name: "Reject" }
          ]
        }));
        await this.handlers.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" }
          }
        });
        return { stopReason: "end_turn" };
      }

      async cancel(params) {
        calls.push(["acp-cancel", params]);
      }
    }

    return {
      ClientSideConnection: FakeClientSideConnection,
      PROTOCOL_VERSION: 1,
      ndJsonStream: (writable, readable) => ({ writable, readable })
    };
  }

  let deps;
  deps = createDeps({
    enginePermissionMode: () => "bypassPermissions",
    importAcpSdk: async () => permissionAcpSdk(deps.calls)
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { permissionMode: "readOnly" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "运行 pwd" }]
  });

  assert.deepEqual(permissionResponses[0], {
    outcome: { outcome: "selected", optionId: "allow-1" }
  });
});

test("sendChat rejects OpenClaw cronjob permission even in bypass mode", async () => {
  const permissionResponses = [];
  function rejectingCronjobAcpSdk(calls) {
    class FakeClientSideConnection {
      constructor(toClient, stream) {
        calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
        this.handlers = toClient(this);
      }

      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "openclaw-acp" } };
      }

      async newSession() {
        return { sessionId: "acp-session", configOptions: [], modes: { currentModeId: "adaptive", availableModes: [] } };
      }

      async setSessionMode() {
        return {};
      }

      async prompt(params) {
        permissionResponses.push(await this.handlers.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            kind: "cronjob",
            title: "cronjob",
            rawInput: { action: "create", schedule: "2m", prompt: "提醒我吃饭" }
          },
          options: [
            { optionId: "allow-1", kind: "allow_once", name: "Allow" },
            { optionId: "reject-1", kind: "reject_once", name: "Reject" }
          ]
        }));
        await this.handlers.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" }
          }
        });
        return { stopReason: "end_turn" };
      }
    }

    return {
      ClientSideConnection: FakeClientSideConnection,
      PROTOCOL_VERSION: 1,
      ndJsonStream: (writable, readable) => ({ writable, readable })
    };
  }
  const deps = createDeps({
    importAcpSdk: async () => rejectingCronjobAcpSdk(deps.calls)
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { permissionMode: "bypassPermissions" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "2分钟后提醒我吃饭" }]
  });

  assert.deepEqual(permissionResponses[0], {
    outcome: { outcome: "selected", optionId: "reject-1" }
  });
});

test("sendChat runs OpenClaw through ACP backend and stores the stable session key", async () => {
  const deps = createDeps();
  const adapter = createOpenClawChatAdapter(deps);
  const response = await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { effortLevel: "high" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "帮我整理文件" }],
    skillMaterialization: {
      indexBlock: "## Available Mia Skills\n\n- file-helper: 整理文件。",
      loadedBlock: "## Loaded Mia Skill Guides\n\n=== Skill: file-helper ===\n整理文件正文\n=== End Skill ==="
    }
  });

  const spawnCall = deps.calls.find((call) => call[0] === "spawn");
  assert.equal(spawnCall[1], "/bin/openclaw");
  assert.deepEqual(spawnCall[2], ["acp", "--no-prefix-cwd"]);
  assert.equal(spawnCall[3], "/tmp/mia-workspace");
  const newSessionCall = deps.calls.find((call) => call[0] === "acp-new-session");
  assert.deepEqual(newSessionCall[1], {
    cwd: "/tmp/mia-workspace",
    mcpServers: [],
    _meta: {
      sessionKey: "openclaw:mia:claw:mia-session",
      sessionLabel: undefined,
      resetSession: false,
      requireExisting: false,
      prefixCwd: false
    }
  });
  const setModeCall = deps.calls.find((call) => call[0] === "acp-set-mode");
  assert.deepEqual(setModeCall[1], { sessionId: "acp-session", modeId: "normalized-high" });
  const promptCall = deps.calls.find((call) => call[0] === "acp-prompt");
  assert.match(promptCall[1].prompt[0].text, /## Mia Runtime Context/);
  assert.match(promptCall[1].prompt[0].text, /Claw 的人设/);
  assert.match(promptCall[1].prompt[0].text, /Mia 记忆/);
  assert.match(promptCall[1].prompt[0].text, /Available Mia Skills/);
  assert.match(promptCall[1].prompt[0].text, /Loaded Mia Skill Guides/);
  assert.match(promptCall[1].prompt[0].text, /用户消息：\n帮我整理文件/);
  assert.deepEqual(promptCall[1]._meta, {
    thinking: "normalized-high",
    timeoutMs: 600000,
    prefixCwd: false
  });
  assert.equal(response.model, "openclaw-acp");
  assert.equal(response.choices[0].message.content, "OpenClaw reply");
  assert.deepEqual(response.mia, {
    transport: "acp-backend",
    agent_type: "acp",
    backend: "openclaw",
    compatibility_transport: "",
    engine: "openclaw",
    session_id: "openclaw:mia:claw:mia-session",
    bot_id: "claw"
  });
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
    "set-session",
    "openclaw",
    "claw",
    "mia-session",
    "openclaw:mia:claw:mia-session"
  ]);
  assert.equal(deps.calls.some((call) => call[0] === "exec"), false);
});

test("sendChat waits for user MCP readiness before reading OpenClaw MCP servers", async () => {
  let ready = false;
  const deps = createDeps({
    ensureUserMcpReady: async () => { ready = true; },
    getUserMcpServers: () => {
      assert.equal(ready, true);
      return [];
    }
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: {} },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "帮我整理文件" }]
  });
});

test("ACP newSession defaults MCP injection to stdio plus bridge fallback when capabilities are missing", async () => {
  const deps = createDeps({
    userMcpServers: [{ name: "xhs", command: "node", args: ["/proxy.js"], env: [{ name: "A", value: "1" }] }],
    mcpFingerprint: "mcp_fp"
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "bot", name: "Bot", engineConfig: {} },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }]
  });

  const newSession = deps.calls.find((call) => call[0] === "acp-new-session")[1];
  assert.deepEqual(deps.calls.find((call) => call[0] === "get-user-mcp-servers"), [
    "get-user-mcp-servers",
    { supportsHttp: false, supportsSse: false }
  ]);
  assert.deepEqual(newSession.mcpServers, [{ name: "xhs", command: "node", args: ["/proxy.js"], env: [{ name: "A", value: "1" }] }]);
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), ["set-session", "openclaw", "bot", "s1", "openclaw:mia:bot:s1:mcp_fp"]);
});

test("ACP MCP injection includes the Mia app built-in server", async () => {
  const specCalls = [];
  const deps = createDeps({
    getMiaAppMcpSpec: (context) => {
      specCalls.push(context);
      return {
        type: "stdio",
        command: "/opt/node",
        args: ["/tmp/mia-app-mcp-server.js"],
        env: { MIA_APP_CONTEXT_FILE: "/tmp/mia-app-context.json" }
      };
    },
    userMcpServers: [
      { name: "mia-app", command: "/bad/node", args: ["/bad.js"], env: [] },
      { name: "xhs", command: "node", args: ["/proxy.js"], env: [] }
    ]
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "bot", name: "Bot", engineConfig: {} },
    sessionId: "s1",
    messages: [{ role: "user", id: "m1", content: "hi" }]
  });

  const newSession = deps.calls.find((call) => call[0] === "acp-new-session")[1];
  assert.deepEqual(specCalls[0], { botId: "bot", sessionId: "s1", originMessageId: "m1" });
  assert.deepEqual(newSession.mcpServers, [
    { name: "xhs", command: "node", args: ["/proxy.js"], env: [] },
    {
      name: "mia-app",
      command: "/opt/node",
      args: ["/tmp/mia-app-mcp-server.js"],
      env: [{ name: "MIA_APP_CONTEXT_FILE", value: "/tmp/mia-app-context.json" }]
    }
  ]);
});

test("ACP MCP injection uses initialized transport capabilities when available", async () => {
  const deps = createDeps({
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { mcp: { transports: ["http", "sse"] } },
      agentInfo: { name: "openclaw-acp", version: "test" }
    },
    userMcpServers: [{ type: "http", name: "xhs", url: "http://127.0.0.1:18060/mcp", headers: [] }]
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "bot", name: "Bot", engineConfig: {} },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }]
  });

  const newSession = deps.calls.find((call) => call[0] === "acp-new-session")[1];
  assert.deepEqual(deps.calls.find((call) => call[0] === "get-user-mcp-servers"), [
    "get-user-mcp-servers",
    { supportsHttp: true, supportsSse: true }
  ]);
  assert.deepEqual(newSession.mcpServers, [{ type: "http", name: "xhs", url: "http://127.0.0.1:18060/mcp", headers: [] }]);
});

test("ACP MCP injection exposes managed xiaohongshu HTTP when OpenClaw supports HTTP", async () => {
  const deps = createDeps({
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { mcp: { transports: ["http"] } },
      agentInfo: { name: "openclaw-acp", version: "test" }
    },
    userMcpServers: [{ type: "http", name: "xiaohongshu", url: "http://127.0.0.1:18060/mcp", headers: [] }],
    mcpFingerprint: "mcp_fp"
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "bot", name: "Bot", engineConfig: {} },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }]
  });

  const newSession = deps.calls.find((call) => call[0] === "acp-new-session")[1];
  assert.deepEqual(newSession.mcpServers, [{ type: "http", name: "xiaohongshu", url: "http://127.0.0.1:18060/mcp", headers: [] }]);
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), ["set-session", "openclaw", "bot", "s1", "openclaw:mia:bot:s1:mcp_fp"]);
});

test("sendChat emits OpenClaw ACP diff content as unified file_edit events", async () => {
  const deps = createDeps();
  deps.importAcpSdk = async () => {
    class DiffClientSideConnection {
      constructor(toClient, stream) {
        deps.calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
        this.handlers = toClient(this);
      }

      async initialize(params) {
        deps.calls.push(["acp-initialize", params]);
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "openclaw-acp" } };
      }

      async newSession(params) {
        deps.calls.push(["acp-new-session", params]);
        return { sessionId: "acp-session", configOptions: [], modes: { currentModeId: "adaptive", availableModes: [] } };
      }

      async setSessionMode(params) {
        deps.calls.push(["acp-set-mode", params]);
        return {};
      }

      async prompt(params) {
        deps.calls.push(["acp-prompt", params]);
        await this.handlers.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool_1",
            title: "Edit file",
            kind: "edit",
            rawInput: { path: "src/app.js" }
          }
        });
        await this.handlers.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool_1",
            status: "completed",
            content: [{ type: "diff", path: "src/app.js", old_text: "old", new_text: "new" }]
          }
        });
        await this.handlers.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" }
          }
        });
        return { stopReason: "end_turn" };
      }
    }
    return {
      ClientSideConnection: DiffClientSideConnection,
      PROTOCOL_VERSION: 1,
      ndJsonStream: (writable, readable) => ({ writable, readable })
    };
  };
  const emitted = [];
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: {} },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "改文件" }],
    emit: (kind, payload) => emitted.push({ kind, payload })
  });

  assert.deepEqual(emitted.filter((event) => event.kind === "file_edit"), [{
    kind: "file_edit",
    payload: {
      id: "tool_1_diff_0",
      path: "src/app.js",
      action: "update",
      title: "Edited src/app.js (+1 -1)",
      diff: [
        "diff --git a/src/app.js b/src/app.js",
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new"
      ].join("\n"),
      additions: 1,
      deletions: 1,
      status: "completed",
      error: false
    }
  }]);
});

test("sendChat puts the selected OpenClaw bin dir first in ACP env", async () => {
  const deps = createDeps({
    processEnvStrings: () => ({ PATH: "/bad-node/bin:/usr/bin:/opt/openclaw-node/bin" }),
    shellCommandPath: (command) => (command === "openclaw" ? "/opt/openclaw-node/bin/openclaw" : "")
  });
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { effortLevel: "high" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "hello" }]
  });

  const spawnCall = deps.calls.find((call) => call[0] === "spawn");
  assert.equal(spawnCall[4], "/opt/openclaw-node/bin:/bad-node/bin:/usr/bin");
});

test("sendChat can explicitly fall back to the legacy OpenClaw agent CLI", async () => {
  const deps = createDeps();
  const adapter = createOpenClawChatAdapter(deps);
  const response = await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { effortLevel: "high", openclawTransport: "legacy-agent" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "帮我整理文件" }]
  });

  const execCall = deps.calls.find((call) => call[0] === "exec");
  assert.equal(execCall[1], "/bin/openclaw");
  assert.equal(execCall[2][0], "agent");
  assert.equal(execCall[2][3], "--agent");
  assert.equal(execCall[2][4], "main");
  assert.equal(execCall[2][5], "--session-key");
  assert.match(execCall[2][6], /^mia-[a-f0-9]{32}$/);
  assert.deepEqual(execCall[2].slice(7), ["--thinking", "normalized-high", "--json", "--timeout", "600"]);
  assert.equal(response.choices[0].message.content, "OpenClaw reply");
  assert.equal(response.mia.compatibility_transport, "openclaw-cli");
  assert.equal(deps.calls.some((call) => call[0] === "spawn"), false);
});

test("sendChat explains OpenClaw Gateway connection failures from ACP stdout", async () => {
  const calls = [];
  class FailingClientSideConnection {
    constructor(toClient, stream) {
      calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
      this.handlers = toClient(this);
    }

    async initialize() {
      throw new Error("ACP connection closed");
    }
  }
  const deps = createDeps({
    calls,
    importAcpSdk: () => new Promise((resolve) => setImmediate(() => resolve({
      ClientSideConnection: FailingClientSideConnection,
      PROTOCOL_VERSION: 1,
      ndJsonStream: (writable, readable) => ({ writable, readable })
    }))),
    spawn: (file, args, options) => {
      calls.push(["spawn", file, args, options.cwd]);
      const child = fakeChildProcess(calls);
      process.nextTick(() => {
        child.stdout.write("gateway client error: Error: connect ECONNREFUSED 127.0.0.1:18789");
      });
      return child;
    }
  });
  const adapter = createOpenClawChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      bot: { key: "claw", name: "Claw", engineConfig: {} },
      sessionId: "mia-session",
      messages: [{ role: "user", content: "hello" }]
    }),
    /OpenClaw Gateway 没有运行/
  );
});

test("sendChat redacts legacy OpenClaw command failures instead of leaking prompts", async () => {
  const deps = createDeps({
    execFile: (file, args, options, callback) => {
      deps.calls.push(["exec", file, args, options.cwd, options.env.PATH, options.input || ""]);
      const error = new Error("Command failed: /bin/openclaw agent --message SECRET_PROMPT --json");
      callback(error, "", "Error: Pass --to <E.164>, --session-key, --session-id, or --agent to choose a session");
      return { kill() {} };
    }
  });
  const adapter = createOpenClawChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      bot: { key: "claw", name: "Claw", engineConfig: { openclawTransport: "legacy-agent" } },
      sessionId: "mia-session",
      messages: [{ role: "user", content: "SECRET_PROMPT" }]
    }),
    (error) => {
      assert.match(error.message, /OpenClaw agent 运行失败/);
      assert.match(error.message, /Pass --to/);
      assert.doesNotMatch(error.message, /SECRET_PROMPT/);
      assert.doesNotMatch(error.message, /--message/);
      return true;
    }
  );
});

test("sendChat syncs Mia-managed OpenClaw models and runs them through ACP backend", async () => {
  const deps = createDeps({
    resolveModelRuntime: () => ({
      provider: "mia",
      providerConnectionId: "mia",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiKey: "cloud-token",
      providerLabel: "Mia",
      authType: "mia_account",
      apiMode: "chat_completions",
      managedByMia: true
    })
  });
  const adapter = createOpenClawChatAdapter(deps);

  const response = await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { provider: "mia", model: "mia-auto" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "hello" }]
  });

  const configCall = deps.calls.find((call) => call[0] === "exec" && call[2][0] === "config");
  assert.deepEqual(configCall[2], ["config", "patch", "--stdin"]);
  assert.match(configCall[5], /"providers":/);
  assert.match(configCall[5], /"mia-auto"/);
  assert.match(configCall[5], /"baseUrl":"https:\/\/mia\.example\/api\/me\/model-proxy\/v1"/);

  const spawnCall = deps.calls.find((call) => call[0] === "spawn");
  assert.equal(spawnCall[1], "/bin/openclaw");
  assert.deepEqual(spawnCall[2], ["acp", "--no-prefix-cwd"]);
  assert.equal(deps.calls.some((call) => call[0] === "exec" && call[2][0] === "agent"), false);
  const newSessionCall = deps.calls.find((call) => call[0] === "acp-new-session");
  assert.equal(newSessionCall[1]._meta.model, "mia/mia-auto");
  const promptCall = deps.calls.find((call) => call[0] === "acp-prompt");
  assert.equal(promptCall[1]._meta.model, "mia/mia-auto");
  assert.equal(response.mia.compatibility_transport, "");
});

test("sendChat falls back to local OpenClaw CLI for Mia-managed models when ACP gateway is unavailable", async () => {
  let deps;
  class FailingClientSideConnection {
    constructor(toClient, stream) {
      deps.calls.push(["acp-connect", Boolean(stream?.readable), Boolean(stream?.writable)]);
      this.handlers = toClient(this);
    }

    async initialize() {
      throw new Error("ACP connection closed");
    }
  }
  deps = createDeps({
    importAcpSdk: () => new Promise((resolve) => setImmediate(() => resolve({
      ClientSideConnection: FailingClientSideConnection,
      PROTOCOL_VERSION: 1,
      ndJsonStream: (writable, readable) => ({ writable, readable })
    }))),
    resolveModelRuntime: () => ({
      provider: "mia",
      providerConnectionId: "mia",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiKey: "cloud-token",
      providerLabel: "Mia",
      authType: "mia_account",
      apiMode: "chat_completions",
      managedByMia: true
    }),
    spawn: (file, args, options) => {
      deps.calls.push(["spawn", file, args, options.cwd]);
      const child = fakeChildProcess(deps.calls);
      process.nextTick(() => {
        child.stdout.write("ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789");
      });
      return child;
    }
  });
  const adapter = createOpenClawChatAdapter(deps);

  const response = await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: { provider: "mia", model: "mia-auto" } },
    sessionId: "mia-session",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(deps.calls.some((call) => call[0] === "spawn"), true);
  const agentCall = deps.calls.find((call) => call[0] === "exec" && call[2][0] === "agent");
  assert.equal(agentCall[1], "/bin/openclaw");
  assert.equal(agentCall[2].includes("--local"), true);
  assert.equal(agentCall[2][agentCall[2].indexOf("--model") + 1], "mia/mia-auto");
  assert.equal(agentCall[2][agentCall[2].indexOf("--thinking") + 1], "off");
  assert.equal(response.choices[0].message.content, "OpenClaw reply");
  assert.equal(response.mia.compatibility_transport, "openclaw-cli-fallback");
});

test("sendChat reuses OpenClaw ACP runtime for durable conversation sessions", async (t) => {
  t.after(() => closeOpenClawAcpRuntimes());
  const deps = createDeps();
  const adapter = createOpenClawChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: {} },
    sessionId: "conversation:bot:u_1:claw",
    messages: [{ role: "user", content: "hello" }]
  });
  await adapter.sendChat({
    bot: { key: "claw", name: "Claw", engineConfig: {} },
    sessionId: "conversation:bot:u_1:claw",
    messages: [{ role: "user", content: "again" }]
  });

  assert.equal(deps.calls.filter((call) => call[0] === "spawn").length, 1);
  assert.equal(deps.calls.filter((call) => call[0] === "acp-initialize").length, 1);
  assert.equal(deps.calls.filter((call) => call[0] === "acp-new-session").length, 1);
  assert.equal(deps.calls.filter((call) => call[0] === "acp-prompt").length, 2);
});
