const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  installPathPasteShortcut,
  isPathPasteInput,
  normalizeClipboardCandidate,
  readClipboardPathPastePayload,
  readClipboardPathPasteText
} = require("../src/main/path-paste-shortcut.js");

test("path paste shortcut recognizes main-process mac and windows inputs", () => {
  assert.equal(isPathPasteInput({ key: "v", code: "KeyV", control: true }, "darwin"), true);
  assert.equal(isPathPasteInput({ key: "\u0016", control: true }, "darwin"), true);
  assert.equal(isPathPasteInput({ key: "v", code: "KeyV", meta: true }, "darwin"), false);
  assert.equal(isPathPasteInput({ key: "v", code: "KeyV", alt: true }, "win32"), true);
  assert.equal(isPathPasteInput({ key: "v", code: "KeyV", control: true }, "win32"), false);
});

test("path paste clipboard reader supports text uri and plist-ish candidates", () => {
  assert.equal(normalizeClipboardCandidate("# comment\nfile:///Users/jung/A%20B.png"), "file:///Users/jung/A%20B.png");
  assert.equal(
    normalizeClipboardCandidate("<plist><array><string>/Users/jung/A&amp;B.png</string></array></plist>"),
    "/Users/jung/A&B.png"
  );
  assert.equal(
    readClipboardPathPasteText({
      availableFormats: () => ["text/uri-list"],
      readText: () => "",
      read: (format) => format === "text/uri-list" ? "file:///tmp/a.png" : ""
    }),
    "file:///tmp/a.png"
  );
});

test("path paste clipboard reader writes clipboard images to a temp png path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-path-paste-test-"));
  const payload = readClipboardPathPastePayload({
    availableFormats: () => [],
    readText: () => "",
    read: () => "",
    readImage: () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from("png-bytes")
    })
  }, {
    tempDir: dir,
    now: () => 123,
    randomId: () => "abcdef123456"
  });
  const result = payload.text;

  assert.equal(payload.kind, "image");
  assert.equal(result, path.join(dir, "clipboard-123-abcdef12.png"));
  assert.equal(fs.readFileSync(result, "utf8"), "png-bytes");
});

test("path paste shortcut sends clipboard path text from before-input-event", () => {
  const webContents = new EventEmitter();
  const sent = [];
  webContents.send = (channel, payload) => sent.push({ channel, payload });
  const win = {
    webContents,
    isDestroyed: () => false
  };
  installPathPasteShortcut(win, {
    channel: "composer:path-paste",
    platform: "darwin",
    clipboard: {
      availableFormats: () => ["text/plain"],
      readText: () => "/tmp/a.png",
      read: () => ""
    }
  });

  let prevented = false;
  webContents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, {
    key: "v",
    code: "KeyV",
    control: true
  });

  assert.equal(prevented, true);
  assert.deepEqual(sent, [{ channel: "composer:path-paste", payload: { text: "/tmp/a.png", kind: "text" } }]);
});
