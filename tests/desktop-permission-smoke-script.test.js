const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  activateManualSmokeApp,
  electronAppBundlePath,
  isManualPermissionSmoke,
  manualSmokeWindowSettleMs,
  permissionSmokeProofFile,
  permissionSmokeTimeoutMs,
  parseAudit,
  pollForAuditResult
} = require("../scripts/smoke-desktop-permission.js");

test("desktop permission smoke manual mode is explicit opt-in", () => {
  assert.equal(isManualPermissionSmoke({}), false);
  assert.equal(isManualPermissionSmoke({ MIA_PERMISSION_SMOKE_MANUAL: "0" }), false);
  assert.equal(isManualPermissionSmoke({ MIA_PERMISSION_SMOKE_MANUAL: "1" }), true);
  assert.equal(isManualPermissionSmoke({ MIA_PERMISSION_SMOKE_MANUAL: "true" }), true);
  assert.equal(isManualPermissionSmoke({ MIA_PERMISSION_SMOKE_MANUAL: "yes" }), true);
});

test("desktop permission smoke audit parser captures show and reject result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-permission-smoke-test-"));
  const auditFile = path.join(dir, "dialog.jsonl");
  try {
    fs.writeFileSync(auditFile, [
      JSON.stringify({
        event: "show",
        options: {
          title: "允许远程运行本机 Agent？",
          buttons: ["允许本次运行", "拒绝"],
          defaultId: 1,
          cancelId: 1,
          detail: [
            "来源：Mia Cloud",
            "会话：default",
            "附件：1 个",
            "请求内容：",
            "permission-dialog-audit-smoke-do-not-run-codex"
          ].join("\n")
        }
      }),
      JSON.stringify({ event: "result", response: 1 })
    ].join("\n") + "\n");
    const audit = parseAudit(auditFile);
    assert.equal(audit.show.options.title, "允许远程运行本机 Agent？");
    assert.deepEqual(audit.show.options.buttons, ["允许本次运行", "拒绝"]);
    assert.equal(audit.show.options.defaultId, 1);
    assert.equal(audit.show.options.cancelId, 1);
    assert.equal(audit.result.response, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop permission smoke waits for a real dialog result record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-permission-smoke-test-"));
  const auditFile = path.join(dir, "dialog.jsonl");
  try {
    fs.writeFileSync(auditFile, JSON.stringify({
      event: "show",
      options: {
        title: "允许远程运行本机 Agent？",
        buttons: ["允许本次运行", "拒绝"],
        defaultId: 1,
        cancelId: 1,
        detail: [
          "来源：Mia Cloud",
          "会话：default",
          "附件：1 个",
          "permission-dialog-audit-smoke-do-not-run-codex"
        ].join("\n")
      }
    }) + "\n");
    setTimeout(() => {
      fs.appendFileSync(auditFile, JSON.stringify({ event: "result", response: 1 }) + "\n");
    }, 25);
    const audit = await pollForAuditResult(auditFile, 1000);
    assert.equal(audit.result.response, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop permission smoke can bring the Electron app bundle forward in manual mode", () => {
  const calls = [];
  const activated = activateManualSmokeApp({
    manualMode: true,
    platform: "darwin",
    binaryPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    execFileSync: (command, args, options) => calls.push({ command, args, options })
  });
  assert.equal(activated, true);
  assert.deepEqual(calls, [{
    command: "open",
    args: ["-a", "/repo/node_modules/electron/dist/Electron.app"],
    options: { stdio: "ignore" }
  }]);
  assert.equal(electronAppBundlePath("/not/an/app/binary"), "");
});

test("desktop permission smoke does not activate apps outside manual macOS mode", () => {
  const calls = [];
  const activated = activateManualSmokeApp({
    manualMode: false,
    platform: "darwin",
    binaryPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    execFileSync: (...args) => calls.push(args)
  });
  assert.equal(activated, false);
  assert.deepEqual(calls, []);
});

test("desktop permission smoke uses a bounded manual window settle delay", () => {
  assert.equal(manualSmokeWindowSettleMs({}), 1500);
  assert.equal(manualSmokeWindowSettleMs({ MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS: "0" }), 0);
  assert.equal(manualSmokeWindowSettleMs({ MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS: "2500" }), 2500);
  assert.equal(manualSmokeWindowSettleMs({ MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS: "-1" }), 1500);
  assert.equal(manualSmokeWindowSettleMs({ MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS: "bad" }), 1500);
});

test("desktop permission smoke gives manual mode a human-scale default timeout", () => {
  assert.equal(permissionSmokeTimeoutMs({}), 30000);
  assert.equal(permissionSmokeTimeoutMs({ MIA_PERMISSION_SMOKE_MANUAL: "1" }), 240000);
  assert.equal(permissionSmokeTimeoutMs({ MIA_PERMISSION_SMOKE_MANUAL: "1", MIA_PERMISSION_SMOKE_TIMEOUT_MS: "120000" }), 120000);
  assert.equal(permissionSmokeTimeoutMs({ MIA_PERMISSION_SMOKE_TIMEOUT_MS: "15000" }), 15000);
  assert.equal(permissionSmokeTimeoutMs({ MIA_PERMISSION_SMOKE_MANUAL: "1", MIA_PERMISSION_SMOKE_TIMEOUT_MS: "-1" }), 240000);
  assert.equal(permissionSmokeTimeoutMs({ MIA_PERMISSION_SMOKE_TIMEOUT_MS: "bad" }), 30000);
});

test("desktop permission smoke writes manual proof to an explicit durable path", () => {
  const rootDir = "/repo";
  assert.equal(
    permissionSmokeProofFile({}, rootDir),
    path.join(rootDir, "dist", "mia-desktop-permission-manual-proof.json")
  );
  assert.equal(
    permissionSmokeProofFile({ MIA_PERMISSION_SMOKE_PROOF_FILE: "/tmp/proof.json" }, rootDir),
    "/tmp/proof.json"
  );
});
