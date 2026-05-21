// Renderer-side social module: friends, DM rooms, add-friend dialog.
// Loaded by <script src="./social/social.js"> from index.html, BEFORE app.js.
// Pattern: same IIFE + window.aimashiSocial as group.js uses for window.aimashiGroup.

(function (global) {
  // Decision: cap initial-message fetch to 30 rooms to keep bootstrap fast.
  const INITIAL_ROOMS_CAP = 30;

  // Decision: singleton modal — create once, re-populate on open.
  // Avoids leaking DOM nodes on repeated opens.
  let _addFriendModal = null;

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
      if (friendsRes.ok) moduleState.friends = friendsRes.data || [];
      if (roomsRes.ok) moduleState.rooms = roomsRes.data || [];
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data || [];

      // Fetch initial messages for up to INITIAL_ROOMS_CAP rooms.
      const roomsToFetch = moduleState.rooms.slice(0, INITIAL_ROOMS_CAP);
      await Promise.all(roomsToFetch.map(async (room) => {
        if (!moduleState.messageCache.has(room.id)) {
          moduleState.messageCache.set(room.id, { messages: [], maxSeq: 0 });
        }
        try {
          const msgRes = await api.listRoomMessages(room.id, 0, 100);
          if (msgRes.ok && Array.isArray(msgRes.data)) {
            const msgs = msgRes.data.slice().sort((a, b) => a.seq - b.seq);
            const maxSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;
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

  // ── handleCloudEvent ──────────────────────────────────────────────────────

  function handleCloudEvent(event) {
    if (!event || !event.type) return;
    const { type, payload } = event;

    if (type === "social.friend_request_received") {
      const req = payload && payload.request;
      if (!req) return;
      // De-dup
      if (!moduleState.incomingRequests.find((r) => r.id === req.id)) {
        moduleState.incomingRequests.push(req);
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
    }
  }

  // ── renderSidebarRows ─────────────────────────────────────────────────────

  function renderSidebarRows() {
    return moduleState.rooms.map((room) => {
      const otherUser = otherUserForRoom(room);
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
    const otherUser = room ? otherUserForRoom(room) : { username: "好友" };
    const otherName = otherUser.username || otherUser.account || "好友";
    const color = avatarColor(roomId);

    containerEl.innerHTML = "";

    // Minimal wrapper that mimics the chat layout structure.
    // We replace the #chat contents (keeping the outer shell), so we write
    // directly into the scrollable chat area.

    for (const msg of entry.messages) {
      const article = _buildMessageArticle(msg, color);
      if (article) containerEl.appendChild(article);
    }

    containerEl.scrollTop = containerEl.scrollHeight;

    // Wire the existing composer send button for DM rooms.
    // Decision: reuse the app-level chatInput / sendChat form so we don't
    // need to inject a separate input into the chat area. The composer is
    // already present. We just override the send path in the form submit
    // handler, which lives in app.js — see the sendChat override injected
    // via deps.setDmSendOverride (if present). Without that hook we still
    // let the event fire and app.js gracefully ignores it (no session).
    //
    // Topbar update: we reach into the DOM directly (same pattern as group).
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

  // ── openAddFriendDialog ───────────────────────────────────────────────────

  function openAddFriendDialog() {
    if (!document.body) return;
    if (!_addFriendModal) {
      _addFriendModal = document.createElement("section");
      _addFriendModal.className = "skill-preview-dialog hidden";
      _addFriendModal.setAttribute("role", "dialog");
      _addFriendModal.setAttribute("aria-modal", "true");
      document.body.appendChild(_addFriendModal);
    }
    _renderAddFriendModal(_addFriendModal);
    _addFriendModal.classList.remove("hidden");

    function onEsc(e) {
      if (e.key === "Escape") { closeModal(); }
    }
    function onBackdrop(e) {
      if (e.target === _addFriendModal) closeModal();
    }
    function closeModal() {
      _addFriendModal.classList.add("hidden");
      document.removeEventListener("keydown", onEsc);
      _addFriendModal.removeEventListener("click", onBackdrop);
    }
    // Store closeModal so _renderAddFriendModal can wire close button
    _addFriendModal._closeModal = closeModal;
    document.addEventListener("keydown", onEsc);
    _addFriendModal.addEventListener("click", onBackdrop);
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
        if (outRes.ok) moduleState.outgoingRequests = outRes.data || [];
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
      const sentMsg = res.data;
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

  global.aimashiSocial = {
    moduleState,
    initSocialModule,
    bootstrapAfterLogin,
    handleCloudEvent,
    renderSidebarRows,
    renderRoomChat,
    openAddFriendDialog,
    sendInActiveRoom,
    getActiveRoomId,
    setActiveRoomId
  };
})(typeof window !== "undefined" ? window : globalThis);
