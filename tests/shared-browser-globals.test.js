const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHARED_DIR = path.join(__dirname, "..", "src", "shared");

// Each entry: { file: shared module filename, global: expected window.* attach name }
const SHARED_MODULES = [
  { file: "engine-contracts.js", global: "aimashiEngineContracts" },
  { file: "ipc-channels.js", global: "aimashiIpcChannels" },
  { file: "contact.js", global: "aimashiContact" },
  { file: "message-spec.js", global: "aimashiMessageSpec" },
  { file: "time-format.js", global: "aimashiTimeFormat" },
  { file: "cloud-events.js", global: "aimashiCloudEvents" },
  { file: "unread.js", global: "aimashiUnread" },
  { file: "conversation-kinds.js", global: "aimashiConversationKinds" },
  { file: "send-pipeline.js", global: "aimashiSendPipeline" }
];

function runInBrowserSandbox(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  // Simulate a browser environment: window exists, but `module` does NOT.
  // The shared modules must use a `typeof module === "object" && module.exports`
  // guard, otherwise this script will throw "module is not defined".
  const fakeWindow = {};
  const sandbox = { window: fakeWindow, globalThis: { window: fakeWindow } };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: filePath });
  return fakeWindow;
}

for (const { file, global } of SHARED_MODULES) {
  test(`${file} attaches window.${global} without throwing when 'module' is undefined`, () => {
    const win = runInBrowserSandbox(path.join(SHARED_DIR, file));
    assert.ok(win[global], `expected window.${global} to be set`);
    assert.equal(typeof win[global], "object");
  });
}

test("renderer/index.html loads every shared module via <script>", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  for (const { file } of SHARED_MODULES) {
    assert.ok(
      html.includes(`../shared/${file}`),
      `renderer/index.html missing <script src="../shared/${file}">`
    );
  }
});
