// Fellow manager module
// Extracted from app.js. Contains the contact-list / contact-detail view,
// the per-fellow skill capability panel, and the
// fellow right-click context menu. Heavy renderer-only module — no IPC of
// its own beyond what's injected.
//
// Defensive `if (!state || !els)` guards on every entry point.
(function () {
  "use strict";

  // Sentinel activeContactKey for the pinned "新的好友" entry — the right pane
  // shows the incoming friend-request list instead of a fellow profile.
  const FRIEND_REQUESTS_KEY = "__friend_requests__";

  let state, els;
  let setText, formatConversationTime;
  let loadSkills, showNarrowContent, render;
  let closeGroupContextMenu, openEditFellowDialog, deleteFellow, setFellowPinned;

  function fellowIdentity() {
    if (typeof window !== "undefined" && window.miaFellowIdentity) return window.miaFellowIdentity;
    if (typeof require === "function") {
      try { return require("../../shared/fellow-identity.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function contact() {
    if (typeof window !== "undefined" && window.miaContact) return window.miaContact;
    if (typeof require === "function") {
      try { return require("../../shared/contact.js"); } catch { /* fallback below */ }
    }
    return null;
  }

  function fellowAvatarIdentityId(fellow = {}) {
    const localId = fellow.key || fellow.id || "";
    const ownerUserId = fellow.ownerUserId || fellow.owner_user_id || fellow.ownerId || fellow.owner_id || "";
    return contact()?.fellowAvatarIdentityId?.(localId, fellow)
      || fellow.globalId
      || fellow.global_id
      || fellow.fellowGlobalId
      || fellow.fellow_global_id
      || fellowIdentity()?.fellowGlobalId?.(ownerUserId, localId)
      || (ownerUserId && localId ? "fellow:" + ownerUserId + ":" + localId : "")
      || localId;
  }

  function initFellowManager(deps) {
    state = deps.state;
    els = deps.els;
    setText = deps.setText;
    formatConversationTime = deps.formatConversationTime;
    loadSkills = deps.loadSkills;
    showNarrowContent = deps.showNarrowContent;
    render = deps.render;
    closeGroupContextMenu = deps.closeGroupContextMenu;
    openEditFellowDialog = deps.openEditFellowDialog;
    deleteFellow = deps.deleteFellow;
    setFellowPinned = deps.setFellowPinned;
  }

  function fellowByKey(key) {
    if (!state) return null;
    const fellows = allOwnedFellows();
    return fellows.find((item) => item.key === key) || null;
  }

  function avatarForFellow(fellow = {}) {
    const api = contact();
    if (api?.resolveContact && api?.ContactKind) {
      return api.resolveContact(
        { kind: api.ContactKind.Fellow, ref: fellow.key || fellow.id },
        { fellows: [fellow] }
      ).avatar;
    }
    return window.miaAvatarResolve.resolveAvatarForContact({
      id: fellowAvatarIdentityId(fellow),
      displayName: fellow.name || fellow.key || fellow.id,
      avatarImage: fellow.avatarImage || "",
      avatarCrop: fellow.avatarCrop || null,
      color: fellow.color || fellow.avatarColor || fellow.avatar_color || ""
    });
  }

  function allOwnedFellows() {
    if (!state) return [];
    const socialFellows = window.miaSocial?._internalCtx?.adapterCtx?.()?.fellows
      || window.miaSocial?.moduleState?.fellows
      || [];
    const localFellows = [
      ...(Array.isArray(state.runtime?.fellows) ? state.runtime.fellows : []),
      ...(Array.isArray(state.runtime?.personas) ? state.runtime.personas : [])
    ];
    return window.miaFellowDirectory.listOwnedFellows({
      cloudFellows: socialFellows,
      localFellows,
      runtime: state.runtime || {}
    });
  }

  function sortFellowsForSidebar(fellows = []) {
    return fellows
      .map((fellow, index) => ({ fellow, index }))
      .sort((a, b) => {
        const pinnedDiff = Number(Boolean(b.fellow.pinned)) - Number(Boolean(a.fellow.pinned));
        if (pinnedDiff) return pinnedDiff;
        if (a.fellow.pinned && b.fellow.pinned) {
          const timeDiff = String(b.fellow.pinnedAt || "").localeCompare(String(a.fellow.pinnedAt || ""));
          if (timeDiff) return timeDiff;
        }
        return a.index - b.index;
      })
      .map((item) => item.fellow);
  }

  function sortableConversationTime(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sortMessageCardsForSidebar(rows = []) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const pinnedDiff = Number(Boolean(b.row.pinned)) - Number(Boolean(a.row.pinned));
        if (pinnedDiff) return pinnedDiff;
        if (a.row.pinned && b.row.pinned) {
          const timeDiff = sortableConversationTime(b.row.pinnedAt) - sortableConversationTime(a.row.pinnedAt);
          if (timeDiff) return timeDiff;
        }
        const updatedDiff = sortableConversationTime(b.row.updatedAt) - sortableConversationTime(a.row.updatedAt);
        if (updatedDiff) return updatedDiff;
        return a.index - b.index;
      })
      .map((item) => item.row);
  }

  function contactSessionSummary(fellow) {
    // Cloud-only: the contacts list no longer derives a preview from local
    // sessions; it shows the fellow's subtitle.
    return { count: 0, preview: `${fellowSubtitle(fellow)} · 暂无对话`, time: "" };
  }

  function contactPetLabel(pet = {}) {
    if (pet.placed) return "桌面中";
    if (pet.hasAsset) return "已生成桌宠";
    return "";
  }

  async function openFellowChat(fellowKey) {
    if (!fellowKey || !state || !els) return;
    // Cloud-only: opening a fellow chat always routes through the cloud
    // conversation opener (always present).
    await window.miaOpenFellowConversation?.(fellowKey);
  }

  // "使用" a skill from the skills page: enable it on the chosen Fellow (so the
  // engine actually gets it, via buildEnabledSkillsContext) and open that chat.
  async function useSkillOnFellow(fellowKey, skillId) {
    if (!fellowKey || !skillId || !state) return;
    const fellow = allOwnedFellows().find((item) => item.key === fellowKey);
    if (!fellow) return;
    const caps = fellowCapabilities(fellow);
    if (!caps.enabledSkills.includes(skillId)) {
      await saveFellowCapabilities(fellow, toggleCapabilityId(caps, skillId, "enabledSkills", "disabledSkills", true));
    }
    await openFellowChat(fellowKey);
  }

  function defaultFellowCapabilities() {
    return fellowIdentity()?.normalizeFellowCapabilities?.({}) || {
      inheritEngineDefaults: true,
      enabledPlugins: [],
      disabledPlugins: [],
      enabledSkills: [],
      disabledSkills: [],
      enabledConnectors: [],
      legacyCapabilities: []
    };
  }

  function normalizeCapabilityIds(input) {
    return fellowIdentity()?.normalizeCapabilityIds?.(input)
      || (Array.isArray(input) ? [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))] : []);
  }

  function fellowCapabilities(fellow = {}) {
    const normalizer = fellowIdentity()?.normalizeFellowCapabilities;
    if (typeof normalizer === "function") return normalizer(fellow.capabilities);
    const raw = fellow.capabilities && typeof fellow.capabilities === "object" ? fellow.capabilities : {};
    return { ...defaultFellowCapabilities(), ...raw };
  }

  function capabilityForEngine(item = {}, engine = "") {
    const itemEngine = String(item.engine || item.provider || "").trim();
    return !itemEngine || itemEngine === "mia" || itemEngine === engine || (engine === "hermes" && item.source === "hermes");
  }

  function engineLabel(engine = "") {
    if (engine === "mia") return "Mia";
    if (engine === "claude-code") return "Claude Code";
    if (engine === "codex") return "Codex";
    return "Hermes";
  }

  function engineLogoKind(engine = "") {
    if (engine === "claude-code") return "claude";
    if (engine === "codex") return "codex";
    return "hermes";
  }

  function engineLogoHtml(engine = "") {
    const kind = engineLogoKind(engine);
    if (kind === "codex") {
      return '<span class="engine-row-logo contact-engine-logo codex" aria-hidden="true"><img src="./assets/engine-icons/codex-color.svg" alt=""></span>';
    }
    return `<span class="engine-row-logo contact-engine-logo ${window.miaMarkdown.escapeHtml(kind)}" aria-hidden="true"></span>`;
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = String(value || "").trim();
      if (next) return next;
    }
    return "";
  }

  function fellowDeviceLabel(fellow = {}) {
    return window.miaFellowDirectory.runtimeLabelFor(fellow, state?.runtime || {});
  }

  function fellowSubtitle(fellow = {}) {
    return firstNonEmpty(fellow.bio, fellow.description, fellowDeviceLabel(fellow));
  }

  function fellowCapabilityItems(fellow = {}) {
    if (!state) return { skills: [] };
    const engine = fellow.agentEngine || fellow.agent_engine || "hermes";
    const skills = (state.skillLibrary.skills || [])
      .filter((item) => capabilityForEngine(item, engine))
      .slice(0, 32);
    return { skills };
  }

  function capabilityChecked(capabilities, id, enabledKey, disabledKey) {
    return capabilities[enabledKey].includes(id);
  }

  function renderCapabilityCheckbox({ item, checked, type }) {
    const title = item.label || item.name || item.id;
    const meta = item.engineLabel || item.sourceLabel || item.category || item.status || "";
    return `
      <label class="capability-row">
        <input type="checkbox" data-capability-type="${window.miaMarkdown.escapeHtml(type)}" data-capability-id="${window.miaMarkdown.escapeHtml(item.id)}" ${checked ? "checked" : ""}>
        <span>
          <strong>${window.miaMarkdown.escapeHtml(title)}</strong>
          ${meta ? `<small>${window.miaMarkdown.escapeHtml(meta)}</small>` : ""}
        </span>
      </label>
    `;
  }

  function renderFellowCapabilitiesPanel(fellow) {
    const capabilities = fellowCapabilities(fellow);
    const { skills } = fellowCapabilityItems(fellow);
    const engine = fellow.agentEngine || fellow.agent_engine || "hermes";
    return `
      <section class="contact-capabilities">
        <header>
          <div>
            <strong>能力</strong>
            <p>${window.miaMarkdown.escapeHtml(engineLabel(engine))} · ${skills.length} 技能</p>
          </div>
        </header>
        <div class="capability-columns">
          <section>
            <h3>技能</h3>
            ${skills.length ? skills.map((item) => renderCapabilityCheckbox({
              item,
              checked: capabilityChecked(capabilities, item.id, "enabledSkills", "disabledSkills"),
              type: "skill"
            })).join("") : `<div class="capability-empty">当前引擎没有可选技能</div>`}
          </section>
        </div>
      </section>
    `;
  }

  function renderContacts() {
    if (!state || !els || !els.contactList || !els.contactDetail) return;
    if (!state.skillsLoading && !(state.skillLibrary.extensions || []).length && !(state.skillLibrary.skills || []).length) {
      loadSkills().catch(() => {});
    }
    const fellows = allOwnedFellows();
    const pendingRequests = window.miaSocial?.pendingRequestCount?.() || 0;
    if (!fellows.length && !pendingRequests) {
      els.contactList.innerHTML = `<div class="contact-empty">还没有联系人</div>`;
      els.contactDetail.innerHTML = `<div class="contact-empty detail-empty">添加一个伙伴后会显示在这里</div>`;
      return;
    }
    const onRequests = state.activeContactKey === FRIEND_REQUESTS_KEY;
    if (onRequests && !pendingRequests) {
      // The pending list emptied (all accepted/rejected) — fall back to a real contact.
      state.activeContactKey = fellows[0]?.key || null;
    } else if (!onRequests && !fellows.some((fellow) => fellow.key === state.activeContactKey)) {
      state.activeContactKey = fellows[0]?.key || (pendingRequests ? FRIEND_REQUESTS_KEY : null);
    }
    const filter = state.contactFilter.trim().toLowerCase();
    const visibleContacts = sortFellowsForSidebar(filter
      ? fellows.filter((fellow) => `${fellow.name || ""} ${fellow.key || ""} ${fellow.bio || ""}`.toLowerCase().includes(filter))
      : fellows);
    els.contactList.innerHTML = "";
    if (pendingRequests && !filter) {
      els.contactList.appendChild(buildFriendRequestRow(pendingRequests));
    }
    for (const fellow of visibleContacts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `contact-row${fellow.key === state.activeContactKey ? " active" : ""}`;
      button.innerHTML = `
        <span class="avatar fellow-photo"></span>
        <span class="contact-row-main">
          <strong>${window.miaMarkdown.escapeHtml(fellow.name)}</strong>
        </span>
      `;
      button.addEventListener("click", () => {
        state.activeContactKey = fellow.key;
        showNarrowContent();
        renderContacts();
      });
      button.addEventListener("dblclick", () => openFellowChat(fellow.key));
      const avatar = avatarForFellow(fellow);
      window.miaAvatar.applyAvatarMedia(
        button.querySelector(".fellow-photo"),
        avatar.image,
        avatar.crop,
        avatar.color,
        avatar.text
      );
      els.contactList.appendChild(button);
    }
    if (!visibleContacts.length && filter) {
      els.contactList.innerHTML = `<div class="contact-empty">没有匹配的联系人</div>`;
    }
    if (state.activeContactKey === FRIEND_REQUESTS_KEY && pendingRequests) {
      setText(els.contactPageTitle, "新的好友");
      setText(els.contactPageMeta, "");
      window.miaSocial.renderRequestsInto(els.contactDetail);
    } else {
      renderContactDetail(fellows.find((fellow) => fellow.key === state.activeContactKey) || visibleContacts[0] || fellows[0]);
    }
  }

  function buildFriendRequestRow(count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `contact-row${state.activeContactKey === FRIEND_REQUESTS_KEY ? " active" : ""}`;
    button.innerHTML = `
      <span class="avatar contact-request-avatar">${window.miaMarkdown.iconParkIcon("add-friend", "contact-request-icon")}</span>
      <span class="contact-row-main"><strong>新的好友</strong></span>
      <span class="contact-row-side"><span class="contact-request-badge">${window.miaUnread.unreadBadgeText(count)}</span></span>
    `;
    button.addEventListener("click", () => {
      state.activeContactKey = FRIEND_REQUESTS_KEY;
      showNarrowContent();
      renderContacts();
    });
    return button;
  }

  function renderContactDetail(fellow) {
    if (!state || !els || !els.contactDetail || !fellow) return;
    const summary = contactSessionSummary(fellow);
    const engine = fellow.agentEngine || fellow.agent_engine || fellow.engine || "hermes";
    setText(els.contactPageTitle, fellow.name || "联系人");
    setText(els.contactPageMeta, fellowDeviceLabel(fellow));
    const canEditFellow = fellow.canEditIdentity !== false;
    const canDeleteFellow = fellow.canDelete !== false;
    els.contactDetail.innerHTML = `
      <article class="contact-profile">
        <header class="contact-profile-head">
          <button class="contact-profile-avatar" type="button" ${canEditFellow ? 'data-contact-action="edit" title="编辑联系人头像"' : 'title="联系人头像"'}></button>
          <div class="contact-profile-title">
            <h2>${window.miaMarkdown.escapeHtml(fellow.name || "联系人")}</h2>
            <div class="contact-engine-badge" title="Agent 引擎">
              ${engineLogoHtml(engine)}
              <span class="contact-engine-copy">
                <small>Agent</small>
                <strong>${window.miaMarkdown.escapeHtml(engineLabel(engine))}</strong>
              </span>
            </div>
            <p>${window.miaMarkdown.escapeHtml(fellowSubtitle(fellow))}</p>
          </div>
          <div class="contact-actions">
            <button class="primary contact-message-action" type="button" data-contact-action="message" title="发消息" aria-label="发消息">${window.miaMarkdown.iconParkIcon("message", "contact-action-icon")}</button>
            ${canEditFellow ? `<button class="secondary" type="button" data-contact-action="edit">编辑</button>` : ""}
            ${canDeleteFellow ? `<button class="secondary danger" type="button" data-contact-action="delete">删除伙伴</button>` : ""}
          </div>
        </header>
        <section class="contact-note">
          <strong>最近内容</strong>
          <p>${window.miaMarkdown.escapeHtml(summary.preview)}</p>
        </section>
        ${fellow.canConfigureCapabilities !== false ? renderFellowCapabilitiesPanel(fellow) : ""}
      </article>
    `;
    const avatar = avatarForFellow(fellow);
    window.miaAvatar.applyAvatarMedia(
      els.contactDetail.querySelector(".contact-profile-avatar"),
      avatar.image,
      avatar.crop,
      avatar.color,
      avatar.text
    );
    els.contactDetail.querySelector('[data-contact-action="message"]')?.addEventListener("click", () => openFellowChat(fellow.key));
    els.contactDetail.querySelectorAll('[data-contact-action="edit"]').forEach((button) => {
      button.addEventListener("click", () => openEditFellowDialog(fellow.key));
    });
    els.contactDetail.querySelector('[data-contact-action="delete"]')?.addEventListener("click", async () => {
      await deleteFellow(fellow.key);
    });
    if (fellow.canConfigureCapabilities !== false) wireFellowCapabilities(fellow);
  }

  async function saveFellowCapabilities(fellow, capabilities) {
    if (!fellow?.key || !state) return;
    state.savingFellowCapabilities.add(fellow.key);
    try {
      const result = await window.miaFellowCommands.saveFellowCapabilities({
        state,
        fellow,
        capabilities,
        api: window.mia,
        social: window.miaSocial
      });
      if (result?.runtime) state.runtime = result.runtime;
    } catch (error) {
      window.alert(`保存能力设置失败：${error.message || error}`);
    } finally {
      state.savingFellowCapabilities.delete(fellow.key);
      renderContacts();
    }
  }

  function toggleCapabilityId(capabilities, id, enabledKey, disabledKey, checked) {
    const next = {
      ...capabilities,
      inheritEngineDefaults: false,
      [enabledKey]: [...capabilities[enabledKey]],
      [disabledKey]: [...capabilities[disabledKey]]
    };
    next[enabledKey] = checked
      ? [...new Set([...next[enabledKey], id])]
      : next[enabledKey].filter((item) => item !== id);
    next[disabledKey] = next[disabledKey].filter((item) => item !== id);
    return next;
  }

  function wireFellowCapabilities(fellow) {
    if (!els || !els.contactDetail || !fellow) return;
    els.contactDetail.querySelectorAll("[data-capability-type][data-capability-id]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.dataset.capabilityId || "";
        const type = input.dataset.capabilityType || "";
        let capabilities = fellowCapabilities(fellow);
        if (type === "skill") {
          capabilities = toggleCapabilityId(capabilities, id, "enabledSkills", "disabledSkills", input.checked);
        }
        await saveFellowCapabilities(fellow, capabilities);
      });
    });
  }

  function petStatusForKey(key) {
    return state?.runtime?.pets?.[key] || { hasAsset: false, placed: false, petId: "" };
  }

  function openFellowContextMenu(fellowKey, x, y) {
    if (!fellowKey || !state) return;
    window.miaMessageMenu?.closeMessageContextMenu();
    closeGroupContextMenu?.(); // group subsystem removed in unification — dep no longer injected
    state.fellowContextMenu = { open: true, x, y, fellowKey };
    renderFellowContextMenu();
  }

  function closeFellowContextMenu() {
    if (!state || !state.fellowContextMenu.open) return;
    state.fellowContextMenu = { open: false, x: 0, y: 0, fellowKey: "" };
    renderFellowContextMenu();
  }

  function renderFellowContextMenu() {
    if (!state || !els || !els.fellowContextMenu) return;
    const menu = els.fellowContextMenu;
    const fellow = fellowByKey(state.fellowContextMenu.fellowKey);
    const open = state.fellowContextMenu.open && fellow;
    menu.classList.toggle("hidden", !open);
    if (!open) return;
    const pet = petStatusForKey(fellow.key);
    const canDeleteFellow = fellow.canDelete !== false;
    const petAction = pet.hasAsset
      ? pet.placed
        ? window.miaMarkdown.menuItemHtml({ icon: "message", label: `收回「${fellow.name}」`, attrs: 'data-fellow-action="recall"' })
        : window.miaMarkdown.menuItemHtml({ icon: "message", label: "放进桌面", attrs: 'data-fellow-action="place"' })
      : window.miaMarkdown.menuItemHtml({ icon: "addPic", label: "生成桌宠", attrs: 'data-fellow-action="generate-pet"' });
    menu.innerHTML = `
      ${window.miaMarkdown.menuItemHtml({ icon: "pin", label: fellow.pinned ? "取消置顶" : "置顶", attrs: 'data-fellow-action="pin"' })}
      ${window.miaMarkdown.menuItemHtml({ icon: "edit", label: "编辑", attrs: 'data-fellow-action="edit"' })}
      ${petAction}
      ${canDeleteFellow ? `<div class="skill-context-menu-separator" role="separator"></div>${window.miaMarkdown.menuItemHtml({ icon: "delete", label: "删除伙伴", attrs: 'data-fellow-action="delete"', className: "danger" })}` : ""}
    `;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 138;
    const height = rect.height || (canDeleteFellow ? 158 : 114);
    menu.style.left = `${Math.max(8, Math.min(state.fellowContextMenu.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(state.fellowContextMenu.y, window.innerHeight - height - 8))}px`;
    menu.querySelector('[data-fellow-action="edit"]')?.addEventListener("click", () => {
      closeFellowContextMenu();
      openEditFellowDialog(fellow.key);
    });
    menu.querySelector('[data-fellow-action="pin"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await setFellowPinned(fellow.key, !fellow.pinned);
    });
    menu.querySelector('[data-fellow-action="generate-pet"]')?.addEventListener("click", () => {
      closeFellowContextMenu();
      window.miaPetDialog?.openPetGenerateDialog(fellow.key);
    });
    menu.querySelector('[data-fellow-action="place"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await window.miaPetDialog?.placeFellowPet(fellow.key);
    });
    menu.querySelector('[data-fellow-action="recall"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await window.miaPetDialog?.recallFellowPet(fellow.key);
    });
    menu.querySelector('[data-fellow-action="delete"]')?.addEventListener("click", async () => {
      closeFellowContextMenu();
      await deleteFellow(fellow.key);
    });
  }

  window.miaFellowManager = {
    FRIEND_REQUESTS_KEY,
    initFellowManager,
    fellowByKey,
    sortFellowsForSidebar,
    sortableConversationTime,
    sortMessageCardsForSidebar,
    allOwnedFellows,
    useSkillOnFellow,
    contactSessionSummary,
    contactPetLabel,
    openFellowChat,
    defaultFellowCapabilities,
    normalizeCapabilityIds,
    fellowCapabilities,
    capabilityForEngine,
    engineLabel,
    fellowCapabilityItems,
    capabilityChecked,
    fellowDeviceLabel,
    fellowSubtitle,
    engineLogoHtml,
    renderCapabilityCheckbox,
    renderFellowCapabilitiesPanel,
    renderContacts,
    renderContactDetail,
    saveFellowCapabilities,
    toggleCapabilityId,
    wireFellowCapabilities,
    petStatusForKey,
    openFellowContextMenu,
    closeFellowContextMenu,
    renderFellowContextMenu,
  };
})();
