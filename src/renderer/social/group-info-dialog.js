// Group info / settings dialog for cloud group rooms.
// Replaces the local-group openInfoDialog deleted in Phase 5. Every field
// here writes through PATCH /api/rooms/:id (top-level name; everything
// else goes into decorations) or /api/rooms/:id/members for membership.
//
// Fields:
//   - 群头像 (decorations.avatar = { image, crop }) — uses the shared
//     avatar-crop editor; reverting "恢复默认" clears the override so the
//     sidebar mosaic renders again.
//   - 群名 (room.name)
//   - 回复模式 (decorations.responseMode: "conductor" | "mentions-only")
//   - 群目标 (decorations.pinnedGoal) — shown to the conductor's
//     dispatch prompt as the group summary fallback.
//   - 群主 (decorations.hostMember = { kind: "fellow", fellowId })
//   - 成员管理 (POST/DELETE /api/rooms/:id/members)
//   - 重置群上下文 (decorations.contextCard = null)

(function (global) {
  "use strict";

  const { MemberKind } = (typeof window !== "undefined" && window.miaConversationKinds)
    || require("../../shared/conversation-kinds");

  let _ctx = null;
  let _activeRoomId = null;
  let _pendingAvatarApply = null;

  function attach(internalCtx) { _ctx = internalCtx; }

  function escapeHtml(value) {
    return global.miaMarkdown?.escapeHtml?.(value)
      ?? String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]));
  }

  function applyTilesToButton(buttonEl, room, members) {
    if (!buttonEl) return;
    const slot = buttonEl.querySelector(".avatar");
    if (!slot) return;
    const custom = room?.decorations?.avatar;
    if (custom && custom.image) {
      slot.className = "avatar";
      const style = global.miaAvatar?.avatarThumbBackgroundStyle?.(custom.image, custom.crop, "#5e5ce6")
        || `background-image:url('${custom.image}');background-size:cover;background-position:center;`;
      slot.style.cssText = style;
      slot.removeAttribute("data-count");
      slot.innerHTML = "";
      return;
    }
    slot.className = "avatar group-avatar";
    slot.style.cssText = "";
    const tiles = global.miaGroupTiles.resolveGroupMemberTiles(members || [], groupTilesCtx());
    global.miaGroupAvatar.applyGroupAvatar(slot, tiles);
  }

  function groupTilesCtx() {
    const { moduleState, deps } = _ctx;
    const runtimeState = deps && typeof deps.getState === "function" ? deps.getState() : {};
    const cloudUser = runtimeState.runtime?.cloud?.user || null;
    return {
      self: cloudUser || runtimeState.runtime?.user || null,
      friends: moduleState.friends || [],
      fellows: runtimeState.runtime?.fellows || runtimeState.runtime?.personas || [],
      avatarAssetForKey: global.miaAvatar?.avatarAssetForKey
    };
  }

  // —— field writes ——

  async function patchDecorations(room, patch) {
    const decorations = { ...(room.decorations || {}), ...patch };
    const res = await global.mia.social.updateRoom(room.id, { decorations });
    if (!res.ok) {
      console.warn("[group-info] PATCH decorations failed:", res.error);
      return null;
    }
    return res.data?.room || res.data || null;
  }

  async function patchName(room, name) {
    const res = await global.mia.social.updateRoom(room.id, { name });
    if (!res.ok) {
      alert("保存群名失败：" + (res.error || ""));
      return null;
    }
    return res.data?.room || res.data || null;
  }

  // —— render ——

  function fellowNameFor(member, fellows) {
    if (member.fellow_name) return member.fellow_name;
    const f = (fellows || []).find((x) => (x.id || x.key) === member.member_ref);
    return f?.name || member.member_ref;
  }

  function fellowAvatarFor(member, fellows) {
    if (member.fellow_avatar_image) {
      return { image: member.fellow_avatar_image, crop: member.fellow_avatar_crop, color: member.fellow_color || "#5e5ce6" };
    }
    const f = (fellows || []).find((x) => (x.id || x.key) === member.member_ref);
    return {
      image: f?.avatarImage || global.miaAvatar?.avatarAssetForKey?.(member.member_ref),
      crop: f?.avatarCrop,
      color: f?.color || "#5e5ce6"
    };
  }

  function userNameFor(member, friends, self) {
    if (member.member_ref === self?.id) return self?.username || "我";
    const friend = (friends || []).find((f) => f.id === member.member_ref);
    return friend?.username || friend?.account || member.member_ref;
  }

  function renderMembersSection(box, room, members, fellows, friends, self) {
    box.innerHTML = "";
    const hostFellowId = room.decorations?.hostMember?.fellowId || null;
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
        avatar = { image: "", crop: null, color: "#5e5ce6" };
      }
      const style = avatar.image
        ? global.miaAvatar.avatarThumbBackgroundStyle(avatar.image, avatar.crop, avatar.color)
        : `background-color:${avatar.color};`;
      avatarEl.style.cssText = style || `background-color:${avatar.color};`;
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
          await patchDecorations(room, { hostMember: { kind: MemberKind.Fellow, fellowId: member.member_ref } });
          reload(room.id);
        } else if (btn.dataset.groupMemberAction === "remove") {
          if (!confirm(`确定移除「${label}」？`)) return;
          const res = await global.mia.social.removeRoomMember(room.id, {
            memberKind: member.member_kind,
            memberRef: member.member_ref
          });
          if (!res.ok) { alert("移除失败：" + (res.error || "")); return; }
          reload(room.id);
        }
      });
      actions.appendChild(trigger);
      actions.appendChild(menu);
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  function renderResponseMode(el, room) {
    if (!el) return;
    const mode = room.decorations?.responseMode === "mentions-only" ? "mentions-only" : "conductor";
    el.querySelectorAll("[data-group-response-mode]").forEach((btn) => {
      const selected = btn.dataset.groupResponseMode === mode;
      btn.classList.toggle("active", selected);
      btn.setAttribute("aria-checked", selected ? "true" : "false");
    });
  }

  async function reload(roomId) {
    const res = await global.mia.social.getRoom(roomId);
    if (!res.ok) return;
    const data = res.data;
    if (data?.room) {
      _ctx.moduleState.rooms = _ctx.moduleState.rooms.map((r) => (r.id === roomId ? { ...r, ...data.room } : r));
    }
    if (Array.isArray(data?.members)) {
      _ctx.roomMembersCache.set(roomId, data.members);
    }
    paintDialog(_activeRoomId);
    _ctx.deps?.render?.();
  }

  function paintDialog(roomId) {
    if (!roomId) return;
    const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const members = _ctx.roomMembersCache.get(roomId) || [];
    const runtimeState = _ctx.deps?.getState?.() || {};
    const fellows = runtimeState.runtime?.fellows || runtimeState.runtime?.personas || [];
    const self = runtimeState.runtime?.cloud?.user || runtimeState.runtime?.user || null;

    const avatarBtn = document.getElementById("groupInfoAvatarPreview");
    applyTilesToButton(avatarBtn, room, members);

    const nameInput = document.getElementById("groupInfoName");
    if (nameInput && document.activeElement !== nameInput) nameInput.value = room.name || "";

    const goalInput = document.getElementById("groupInfoGoal");
    if (goalInput && document.activeElement !== goalInput) goalInput.value = room.decorations?.pinnedGoal || "";

    renderResponseMode(document.getElementById("groupInfoResponseMode"), room);
    renderMembersSection(document.getElementById("groupInfoMembers"), room, members, fellows, _ctx.moduleState.friends || [], self);
  }

  function openDialog(roomOrId) {
    const roomId = typeof roomOrId === "string" ? roomOrId : roomOrId?.id;
    if (!roomId) return;
    const dialog = document.getElementById("groupInfoDialog");
    if (!dialog) return;
    _activeRoomId = roomId;
    dialog.classList.remove("hidden");

    const nameInput = document.getElementById("groupInfoName");
    const goalInput = document.getElementById("groupInfoGoal");
    const responseModeEl = document.getElementById("groupInfoResponseMode");
    const closeBtn = document.getElementById("groupInfoClose");
    const resetCtxBtn = document.getElementById("groupInfoResetCtx");
    const avatarBtn = document.getElementById("groupInfoAvatarPreview");
    const avatarFile = document.getElementById("groupInfoAvatarFile");
    const avatarReset = document.getElementById("groupInfoAvatarReset");
    const addMemberToggle = document.getElementById("groupInfoAddMemberToggle");
    const addableBox = document.getElementById("groupInfoAddable");

    // Ensure members are fresh.
    global.mia.social.getRoom(roomId).then((res) => {
      if (!res.ok) return;
      const data = res.data;
      if (Array.isArray(data?.members)) _ctx.roomMembersCache.set(roomId, data.members);
      if (data?.room) _ctx.moduleState.rooms = _ctx.moduleState.rooms.map((r) => (r.id === roomId ? { ...r, ...data.room } : r));
      paintDialog(roomId);
    }).catch(() => paintDialog(roomId));

    paintDialog(roomId);

    function close() {
      dialog.classList.add("hidden");
      _activeRoomId = null;
      _pendingAvatarApply = null;
      closeBtn?.removeEventListener("click", close);
      document.removeEventListener("keydown", onEsc);
      dialog.removeEventListener("click", onBackdrop);
      nameInput?.removeEventListener("change", onNameChange);
      goalInput?.removeEventListener("change", onGoalChange);
      responseModeEl?.removeEventListener("click", onResponseModeClick);
      resetCtxBtn?.removeEventListener("click", onResetCtx);
      avatarBtn?.removeEventListener("click", onAvatarClick);
      avatarFile?.removeEventListener("change", onAvatarFile);
      avatarReset?.removeEventListener("click", onAvatarReset);
      addMemberToggle?.removeEventListener("click", onToggleAddable);
    }
    function onEsc(e) { if (e.key === "Escape") close(); }
    function onBackdrop(e) { if (e.target === dialog) close(); }
    async function onNameChange() {
      const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const next = nameInput.value.trim() || "未命名群聊";
      if (next === (room.name || "")) return;
      const updated = await patchName(room, next);
      if (updated) reload(roomId);
    }
    async function onGoalChange() {
      const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const next = goalInput.value.trim();
      if (next === (room.decorations?.pinnedGoal || "")) return;
      const updated = await patchDecorations(room, { pinnedGoal: next || null });
      if (updated) reload(roomId);
    }
    async function onResponseModeClick(event) {
      const btn = event.target.closest("[data-group-response-mode]");
      if (!btn) return;
      const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const next = btn.dataset.groupResponseMode === "mentions-only" ? "mentions-only" : "conductor";
      const updated = await patchDecorations(room, { responseMode: next });
      if (updated) reload(roomId);
    }
    async function onResetCtx() {
      const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
      if (!room) return;
      if (!confirm("重置群上下文？已生成的摘要会清空，后续重新积累。")) return;
      const updated = await patchDecorations(room, { contextCard: null });
      if (updated) reload(roomId);
    }
    function onAvatarClick() { avatarFile?.click(); }
    function onAvatarFile() {
      const file = avatarFile?.files?.[0];
      if (!file || !file.type?.startsWith("image/")) return;
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = String(reader.result || "");
        _pendingAvatarApply = roomId;
        global.miaFellowDialog.openAvatarCropEditor(dataUrl, { x: 50, y: 50, zoom: 1.12 }, "groupRoom");
      });
      reader.readAsDataURL(file);
      avatarFile.value = "";
    }
    async function onAvatarReset() {
      const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const updated = await patchDecorations(room, { avatar: null });
      if (updated) reload(roomId);
    }
    function onToggleAddable() {
      addableBox?.classList.toggle("hidden");
    }

    closeBtn?.addEventListener("click", close);
    document.addEventListener("keydown", onEsc);
    dialog.addEventListener("click", onBackdrop);
    nameInput?.addEventListener("change", onNameChange);
    goalInput?.addEventListener("change", onGoalChange);
    responseModeEl?.addEventListener("click", onResponseModeClick);
    resetCtxBtn?.addEventListener("click", onResetCtx);
    avatarBtn?.addEventListener("click", onAvatarClick);
    avatarFile?.addEventListener("change", onAvatarFile);
    avatarReset?.addEventListener("click", onAvatarReset);
    addMemberToggle?.addEventListener("click", onToggleAddable);
  }

  // Called from the global confirmAvatarCrop handler (target === "groupRoom").
  async function applyAvatarFromCropEditor(image, crop) {
    const roomId = _pendingAvatarApply || _activeRoomId;
    _pendingAvatarApply = null;
    if (!roomId) return;
    const room = _ctx.moduleState.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const normalized = global.miaAvatar.normalizeCrop(crop);
    const updated = await patchDecorations(room, { avatar: { image, crop: normalized } });
    if (updated) reload(roomId);
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
