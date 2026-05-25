const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Renders the cloud-room fellow contact card in a mock DOM so we can assert the
// ownership decision: a fellow whose room-member owner_id is NOT me must render
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
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
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
  const window = {
    miaConversationKinds: { MemberKind: { Fellow: "fellow", User: "user" } },
    innerWidth: 1000,
    innerHeight: 800,
  };
  const ctx = vm.createContext({ window, globalThis: window, document, console, setTimeout });
  vm.runInContext(src, ctx);
  return { card: window.miaContactCard, body };
}

function ctxWith(ownerId, meId) {
  return {
    deps: {
      getState: () => ({
        runtime: {
          fellows: [{ id: "codex", key: "codex", name: "My Codex", agentEngine: "codex", engineConfig: {} }],
          cloud: { user: { id: meId } },
        },
      }),
    },
    roomMembersCache: new Map([["g_1", [
      { member_kind: "fellow", member_ref: "codex", owner_id: ownerId, fellow_name: "Their Codex" },
    ]]]),
    moduleState: { friends: [] },
  };
}

function lastCardHtml(body) {
  return body.children[body.children.length - 1].innerHTML;
}

test("fellow owned by another user renders remote-only card despite same local key", () => {
  const { card, body } = loadCard();
  card.attach(ctxWith("alice", "bob"));
  card.openCard({ kind: "fellow", ref: "codex", roomId: "g_1", anchor: null });
  const html = lastCardHtml(body);
  assert.match(html, /不在你的本地 fellow 列表里/);
  assert.doesNotMatch(html, /data-fellow-field/);
  assert.doesNotMatch(html, /edit-fellow/);
});

test("fellow I own renders editable controls card", () => {
  const { card, body } = loadCard();
  card.attach(ctxWith("bob", "bob"));
  card.openCard({ kind: "fellow", ref: "codex", roomId: "g_1", anchor: null });
  const html = lastCardHtml(body);
  assert.doesNotMatch(html, /不在你的本地 fellow 列表里/);
  assert.match(html, /edit-fellow/);
});
