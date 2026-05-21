const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  cloudBridgeRunDialogOptions,
  cloudBridgeRunNotificationOptions,
  cloudBridgeRunPromptHtml,
  confirmCloudBridgeRunPermission,
  focusPermissionDialogWindow,
  releasePermissionDialogWindowAttention
} = require("../src/cloud/desktop-bridge-permission.js");

test("desktop bridge permission dialog describes source, conversation, attachments, and prompt", () => {
  const options = cloudBridgeRunDialogOptions({
    conversationId: "conv_1",
    text: "运行本机任务",
    attachments: [{ name: "a.png" }, { name: "b.png" }]
  });
  assert.equal(options.title, "允许远程运行本机 Agent？");
  assert.deepEqual(options.buttons, ["允许本次运行", "拒绝"]);
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
  assert.match(options.detail, /来源：Aimashi Cloud/);
  assert.match(options.detail, /会话：conv_1/);
  assert.match(options.detail, /附件：2 个/);
  assert.match(options.detail, /运行本机任务/);
});

test("desktop bridge permission notification directs user back to native dialog", () => {
  const options = cloudBridgeRunNotificationOptions({
    conversationId: "conv_notice",
    attachments: [{ name: "a.png" }]
  });
  assert.equal(options.title, "Aimashi Cloud 请求本机 Agent");
  assert.match(options.body, /会话：conv_notice/);
  assert.match(options.body, /附件：1 个/);
  assert.match(options.body, /权限弹窗/);
  assert.equal(options.silent, false);
});

test("desktop bridge permission prompt html defaults to reject and escapes request text", () => {
  const html = cloudBridgeRunPromptHtml(cloudBridgeRunDialogOptions({
    conversationId: "conv_<unsafe>",
    text: "<script>alert(1)</script>",
    attachments: [{ name: "a.png" }]
  }));
  assert.match(html, /<button data-response="0">允许本次运行<\/button>\s*<button class="primary" data-response="1" autofocus>拒绝<\/button>/);
  assert.match(html, /data-response="1" autofocus/);
  assert.match(html, /aimashi-permission:\/\/response\/1/);
  assert.match(html, /允许本次运行/);
  assert.match(html, /拒绝/);
  assert.match(html, /conv_&lt;unsafe&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("desktop bridge permission allows yolo without showing dialog", async () => {
  let called = false;
  await assert.doesNotReject(confirmCloudBridgeRunPermission({
    mode: "yolo",
    message: { text: "run" },
    showMessageBox: async () => {
      called = true;
      return { response: 1 };
    }
  }));
  assert.equal(called, false);
});

test("desktop bridge permission denies deny mode without showing dialog", async () => {
  let called = false;
  await assert.rejects(
    confirmCloudBridgeRunPermission({
      mode: "deny",
      message: { text: "run" },
      showMessageBox: async () => {
        called = true;
        return { response: 0 };
      }
    }),
    /已拒绝远程 Agent 运行/
  );
  assert.equal(called, false);
});

test("desktop bridge permission follows ask dialog response", async () => {
  await assert.doesNotReject(confirmCloudBridgeRunPermission({
    mode: "ask",
    message: { text: "run" },
    showMessageBox: async () => ({ response: 0 })
  }));
  await assert.rejects(
    confirmCloudBridgeRunPermission({
      mode: "ask",
      message: { text: "run" },
      showMessageBox: async () => ({ response: 1 })
    }),
    /本机已拒绝远程 Agent 运行/
  );
});

test("desktop bridge permission can audit the real dialog options path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-permission-audit-"));
  const auditFile = path.join(dir, "dialog.jsonl");
  try {
    await confirmCloudBridgeRunPermission({
      mode: "ask",
      message: {
        conversationId: "conv_audit",
        text: "audit prompt",
        attachments: [{ name: "proof.png" }]
      },
      auditFile,
      showMessageBox: async () => ({ response: 0 })
    });
    const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "show");
    assert.equal(lines[0].mode, "ask");
    assert.equal(lines[0].options.title, "允许远程运行本机 Agent？");
    assert.deepEqual(lines[0].options.buttons, ["允许本次运行", "拒绝"]);
    assert.equal(lines[0].options.defaultId, 1);
    assert.match(lines[0].options.detail, /会话：conv_audit/);
    assert.match(lines[0].options.detail, /附件：1 个/);
    assert.match(lines[0].options.detail, /audit prompt/);
    assert.equal(lines[1].event, "result");
    assert.equal(lines[1].response, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop bridge permission focuses a visible parent window before showing native dialog", () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    isAlwaysOnTop: () => false,
    setAlwaysOnTop: (enabled, level) => calls.push(["setAlwaysOnTop", enabled, level || ""]),
    moveTop: () => calls.push("moveTop"),
    flashFrame: (enabled) => calls.push(["flashFrame", enabled])
  };
  const target = focusPermissionDialogWindow({
    getFocusedWindow: () => null,
    getAllWindows: () => [win],
    focusApp: () => calls.push("app.focus"),
    requestUserAttention: () => {
      calls.push(["requestUserAttention", "critical"]);
      return 42;
    },
    cancelUserAttention: (requestId) => calls.push(["cancelUserAttention", requestId])
  });
  assert.equal(target, win);
  assert.deepEqual(calls, [
    "restore",
    "show",
    "app.focus",
    "focus",
    ["requestUserAttention", "critical"],
    ["setAlwaysOnTop", true, "modal-panel"],
    "moveTop",
    ["flashFrame", true]
  ]);
  assert.equal(releasePermissionDialogWindowAttention(win), true);
  assert.deepEqual(calls.slice(-3), [
    ["flashFrame", false],
    ["setAlwaysOnTop", false, ""],
    ["cancelUserAttention", 42]
  ]);
});

test("desktop bridge permission ignores destroyed windows when choosing a dialog parent", () => {
  const destroyed = { isDestroyed: () => true };
  const target = focusPermissionDialogWindow({
    getFocusedWindow: () => destroyed,
    getAllWindows: () => [destroyed]
  });
  assert.equal(target, null);
});

test("desktop bridge permission does not drop pre-existing always-on-top state", () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    show: () => {},
    focus: () => {},
    isAlwaysOnTop: () => true,
    setAlwaysOnTop: (enabled, level) => calls.push(["setAlwaysOnTop", enabled, level || ""]),
    moveTop: () => calls.push("moveTop"),
    flashFrame: (enabled) => calls.push(["flashFrame", enabled])
  };
  const target = focusPermissionDialogWindow({
    getFocusedWindow: () => win,
    getAllWindows: () => []
  });
  assert.equal(target, win);
  assert.deepEqual(calls, ["moveTop", ["flashFrame", true]]);
  assert.equal(releasePermissionDialogWindowAttention(win), true);
  assert.deepEqual(calls, ["moveTop", ["flashFrame", true], ["flashFrame", false]]);
});
