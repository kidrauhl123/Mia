const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBrowserGlobal(relativePath, globalName) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const context = { window: {} };
  context.globalThis = context.window;
  vm.runInNewContext(source, context, { filename: relativePath });
  return context.window[globalName];
}

test("ipc channel contract is available in Node and browser contexts", () => {
  const nodeContract = require("../src/shared/ipc-channels");
  const browserContract = loadBrowserGlobal("src/shared/ipc-channels.js", "miaIpcChannels");

  assert.equal(nodeContract.IpcChannel.ChatSend, "chat:send");
  assert.equal(nodeContract.IpcChannel.RuntimeInitialize, "runtime:initialize");
  assert.equal(nodeContract.IpcChannel.TasksRunNow, "tasks:run-now");
  assert.equal(nodeContract.IpcChannel.UpdateCheck, "update:check");
  assert.equal(nodeContract.IpcChannel.UpdateEvent, "update:event");
  assert.deepEqual(plain(browserContract.IpcChannel), plain(nodeContract.IpcChannel));
});

test("engine contract normalizes aliases and exposes shared labels", () => {
  const nodeContract = require("../src/shared/engine-contracts");
  const browserContract = loadBrowserGlobal("src/shared/engine-contracts.js", "miaEngineContracts");

  assert.equal(nodeContract.EngineId.Hermes, "hermes");
  assert.equal(nodeContract.EngineId.ClaudeCode, "claude-code");
  assert.equal(nodeContract.EngineId.Codex, "codex");
  assert.equal(nodeContract.EngineId.OpenClaw, "openclaw");
  assert.equal(nodeContract.normalizeAgentEngine("claude"), "claude-code");
  assert.equal(nodeContract.normalizeAgentEngine("openai_codex"), "codex");
  assert.equal(nodeContract.normalizeAgentEngine("open-claw"), "openclaw");
  assert.equal(nodeContract.normalizeAgentEngine("unknown"), "hermes");
  assert.equal(nodeContract.engineLabel("openclaw"), "OpenClaw");
  assert.equal(nodeContract.engineLabel("claude-code"), "Claude Code");
  assert.deepEqual(plain(browserContract.EngineId), plain(nodeContract.EngineId));
  assert.equal(browserContract.normalizeAgentEngine("openai-codex"), "codex");
});

