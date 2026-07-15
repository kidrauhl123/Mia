const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadSocialGroups(options = {}) {
  const delegated = [];
  const renderCalls = [];
  const elementsById = new Map();
  const mockEl = (tag = "div") => ({
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    type: "",
    value: "",
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    _html: "",
    _text: "",
    classList: {
      add() {},
      remove() {},
      contains() { return false; }
    },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    addEventListener() {},
    removeEventListener() {},
    closest() { return this; },
    querySelector(selector) {
      if (selector === ".group-create-member-row") {
        return this.children.find((child) => child.className === "group-create-member-row") || null;
      }
      return null;
    },
    focus() {},
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html; },
    set textContent(value) { this._text = value; },
    get textContent() { return this._text; },
  });
  const documentMock = {
    createElement: (tag) => mockEl(tag),
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, mockEl("div"));
      return elementsById.get(id);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  documentMock.getElementById("groupCreateName").value = "";
  const mockWindow = {
    setTimeout: options.setTimeout || ((fn) => fn()),
    mia: {
      social: {
        postConversationMessage: async () => {
          throw new Error("social-groups must not post conversation messages directly");
        },
      },
    },
    miaSocial: {
      sendInActiveConversation: async (text) => delegated.push(text),
      _internalCtx: {
        moduleState: {
          activeConversationId: "g_1",
          myUserId: "u_me",
          messageCache: new Map([["g_1", { messages: [], maxSeq: 0 }]]),
          friends: [],
          ...(options.moduleState || {})
        },
        deps: options.deps || { render: () => renderCalls.push("render") },
        conversationMembersCache: new Map(),
        escapeHtml: (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
        renderMsgBody: (v) => String(v || ""),
        renderSendStatus: (msg) => msg.status === "error"
          ? `<span class="message-send-status is-error" title="${String(msg.error || "")}">发送失败</span>`
          : "",
      },
    },
    miaConversationKinds: require("../src/shared/conversation-kinds.js"),
    miaMemberColor: require("../src/shared/member-color.js"),
    miaAvatar: {
      paintAvatar(el, avatar) {
        el._avatar = avatar;
      }
    },
    miaAvatarResolve: {
      resolveAvatarForContact(contact) {
        return { color: contact.color || "#888", image: contact.avatarImage || "", crop: contact.avatarCrop || null, text: String(contact.displayName || "?").slice(0, 2) };
      }
    },
    miaTraceBlocks: {
      renderTraceBlocks({ reasoning, tools }) {
        return `<div class="trace"><span>${String(reasoning || "")}</span>${(tools || []).map((tool) => `<span>${tool.name}</span>`).join("")}</div>`;
      }
    },
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: documentMock,
    console,
    Map,
    Set,
    setTimeout: (fn) => fn(),
    Date,
    JSON,
    String,
    Array,
    Object,
    Boolean,
    Promise,
    require,
  });
  const src = fs.readFileSync(path.join(ROOT, "src/renderer/social/social-groups.js"), "utf8");
  vm.runInContext(src, context);
  return { groups: mockWindow.miaSocialGroups, delegated, renderCalls, mockWindow, documentMock };
}

test("sendInActiveGroupConversation delegates to the unified social send path", async () => {
  const { groups, delegated } = loadSocialGroups();

  await groups.sendInActiveGroupConversation("hello group");

  assert.deepEqual(delegated, ["hello group"]);
});

test("buildGroupMessageArticle renders failed outgoing status from shared helper", () => {
  const { groups } = loadSocialGroups();

  const article = groups.buildGroupMessageArticle({
    id: "local_1",
    sender_kind: "user",
    sender_ref: "u_me",
    body_md: "hello failed",
    status: "error",
    error: "network down"
  }, "#5e5ce6", []);

  assert.match(article.innerHTML, /message-send-status is-error/);
  assert.match(article.innerHTML, /发送失败/);
  assert.match(article.innerHTML, /title="network down"/);
});

test("buildGroupMessageArticle renders persisted bot trace_json", () => {
  const { groups } = loadSocialGroups();

  const article = groups.buildGroupMessageArticle({
    id: "m_trace",
    sender_kind: "bot",
    sender_ref: "codex",
    body_md: "done",
    trace_json: JSON.stringify({
      reasoning: "分析需求",
      tools: [{ name: "search", status: "completed" }]
    })
  }, "#5e5ce6", []);

  assert.match(article.innerHTML, /trace/);
  assert.match(article.innerHTML, /分析需求/);
  assert.match(article.innerHTML, /search/);
});

test("fetchAndCacheConversationMembers rerenders after sidebar member cache fills", async () => {
  const { groups, renderCalls, mockWindow } = loadSocialGroups();
  mockWindow.mia.social.getConversation = async (conversationId) => ({
    ok: true,
    data: {
      members: [
        { member_kind: "user", member_ref: "u_me", identity: { displayName: "我", avatar: { image: "", crop: null } } },
        { member_kind: "bot", member_ref: "kongling", bot_name: "空铃" }
      ],
      conversation: { id: conversationId }
    }
  });

  await groups.fetchAndCacheConversationMembers("g_1");

  assert.equal(mockWindow.miaSocial._internalCtx.conversationMembersCache.get("g_1").length, 2);
  assert.deepEqual(renderCalls, ["render"]);
});

test("fetchAndCacheConversationMembers cools down failed lookups", async () => {
  const { groups, mockWindow } = loadSocialGroups();
  let calls = 0;
  mockWindow.mia.social.getConversation = async () => {
    calls += 1;
    throw new Error("Mia Core HTTP GET /api/conversations/g_missing failed 404: Not Found");
  };

  await groups.fetchAndCacheConversationMembers("g_missing");
  await groups.fetchAndCacheConversationMembers("g_missing");

  assert.equal(calls, 1);
});

test("openCreateGroupDialog shows friend display names instead of WeChat hash usernames", () => {
  const { groups, documentMock } = loadSocialGroups({
    moduleState: {
      friends: [{
        id: "u_friend",
        username: "wx_dab93e8a6744",
        account: "wx_dab93e8a6744",
        displayName: "Jung"
      }]
    }
  });

  groups.openCreateGroupDialog();

  const membersBox = documentMock.getElementById("groupCreateMembers");
  const row = membersBox.children.find((child) => child.className === "group-create-member-row");
  const nameEl = row.children.find((child) => child.className === "member-name");
  assert.equal(nameEl.innerHTML, "Jung");
  assert.doesNotMatch(nameEl.innerHTML, /wx_dab93e8a6744/);
});
