const { test } = require("node:test");
const assert = require("node:assert/strict");

const { finalizeCloudLoginIpcResult } = require("../src/main/cloud-login-ipc.js");

test("mobile scan start returns the raw QR payload instead of runtime status", () => {
  const qrPayload = {
    ok: true,
    qrUrl: "https://mia.example/mobile-scan?grant=ms_123",
    qrCodeUrl: "data:image/png;base64,abc",
    expiresAt: "2026-07-03T10:00:00.000Z"
  };
  const runtimeStatus = {
    cloud: {
      enabled: true,
      user: { id: "u_1" }
    }
  };

  const result = finalizeCloudLoginIpcResult({
    payload: { action: "mobile-scan-start" },
    result: qrPayload,
    runtimeStatus
  });

  assert.deepEqual(result, qrPayload);
});

test("mobile scan pending and decision responses stay raw for the renderer flow", () => {
  const pending = finalizeCloudLoginIpcResult({
    payload: { action: "mobile-scan-pending" },
    result: {
      ok: true,
      requestId: "msr_123",
      deviceLabel: "Pixel 9",
      status: "pending"
    },
    runtimeStatus: { cloud: { enabled: true } }
  });
  const decision = finalizeCloudLoginIpcResult({
    payload: { action: "mobile-scan-decision", requestId: "msr_123", decision: "approve" },
    result: { ok: true, status: "approved" },
    runtimeStatus: { cloud: { enabled: true } }
  });

  assert.deepEqual(pending, {
    ok: true,
    requestId: "msr_123",
    deviceLabel: "Pixel 9",
    status: "pending"
  });
  assert.deepEqual(decision, { ok: true, status: "approved" });
});

test("wechat complete still returns runtime status for the renderer", () => {
  const result = finalizeCloudLoginIpcResult({
    payload: { action: "complete", state: "wx_state" },
    result: { kind: "wechat-login-complete", status: "complete" },
    runtimeStatus: { cloud: { enabled: true } }
  });

  assert.deepEqual(result, { cloud: { enabled: true } });
});
