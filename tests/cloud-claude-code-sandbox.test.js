const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_CLOUD_CLAUDE_CODE_MODEL,
  normalizeCloudClaudeCodeModel
} = require("../src/cloud-agent/cloud-claude-code-model.js");
const {
  DEFAULT_AGENT_PYTHON_VENV,
  DEFAULT_PIP_INDEX_URL,
  baseClaudeCodeEnv,
  createCloudClaudeCodeSandboxManager
} = require("../src/cloud-agent/claude-code-sandbox-manager.js");
const {
  createCloudClaudeCodeClient,
  normalizeClaudePermissionMode
} = require("../src/cloud-agent/claude-code-sandbox-client.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSdk(messages, capture) {
  return async () => ({
    query(params) {
      capture.params = params;
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        async interrupt() {
          capture.interrupted = true;
        },
        close() {
          capture.closed = true;
        }
      };
    }
  });
}

function fakeSdkSequence(steps, capture) {
  let index = 0;
  return async () => ({
    query(params) {
      capture.paramsList = capture.paramsList || [];
      capture.paramsList.push(params);
      const step = steps[index++] || [];
      if (step instanceof Error) throw step;
      const messages = Array.isArray(step) ? step : (step.messages || []);
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        async interrupt() {
          capture.interrupted = true;
        },
        close() {
          capture.closed = true;
        }
      };
    }
  });
}

test("cloud Claude Code model normalizes Mia and Hermes aliases to a Claude model name", () => {
  assert.equal(normalizeCloudClaudeCodeModel(""), DEFAULT_CLOUD_CLAUDE_CODE_MODEL);
  assert.equal(normalizeCloudClaudeCodeModel("mia-auto", { defaultModel: "claude-sonnet-x" }), "claude-sonnet-x");
  assert.equal(normalizeCloudClaudeCodeModel("hermes-agent", { defaultModel: "claude-sonnet-x" }), "claude-sonnet-x");
  assert.equal(normalizeCloudClaudeCodeModel("claude-opus-4-5"), "claude-opus-4-5");
});

