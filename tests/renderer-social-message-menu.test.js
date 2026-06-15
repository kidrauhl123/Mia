const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function mockMenu() {
  const buttons = [];
  return {
    buttons,
    classList: { add() {}, remove() {} },
    style: {},
    contains: () => false,
    getBoundingClientRect: () => ({ width: 140, height: 180 }),
    set innerHTML(value) {
      this._html = String(value || "");
      buttons.length = 0;
      for (const match of this._html.matchAll(/data-social-message-action="([^"]+)"/g)) {
        buttons.push({
          dataset: { socialMessageAction: match[1] },
          addEventListener(_event, handler) { this.handler = handler; }
        });
      }
    },
    get innerHTML() {
      return this._html || "";
    },
    querySelectorAll(selector) {
      return selector === "[data-social-message-action]" ? buttons : [];
    }
  };
}

function loadSocialMessageMenu() {
  const menu = mockMenu();
  let copied = "";
  const mockWindow = {
    innerWidth: 900,
    innerHeight: 700,
    miaMarkdown: {
      escapeHtml: (value) => String(value || ""),
      menuItemHtml: ({ label, attrs }) => `<button type="button" ${attrs || ""}>${label}</button>`
    },
    miaSocial: {
      getActiveConversationId: () => "botc_sess_1",
      describeMessageForMenu: () => ({ authorName: "论文搭子", isOwn: false, bodyMd: "整条消息文本" })
    },
    miaMessageMenu: { closeMessageContextMenu() {} },
    miaLottieIcons: { init() {} }
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: {
      getElementById: () => menu,
      addEventListener() {},
      removeEventListener() {}
    },
    navigator: { clipboard: { writeText: async (text) => { copied = text; } } },
    setTimeout: (fn) => { fn(); return 0; },
    console
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src", "renderer", "social", "social-message-menu.js"), "utf8"), context, {
    filename: "src/renderer/social/social-message-menu.js"
  });
  return { api: mockWindow.miaSocialMessageMenu, menu, copied: () => copied };
}

test("cloud message menu copies selected text instead of the whole bubble", async () => {
  const { api, menu, copied } = loadSocialMessageMenu();

  api.openSocialMessageMenu({ id: "m_1", body_md: "整条消息文本" }, 100, 100, { text: "选中的一段" });
  const copyButton = menu.buttons.find((button) => button.dataset.socialMessageAction === "copy");
  assert.ok(copyButton, "copy action should be rendered");
  assert.match(menu.innerHTML, /拷贝选中/);

  await copyButton.handler();

  assert.equal(copied(), "选中的一段");
});
