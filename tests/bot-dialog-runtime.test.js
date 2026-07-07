const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const cloudRuntime = require("../src/shared/cloud-runtime.js");
const CLOUD_AGENT_RUNTIME = {
  mode: "claude-code",
  runtimeKind: "cloud-claude-code",
  agentEngine: "claude-code",
  label: "Claude Code",
  available: true
};

class FakeOption {
  constructor() {
    this.tagName = "OPTION";
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.selected = false;
  }

  get label() {
    return this.textContent;
  }
}

class FakeOptGroup {
  constructor() {
    this.tagName = "OPTGROUP";
    this.label = "";
    this.children = [];
    this.disabled = false;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

class FakeSelect {
  constructor() {
    this.children = [];
    this._value = "";
  }

  set innerHTML(_value) {
    this.children = [];
    this._value = "";
  }

  get innerHTML() {
    return "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  get options() {
    return this.children.flatMap((child) => child.tagName === "OPTGROUP" ? child.children : [child]);
  }

  set value(value) {
    this._value = String(value || "");
    for (const option of this.options) option.selected = option.value === this._value;
  }

  get value() {
    return this._value;
  }
}

function input(value = "") {
  return { value, textContent: "", open: false };
}

function createBotDialogContext({ activeBinding, runtime = null, engineCapabilities = null, listBridgeDevices = null } = {}) {
  const select = new FakeSelect();
  const calls = [];
  const events = [];
  const defaultRuntime = {
    cloud: {
      enabled: true,
      agentRuntime: CLOUD_AGENT_RUNTIME,
      devices: [{
        id: "mac-1",
        deviceName: "Office Mac",
        status: "online",
        capabilities: { engines: ["hermes", "claude-code"] }
      }]
    },
    localDevice: { id: "mac-1", name: "Office Mac" },
    agentEngines: {
      hermes: { available: true },
      claudeCode: { available: true }
    },
    preferredAgentEngine: "hermes"
  };
  const state = {
    runtime: runtime || defaultRuntime,
    engineCapabilities
  };
  const els = {
    botRuntimeTarget: select,
    botName: input(),
    botNameText: input(),
    botKey: input(),
    botStatusBadge: input(),
    botDialogTitle: input(),
    botSeed: input(),
    botPersonaDetails: { open: false },
    botAvatar: input()
  };
  const document = {
    createElement(tag) {
      if (tag === "optgroup") return new FakeOptGroup();
      if (tag === "option") return new FakeOption();
      throw new Error(`unexpected element ${tag}`);
    },
    getElementById() {
      return null;
    }
  };
  const context = vm.createContext({
    window: {
      miaAvatar: {
        canonicalAvatarSrc: (value) => String(value || ""),
        normalizeCrop: (crop) => crop || null,
        avatarCropForImage: (_image, crop) => crop || null,
        avatarDefaultCropForSrc: () => ({ x: 50, y: 50, zoom: 1 }),
        applyAvatarMedia() {}
      },
      miaAvatarResolve: {
        resolveAvatarForContact: () => ({ image: "", crop: null, color: "", text: "B" })
      },
      miaBotDirectory: {
        normalizeRuntimeKind(value, fallback = "desktop-local") {
          return value === "cloud-claude-code" || value === "desktop-local" ? value : fallback;
        },
        normalizeAgentEngine(value, runtimeKind = "desktop-local") {
          if (runtimeKind === "cloud-claude-code") return cloudRuntime.cloudAgentRuntimeFromCloud(state.runtime.cloud).agentEngine;
          const id = String(value || "hermes").trim();
          return id === "claude-code" || id === "codex" ? id : "hermes";
        },
        isCloudIdentityBot(bot) {
          return Array.isArray(bot?.sourceKinds) && bot.sourceKinds.includes("cloud");
        }
      },
      miaBotCommands: {
        async getBotRuntimeBinding(args) {
          calls.push(args);
          return activeBinding;
        }
      },
      miaStatusBadgeControls: {
        statusBadgePresetValue: () => "",
        syncIdentityNameText() {},
        syncStatusBadgeControl() {},
        beginIdentityNameEdit() {},
        endIdentityNameEdit() {}
      },
      miaContact: {
        botAvatarIdentityId: (key) => key
      },
      miaEngineContracts: {
        engineLabel(engine) {
          return {
            hermes: "Hermes",
            "claude-code": "Claude Code",
            codex: "Codex"
          }[engine] || engine;
        }
      },
      miaCloudRuntime: cloudRuntime,
      mia: {
        social: {
          listBridgeDevices: listBridgeDevices
            ? (...args) => {
                events.push("listBridgeDevices");
                return listBridgeDevices(...args);
              }
            : null
        }
      }
    },
    document,
    console,
    setTimeout,
    clearTimeout
  });
  const source = fs.readFileSync(path.join(root, "src/renderer/bot/bot-dialog.js"), "utf8");
  vm.runInContext(source, context, { filename: "src/renderer/bot/bot-dialog.js" });
  context.window.miaBotDialog.initBotDialog({
    state,
    els,
    renderView() { events.push("renderView"); },
    render() {}
  });
  return { context, calls, events, state, select, els };
}

function decodedRuntimeOptions(select) {
  return select.options.map((option) => ({
    label: option.textContent,
    disabled: option.disabled,
    ...JSON.parse(option.value)
  }));
}

test("creating a bot exposes only Mia Cloud and local engines", () => {
  const { context, select } = createBotDialogContext({
    runtime: {
      cloud: {
        enabled: true,
        agentRuntime: CLOUD_AGENT_RUNTIME,
        devices: [{
          id: "mac-remote",
          deviceName: "Studio Mac",
          status: "online",
          capabilities: { engines: ["codex"] }
        }]
      },
      localDevice: { id: "mac-local", name: "Work Mac" },
      agentEngines: {
        hermes: { available: true },
        claudeCode: { available: true },
        codex: { available: true }
      },
      preferredAgentEngine: "codex"
    }
  });

  context.window.miaBotDialog.openBotDialog();

  const options = decodedRuntimeOptions(select);
  assert.ok(options.some((option) => option.runtimeKind === "cloud-claude-code"), "Mia Cloud should be available");
  assert.deepEqual(
    options
      .filter((option) => option.deviceId === "mac-local")
      .map((option) => option.agentEngine)
      .sort(),
    ["claude-code", "codex", "hermes"]
  );
  assert.equal(options.some((option) => option.deviceId === "mac-remote"), false);
});

test("creating a bot keeps local runtime options before device ids load", () => {
  const { context, select } = createBotDialogContext({
    runtime: {
      cloud: { enabled: false, devices: [] },
      agentEngines: {},
      preferredAgentEngine: "hermes"
    }
  });

  context.window.miaBotDialog.openBotDialog();

  assert.deepEqual(decodedRuntimeOptions(select), [{
    label: "Hermes",
    disabled: false,
    runtimeKind: "desktop-local",
    deviceId: "current-device",
    deviceName: "本机",
    agentEngine: "hermes"
  }]);
});

test("creating a bot uses normalized local agent inventory for engine choices", () => {
  const { context, select } = createBotDialogContext({
    runtime: {
      cloud: { enabled: false, devices: [] },
      localDevice: { id: "win-local", name: "Windows PC" },
      agentEngines: {
        hermes: { available: true }
      },
      agentInventory: {
        agents: [
          { id: "hermes", usableInMia: true },
          { id: "claude-code", usableInMia: true },
          { id: "codex", usableInMia: true }
        ]
      },
      preferredAgentEngine: "hermes"
    }
  });

  context.window.miaBotDialog.openBotDialog();

  assert.deepEqual(
    decodedRuntimeOptions(select)
      .filter((option) => option.deviceId === "win-local")
      .map((option) => option.agentEngine),
    ["hermes", "claude-code", "codex"]
  );
});

test("creating a bot keeps local engine choices while agent scan is still running", () => {
  const { context, select } = createBotDialogContext({
    runtime: {
      cloud: { enabled: false, devices: [] },
      localDevice: { id: "win-local", name: "Windows PC" },
      agentEngines: {},
      agentInventory: {
        summary: { scanning: true },
        agents: [
          { id: "hermes", health: "checking", source: "checking", usableInMia: false },
          { id: "claude-code", health: "checking", source: "checking", usableInMia: false },
          { id: "codex", health: "checking", source: "checking", usableInMia: false }
        ]
      },
      preferredAgentEngine: "hermes"
    }
  });

  context.window.miaBotDialog.openBotDialog();

  assert.deepEqual(
    decodedRuntimeOptions(select)
      .filter((option) => option.deviceId === "win-local")
      .map((option) => option.agentEngine),
    ["hermes", "claude-code", "codex"]
  );
});

test("creating a bot paints the dialog before refreshing bridge devices", async () => {
  const { context, events } = createBotDialogContext({
    listBridgeDevices: async () => ({ ok: true, data: { devices: [] } })
  });

  context.window.miaBotDialog.openBotDialog();

  assert.deepEqual(events, ["renderView"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events[1], "listBridgeDevices");
});

test("opening create after editing a bot clears the previous bot fields", () => {
  const { context, els } = createBotDialogContext();

  context.window.miaBotDialog.openBotDialog({
    key: "codex",
    name: "Codex",
    sourceKinds: ["cloud"],
    runtimeKind: "desktop-local",
    agentEngine: "codex"
  }, "你是 Codex。专注代码阅读、修改、调试、测试和工程自动化，先理解上下文再行动。");

  context.window.miaBotDialog.openBotDialog();

  assert.equal(els.botDialogTitle.textContent, "添加伙伴");
  assert.equal(els.botKey.value, "");
  assert.equal(els.botName.value, "");
  assert.equal(els.botSeed.value, "");
  assert.equal(els.botPersonaDetails.open, false);
});

test("opening an existing id-only bot edits it instead of treating it as a create seed", () => {
  const { context, els, state } = createBotDialogContext();

  context.window.miaBotDialog.openBotDialog({
    id: "4020623",
    name: "？？",
    sourceKinds: ["cloud"],
    runtimeKind: "cloud-claude-code",
    agentEngine: "hermes"
  }, "你是 Claude Code。");

  assert.equal(state.botDialogMode, "edit");
  assert.equal(els.botDialogTitle.textContent, "编辑「？？」");
  assert.equal(els.botKey.value, "4020623");
  assert.equal(els.botName.value, "？？");
  assert.equal(els.botSeed.value, "你是 Claude Code。");
});

test("closing an edited bot dialog clears hidden form fields", () => {
  const { context, els } = createBotDialogContext();

  context.window.miaBotDialog.openBotDialog({
    key: "codex",
    name: "Codex",
    sourceKinds: ["cloud"],
    runtimeKind: "desktop-local",
    agentEngine: "codex"
  }, "你是 Codex。专注代码阅读、修改、调试、测试和工程自动化，先理解上下文再行动。");

  context.window.miaBotDialog.closeBotDialog();

  assert.equal(els.botKey.value, "");
  assert.equal(els.botName.value, "");
  assert.equal(els.botNameText.textContent, "");
  assert.equal(els.botSeed.value, "");
  assert.equal(els.botPersonaDetails.open, false);
});

test("creating a bot supplements local engines from loaded engine capabilities", () => {
  const { context, select } = createBotDialogContext({
    runtime: {
      cloud: { enabled: true, agentRuntime: CLOUD_AGENT_RUNTIME, devices: [] },
      localDevice: { id: "mac-local", name: "Work Mac" },
      agentEngines: {
        hermes: { available: true }
      },
      preferredAgentEngine: "hermes"
    },
    engineCapabilities: {
      engines: {
        "claude-code": { available: true },
        codex: { available: true }
      }
    }
  });

  context.window.miaBotDialog.openBotDialog();

  assert.deepEqual(
    decodedRuntimeOptions(select)
      .filter((option) => option.deviceId === "mac-local")
      .map((option) => option.agentEngine)
      .sort(),
    ["claude-code", "codex", "hermes"]
  );
});

test("editing a bot hydrates the runtime target from the active binding", async () => {
  const { context, calls } = createBotDialogContext({
    activeBinding: {
      botId: "bot_writer",
      runtimeKind: "desktop-local",
      enabled: true,
      config: {
        agentEngine: "claude-code",
        deviceId: "mac-1",
        deviceName: "Office Mac"
      }
    }
  });

  context.window.miaBotDialog.openBotDialog({
    key: "bot_writer",
    name: "写作助手",
    sourceKinds: ["cloud"],
    runtimeKind: "cloud-claude-code",
    agentEngine: "hermes"
  }, "persona");
  assert.equal(context.window.miaBotDialog.readSelectedRuntimeTarget().runtimeKind, "cloud-claude-code");

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls[0].botKey, "bot_writer");
  assert.equal(calls[0].runtimeKind, "active");
  const selected = JSON.parse(JSON.stringify(context.window.miaBotDialog.readSelectedRuntimeTarget()));
  assert.deepEqual(selected, {
    runtimeKind: "desktop-local",
    targetDeviceId: "mac-1",
    targetDeviceName: "本机",
    agentEngine: "claude-code"
  });
});

test("editing a bot keeps a stale device id instead of resolving bridge aliases", async () => {
  const { context } = createBotDialogContext({
    runtime: {
      cloud: {
        enabled: true,
        devices: [{
          id: "mac-1",
          aliases: ["stale-device-id"],
          deviceName: "Office Mac",
          status: "online",
          capabilities: { engines: ["hermes", "claude-code"] }
        }]
      },
      localDevice: { id: "mac-1", name: "Office Mac" },
      agentEngines: {
        hermes: { available: true },
        claudeCode: { available: true }
      },
      preferredAgentEngine: "hermes"
    },
    activeBinding: {
      botId: "bot_writer",
      runtimeKind: "desktop-local",
      enabled: true,
      config: {
        agentEngine: "claude-code",
        deviceId: "stale-device-id",
        deviceName: "Old Mac"
      }
    }
  });

  context.window.miaBotDialog.openBotDialog({
    key: "bot_writer",
    name: "写作助手",
    sourceKinds: ["cloud"],
    runtimeKind: "cloud-claude-code",
    agentEngine: "hermes"
  }, "persona");

  await new Promise((resolve) => setTimeout(resolve, 0));

  const selected = JSON.parse(JSON.stringify(context.window.miaBotDialog.readSelectedRuntimeTarget()));
  assert.equal(selected.targetDeviceId, "stale-device-id");
});
