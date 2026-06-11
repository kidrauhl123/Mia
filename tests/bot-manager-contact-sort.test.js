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
    style: {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return mockEl(); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return ""; },
    set innerHTML(value) { this._html = String(value || ""); this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(value) { this._text = String(value || ""); },
    get textContent() { return this._text || ""; }
  };
}

function loadBotManager() {
  const source = fs.readFileSync(path.join(root, "src/renderer/bot/bot-manager.js"), "utf8");
  const mockWindow = {
    mia: {},
    miaSocial: { moduleState: { bots: [] }, pendingRequestCount: () => 0 },
    miaBotDirectory: {
      listOwnedBots: ({ cloudBots }) => cloudBots,
      runtimeLabelFor: () => ""
    },
    miaMarkdown: {
      escapeHtml: (value) => String(value || ""),
      iconParkIcon: () => ""
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
    }
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
  return { manager: mockWindow.miaBotManager, window: mockWindow };
}

test("renderContacts groups bot contacts by alphabetical initial", () => {
  const { manager, window } = loadBotManager();
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

  const rendered = contactList.children.map((child) => {
    if (child.className === "contact-group-header") return `header:${child.textContent}`;
    return child.innerHTML.match(/<strong>([^<]+)<\/strong>/)?.[1];
  });
  assert.deepEqual(rendered, [
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

test("contact detail exposes the contact uid", () => {
  const { manager, window } = loadBotManager();
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

  assert.match(contactDetail.innerHTML, /class="contact-profile-uid"/);
  assert.match(contactDetail.innerHTML, />UID</);
  assert.match(contactDetail.innerHTML, /review-bot/);
});
