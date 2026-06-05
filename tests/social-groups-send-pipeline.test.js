const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadSocialGroups(options = {}) {
  const delegated = [];
  const renderCalls = [];
  const mockEl = () => ({
    className: "",
    _html: "",
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html; },
  });
  const mockWindow = {
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
          friends: []
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
    miaTraceBlocks: {
      renderTraceBlocks({ reasoning, tools }) {
        return `<div class="trace"><span>${String(reasoning || "")}</span>${(tools || []).map((tool) => `<span>${tool.name}</span>`).join("")}</div>`;
      }
    },
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: { createElement: () => mockEl() },
    console,
    Map,
    Set,
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
  return { groups: mockWindow.miaSocialGroups, delegated, renderCalls, mockWindow };
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
