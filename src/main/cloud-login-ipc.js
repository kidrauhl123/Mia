"use strict";

function normalizedAction(payload = {}) {
  return String(payload?.action || "").trim().toLowerCase();
}

function shouldReturnRawCloudLoginResult(payload = {}, result = {}) {
  const action = normalizedAction(payload);
  if (result?.kind === "wechat-login-start" || result?.kind === "wechat-login-pending") return true;
  return action === "mobile-scan-start"
    || action === "mobile-scan-pending"
    || action === "mobile-scan-decision";
}

function finalizeCloudLoginIpcResult({ payload = {}, result = null, runtimeStatus = null } = {}) {
  return shouldReturnRawCloudLoginResult(payload, result) ? result : runtimeStatus;
}

module.exports = {
  finalizeCloudLoginIpcResult
};
