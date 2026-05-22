const { fetch } = globalThis;

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
      return jsonFetch({ ...ctx(), method: "POST", path: "/api/social/friend-requests", body: { toUsername } });
    },
    async respondFriendRequest(requestId, action) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/social/friend-requests/${encodeURIComponent(requestId)}/respond`, body: { action } });
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
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/rooms/${roomId}/messages`, body });
    },
    async createRoom({ name, memberFellows, memberFriendUserIds }) {
      return jsonFetch({ ...ctx(), method: "POST", path: "/api/rooms", body: { name, memberFellows, memberFriendUserIds } });
    },
    async addRoomMember(roomId, { memberKind, memberRef, ownerId }) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/rooms/${roomId}/members`, body: { memberKind, memberRef, ownerId } });
    },
    async postRoomMessageAsFellow(roomId, body) {
      return jsonFetch({ ...ctx(), method: "POST", path: `/api/rooms/${roomId}/messages/as-fellow`, body });
    }
  };
}

module.exports = { createSocialApi };
