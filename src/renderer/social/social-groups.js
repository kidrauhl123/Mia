// Renderer-side group-room feature: group message rendering, @mention send,
// fellow invocation handler, and the create-group dialog.
// Loaded by <script src="./social/social-groups.js"> AFTER social.js.
// Uses window.aimashiSocial._internalCtx to share state.

(function (global) {
  const { MemberKind } = (typeof window !== "undefined" && window.aimashiConversationKinds) || require("../../shared/conversation-kinds");

  let ctx = null; // set by attach()

  // H1: dedup set to prevent double-invocation on repeated WS events
  const _processedInvocations = new Set();
  const PROCESSED_INVOCATIONS_CAP = 256;

  function attach(internalCtx) {
    ctx = internalCtx;
  }

  // Build the adapter-facing ctx ({ self, fellows, friends }) from
  // social's internal ctx + the renderer's runtime state. All cloud-room
  // sender resolution must go through this; raw cloud-message schema fields
  // (sender kind / member kind / refs) are off-limits to this file —
  // consume MessageSpec from cloud-room-source.js instead.
  function _adapterCtx() {
    const { moduleState, deps } = ctx;
    const runtimeState = deps && typeof deps.getState === "function" ? deps.getState() : {};
    const fellows = runtimeState.runtime?.fellows || runtimeState.runtime?.personas || [];
    return {
      self: { id: moduleState.myUserId || "", username: moduleState.myUsername || "" },
      fellows,
      friends: moduleState.friends || []
    };
  }

  function _cloudRoomSourceFor(roomId, msgs, members) {
    const factory = global.aimashiCloudRoomSource;
    if (!factory || typeof factory.createCloudRoomSource !== "function") return null;
    return factory.createCloudRoomSource({
      room: { id: roomId },
      messages: msgs,
      members: members || [],
      ctx: _adapterCtx()
    });
  }

  // ── group message article (with sender attribution) ───────────────────────

  // Group bubble mirrors fellow chat's renderMessageHtml shape EXACTLY
  // (same .avatar div, .message-stack, .bubble with data-message-index +
  // data-message-source, message-time after bubble). This is what the
  // existing CSS expects; deviating produces "bubble that isn't a bubble".
  function buildGroupMessageArticle(msg, accentColor, members) {
    const { moduleState, escapeHtml, renderMsgBody } = ctx;
    const roomId = moduleState.activeRoomId || "";
    const source = _cloudRoomSourceFor(roomId, [msg], members);
    const spec = source ? source.listMessages()[0] : null;
    const isOwn = Boolean(spec && spec.isOwn);
    const roleClass = isOwn ? "user" : "assistant";
    const authorName = spec ? spec.authorName : "";
    const senderLabel = isOwn ? "" : (authorName || "");
    const avatar = (spec && spec.avatar) || { image: "", crop: null, color: "" };
    const avatarColor = avatar.color || accentColor || "#5e5ce6";
    const avatarHelpers = window.aimashiAvatar;
    const avatarStyle = (avatarHelpers && typeof avatarHelpers.avatarThumbBackgroundStyle === "function")
      ? avatarHelpers.avatarThumbBackgroundStyle(avatar.image, avatar.crop, avatarColor)
      : `background-color:${avatarColor};`;
    const avatarLetter = avatar.image ? "" : ((authorName || "?")[0] || "?").toUpperCase();
    const bodyHtml = renderMsgBody((spec ? spec.bodyMd : msg.body_md) || "");
    const createdAt = msg.created_at || msg.createdAt || "";
    const timeHtml = createdAt
      ? `<time class="message-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(window.aimashiTimeFormat.formatMessageTime(createdAt))}</time>`
      : "";

    // Index in the room's message cache — used by the chat-level contextmenu
    // dispatcher in app.js to look up the message for the floating menu.
    const cache = moduleState.messageCache.get(roomId);
    const messageIndex = cache ? cache.messages.findIndex((m) => m.id === msg.id) : -1;

    const article = document.createElement("article");
    article.className = `message ${roleClass}`;
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(avatarColor)};${avatarStyle}">${escapeHtml(avatarLetter)}</div>
      <div class="message-stack">
        ${senderLabel ? `<span class="message-sender">${escapeHtml(senderLabel)}</span>` : ""}
        <div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-room" data-message-id="${escapeHtml(msg.id || "")}">${bodyHtml}</div>
        ${timeHtml}
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

    // Mention resolution lives in the cloud-room adapter — see resolveMention
    // there. social-groups must not crack open the member list itself.
    const source = _cloudRoomSourceFor(roomId, [], members);
    const mentionPattern = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
    let match;
    const mentions = [];
    while ((match = mentionPattern.exec(text)) !== null) {
      const word = match[1];
      const resolved = source && typeof source.resolveMention === "function"
        ? source.resolveMention(word)
        : null;
      if (resolved) mentions.push(resolved);
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

    // Build context lines from the cloud-room adapter's MessageSpec output
    // instead of inspecting raw cloud schema fields here.
    const members = ctx.roomMembersCache.get(roomId) || [];
    const ctxSource = _cloudRoomSourceFor(roomId, recentMessages || [], members);
    const specs = ctxSource ? ctxSource.listMessages() : [];
    const contextLines = specs.map((s) => {
      const tag = s.role === "assistant"
        ? `fellow:${s.authorName}`
        : (s.role === "system" ? "system" : `user:${s.authorName}`);
      return `[${tag}] ${s.bodyMd}`;
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
  // Reuses the existing #groupCreateDialog DOM (rail #1's UI). Members are a
  // single mixed list of friends + own fellows — the frontend treats them as
  // unified "contacts"; the kind tag is only needed when posting to /api/rooms.

  function openCreateGroupDialog() {
    const dialog = document.getElementById("groupCreateDialog");
    if (!dialog) {
      console.error("[social-groups] groupCreateDialog DOM missing");
      return;
    }
    const { moduleState, deps, roomMembersCache, dedup } = ctx;
    const membersBox = document.getElementById("groupCreateMembers");
    const hostSection = document.getElementById("groupCreateHost")?.closest(".group-create-section");
    const nameInput = document.getElementById("groupCreateName");
    const countEl = document.getElementById("groupCreateCount");
    const confirmBtn = document.getElementById("groupCreateConfirm");
    const cancelBtn = document.getElementById("groupCreateCancel");
    const closeBtn = document.getElementById("groupCreateClose");

    const MAX_MEMBERS = 5;
    const selected = new Map(); // key `${kind}:${id}` → { kind, id, name }

    // Cloud rooms have no "host fellow" concept — hide that section while open.
    const prevHostDisplay = hostSection ? hostSection.style.display : "";
    if (hostSection) hostSection.style.display = "none";

    function refreshCount() {
      if (countEl) countEl.textContent = String(selected.size);
      if (confirmBtn) confirmBtn.disabled = selected.size < 1;
    }

    function buildRow(entry) {
      const key = `${entry.kind}:${entry.id}`;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group-create-member-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.dataset.memberKey = key;

      const avatarEl = document.createElement("span");
      avatarEl.className = "member-avatar";
      if (entry.image && typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function") {
        avatarEl.style.cssText = window.aimashiAvatar.avatarThumbBackgroundStyle(entry.image, entry.crop, entry.color);
      } else {
        avatarEl.style.background = entry.color;
      }

      const nameEl = document.createElement("span");
      nameEl.className = "member-name";
      nameEl.textContent = entry.name;

      const checkEl = document.createElement("span");
      checkEl.className = "member-check";
      checkEl.setAttribute("aria-hidden", "true");

      row.appendChild(avatarEl);
      row.appendChild(nameEl);
      row.appendChild(checkEl);

      row.addEventListener("click", () => {
        if (selected.has(key)) {
          selected.delete(key);
          row.classList.remove("is-selected");
          row.setAttribute("aria-selected", "false");
        } else {
          if (selected.size >= MAX_MEMBERS) return;
          selected.set(key, entry);
          row.classList.add("is-selected");
          row.setAttribute("aria-selected", "true");
        }
        refreshCount();
      });
      return row;
    }

    // Build mixed contact list: friends + own fellows in a single section.
    membersBox.innerHTML = "";
    const friends = moduleState.friends || [];
    const localFellows = deps ? (deps.getState().runtime?.fellows || deps.getState().runtime?.personas || []) : [];

    if (friends.length === 0 && localFellows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "group-create-members-empty";
      empty.textContent = "还没有联系人";
      membersBox.appendChild(empty);
    }
    for (const friend of friends) {
      membersBox.appendChild(buildRow({
        kind: "friend",
        id: friend.id,
        name: friend.username || friend.account || friend.id,
        color: "#34c759"
      }));
    }
    for (const fellow of localFellows) {
      const id = fellow.key || fellow.id;
      membersBox.appendChild(buildRow({
        kind: "fellow",
        id,
        name: fellow.name || id,
        color: fellow.color || "#5e5ce6",
        image: fellow.avatarImage,
        crop: fellow.avatarCrop
      }));
    }

    nameInput.value = "";
    refreshCount();
    dialog.classList.remove("hidden");
    setTimeout(() => { try { membersBox.querySelector(".group-create-member-row")?.focus(); } catch {} }, 0);

    function close() {
      dialog.classList.add("hidden");
      if (hostSection) hostSection.style.display = prevHostDisplay;
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onClose);
      closeBtn.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onEsc);
      dialog.removeEventListener("click", onBackdropClick);
    }
    function onClose() { close(); }
    function onEsc(e) { if (e.key === "Escape") close(); }
    function onBackdropClick(e) { if (e.target === dialog) close(); }

    async function onConfirm() {
      if (selected.size < 1) { alert("至少选择 1 位联系人"); return; }

      const entries = Array.from(selected.values());
      const name = (nameInput.value || "").trim() || entries.map((e) => e.name).join(" · ");
      const memberFriendUserIds = entries.filter((e) => e.kind === "friend").map((e) => e.id);
      const fellowEntries = entries.filter((e) => e.kind === MemberKind.Fellow);

      confirmBtn.disabled = true;
      try {
        // Phase 5 cutover: every group is a cloud room. Login required.
        const memberFellows = fellowEntries.map((e) => ({ fellowId: e.id }));
        const res = await window.aimashi.social.createRoom({ name, memberFellows, memberFriendUserIds });
        if (!res.ok) { alert("创建失败：" + (res.error || "")); confirmBtn.disabled = false; return; }
        const newRoom = res.data?.room || res.data;
        if (newRoom && newRoom.id) {
          moduleState.rooms = dedup([...moduleState.rooms, newRoom]);
          if (!moduleState.messageCache.has(newRoom.id)) {
            moduleState.messageCache.set(newRoom.id, { messages: [], maxSeq: 0 });
          }
          if (res.data?.members && Array.isArray(res.data.members)) {
            roomMembersCache.set(newRoom.id, res.data.members);
          }
          close();
          if (deps && typeof deps.render === "function") deps.render();
        } else {
          alert("创建失败：无效响应");
          confirmBtn.disabled = false;
        }
      } catch (err) {
        alert("创建失败：" + (err?.message || err));
        confirmBtn.disabled = false;
      }
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onClose);
    closeBtn.addEventListener("click", onClose);
    document.addEventListener("keydown", onEsc);
    dialog.addEventListener("click", onBackdropClick);
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
