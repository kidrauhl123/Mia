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
  assert.match(capture.params.prompt, /Conversation history/);
  assert.match(capture.params.prompt, /\/data\/attachments\/a\.txt maps to \/tmp\/mia-worker\/attachments\/a\.txt/);
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

test("cloud Claude Code client fails fast when DeepSeek credentials are absent", async () => {
  const client = createCloudClaudeCodeClient({ claudeAgentSdk: fakeSdk([], {}) });
  await assert.rejects(
    () => client.runChat({ worker: { env: {}, paths: {} }, input: "hello" }),
    /DeepSeek API Key is not configured/
  );
});
