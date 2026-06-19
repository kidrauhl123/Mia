const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Each entry: { file: module path from repo root, global: expected window.* attach name }
const SHARED_MODULES = [
  { file: "src/shared/engine-contracts.js", global: "miaEngineContracts" },
  { file: "src/shared/agent-engine-policy.js", global: "miaAgentEnginePolicy" },
  { file: "src/shared/ipc-channels.js", global: "miaIpcChannels" },
  { file: "packages/shared/contact.js", global: "miaContact" },
  { file: "src/shared/message-spec.js", global: "miaMessageSpec" },
  { file: "src/shared/time-format.js", global: "miaTimeFormat" },
  { file: "src/shared/cloud-events.js", global: "miaCloudEvents" },
  { file: "packages/shared/unread.js", global: "miaUnread" },
  { file: "src/shared/conversation-kinds.js", global: "miaConversationKinds" },
  { file: "packages/shared/send-pipeline.js", global: "miaSendPipeline" },
  { file: "packages/shared/cloud-client.js", global: "miaCloudClient" },
  { file: "packages/shared/group-tiles.js", global: "miaGroupTiles" },
  { file: "packages/shared/self-identity.js", global: "miaSelfIdentity" },
  { file: "packages/shared/avatar.js", global: "miaAvatarMedia" },
  { file: "packages/shared/avatar.js", global: "miaAvatarResolve" },
  { file: "packages/shared/avatar.js", global: "miaMemberColor" },
  { file: "src/shared/bot-runtime-control.js", global: "miaBotRuntimeControl" },
  { file: "src/shared/message-text-cursor.js", global: "miaMessageTextCursor" }
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
    const win = runInBrowserSandbox(path.join(__dirname, "..", file));
    assert.ok(win[global], `expected window.${global} to be set`);
    assert.equal(typeof win[global], "object");
  });
}

test("renderer/index.html loads every shared module via <script>", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  for (const { file } of SHARED_MODULES.filter((entry) => entry.file.startsWith("src/shared/"))) {
    const filename = path.basename(file);
    assert.ok(
      html.includes(`../shared/${filename}`),
      `renderer/index.html missing <script src="../shared/${filename}">`
    );
  }
  assert.ok(
    html.includes("../../packages/shared/contact.js"),
    "renderer/index.html missing <script src=\"../../packages/shared/contact.js\">"
  );
  assert.ok(
    html.includes("../../packages/shared/group-tiles.js"),
    "renderer/index.html missing <script src=\"../../packages/shared/group-tiles.js\">"
  );
  assert.ok(
    html.includes("../../packages/shared/send-pipeline.js"),
    "renderer/index.html missing <script src=\"../../packages/shared/send-pipeline.js\">"
  );
  assert.ok(
    html.includes("../../packages/shared/self-identity.js"),
    "renderer/index.html missing <script src=\"../../packages/shared/self-identity.js\">"
  );
  assert.ok(
    html.includes("../../packages/shared/unread.js"),
    "renderer/index.html missing <script src=\"../../packages/shared/unread.js\">"
  );
  assert.ok(
    html.includes("../../packages/shared/avatar.js"),
    "renderer/index.html missing <script src=\"../../packages/shared/avatar.js\">"
  );
});

test("renderer/index.html does not load the same script twice", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = scripts.filter((src, index) => scripts.indexOf(src) !== index);
  assert.deepEqual(duplicates, [], `Duplicate renderer scripts:\n${duplicates.join("\n")}`);
});
