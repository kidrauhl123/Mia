const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Renders the cloud-conversation bot contact card in a mock DOM so we can assert the
// ownership decision: a bot whose conversation-member owner_id is NOT me must render
// the read-only "remote" card even when one of MY cloud-owned bots happens to share
// its key — otherwise clicking another user's bot would expose and mutate my
// own bot model/effort/permission settings.

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
      if (!this._queries[selector]) this._queries[selector] = mockEl();
      return this._queries[selector];
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
          cloud: { user: { id: meId } },
        },
      }),
    },
    conversationMembersCache: new Map([["g_1", [
      { member_kind: "bot", member_ref: "codex", owner_id: ownerId, bot_name: "Their Codex" },
    ]]]),
    moduleState: {
      friends: [],
      bots: [{ id: "codex", key: "codex", name: "My Codex", agentEngine: "codex", engineConfig: {} }]
    },
    adapterCtx: () => ({
      bots: [{ id: "codex", key: "codex", name: "My Codex", agentEngine: "codex", engineConfig: {} }],
      friends: [],
      self: { id: meId }
    }),
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
      bots: [{ key: "mia", name: "Mia", runtimeKind: "cloud-claude-code", runtimeLabel: "Mia Cloud" }],
    },
    adapterCtx: () => ({
      bots: [{ key: "mia", name: "Mia", runtimeKind: "cloud-claude-code", runtimeLabel: "Mia Cloud", color: "#5e5ce6" }],
      friends: [],
      self: { id: "bob" },
    }),
  };
}

function lastCardHtml(body) {
  return body.children[body.children.length - 1].innerHTML;
}

test("bot owned by another user renders remote-only card despite same local key", () => {
  const { card, body } = loadCard();
  card.attach(ctxWith("alice", "bob"));
  card.openCard({ kind: "bot", ref: "codex", conversationId: "g_1", anchor: null });
  const html = lastCardHtml(body);
  assert.doesNotMatch(html, new RegExp("data-" + "fellow-field"));
  assert.doesNotMatch(html, /edit-bot-old/);
});

test("bot I own renders editable controls card", () => {
  const { card, body } = loadCard();
  card.attach(ctxWith("bob", "bob"));
  card.openCard({ kind: "bot", ref: "codex", conversationId: "g_1", anchor: null });
  const html = lastCardHtml(body);
  assert.match(html, /edit-bot/);
});

test("cloud bot I own renders editable controls instead of a separate cloud-only card", () => {
  const { card, body } = loadCard();
  card.attach(ctxWithCloudOwnedFellow());
  card.openCard({ kind: "bot", ref: "mia", conversationId: "botc_bob_mia", anchor: null });
  const html = lastCardHtml(body);
  assert.match(html, /Mia Cloud/);
  assert.match(html, /class="contact-card-controls"/);
  assert.doesNotMatch(html, /data-bot-field="model"/);
  assert.doesNotMatch(html, /使用 CLI 模型|CLI 默认/);
  assert.match(html, /data-card-action="edit-bot"/);
});

test("owned bot card hides runtime controls when Core returns no observed values", async () => {
  const { card, body, window } = loadCard();
  window.mia = {
    social: {
      getBotRuntimeControlOptions: async () => ({
        ok: true,
        data: {
          agentEngine: "codex",
          statusText: "Codex",
          modelOptions: [],
          effortOptions: [],
          permissionOptions: []
        }
      })
    }
  };

  card.attach(ctxWith("bob", "bob"));
  card.openCard({ kind: "bot", ref: "codex", conversationId: "g_1", anchor: null });
  await Promise.resolve();
  await Promise.resolve();

  const cardEl = body.children.at(-1);
  const controlsHtml = cardEl._queries[".contact-card-controls"]?.innerHTML || cardEl.innerHTML;
  assert.doesNotMatch(controlsHtml, /data-bot-field="model"/);
  assert.doesNotMatch(controlsHtml, /data-bot-field="effortLevel"/);
  assert.doesNotMatch(controlsHtml, /data-bot-field="permissionMode"/);
  assert.doesNotMatch(controlsHtml, /使用 CLI 模型|CLI 默认/);
});

