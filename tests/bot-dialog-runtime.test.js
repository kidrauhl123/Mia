const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

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

function createBotDialogContext({ activeBinding }) {
  const select = new FakeSelect();
  const calls = [];
  const state = {
    runtime: {
      cloud: {
        enabled: true,
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
    }
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
          return value === "cloud-hermes" || value === "desktop-local" ? value : fallback;
        },
        normalizeAgentEngine(value, runtimeKind = "desktop-local") {
          if (runtimeKind === "cloud-hermes") return "hermes";
          const id = String(value || "hermes").trim();
          return id === "claude-code" || id === "codex" || id === "openclaw" ? id : "hermes";
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
      mia: { social: { listBridgeDevices: null } }
    },
    document,
    console
  });
  const source = fs.readFileSync(path.join(root, "src/renderer/bot/bot-dialog.js"), "utf8");
  vm.runInContext(source, context, { filename: "src/renderer/bot/bot-dialog.js" });
  context.window.miaBotDialog.initBotDialog({
    state,
    els,
    renderView() {},
    render() {}
  });
  return { context, calls };
}

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
    runtimeKind: "cloud-hermes",
    agentEngine: "hermes"
  }, "persona");
  assert.equal(context.window.miaBotDialog.readSelectedRuntimeTarget().runtimeKind, "cloud-hermes");

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
