// Bot manager module
// Extracted from app.js. Contains the contact-list / contact-detail view,
// the per-bot skill capability panel, and the
// bot right-click context menu. Heavy renderer-only module — no IPC of
// its own beyond what's injected.
//
// Defensive `if (!state || !els)` guards on every entry point.
(function () {
  "use strict";

  // Sentinel activeContactKey for the pinned "新的好友" entry — the right pane
  // shows the incoming friend-request list instead of a bot profile.
  const FRIEND_REQUESTS_KEY = "__friend_requests__";

  let state, els;
  let setText, formatConversationTime;
  let loadSkills, showNarrowContent, render;
  let closeGroupContextMenu, openEditBotDialog, deleteBot, setBotPinned;

  function botIdentity() {
    if (typeof window !== "undefined" && window.miaBotIdentity) return window.miaBotIdentity;
    if (typeof require === "function") {
      try { return require("../../shared/bot-identity.js"); } catch { /* fallback below */ }
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

  function botAvatarIdentityId(bot = {}) {
    const localId = bot.key || bot.id || "";
    const ownerUserId = bot.ownerUserId || bot.owner_user_id || bot.ownerId || bot.owner_id || "";
    return contact()?.botAvatarIdentityId?.(localId, bot)
      || bot.globalId
      || bot.global_id
      || bot.botGlobalId
      || bot.bot_global_id
      || (ownerUserId && localId ? "botc_" + ownerUserId + "_" + localId : "")
      || localId;
  }

  function initBotManager(deps) {
    state = deps.state;
    els = deps.els;
    setText = deps.setText;
    formatConversationTime = deps.formatConversationTime;
    loadSkills = deps.loadSkills;
    showNarrowContent = deps.showNarrowContent;
    render = deps.render;
    closeGroupContextMenu = deps.closeGroupContextMenu;
    openEditBotDialog = deps.openEditBotDialog;
    deleteBot = deps.deleteBot;
    setBotPinned = deps.setBotPinned;
  }

  function botByKey(key) {
    if (!state) return null;
    const bots = allOwnedBots();
    return bots.find((item) => item.key === key) || null;
  }

  function avatarForBot(bot = {}) {
    const api = contact();
    if (api?.resolveContact && api?.IdentityKind) {
      return api.resolveContact(
        { kind: api.IdentityKind.Bot, ref: bot.id || bot.key },
        { bots: [bot] }
      ).avatar;
    }
    return window.miaAvatarResolve.resolveAvatarForContact({
      id: botAvatarIdentityId(bot),
      displayName: bot.name || bot.key || bot.id,
      avatarImage: bot.avatarImage || "",
      avatarCrop: bot.avatarCrop || null,
      color: bot.color || bot.avatarColor || bot.avatar_color || ""
    });
  }

  function allOwnedBots() {
    if (!state) return [];
    const socialBots = window.miaSocial?._internalCtx?.adapterCtx?.()?.bots
      || window.miaSocial?.moduleState?.bots
      || [];
    const localBots = [
      ...(Array.isArray(state.runtime?.bots) ? state.runtime.bots : [])
    ];
    return window.miaBotDirectory.listOwnedBots({
      cloudBots: socialBots,
      localBots,
      runtime: state.runtime || {}
    });
  }

  function sortBotsForSidebar(bots = []) {
    return bots
      .map((bot, index) => ({ bot, index }))
      .sort((a, b) => {
        const pinnedDiff = Number(Boolean(b.bot.pinned)) - Number(Boolean(a.bot.pinned));
        if (pinnedDiff) return pinnedDiff;
        if (a.bot.pinned && b.bot.pinned) {
          const timeDiff = String(b.bot.pinnedAt || "").localeCompare(String(a.bot.pinnedAt || ""));
          if (timeDiff) return timeDiff;
        }
        return a.index - b.index;
      })
      .map((item) => item.bot);
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

  function contactSessionSummary(bot) {
    // Cloud-only: the contacts list no longer derives a preview from local
    // sessions; it shows the bot's subtitle.
    return { count: 0, preview: `${botSubtitle(bot)} · 暂无对话`, time: "" };
  }

  function contactPetLabel(pet = {}) {
    if (pet.placed) return "桌面中";
    if (pet.hasAsset) return "已生成桌宠";
    return "";
  }

  async function openBotChat(botKey) {
    if (!botKey || !state || !els) return;
    // Cloud-only: opening a bot chat always routes through the cloud
    // conversation opener (always present).
    await window.miaOpenBotConversation?.(botKey);
  }

  // "使用" a skill from the skills page: enable it on the chosen Bot (so the
  // engine actually gets it, via buildEnabledSkillsContext) and open that chat.
  async function useSkillOnBot(botKey, skillId) {
    if (!botKey || !skillId || !state) return;
    const bot = allOwnedBots().find((item) => item.key === botKey);
    if (!bot) return;
    const caps = botCapabilities(bot);
    if (!caps.enabledSkills.includes(skillId)) {
      await saveBotCapabilities(bot, toggleCapabilityId(caps, skillId, "enabledSkills", "disabledSkills", true));
    }
    await openBotChat(botKey);
  }

  function defaultBotCapabilities() {
    return botIdentity()?.normalizeBotCapabilities?.({}) || {
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
    return botIdentity()?.normalizeCapabilityIds?.(input)
      || (Array.isArray(input) ? [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))] : []);
  }

  function botCapabilities(bot = {}) {
    const normalizer = botIdentity()?.normalizeBotCapabilities;
    if (typeof normalizer === "function") return normalizer(bot.capabilities);
    const raw = bot.capabilities && typeof bot.capabilities === "object" ? bot.capabilities : {};
    return { ...defaultBotCapabilities(), ...raw };
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

  function botDeviceLabel(bot = {}) {
    return window.miaBotDirectory.runtimeLabelFor(bot, state?.runtime || {});
  }

  function botSubtitle(bot = {}) {
    return firstNonEmpty(bot.bio, bot.description, botDeviceLabel(bot));
  }

  function botCapabilityItems(bot = {}) {
    if (!state) return { skills: [] };
    const engine = bot.agentEngine || bot.agent_engine || "hermes";
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

  function renderBotCapabilitiesPanel(bot) {
    const capabilities = botCapabilities(bot);
    const { skills } = botCapabilityItems(bot);
    const engine = bot.agentEngine || bot.agent_engine || "hermes";
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
    const bots = allOwnedBots();
    const pendingRequests = window.miaSocial?.pendingRequestCount?.() || 0;
    if (!bots.length && !pendingRequests) {
      els.contactList.innerHTML = `<div class="contact-empty">还没有联系人</div>`;
      els.contactDetail.innerHTML = `<div class="contact-empty detail-empty">添加一个伙伴后会显示在这里</div>`;
      return;
    }
    const onRequests = state.activeContactKey === FRIEND_REQUESTS_KEY;
    if (onRequests && !pendingRequests) {
      // The pending list emptied (all accepted/rejected) — fall back to a real contact.
      state.activeContactKey = bots[0]?.key || null;
    } else if (!onRequests && !bots.some((bot) => bot.key === state.activeContactKey)) {
      state.activeContactKey = bots[0]?.key || (pendingRequests ? FRIEND_REQUESTS_KEY : null);
    }
    const filter = state.contactFilter.trim().toLowerCase();
    const visibleContacts = sortBotsForSidebar(filter
      ? bots.filter((bot) => `${bot.name || ""} ${bot.key || ""} ${bot.bio || ""}`.toLowerCase().includes(filter))
      : bots);
    els.contactList.innerHTML = "";
    if (pendingRequests && !filter) {
      els.contactList.appendChild(buildFriendRequestRow(pendingRequests));
    }
    for (const bot of visibleContacts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `contact-row${bot.key === state.activeContactKey ? " active" : ""}`;
      button.innerHTML = `
        <span class="avatar bot-photo"></span>
        <span class="contact-row-main">
          <strong>${window.miaMarkdown.escapeHtml(bot.name)}</strong>
        </span>
      `;
      button.addEventListener("click", () => {
        state.activeContactKey = bot.key;
        showNarrowContent();
        renderContacts();
      });
      button.addEventListener("dblclick", () => openBotChat(bot.key));
      const avatar = avatarForBot(bot);
      window.miaAvatar.applyAvatarMedia(
        button.querySelector(".bot-photo"),
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
      renderContactDetail(bots.find((bot) => bot.key === state.activeContactKey) || visibleContacts[0] || bots[0]);
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

  function renderContactDetail(bot) {
    if (!state || !els || !els.contactDetail || !bot) return;
    const summary = contactSessionSummary(bot);
    const engine = bot.agentEngine || bot.agent_engine || bot.engine || "hermes";
    setText(els.contactPageTitle, bot.name || "联系人");
    setText(els.contactPageMeta, botDeviceLabel(bot));
    const canEditBot = bot.canEditIdentity !== false;
    const canDeleteBot = bot.canDelete !== false;
    els.contactDetail.innerHTML = `
      <article class="contact-profile">
        <header class="contact-profile-head">
          <button class="contact-profile-avatar" type="button" ${canEditBot ? 'data-contact-action="edit" title="编辑联系人头像"' : 'title="联系人头像"'}></button>
          <div class="contact-profile-title">
            <h2>${window.miaMarkdown.escapeHtml(bot.name || "联系人")}</h2>
            <div class="contact-engine-badge" title="Agent 引擎">
              ${engineLogoHtml(engine)}
              <span class="contact-engine-copy">
                <small>Agent</small>
                <strong>${window.miaMarkdown.escapeHtml(engineLabel(engine))}</strong>
              </span>
            </div>
            <p>${window.miaMarkdown.escapeHtml(botSubtitle(bot))}</p>
          </div>
          <div class="contact-actions">
            <button class="primary contact-message-action" type="button" data-contact-action="message" title="发消息" aria-label="发消息">${window.miaMarkdown.iconParkIcon("message", "contact-action-icon")}</button>
            ${canEditBot ? `<button class="secondary" type="button" data-contact-action="edit">编辑</button>` : ""}
            ${canDeleteBot ? `<button class="secondary danger" type="button" data-contact-action="delete">删除伙伴</button>` : ""}
          </div>
        </header>
        <section class="contact-note">
          <strong>最近内容</strong>
          <p>${window.miaMarkdown.escapeHtml(summary.preview)}</p>
        </section>
        ${bot.canConfigureCapabilities !== false ? renderBotCapabilitiesPanel(bot) : ""}
      </article>
    `;
    const avatar = avatarForBot(bot);
    window.miaAvatar.applyAvatarMedia(
      els.contactDetail.querySelector(".contact-profile-avatar"),
      avatar.image,
      avatar.crop,
      avatar.color,
      avatar.text
    );
    els.contactDetail.querySelector('[data-contact-action="message"]')?.addEventListener("click", () => openBotChat(bot.key));
    els.contactDetail.querySelectorAll('[data-contact-action="edit"]').forEach((button) => {
      button.addEventListener("click", () => openEditBotDialog(bot.key));
    });
    els.contactDetail.querySelector('[data-contact-action="delete"]')?.addEventListener("click", async () => {
      await deleteBot(bot.key);
    });
    if (bot.canConfigureCapabilities !== false) wireBotCapabilities(bot);
  }

  async function saveBotCapabilities(bot, capabilities) {
    if (!bot?.key || !state) return;
    state.savingBotCapabilities.add(bot.key);
    try {
      const result = await window.miaBotCommands.saveBotCapabilities({
        state,
        bot,
        capabilities,
        api: window.mia,
        social: window.miaSocial
      });
      if (result?.runtime) state.runtime = result.runtime;
    } catch (error) {
      window.alert(`保存能力设置失败：${error.message || error}`);
    } finally {
      state.savingBotCapabilities.delete(bot.key);
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

  function wireBotCapabilities(bot) {
    if (!els || !els.contactDetail || !bot) return;
    els.contactDetail.querySelectorAll("[data-capability-type][data-capability-id]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.dataset.capabilityId || "";
        const type = input.dataset.capabilityType || "";
        let capabilities = botCapabilities(bot);
        if (type === "skill") {
          capabilities = toggleCapabilityId(capabilities, id, "enabledSkills", "disabledSkills", input.checked);
        }
        await saveBotCapabilities(bot, capabilities);
      });
    });
  }

  function petStatusForKey(key) {
    return state?.runtime?.pets?.[key] || { hasAsset: false, placed: false, petId: "" };
  }

  function openBotContextMenu(botKey, x, y) {
    if (!botKey || !state) return;
    window.miaMessageMenu?.closeMessageContextMenu();
    closeGroupContextMenu?.(); // group subsystem removed in unification — dep no longer injected
    state.botContextMenu = { open: true, x, y, botKey };
    renderBotContextMenu();
  }

  function closeBotContextMenu() {
    if (!state || !state.botContextMenu.open) return;
    state.botContextMenu = { open: false, x: 0, y: 0, botKey: "" };
    renderBotContextMenu();
  }

  function renderBotContextMenu() {
    if (!state || !els || !els.botContextMenu) return;
    const menu = els.botContextMenu;
    const bot = botByKey(state.botContextMenu.botKey);
    const open = state.botContextMenu.open && bot;
    menu.classList.toggle("hidden", !open);
    if (!open) return;
    const pet = petStatusForKey(bot.key);
    const canDeleteBot = bot.canDelete !== false;
    const petAction = pet.hasAsset
      ? pet.placed
        ? window.miaMarkdown.menuItemHtml({ icon: "message", label: `收回「${bot.name}」`, attrs: 'data-bot-action="recall"' })
        : window.miaMarkdown.menuItemHtml({ icon: "message", label: "放进桌面", attrs: 'data-bot-action="place"' })
      : window.miaMarkdown.menuItemHtml({ icon: "addPic", label: "生成桌宠", attrs: 'data-bot-action="generate-pet"' });
    menu.innerHTML = `
      ${window.miaMarkdown.menuItemHtml({ icon: "pin", label: bot.pinned ? "取消置顶" : "置顶", attrs: 'data-bot-action="pin"' })}
      ${window.miaMarkdown.menuItemHtml({ icon: "edit", label: "编辑", attrs: 'data-bot-action="edit"' })}
      ${petAction}
      ${canDeleteBot ? `<div class="skill-context-menu-separator" role="separator"></div>${window.miaMarkdown.menuItemHtml({ icon: "delete", label: "删除伙伴", attrs: 'data-bot-action="delete"', className: "danger" })}` : ""}
    `;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 138;
    const height = rect.height || (canDeleteBot ? 158 : 114);
    menu.style.left = `${Math.max(8, Math.min(state.botContextMenu.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(state.botContextMenu.y, window.innerHeight - height - 8))}px`;
    menu.querySelector('[data-bot-action="edit"]')?.addEventListener("click", () => {
      closeBotContextMenu();
      openEditBotDialog(bot.key);
    });
    menu.querySelector('[data-bot-action="pin"]')?.addEventListener("click", async () => {
      closeBotContextMenu();
      await setBotPinned(bot.key, !bot.pinned);
    });
    menu.querySelector('[data-bot-action="generate-pet"]')?.addEventListener("click", () => {
      closeBotContextMenu();
      window.miaPetDialog?.openPetGenerateDialog(bot.key);
    });
    menu.querySelector('[data-bot-action="place"]')?.addEventListener("click", async () => {
      closeBotContextMenu();
      await window.miaPetDialog?.placeBotPet(bot.key);
    });
    menu.querySelector('[data-bot-action="recall"]')?.addEventListener("click", async () => {
      closeBotContextMenu();
      await window.miaPetDialog?.recallBotPet(bot.key);
    });
    menu.querySelector('[data-bot-action="delete"]')?.addEventListener("click", async () => {
      closeBotContextMenu();
      await deleteBot(bot.key);
    });
  }

  window.miaBotManager = {
    FRIEND_REQUESTS_KEY,
    initBotManager,
    botByKey,
    sortBotsForSidebar,
    sortableConversationTime,
    sortMessageCardsForSidebar,
    allOwnedBots,
    useSkillOnBot,
    contactSessionSummary,
    contactPetLabel,
    openBotChat,
    defaultBotCapabilities,
    normalizeCapabilityIds,
    botCapabilities,
    capabilityForEngine,
    engineLabel,
    botCapabilityItems,
    capabilityChecked,
    botDeviceLabel,
    botSubtitle,
    engineLogoHtml,
    renderCapabilityCheckbox,
    renderBotCapabilitiesPanel,
    renderContacts,
    renderContactDetail,
    saveBotCapabilities,
    toggleCapabilityId,
    wireBotCapabilities,
    petStatusForKey,
    openBotContextMenu,
    closeBotContextMenu,
    renderBotContextMenu,
  };
})();
