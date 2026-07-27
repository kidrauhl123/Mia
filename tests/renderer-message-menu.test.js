const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function mockMenu() {
  const buttons = [];
  return {
    buttons,
    classList: { toggle() {} },
    style: {},
    getBoundingClientRect: () => ({ width: 140, height: 210 }),
    set innerHTML(value) {
      this._html = String(value || "");
      buttons.length = 0;
      for (const match of this._html.matchAll(/data-message-action="([^"]+)"/g)) {
        buttons.push({
          dataset: { messageAction: match[1] },
          addEventListener(_event, handler) { this.handler = handler; }
        });
      }
    },
    get innerHTML() {
      return this._html || "";
    },
    querySelectorAll(selector) {
      return selector === "[data-message-action]" ? buttons : [];
    }
  };
}

function loadMessageMenu() {
  const menu = mockMenu();
  const message = { content: "[文档](https://example.com/docs)", pinned: false };
  const state = {
    messageContextMenu: {
      open: false,
      x: 0,
      y: 0,
      messageIndex: -1,
      selectionText: "",
      linkTarget: ""
    }
  };
  let copied = "";
  const mockWindow = {
    innerWidth: 900,
    innerHeight: 700,
    miaLottieIcons: { init() {} }
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    console
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src", "renderer", "chat", "message-menu.js"), "utf8"), context, {
    filename: "src/renderer/chat/message-menu.js"
  });
  mockWindow.miaMessageMenu.initMessageMenu({
    state,
    els: { messageContextMenu: menu },
    mia: {},
    messageAtIndex: (index) => index === 0 ? message : null,
    messageReferenceForIndex: () => null,
    messageContextText: (target, selectionText) => selectionText || target.content,
    menuItemHtml: ({ label, attrs }) => `<button type="button" ${attrs || ""}>${label}</button>`,
    renderChat() {},
    renderSessionMenu() {},
    renderComposerReply() {},
    escapeHtml: (value) => String(value || ""),
    renderMarkdown: (value) => String(value || ""),
    copyTextToClipboard: async (text) => { copied = text; },
    nowIso: () => "2026-07-27T00:00:00.000Z",
    cryptoRandomId: () => "id"
  });
  return { api: mockWindow.miaMessageMenu, menu, copied: () => copied };
}

test("local message link menu copies the link target", async () => {
  const { api, menu, copied } = loadMessageMenu();
  const linkTarget = "https://example.com/docs?mode=raw#copy";

  api.openMessageContextMenu(0, 100, 100, null, linkTarget);
  const copyLinkButton = menu.buttons.find((button) => button.dataset.messageAction === "copy-link");
  assert.ok(copyLinkButton, "copy link action should be rendered");
  assert.match(menu.innerHTML, /复制链接/);

  await copyLinkButton.handler();

  assert.equal(copied(), linkTarget);
});

test("local message menu hides the link action outside a link", () => {
  const { api, menu } = loadMessageMenu();

  api.openMessageContextMenu(0, 100, 100);

  assert.equal(menu.buttons.some((button) => button.dataset.messageAction === "copy-link"), false);
});