test("engine contract owns external model and mode options for browser clients", () => {
  const contract = require("../src/shared/engine-contracts");

  assert.equal(contract.isExternalEngine("claude-code"), true);
  assert.equal(contract.isExternalEngine("codex"), true);
  assert.equal(contract.isExternalEngine("openclaw"), true);
  assert.equal(contract.isExternalEngine("hermes"), false);
  assert.equal(contract.adapterForEngine("openclaw").usesRuntime, true);
  assert.equal(contract.adapterForEngine("openclaw").transport, "acp-backend");
  assert.equal(contract.adapterForEngine("openclaw").agentType, "acp");
  assert.equal(contract.adapterForEngine("openclaw").backend, "openclaw");
  assert.deepEqual(contract.externalModelEntries("claude-code").map((entry) => entry.id), ["default", "mia-auto"]);
  assert.equal(contract.externalModelEntries("claude-code").find((entry) => entry.provider === "mia").authType, "mia_account");
  assert.deepEqual(
    contract.externalModelEntries("claude-code", {
      engineCapabilities: {
        engines: {
          "claude-code": {
            models: [{ id: "sonnet", provider: "claude-code", providerLabel: "Claude Code", model: "sonnet", label: "Sonnet alias" }]
          }
        }
      }
    }).map((entry) => ({ id: entry.id, model: entry.model, label: entry.label, provider: entry.provider })),
    [
      { id: "default", model: "", label: "Claude Code 默认", provider: "claude-code" },
      { id: "sonnet", model: "sonnet", label: "Sonnet alias", provider: "claude-code" },
      { id: "mia-auto", model: "mia-auto", label: "Auto", provider: "mia" }
    ]
  );
  assert.equal(contract.platformModelDisplayLabel({ id: "mia-auto", label: "Mia DeepSeek" }), "Auto");
  assert.equal(contract.platformModelDisplayLabel({ id: "mia-pro", label: "Mia Pro" }), "Pro");
  assert.deepEqual(
    contract.externalModelEntries("openclaw", {
      engineCapabilities: {
        engines: {
          openclaw: {
            models: [{ id: "openai/gpt-5.5", provider: "openclaw", providerLabel: "OpenClaw", model: "openai/gpt-5.5", label: "gpt-5.5" }]
          }
        }
      }
    }).map((entry) => ({ id: entry.id, model: entry.model, label: entry.label, provider: entry.provider })),
    [
      { id: "openai/gpt-5.5", model: "openai/gpt-5.5", label: "gpt-5.5", provider: "openclaw" },
      { id: "mia-auto", model: "mia-auto", label: "Auto", provider: "mia" }
    ]
  );
  assert.equal(contract.externalModelEntries("openclaw", {
    platformModels: [{ id: "mia-auto", label: "Mia DeepSeek" }]
  }).find((entry) => entry.provider === "mia")?.label, "Auto");
  assert.deepEqual(
    contract.externalModelEntries("codex", {
      codexModels: [{
        slug: "gpt-test",
        displayName: "GPT Test",
        description: "Test model",
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: [{ effort: "low", description: "Fast" }, { effort: "medium" }]
      }]
    }),
    [
      { id: "default", provider: "codex", providerLabel: "Codex CLI", model: "", label: "Codex 默认" },
      {
        id: "gpt-test",
        provider: "codex",
        providerLabel: "Codex CLI",
        model: "gpt-test",
        label: "GPT Test",
        description: "Test model",
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: [{ effort: "low", description: "Fast" }, { effort: "medium" }]
      },
      { id: "mia-auto", provider: "mia", providerLabel: "Mia", model: "mia-auto", label: "Auto", authType: "mia_account", modelProfileId: "mia:mia-auto", upstreamModel: "" }
    ]
  );
  assert.deepEqual(contract.externalModelEntries("codex").map((entry) => entry.id), ["default", "mia-auto"]);
  assert.deepEqual(
    contract.externalPermissionOptions("claude-code", {
      engineCapabilities: { engines: { "claude-code": { permissionModes: ["default", "plan"] } } }
    }).map((item) => ({ value: item.value, label: item.label })),
    [{ value: "default", label: "Ask" }, { value: "plan", label: "Plan Mode" }]
  );
  assert.deepEqual(
    contract.externalPermissionOptions("codex", {
      engineCapabilities: { engines: { codex: { permissionProfiles: [{ id: ":read-only" }, { id: ":workspace" }, { id: ":danger-full-access" }] } } }
    }).map((item) => ({ value: item.value, label: item.label, aliases: item.aliases })),
    [
      { value: ":workspace", label: "Workspace", aliases: ["default", "acceptEdits", "workspace"] },
      { value: ":read-only", label: "Read Only", aliases: ["readOnly", "read-only"] },
      { value: ":danger-full-access", label: "Full Access", aliases: ["bypassPermissions", "yolo", "off", "never", "danger-full-access"] }
    ]
  );
  assert.deepEqual(
    contract.externalPermissionOptions("openclaw", {
      engineCapabilities: { engines: { openclaw: { permissionOptions: [{ value: "readOnly", label: "Read" }] } } }
    }).map((item) => ({ value: item.value, label: item.label })),
    [{ value: "readOnly", label: "Read" }]
  );
  assert.deepEqual(contract.effortOptions("codex", {
    codexModels: [{ supportedReasoningLevels: [{ effort: "low", description: "Fast" }, { effort: "high" }] }]
  }), [
    { value: "low", label: "Low", title: "Fast" },
    { value: "high", label: "High", title: "" }
  ]);
  assert.deepEqual(contract.effortOptions("codex").map((item) => item.value), ["medium"]);
  assert.deepEqual(
    contract.effortOptions("openclaw", {
      engineCapabilities: { engines: { openclaw: { effortLevels: ["off", "adaptive", "max"] } } }
    }).map((item) => item.value),
    ["off", "adaptive", "max"]
  );
  assert.deepEqual(contract.effortOptions("openclaw").map((item) => item.value), ["medium"]);
  assert.deepEqual(
    contract.effortOptions("hermes", { effortLevels: ["low", "high"], effortLabels: { high: "High" } }),
    [{ value: "low", label: "low" }, { value: "high", label: "High" }]
  );
});

test("session history contract is shared by desktop and web clients", () => {
  const nodeContract = require("../packages/shared/session-history");
  const browserContract = loadBrowserGlobal("packages/shared/session-history.js", "miaSessionHistory");
  const botIdentity = require("../packages/shared/bot-identity");

  assert.equal(nodeContract.conversationType({ id: "botc_u_mia" }), "bot");
  assert.equal(browserContract.runtimeKind({ decorations: { runtimeKind: "cloud-hermes" } }), "cloud-hermes");
  assert.equal(browserContract.canCreateSession({ type: "bot", decorations: { botId: "mia" } }), true);
  assert.equal(botIdentity.botConversationId("u_mia"), "botc_u_mia");
});

