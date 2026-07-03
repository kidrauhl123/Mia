"use strict";

const crypto = require("node:crypto");

const GRANT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 90 * 1000;

function nowMs() {
  return Date.now();
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function randomId(prefix, randomBytes = crypto.randomBytes) {
  return `${prefix}_${base64url(randomBytes(12))}`;
}

function createTerminalResult(status, error) {
  return { ok: false, status, error };
}

function createMobileScanLoginFlow({
  cloudStore,
  now = nowMs,
  grantTtlMs = GRANT_TTL_MS,
  requestTtlMs = REQUEST_TTL_MS,
  randomIdFactory = randomId
} = {}) {
  if (!cloudStore || typeof cloudStore.createSessionForUser !== "function") {
    throw new Error("createMobileScanLoginFlow requires cloudStore.createSessionForUser().");
  }

  const grants = new Map();
  const requests = new Map();

  function currentNow() {
    return Number(now()) || Date.now();
  }

  function cleanup() {
    const current = currentNow();
    for (const request of requests.values()) {
      if (request.status === "pending" && request.expiresAtMs <= current) request.status = "expired";
    }
    for (const [grantId, grant] of grants.entries()) {
      if (grant.expiresAtMs <= current) {
        const activeRequest = requests.get(grant.activeRequestId || "");
        if (activeRequest && activeRequest.status === "pending") activeRequest.status = "expired";
        grants.delete(grantId);
      }
    }
  }

  function expirePriorGrantsForUser(userId) {
    for (const [grantId, grant] of grants.entries()) {
      if (grant.userId !== userId) continue;
      const activeRequest = requests.get(grant.activeRequestId || "");
      if (activeRequest && activeRequest.status === "pending") activeRequest.status = "expired";
      grants.delete(grantId);
    }
  }

  function startGrant({ userId, cloudBase = "" } = {}) {
    cleanup();
    const owner = String(userId || "").trim();
    if (!owner) throw new Error("用户不存在。");
    expirePriorGrantsForUser(owner);
    const grant = randomIdFactory("ms");
    const createdAtMs = currentNow();
    const expiresAtMs = createdAtMs + grantTtlMs;
    const normalizedBase = String(cloudBase || "").replace(/\/+$/, "");
    grants.set(grant, {
      grant,
      userId: owner,
      cloudBase: normalizedBase,
      createdAtMs,
      expiresAtMs,
      activeRequestId: "",
      consumedAtMs: 0
    });
    return {
      ok: true,
      grant,
      qrUrl: `${normalizedBase}/mobile-scan?grant=${encodeURIComponent(grant)}`,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  function createRequest({ grant = "", deviceLabel = "", platform = "" } = {}) {
    cleanup();
    const grantId = String(grant || "").trim();
    const record = grants.get(grantId);
    if (!record) return createTerminalResult("expired", "二维码已过期，请在电脑上刷新");
    if (record.consumedAtMs) return createTerminalResult("used", "这个二维码已经用过了，请重新生成");
    const active = requests.get(record.activeRequestId || "");
    if (active && active.status === "pending" && active.expiresAtMs > currentNow()) {
      return {
        ok: true,
        requestId: active.requestId,
        status: "pending",
        expiresAt: new Date(active.expiresAtMs).toISOString()
      };
    }
    const createdAtMs = currentNow();
    const expiresAtMs = Math.min(record.expiresAtMs, createdAtMs + requestTtlMs);
    const requestId = randomIdFactory("msr");
    const pending = {
      requestId,
      grant: grantId,
      userId: record.userId,
      deviceLabel: String(deviceLabel || "").trim().slice(0, 120),
      platform: String(platform || "").trim().slice(0, 40),
      createdAtMs,
      expiresAtMs,
      status: "pending",
      sessionResult: null
    };
    requests.set(requestId, pending);
    record.activeRequestId = requestId;
    return {
      ok: true,
      requestId,
      status: "pending",
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  function getPendingRequestForUser(userId) {
    cleanup();
    const owner = String(userId || "").trim();
    if (!owner) return null;
    let latest = null;
    for (const request of requests.values()) {
      if (request.userId !== owner || request.status !== "pending") continue;
      if (!latest || request.createdAtMs > latest.createdAtMs) latest = request;
    }
    if (!latest) return null;
    return {
      requestId: latest.requestId,
      grant: latest.grant,
      deviceLabel: latest.deviceLabel,
      platform: latest.platform,
      status: latest.status,
      expiresAt: new Date(latest.expiresAtMs).toISOString()
    };
  }

  function decideRequest({ userId, requestId, decision = "" } = {}) {
    cleanup();
    const owner = String(userId || "").trim();
    const pending = requests.get(String(requestId || "").trim());
    if (!pending || pending.userId !== owner) throw new Error("登录请求不存在。");
    if (pending.status !== "pending") return { ok: pending.status === "approved", status: pending.status };
    if (pending.expiresAtMs <= currentNow()) {
      pending.status = "expired";
      return createTerminalResult("expired", "登录请求已过期。");
    }
    const normalized = String(decision || "").trim().toLowerCase();
    if (normalized === "deny") {
      pending.status = "denied";
      const grant = grants.get(pending.grant);
      if (grant && grant.activeRequestId === pending.requestId) grant.activeRequestId = "";
      return { ok: true, status: "denied" };
    }
    const sessionResult = cloudStore.createSessionForUser(owner);
    pending.status = "approved";
    pending.sessionResult = sessionResult;
    const grant = grants.get(pending.grant);
    if (grant) grant.consumedAtMs = currentNow();
    return { ok: true, status: "approved" };
  }

  function completeRequest({ requestId = "" } = {}) {
    cleanup();
    const pending = requests.get(String(requestId || "").trim());
    if (!pending) return createTerminalResult("expired", "登录请求已过期。");
    if (pending.status === "pending") {
      return {
        ok: true,
        status: "pending",
        expiresAt: new Date(pending.expiresAtMs).toISOString()
      };
    }
    if (pending.status === "approved" && pending.sessionResult?.token) {
      return {
        ok: true,
        status: "approved",
        token: pending.sessionResult.token,
        user: pending.sessionResult.user || null
      };
    }
    if (pending.status === "denied") return createTerminalResult("denied", "电脑端已取消本次登录");
    return createTerminalResult("expired", "登录请求已过期。");
  }

  return {
    startGrant,
    createRequest,
    getPendingRequestForUser,
    decideRequest,
    completeRequest
  };
}

module.exports = {
  createMobileScanLoginFlow
};
