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
  assert.deepEqual(plain(browserContract.IpcChannel), plain(nodeContract.IpcChannel));
});

test("engine contract normalizes aliases and exposes shared labels", () => {
  const nodeContract = require("../src/shared/engine-contracts");
  const browserContract = loadBrowserGlobal("src/shared/engine-contracts.js", "miaEngineContracts");

  assert.equal(nodeContract.EngineId.Hermes, "hermes");
  assert.equal(nodeContract.EngineId.ClaudeCode, "claude-code");
  assert.equal(nodeContract.EngineId.Codex, "codex");
  assert.equal(nodeContract.normalizeAgentEngine("claude"), "claude-code");
  assert.equal(nodeContract.normalizeAgentEngine("openai_codex"), "codex");
  assert.equal(nodeContract.normalizeAgentEngine("unknown"), "hermes");
  assert.equal(nodeContract.engineLabel("claude-code"), "Claude Code");
  assert.deepEqual(plain(browserContract.EngineId), plain(nodeContract.EngineId));
  assert.equal(browserContract.normalizeAgentEngine("openai-codex"), "codex");
});

test("engine contract owns external model and mode options for browser clients", () => {
  const contract = require("../src/shared/engine-contracts");

  assert.equal(contract.isExternalEngine("claude-code"), true);
  assert.equal(contract.isExternalEngine("codex"), true);
  assert.equal(contract.isExternalEngine("hermes"), false);
  assert.equal(contract.externalModelEntries("claude-code")[0].provider, "claude-code");
  assert.deepEqual(
    contract.externalModelEntries("codex", { codexModels: [{ slug: "gpt-test", displayName: "GPT Test" }] }),
    [
      { id: "default", provider: "codex", providerLabel: "Codex CLI", model: "", label: "Codex 默认" },
      { id: "gpt-test", provider: "codex", providerLabel: "Codex CLI", model: "gpt-test", label: "GPT Test" }
    ]
  );
  assert.equal(contract.externalPermissionOptions("claude-code").find((item) => item.value === "plan").label, "Plan Mode");
  assert.equal(contract.externalPermissionOptions("codex").find((item) => item.value === "readOnly").label, "Read");
  assert.deepEqual(contract.effortOptions("codex").map((item) => item.value), ["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(
    contract.effortOptions("hermes", { effortLevels: ["low", "high"], effortLabels: { high: "High" } }),
    [{ value: "low", label: "low" }, { value: "high", label: "High" }]
  );
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

test("desktop and mobile clients load shared engine contract before feature code", () => {
  const rendererHtml = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const mobileHtml = fs.readFileSync(path.join(root, "src/mobile/index.html"), "utf8");
  const daemonControlSource = fs.readFileSync(path.join(root, "src/main/daemon/control-server.js"), "utf8");
  const relaySource = fs.readFileSync(path.join(root, "src/relay/server.js"), "utf8");

  assert.match(rendererHtml, /<script src="\.\.\/shared\/engine-contracts\.js"><\/script>[\s\S]*<script src="\.\/settings\/engine-options\.js"><\/script>/);
  assert.match(mobileHtml, /<script src="\/shared\/engine-contracts\.js"><\/script>[\s\S]*<script src="\/mobile\/app\.js/);
  assert.match(daemonControlSource, /\/shared\/engine-contracts\.js/);
  assert.match(relaySource, /\/shared\/engine-contracts\.js/);
});