test("bot runtime control contract saves model, effort, and permission patches", async () => {
  const contract = require("../src/shared/bot-runtime-control");
  const calls = [];
  const cache = new Map();
  const api = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return {
        binding: {
          botId: "mia",
          runtimeKind: "cloud-hermes",
          enabled: true,
          config: { model: "old-model", effortLevel: "low" }
        }
      };
    }
    return {
      binding: {
        botId: "mia",
        runtimeKind: options.body.runtimeKind,
        enabled: options.body.enabled,
        config: options.body.config
      }
    };
  };

  await contract.saveBotRuntimeControl({
    api,
    cache,
    botKey: "mia",
    runtimeKind: "cloud-hermes",
    field: "model",
    value: "mia-auto",
    modelEntries: [{ value: "mia-auto", model: "gpt-5.3", label: "GPT" }]
  });
  await contract.saveBotRuntimeControl({
    api,
    cache,
    botKey: "mia",
    runtimeKind: "cloud-hermes",
    field: "effort",
    value: "high"
  });
  await contract.saveBotRuntimeControl({
    api,
    cache,
    botKey: "mia",
    runtimeKind: "cloud-hermes",
    field: "permission",
    value: "auto"
  });

  const putCalls = calls.filter((call) => call.options.method === "PUT");
  assert.equal(calls[0].url, "/api/me/bots/mia/runtime?kind=cloud-hermes");
  assert.equal(putCalls.length, 3);
  assert.deepEqual(putCalls[0].options.body.config, { model: "gpt-5.3", effortLevel: "low" });
  assert.deepEqual(putCalls[1].options.body.config, { model: "gpt-5.3", effortLevel: "high" });
  assert.deepEqual(putCalls[2].options.body.config, { model: "gpt-5.3", effortLevel: "high", permissionMode: "auto" });
  assert.deepEqual(cache.get("mia:cloud-hermes")?.config, {
    model: "gpt-5.3",
    effortLevel: "high",
    permissionMode: "auto"
  });
});

test("bot runtime control accepts botId for runtime reads", async () => {
  const contract = require("../src/shared/bot-runtime-control");
  const calls = [];
  const binding = await contract.getBotRuntimeBinding({
    api: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        binding: {
          botId: "mia",
          runtimeKind: "cloud-hermes",
          enabled: true,
          config: { model: "mia-auto" }
        }
      };
    },
    botId: "mia",
    runtimeKind: "cloud-hermes"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/me/bots/mia/runtime?kind=cloud-hermes");
  assert.equal(binding.botId, "mia");
});

test("bot runtime control accepts botId for direct config saves", async () => {
  const contract = require("../src/shared/bot-runtime-control");
  const calls = [];
  const result = await contract.saveBotRuntimeConfig({
    api: async (url, options = {}) => {
      calls.push({ url, options });
      if (!options.method) return { binding: { botId: "mia", runtimeKind: "cloud-hermes", enabled: true, config: {} } };
      return { binding: { botId: "mia", runtimeKind: options.body.runtimeKind, enabled: true, config: options.body.config } };
    },
    botId: "mia",
    runtimeKind: "cloud-hermes",
    patch: { model: "mia-auto" }
  });

  assert.equal(result.saved, true);
  assert.equal(calls[0].url, "/api/me/bots/mia/runtime?kind=cloud-hermes");
  assert.equal(calls[1].url, "/api/me/bots/mia/runtime");
  assert.equal(calls[1].options.method, "PUT");
  assert.deepEqual(calls[1].options.body.config, { model: "mia-auto" });
});

test("main chat engine registry reuses the shared engine contract", () => {
  const shared = require("../src/shared/engine-contracts");
  const registry = require("../src/main/chat-engine-registry");

  assert.equal(registry.CHAT_ENGINE_ADAPTERS, shared.CHAT_ENGINE_ADAPTERS);
  assert.equal(registry.normalizeAgentEngine, shared.normalizeAgentEngine);
  assert.equal(registry.adapterForEngine, shared.adapterForEngine);
});

test("IPC registration and preload calls use the shared channel contract", () => {
  const source = [
    "src/preload.js",
    "src/main.js",
    "src/main/social/social-ipc.js"
  ].map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8")).join("\n");

  assert.doesNotMatch(source, /ipcRenderer\.(invoke|send|on|removeListener)\("[^"]+"/);
  assert.doesNotMatch(source, /ipcMain\.(handle|on)\("[^"]+"/);
});

test("desktop client loads shared engine contract before feature code", () => {
  const rendererHtml = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");

  assert.match(rendererHtml, /<script src="\.\.\/shared\/engine-contracts\.js"><\/script>[\s\S]*<script src="\.\/settings\/engine-options\.js"><\/script>/);
});