test("cloud Claude Code sandbox manager creates per-user workspace and DeepSeek Anthropic env", async () => {
  const root = tempDir("mia-cloud-claude-manager-");
  try {
    const manager = createCloudClaudeCodeSandboxManager({
      root,
      apiKey: "sk-deepseek",
      anthropicBaseUrl: "https://api.deepseek.com/anthropic/",
      model: "mia-auto",
      platformModel: "mia-auto",
      pythonVenv: path.join(root, "python"),
      pipIndexUrl: "https://mirror.test/simple",
      sandboxRequired: true
    });
    const worker = await manager.ensureWorker("user:1");
    assert.equal(worker.runtimeKind, "cloud-claude-code");
    assert.equal(worker.model, DEFAULT_CLOUD_CLAUDE_CODE_MODEL);
    assert.equal(worker.platformModel, "mia-auto");
    assert.equal(worker.modelProvider, "deepseek");
    assert.equal(worker.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(worker.env.ANTHROPIC_API_KEY, "sk-deepseek");
    assert.equal(worker.env.ANTHROPIC_AUTH_TOKEN, "sk-deepseek");
    assert.equal(worker.env.MIA_CLOUD_AGENT_PYTHON_VENV, path.join(root, "python"));
    assert.equal(worker.env.VIRTUAL_ENV, path.join(root, "python"));
    assert.equal(worker.env.PIP_INDEX_URL, "https://mirror.test/simple");
    assert.equal(worker.env.PIP_DISABLE_PIP_VERSION_CHECK, "1");
    assert.equal(worker.env.PATH.split(path.delimiter)[0], path.join(root, "python", "bin"));
    assert.equal(worker.env.PYTHONUSERBASE, path.join(worker.paths.home, ".local"));
    assert.equal(worker.env.PIP_CACHE_DIR, path.join(worker.paths.cache, "pip"));
    assert.equal(worker.env.MPLCONFIGDIR, path.join(worker.paths.cache, "matplotlib"));
    assert.equal(worker.sandboxSettings.enabled, true);
    assert.equal(worker.sandboxSettings.failIfUnavailable, true);
    assert.ok(fs.statSync(worker.paths.workspace).isDirectory());
    assert.ok(fs.statSync(worker.paths.pythonUserBase).isDirectory());
    assert.ok(fs.statSync(worker.paths.agentHome).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseClaudeCodeEnv points Claude Code at DeepSeek Anthropic-compatible endpoint", () => {
  const env = baseClaudeCodeEnv({
    apiKey: "sk-test",
    baseUrl: "https://example.test/anthropic/",
    pythonVenv: DEFAULT_AGENT_PYTHON_VENV,
    pipIndexUrl: DEFAULT_PIP_INDEX_URL
  });
  assert.equal(env.baseUrl, "https://example.test/anthropic");
  assert.equal(env.apiKey, "sk-test");
  assert.equal(env.env.ANTHROPIC_BASE_URL, "https://example.test/anthropic");
  assert.equal(env.env.MIA_CLOUD_AGENT_PYTHON_VENV, DEFAULT_AGENT_PYTHON_VENV);
  assert.equal(env.env.PIP_INDEX_URL, DEFAULT_PIP_INDEX_URL);
  assert.equal(env.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
});

test("cloud Claude Code permission normalization does not escalate stale read-only values", () => {
  assert.equal(normalizeClaudePermissionMode(""), "bypassPermissions");
  assert.equal(normalizeClaudePermissionMode("ask"), "default");
  assert.equal(normalizeClaudePermissionMode("auto"), "auto");
  assert.equal(normalizeClaudePermissionMode("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeClaudePermissionMode("readOnly"), "plan");
  assert.equal(normalizeClaudePermissionMode("deny"), "plan");
  assert.equal(normalizeClaudePermissionMode("unknown-mode"), "default");
});

test("cloud Claude Code client runs SDK query without Hermes gateway and streams Mia events once", async () => {
  const capture = {};
  const events = [];
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdk([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" }
        }
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" }
        }
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "final" }] }
      }
    ], capture),
    randomUUID: () => "uuid-1"
  });
  let runtimeRunId = "";
  const result = await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      permissionMode: "bypassPermissions",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: {
        root: "/tmp/mia-worker",
        workspace: "/tmp/mia-worker/workspace"
      },
      sandboxSettings: { enabled: true, failIfUnavailable: true }
    },
    model: "mia-auto",
    instructions: "system instructions",
    seedMessages: [{ role: "user", content: "earlier" }],
    input: "hello",
    attachments: [{ name: "a.txt", path: "/data/attachments/a.txt", hostPath: "/tmp/mia-worker/attachments/a.txt" }],
    onRunCreated(id) {
      runtimeRunId = id;
    },
    onEvent(event) {
      events.push(event);
    }
  });

  assert.match(runtimeRunId, /^cc_/);
  assert.equal(result.content, "final");
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["partial"]);
  assert.equal(capture.params.options.model, "claude-sonnet-test");
  assert.equal(capture.params.options.permissionMode, "bypassPermissions");
  assert.equal(capture.params.options.allowDangerouslySkipPermissions, true);
  assert.equal(capture.params.options.sandbox.enabled, true);
  assert.doesNotMatch(capture.params.prompt, /Conversation history/);
  assert.doesNotMatch(capture.params.prompt, /earlier/);
  assert.equal(capture.params.prompt, "hello");
  assert.doesNotMatch(capture.params.prompt, /Mia cloud sandbox filesystem mapping/);
  assert.doesNotMatch(capture.params.prompt, /\/data\/attachments\/a\.txt maps to \/tmp\/mia-worker\/attachments\/a\.txt/);
  assert.match(capture.params.options.systemPrompt.append, /system instructions/);
  assert.match(capture.params.options.systemPrompt.append, /Mia cloud sandbox filesystem mapping/);
  assert.match(capture.params.options.systemPrompt.append, /\/data\/attachments\/a\.txt maps to \/tmp\/mia-worker\/attachments\/a\.txt/);
});