test("cloud bot card avatar preserves the bot explicit color", () => {
  const { card, window } = loadCard();
  card.attach(ctxWithCloudOwnedFellow());
  card.openCard({ kind: "bot", ref: "mia", conversationId: "botc_bob_mia", anchor: null });

  assert.equal(window.lastAvatarResolveInput.id, "mia");
  assert.equal(window.lastPaintedAvatar.color, "#5e5ce6");
});

test("owned cloud bot card reads runtime binding and omits managed permission controls", async () => {
  const { card, body, window } = loadCard();
  const calls = { bindings: [], options: [] };
  window.miaBotCommands = {
    getBotRuntimeBinding: async (args) => {
      calls.bindings.push(args);
      return {
        botId: "mia",
        runtimeKind: "cloud-claude-code",
        config: { model: "gpt-5.3", effortLevel: "high", permissionMode: "auto" }
      };
    }
  };
  window.mia = {
    social: {
      getBotRuntimeControlOptions: async (input) => {
        calls.options.push(input);
        return {
          ok: true,
          data: {
            agentEngine: "claude-code",
            statusText: "Mia Cloud",
            modelOptions: [{ id: "gpt-5.3", label: "GPT-5.3", model: "gpt-5.3", provider: "mia" }],
            selectedModel: "gpt-5.3",
            selectedModelEntry: { id: "gpt-5.3", label: "GPT-5.3", model: "gpt-5.3", provider: "mia" },
            effortOptions: [{ value: "high", label: "High" }],
            selectedEffort: "high",
            permissionOptions: [{ value: "auto", label: "Auto" }],
            selectedPermission: "auto"
          }
        };
      }
    }
  };

  card.attach(ctxWithCloudOwnedFellow());
  card.openCard({ kind: "bot", ref: "mia", conversationId: "botc_bob_mia", anchor: null });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.bindings.length, 1);
  assert.equal(calls.bindings[0].botKey, "mia");
  assert.equal(calls.bindings[0].runtimeKind, "cloud-claude-code");
  assert.equal(calls.options.length >= 1, true);
  const latestOptionsRequest = calls.options.at(-1);
  assert.equal(latestOptionsRequest.runtimeKind, "cloud-claude-code");
  assert.equal(latestOptionsRequest.bot.key, "mia");
  assert.match(JSON.stringify(latestOptionsRequest), /modelCatalog/);
  assert.doesNotMatch(JSON.stringify(latestOptionsRequest), /modelOptionsByEngine/);
  assert.doesNotMatch(JSON.stringify(latestOptionsRequest), /effortOptionsByEngine/);
  assert.doesNotMatch(JSON.stringify(latestOptionsRequest), /permissionOptionsByEngine/);
  const controlsHtml = body.children.at(-1)._queries[".contact-card-controls"].innerHTML;
  assert.match(controlsHtml, /data-bot-field="model"/);
  assert.match(controlsHtml, /GPT-5\.3/);
  assert.match(controlsHtml, /High/);
  assert.doesNotMatch(controlsHtml, /data-bot-field="permissionMode"/);
  assert.doesNotMatch(controlsHtml, /Auto/);
});

test("bot contact-card runtime edits go through bot command adapter", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "social", "contact-card.js"), "utf8");
  assert.match(source, /getBotRuntimeControlOptions/);
  assert.match(source, /global\.miaBotCommands\?\.saveBotRuntimeControl\?\.\(\{/);
  assert.doesNotMatch(source, /global\.mia\?\.savePermissions\?\.\(\{/);
  assert.doesNotMatch(source, /permissionSaveTarget/);
  assert.doesNotMatch(source, /field === "permissionMode" && isExternal/);
  assert.doesNotMatch(source, /currentModelEntry/);
  assert.doesNotMatch(source, /runtime\.permissions\?\.engines/);
  assert.doesNotMatch(source, new RegExp("global\\.mia\\?\\.social\\?\\.save" + "BotRuntime"));
  assert.doesNotMatch(source, /global\.mia\.saveModel\(/);
  assert.doesNotMatch(source, new RegExp("global\\.mia\\.save" + "FellowEngine\\("));
});
