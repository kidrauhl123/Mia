// Renderer-side social module: friends, DM rooms, add-friend dialog.
// Loaded by <script src="./social/social.js"> from index.html, BEFORE app.js.
// Pattern: same IIFE + window.aimashiSocial as group.js uses for window.aimashiGroup.

(function (global) {
  // Decision: cap initial-message fetch to 30 rooms to keep bootstrap fast.
  const INITIAL_ROOMS_CAP = 30;

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
    myUserId: ""
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
      if (!entry.messages.find((m) => m.id === message.id)) {
        entry.messages.push(message);
        entry.messages.sort((a, b) => a.seq - b.seq);
      }
      if (message.seq > entry.maxSeq) entry.maxSeq = message.seq;

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

  function _buildMessageArticle(msg, accentColor) {
    const article = document.createElement("article");
    const isUser = msg.sender_kind === "user";
    article.className = "message " + (isUser ? "user" : "assistant");
    const bodyHtml = _renderMsgBody(msg.body_md || "");
    const color = isUser ? "#111827" : (accentColor || "#5e5ce6");
    const initial = isUser ? "B" : "?";
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(color)}; color:#fff;">${isUser ? "" : escapeHtml(initial)}</div>
      <div class="message-stack"><div class="bubble">${bodyHtml}</div></div>
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

      const fromUser = req.from || {};
      const displayName = escapeHtml(
        direction === "incoming"
          ? (fromUser.username || fromUser.account || req.from_user || "—")
          : (req.to_user || "—")
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
    if (!roomId || !text) return;
    try {
      const res = await window.aimashi.social.postRoomMessage(roomId, { bodyMd: text });
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
  function setActiveRoomId(id) { moduleState.activeRoomId = id || null; }

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
    _internalCtx
  };
})(typeof window !== "undefined" ? window : globalThis);
