// Group info / settings dialog for cloud group conversations.
// Replaces the local-group openInfoDialog deleted in Phase 5. Every field
// here writes through PATCH /api/conversations/:id (top-level name; everything
// else goes into decorations) or /api/conversations/:id/members for membership.
//
// Fields:
//   - 群头像 (decorations.avatar = { image, crop }) — uses the shared
//     avatar-crop editor; reverting "恢复默认" clears the override so the
//     sidebar mosaic renders again.
//   - 群名 (conversation.name)
//   - 群目标 (decorations.pinnedGoal) — shown to the conductor's
//     dispatch prompt as the group summary fallback.
//   - 群主 (decorations.hostMember = { kind: "fellow", fellowId })
//   - 成员管理 (POST/DELETE /api/conversations/:id/members)
//   - 重置群上下文 (decorations.contextCard = null)

(function (global) {
  "use strict";

  const { MemberKind } = (typeof window !== "undefined" && window.miaConversationKinds)
    || require("../../shared/conversation-kinds");

  let _ctx = null;
  let _activeConversationId = null;
  let _pendingAvatarApply = null;

  function attach(internalCtx) { _ctx = internalCtx; }

  function escapeHtml(value) {
    return global.miaMarkdown?.escapeHtml?.(value)
      ?? String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]));
  }

  function applyTilesToButton(buttonEl, conversation, members) {
    if (!buttonEl) return;
    const slot = buttonEl.querySelector(".avatar");
    if (!slot) return;
    const custom = conversation?.decorations?.avatar;
    if (custom && custom.image) {
      slot.className = "avatar";
      global.miaAvatar.paintAvatar(slot, { image: custom.image, crop: custom.crop, color: "#5e5ce6" });
      slot.removeAttribute("data-count");
      return;
    }
    slot.className = "avatar group-avatar";
    slot.style.cssText = "";
    const tiles = global.miaGroupTiles.resolveGroupMemberTiles(members || [], groupTilesCtx());
    global.miaGroupAvatar.applyGroupAvatar(slot, tiles);
  }

  function groupTilesCtx() {
    // Canonical identity/avatar context (self + cloud&local fellows + friends +
    // avatarAssetForKey), shared with cloud-conversation message rendering. Group
    // tiles need exactly this shape, so reuse it rather than re-deriving self/
    // fellows here — re-deriving dropped cloud fellows and a usable self avatar.
    return _ctx.adapterCtx();
  }

  // —— field writes ——

  async function patchDecorations(conversation, patch) {
    const decorations = { ...(conversation.decorations || {}), ...patch };
    const res = await global.mia.social.updateConversation(conversation.id, { decorations });
    if (!res.ok) {
      console.warn("[group-info] PATCH decorations failed:", res.error);
      return null;
    }
    return res.data?.conversation || res.data || null;
  }

  async function patchName(conversation, name) {
    const res = await global.mia.social.updateConversation(conversation.id, { name });
    if (!res.ok) {
      alert("保存群名失败：" + (res.error || ""));
      return null;
    }
    return res.data?.conversation || res.data || null;
  }

  // —— render ——

  function fellowNameFor(member, fellows) {
    if (member.fellow_name) return member.fellow_name;
    const f = (fellows || []).find((x) => (x.id || x.key) === member.member_ref);
    return f?.name || member.member_ref;
  }

  function fellowAvatarFor(member, fellows) {
    const color = global.miaMemberColor.memberAccentColor(member.member_ref);
    if (member.fellow_avatar_image) {
      return { image: member.fellow_avatar_image, crop: member.fellow_avatar_crop, color };
    }
    const f = (fellows || []).find((x) => (x.id || x.key) === member.member_ref);
    return {
      image: f?.avatarImage || global.miaAvatar?.avatarAssetForKey?.(member.member_ref),
      crop: f?.avatarCrop,
      color
    };
  }

  function userNameFor(member, friends, self) {
    if (member.member_ref === self?.id) return self?.username || "我";
    const friend = (friends || []).find((f) => f.id === member.member_ref);
    return friend?.username || friend?.account || member.member_ref;
  }

  function renderMembersSection(box, conversation, members, fellows, friends, self) {
    box.innerHTML = "";
    const hostFellowId = conversation.decorations?.hostMember?.fellowId || null;
    const fellowMembers = members.filter((m) => m.member_kind === MemberKind.Fellow);
    for (const member of members) {
      const row = document.createElement("div");
      row.className = "group-info-member-row";
      const main = document.createElement("span");
      main.className = "group-info-member-main";
      const avatarEl = document.createElement("span");
      avatarEl.className = "member-avatar";
      let label = "";
      let isHost = false;
      let avatar;
      if (member.member_kind === MemberKind.Fellow) {
        label = fellowNameFor(member, fellows);
        avatar = fellowAvatarFor(member, fellows);
        isHost = member.member_ref === hostFellowId;
      } else {
        label = userNameFor(member, friends, self);
        // Resolve user avatar (self or friend) through the canonical contact
        // resolver — server members carry no user avatar, only fellow_avatar_image.
        avatar = global.miaContact.resolveContact(
          { kind: global.miaContact.ContactKind.User, ref: member.member_ref },
          { self, friends }
        ).avatar;
      }
      global.miaAvatar.paintAvatar(avatarEl, avatar);
      const nameEl = document.createElement("span");
      nameEl.className = "group-info-member-name";
      nameEl.textContent = label;
      if (isHost) {
        const badge = document.createElement("span");
        badge.className = "group-info-host-badge";
        badge.textContent = "群主";
        nameEl.appendChild(badge);
      }
      main.appendChild(avatarEl);
      main.appendChild(nameEl);
      row.appendChild(main);

      const actions = document.createElement("span");
      actions.className = "group-info-member-actions";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "group-info-member-action-button";
      trigger.setAttribute("aria-label", "成员操作");
      trigger.textContent = "⋯";
      const menu = document.createElement("span");
      menu.className = "group-info-member-action-menu hidden";
      const canBeHost = member.member_kind === MemberKind.Fellow;
      const canRemove = fellowMembers.length + (member.member_kind === MemberKind.User ? 1 : 0) > 1;
      menu.innerHTML = `
        ${canBeHost ? `<button type="button" data-group-member-action="set-host" ${isHost ? "disabled" : ""}>设为群主</button>` : ""}
        <button type="button" data-group-member-action="remove" ${canRemove ? "" : "disabled"}>${
          member.member_kind === MemberKind.User && member.member_ref === self?.id ? "退出群聊" : "移除群聊"
        }</button>
      `;
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        box.querySelectorAll(".group-info-member-action-menu").forEach((m) => { if (m !== menu) m.classList.add("hidden"); });
        menu.classList.toggle("hidden");
      });
      menu.addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-group-member-action]");
        if (!btn || btn.disabled) return;
        menu.classList.add("hidden");
        if (btn.dataset.groupMemberAction === "set-host") {
          await patchDecorations(conversation, { hostMember: { kind: MemberKind.Fellow, fellowId: member.member_ref } });
          reload(conversation.id);
        } else if (btn.dataset.groupMemberAction === "remove") {
          if (!confirm(`确定移除「${label}」？`)) return;
          const res = await global.mia.social.removeConversationMember(conversation.id, {
            memberKind: member.member_kind,
            memberRef: member.member_ref
          });
          if (!res.ok) { alert("移除失败：" + (res.error || "")); return; }
          reload(conversation.id);
        }
      });
      actions.appendChild(trigger);
      actions.appendChild(menu);
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  async function reload(conversationId) {
    const res = await global.mia.social.getConversation(conversationId);
    if (!res.ok) return;
    const data = res.data;
    if (data?.conversation) {
      _ctx.moduleState.conversations = _ctx.moduleState.conversations.map((r) => (r.id === conversationId ? { ...r, ...data.conversation } : r));
    }
    if (Array.isArray(data?.members)) {
      _ctx.conversationMembersCache.set(conversationId, data.members);
    }
    paintDialog(_activeConversationId);
    _ctx.deps?.render?.();
  }

  function paintDialog(conversationId) {
    if (!conversationId) return;
    const conversation = _ctx.moduleState.conversations.find((r) => r.id === conversationId);
    if (!conversation) return;
    const members = _ctx.conversationMembersCache.get(conversationId) || [];
    // Canonical context (self + cloud&local fellows + friends) — see groupTilesCtx().
    const actx = _ctx.adapterCtx();
    const fellows = actx.fellows;
    const self = actx.self;

    const avatarBtn = document.getElementById("groupInfoAvatarPreview");
    applyTilesToButton(avatarBtn, conversation, members);

    const nameInput = document.getElementById("groupInfoName");
    if (nameInput && document.activeElement !== nameInput) nameInput.value = conversation.name || "";

    const goalInput = document.getElementById("groupInfoGoal");
    if (goalInput && document.activeElement !== goalInput) goalInput.value = conversation.decorations?.pinnedGoal || "";

    renderMembersSection(document.getElementById("groupInfoMembers"), conversation, members, fellows, _ctx.moduleState.friends || [], self);
  }

  function openDialog(conversationOrId) {
    const conversationId = typeof conversationOrId === "string" ? conversationOrId : conversationOrId?.id;
    if (!conversationId) return;
    const dialog = document.getElementById("groupInfoDialog");
    if (!dialog) return;
    _activeConversationId = conversationId;
    dialog.classList.remove("hidden");

    const nameInput = document.getElementById("groupInfoName");
    const goalInput = document.getElementById("groupInfoGoal");
    const closeBtn = document.getElementById("groupInfoClose");
    const resetCtxBtn = document.getElementById("groupInfoResetCtx");
    const avatarBtn = document.getElementById("groupInfoAvatarPreview");
    const avatarFile = document.getElementById("groupInfoAvatarFile");
    const avatarReset = document.getElementById("groupInfoAvatarReset");
    const addMemberToggle = document.getElementById("groupInfoAddMemberToggle");
    const addableBox = document.getElementById("groupInfoAddable");

    // Ensure members are fresh.
    global.mia.social.getConversation(conversationId).then((res) => {
      if (!res.ok) return;
      const data = res.data;
      if (Array.isArray(data?.members)) _ctx.conversationMembersCache.set(conversationId, data.members);
      if (data?.conversation) _ctx.moduleState.conversations = _ctx.moduleState.conversations.map((r) => (r.id === conversationId ? { ...r, ...data.conversation } : r));
      paintDialog(conversationId);
    }).catch(() => paintDialog(conversationId));

    paintDialog(conversationId);

    function close() {
      dialog.classList.add("hidden");
      _activeConversationId = null;
      _pendingAvatarApply = null;
      closeBtn?.removeEventListener("click", close);
      document.removeEventListener("keydown", onEsc);
      dialog.removeEventListener("click", onBackdrop);
      nameInput?.removeEventListener("change", onNameChange);
      goalInput?.removeEventListener("change", onGoalChange);
      resetCtxBtn?.removeEventListener("click", onResetCtx);
      avatarBtn?.removeEventListener("click", onAvatarClick);
      avatarFile?.removeEventListener("change", onAvatarFile);
      avatarReset?.removeEventListener("click", onAvatarReset);
      addMemberToggle?.removeEventListener("click", onToggleAddable);
    }
    function onEsc(e) { if (e.key === "Escape") close(); }
    function onBackdrop(e) { if (e.target === dialog) close(); }
    async function onNameChange() {
      const conversation = _ctx.moduleState.conversations.find((r) => r.id === conversationId);
      if (!conversation) return;
      const next = nameInput.value.trim() || "未命名群聊";
      if (next === (conversation.name || "")) return;
      const updated = await patchName(conversation, next);
      if (updated) reload(conversationId);
    }
    async function onGoalChange() {
      const conversation = _ctx.moduleState.conversations.find((r) => r.id === conversationId);
      if (!conversation) return;
      const next = goalInput.value.trim();
      if (next === (conversation.decorations?.pinnedGoal || "")) return;
      const updated = await patchDecorations(conversation, { pinnedGoal: next || null });
      if (updated) reload(conversationId);
    }
    async function onResetCtx() {
      const conversation = _ctx.moduleState.conversations.find((r) => r.id === conversationId);
      if (!conversation) return;
      if (!confirm("重置群上下文？已生成的摘要会清空，后续重新积累。")) return;
      const updated = await patchDecorations(conversation, { contextCard: null });
      if (updated) reload(conversationId);
    }
    function onAvatarClick() { avatarFile?.click(); }
    function onAvatarFile() {
      const file = avatarFile?.files?.[0];
      if (!file || !file.type?.startsWith("image/")) return;
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = String(reader.result || "");
        _pendingAvatarApply = conversationId;
        global.miaFellowDialog.openAvatarCropEditor(dataUrl, { x: 50, y: 50, zoom: 1.12 }, "groupConversation");
      });
      reader.readAsDataURL(file);
      avatarFile.value = "";
    }
    async function onAvatarReset() {
      const conversation = _ctx.moduleState.conversations.find((r) => r.id === conversationId);
      if (!conversation) return;
      const updated = await patchDecorations(conversation, { avatar: null });
      if (updated) reload(conversationId);
    }
    function onToggleAddable() {
      addableBox?.classList.toggle("hidden");
    }

    closeBtn?.addEventListener("click", close);
    document.addEventListener("keydown", onEsc);
    dialog.addEventListener("click", onBackdrop);
    nameInput?.addEventListener("change", onNameChange);
    goalInput?.addEventListener("change", onGoalChange);
    resetCtxBtn?.addEventListener("click", onResetCtx);
    avatarBtn?.addEventListener("click", onAvatarClick);
    avatarFile?.addEventListener("change", onAvatarFile);
    avatarReset?.addEventListener("click", onAvatarReset);
    addMemberToggle?.addEventListener("click", onToggleAddable);
  }

  // Called from the global confirmAvatarCrop handler (target === "groupConversation").
  async function applyAvatarFromCropEditor(image, crop) {
    const conversationId = _pendingAvatarApply || _activeConversationId;
    _pendingAvatarApply = null;
    if (!conversationId) return;
    const conversation = _ctx.moduleState.conversations.find((r) => r.id === conversationId);
    if (!conversation) return;
    const normalized = global.miaAvatar.normalizeCrop(crop);
    const updated = await patchDecorations(conversation, { avatar: { image, crop: normalized } });
    if (updated) reload(conversationId);
  }

  global.miaGroupInfoDialog = {
    attach,
    open: openDialog,
    applyAvatarFromCropEditor,
  };

  if (global.miaSocial && global.miaSocial._internalCtx) {
    attach(global.miaSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);
