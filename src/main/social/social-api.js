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
    const message = (payload && payload.error) || `Aimashi Cloud ${response.status}`;
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
      throw new Error("Aimashi Cloud not logged in.");
    }
    return {
      baseUrl: normalizeUrl(settings.url),
      token: settings.token,
      ...opts
    };
  }
  return {
    async sendFriendRequest(toUsername) {
      return jsonFetch({ ...ctx(), method: "POST", path: "/api/social/friend-requests", body: withOpId({ toUsername }) });
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
    async listRooms() {
      return jsonFetch({ ...ctx(), method: "GET", path: "/api/rooms" });
    },
    // Room ids are `dm:<a>:<b>` or `g_<hex>` — both match the cloud route
    // regex /api/rooms/([A-Za-z0-9_:-]+) literally. encodeURIComponent would
    // turn `:` into `%3A` which doesn't match and silently 404s, which is
    // why DM sends were being swallowed.
    async getRoom(roomId) {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/rooms/${roomId}` });
    },
    async listRoomMessages(roomId, sinceSeq = 0, limit = 100) {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/rooms/${roomId}/messages?since_seq=${Number(sinceSeq) || 0}&limit=${Number(limit) || 100}` });
    },
    async postRoomMessage(roomId, body) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/rooms/${roomId}/messages`, body: withOpId(body) });
    },
    async deleteRoomMessage(roomId, messageId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/rooms/${roomId}/messages/${encodeURIComponent(messageId)}` });
    },
    async createRoom({ name, memberFellows, memberFriendUserIds, clientGroupId } = {}) {
      // clientGroupId is the room-creation-specific idempotency key (links
      // a local group to its cloud counterpart); we still attach a generic
      // clientOpId so a *retry* of the same POST doesn't run twice even
      // when there's no clientGroupId provided. Both checks coexist on
      // the server.
      const body = { name, memberFellows, memberFriendUserIds };
      if (clientGroupId) body.clientGroupId = clientGroupId;
      return jsonFetch({ ...ctx(), method: "POST", path: "/api/rooms", body: withOpId(body) });
    },
    async ensureFellowRoom(fellowId, body = {}) {
      return jsonFetch({ ...ctx(), method: "PUT", path: `/api/me/fellows/${encodeURIComponent(fellowId)}/room`, body: withOpId(body) });
    },
    async getFellowRuntime(fellowId, runtimeKind = "cloud-hermes") {
      return jsonFetch({ ...ctx(), method: "GET", path: `/api/me/fellows/${encodeURIComponent(fellowId)}/runtime?kind=${encodeURIComponent(runtimeKind)}` });
    },
    async saveFellowRuntime(fellowId, body = {}) {
      return jsonFetch({ ...ctx(), method: "PUT", path: `/api/me/fellows/${encodeURIComponent(fellowId)}/runtime`, body: withOpId(body) });
    },
    async updateRoom(roomId, patch) {
      return jsonFetch({ ...ctx(), method: "PATCH", path: `/api/rooms/${roomId}`, body: patch || {} });
    },
    async deleteRoom(roomId) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/rooms/${roomId}` });
    },
    async addRoomMember(roomId, { memberKind, memberRef, ownerId }) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/rooms/${roomId}/members`, body: { memberKind, memberRef, ownerId } });
    },
    async removeRoomMember(roomId, { memberKind, memberRef }) {
      return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/rooms/${roomId}/members`, body: { memberKind, memberRef } });
    },
    async postRoomMessageAsFellow(roomId, body) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/rooms/${roomId}/messages/as-fellow`, body: withOpId(body) });
    }
  };
}

module.exports = { createSocialApi };
