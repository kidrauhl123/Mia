// Scroll-anchoring behavior for cloud-conversation (group / DM) chat rendering.
//
// Bug: renderConversationChat unconditionally forced `scrollTop = scrollHeight` on every
// paint, so any background re-render (read receipts, cloud-agent streaming,
// member/runtime refresh) yanked the user to the bottom — making it impossible
// to scroll up and read history in a group. The bot-chat path in app.js
// already guards on "was the user near the bottom?"; the cloud-conversation path didn't.
//
// Loads social.js into a vm sandbox with a mock DOM. The chat container is an
// argument to renderConversationChat, so its scroll metrics are fully controllable here.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function mockEl() {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    children: [],
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return ""; }, removeAttribute() {},
    closest() { return null; },
    remove() {},
    style: {},
    _html: "",
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set textContent(v) {}, get textContent() { return ""; },
    cloneNode() { return mockEl(); },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return el;
}

function scrollEl({ scrollTop, scrollHeight, clientHeight }) {
  const el = mockEl();
  el.scrollTop = scrollTop;
  el.scrollHeight = scrollHeight;
  el.clientHeight = clientHeight;
  return el;
}

function loadSocial() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "social", "social.js"), "utf8");
  let chatEl = mockEl();
  const groupArticles = [];
  const mockWindow = {
    mia: {},
    miaMarkdown: {
      escapeHtml: (v) => String(v || ""),
      renderMarkdown: (v) => String(v || ""),
    },
    miaSocialGroups: {
      fetchAndCacheConversationMembers() {},
      buildGroupMessageArticle(msg) {
        const article = mockEl();
        article.kind = "group-article";
        article.messageId = msg.id;
        groupArticles.push({ msg, article });
        return article;
      },
    },
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: {
      createElement: () => mockEl(),
      getElementById: (id) => (id === "chat" ? chatEl : mockEl()),
      querySelector: () => mockEl(),
      body: { appendChild() {} },
      addEventListener() {}, removeEventListener() {},
    },
    navigator: { clipboard: { writeText: async () => {} } },
    Map, Set, Date, JSON, Promise, console, String, Array, Object, Boolean, parseInt, Math,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  vm.runInContext(src, context);
  const social = mockWindow.miaSocial;
  social.moduleState.activeConversationId = "g_1";
  social.moduleState.conversations = [{ id: "g_1", type: "group", name: "G" }];
  social.moduleState.messageCache.set("g_1", { messages: [], maxSeq: 0 });
  return { social, groupArticles, setChat: (el) => { chatEl = el; } };
}

test("renderConversationChat preserves scroll position on a same-conversation re-render when scrolled up", () => {
  const { social } = loadSocial();
  // First paint of the conversation = entering it → lands at the bottom.
  social.renderConversationChat(scrollEl({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }));
  // User scrolls up to read history, then a background event re-renders.
  const c = scrollEl({ scrollTop: 120, scrollHeight: 1000, clientHeight: 400 });
  social.renderConversationChat(c);
  assert.equal(c.scrollTop, 120, "must not yank to bottom while reading history");
});

test("renderConversationChat follows to the bottom when the user is already near the bottom", () => {
  const { social } = loadSocial();
  social.renderConversationChat(scrollEl({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }));
  const c = scrollEl({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 }); // 10px from bottom
  social.renderConversationChat(c);
  assert.equal(c.scrollTop, 1000, "near-bottom users should keep following new content");
});

test("renderConversationChat reuses unchanged message DOM instead of rebuilding lottie badges", () => {
  const { social } = loadSocial();
  social.moduleState.messageCache.set("g_1", {
    maxSeq: 1,
    messages: [{ id: "m1", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "hi", created_at: "" }]
  });
  const c = scrollEl({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  social.renderConversationChat(c);
  const firstArticle = c.children[0];

  social.renderConversationChat(c);

  assert.equal(c.children[0], firstArticle, "unchanged re-render must keep the existing badge/lottie DOM");
});

test("renderConversationChat jumps to the bottom on conversation switch even if metrics say not-near-bottom", () => {
  const { social } = loadSocial();
  // Fresh module → first paint of g_1 is a switch; user metrics are far from bottom.
  const c = scrollEl({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
  social.renderConversationChat(c);
  assert.equal(c.scrollTop, 1000, "entering a conversation should show its latest messages");
});

test("re-entering a conversation after a detour through a local bot chat lands at the bottom", () => {
  const { social } = loadSocial();
  // Enter g_1 (first paint = switch → bottom).
  social.renderConversationChat(scrollEl({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }));
  // Detour to a local bot chat: app.js clears cloud-conversation mode via setActiveConversationId(null).
  social.setActiveConversationId(null);
  // Come back to the same conversation. The shared #chat may be scrolled up from the bot chat.
  social.setActiveConversationId("g_1");
  const c = scrollEl({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
  social.renderConversationChat(c);
  assert.equal(c.scrollTop, 1000, "re-entry must show latest, not restore an unrelated offset");
});

const incoming = { id: "m1", sender_kind: "user", sender_ref: "u_other", body_md: "hi", created_at: "" };

test("appendMessageToActiveChat does not yank a scrolled-up reader to the bottom (stick:false)", () => {
  const { social, setChat } = loadSocial();
  const chat = scrollEl({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }); // scrolled up
  setChat(chat);
  social._internalCtx.appendMessageToActiveChat(incoming, { stick: false });
  assert.equal(chat.scrollTop, 100, "an incoming message from someone else must not steal scroll");
});

test("appendMessageToActiveChat follows incoming messages when already near bottom", () => {
  const { social, setChat } = loadSocial();
  const chat = scrollEl({ scrollTop: 570, scrollHeight: 1000, clientHeight: 400 }); // 30px from bottom
  setChat(chat);
  social._internalCtx.appendMessageToActiveChat(incoming, { stick: false });
  assert.equal(chat.scrollTop, 1000, "near-bottom readers should see the incoming reply immediately");
});

test("appendMessageToActiveChat follows to bottom when stick:true (self-sent / near bottom)", () => {
  const { social, setChat } = loadSocial();
  const chat = scrollEl({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
  setChat(chat);
  social._internalCtx.appendMessageToActiveChat(incoming, { stick: true });
  assert.equal(chat.scrollTop, 1000, "your own message should jump to the bottom");
});

test("appendMessageToActiveChat uses group renderer for active group conversations", () => {
  const { social, groupArticles, setChat } = loadSocial();
  const chat = scrollEl({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
  setChat(chat);
  social._internalCtx.conversationMembersCache.set("g_1", [
    { member_kind: "user", member_ref: "u_other", username: "other" }
  ]);

  social._internalCtx.appendMessageToActiveChat(incoming, { stick: false });

  assert.equal(groupArticles.length, 1, "live group append must go through buildGroupMessageArticle");
  assert.equal(groupArticles[0].msg.id, "m1");
  assert.equal(chat.children[0].kind, "group-article");
});
