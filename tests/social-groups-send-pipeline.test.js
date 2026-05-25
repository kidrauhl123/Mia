const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadSocialGroups() {
  const delegated = [];
  const mockEl = () => ({
    className: "",
    _html: "",
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html; },
  });
  const mockWindow = {
    aimashi: {
      social: {
        postRoomMessage: async () => {
          throw new Error("social-groups must not post room messages directly");
        },
      },
    },
    aimashiSocial: {
      sendInActiveRoom: async (text) => delegated.push(text),
      _internalCtx: {
        moduleState: {
          activeRoomId: "g_1",
          myUserId: "u_me",
          messageCache: new Map([["g_1", { messages: [], maxSeq: 0 }]]),
          friends: []
        },
        deps: null,
        roomMembersCache: new Map(),
        escapeHtml: (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
        renderMsgBody: (v) => String(v || ""),
        renderSendStatus: (msg) => msg.status === "error"
          ? `<span class="message-send-status is-error" title="${String(msg.error || "")}">发送失败</span>`
          : "",
      },
    },
    aimashiConversationKinds: require("../src/shared/conversation-kinds.js"),
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
  return { groups: mockWindow.aimashiSocialGroups, delegated };
}

test("sendInActiveGroupRoom delegates to the unified social send path", async () => {
  const { groups, delegated } = loadSocialGroups();

  await groups.sendInActiveGroupRoom("hello group");

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
