const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function mockEl() {
  return {
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    style: {},
    innerHTMLWrites: 0,
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return mockEl(); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return ""; },
    set innerHTML(value) {
      this.innerHTMLWrites += 1;
      this._html = String(value || "");
      this.children = [];
    },
    get innerHTML() { return this._html || ""; },
    set textContent(value) { this._text = String(value || ""); },
    get textContent() { return this._text || ""; }
  };
}

function coreCapabilityOptions({ capabilities = {}, summary = "未设置默认技能", enabled = [], addable = [] } = {}) {
  return {
    ok: true,
    data: {
      capabilities,
      summary,
      groups: [
        {
          id: "enabled-skills",
          label: "已启用技能",
          kind: "skill",
          options: enabled.map((item) => ({ ...item, checked: true }))
        },
        {
          id: "addable-skills",
          label: "添加技能",
          kind: "skill",
          options: addable.map((item) => ({ ...item, checked: false }))
        }
      ]
    }
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function latestContactPatch(patches, predicate) {
  return [...patches].reverse().find(predicate);
}

function loadBotManager(options = {}) {
  const source = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const timers = [];
  const contactPatches = [];
  const mockWindow = {
    mia: options.mia || {},
    miaBotCommands: options.miaBotCommands || {},
    miaSocial: { moduleState: { bots: [] }, pendingRequestCount: () => 0 },
    miaBotDirectory: {
      listOwnedBots: ({ identityBots }) => identityBots,
      normalizeAgentEngine: (value) => {
        const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
        return ["hermes", "claude-code", "codex"].includes(id) ? id : "hermes";
      },
      normalizeRuntimeKind: (value, fallback = "desktop-local") => {
        const kind = String(value || fallback || "desktop-local").trim();
        return kind === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
      },
      runtimeLabelFor: () => ""
    },
    miaMarkdown: {
      escapeHtml: (value) => String(value || ""),
      iconParkIcon: () => ""
    },
    miaBotIdentity: require(path.join(root, "packages/shared/bot-identity.js")),
    miaSkillHelpers: {
      skillDisplayName: (skill) => ({
        "document-editor": "文档编辑",
        "lab-report": "实验报告",
        "meeting-notes": "会议纪要",
        "spreadsheet-organizer": "表格整理",
        "xlsx": "Excel 文件"
      }[skill.name] || skill.name_zh || skill.name || skill.title || "Skill")
    },
    miaAvatar: { applyAvatarMedia() {} },
    miaContact: {
      IdentityKind: { Bot: "bot" },
      botAvatarIdentityId: (id) => id,
      resolveContact: (_query, ctx) => ({
        avatar: {
          image: "",
          crop: null,
          color: "#5e5ce6",
          text: String(ctx.bots?.[0]?.name || "?").slice(0, 2)
        }
      })
    },
    miaAvatarResolve: {
      resolveAvatarForContact: () => ({ image: "", crop: null, color: "#5e5ce6", text: "?" })
    },
    miaReactContacts: {
      publish(patch) { contactPatches.push(patch); }
    },
    setTimeout: (fn, delay = 0) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout: () => {}
  };
  const context = vm.createContext({
    window: mockWindow,
    document: { createElement: () => mockEl() },
    console,
    Intl,
    String,
    Number,
    Boolean,
    Array,
    Set,
  });
  vm.runInContext(source, context);
  return { manager: mockWindow.miaBotManager, window: mockWindow, timers, contactPatches };
}

test("sidebar conversation sorting uses lastMessageAt instead of metadata updatedAt", () => {
  const { manager } = loadBotManager();
  const rows = manager.sortMessageCardsForSidebar([
    { key: "old-message", lastMessageAt: Date.parse("2026-01-01T10:00:00.000Z"), updatedAt: Date.parse("2026-01-01T12:00:00.000Z") },
    { key: "new-message", lastMessageAt: Date.parse("2026-01-01T11:00:00.000Z"), updatedAt: Date.parse("2026-01-01T09:00:00.000Z") }
  ]);

  assert.deepEqual(rows.map((row) => row.key), ["new-message", "old-message"]);
});

test("sidebar conversation sorting keeps pinned rows first and places empty conversations above messaged rows", () => {
  const { manager } = loadBotManager();
  const rows = manager.sortMessageCardsForSidebar([
    { key: "older-message", lastMessageAt: Date.parse("2026-01-01T10:00:00.000Z") },
    { key: "empty-first", lastMessageAt: null },
    { key: "newer-message", lastMessageAt: Date.parse("2026-01-01T11:00:00.000Z") },
    { key: "pinned", pinned: true, pinnedAt: Date.parse("2026-01-01T09:00:00.000Z"), lastMessageAt: null },
    { key: "empty-second", lastMessageAt: "" }
  ]);

  assert.deepEqual(rows.map((row) => row.key), [
    "pinned",
    "empty-first",
    "empty-second",
    "newer-message",
    "older-message"
  ]);
});

test("renderContacts publishes bot contacts by alphabetical initial", () => {
  const { manager, window, contactPatches } = loadBotManager();
  const contactList = mockEl();
  const contactDetail = mockEl();
  const state = {
    skillsLoading: true,
    skillLibrary: { extensions: [], skills: [] },
    runtime: {},
    contactFilter: "",
    activeContactKey: "",
    savingBotCapabilities: new Set()
  };
  window.miaSocial.moduleState.bots = [
    { key: "zeta", name: "Zeta" },
    { key: "kong", name: "空铃" },
    { key: "beta", name: "Beta", pinned: true, pinnedAt: "2099-01-01T00:00:00.000Z" },
    { key: "alpha", name: "Alpha" },
    { key: "ha", name: "哈哈哈" }
  ];

  manager.initBotManager({
    state,
    els: { contactList, contactDetail, contactPageTitle: mockEl(), contactPageMeta: mockEl() },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {},
  });

  manager.renderContacts();

  const list = latestContactPatch(contactPatches, (patch) => Array.isArray(patch.groups));
  const rendered = list.groups.flatMap((group) => [
    `header:${group.label}`,
    ...group.rows.map((row) => row.name)
  ]);
  assert.deepEqual(Array.from(rendered), [
    "header:A",
    "Alpha",
    "header:B",
    "Beta",
    "header:H",
    "哈哈哈",
    "header:K",
    "空铃",
    "header:Z",
    "Zeta"
  ]);
  assert.equal(state.activeContactKey, "alpha");
});

test("renderContacts keeps stable React row keys for status badge lotties", () => {
  const { manager, window, contactPatches } = loadBotManager();
  const contactList = mockEl();
  const contactDetail = mockEl();
  const state = {
    skillsLoading: true,
    skillLibrary: { extensions: [], skills: [] },
    runtime: {},
    contactFilter: "",
    activeContactKey: "alpha",
    savingBotCapabilities: new Set()
  };
  window.miaSocial.moduleState.bots = [
    {
      key: "alpha",
      id: "alpha",
      name: "Alpha",
      statusBadge: { kind: "lottie", assetId: "blue-fire" }
    }
  ];

  manager.initBotManager({
    state,
    els: { contactList, contactDetail, contactPageTitle: mockEl(), contactPageMeta: mockEl() },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {},
  });

  manager.renderContacts();
  const firstList = latestContactPatch(contactPatches, (patch) => Array.isArray(patch.groups));
  manager.renderContacts();
  const secondList = latestContactPatch(contactPatches, (patch) => Array.isArray(patch.groups));

  const firstRow = firstList.groups[0].rows[0];
  const secondRow = secondList.groups[0].rows[0];
  assert.equal(firstRow.key, "alpha");
  assert.equal(secondRow.key, firstRow.key, "React keeps the row mounted by its stable key");
  assert.deepEqual(secondRow.badge, { kind: "lottie", assetId: "blue-fire" });
});

test("contact detail exposes the contact uid", () => {
  const { manager, window, contactPatches } = loadBotManager();
  const contactList = mockEl();
  const contactDetail = mockEl();
  const state = {
    skillsLoading: true,
    skillLibrary: { extensions: [], skills: [] },
    runtime: {},
    contactFilter: "",
    activeContactKey: "review-bot",
    savingBotCapabilities: new Set()
  };
  window.miaSocial.moduleState.bots = [
    {
      key: "review-bot",
      id: "review-bot",
      name: "复习搭子",
      ownerUserId: "8123456789",
      canConfigureCapabilities: false
    }
  ];

  manager.initBotManager({
    state,
    els: { contactList, contactDetail, contactPageTitle: mockEl(), contactPageMeta: mockEl() },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {},
  });

  manager.renderContacts();

  const detail = latestContactPatch(contactPatches, (patch) => patch.detail?.kind === "bot");
  assert.equal(detail.detail.bot.uid, "review-bot");
  assert.equal(detail.detail.bot.key, "review-bot");
});

test("contact detail publishes normalized Core capability options", async () => {
  const { manager, window, contactPatches } = loadBotManager({
    mia: {
      social: {
        getBotCapabilityOptions: async () => coreCapabilityOptions({
          capabilities: { inheritEngineDefaults: false, enabledSkills: ["mia-official:document-editor"], disabledSkills: [] },
          summary: "1 个默认技能",
          enabled: [{ id: "mia-official:document-editor", capabilityId: "mia-official:document-editor", label: "文档编辑", source: "mia-official" }],
          addable: [{ id: "mia-official:lab-report", capabilityId: "mia-official:lab-report", label: "实验报告", source: "mia-official" }]
        })
      }
    }
  });
  const contactList = mockEl();
  const contactDetail = mockEl();
  const contactPageMeta = mockEl();
  const state = {
    skillsLoading: true,
    skillLibrary: {
      extensions: [],
      skills: [
        { id: "mia-official:document-editor", label: "document-editor", sourceLabel: "Mia 官方库" },
        { id: "mia-official:lab-report", label: "lab-report", sourceLabel: "Mia 官方库" }
      ]
    },
    runtime: {},
    contactFilter: "",
    activeContactKey: "spreadsheet-bot",
    savingBotCapabilities: new Set(),
    openCapabilityPanelKeys: new Set(["spreadsheet-bot"])
  };
  const bot = {
    key: "spreadsheet-bot",
    id: "spreadsheet-bot",
    name: "表格整理师",
    agentEngine: "hermes",
    capabilities: { enabledSkills: ["mia-official:document-editor"], disabledSkills: [] }
  };
  window.miaSocial.moduleState.bots = [bot];

  manager.initBotManager({
    state,
    els: { contactList, contactDetail, contactPageTitle: mockEl(), contactPageMeta },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {},
  });

  manager.renderContactDetail(bot);
  await flushAsyncWork();
  manager.renderContactDetail(bot);

  const detail = latestContactPatch(contactPatches, (patch) => patch.detail?.kind === "bot");
  assert.deepEqual(
    detail.detail.bot.capabilities.enabled.map((option) => ({ label: option.label, originLabel: option.originLabel })),
    [{ label: "文档编辑", originLabel: "" }]
  );
  assert.deepEqual(
    detail.detail.bot.capabilities.addable.map((option) => option.label),
    ["实验报告"]
  );
});

test("contact detail publishes preset defaults from Core capability options", async () => {
  const { manager, window, contactPatches } = loadBotManager({
    mia: {
      social: {
        getBotCapabilityOptions: async () => coreCapabilityOptions({
          capabilities: {
            inheritEngineDefaults: false,
            enabledSkills: ["mia-official:spreadsheet-organizer", "mia-official:xlsx"],
            disabledSkills: []
          },
          summary: "2 个默认技能",
          enabled: [
            { id: "mia-official:spreadsheet-organizer", capabilityId: "mia-official:spreadsheet-organizer", label: "表格整理", source: "mia-official", origin: "assistant-preset", inherited: true },
            { id: "mia-official:xlsx", capabilityId: "mia-official:xlsx", label: "Excel 文件", source: "mia-official", origin: "system-default", inherited: true }
          ],
          addable: [{ id: "mia-official:lab-report", capabilityId: "mia-official:lab-report", label: "实验报告", source: "mia-official" }]
        })
      }
    }
  });
  const contactList = mockEl();
  const contactDetail = mockEl();
  const contactPageMeta = mockEl();
  const state = {
    skillsLoading: false,
    skillLibrary: {
      extensions: [],
      botPresets: [
        {
          key: "spreadsheet-organizer",
          name: "表格整理师",
          capabilities: {
            enabledSkills: ["mia-official:spreadsheet-organizer", "mia-official:xlsx"]
          }
        }
      ],
      skills: [
        { id: "mia-official:spreadsheet-organizer", name: "spreadsheet-organizer", sourceLabel: "Mia 官方库" },
        { id: "mia-official:xlsx", name: "xlsx", sourceLabel: "Mia 官方库" },
        { id: "mia-official:lab-report", name: "lab-report", sourceLabel: "Mia 官方库" }
      ]
    },
    runtime: {},
    contactFilter: "",
    activeContactKey: "spreadsheet-organizer",
    savingBotCapabilities: new Set(),
    openCapabilityPanelKeys: new Set(["spreadsheet-organizer"])
  };
  const bot = {
    key: "spreadsheet-organizer",
    id: "spreadsheet-organizer",
    name: "表格整理师",
    agentEngine: "hermes",
    capabilities: { inheritEngineDefaults: true, enabledSkills: [], disabledSkills: [] }
  };
  window.miaSocial.moduleState.bots = [bot];

  manager.initBotManager({
    state,
    els: { contactList, contactDetail, contactPageTitle: mockEl(), contactPageMeta },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {},
  });

  manager.renderContactDetail(bot);
  await flushAsyncWork();

  const detail = latestContactPatch(contactPatches, (patch) => patch.detail?.kind === "bot");
  assert.equal(detail.detail.bot.capabilities.summary, "2 个默认技能");
  assert.deepEqual(
    detail.detail.bot.capabilities.enabled.map((option) => [option.label, option.originLabel]),
    [["表格整理", "助手预设"], ["Excel 文件", "系统默认"]]
  );
  assert.deepEqual(detail.detail.bot.capabilities.addable.map((option) => option.label), ["实验报告"]);
});

test("contact runtime target panel renders Core-owned target options", async () => {
  const calls = [];
  const { manager, window, contactPatches } = loadBotManager({
    mia: {
      social: {
        getBotRuntimeTargetOptions: async (input) => {
          calls.push(input);
          return {
            ok: true,
            data: {
              runtimeLabel: "本机运行",
              runsOnOtherDevice: false,
              groups: [{
                id: "mac-local",
                label: "本机",
                statusLabel: "本机",
                runtimeKind: "desktop-local",
                options: [{
                  id: "desktop-local:mac-local:codex",
                  runtimeKind: "desktop-local",
                  deviceId: "mac-local",
                  deviceName: "本机",
                  agentEngine: "codex",
                  label: "Codex",
                  engineLabel: "Codex",
                  iconKind: "codex",
                  title: "本机 · Codex",
                  selected: true,
                  disabled: false
                }]
              }]
            }
          };
        }
      }
    }
  });
  const contactList = mockEl();
  const contactDetail = mockEl();
  const contactPageMeta = mockEl();
  const state = {
    skillsLoading: true,
    skillLibrary: { extensions: [], skills: [] },
    runtime: {
      localDevice: { id: "mac-local", name: "Studio Mac" },
      agentInventory: { agents: [{ id: "codex", usableInMia: true }] }
    },
    engineCapabilities: { engines: { codex: { available: true } } },
    preferredAgentEngine: "codex",
    contactFilter: "",
    activeContactKey: "codex-bot",
    savingBotCapabilities: new Set(),
    savingBotRuntimeTargets: new Set()
  };
  const bot = {
    key: "codex-bot",
    id: "codex-bot",
    name: "Codex",
    runtimeKind: "desktop-local",
    agentEngine: "codex"
  };
  window.miaSocial.moduleState.bots = [bot];

  manager.initBotManager({
    state,
    els: { contactList, contactDetail, contactPageTitle: mockEl(), contactPageMeta },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {},
  });

  manager.renderContactDetail(bot);
  const pendingDetail = latestContactPatch(contactPatches, (patch) => patch.detail?.kind === "bot");
  assert.deepEqual(Array.from(pendingDetail.detail.bot.runtime.groups), []);
  await flushAsyncWork();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bot.key, "codex-bot");
  assert.equal(calls[0].runtime.agentInventory.agents[0].id, "codex");
  assert.equal(contactPageMeta.textContent, "本机运行");
  const detail = latestContactPatch(contactPatches, (patch) => patch.detail?.kind === "bot");
  assert.deepEqual(Array.from(detail.detail.bot.runtime.groups, (group) => ({
    label: group.label,
    options: Array.from(group.options, (option) => [option.engineKind, option.label, option.selected])
  })), [{ label: "本机", options: [["codex", "Codex", true]] }]);
});

test("contact runtime target selection prepares detected Codex before saving", async () => {
  const order = [];
  const { manager, window, contactPatches } = loadBotManager({
    mia: {
      installEngine: async (engineId) => {
        order.push(`install:${engineId}`);
        return { prepared: true };
      },
      scanAgents: async () => order.push("scan"),
      runtimeStatus: async () => {
        order.push("status");
        return { prepared: true };
      },
      social: {
        getBotRuntimeTargetOptions: async () => ({
          ok: true,
          data: {
            runtimeLabel: "本机运行",
            runsOnOtherDevice: false,
            groups: [{
              id: "mac-local",
              label: "本机",
              statusLabel: "本机",
              runtimeKind: "desktop-local",
              options: [
                {
                  runtimeKind: "desktop-local",
                  deviceId: "mac-local",
                  deviceName: "本机",
                  agentEngine: "hermes",
                  label: "Hermes",
                  selected: true,
                  disabled: false
                },
                {
                  runtimeKind: "desktop-local",
                  deviceId: "mac-local",
                  deviceName: "本机",
                  agentEngine: "codex",
                  label: "Codex",
                  selected: false,
                  disabled: false,
                  setupAction: "install-codex"
                }
              ]
            }]
          }
        })
      }
    },
    miaBotCommands: {
      saveBotRuntimeTarget: async ({ agentEngine }) => {
        order.push(`save:${agentEngine}`);
        return {};
      }
    }
  });
  const state = {
    skillsLoading: true,
    skillLibrary: { extensions: [], skills: [] },
    runtime: { localDevice: { id: "mac-local", name: "Studio Mac" } },
    contactFilter: "",
    activeContactKey: "runtime-bot",
    savingBotCapabilities: new Set(),
    savingBotRuntimeTargets: new Set()
  };
  const bot = {
    key: "runtime-bot",
    id: "runtime-bot",
    name: "Runtime Bot",
    runtimeKind: "desktop-local",
    agentEngine: "hermes"
  };
  window.miaSocial.moduleState.bots = [bot];
  manager.initBotManager({
    state,
    els: { contactList: mockEl(), contactDetail: mockEl(), contactPageTitle: mockEl(), contactPageMeta: mockEl() },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {}
  });

  manager.renderContactDetail(bot);
  await flushAsyncWork();
  const detail = latestContactPatch(contactPatches, (patch) => patch.detail?.kind === "bot");
  await detail.detail.bot.runtime.groups[0].options[1].select();

  assert.deepEqual(order, ["install:codex", "scan", "status", "save:codex"]);
});

test("other-device grouping uses the persisted bot target before Core options load", () => {
  const { manager } = loadBotManager();
  const state = {
    runtime: {
      localDevice: { id: "win-local", name: "Windows PC" },
      cloud: { deviceId: "win-local" }
    }
  };
  manager.initBotManager({ state });

  assert.equal(manager.botRunsOnOtherDevice({
    key: "remote-codex",
    runtimeKind: "desktop-local",
    targetDeviceId: "mac-remote"
  }), true);
  assert.equal(manager.botRunsOnOtherDevice({
    key: "local-codex",
    runtimeKind: "desktop-local",
    targetDeviceId: "win-local"
  }), false);
  assert.equal(manager.botRunsOnOtherDevice({
    key: "cloud-mia",
    runtimeKind: "cloud-claude-code",
    targetDeviceId: "mac-remote"
  }), false);
});

test("a stale bridge id with the current Mac name still belongs to this device", () => {
  const { manager } = loadBotManager();
  const state = {
    runtime: {
      localDevice: { id: "air-current", name: "jungdeMacBook-Air-9" },
      cloud: { deviceId: "air-current", deviceName: "jungdeMacBook-Air-9" }
    }
  };
  manager.initBotManager({ state });

  assert.equal(manager.botRunsOnOtherDevice({
    key: "stale-local-hermes",
    runtimeKind: "desktop-local",
    targetDeviceId: "air-retired",
    targetDeviceName: "jungdeMacBook-Air-9 · Mia Desktop"
  }), false);
});

test("other-device conversation groups expose device name, status, and stable order", () => {
  const { manager } = loadBotManager();
  const state = {
    runtime: {
      localDevice: { id: "win-local", name: "Windows PC" },
      cloud: {
        deviceId: "win-local",
        devices: [
          {
            id: "mac-remote",
            deviceName: "Studio Mac · Mia Desktop",
            status: "online",
            capabilities: { platform: "darwin" }
          },
          {
            id: "office-pc",
            deviceName: "Office PC",
            status: "offline",
            capabilities: { platform: "win32" }
          }
        ]
      }
    }
  };
  manager.initBotManager({ state });

  const online = manager.botDeviceGroup({
    key: "remote-codex",
    runtimeKind: "desktop-local",
    targetDeviceId: "mac-remote",
    targetDeviceName: "Old Mac name"
  });
  assert.equal(online.key, "device-name:studio mac");
  assert.equal(online.label, "Studio Mac");
  assert.equal(online.meta, "在线");
  assert.equal(online.status, "online");
  assert.equal(online.platform, "macos");
  assert.equal(online.order, 100);

  const offline = manager.botDeviceGroup({
    key: "remote-hermes",
    runtimeKind: "desktop-local",
    targetDeviceId: "retired-device",
    targetDeviceName: "Home Mac · 离线"
  });
  assert.equal(offline.key, "device-name:home mac");
  assert.equal(offline.label, "Home Mac");
  assert.equal(offline.meta, "离线");
  assert.equal(offline.status, "offline");
  assert.equal(offline.platform, "");
  assert.equal(offline.order, 700);
});

test("device grouping infers Windows and macOS logos for old device records", () => {
  const { manager } = loadBotManager();
  const state = {
    runtime: {
      localDevice: { id: "current", name: "Current Mac" },
      cloud: { deviceId: "current", devices: [] }
    }
  };
  manager.initBotManager({ state });

  assert.equal(manager.botDeviceGroup({
    runtimeKind: "desktop-local",
    targetDeviceId: "windows-old",
    targetDeviceName: "LAPTOP-944FKKVR"
  }).platform, "windows");
  assert.equal(manager.botDeviceGroup({
    runtimeKind: "desktop-local",
    targetDeviceId: "mac-old",
    targetDeviceName: "zuiyoudeMacBook-Pro-2"
  }).platform, "macos");
});

test("reconnected device ids share one conversation group by stable device name", () => {
  const { manager } = loadBotManager();
  const state = {
    runtime: {
      localDevice: { id: "win-local", name: "Windows PC" },
      cloud: {
        deviceId: "win-local",
        devices: [
          { id: "air-current", deviceName: "jungdeMacBook-Air-9 · Mia Desktop", status: "online" }
        ]
      }
    }
  };
  manager.initBotManager({ state });

  const staleBinding = manager.botDeviceGroup({
    key: "old-hermes",
    runtimeKind: "desktop-local",
    targetDeviceId: "air-retired",
    targetDeviceName: "jungdeMacBook-Air-9"
  });
  const currentBinding = manager.botDeviceGroup({
    key: "new-hermes",
    runtimeKind: "desktop-local",
    targetDeviceId: "air-current",
    targetDeviceName: "jungdeMacBook-Air-9"
  });

  assert.equal(staleBinding.key, currentBinding.key);
});

test("device refresh keeps cached bot placement until refreshed options arrive", async () => {
  let targetOptionsCalls = 0;
  let resolveRefreshedOptions;
  const refreshedOptions = new Promise((resolve) => { resolveRefreshedOptions = resolve; });
  const { manager, window } = loadBotManager({
    mia: {
      social: {
        getBotRuntimeTargetOptions: async () => {
          targetOptionsCalls += 1;
          if (targetOptionsCalls === 1) {
            return { data: { runtimeLabel: "Remote Mac · 在线", runsOnOtherDevice: true, groups: [] } };
          }
          return refreshedOptions;
        },
        listBridgeDevices: async () => ({ data: { devices: [{ id: "mac-remote", status: "online" }] } })
      }
    }
  });
  const contactDetail = mockEl();
  const state = {
    skillsLoading: true,
    skillLibrary: { extensions: [], skills: [] },
    runtime: {
      localDevice: { id: "win-local", name: "Windows PC" },
      cloud: { enabled: false, deviceId: "win-local", devices: [] }
    },
    contactFilter: "",
    activeContactKey: "remote-codex",
    savingBotCapabilities: new Set(),
    savingBotRuntimeTargets: new Set()
  };
  const bot = {
    key: "remote-codex",
    id: "remote-codex",
    name: "Remote Codex",
    runtimeKind: "desktop-local",
    targetDeviceId: "mac-remote",
    targetDeviceName: "Remote Mac"
  };
  window.miaSocial.moduleState.bots = [bot];
  manager.initBotManager({
    state,
    els: { contactList: mockEl(), contactDetail, contactPageTitle: mockEl(), contactPageMeta: mockEl() },
    setText(el, value) { if (el) el.textContent = value; },
    loadSkills: async () => {},
    showNarrowContent() {},
    render() {},
    closeGroupContextMenu() {},
    openEditBotDialog() {},
    deleteBot() {},
    setBotPinned() {}
  });

  manager.renderContactDetail(bot);
  await flushAsyncWork();
  assert.equal(state.botRuntimeTargetOptions.get(bot.key).runtimeLabel, "Remote Mac · 在线");

  state.runtime.cloud.enabled = true;
  manager.renderContactDetail(bot);
  await flushAsyncWork();
  assert.equal(targetOptionsCalls, 2);
  assert.equal(state.botRuntimeTargetOptions.get(bot.key).runtimeLabel, "Remote Mac · 在线");
  assert.equal(manager.botRunsOnOtherDevice(bot), true);

  resolveRefreshedOptions({ data: { runtimeLabel: "Remote Mac · 离线", runsOnOtherDevice: true, groups: [] } });
  await flushAsyncWork();
  assert.equal(state.botRuntimeTargetOptions.get(bot.key).runtimeLabel, "Remote Mac · 离线");
});
