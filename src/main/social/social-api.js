const { fetch } = globalThis;
const { randomUUID } = require("node:crypto");
const { createCloudRequestCoordinator } = require("../cloud/request-coordinator.js");
const {
  hasRuntimeConfigIntent,
  runtimeConfigInputForRequest
} = require("../../shared/runtime-binding-intents.js");

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

async function jsonFetch({ baseUrl, token, method, path, body, timeoutMs = 15000, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
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

function createSocialApi({ getSettings, normalizeUrl, fetchImpl = fetch, maxConcurrentRequests = 6 }) {
  const requests = createCloudRequestCoordinator({
    maxConcurrent: maxConcurrentRequests,
    execute: (request) => jsonFetch({ ...request, fetchImpl })
  });
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
  const jsonRequest = (input) => requests.request(input);
  return {
    async sendFriendRequest(toUserId) {
      return jsonRequest({ ...ctx(), method: "POST", path: "/api/social/friend-requests", body: withOpId({ toUserId }) });
    },
    async respondFriendRequest(requestId, action) {
      return jsonRequest({ ...ctx(), method: "POST", path: `/api/social/friend-requests/${encodeURIComponent(requestId)}/respond`, body: withOpId({ action }) });
    },
    async cancelFriendRequest(requestId) {
      return jsonRequest({ ...ctx(), method: "DELETE", path: `/api/social/friend-requests/${encodeURIComponent(requestId)}` });
    },
    async listFriendRequests(direction = "incoming") {
      const dir = direction === "outgoing" ? "outgoing" : "incoming";
      return jsonRequest({ ...ctx(), method: "GET", path: `/api/social/friend-requests?direction=${dir}` });
    },
    async listFriends() {
      return jsonRequest({ ...ctx(), method: "GET", path: "/api/social/friends" });
    },
    async removeFriend(userId) {
      return jsonRequest({ ...ctx(), method: "DELETE", path: `/api/social/friends/${encodeURIComponent(userId)}` });
    },
    async listConversations() {
      return jsonRequest({ ...ctx(), method: "GET", path: "/api/conversations" });
    },
    async listBots() {
      return jsonRequest({ ...ctx(), method: "GET", path: "/api/me/bots?compact=1" });
    },
    async listImChannels() {
      return jsonRequest({ ...ctx(), method: "GET", path: "/api/me/im-channels" });
    },
    async createImChannel(body = {}) {
      return jsonRequest({ ...ctx(), method: "POST", path: "/api/me/im-channels", body: withOpId(body) });
    },
    async updateImChannel(channelId, body = {}) {
      return jsonRequest({
        ...ctx(),
        method: "PATCH",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}`,
        body: withOpId(body)
      });
    },
    async deleteImChannel(channelId) {
      return jsonRequest({
        ...ctx(),
        method: "DELETE",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}`,
        body: withOpId({})
      });
    },
    async testImChannel(channelId) {
      return jsonRequest({
        ...ctx(),
        method: "POST",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}/test`,
        body: withOpId({})
      });
    },
    async getCloudWechatClawbotStatus(channelId) {
      return jsonRequest({
        ...ctx(),
        method: "GET",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}/wechat-clawbot/status`
      });
    },
    async startCloudWechatClawbotLink(channelId) {
      return jsonRequest({
        ...ctx(),
        method: "POST",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}/wechat-clawbot/link`,
        body: withOpId({})
      });
    },
    async submitCloudWechatClawbotPairingCode(channelId, body = {}) {
      return jsonRequest({
        ...ctx(),
        method: "POST",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}/wechat-clawbot/pairing-code`,
        body: { code: String(body?.code || "").trim() }
      });
    },
    async disconnectCloudWechatClawbot(channelId) {
      return jsonRequest({
        ...ctx(),
        method: "POST",
        path: `/api/me/im-channels/${encodeURIComponent(String(channelId || ""))}/wechat-clawbot/disconnect`,
        body: withOpId({})
      });
    },
    async getBotIdentity(botId) {
      return jsonRequest({ ...ctx(), method: "GET", path: `/api/me/bots/${encodeURIComponent(botId)}` });
    },
    async saveBotIdentity(botId, body = {}) {
      return jsonRequest({
        ...ctx(),
        method: "PUT",
        path: `/api/me/bots/${encodeURIComponent(botId)}`,
        body: withOpId(body)
      });
    },
    async deleteBot(botId) {
      return jsonRequest({ ...ctx(), method: "DELETE", path: `/api/me/bots/${encodeURIComponent(botId)}` });
    },
    async listPlatformModels() {
      return jsonRequest({ ...ctx(), method: "GET", path: "/api/me/model-catalog" });
    },
    // Conversation ids are `dm:<a>:<b>` or `g_<hex>` — both match the cloud route
    // regex /api/conversations/([A-Za-z0-9_:-]+) literally. encodeURIComponent would
    // turn `:` into `%3A` which doesn't match and silently 404s, which is
    // why DM sends were being swallowed.
    async getConversation(conversationId) {
      return jsonRequest({ ...ctx(), method: "GET", path: `/api/conversations/${conversationId}` });
    },
    async listConversationMessages(conversationId, sinceSeq = 0, limit = 100) {
      return jsonRequest({ ...ctx(), method: "GET", path: `/api/conversations/${conversationId}/messages?since_seq=${Number(sinceSeq) || 0}&limit=${Number(limit) || 100}` });
    },
    async searchConversationMessages(query, limit = 80) {
      return jsonRequest({
        ...ctx({ timeoutMs: 20000 }),
        method: "GET",
        path: `/api/conversations/search?q=${encodeURIComponent(String(query || ""))}&limit=${Number(limit) || 80}`
      });
    },
    async postConversationMessage(conversationId, body) {
      return jsonRequest({ ...ctx(), method: "POST", path: `/api/conversations/${conversationId}/messages`, body: withOpId(body) });
    },
    async respondRunApproval(conversationId, runId, decision) {
      return jsonRequest({
        ...ctx(),
        method: "POST",
        path: `/api/conversations/${conversationId}/runs/${encodeURIComponent(runId)}/approval`,
        body: { decision }
      });
    },
    async cancelConversationRun(conversationId, runId) {
      return jsonRequest({
        ...ctx(),
        method: "POST",
        path: `/api/conversations/${conversationId}/runs/${encodeURIComponent(runId)}/cancel`,
        body: {}
      });
    },
    async deleteConversationMessage(conversationId, messageId) {
      return jsonRequest({ ...ctx(), method: "DELETE", path: `/api/conversations/${conversationId}/messages/${encodeURIComponent(messageId)}` });
    },
    async createConversation({ name, memberBots, memberFriendUserIds, clientGroupId } = {}) {
      // clientGroupId is the conversation-creation-specific idempotency key (links
      // a local group to its cloud counterpart); we still attach a generic
      // clientOpId so a *retry* of the same POST doesn't run twice even
      // when there's no clientGroupId provided. Both checks coexist on
      // the server.
      const body = { name, memberBots, memberFriendUserIds };
      if (clientGroupId) body.clientGroupId = clientGroupId;
      return jsonRequest({ ...ctx(), method: "POST", path: "/api/conversations", body: withOpId(body) });
    },
    async ensureBotConversation(botId, body = {}) {
      const id = String(botId || "").trim();
      if (!id) throw new Error("botId is required");
      return this.ensureBotSessionConversation(id, { ...body, botId: id });
    },
    async ensureBotSessionConversation(sessionId, body = {}) {
      const botId = String(body.botId || body.botKey || "").trim();
      return jsonRequest({
        ...ctx(),
        method: "PUT",
        path: `/api/me/bot-conversations/${encodeURIComponent(sessionId)}`,
        body: withOpId({ ...body, ...(botId ? { botId } : {}) })
      });
    },
    async getBotRuntime(botId, runtimeKind = "cloud-claude-code") {
      return jsonRequest({ ...ctx(), method: "GET", path: `/api/me/bots/${encodeURIComponent(botId)}/runtime?kind=${encodeURIComponent(runtimeKind)}` });
    },
    async saveBotRuntime(botId, body = {}) {
      const runtimeKind = String(body.runtimeKind || "cloud-claude-code").trim() || "cloud-claude-code";
      let requestBody = body;
      if (hasRuntimeConfigIntent(body)) {
        const current = await jsonRequest({
          ...ctx(),
          method: "GET",
          path: `/api/me/bots/${encodeURIComponent(botId)}/runtime?kind=${encodeURIComponent(runtimeKind)}`
        });
        requestBody = {
          ...body,
          config: runtimeConfigInputForRequest({
            body,
            existingConfig: current?.binding?.config || {}
          })
        };
      }
      return jsonRequest({
        ...ctx(),
        method: "PUT",
        path: `/api/me/bots/${encodeURIComponent(botId)}/runtime`,
        body: withOpId(requestBody)
      });
    },
    async listBridgeDevices({ includeOffline = false } = {}) {
      const query = includeOffline ? "?include=all" : "";
      return jsonRequest({ ...ctx(), method: "GET", path: `/api/bridge/devices${query}` });
    },
    async updateConversation(conversationId, patch) {
      return jsonRequest({ ...ctx(), method: "PATCH", path: `/api/conversations/${conversationId}`, body: patch || {} });
    },
    async deleteConversation(conversationId) {
      return jsonRequest({ ...ctx(), method: "DELETE", path: `/api/conversations/${conversationId}` });
    },
    async addConversationMember(conversationId, { memberKind, memberRef, ownerId }) {
      return jsonRequest({ ...ctx(), method: "POST", path: `/api/conversations/${conversationId}/members`, body: { memberKind, memberRef, ownerId } });
    },
    async removeConversationMember(conversationId, { memberKind, memberRef }) {
      return jsonRequest({ ...ctx(), method: "DELETE", path: `/api/conversations/${conversationId}/members`, body: { memberKind, memberRef } });
    },
    async postConversationMessageAsBot(conversationId, body) {
      return jsonRequest({ ...ctx(), method: "POST", path: `/api/conversations/${conversationId}/messages/as-bot`, body: withOpId(body) });
    }
  };
}

module.exports = { createSocialApi };
