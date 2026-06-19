const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function menuElement() {
  return {
    innerHTML: "",
    classList: { toggle() {} },
    querySelectorAll: () => []
  };
}

function mockInput(value = "", selectionStart = value.length, selectionEnd = selectionStart) {
  return {
    value,
    selectionStart,
    selectionEnd,
    focused: false,
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    focus() {
      this.focused = true;
    }
  };
}

function mockClassList() {
  const values = new Set();
  return {
    values,
    toggle(name, force) {
      const shouldAdd = force === undefined ? !values.has(name) : Boolean(force);
      if (shouldAdd) values.add(name);
      else values.delete(name);
      return shouldAdd;
    },
    contains(name) {
      return values.has(name);
    }
  };
}

function loadComposer({ clipboardText = "", nativeClipboardText = null, includeNavigatorClipboard = true } = {}) {
  const source = fs.readFileSync(path.join(root, "src/renderer/chat/composer.js"), "utf8");
  const window = {
    miaConversationKinds: { MemberKind: { Bot: "bot", User: "user" } },
    miaEngineOptions: {
      activeAgentEngine: () => "hermes",
      isExternalAgentEngine: () => false
    },
    miaMarkdown: { escapeHtml: (value) => String(value ?? "") },
    miaSocial: { getActiveConversationId: () => "" }
  };
  if (nativeClipboardText !== null) {
    window.mia = { readClipboardText: async () => nativeClipboardText };
  }
  const navigator = {
    platform: "MacIntel"
  };
  if (includeNavigatorClipboard) navigator.clipboard = { readText: async () => clipboardText };
  const context = vm.createContext({
    window,
    globalThis: window,
    navigator,
    URL,
    console,
    require,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: "src/renderer/chat/composer.js" });
  return { composer: window.miaComposer, window, navigator };
}

function initComposer(composer, input, counters = { resized: 0, rendered: 0 }) {
  composer.initComposer({
    state: {
      slashCommands: [],
      fallbackSlashCommands: [],
      agentSlashCommands: {},
      slashFilter: "",
      slashSelectedIndex: 0,
      slashMenuOpen: false,
      mentionMenuOpen: false,
      mentionStart: -1,
      mentionEnd: -1,
      mentionFilter: "",
      mentionSelectedIndex: 0,
      skillLibrary: { skills: [] },
      pendingAttachments: [],
      pathPasteRefs: [],
      pathPasteNextIndex: 1
    },
    els: {
      chatInput: input,
      slashCommandMenu: menuElement(),
      mentionMenu: menuElement()
    },
    mia: {},
    fallbackSlashCommands: [],
    loadSkills: async () => {},
    renderAttachmentThumb: () => "",
    renderSendButton: () => { counters.rendered += 1; },
    resizeChatInput: () => { counters.resized += 1; },
    openImagePreview: () => {},
    appendTransientChat: () => {},
    cryptoRandomId: () => "id"
  });
  return counters;
}

test("composer path paste shortcut is platform-specific and leaves ordinary paste alone", () => {
  const { composer } = loadComposer();

  assert.equal(composer.isPathPasteShortcut({ key: "v", ctrlKey: true }, "MacIntel"), true);
  assert.equal(composer.isPathPasteShortcut({ key: "", code: "KeyV", ctrlKey: true }, "MacIntel"), true);
  assert.equal(composer.isPathPasteShortcut({ key: "v", ctrlKey: true, metaKey: true }, "MacIntel"), false);
  assert.equal(composer.isPathPasteShortcut({ key: "v", altKey: true }, "MacIntel"), false);

  assert.equal(composer.isPathPasteShortcut({ key: "v", altKey: true }, "Win32"), true);
  assert.equal(composer.isPathPasteShortcut({ key: "", code: "KeyV", altKey: true }, "Win32"), true);
  assert.equal(composer.isPathPasteShortcut({ key: "v", ctrlKey: true }, "Win32"), false);
  assert.equal(composer.isPathPasteShortcut({ key: "v", altKey: true, repeat: true }, "Win32"), false);
  assert.equal(composer.isPathPasteShortcut({ key: "v", altKey: true, isComposing: true }, "Win32"), false);
});

test("composer path paste normalizes file urls quotes and multiple lines", () => {
  const { composer } = loadComposer();

  assert.equal(
    composer.normalizePathPasteText('"file:///Users/jung/My%20File.png"\n\'/tmp/other file.txt\''),
    "/Users/jung/My File.png\n/tmp/other file.txt"
  );
  assert.equal(
    composer.normalizePathPasteText("file:///C:/Users/jung/Desktop/a.png"),
    "C:/Users/jung/Desktop/a.png"
  );
});

test("composer path paste inserts text at the current selection", () => {
  const { composer } = loadComposer();
  const input = mockInput("open  please", 5);
  const counters = initComposer(composer, input);

  assert.equal(composer.insertPathPasteText("/tmp/a.png"), true);
  assert.equal(input.value, "open /tmp/a.png please");
  assert.equal(input.selectionStart, "open /tmp/a.png".length);
  assert.equal(input.selectionEnd, "open /tmp/a.png".length);
  assert.equal(input.focused, true);
  assert.equal(counters.resized, 1);
  assert.equal(counters.rendered, 1);
});

