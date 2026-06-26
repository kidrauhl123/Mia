const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("loadEngineCapabilities refreshes an open bot runtime selector", async () => {
  const refreshes = [];
  let renderCalls = 0;
  const context = vm.createContext({
    window: {
      mia: {
        loadEngineCapabilities: async () => ({
          approvalModes: ["ask"],
          effortLevels: ["low"],
          engines: {
            codex: { available: true, models: [{ model: "gpt-test" }] },
            "claude-code": { available: true }
          }
        })
      },
      miaBotDialog: {
        readSelectedRuntimeTarget: () => ({
          runtimeKind: "desktop-local",
          targetDeviceId: "mac-local",
          targetDeviceName: "Work Mac",
          agentEngine: "hermes"
        }),
        renderBotRuntimeTargetSelect: (target, options) => refreshes.push({ target, options })
      }
    },
    console
  });
  const source = fs.readFileSync(path.join(root, "src/renderer/loaders.js"), "utf8");
  vm.runInContext(source, context, { filename: "src/renderer/loaders.js" });

  const state = {
    botDialogOpen: true,
    runtime: {
      localDevice: { id: "mac-local", name: "Work Mac" },
      agentEngines: { hermes: { available: true } }
    }
  };
  context.window.miaLoaders.initLoaders({
    state,
    render: () => { renderCalls += 1; },
    fallbackSlashCommands: []
  });

  await context.window.miaLoaders.loadEngineCapabilities();

  assert.equal(renderCalls, 1);
  assert.equal(state.codexModels[0].model, "gpt-test");
  assert.equal(state.engineCapabilities.engines.codex.available, true);
  assert.deepEqual(JSON.parse(JSON.stringify(refreshes)), [{
    target: {
      runtimeKind: "desktop-local",
      deviceId: "mac-local",
      deviceName: "Work Mac",
      agentEngine: "hermes"
    },
    options: { preservePrevious: true }
  }]);
});
