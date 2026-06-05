const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Renders the cloud-conversation fellow contact card in a mock DOM so we can assert the
// ownership decision: a fellow whose conversation-member owner_id is NOT me must render
// the read-only "remote" card even when one of MY local fellows happens to share
// its key — otherwise clicking another user's fellow would expose and mutate my
// own local model/effort/permission settings.

function mockEl() {
  return {
    tagName: "DIV",
    className: "",
    style: {},
    innerHTML: "",
    children: [],
    _queries: {},
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector(selector) {
      if (selector === ".contact-card-avatar") {
        if (!this._queries[selector]) this._queries[selector] = mockEl();
        return this._queries[selector];
      }
      return null;
    },
    remove() {},
    contains() { return false; },
    getBoundingClientRect() { return { right: 0, left: 0, top: 0, width: 100, height: 100 }; },
  };
}

function loadCard() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "social", "contact-card.js"), "utf8");
  const body = mockEl();
  const document = {
    body,
    createElement: () => mockEl(),
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
  };
  const sharedAvatar = require("../packages/shared/avatar.js");
  const window = {
    miaConversationKinds: { MemberKind: { Bot: "bot", Fellow: "fellow", User: "user" } },
    miaMemberColor: require("../src/shared/member-color.js"),
    miaAvatarResolve: {
      ...sharedAvatar,
      resolveAvatarForContact: (input) => {
        window.lastAvatarResolveInput = input;
        return sharedAvatar.resolveAvatarForContact(input);
      }
    },
    miaContact: require("../packages/shared/contact.js"),
    miaSessionHistory: require("../packages/shared/session-history.js"),
    miaAvatar: {
      paintAvatar: (el, avatar) => {
        el.paintedAvatar = avatar;
        window.lastPaintedAvatar = avatar;
      }
    },
    innerWidth: 1000,
    innerHeight: 800,
  };
  const ctx = vm.createContext({ window, globalThis: window, document, console, setTimeout });
  vm.runInContext(src, ctx);
  return { card: window.miaContactCard, body, window };
}

function ctxWith(ownerId, meId) {
  return {
    deps: {
      getState: () => ({
        runtime: {
          bots: [{ id: "codex", key: "codex", name: "My Codex", agentEngine: "codex", engineConfig: {} }],
          cloud: { user: { id: meId } },
        },
      }),
    },
    conversationMembersCache: new Map([["g_1", [
      { member_kind: "bot", member_ref: "codex", owner_id: ownerId, bot_name: "Their Codex" },
    ]]]),
    moduleState: { friends: [] },
  };
}

function ctxWithCloudOwnedFellow() {
  return {
    deps: {
      getState: () => ({
        runtime: {
          bots: [],
          cloud: { user: { id: "bob" } },
        },
      }),
    },
    conversationMembersCache: new Map(),
    moduleState: {
      myUserId: "bob",
      friends: [],
      bots: [{ key: "mia", name: "Mia", runtimeKind: "cloud-hermes", runtimeLabel: "Mia Cloud" }],
    },
    adapterCtx: () => ({
      bots: [{ key: "mia", name: "Mia", runtimeKind: "cloud-hermes", runtimeLabel: "Mia Cloud", color: "#5e5ce6" }],
      friends: [],
      self: { id: "bob" },
    }),
  };
}

function lastCardHtml(body) {
  return body.children[body.children.length - 1].innerHTML;
}

test("fellow owned by another user renders remote-only card despite same local key", () => {
  const { card, body } = loadCard();
  card.attach(ctxWith("alice", "bob"));
  card.openCard({ kind: "bot", ref: "codex", conversationId: "g_1", anchor: null });
  const html = lastCardHtml(body);
  assert.match(html, /不属于你/);
  assert.doesNotMatch(html, /本地 fellow/);
  assert.doesNotMatch(html, /data-fellow-field/);
  assert.doesNotMatch(html, /edit-fellow/);
});

test("fellow I own renders editable controls card", () => {
  const { card, body } = loadCard();
  card.attach(ctxWith("bob", "bob"));
  card.openCard({ kind: "bot", ref: "codex", conversationId: "g_1", anchor: null });
  const html = lastCardHtml(body);
  assert.doesNotMatch(html, /不在你的本地 fellow 列表里/);
  assert.match(html, /edit-fellow/);
});

test("cloud fellow I own renders editable controls instead of a separate cloud-only card", () => {
  const { card, body } = loadCard();
  card.attach(ctxWithCloudOwnedFellow());
  card.openCard({ kind: "bot", ref: "mia", conversationId: "botc_bob_mia", anchor: null });
  const html = lastCardHtml(body);
  assert.doesNotMatch(html, /不在你的本地 fellow 列表里/);
  assert.match(html, /Mia Cloud/);
  assert.match(html, /data-fellow-field="model"/);
  assert.match(html, /data-card-action="edit-fellow"/);
});

test("cloud fellow card avatar uses the global fellow identity color", () => {
  const { card, window } = loadCard();
  card.attach(ctxWithCloudOwnedFellow());
  card.openCard({ kind: "bot", ref: "mia", conversationId: "botc_bob_mia", anchor: null });

  assert.equal(window.lastAvatarResolveInput.id, "botc_bob_mia");
  assert.equal(window.lastPaintedAvatar.color, window.miaMemberColor.memberAccentColor("botc_bob_mia"));
});

test("owned cloud fellow card reads runtime binding before exposing controls", () => {
  const { card, window } = loadCard();
  const calls = [];
  window.miaFellowCommands = {
    getFellowRuntimeBinding: async (args) => {
      calls.push(args);
      return {
        botId: "mia",
        runtimeKind: "cloud-hermes",
        config: { model: "gpt-5.3", effortLevel: "high", permissionMode: "auto" }
      };
    }
  };

  card.attach(ctxWithCloudOwnedFellow());
  card.openCard({ kind: "bot", ref: "mia", conversationId: "botc_bob_mia", anchor: null });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fellowKey, "mia");
  assert.equal(calls[0].runtimeKind, "cloud-hermes");
});

test("fellow contact-card runtime edits go through fellow command adapter", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "social", "contact-card.js"), "utf8");
  assert.match(source, /global\.miaFellowCommands\?\.saveFellowRuntimeControl\?\.\(\{/);
  assert.doesNotMatch(source, /global\.mia\?\.social\?\.saveFellowRuntime/);
  assert.doesNotMatch(source, /global\.mia\.saveModel\(/);
  assert.doesNotMatch(source, /global\.mia\.saveFellowEngine\(/);
});
