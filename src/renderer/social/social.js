// Renderer-side social module: friends, DM rooms, add-friend dialog.
// Loaded by <script src="./social/social.js"> from index.html, BEFORE app.js.
// Pattern: same IIFE + window.aimashiSocial as group.js uses for window.aimashiGroup.

(function (global) {
  // Decision: cap initial-message fetch to 30 rooms to keep bootstrap fast.
  const INITIAL_ROOMS_CAP = 30;

  function unreadShared() {
    if (global.aimashiUnread) return global.aimashiUnread;
    if (typeof require !== "undefined") return require("../../shared/unread");
    throw new Error("aimashiUnread is not loaded");
  }

  function sendPipelineShared() {
    if (global.aimashiSendPipeline) return global.aimashiSendPipeline;
    if (typeof require !== "undefined") return require("../../shared/send-pipeline");
    throw new Error("aimashiSendPipeline is not loaded");
  }

  // Decision: singleton modal — create once, re-populate on open.
  // Avoids leaking DOM nodes on repeated opens.
  let _addFriendModal = null;
  let _createGroupModal = null;

  // Cache of room members per room id (fetched on first open, updated via WS events).
  const _roomMembersCache = new Map();

  const moduleState = {
    rooms: [],
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    messageCache: new Map(),
    activeRoomId: null,
    myUsername: "",
    myUserId: "",
    // unreadByRoom: roomId → count. Bumped by WS room.message_appended when
    // the message is from someone else and the room isn't currently open.
    // Cleared by setActiveRoomId (and on bootstrap — incomingRequests path
    // doesn't update this, only message activity does).
    unreadByRoom: new Map()
  };

  let deps = null;

  // ── helpers ───────────────────────────────────────────────────────────────

  function escapeHtml(value) {
    if (typeof window !== "undefined" && window.aimashiMarkdown && typeof window.aimashiMarkdown.escapeHtml === "function") {
      return window.aimashiMarkdown.escapeHtml(value);
    }
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function avatarColor(key) {
    // Derive a stable hex color from the room id using a simple hash.
    let hash = 0;
    const s = String(key || "dm");
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    const PALETTE = ["#5e5ce6", "#30b0c7", "#34c759", "#ff9f0a", "#ff3b30", "#af52de", "#007aff"];
    return PALETTE[hash % PALETTE.length];
  }

  // Parse dm:<a>:<b> and return the user-id that is NOT myUserId.
  function otherUserId(roomId) {
    if (!roomId || !roomId.startsWith("dm:")) return null;
    const parts = roomId.split(":");
    // format: dm:<uid_a>:<uid_b>
    const a = parts[1];
    const b = parts.slice(2).join(":");
    if (!a || !b) return null;
    return a === moduleState.myUserId ? b : a;
  }

  // Look up a friend object by userId.
  function friendById(userId) {
    return moduleState.friends.find((f) => f.id === userId) || null;
  }

  // Compute otherUser display info for a DM room.
  function otherUserForRoom(room) {
    const uid = otherUserId(room.id);
    if (!uid) return { id: "", username: room.name || room.id };
    const friend = friendById(uid);
    if (friend) return friend;
    return { id: uid, username: uid, account: uid };
  }

  // De-dup array of objects by id field.
  function dedup(arr, getId = (x) => x.id) {
    const seen = new Set();
    return arr.filter((item) => {
      const id = getId(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // Resolve "is this message from me?" through shared/contact (resolveContact
  // returns kind="self" only when ref matches ctx.self.id). Falls back to
  // false when the helper isn't loaded (test sandbox or pre-bootstrap).
  function _isMessageFromSelf(msg) {
    const helper = (typeof window !== "undefined" && window.aimashiContact) || null;
    if (!helper || typeof helper.resolveContact !== "function") return false;
    const { resolveContact, ContactKind } = helper;
    const contact = resolveContact(
      { kind: ContactKind.User, ref: msg && msg.sender_ref },
      { self: { id: moduleState.myUserId, username: moduleState.myUsername }, friends: moduleState.friends }
    );
    return contact && contact.kind === ContactKind.Self;
  }

  // Resolve "is this a user-role message?" by routing through the canonical
  // cloud-room-source adapter and reading spec.role. Falls back to false when
  // the adapter isn't loaded (test sandbox or pre-bootstrap).
  function _isUserRoleMessage(msg) {
    const factory = (typeof window !== "undefined" && window.aimashiCloudRoomSource) || null;
    if (!factory || typeof factory.createCloudRoomSource !== "function") return false;
    const room = moduleState.rooms.find((r) => r.id === moduleState.activeRoomId) || { id: moduleState.activeRoomId || "" };
    const ctx = { self: { id: moduleState.myUserId, username: moduleState.myUsername }, friends: moduleState.friends, fellows: [] };
    const source = factory.createCloudRoomSource({ room, messages: [msg], members: [], ctx });
    const spec = source.listMessages()[0];
    return !!spec && spec.role === "user";
  }

  // ── initSocialModule ──────────────────────────────────────────────────────

  function initSocialModule(d) {
    deps = d;
  }

  // ── bootstrapAfterLogin ───────────────────────────────────────────────────

  async function bootstrapAfterLogin() {
    if (!window.aimashi || !window.aimashi.social) {
      console.warn("[social] window.aimashi.social not available — skip bootstrap");
      return;
    }
    const api = window.aimashi.social;
    try {
      const [meRes, friendsRes, roomsRes, incomingRes, outgoingRes] = await Promise.all([
        api.myUsername(),
        api.listFriends(),
        api.listRooms(),
        api.listFriendRequests("incoming"),
        api.listFriendRequests("outgoing"),
      ]);
      if (meRes.ok) {
        moduleState.myUsername = meRes.data.username || "";
        moduleState.myUserId = meRes.data.id || "";
      }
      if (friendsRes.ok) moduleState.friends = friendsRes.data?.friends || [];
      if (roomsRes.ok) moduleState.rooms = roomsRes.data?.rooms || [];
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data?.requests || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data?.requests || [];

      // Phase 3: cross-device user settings (pin / read marks / appearance).
      await bootstrapCloudSettings();

      // Fetch initial messages for up to INITIAL_ROOMS_CAP rooms.
      const roomsToFetch = moduleState.rooms.slice(0, INITIAL_ROOMS_CAP);
      await Promise.all(roomsToFetch.map(async (room) => {
        if (!moduleState.messageCache.has(room.id)) {
          moduleState.messageCache.set(room.id, { messages: [], maxSeq: 0 });
        }
        try {
          const msgRes = await api.listRoomMessages(room.id, 0, 100);
          if (msgRes.ok) {
            const msgs = (msgRes.data?.messages || []).slice().sort((a, b) => a.seq - b.seq);
            const maxSeq = msgs.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0);
            moduleState.messageCache.set(room.id, { messages: msgs, maxSeq });
          }
        } catch (err) {
          console.warn("[social] listRoomMessages failed for", room.id, err);
        }
      }));
    } catch (err) {
      console.error("[social] bootstrapAfterLogin failed:", err);
    }
    if (deps && typeof deps.render === "function") deps.render();
  }

  // ── toast helper (used for new friend-request notifications) ────────────

  let _toastTimer = 0;
  function showFriendRequestToast(fromName) {
    const el = document.getElementById("appToast");
    if (!el) return;
    el.innerHTML = `
      <strong>新好友申请</strong>
      <span>${String(fromName || "").replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[ch]))} 想加你为好友</span>
      <button type="button" class="app-toast-action">查看</button>
    `;
    el.classList.remove("hidden");
    el.querySelector(".app-toast-action")?.addEventListener("click", () => {
      el.classList.add("hidden");
      openAddFriendDialog();
    }, { once: true });
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.add("hidden"), 6000);
  }

  // ── handleCloudEvent ──────────────────────────────────────────────────────

  function handleCloudEvent(event) {
    if (!event || !event.type) return;
    const { type, payload } = event;

    // Every time the WS reconnects (events_ready), re-pull authoritative
    // state from the cloud. Otherwise any social events that were
    // broadcast while we were disconnected stay invisible until restart.
    if (type === "events_ready") {
      bootstrapAfterLogin().catch((err) => console.warn("[social] rebootstrap on events_ready failed:", err));
      return;
    }

    // Phase 3: another device wrote settings — replace local cache so
    // pins / read marks / appearance match across devices in real time.
    // payload is the full envelope { type, settings, seq, ... }.
    if (type === "user_settings.updated") {
      const settings = payload && payload.settings ? payload.settings : null;
      if (settings) applyCloudSettings(settings);
      return;
    }

    if (type === "social.friend_request_received") {
      const req = payload && payload.request;
      if (!req) return;
      // De-dup
      const seen = moduleState.incomingRequests.find((r) => r.id === req.id);
      if (!seen) {
        moduleState.incomingRequests.push(req);
        const fromName = req.from?.username || req.from?.account || req.from_user || "陌生人";
        showFriendRequestToast(fromName);
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "social.friend_added") {
      const { friend, room } = payload || {};
      if (friend) {
        moduleState.friends = dedup([...moduleState.friends, friend]);
      }
      if (room) {
        moduleState.rooms = dedup([...moduleState.rooms, room]);
        if (!moduleState.messageCache.has(room.id)) {
          moduleState.messageCache.set(room.id, { messages: [], maxSeq: 0 });
        }
      }
      // Remove matching pending requests from both lists
      if (friend) {
        moduleState.outgoingRequests = moduleState.outgoingRequests.filter(
          (r) => r.to_user !== friend.id && r.to_user !== friend.username && r.to_user !== friend.account
        );
        moduleState.incomingRequests = moduleState.incomingRequests.filter(
          (r) => r.from_user !== friend.id && r.from_user !== friend.username && r.from_user !== friend.account
        );
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "room.message_appended") {
      const { roomId, message } = payload || {};
      if (!roomId || !message) return;
      if (!moduleState.messageCache.has(roomId)) {
        moduleState.messageCache.set(roomId, { messages: [], maxSeq: 0 });
      }
      const entry = moduleState.messageCache.get(roomId);
      // De-dup by id
      const fresh = !entry.messages.find((m) => m.id === message.id);
      if (fresh) {
        entry.messages.push(message);
        entry.messages.sort((a, b) => a.seq - b.seq);
      }
      if (message.seq > entry.maxSeq) entry.maxSeq = message.seq;

      // Unread bookkeeping: count messages that aren't mine and didn't land
      // in the currently open room.
      const isMine = _isMessageFromSelf(message);
      if (fresh && !isMine && roomId !== moduleState.activeRoomId) {
        moduleState.unreadByRoom.set(roomId, (moduleState.unreadByRoom.get(roomId) || 0) + 1);
      }

      // If this is the active room, append to DOM directly for snappy UX.
      if (roomId === moduleState.activeRoomId) {
        _appendMessageToActiveChat(message);
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "social.room_invited") {
      const { room } = payload || {};
      if (!room) return;
      moduleState.rooms = dedup([...moduleState.rooms, room]);
      if (!moduleState.messageCache.has(room.id)) {
        moduleState.messageCache.set(room.id, { messages: [], maxSeq: 0 });
      }
      // H2: Invalidate member cache so next mention parse refetches newly-added fellows
      _roomMembersCache.delete(room.id);
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    // PATCH /api/rooms/:id from any device. Merge the patched room back in
    // by id; broadcast originator includes ourselves so this also handles
    // multi-tab consistency.
    if (type === "room.updated") {
      const { room } = payload || {};
      if (!room || !room.id) return;
      moduleState.rooms = moduleState.rooms.map((r) => (r.id === room.id ? { ...r, ...room } : r));
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    // DELETE /api/rooms/:id from any device.
    if (type === "room.deleted") {
      const { roomId } = payload || {};
      if (!roomId) return;
      moduleState.rooms = moduleState.rooms.filter((r) => r.id !== roomId);
      moduleState.messageCache.delete(roomId);
      moduleState.unreadByRoom.delete(roomId);
      _roomMembersCache.delete(roomId);
      if (roomId === moduleState.activeRoomId) moduleState.activeRoomId = null;
      // Pin state is on cloud (Phase 3); the server side cascades on
      // room delete and pushes user_settings.updated, so no client-side
      // cleanup is needed here. Leftover pin entries (orphaned by a
      // room delete the server didn't broadcast for some reason) age
      // out at the next settings PUT or are tolerated harmlessly.
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "room.fellow_invocation_requested") {
      handleFellowInvocation(payload).catch((err) => {
        console.warn("[social] handleFellowInvocation error:", err?.message || err);
      });
      return;
    }
  }

  // ── renderSidebarRows ─────────────────────────────────────────────────────

  function renderSidebarRows() {
    return moduleState.rooms.map((room) => {
      const cacheEntry = moduleState.messageCache.get(room.id);
      const lastMsg = cacheEntry && cacheEntry.messages.length
        ? cacheEntry.messages[cacheEntry.messages.length - 1]
        : null;
      const lastMessagePreview = lastMsg ? String(lastMsg.body_md || "").slice(0, 80) : "";

      // updatedAt: prefer last message time if newer than room.updatedAt
      let updatedAt = room.updatedAt ? new Date(room.updatedAt).getTime() : 0;
      if (lastMsg && lastMsg.created_at) {
        const msgTs = new Date(lastMsg.created_at).getTime();
        if (msgTs > updatedAt) updatedAt = msgTs;
      }

      // Group rooms: id starts with "g_" or have a non-null name (cloud convention)
      const isGroup = room.name != null && room.id.startsWith("g_");
      if (isGroup) {
        const memberCount = (_roomMembersCache.get(room.id) || []).length;
        return {
          type: "group-room",
          key: room.id,
          pinned: false,
          pinnedAt: "",
          updatedAt,
          room: { ...room, lastMessagePreview, memberCount }
        };
      }

      const otherUser = otherUserForRoom(room);
      return {
        type: "dm-room",
        key: room.id,
        pinned: false,
        pinnedAt: "",
        updatedAt,
        room: { ...room, otherUser, lastMessagePreview }
      };
    });
  }

  // ── renderRoomChat ─────────────────────────────────────────────────────────

  function renderRoomChat(containerEl) {
    if (!containerEl) return;
    const roomId = moduleState.activeRoomId;
    if (!roomId) return;

    const entry = moduleState.messageCache.get(roomId) || { messages: [], maxSeq: 0 };
    const room = moduleState.rooms.find((r) => r.id === roomId);
    const color = avatarColor(roomId);
    const isGroup = room && room.name != null && roomId.startsWith("g_");

    containerEl.innerHTML = "";

    if (isGroup) {
      // Group room: show messages with sender attribution
      const members = _roomMembersCache.get(roomId) || [];
      for (const msg of entry.messages) {
        const article = _buildGroupMessageArticle(msg, color, members);
        if (article) containerEl.appendChild(article);
      }

      containerEl.scrollTop = containerEl.scrollHeight;

      const groupName = escapeHtml(room.name || "群聊");
      const memberCount = members.length;
      const nameEl = document.getElementById("activeChatName");
      if (nameEl) nameEl.textContent = room.name || "群聊";
      const metaEl = document.getElementById("activeChatMeta");
      if (metaEl) metaEl.textContent = memberCount ? `群聊 · ${memberCount} 人` : "群聊";
      const avatarEl = document.getElementById("activeChatAvatar");
      if (avatarEl) {
        avatarEl.textContent = (room.name || "G")[0].toUpperCase();
        avatarEl.className = "profile-avatar";
        avatarEl.style.cssText = "background-color:" + color + "; color:#fff;";
      }
      const groupInfoBtn = document.getElementById("groupInfoButton");
      if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
      const sessionMenuBtn = document.getElementById("sessionMenuButton");
      if (sessionMenuBtn) sessionMenuBtn.classList.add("hidden");
      const composerBottom = document.querySelector(".composer-bottom");
      if (composerBottom) composerBottom.classList.add("hidden");

      // Ensure members are cached for mention parsing
      if (!_roomMembersCache.has(roomId)) {
        _fetchAndCacheRoomMembers(roomId);
      }
      return;
    }

    // DM room path (unchanged)
    const otherUser = room ? otherUserForRoom(room) : { username: "好友" };
    const otherName = otherUser.username || otherUser.account || "好友";

    for (const msg of entry.messages) {
      const article = _buildMessageArticle(msg, color);
      if (article) containerEl.appendChild(article);
    }

    containerEl.scrollTop = containerEl.scrollHeight;

    const nameEl = document.getElementById("activeChatName");
    if (nameEl) nameEl.textContent = otherName;
    const metaEl = document.getElementById("activeChatMeta");
    if (metaEl) metaEl.textContent = "私聊";
    const avatarEl = document.getElementById("activeChatAvatar");
    if (avatarEl) {
      avatarEl.textContent = (otherName[0] || "?").toUpperCase();
      avatarEl.className = "profile-avatar";
      avatarEl.style.cssText = "background-color:" + color + "; color:#fff;";
    }
    const groupInfoBtn = document.getElementById("groupInfoButton");
    if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
    const sessionMenuBtn = document.getElementById("sessionMenuButton");
    if (sessionMenuBtn) sessionMenuBtn.classList.add("hidden");
    const composerBottom = document.querySelector(".composer-bottom");
    if (composerBottom) composerBottom.classList.add("hidden");
  }

  function _specForMessage(msg) {
    const factory = (typeof window !== "undefined" && window.aimashiCloudRoomSource) || null;
    if (!factory || typeof factory.createCloudRoomSource !== "function") return null;
    const room = moduleState.rooms.find((r) => r.id === moduleState.activeRoomId) || { id: moduleState.activeRoomId || "" };
    const ctx = { self: { id: moduleState.myUserId, username: moduleState.myUsername }, friends: moduleState.friends, fellows: [] };
    const source = factory.createCloudRoomSource({ room, messages: [msg], members: [], ctx });
    return source.listMessages()[0] || null;
  }

  // DM bubble mirrors fellow chat's renderMessageHtml shape EXACTLY so the
  // CSS targeting .message > .message-stack > .bubble paints it as a real
  // bubble. The bubble carries data-message-source="cloud-room" + a
  // data-message-id so the chat-level contextmenu dispatcher in app.js
  // routes to openSocialMessageMenu instead of the fellow message menu.
  function _buildMessageArticle(msg, accentColor) {
    const spec = _specForMessage(msg);
    const isUser = Boolean(spec && spec.isOwn);
    const roleClass = isUser ? "user" : "assistant";
    const authorName = spec ? spec.authorName : "";
    const avatar = (spec && spec.avatar) || { image: "", crop: null, color: "" };
    const avatarColor = avatar.color || accentColor || "#5e5ce6";
    const avatarHelpers = window.aimashiAvatar;
    const avatarStyle = (avatarHelpers && typeof avatarHelpers.avatarThumbBackgroundStyle === "function")
      ? avatarHelpers.avatarThumbBackgroundStyle(avatar.image, avatar.crop, avatarColor)
      : `background-color:${avatarColor};`;
    const avatarLetter = avatar.image ? "" : ((authorName || "?")[0] || "?").toUpperCase();
    const bodyHtml = _renderMsgBody((spec ? spec.bodyMd : msg.body_md) || "");
    const createdAt = msg.created_at || msg.createdAt || "";
    const timeHtml = createdAt
      ? `<time class="message-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(window.aimashiTimeFormat.formatMessageTime(createdAt))}</time>`
      : "";

    const cache = moduleState.messageCache.get(moduleState.activeRoomId);
    const messageIndex = cache ? cache.messages.findIndex((m) => m.id === msg.id) : -1;

    const article = document.createElement("article");
    article.className = `message ${roleClass}`;
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(avatarColor)};${avatarStyle}">${escapeHtml(avatarLetter)}</div>
      <div class="message-stack">
        <div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-room" data-message-id="${escapeHtml(msg.id || "")}">${bodyHtml}</div>
        ${timeHtml}
      </div>
    `;
    return article;
  }

  function _renderMsgBody(md) {
    if (typeof window !== "undefined" && window.aimashiMarkdown && typeof window.aimashiMarkdown.renderMarkdown === "function") {
      try { return window.aimashiMarkdown.renderMarkdown(md); } catch { /* fall through */ }
    }
    return escapeHtml(md);
  }

  function _appendMessageToActiveChat(msg) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;
    const room = moduleState.rooms.find((r) => r.id === moduleState.activeRoomId);
    const color = room ? avatarColor(room.id) : "#5e5ce6";
    const article = _buildMessageArticle(msg, color);
    if (article) {
      chatEl.appendChild(article);
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  }

  // ── group feature stubs — implementations in social-groups.js ───────────
  // social-groups.js is loaded after social.js and attaches itself via
  // window.aimashiSocialGroups.attach(ctx) where ctx is the shared internal
  // context exported below.

  function _buildGroupMessageArticle(msg, accentColor, members) {
    return window.aimashiSocialGroups?.buildGroupMessageArticle(msg, accentColor, members) || null;
  }

  function _fetchAndCacheRoomMembers(roomId) {
    return window.aimashiSocialGroups?.fetchAndCacheRoomMembers(roomId);
  }

  async function sendInActiveGroupRoom(text) {
    return window.aimashiSocialGroups?.sendInActiveGroupRoom(text);
  }

  async function handleFellowInvocation(payload) {
    return window.aimashiSocialGroups?.handleFellowInvocation(payload);
  }

  function openCreateGroupDialog() {
    return window.aimashiSocialGroups?.openCreateGroupDialog();
  }

  // ── openAddFriendDialog ───────────────────────────────────────────────────

  // Lightweight re-fetch of friend-request state (username + incoming +
  // outgoing) for the add-friend dialog. We call this on every dialog open
  // so users always see the latest server state even when the WS lost
  // events or bootstrapAfterLogin never ran (e.g., cloud login happened in
  // a previous app lifetime and the renderer never got a "loggedIn" tick).
  async function refreshFriendRequestState() {
    if (!window.aimashi || !window.aimashi.social) return false;
    const api = window.aimashi.social;
    try {
      const [meRes, incomingRes, outgoingRes] = await Promise.all([
        api.myUsername(),
        api.listFriendRequests("incoming"),
        api.listFriendRequests("outgoing"),
      ]);
      if (meRes.ok && meRes.data) {
        moduleState.myUsername = meRes.data.username || "";
        moduleState.myUserId = meRes.data.id || "";
      }
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data?.requests || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data?.requests || [];
      if (deps && typeof deps.render === "function") deps.render();
      return true;
    } catch (err) {
      console.warn("[social] refreshFriendRequestState failed:", err);
      return false;
    }
  }

  function openAddFriendDialog() {
    if (!document.body) return;
    if (!_addFriendModal) {
      _addFriendModal = document.createElement("section");
      _addFriendModal.className = "skill-preview-dialog hidden";
      _addFriendModal.setAttribute("role", "dialog");
      _addFriendModal.setAttribute("aria-modal", "true");
      document.body.appendChild(_addFriendModal);
    }

    // Define close() first so the close button rendered by _renderAddFriendModal
    // references this open's own teardown, not a stale handler from a prior open.
    function onEsc(e) {
      if (e.key === "Escape") { close(); }
    }
    function onBackdrop(e) {
      if (e.target === _addFriendModal) close();
    }
    function close() {
      _addFriendModal.classList.add("hidden");
      document.removeEventListener("keydown", onEsc);
      _addFriendModal.removeEventListener("click", onBackdrop);
    }
    // Assign before rendering so _renderAddFriendModal picks up the fresh closure.
    _addFriendModal._closeModal = close;

    // Render once immediately with whatever cached state we have so the
    // dialog feels responsive…
    _renderAddFriendModal(_addFriendModal);
    _addFriendModal.classList.remove("hidden");
    document.addEventListener("keydown", onEsc);
    _addFriendModal.addEventListener("click", onBackdrop);
    // …then re-fetch from the cloud and re-render. This is the safety net
    // for stale moduleState (WS dropped, bootstrap never fired, etc.).
    refreshFriendRequestState().then((ok) => {
      if (ok && !_addFriendModal.classList.contains("hidden")) {
        _renderAddFriendModal(_addFriendModal);
      }
    });
  }

  function _renderAddFriendModal(modal) {
    const closeModal = modal._closeModal || (() => modal.classList.add("hidden"));
    modal.innerHTML = "";

    const card = document.createElement("div");
    card.className = "skill-preview-card";
    card.style.cssText = "width:min(440px,calc(100vw - 68px)); height:auto; max-height:80vh; overflow-y:auto;";

    // Header
    const toolbar = document.createElement("div");
    toolbar.className = "skill-preview-toolbar";
    toolbar.innerHTML = `
      <div class="skill-preview-title"><h2>添加好友</h2></div>
    `;
    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-button";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeModal);
    toolbar.appendChild(closeBtn);
    card.appendChild(toolbar);

    const body = document.createElement("div");
    body.className = "group-create-body";

    // My username row
    const meSection = document.createElement("section");
    meSection.className = "group-create-section";
    const myUsernameDisplay = escapeHtml(moduleState.myUsername || "—");
    meSection.innerHTML = `
      <div class="group-create-section-header">
        <span class="group-create-section-title">我的用户名</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
        <span id="socialMyUsernameLabel" style="font-weight:600;">${myUsernameDisplay}</span>
        <button type="button" class="button-soft" id="socialCopyUsername" style="font-size:12px; padding:3px 8px;">复制</button>
      </div>
    `;
    body.appendChild(meSection);

    // Send request section
    const sendSection = document.createElement("section");
    sendSection.className = "group-create-section";
    sendSection.innerHTML = `
      <div class="group-create-section-header">
        <span class="group-create-section-title">发送好友请求</span>
      </div>
      <div style="display:flex; gap:8px; margin-top:6px;">
        <input id="socialAddUsernameInput" class="group-create-input" type="text" placeholder="对方的用户名" style="flex:1;">
        <button type="button" class="button-primary" id="socialSendRequestBtn">发送</button>
      </div>
      <p id="socialSendError" style="color:#ff3b30; font-size:13px; margin-top:4px; min-height:18px;"></p>
    `;
    body.appendChild(sendSection);

    // Incoming requests
    const incomingSection = document.createElement("section");
    incomingSection.className = "group-create-section";
    incomingSection.innerHTML = `<div class="group-create-section-header"><span class="group-create-section-title">收到的好友请求</span></div>`;
    const incomingList = document.createElement("div");
    incomingList.id = "socialIncomingList";
    _renderRequestList(incomingList, moduleState.incomingRequests, "incoming", modal);
    incomingSection.appendChild(incomingList);
    body.appendChild(incomingSection);

    // Outgoing requests
    const outgoingSection = document.createElement("section");
    outgoingSection.className = "group-create-section";
    outgoingSection.innerHTML = `<div class="group-create-section-header"><span class="group-create-section-title">我发出的请求</span></div>`;
    const outgoingList = document.createElement("div");
    outgoingList.id = "socialOutgoingList";
    _renderRequestList(outgoingList, moduleState.outgoingRequests, "outgoing", modal);
    outgoingSection.appendChild(outgoingList);
    body.appendChild(outgoingSection);

    card.appendChild(body);
    modal.appendChild(card);

    // Wire copy button
    card.querySelector("#socialCopyUsername")?.addEventListener("click", () => {
      try { navigator.clipboard.writeText(moduleState.myUsername || ""); } catch { /* ignore */ }
      const btn = card.querySelector("#socialCopyUsername");
      if (btn) { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1500); }
    });

    // Wire send button
    const sendBtn = card.querySelector("#socialSendRequestBtn");
    const usernameInput = card.querySelector("#socialAddUsernameInput");
    const errorEl = card.querySelector("#socialSendError");
    sendBtn?.addEventListener("click", async () => {
      const username = (usernameInput?.value || "").trim();
      if (!username) { if (errorEl) errorEl.textContent = "请输入用户名"; return; }
      if (errorEl) errorEl.textContent = "";
      sendBtn.disabled = true;
      try {
        const res = await window.aimashi.social.sendFriendRequest(username);
        if (!res.ok) {
          if (errorEl) errorEl.textContent = res.error || "发送失败";
          return;
        }
        if (usernameInput) usernameInput.value = "";
        // Refresh outgoing list
        const outRes = await window.aimashi.social.listFriendRequests("outgoing");
        if (outRes.ok) moduleState.outgoingRequests = outRes.data?.requests || [];
        // Re-render modal sections
        const oList = card.querySelector("#socialOutgoingList");
        if (oList) _renderRequestList(oList, moduleState.outgoingRequests, "outgoing", modal);
      } catch (err) {
        if (errorEl) errorEl.textContent = String(err && err.message ? err.message : err);
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  function _renderRequestList(container, requests, direction, modal) {
    container.innerHTML = "";
    if (!requests.length) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:var(--fg-muted,#888); font-size:13px; margin:6px 0;";
      empty.textContent = direction === "incoming" ? "暂无收到的请求" : "暂无发出的请求";
      container.appendChild(empty);
      return;
    }
    for (const req of requests) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border,rgba(0,0,0,.08));";

      // Cloud REST hydrates the request with `other` (the user on the
      // opposite end). Live WS events use `from` instead — accept either.
      const otherUser = req.other || req.from || {};
      const fallbackId = direction === "incoming" ? req.from_user : req.to_user;
      const displayName = escapeHtml(
        otherUser.username || otherUser.account || fallbackId || "—"
      );
      const nameSpan = document.createElement("span");
      nameSpan.style.cssText = "flex:1; font-weight:500;";
      nameSpan.innerHTML = displayName;
      row.appendChild(nameSpan);

      if (direction === "incoming") {
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "button-primary";
        acceptBtn.style.cssText = "font-size:12px; padding:3px 10px;";
        acceptBtn.textContent = "同意";
        acceptBtn.addEventListener("click", async () => {
          acceptBtn.disabled = true;
          try {
            const res = await window.aimashi.social.respondFriendRequest(req.id, "accept");
            if (!res.ok) { acceptBtn.disabled = false; return; }
            moduleState.incomingRequests = moduleState.incomingRequests.filter((r) => r.id !== req.id);
            // Re-render
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { acceptBtn.disabled = false; }
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "button-soft";
        rejectBtn.style.cssText = "font-size:12px; padding:3px 10px;";
        rejectBtn.textContent = "拒绝";
        rejectBtn.addEventListener("click", async () => {
          rejectBtn.disabled = true;
          try {
            const res = await window.aimashi.social.respondFriendRequest(req.id, "reject");
            if (!res.ok) { rejectBtn.disabled = false; return; }
            moduleState.incomingRequests = moduleState.incomingRequests.filter((r) => r.id !== req.id);
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { rejectBtn.disabled = false; }
        });

        row.appendChild(acceptBtn);
        row.appendChild(rejectBtn);
      } else {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "button-soft";
        cancelBtn.style.cssText = "font-size:12px; padding:3px 10px;";
        cancelBtn.textContent = "撤回";
        cancelBtn.addEventListener("click", async () => {
          cancelBtn.disabled = true;
          try {
            const res = await window.aimashi.social.cancelFriendRequest(req.id);
            if (!res.ok) { cancelBtn.disabled = false; return; }
            moduleState.outgoingRequests = moduleState.outgoingRequests.filter((r) => r.id !== req.id);
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { cancelBtn.disabled = false; }
        });
        row.appendChild(cancelBtn);
      }

      container.appendChild(row);
    }
  }

  // ── DM send: called by app.js when a DM room is active ───────────────────

  async function sendInActiveRoom(text) {
    const roomId = moduleState.activeRoomId;
    if (!roomId) return;
    const members = _roomMembersCache.get(roomId) || [];
    let prepared;
    try {
      prepared = sendPipelineShared().prepareOutgoingMessage({ text }, { members });
    } catch (err) {
      if (err && err.code === "EMPTY_MESSAGE") return;
      console.warn("[social] sendInActiveRoom prepare failed:", err?.message || err);
      return;
    }
    try {
      const res = await window.aimashi.social.postRoomMessage(roomId, {
        bodyMd: prepared.bodyMd,
        ...(prepared.mentions.length ? { mentions: prepared.mentions } : {})
      });
      if (!res.ok) {
        console.warn("[social] postRoomMessage failed:", res.error);
        return;
      }
      // If WS event doesn't arrive within 500ms, optimistically append from response.
      const sentMsg = res.data?.message;
      if (!sentMsg || !sentMsg.id) return; // server didn't return a message somehow — skip optimistic
      if (sentMsg) {
        setTimeout(() => {
          const entry = moduleState.messageCache.get(roomId);
          if (entry && !entry.messages.find((m) => m.id === sentMsg.id)) {
            entry.messages.push(sentMsg);
            entry.messages.sort((a, b) => a.seq - b.seq);
            if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
            if (roomId === moduleState.activeRoomId) _appendMessageToActiveChat(sentMsg);
            if (deps && typeof deps.render === "function") deps.render();
          }
        }, 500);
      }
    } catch (err) {
      console.warn("[social] sendInActiveRoom error:", err);
    }
  }

  // ── getters / setters ─────────────────────────────────────────────────────

  function getActiveRoomId() { return moduleState.activeRoomId; }
  function setActiveRoomId(id) {
    moduleState.activeRoomId = id || null;
    if (id) moduleState.unreadByRoom.delete(id);
  }
  function markRoomRead(roomId) {
    if (!roomId) return;
    moduleState.unreadByRoom.delete(roomId);
    // Phase 3: stamp a read mark on cloud user_settings so other devices
    // also clear the unread badge. The mark stores the last room.maxSeq
    // we've read (used for incremental unread reconstruction when a
    // device reconnects).
    const cache = moduleState.messageCache.get(roomId);
    const lastSeq = cache && Number.isFinite(Number(cache.maxSeq)) ? Number(cache.maxSeq) : 0;
    const s = _ensureCloudSettings();
    const nextReadMarks = { ...(s.readMarks || {}), [roomId]: lastSeq };
    moduleState.cloudSettings = { ...s, readMarks: nextReadMarks };
    // Fire-and-forget — failure is non-blocking; reconnect replay will
    // bring the latest state.
    window.aimashi?.social?.settingsPut?.({ pins: s.pins, readMarks: nextReadMarks, appearance: s.appearance })
      .catch((err) => console.warn("[social] mark-read settingsPut failed:", err?.message || err));
  }

  // Phase 3: pin state lives in cloud user_settings (server-canonical).
  // Renderer holds a cached copy in moduleState.cloudSettings; it's
  // populated by bootstrapCloudSettings() at login and refreshed on each
  // user_settings.updated WS event. Mutations PUT via IPC and the
  // broadcast confirms / replaces the optimistic update.
  function _ensureCloudSettings() {
    if (!moduleState.cloudSettings) moduleState.cloudSettings = { pins: [], readMarks: {}, appearance: {} };
    return moduleState.cloudSettings;
  }
  function isRoomPinned(roomId) {
    if (!roomId) return false;
    const s = _ensureCloudSettings();
    return Array.isArray(s.pins) && s.pins.includes(roomId);
  }
  async function setRoomPinned(roomId, pinned) {
    if (!roomId) return;
    const s = _ensureCloudSettings();
    const current = Array.isArray(s.pins) ? s.pins : [];
    const next = pinned ? [...new Set([...current, roomId])] : current.filter((id) => id !== roomId);
    // Optimistic: render with new value, then push to cloud.
    moduleState.cloudSettings = { ...s, pins: next };
    if (deps && typeof deps.render === "function") deps.render();
    try {
      const updated = await window.aimashi.social.settingsPut({ pins: next, readMarks: s.readMarks, appearance: s.appearance });
      if (updated && Array.isArray(updated.pins)) {
        // Replace with server-confirmed truth.
        moduleState.cloudSettings = updated;
      }
    } catch (err) {
      console.warn("[social] settingsPut failed:", err?.message || err);
      // Roll back optimistic if server rejected.
      moduleState.cloudSettings = s;
      if (deps && typeof deps.render === "function") deps.render();
    }
  }

  async function bootstrapCloudSettings() {
    try {
      const settings = await window.aimashi.social.settingsGet();
      if (settings && typeof settings === "object") {
        moduleState.cloudSettings = {
          pins: Array.isArray(settings.pins) ? settings.pins : [],
          readMarks: settings.readMarks && typeof settings.readMarks === "object" ? settings.readMarks : {},
          appearance: settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {}
        };
        if (deps && typeof deps.render === "function") deps.render();
      }
    } catch (err) {
      console.warn("[social] settingsGet failed:", err?.message || err);
    }
  }

  function applyCloudSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    moduleState.cloudSettings = {
      pins: Array.isArray(settings.pins) ? settings.pins : [],
      readMarks: settings.readMarks && typeof settings.readMarks === "object" ? settings.readMarks : {},
      appearance: settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {}
    };
    if (deps && typeof deps.render === "function") deps.render();
  }

  // PATCH /api/rooms/:id — rename the cloud room (groups only; DM rename
  // is rejected server-side because DM display name is derived from the
  // peer's profile). Optimistically updates local rooms list; the
  // room.updated WS event will reconcile from canonical state.
  async function renameRoom(roomId, name) {
    if (!roomId || !name) return { ok: false, error: "missing arg" };
    const res = await window.aimashi.social.updateRoom(roomId, { name });
    if (res?.ok && res.data?.room) {
      const room = res.data.room;
      moduleState.rooms = moduleState.rooms.map((r) => (r.id === room.id ? { ...r, ...room } : r));
      if (deps && typeof deps.render === "function") deps.render();
    }
    return res;
  }

  // DELETE /api/rooms/:id — remove the cloud room. Server cascades members
  // + messages. WS room.deleted will sync other tabs; this also cleans up
  // local state immediately.
  async function deleteCloudRoom(roomId) {
    if (!roomId) return { ok: false, error: "missing arg" };
    const res = await window.aimashi.social.deleteRoom(roomId);
    if (res?.ok) {
      moduleState.rooms = moduleState.rooms.filter((r) => r.id !== roomId);
      moduleState.messageCache.delete(roomId);
      moduleState.unreadByRoom.delete(roomId);
      _roomMembersCache.delete(roomId);
      if (roomId === moduleState.activeRoomId) moduleState.activeRoomId = null;
      // Pin state is server-canonical now; cleanup happens via
      // user_settings.updated broadcast.
      if (deps && typeof deps.render === "function") deps.render();
    }
    return res;
  }
  function getUnreadForRoom(roomId) {
    return unreadShared().computeUnreadForConversation({ id: roomId }, moduleState.unreadByRoom);
  }
  function getTotalRoomUnread() {
    return unreadShared().totalUnreadFromConversations(null, moduleState.unreadByRoom);
  }
  // Expose the cached room member list so app.js can build a composite
  // avatar for cloud group rooms via the same path as local fellow groups.
  function getRoomMembers(roomId) { return _roomMembersCache.get(roomId) || null; }

  // ── exports ───────────────────────────────────────────────────────────────

  // Shared context exposed for social-groups.js to consume.
  const _internalCtx = {
    get moduleState() { return moduleState; },
    get deps() { return deps; },
    roomMembersCache: _roomMembersCache,
    escapeHtml,
    avatarColor,
    dedup,
    friendById,
    renderMsgBody: _renderMsgBody,
    appendMessageToActiveChat: _appendMessageToActiveChat
  };

  global.aimashiSocial = {
    moduleState,
    initSocialModule,
    bootstrapAfterLogin,
    handleCloudEvent,
    renderSidebarRows,
    renderRoomChat,
    openAddFriendDialog,
    openCreateGroupDialog,
    sendInActiveRoom,
    sendInActiveGroupRoom,
    getActiveRoomId,
    setActiveRoomId,
    markRoomRead,
    isRoomPinned,
    setRoomPinned,
    applyCloudSettings,
    renameRoom,
    deleteCloudRoom,
    getUnreadForRoom,
    getTotalRoomUnread,
    getRoomMembers,
    friendById,
    _internalCtx
  };
})(typeof window !== "undefined" ? window : globalThis);
