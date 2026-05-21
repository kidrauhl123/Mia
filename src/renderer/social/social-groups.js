// Renderer-side group-room feature: group message rendering, @mention send,
// fellow invocation handler, and the create-group dialog.
// Loaded by <script src="./social/social-groups.js"> AFTER social.js.
// Uses window.aimashiSocial._internalCtx to share state.

(function (global) {
  let ctx = null; // set by attach()

  // H1: dedup set to prevent double-invocation on repeated WS events
  const _processedInvocations = new Set();
  const PROCESSED_INVOCATIONS_CAP = 256;

  function attach(internalCtx) {
    ctx = internalCtx;
  }

  // ── group message article (with sender attribution) ───────────────────────

  function buildGroupMessageArticle(msg, accentColor, members) {
    const { moduleState, escapeHtml, renderMsgBody } = ctx;
    const article = document.createElement("article");
    const isOwn = msg.sender_kind === "user" && msg.sender_ref === moduleState.myUserId;
    article.className = "message " + (isOwn ? "user" : "assistant");
    const bodyHtml = renderMsgBody(msg.body_md || "");
    const color = isOwn ? "#111827" : (accentColor || "#5e5ce6");

    let senderLabel = "";
    if (msg.sender_kind === "user") {
      const friend = ctx.friendById(msg.sender_ref) || { username: msg.sender_ref };
      senderLabel = escapeHtml(friend.username || msg.sender_ref || "");
    } else if (msg.sender_kind === "fellow") {
      const m = (members || []).find((mem) => mem.member_kind === "fellow" && mem.member_ref === msg.sender_ref);
      // M1: prefer enriched owner object from server, fallback to legacy fields
      const ownerUsername = m ? (m.owner?.username || m.owner?.account || m.owner_username || m.owner_id || "") : "";
      senderLabel = escapeHtml(msg.sender_ref || "") + (ownerUsername ? escapeHtml(` (${ownerUsername})`) : "");
    }

    const initial = isOwn
      ? (moduleState.myUsername[0] || "M").toUpperCase()
      : (msg.sender_ref ? msg.sender_ref[0].toUpperCase() : "?");
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(color)}; color:#fff;">${escapeHtml(initial)}</div>
      <div class="message-stack">
        ${senderLabel ? `<div style="font-size:11px; color:var(--fg-muted,#888); margin-bottom:2px;">${senderLabel}</div>` : ""}
        <div class="bubble">${bodyHtml}</div>
      </div>
    `;
    return article;
  }

  async function fetchAndCacheRoomMembers(roomId) {
    if (!window.aimashi || !window.aimashi.social) return;
    try {
      const res = await window.aimashi.social.getRoom(roomId);
      if (res.ok && res.data && Array.isArray(res.data.members)) {
        ctx.roomMembersCache.set(roomId, res.data.members);
      }
    } catch (err) {
      console.warn("[social-groups] fetchAndCacheRoomMembers failed:", roomId, err?.message || err);
    }
  }

  // ── group send: parse @mentions and POST to cloud ─────────────────────────

  // M2: mention regex broadened to cover fellow ids with -, ., _
  const MENTION_REGEX = /@([A-Za-z0-9_.-]+)/g;

  async function sendInActiveGroupRoom(text) {
    const { moduleState, deps, roomMembersCache, appendMessageToActiveChat } = ctx;
    const roomId = moduleState.activeRoomId;
    if (!roomId || !text) return;
    const members = roomMembersCache.get(roomId) || [];

    const mentionPattern = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
    let match;
    const mentions = [];
    while ((match = mentionPattern.exec(text)) !== null) {
      const word = match[1];
      const m = members.find((mem) => mem.member_kind === "fellow" && mem.member_ref === word);
      if (m) mentions.push({ kind: "fellow", fellowId: word });
    }

    try {
      const res = await window.aimashi.social.postRoomMessage(roomId, {
        bodyMd: text,
        ...(mentions.length ? { mentions } : {})
      });
      if (!res.ok) {
        console.warn("[social-groups] sendInActiveGroupRoom failed:", res.error);
        return;
      }
      const sentMsg = res.data?.message;
      if (!sentMsg || !sentMsg.id) return;
      setTimeout(() => {
        const entry = moduleState.messageCache.get(roomId);
        if (entry && !entry.messages.find((m) => m.id === sentMsg.id)) {
          entry.messages.push(sentMsg);
          entry.messages.sort((a, b) => a.seq - b.seq);
          if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
          if (roomId === moduleState.activeRoomId) appendMessageToActiveChat(sentMsg);
          if (deps && typeof deps.render === "function") deps.render();
        }
      }, 500);
    } catch (err) {
      console.warn("[social-groups] sendInActiveGroupRoom error:", err);
    }
  }

  // ── handleFellowInvocation ────────────────────────────────────────────────

  async function handleFellowInvocation(payload) {
    // H1: dedup by triggeringMessage.id to prevent double AI invocation on repeated WS events
    const triggerId = payload && payload.triggeringMessage && payload.triggeringMessage.id;
    if (!triggerId) return;
    if (_processedInvocations.has(triggerId)) return;
    _processedInvocations.add(triggerId);
    // Cap the set so it doesn't grow unboundedly
    if (_processedInvocations.size > PROCESSED_INVOCATIONS_CAP) {
      const first = _processedInvocations.values().next().value;
      _processedInvocations.delete(first);
    }

    const { deps } = ctx;
    const { roomId, fellowId, invokedBy, triggeringMessage, recentMessages } = payload || {};
    if (!roomId || !fellowId) return;

    const state = deps ? deps.getState() : {};
    const fellow = (state.runtime?.fellows || state.runtime?.personas || []).find(
      (f) => (f.key || f.id) === fellowId
    );
    if (!fellow) {
      console.warn("[social-groups] fellow_invocation_requested for unknown fellow:", fellowId);
      return;
    }

    const contextLines = (recentMessages || []).map((m) => {
      if (m.sender_kind === "user") return `[user:${m.sender_ref}] ${m.body_md}`;
      if (m.sender_kind === "fellow") return `[fellow:${m.sender_ref}] ${m.body_md}`;
      return `[system] ${m.body_md}`;
    }).join("\n");

    const invokerName = (invokedBy && (invokedBy.username || invokedBy.account || invokedBy.id)) || "someone";
    const systemPrompt = `你是 ${fellow.name || fellowId}，正在一个跨用户群聊里。最近的消息上下文：\n${contextLines}\n\n刚刚 ${invokerName} 在群里 @ 了你。请用自然的口吻接话，简短直接。`;
    const userPrompt = (triggeringMessage && triggeringMessage.body_md) || "";

    let responseText;
    try {
      const result = await window.aimashi.sendChatStateless({
        fellowKey: fellowId,
        systemPrompt,
        userPrompt
      });
      responseText = (result && typeof result.content === "string" ? result.content : "").trim();
    } catch (err) {
      console.warn("[social-groups] fellow invocation engine call failed:", err?.message || err);
      return;
    }
    if (!responseText) return;

    try {
      const postRes = await window.aimashi.social.postRoomMessageAsFellow(roomId, {
        fellowId,
        bodyMd: responseText,
        turnId: (triggeringMessage && triggeringMessage.turn_id) || null
      });
      if (!postRes.ok) {
        console.warn("[social-groups] post-as-fellow failed:", postRes.error);
      }
    } catch (err) {
      console.warn("[social-groups] post-as-fellow error:", err?.message || err);
    }
  }

  // ── openCreateGroupDialog ─────────────────────────────────────────────────

  let _createGroupModal = null;

  function openCreateGroupDialog() {
    if (!document.body) return;
    if (!_createGroupModal) {
      _createGroupModal = document.createElement("section");
      _createGroupModal.className = "skill-preview-dialog hidden";
      _createGroupModal.setAttribute("role", "dialog");
      _createGroupModal.setAttribute("aria-modal", "true");
      document.body.appendChild(_createGroupModal);
    }

    function onEsc(e) { if (e.key === "Escape") close(); }
    function onBackdrop(e) { if (e.target === _createGroupModal) close(); }
    function close() {
      _createGroupModal.classList.add("hidden");
      document.removeEventListener("keydown", onEsc);
      _createGroupModal.removeEventListener("click", onBackdrop);
    }
    _createGroupModal._closeModal = close;

    _renderCreateGroupModal(_createGroupModal);
    _createGroupModal.classList.remove("hidden");
    document.addEventListener("keydown", onEsc);
    _createGroupModal.addEventListener("click", onBackdrop);
  }

  function _renderCreateGroupModal(modal) {
    const { moduleState, deps, roomMembersCache, dedup, escapeHtml } = ctx;
    const closeModal = modal._closeModal || (() => modal.classList.add("hidden"));
    modal.innerHTML = "";

    const card = document.createElement("div");
    card.className = "skill-preview-card";
    card.style.cssText = "width:min(480px,calc(100vw - 68px)); height:auto; max-height:85vh; overflow-y:auto;";

    const toolbar = document.createElement("div");
    toolbar.className = "skill-preview-toolbar";
    toolbar.innerHTML = `<div class="skill-preview-title"><h2>新建群聊</h2></div>`;
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

    // Group name input
    const nameSection = document.createElement("section");
    nameSection.className = "group-create-section";
    nameSection.innerHTML = `
      <div class="group-create-section-header"><span class="group-create-section-title">群名</span></div>
      <input id="cgGroupNameInput" class="group-create-input" type="text" maxlength="80" placeholder="输入群聊名称（必填）" style="width:100%; margin-top:6px;">
    `;
    body.appendChild(nameSection);

    // Select friends section
    const friendsSection = document.createElement("section");
    friendsSection.className = "group-create-section";
    const friendsHeader = document.createElement("div");
    friendsHeader.className = "group-create-section-header";
    friendsHeader.innerHTML = `<span class="group-create-section-title">选择朋友</span>`;
    friendsSection.appendChild(friendsHeader);
    const friendsList = document.createElement("div");
    friendsList.id = "cgFriendsList";
    if (moduleState.friends.length === 0) {
      friendsList.innerHTML = `<p style="color:var(--fg-muted,#888); font-size:13px; margin:6px 0;">暂无好友</p>`;
    } else {
      for (const friend of moduleState.friends) {
        const row = document.createElement("label");
        row.style.cssText = "display:flex; align-items:center; gap:8px; padding:5px 0; cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = friend.id;
        cb.dataset.kind = "friend";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = friend.username || friend.account || friend.id;
        row.appendChild(cb);
        row.appendChild(nameSpan);
        friendsList.appendChild(row);
      }
    }
    friendsSection.appendChild(friendsList);
    body.appendChild(friendsSection);

    // Select own fellows section
    const fellowsSection = document.createElement("section");
    fellowsSection.className = "group-create-section";
    const fellowsHeader = document.createElement("div");
    fellowsHeader.className = "group-create-section-header";
    fellowsHeader.innerHTML = `<span class="group-create-section-title">拉自己的 Fellow</span>`;
    fellowsSection.appendChild(fellowsHeader);
    const fellowsList = document.createElement("div");
    fellowsList.id = "cgFellowsList";
    const localFellows = deps ? (deps.getState().runtime?.fellows || deps.getState().runtime?.personas || []) : [];
    if (localFellows.length === 0) {
      fellowsList.innerHTML = `<p style="color:var(--fg-muted,#888); font-size:13px; margin:6px 0;">暂无本地 Fellow</p>`;
    } else {
      for (const fellow of localFellows) {
        const row = document.createElement("label");
        row.style.cssText = "display:flex; align-items:center; gap:8px; padding:5px 0; cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = fellow.key || fellow.id;
        cb.dataset.kind = "fellow";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = fellow.name || fellow.key || fellow.id;
        row.appendChild(cb);
        row.appendChild(nameSpan);
        fellowsList.appendChild(row);
      }
    }
    fellowsSection.appendChild(fellowsList);
    body.appendChild(fellowsSection);

    // Error + create button
    const errorEl = document.createElement("p");
    errorEl.id = "cgError";
    errorEl.style.cssText = "color:#ff3b30; font-size:13px; margin:6px 0; min-height:18px;";
    body.appendChild(errorEl);

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "button-primary";
    createBtn.style.cssText = "width:100%; margin-top:8px;";
    createBtn.textContent = "创建";
    createBtn.addEventListener("click", async () => {
      const nameInput = card.querySelector("#cgGroupNameInput");
      const name = (nameInput?.value || "").trim();
      if (!name) { errorEl.textContent = "请输入群名"; return; }
      if (name.length > 80) { errorEl.textContent = "群名不能超过 80 个字符"; return; }

      const checkedFriends = Array.from(card.querySelectorAll("#cgFriendsList input[type=checkbox]:checked")).map((cb) => cb.value);
      const checkedFellows = Array.from(card.querySelectorAll("#cgFellowsList input[type=checkbox]:checked")).map((cb) => cb.value);

      errorEl.textContent = "";
      createBtn.disabled = true;
      try {
        const res = await window.aimashi.social.createRoom({
          name,
          memberFellows: checkedFellows.map((fid) => ({ fellowId: fid })),
          memberFriendUserIds: checkedFriends
        });
        if (!res.ok) { errorEl.textContent = res.error || "创建失败"; return; }
        const newRoom = res.data?.room || res.data;
        if (newRoom && newRoom.id) {
          moduleState.rooms = dedup([...moduleState.rooms, newRoom]);
          if (!moduleState.messageCache.has(newRoom.id)) {
            moduleState.messageCache.set(newRoom.id, { messages: [], maxSeq: 0 });
          }
          if (res.data?.members && Array.isArray(res.data.members)) {
            roomMembersCache.set(newRoom.id, res.data.members);
          }
          closeModal();
          if (deps && typeof deps.render === "function") deps.render();
        } else {
          errorEl.textContent = "创建失败：无效响应";
        }
      } catch (err) {
        errorEl.textContent = String(err?.message || err);
      } finally {
        createBtn.disabled = false;
      }
    });
    body.appendChild(createBtn);

    card.appendChild(body);
    modal.appendChild(card);
  }

  // ── wire up to aimashiSocial ──────────────────────────────────────────────

  global.aimashiSocialGroups = {
    attach,
    buildGroupMessageArticle,
    fetchAndCacheRoomMembers,
    sendInActiveGroupRoom,
    handleFellowInvocation,
    openCreateGroupDialog
  };

  // Auto-attach if aimashiSocial already loaded (normal script order: social.js first).
  if (global.aimashiSocial && global.aimashiSocial._internalCtx) {
    attach(global.aimashiSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);
