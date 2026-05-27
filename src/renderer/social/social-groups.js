// Renderer-side group-conversation feature: group message rendering, @mention send,
// and the create-group dialog.
// Loaded by <script src="./social/social-groups.js"> AFTER social.js.
// Uses window.miaSocial._internalCtx to share state.

(function (global) {
  const { MemberKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../../shared/conversation-kinds");

  let ctx = null; // set by attach()

  function attach(internalCtx) {
    ctx = internalCtx;
  }

  // Build the adapter-facing ctx ({ self, fellows, friends }) from
  // social's internal ctx + the renderer's runtime state. All cloud-conversation
  // sender resolution must go through this; raw cloud-message schema fields
  // (sender kind / member kind / refs) are off-limits to this file —
  // consume MessageSpec from cloud-conversation-source.js instead.
  function _adapterCtx() {
    if (ctx && typeof ctx.adapterCtx === "function") return ctx.adapterCtx();
    const { moduleState, deps } = ctx;
    const runtimeState = deps && typeof deps.getState === "function" ? deps.getState() : {};
    const fellows = runtimeState.runtime?.fellows || runtimeState.runtime?.personas || [];
    return {
      self: { id: moduleState.myUserId || "", username: moduleState.myUsername || "" },
      fellows,
      friends: moduleState.friends || []
    };
  }

  function _cloudConversationSourceFor(conversationId, msgs, members) {
    const factory = global.miaCloudConversationSource;
    if (!factory || typeof factory.createCloudConversationSource !== "function") return null;
    return factory.createCloudConversationSource({
      conversation: { id: conversationId },
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
    const conversationId = moduleState.activeConversationId || "";
    const source = _cloudConversationSourceFor(conversationId, [msg], members);
    const spec = source ? source.listMessages()[0] : null;
    const isOwn = Boolean(spec && spec.isOwn);
    const roleClass = isOwn ? "user" : "assistant";
    const authorName = spec ? spec.authorName : "";
    const senderLabel = isOwn ? "" : (authorName || "");
    const avatar = (spec && spec.avatar) || { image: "", crop: null, color: "" };
    const avatarColor = avatar.color || accentColor || "#5e5ce6";
    const avatarHelpers = window.miaAvatar;
    const avatarLetter = avatar.image ? "" : ((authorName || "?")[0] || "?").toUpperCase();
    const avatarHtml = avatarHelpers?.avatarHtml
      ? avatarHelpers.avatarHtml({
        className: "avatar message-avatar",
        image: avatar.image,
        crop: avatar.crop,
        color: avatarColor,
        text: avatarLetter,
        attrs: `data-sender-kind="${escapeHtml(msg.sender_kind || "")}" data-sender-ref="${escapeHtml(msg.sender_ref || "")}" title="${escapeHtml(spec?.authorName || "")}"`
      })
      : `<div class="avatar message-avatar" data-sender-kind="${escapeHtml(msg.sender_kind || "")}" data-sender-ref="${escapeHtml(msg.sender_ref || "")}" style="background-color:${escapeHtml(avatarColor)};" title="${escapeHtml(spec?.authorName || "")}">${escapeHtml(avatarLetter)}</div>`;
    const bodyHtml = renderMsgBody((spec ? spec.bodyMd : msg.body_md) || "");
    const attachmentHtml = typeof ctx.renderAttachmentChips === "function"
      ? ctx.renderAttachmentChips(spec?.attachments || msg.attachments || [])
      : "";
    const sendStatusHtml = typeof ctx.renderSendStatus === "function"
      ? ctx.renderSendStatus(msg)
      : "";
    const createdAt = msg.created_at || msg.createdAt || "";
    const timeHtml = createdAt
      ? `<time class="message-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(window.miaTimeFormat.formatMessageTime(createdAt))}</time>`
      : "";

    // Index in the conversation's message cache — used by the chat-level contextmenu
    // dispatcher in app.js to look up the message for the floating menu.
    const cache = moduleState.messageCache.get(conversationId);
    const messageIndex = cache ? cache.messages.findIndex((m) => m.id === msg.id) : -1;

    // In-place translation block (same .message-translation markup as 1-on-1).
    const t = msg && msg.translation;
    let translationHtml = "";
    if (t) {
      const status = t.status || (t.text ? "done" : "");
      if (status === "loading") {
        translationHtml = `<div class="message-translation"><div class="message-translation-head"><span>译文</span></div><p class="message-translation-muted">正在翻译...</p></div>`;
      } else if (status === "error") {
        translationHtml = `<div class="message-translation"><div class="message-translation-head"><span>译文</span></div><p class="message-translation-error">${escapeHtml(t.error || "翻译失败")}</p></div>`;
      } else {
        translationHtml = `<div class="message-translation"><div class="message-translation-head"><span>译文</span></div><div class="message-translation-body">${renderMsgBody(t.text || "")}</div></div>`;
      }
    }

    const article = document.createElement("article");
    article.className = `message ${roleClass}`;
    article.innerHTML = `
      ${avatarHtml}
      <div class="message-stack">
        ${senderLabel ? `<span class="message-sender">${escapeHtml(senderLabel)}</span>` : ""}
        <div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${bodyHtml}</div>
        ${attachmentHtml}
        ${translationHtml}
        ${timeHtml}
        ${sendStatusHtml}
      </div>
    `;
    return article;
  }

  async function fetchAndCacheConversationMembers(conversationId) {
    if (!window.mia || !window.mia.social) return;
    try {
      const res = await window.mia.social.getConversation(conversationId);
      if (res.ok && res.data && Array.isArray(res.data.members)) {
        ctx.conversationMembersCache.set(conversationId, res.data.members);
      }
    } catch (err) {
      console.warn("[social-groups] fetchAndCacheConversationMembers failed:", conversationId, err?.message || err);
    }
  }

  // ── group send ────────────────────────────────────────────────────────────
  // Message sending is intentionally owned by social.js so cloud DM, fellow,
  // and group conversations share one optimistic-send/reconcile pipeline.

  async function sendInActiveGroupConversation(text) {
    if (global.miaSocial && typeof global.miaSocial.sendInActiveConversation === "function") {
      return global.miaSocial.sendInActiveConversation(text);
    }
    console.warn("[social-groups] unified social send path is unavailable");
  }

  // ── openCreateGroupDialog ─────────────────────────────────────────────────
  // Reuses the existing #groupCreateDialog DOM (rail #1's UI). Members are a
  // single mixed list of friends + own fellows — the frontend treats them as
  // unified "contacts"; the kind tag is only needed when posting to /api/conversations.

  function openCreateGroupDialog() {
    const dialog = document.getElementById("groupCreateDialog");
    if (!dialog) {
      console.error("[social-groups] groupCreateDialog DOM missing");
      return;
    }
    const { moduleState, deps, conversationMembersCache, dedup } = ctx;
    const membersBox = document.getElementById("groupCreateMembers");
    const hostSection = document.getElementById("groupCreateHost")?.closest(".group-create-section");
    const nameInput = document.getElementById("groupCreateName");
    const countEl = document.getElementById("groupCreateCount");
    const confirmBtn = document.getElementById("groupCreateConfirm");
    const cancelBtn = document.getElementById("groupCreateCancel");
    const closeBtn = document.getElementById("groupCreateClose");

    const MAX_MEMBERS = 5;
    const selected = new Map(); // key `${kind}:${id}` → { kind, id, name }

    // Cloud conversations have no "host fellow" concept — hide that section while open.
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
      window.miaAvatar.paintAvatar(avatarEl, entry);

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
    // Fellows come from the canonical adapter ctx (cloud + local merged via
    // miaFellowDirectory). Reading runtime.fellows directly dropped cloud
    // fellows (e.g. mia, whose agent runs in the cloud) from the picker.
    membersBox.innerHTML = "";
    const { friends, fellows: ownedFellows } = _adapterCtx();

    if (friends.length === 0 && ownedFellows.length === 0) {
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
    for (const fellow of ownedFellows) {
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
        // Phase 5 cutover: every group is a cloud conversation. Login required.
        const memberFellows = fellowEntries.map((e) => ({ fellowId: e.id }));
        const res = await window.mia.social.createConversation({ name, memberFellows, memberFriendUserIds });
        if (!res.ok) { alert("创建失败：" + (res.error || "")); confirmBtn.disabled = false; return; }
        const newConversation = res.data?.conversation || res.data;
        if (newConversation && newConversation.id) {
          moduleState.conversations = dedup([...moduleState.conversations, newConversation]);
          if (!moduleState.messageCache.has(newConversation.id)) {
            moduleState.messageCache.set(newConversation.id, { messages: [], maxSeq: 0 });
          }
          if (res.data?.members && Array.isArray(res.data.members)) {
            conversationMembersCache.set(newConversation.id, res.data.members);
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

  // ── wire up to miaSocial ──────────────────────────────────────────────

  global.miaSocialGroups = {
    attach,
    buildGroupMessageArticle,
    fetchAndCacheConversationMembers,
    sendInActiveGroupConversation,
    openCreateGroupDialog
  };

  // Auto-attach if miaSocial already loaded (normal script order: social.js first).
  if (global.miaSocial && global.miaSocial._internalCtx) {
    attach(global.miaSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);
