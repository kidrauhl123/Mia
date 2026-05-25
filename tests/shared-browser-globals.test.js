const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHARED_DIR = path.join(__dirname, "..", "src", "shared");

// Each entry: { file: shared module filename, global: expected window.* attach name }
const SHARED_MODULES = [
  { file: "engine-contracts.js", global: "miaEngineContracts" },
  { file: "ipc-channels.js", global: "miaIpcChannels" },
  { file: "contact.js", global: "miaContact" },
  { file: "message-spec.js", global: "miaMessageSpec" },
  { file: "time-format.js", global: "miaTimeFormat" },
  { file: "cloud-events.js", global: "miaCloudEvents" },
  { file: "unread.js", global: "miaUnread" },
  { file: "conversation-kinds.js", global: "miaConversationKinds" },
  { file: "send-pipeline.js", global: "miaSendPipeline" }
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