test("composer path paste uses short image tokens and expands them for send", () => {
  const { composer } = loadComposer();
  const input = mockInput("");
  initComposer(composer, input);

  assert.equal(composer.insertPathPastePayload({
    text: "/var/folders/x/mia-clipboard/clipboard-1.png",
    kind: "image"
  }), true);
  assert.equal(input.value, "IMG1");

  const expanded = composer.expandPathPasteRefsForSend("请看 IMG1");
  assert.match(expanded, /^请看 IMG1\n\n\[\[MIA_PATH_REFS_BEGIN\]\]/);
  assert.match(expanded, /IMG1: \/var\/folders\/x\/mia-clipboard\/clipboard-1\.png/);
  assert.match(expanded, /\[\[MIA_PATH_REFS_END\]\]$/);
  assert.deepEqual(JSON.parse(JSON.stringify(composer.pathPasteAttachmentsForSend("请看 IMG1"))), [{
    id: "path-ref:IMG1",
    name: "clipboard-1.png",
    path: "/var/folders/x/mia-clipboard/clipboard-1.png",
    mime: "image/png",
    size: 0,
    kind: "image",
    inlinePathRef: true,
    pathRefToken: "IMG1"
  }]);

  composer.clearPathPasteRefs();
  assert.equal(composer.expandPathPasteRefsForSend("请看 IMG1"), "请看 IMG1");
  assert.deepEqual(JSON.parse(JSON.stringify(composer.pathPasteAttachmentsForSend("请看 IMG1"))), []);
});

test("composer path paste uses a rich inline editor for image chips", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const composerSource = fs.readFileSync(path.join(root, "src/renderer/chat/composer.js"), "utf8");

  assert.match(html, /id="chatInput" class="composer-editor" contenteditable="true"/);
  assert.match(composerSource, /data-path-ref-token/);
  assert.match(composerSource, /contentEditable = "false"/);
  assert.match(composerSource, /openPathPasteRefPreview\(chip\.dataset\.pathRefToken/);
  assert.match(composerSource, /window\.mia\.fetchFileAttachment\(\{ path: ref\.path \}\)/);
  assert.match(composerSource, /openImagePreview\(src, attachment\?\.name \|\| ref\.path \|\| ref\.token\)/);
});

test("composer path paste image tokens are removed atomically in fallback inputs", () => {
  const { composer } = loadComposer();
  const input = mockInput("");
  initComposer(composer, input);

  composer.insertPathPastePayload({ text: "/tmp/photo.png", kind: "image" });
  input.setSelectionRange(4, 4);

  const event = { key: "Backspace", preventDefault() { this.prevented = true; } };
  assert.equal(composer.handlePathPasteRefBackspace(event), true);
  assert.equal(event.prevented, true);
  assert.equal(input.value, "");
  assert.equal(composer.expandPathPasteRefsForSend(""), "");
});

test("composer path paste reads the clipboard as plain path text", async () => {
  const { composer } = loadComposer({ clipboardText: '"file:///Users/jung/A%20B.png"' });
  const input = mockInput("");
  initComposer(composer, input);

  assert.equal(await composer.pasteClipboardPathText(), true);
  assert.equal(input.value, "/Users/jung/A B.png");
});

test("composer path paste prefers the desktop clipboard bridge", async () => {
  const { composer } = loadComposer({
    nativeClipboardText: '"file:///Users/jung/Desktop/native%20path.png"',
    includeNavigatorClipboard: false
  });
  const input = mockInput("");
  initComposer(composer, input);

  assert.equal(await composer.pasteClipboardPathText(), true);
  assert.equal(input.value, "/Users/jung/Desktop/native path.png");
});

test("chat input wires the path paste shortcut before menu navigation", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const shortcutIndex = appSource.indexOf("window.miaComposer.handlePathPasteShortcut(event)");
  const mentionIndex = appSource.indexOf("if (state.mentionMenuOpen)");
  const slashIndex = appSource.indexOf("if (state.slashMenuOpen)");

  assert.ok(shortcutIndex >= 0, "path paste shortcut is wired");
  assert.ok(shortcutIndex < mentionIndex, "path paste runs before mention menu handling");
  assert.ok(shortcutIndex < slashIndex, "path paste runs before slash menu handling");
});

test("chat input accepts main-process path paste events only while focused", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /window\.mia\?\.onPathPasteText\?\.\(\(payload = \{\}\) => \{/);
  assert.match(appSource, /document\.activeElement !== els\.chatInput/);
  assert.match(appSource, /window\.miaComposer\.insertPathPastePayload\(payload\)/);
  assert.match(appSource, /const composerText = els\.chatInput\.value/);
  assert.match(appSource, /window\.miaComposer\.expandPathPasteRefsForSend\(composerText\)/);
  assert.match(appSource, /window\.miaComposer\.clearPathPasteRefs\(\)/);
});

test("preload exposes electron clipboard text for desktop path paste", () => {
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");

  assert.match(preloadSource, /clipboard/);
  assert.match(preloadSource, /readClipboardText:\s*\(\)\s*=>/);
  assert.match(preloadSource, /clipboard\.readText\(\)/);
  assert.match(preloadSource, /onPathPasteText:\s*\(handler\) => \{/);
  assert.match(preloadSource, /ipcRenderer\.on\(IpcChannel\.ComposerPathPaste, listener\)/);
});
