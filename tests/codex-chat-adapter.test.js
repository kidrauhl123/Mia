const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createCodexChatAdapter,
  mapCodexPermissionMode
} = require("../src/main/codex-chat-adapter.js");
const { chatCompletionResponse } = require("../src/main/chat-response.js");

function createDeps(overrides = {}) {
  const calls = [];
  class Codex {
    constructor(options) {
      calls.push(["constructor", options]);
    }
    startThread(options) {
      calls.push(["startThread", options]);
      return {
        id: overrides.startedThreadId || "thread_1",
        run: async (prompt, runOptions) => {
          calls.push(["run", prompt, runOptions]);
          return { finalResponse: overrides.finalResponse || "codex out" };
        }
      };
    }
    resumeThread(id, options) {
      calls.push(["resumeThread", id, options]);
      return {
        id,
        run: async (prompt, runOptions) => {
          calls.push(["run", prompt, runOptions]);
          return { finalResponse: overrides.finalResponse || "resumed out" };
        }
      };
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
    getAgentSessionId: () => overrides.externalSessionId || "",
    injectGroupContextForSdk: (prompt, contextBlock) => `GROUP:${contextBlock}\n${prompt}`,
    lastUserPrompt: () => "hello",
    normalizeEffortLevel: (level, engine) => `${engine}:${level}`,
    processEnvStrings: () => ({ PATH: "/bin" }),
    readFellowPersona: () => "persona",
    setAgentSessionId: (...args) => calls.push(["set-session", ...args]),
    shellCommandPath: (command) => command === "codex" ? "/bin/codex" : ""
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
  assert.deepEqual(deps.calls[1], ["constructor", { codexPathOverride: "/bin/codex", env: { PATH: "/bin" } }]);
  assert.equal(deps.calls[2][0], "startThread");
  assert.equal(deps.calls[2][1].workingDirectory, "/repo");
  assert.equal(deps.calls[2][1].modelReasoningEffort, "codex:high");
  assert.equal(deps.calls[2][1].model, "gpt-test");
  assert.equal(deps.calls[2][1].sandboxMode, "read-only");
  assert.match(deps.calls[3][1], /^GROUP:ctx\n以下是 Aimashi 给当前 Fellow 的人设/);
  assert.match(deps.calls[3][1], /persona/);
  assert.match(deps.calls[3][1], /expanded/);
  assert.deepEqual(deps.calls.find((call) => call[0] === "set-session"), [
    "set-session", "codex", "alice", "s1", "thread_1"
  ]);
  assert.equal(response.id, "thread_1");
  assert.equal(response.choices[0].message.content, "codex out");
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
  assert.equal(deps.calls[3][1], "expanded");
  assert.equal(deps.calls.some((call) => call[0] === "set-session"), false);
  assert.equal(response.id, "thread_old");
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
  assert.deepEqual(response, { content: "stateless out" });
});