test("cloud Claude Code client passes cloud-safe MCP servers to the SDK", async () => {
  const capture = {};
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdk([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] }
      }
    ], capture),
    randomUUID: () => "uuid-1"
  });

  await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      permissionMode: "bypassPermissions",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: { workspace: "/tmp/mia-worker/workspace" },
      sandboxSettings: { enabled: true, failIfUnavailable: true }
    },
    input: "hello",
    mcpServers: {
      docs: {
        type: "http",
        url: "https://cloud.example/mcp",
        headers: { Authorization: "Bearer cloud-token" }
      },
      "mia-app": {
        command: "/usr/local/bin/node",
        args: ["/Applications/Mia/mia-app-mcp-server.js"],
        env: { MIA_CORE_URL: "http://127.0.0.1:27861", MIA_CORE_TOKEN: "local-token" }
      },
      "mia-scheduler": {
        command: "/usr/local/bin/node",
        args: ["/Applications/Mia/scheduler-mcp-server.js"],
        env: { MIA_SCHEDULER_CONTEXT_FILE: "/tmp/mia-scheduler-context.json" }
      },
      shell: {
        command: "/bin/sh",
        args: ["-lc", "echo unsafe"]
      }
    }
  });

  assert.deepEqual(capture.params.options.mcpServers, {
    docs: {
      type: "http",
      url: "https://cloud.example/mcp",
      headers: { Authorization: "Bearer cloud-token" }
    }
  });
  assert.equal(capture.params.options.strictMcpConfig, true);
});

test("cloud Claude Code client enables only turn-scoped native project skills", async () => {
  const capture = {};
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdk([{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }], capture),
    randomUUID: () => "uuid-native-skill"
  });

  await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: { workspace: "/tmp/mia-worker/workspace" }
    },
    cwd: "/tmp/mia-worker/workspace/.mia-agent-sessions/bot/conv",
    additionalDirectories: ["/tmp/mia-worker/workspace"],
    skills: ["mia-scheduler"],
    input: "1分钟后提醒我喝水"
  });

  assert.equal(capture.params.options.cwd, "/tmp/mia-worker/workspace/.mia-agent-sessions/bot/conv");
  assert.deepEqual(capture.params.options.settingSources, ["project"]);
  assert.deepEqual(capture.params.options.additionalDirectories, ["/tmp/mia-worker/workspace"]);
  assert.deepEqual(capture.params.options.skills, ["mia-scheduler"]);
});

test("cloud Claude Code client allows trusted Mia cloud stdio MCP servers", async () => {
  const capture = {};
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdk([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] }
      }
    ], capture),
    randomUUID: () => "uuid-1"
  });

  await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      permissionMode: "bypassPermissions",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: { workspace: "/tmp/mia-worker/workspace" },
      sandboxSettings: { enabled: true, failIfUnavailable: true }
    },
    input: "hello",
    mcpServers: {
      "mia-app": {
        type: "stdio",
        command: process.execPath,
        args: ["/tmp/mia-cloud-mcp-server.js"],
        env: {
          MIA_CLOUD_URL: "https://cloud.example",
          MIA_CLOUD_TOKEN: "cloud-token"
        },
        source: "mia-cloud",
        trusted: true
      },
      shell: {
        command: "/bin/sh",
        args: ["-lc", "echo unsafe"]
      }
    }
  });

  assert.deepEqual(capture.params.options.mcpServers, {
    "mia-app": {
      type: "stdio",
      command: process.execPath,
      args: ["/tmp/mia-cloud-mcp-server.js"],
      env: {
        MIA_CLOUD_URL: "https://cloud.example",
        MIA_CLOUD_TOKEN: "cloud-token"
      }
    }
  });
  assert.equal(capture.params.options.strictMcpConfig, true);
});

test("cloud Claude Code client dedupes progressive assistant snapshots in fallback mode", async () => {
  const events = [];
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdk([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "我先试试。" }] }
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "我先试试。\n\n还是不行。" }] }
      }
    ], {}),
    randomUUID: () => "uuid-1"
  });

  const result = await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      permissionMode: "bypassPermissions",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: {
        root: "/tmp/mia-worker",
        workspace: "/tmp/mia-worker/workspace"
      },
      sandboxSettings: { enabled: true, failIfUnavailable: true }
    },
    input: "hello",
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.content, "我先试试。\n\n还是不行。");
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "我先试试。",
    "\n\n还是不行。"
  ]);
});

test("cloud Claude Code client preserves ordered assistant content blocks without stream events", async () => {
  const events = [];
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdk([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "我先看目录。" },
            { type: "thinking", thinking: "判断是否需要工具。" },
            { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "pwd" } },
            { type: "text", text: "工具调用发出。" }
          ]
        }
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool_1", content: "/tmp/mia" }
          ]
        }
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "结论是已确认。" }
          ]
        }
      }
    ], {}),
    randomUUID: () => "uuid-1"
  });

  const result = await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      permissionMode: "bypassPermissions",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: { workspace: "/tmp/mia-worker/workspace" },
      sandboxSettings: { enabled: true, failIfUnavailable: true }
    },
    input: "hello",
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.content, "我先看目录。\n\n工具调用发出。\n\n结论是已确认。");
  assert.deepEqual(events.map((event) => event.type), [
    "text_delta",
    "reasoning_delta",
    "tool_call_started",
    "text_delta",
    "tool_call_completed",
    "text_delta"
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.text),
    ["我先看目录。", "工具调用发出。", "结论是已确认。"]
  );
  assert.equal(events.find((event) => event.type === "tool_call_started")?.name, "Bash");
});

