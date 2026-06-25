"use strict";

function sessionQuery(filter = {}) {
  const sessionId = String(filter.sessionId || "").trim();
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
}

function createAgentPermissionProxy({
  isDaemonProcess = false,
  coordinator,
  daemonClient
}) {
  function requireDaemonClient() {
    if (daemonClient && typeof daemonClient.call === "function") return daemonClient;
    throw new Error("Mia Core 未运行，权限审批无法完成。");
  }

  async function respond(payload = {}) {
    if (isDaemonProcess) {
      return coordinator.resolvePermission(payload || {});
    }
    return requireDaemonClient().call("/api/chat/permissions/respond", {
      method: "POST",
      body: JSON.stringify(payload || {})
    });
  }

  async function list(filter = {}) {
    if (isDaemonProcess) {
      return coordinator.listPending(filter || {});
    }
    const result = await requireDaemonClient().call(`/api/chat/permissions${sessionQuery(filter)}`);
    return Array.isArray(result?.requests) ? result.requests : [];
  }

  return {
    list,
    respond
  };
}

module.exports = {
  createAgentPermissionProxy
};
