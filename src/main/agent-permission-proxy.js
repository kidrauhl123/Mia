"use strict";

function sessionQuery(filter = {}) {
  const sessionId = String(filter.sessionId || "").trim();
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
}

function createAgentPermissionProxy({
  coreControlClient
}) {
  function requireCoreControlClient() {
    if (coreControlClient && typeof coreControlClient.call === "function") return coreControlClient;
    throw new Error("Mia Core 未运行，权限审批无法完成。");
  }

  async function respond(payload = {}) {
    return requireCoreControlClient().call("/api/agent-permissions/respond", {
      method: "POST",
      body: JSON.stringify(payload || {})
    });
  }

  async function list(filter = {}) {
    const result = await requireCoreControlClient().call(`/api/agent-permissions${sessionQuery(filter)}`);
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