test("cloud Claude Code client captures SDK session ids and resumes natively without prompt history", async () => {
  const capture = {};
  const seenSessionIds = [];
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdkSequence([
      [
        {
          type: "assistant",
          session_id: "sdk-session-1",
          message: { content: [{ type: "text", text: "first" }] }
        }
      ],
      [
        {
          type: "assistant",
          session_id: "sdk-session-1",
          message: { content: [{ type: "text", text: "second" }] }
        }
      ]
    ], capture),
    randomUUID: () => "uuid-1"
  });
  const worker = {
    hasApiKey: true,
    model: "claude-sonnet-test",
    permissionMode: "bypassPermissions",
    env: { ANTHROPIC_API_KEY: "sk-test" },
    paths: {
      root: "/tmp/mia-worker",
      workspace: "/tmp/mia-worker/workspace"
    },
    sandboxSettings: { enabled: true, failIfUnavailable: true }
  };

  const first = await client.runChat({
    worker,
    input: "first message",
    onSessionId(sessionId) {
      seenSessionIds.push(sessionId);
    }
  });
  const second = await client.runChat({
    worker,
    nativeSessionId: first.sessionId,
    seedMessages: [{ role: "user", content: "forbidden history" }],
    input: "second message",
    onSessionId(sessionId) {
      seenSessionIds.push(sessionId);
    }
  });

  assert.equal(first.sessionId, "sdk-session-1");
  assert.equal(first.nativeSessionId, "sdk-session-1");
  assert.equal(second.sessionId, "sdk-session-1");
  assert.deepEqual(seenSessionIds, ["sdk-session-1", "sdk-session-1"]);
  assert.equal(capture.paramsList[0].options.resume, undefined);
  assert.equal(capture.paramsList[0].prompt, "first message");
  assert.equal(capture.paramsList[1].options.resume, "sdk-session-1");
  assert.equal(capture.paramsList[1].prompt, "second message");
  assert.doesNotMatch(capture.paramsList[1].prompt, /forbidden history/);
});

test("cloud Claude Code client retries a stale native session without replaying history", async () => {
  const capture = {};
  const resets = [];
  const client = createCloudClaudeCodeClient({
    claudeAgentSdk: fakeSdkSequence([
      Object.assign(new Error("Session not found"), { code: "ENOSESSION" }),
      [
        {
          type: "assistant",
          session_id: "sdk-session-new",
          message: { content: [{ type: "text", text: "fresh" }] }
        }
      ]
    ], capture),
    randomUUID: () => "uuid-1"
  });

  const result = await client.runChat({
    worker: {
      hasApiKey: true,
      model: "claude-sonnet-test",
      permissionMode: "bypassPermissions",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      paths: { workspace: "/tmp/mia-worker/workspace" },
      sandboxSettings: { enabled: true, failIfUnavailable: true }
    },
    nativeSessionId: "stale-session",
    seedMessages: [{ role: "assistant", content: "old answer" }],
    input: "current only",
    onSessionReset(info) {
      resets.push(info.staleSessionId);
    }
  });

  assert.equal(result.sessionId, "sdk-session-new");
  assert.deepEqual(resets, ["stale-session"]);
  assert.equal(capture.paramsList.length, 2);
  assert.equal(capture.paramsList[0].options.resume, "stale-session");
  assert.equal(capture.paramsList[1].options.resume, undefined);
  assert.equal(capture.paramsList[1].prompt, "current only");
  assert.doesNotMatch(capture.paramsList[1].prompt, /old answer/);
});

test("cloud Claude Code client fails fast when DeepSeek credentials are absent", async () => {
  const client = createCloudClaudeCodeClient({ claudeAgentSdk: fakeSdk([], {}) });
  await assert.rejects(
    () => client.runChat({ worker: { env: {}, paths: {} }, input: "hello" }),
    /DeepSeek API Key is not configured/
  );
});
