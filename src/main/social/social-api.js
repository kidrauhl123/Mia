const { fetch } = globalThis;
const { randomUUID } = require("node:crypto");

// Tag a write body with a clientOpId so the server can deduplicate
// retries (Phase 1.D). Bodies that omit clientOpId are still accepted;
// the helper only attaches one when the caller hasn't supplied their
// own. Callers that need a stable id across explicit retries can
// pre-set body.clientOpId.
function withOpId(body = {}) {
  if (body && typeof body === "object" && !body.clientOpId) {
    return { ...body, clientOpId: `op_${randomUUID()}` };
  }
  return body;
}

async function jsonFetch({ baseUrl, token, method, path, body, timeoutMs = 15000 }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { /* ignore */ }
    const message = (payload && payload.error) || `Mia Cloud ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  if (response.status === 204) return null;
  return response.json();
}

function createSocialApi({ getSettings, normalizeUrl }) {
  function ctx(opts = {}) {
    const settings = getSettings();
    if (!settings || !settings.enabled || !settings.token) {
      throw new Error("Mia Cloud not logged in.");
    }
    return {
      baseUrl: normalizeUrl(settings.url),
      token: settings.token,
      ...opts
    };
  }
  return {
    async sendFriendRequest(toUserId) {
      return jsonFetch({ ...ctx(), method: "POST", path: "/api/social/friend-requests", body: withOpId({ toUserId }) });
    },
    async respondFriendRequest(requestId, action) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/social/friend-requests/${encodeURIComponent(requestId)}/respond`, body: withOpId({ action }) });
    },
    async cancelFriendRequest(requestId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/social/friend-requests/${encodeURIComponent(requestId)}` });
    },
    async listFriendRequests(direction = "incoming") {
      const dir = direction === "outgoing" ? "outgoing" : "incoming";
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/social/friend-requests?direction=${dir}` });
    },
    async listFriends() {
      return jsonFetch({ ...ctx(), method: "GET", path: "/api/social/friends" });
    },
    async removeFriend(userId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/social/friends/${encodeURIComponent(userId)}` });
    },
    async listConversations() {
      return jsonFetch({ ...ctx(), method: "GET", path: "/api/conversations" });
    },
    async listBots() {
      return jsonFetch({ ...ctx(), method: "GET", path: "/api/me/bots?compact=1" });
    },
    async getBotIdentity(botId) {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/me/bots/${encodeURIComponent(botId)}` });
    },
    async saveBotIdentity(botId, body = {}) {
      return jsonFetch({
        ...ctx(),
        method: "PUT",
        path: `/api/me/bots/${encodeURIComponent(botId)}`,
        body: withOpId(body)
      });
    },
    async deleteBot(botId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/me/bots/${encodeURIComponent(botId)}` });
    },
    async listPlatformModels() {
      return jsonFetch({ ...ctx(), method: "GET", path: "/api/me/model-catalog" });
    },
    // Conversation ids are `dm:<a>:<b>` or `g_<hex>` — both match the cloud route
    // regex /api/conversations/([A-Za-z0-9_:-]+) literally. encodeURIComponent would
    // turn `:` into `%3A` which doesn't match and silently 404s, which is
    // why DM sends were being swallowed.
    async getConversation(conversationId) {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/conversations/${conversationId}` });
    },
    async listConversationMessages(conversationId, sinceSeq = 0, limit = 100) {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/conversations/${conversationId}/messages?since_seq=${Number(sinceSeq) || 0}&limit=${Number(limit) || 100}` });
    },
    async searchConversationMessages(query, limit = 80) {
      return jsonFetch({
        ...ctx({ timeoutMs: 20000 }),
        method: "GET",
        path: `/api/conversations/search?q=${encodeURIComponent(String(query || ""))}&limit=${Number(limit) || 80}`
      });
    },
    async postConversationMessage(conversationId, body) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/conversations/${conversationId}/messages`, body: withOpId(body) });
    },
    async respondRunApproval(conversationId, runId, decision) {
      return jsonFetch({
        ...ctx(),
        method: "POST",
        path: `/api/conversations/${conversationId}/runs/${encodeURIComponent(runId)}/approval`,
        body: { decision }
      });
    },
    async deleteConversationMessage(conversationId, messageId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/conversations/${conversationId}/messages/${encodeURIComponent(messageId)}` });
    },
    async createConversation({ name, memberBots, memberFriendUserIds, clientGroupId } = {}) {
      // clientGroupId is the conversation-creation-specific idempotency key (links
      // a local group to its cloud counterpart); we still attach a generic
      // clientOpId so a *retry* of the same POST doesn't run twice even
      // when there's no clientGroupId provided. Both checks coexist on
      // the server.
      const body = { name, memberBots, memberFriendUserIds };
      if (clientGroupId) body.clientGroupId = clientGroupId;
      return jsonFetch({ ...ctx(), method: "POST", path: "/api/conversations", body: withOpId(body) });
    },
    async ensureBotConversation(botId, body = {}) {
      const id = String(botId || "").trim();
      if (!id) throw new Error("botId is required");
      return this.ensureBotSessionConversation(id, { ...body, botId: id });
    },
    async ensureBotSessionConversation(sessionId, body = {}) {
      const botId = String(body.botId || body.botKey || "").trim();
      return jsonFetch({
        ...ctx(),
        method: "PUT",
        path: `/api/me/bot-conversations/${encodeURIComponent(sessionId)}`,
        body: withOpId({ ...body, ...(botId ? { botId } : {}) })
      });
    },
    async getBotRuntime(botId, runtimeKind = "cloud-claude-code") {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/me/bots/${encodeURIComponent(botId)}/runtime?kind=${encodeURIComponent(runtimeKind)}` });
    },
    async saveBotRuntime(botId, body = {}) {
      return jsonFetch({ ...ctx(), method: "PUT", path: `/api/me/bots/${encodeURIComponent(botId)}/runtime`, body: withOpId(body) });
    },
    async listBridgeDevices({ includeOffline = false } = {}) {
      const query = includeOffline ? "?include=all" : "";
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/bridge/devices${query}` });
    },
    async updateConversation(conversationId, patch) {
      return jsonFetch({ ...ctx(), method: "PATCH", path: `/api/conversations/${conversationId}`, body: patch || {} });
    },
    async deleteConversation(conversationId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/conversations/${conversationId}` });
    },
    async addConversationMember(conversationId, { memberKind, memberRef, ownerId }) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/conversations/${conversationId}/members`, body: { memberKind, memberRef, ownerId } });
    },
    async removeConversationMember(conversationId, { memberKind, memberRef }) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/conversations/${conversationId}/members`, body: { memberKind, memberRef } });
    },
    async postConversationMessageAsBot(conversationId, body) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/conversations/${conversationId}/messages/as-bot`, body: withOpId(body) });
    }
  };
}

module.exports = { createSocialApi };
