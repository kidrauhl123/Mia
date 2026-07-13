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
  let closeGroupContextMenu, openEditBotDialog, deleteBot;
  let runtimeDevicesLoading = false;
  let runtimeDevicesLoadedAt = 0;
  let contactMemoryLoadToken = 0;
  const RUNTIME_DEVICE_REFRESH_INTERVAL_MS = 15000;
  const MEMORY_LIST_TIMEOUT_MS = 3000;
  const OTHER_DEVICE_GROUP_KEY = "other-devices";
  const CONTACT_GROUP_COLLAPSED_KEY = "mia.contactGroupCollapsed.v1";
  const contactNameCollator = new Intl.Collator(["zh-Hans-CN-u-co-pinyin", "en"], {
    sensitivity: "base",
    numeric: true
  });
  const contactPinyinBoundaries = [
    ["A", "阿"], ["B", "八"], ["C", "嚓"], ["D", "咑"], ["E", "妸"],
    ["F", "发"], ["G", "旮"], ["H", "哈"], ["J", "击"], ["K", "喀"],
    ["L", "垃"], ["M", "妈"], ["N", "拿"], ["O", "哦"], ["P", "啪"],
    ["Q", "期"], ["R", "然"], ["S", "撒"], ["T", "塌"], ["W", "哇"],
    ["X", "西"], ["Y", "压"], ["Z", "匝"]
  ];

  function readLocalJson(key, fallback) {
    try {
      const raw = window.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeLocalJson(key, value) {
    try {
      window.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
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
    return contact()?.botAvatarIdentityId?.(localId, bot)
      || bot.id
      || bot.key
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
  }

  function botByKey(key) {
    if (!state) return null;
    const bots = allOwnedBots();
    return bots.find((item) => item.key === key) || null;
  }

  function withMemoryListTimeout(promise) {
    const setTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : (typeof setTimeout === "function" ? setTimeout : null);
    const clearTimer = typeof window !== "undefined" && typeof window.clearTimeout === "function"
      ? window.clearTimeout.bind(window)
      : (typeof clearTimeout === "function" ? clearTimeout : null);
    if (!setTimer || !clearTimer) return Promise.resolve(promise);
    let timer = 0;
    return new Promise((resolve, reject) => {
      timer = setTimer(() => {
        reject(new Error("记忆加载超时，请稍后重试。"));
      }, MEMORY_LIST_TIMEOUT_MS);
      Promise.resolve(promise).then(
        (value) => {
          clearTimer(timer);
          resolve(value);
        },
        (error) => {
          clearTimer(timer);
          reject(error);
        }
      );
    });
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
    return window.miaBotDirectory.listOwnedBots({
      identityBots: socialBots,
      runtime: state.runtime || {}
    });
  }

  function contactSortLabel(bot = {}) {
    return String(bot.name || bot.displayName || bot.key || bot.id || "").trim();
  }

  function statusBadgeFrom(...sources) {
    for (const source of sources) {
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
    }
    return undefined;
  }

  function renderBotNameWithBadgeHtml(bot = {}, fallback = "") {
    const name = fallback || bot.name || bot.displayName || bot.display_name || bot.key || bot.id || "联系人";
    const renderer = window.miaNameWithBadge;
    if (renderer && typeof renderer.renderNameWithBadgeHtml === "function") {
      try {
        return renderer.renderNameWithBadgeHtml({
          identity: {
            kind: "bot",
            id: bot.id || bot.key || "",
            displayName: name,
            statusBadge: statusBadgeFrom(bot)
          },
          fallbackName: name,
          statusBadge: statusBadgeFrom(bot)
        });
      } catch {
        // Keep contact rendering resilient to optional badge payloads.
      }
    }
    return window.miaMarkdown.escapeHtml(name);
  }

  function setBotNameWithBadge(el, bot = {}, fallback = "") {
    if (!el) return;
    const name = fallback || bot.name || bot.displayName || bot.display_name || bot.key || bot.id || "联系人";
    const renderer = window.miaNameWithBadge;
    if (renderer && (typeof renderer.setNameWithBadge === "function" || typeof renderer.renderNameWithBadge === "function")) {
      try {
        const payload = {
          identity: {
            kind: "bot",
            id: bot.id || bot.key || "",
            displayName: name,
            statusBadge: statusBadgeFrom(bot)
          },
          fallbackName: name,
          statusBadge: statusBadgeFrom(bot)
        };
        if (typeof renderer.setNameWithBadge === "function") {
          renderer.setNameWithBadge(el, payload);
        } else {
          el.replaceChildren(renderer.renderNameWithBadge(payload));
        }
        return;
      } catch {
        // Fall through to plain text.
      }
    }
    setText(el, name);
  }

  function initNameBadgeLotties(root) {
    try { window.miaNameWithBadge?.initLottieBadges?.(root); } catch { /* optional badge animation */ }
  }

  function contactGroupKey(bot = {}) {
    const first = Array.from(contactSortLabel(bot))[0] || "";
    const upper = first.toUpperCase();
    if (/^[A-Z]$/.test(upper)) return upper;
    if (/^[\u4E00-\u9FFF]$/.test(first)) {
      for (let i = contactPinyinBoundaries.length - 1; i >= 0; i -= 1) {
        if (contactNameCollator.compare(first, contactPinyinBoundaries[i][1]) >= 0) return contactPinyinBoundaries[i][0];
      }
    }
    return "#";
  }

  function contactDisplayGroupKey(bot = {}) {
    return botRunsOnOtherDevice(bot) ? OTHER_DEVICE_GROUP_KEY : contactGroupKey(bot);
  }

  function contactGroupLabel(key) {
    return key === OTHER_DEVICE_GROUP_KEY ? "其他设备" : key;
  }

  function contactGroupRank(key) {
    if (key === OTHER_DEVICE_GROUP_KEY) return 100;
    if (/^[A-Z]$/.test(key)) return key.charCodeAt(0) - 64;
    return 27;
  }

  function sortBotsForSidebar(bots = []) {
    return bots
      .map((bot, index) => ({ bot, index }))
      .sort((a, b) => {
        const groupDiff = contactGroupRank(contactGroupKey(a.bot)) - contactGroupRank(contactGroupKey(b.bot));
        if (groupDiff) return groupDiff;
        const labelDiff = contactNameCollator.compare(contactSortLabel(a.bot), contactSortLabel(b.bot));
        if (labelDiff) return labelDiff;
        const keyDiff = contactNameCollator.compare(String(a.bot.key || a.bot.id || ""), String(b.bot.key || b.bot.id || ""));
        if (keyDiff) return keyDiff;
        return a.index - b.index;
      })
      .map((item) => item.bot);
  }

  function contactGroupsForSidebar(bots = []) {
    const groups = new Map();
    for (const bot of bots) {
      const key = contactDisplayGroupKey(bot);
      if (!groups.has(key)) groups.set(key, { key, label: contactGroupLabel(key), bots: [] });
      groups.get(key).bots.push(bot);
    }
    return [...groups.values()].sort((a, b) => {
      const rankDiff = contactGroupRank(a.key) - contactGroupRank(b.key);
      if (rankDiff) return rankDiff;
      return contactNameCollator.compare(a.label, b.label);
    });
  }

  function contactGroupCollapsedSet() {
    const saved = readLocalJson(CONTACT_GROUP_COLLAPSED_KEY, null);
    return new Set(Array.isArray(saved) ? saved : [OTHER_DEVICE_GROUP_KEY]);
  }

  function isContactGroupCollapsed(key, options = {}) {
    if (options.forceExpanded) return false;
    return contactGroupCollapsedSet().has(key);
  }

  function toggleContactGroupCollapsed(key) {
    const collapsed = contactGroupCollapsedSet();
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    writeLocalJson(CONTACT_GROUP_COLLAPSED_KEY, [...collapsed]);
  }

  function appendContactGroupHeader(group, options = {}) {
    const key = String(group?.key || group || "").trim();
    const label = String(group?.label || contactGroupLabel(key)).trim();
    const count = Number(group?.bots?.length) || 0;
    const collapsed = Boolean(options.collapsed);
    const header = document.createElement("button");
    header.type = "button";
    header.className = `contact-group-header contact-group-toggle${collapsed ? " collapsed" : ""}`;
    header.dataset.contactGroupKey = key;
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    header.innerHTML = `
      <span>${window.miaMarkdown.escapeHtml(label)}</span>
      ${count ? `<small>${window.miaMarkdown.escapeHtml(String(count))}</small>` : ""}
    `;
    header.addEventListener("click", () => {
      toggleContactGroupCollapsed(key);
      renderContacts();
    });
    els.contactList.appendChild(header);
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
  // engine actually gets it through turn skill materialization) and open that chat.
  async function useSkillOnBot(botKey, skillId) {
    if (!botKey || !skillId || !state) return;
    const bot = allOwnedBots().find((item) => item.key === botKey);
    if (!bot) return;
    await saveBotCapabilityIntent(bot, {
      capabilityType: "skill",
      capabilityId: skillId,
      checked: true
    });
    await openBotChat(botKey);
  }

  function engineLabel(engine = "") {
    if (!engine) return "未同步";
    if (engine === "mia") return "Mia";
    return window.miaEngineContracts?.engineLabel?.(engine) || "Hermes";
  }

  function engineLogoKind(engine = "") {
    if (!engine) return "unknown";
    const normalized = window.miaEngineContracts?.normalizeAgentEngine?.(engine) || engine;
    if (normalized === "claude-code") return "claude";
    if (normalized === "codex") return "codex";
    return "hermes";
  }

  function engineLogoHtml(engine = "") {
    const kind = engineLogoKind(engine);
    const iconSrc = {
      hermes: "./assets/engine-icons/hermesagent.svg",
      claude: "./assets/engine-icons/claudecode.svg",
      codex: "./assets/engine-icons/codex-color.svg"
    }[kind];
    if (kind === "unknown") return `<span class="engine-row-logo contact-engine-logo unknown" aria-hidden="true"></span>`;
    if (!iconSrc) return `<span class="engine-row-logo contact-engine-logo ${window.miaMarkdown.escapeHtml(kind)}" aria-hidden="true"></span>`;
    return `<span class="engine-row-logo contact-engine-logo asset ${window.miaMarkdown.escapeHtml(kind)}" aria-hidden="true"><img src="${iconSrc}" alt=""></span>`;
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = String(value || "").trim();
      if (next) return next;
    }
    return "";
  }

  function botDeviceLabel(bot = {}) {
    const projection = runtimeTargetProjection(bot);
    return firstNonEmpty(
      projection.runtimeLabel,
      bot.runtimeLabel,
      bot.runtime_label,
      "正在同步运行目标..."
    );
  }

  function runtimeTargetProjection(bot = {}) {
    const options = cachedRuntimeTargetOptions(bot) || {};
    return {
      runtimeLabel: String(options.runtimeLabel || options.runtime_label || "").trim(),
      runsOnOtherDevice: Boolean(options.runsOnOtherDevice || options.runs_on_other_device)
    };
  }

  function contactUid(bot = {}) {
    return firstNonEmpty(bot.uid, bot.publicId, bot.public_id, bot.id, bot.key, bot.globalId, bot.global_id);
  }

  function contactMemoryBotId(bot = {}) {
    return firstNonEmpty(bot.key, bot.id, bot.botKey, bot.bot_id, bot.accountId, bot.account_id, contactUid(bot));
  }

  function botPresetForContact(bot = {}) {
    const presets = Array.isArray(state?.skillLibrary?.botPresets) ? state.skillLibrary.botPresets : [];
    const botKeys = [bot.key, bot.id, bot.account_id, bot.accountId]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const botNames = [bot.name, bot.displayName, bot.display_name, bot.username]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return presets.find((preset) => {
      const presetKeys = [preset?.key, preset?.id]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      if (botKeys.some((key) => presetKeys.includes(key))) return true;
      const presetNames = [preset?.name, preset?.displayName, preset?.display_name]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      return botNames.some((name) => presetNames.includes(name));
    }) || null;
  }

  function botPersonaText(bot = {}) {
    return firstNonEmpty(
      bot.personaText,
      bot.persona_text,
      bot.persona,
      bot.systemPrompt,
      bot.system_prompt,
      botPresetForContact(bot)?.persona
    );
  }

  function capabilityOptionsApi() {
    return window.mia?.social?.getBotCapabilityOptions || window.miaSocial?.getBotCapabilityOptions || null;
  }

  function ensureCapabilityOptionsState() {
    if (!state.botCapabilityOptionsCache) state.botCapabilityOptionsCache = new Map();
    if (!state.botCapabilityOptionsLoadingKeys) state.botCapabilityOptionsLoadingKeys = new Set();
  }

  function capabilityOptionsKey(bot = {}) {
    return String(bot.key || bot.id || "").trim();
  }

  function capabilityOptionsRequest(bot = {}, intent = null) {
    const displayName = window.miaSkillHelpers?.skillDisplayName;
    const availableSkills = Array.isArray(state?.skillLibrary?.skills)
      ? state.skillLibrary.skills.map((skill) => ({
          ...skill,
          ...(typeof displayName === "function" ? { nameZh: displayName(skill) } : {})
        }))
      : [];
    return {
      bot,
      availableSkills,
      botPresets: Array.isArray(state?.skillLibrary?.botPresets) ? state.skillLibrary.botPresets : [],
      ...(intent ? { intent } : {})
    };
  }

  function normalizeCoreCapabilityOption(option = {}) {
    const capabilityId = String(option.capabilityId || option.capability_id || option.id || "").trim();
    return {
      id: String(option.id || capabilityId).trim(),
      capabilityId,
      label: String(option.label || option.title || option.name || capabilityId || "").trim(),
      source: String(option.source || "").trim(),
      origin: String(option.origin || "").trim(),
      inherited: Boolean(option.inherited),
      checked: Boolean(option.checked),
      missing: Boolean(option.missing)
    };
  }

  function normalizeCoreCapabilityGroup(group = {}) {
    return {
      id: String(group.id || "").trim(),
      label: String(group.label || "").trim(),
      kind: String(group.kind || "skill").trim() || "skill",
      options: (Array.isArray(group.options) ? group.options : [])
        .map(normalizeCoreCapabilityOption)
        .filter((option) => option.capabilityId)
    };
  }

  function normalizeCoreCapabilityOptions(response = {}) {
    const data = response?.data && typeof response.data === "object" && Array.isArray(response.data.groups)
      ? response.data
      : response;
    return {
      capabilities: data?.capabilities && typeof data.capabilities === "object" ? data.capabilities : {},
      summary: String(data?.summary || "未设置默认技能"),
      groups: (Array.isArray(data?.groups) ? data.groups : []).map(normalizeCoreCapabilityGroup)
    };
  }

  async function loadBotCapabilityOptions(bot = {}) {
    if (!state) return null;
    ensureCapabilityOptionsState();
    const key = capabilityOptionsKey(bot);
    if (!key || state.botCapabilityOptionsCache.has(key) || state.botCapabilityOptionsLoadingKeys.has(key)) {
      return state.botCapabilityOptionsCache.get(key) || null;
    }
    const api = capabilityOptionsApi();
    if (typeof api !== "function") {
      state.botCapabilityOptionsCache.set(key, {
        capabilities: {},
        summary: "能力配置不可用",
        groups: []
      });
      return state.botCapabilityOptionsCache.get(key);
    }
    state.botCapabilityOptionsLoadingKeys.add(key);
    try {
      const response = await api(capabilityOptionsRequest(bot));
      const options = normalizeCoreCapabilityOptions(response);
      state.botCapabilityOptionsCache.set(key, options);
      return options;
    } catch (error) {
      state.botCapabilityOptionsCache.set(key, {
        capabilities: {},
        summary: error?.message || "能力配置加载失败",
        groups: []
      });
      return state.botCapabilityOptionsCache.get(key);
    } finally {
      state.botCapabilityOptionsLoadingKeys.delete(key);
      if (state.activeContactKey === key) renderContacts();
    }
  }

  function botCapabilityOptions(bot = {}) {
    if (!state) return null;
    ensureCapabilityOptionsState();
    const key = capabilityOptionsKey(bot);
    if (!key) return null;
    const cached = state.botCapabilityOptionsCache.get(key) || null;
    if (!cached) loadBotCapabilityOptions(bot);
    return cached;
  }

  function capabilityGroup(options, id) {
    return (options?.groups || []).find((group) => group.id === id) || { options: [] };
  }

  function renderCapabilityCheckbox({ option, type, className = "" }) {
    const title = option.label || option.capabilityId;
    const capabilityId = option.capabilityId || option.id;
    const rowClass = ["capability-row", className].filter(Boolean).join(" ");
    const originLabel = {
      "system-default": "系统默认",
      "assistant-preset": "助手预设",
      manual: "手动添加"
    }[option.origin] || "";
    return `
      <label class="${window.miaMarkdown.escapeHtml(rowClass)}">
        <input type="checkbox" data-capability-type="${window.miaMarkdown.escapeHtml(type)}" data-capability-id="${window.miaMarkdown.escapeHtml(capabilityId)}" ${option.checked ? "checked" : ""}>
        <span class="capability-copy">
          <strong>${window.miaMarkdown.escapeHtml(title)}</strong>
          ${originLabel ? `<small>${window.miaMarkdown.escapeHtml(originLabel)}</small>` : ""}
        </span>
        <span class="capability-check" aria-hidden="true"></span>
      </label>
    `;
  }

  function renderBotCapabilitiesPanel(bot) {
    const options = botCapabilityOptions(bot);
    const skills = capabilityGroup(options, "enabled-skills").options;
    const addableSkills = capabilityGroup(options, "addable-skills").options;
    const panelOpen = state?.openCapabilityPanelKeys?.has?.(bot?.key);
    const summary = !options
      ? "同步能力选项"
      : state?.skillsLoading
      ? "正在加载技能"
      : options.summary;
    return `
      <details class="contact-capabilities accordion-details" data-capabilities-panel-key="${window.miaMarkdown.escapeHtml(bot?.key || "")}"${panelOpen ? " open" : ""}>
        <summary>
          <div>
            <strong>能力</strong>
            <p>${window.miaMarkdown.escapeHtml(summary)}</p>
          </div>
          <span class="runtime-target-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="accordion-body">
          <div class="capability-list capability-list-enabled">
            ${skills.length ? skills.map((option) => renderCapabilityCheckbox({
              option,
              type: "skill",
              className: "enabled"
            })).join("") : `<div class="capability-empty">这个 Bot 还没有默认启用的技能</div>`}
          </div>
          ${addableSkills.length ? `
            <details class="capability-add-details">
              <summary><span aria-hidden="true">+</span><strong>添加技能</strong></summary>
              <div class="capability-list capability-list-add">
                ${addableSkills.map((option) => renderCapabilityCheckbox({
                  option,
                  type: "skill",
                  className: "addable"
                })).join("")}
              </div>
            </details>
          ` : ""}
        </div>
      </details>
    `;
  }

  function renderBotPersonaPanel(bot) {
    const persona = botPersonaText(bot);
    const panelOpen = state?.openPersonaPanelKeys?.has?.(bot?.key);
    const summary = persona ? persona.replace(/\s+/g, " ").trim() : "还没有设置人设";
    return `
      <details class="contact-persona-card accordion-details" data-persona-panel-key="${window.miaMarkdown.escapeHtml(bot?.key || "")}"${panelOpen ? " open" : ""}>
        <summary>
          <div>
            <strong>人设</strong>
            <p>${window.miaMarkdown.escapeHtml(summary)}</p>
          </div>
          <span class="runtime-target-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="accordion-body">
          <p class="contact-persona-text">${window.miaMarkdown.escapeHtml(persona || "还没有设置人设。")}</p>
        </div>
      </details>
    `;
  }

  function ensureContactMemoryPanel(bot = null) {
    if (!state) return {};
    const botId = contactMemoryBotId(bot || {});
    const current = state.contactMemoryPanel && typeof state.contactMemoryPanel === "object"
      ? state.contactMemoryPanel
      : {};
    if (current.botId !== botId) {
      state.contactMemoryPanel = {
        botId,
        entries: [],
        loaded: false,
        loading: false,
        error: ""
      };
    } else {
      current.botId = botId;
      if (!Array.isArray(current.entries)) current.entries = [];
      current.loaded = Boolean(current.loaded);
      current.loading = Boolean(current.loading);
      current.error = current.error || "";
      state.contactMemoryPanel = current;
    }
    return state.contactMemoryPanel;
  }

  function scheduleContactMemoryLoad(botId = "") {
    if (!botId) return;
    if (!window.mia?.memory?.list) {
      const panel = ensureContactMemoryPanel(botByKey(botId) || { key: botId });
      panel.entries = [];
      panel.loaded = true;
      panel.loading = false;
      panel.error = "";
      const timer = typeof window !== "undefined" && typeof window.setTimeout === "function"
        ? window.setTimeout.bind(window)
        : (typeof setTimeout === "function" ? setTimeout : null);
      if (timer) timer(() => renderContacts(), 0);
      else renderContacts();
      return;
    }
    const timer = typeof window !== "undefined" && typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : (typeof setTimeout === "function" ? setTimeout : null);
    const panel = ensureContactMemoryPanel(botByKey(botId) || { key: botId });
    panel.loading = true;
    panel.error = "";
    const run = () => loadContactMemoryEntries(botId, { allowWhileLoading: true });
    if (timer) timer(run, 0);
    else run();
  }

  function renderContactMemoryPanel(bot) {
    const panel = ensureContactMemoryPanel(bot);
    const botId = contactMemoryBotId(bot);
    if (!botId && !panel.loaded) {
      panel.loaded = true;
      panel.loading = false;
      panel.error = "";
    }
    if (botId && !panel.loaded && !panel.loading && !panel.error) scheduleContactMemoryLoad(botId);
    const entries = Array.isArray(panel.entries) ? panel.entries : [];
    const panelOpen = state?.openMemoryPanelKeys ? state.openMemoryPanelKeys.has(bot?.key) : true;
    const summary = panel.loading
      ? "正在加载记忆"
      : entries.length
        ? `${entries.length} 条长期记忆`
        : "暂无长期记忆";
    return `
      <details class="contact-memory-card accordion-details" data-memory-panel-key="${window.miaMarkdown.escapeHtml(bot?.key || "")}"${panelOpen ? " open" : ""}>
        <summary>
          <div>
            <strong>记忆</strong>
            <p>${window.miaMarkdown.escapeHtml(summary)}</p>
          </div>
          <span class="runtime-target-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="accordion-body contact-memory-body">
          ${renderContactMemoryList(panel)}
        </div>
      </details>
    `;
  }

  function renderContactMemoryList(panel = {}) {
    if (panel.error) return `
      <div class="contact-memory-error">
        <span>${window.miaMarkdown.escapeHtml(panel.error)}</span>
        <button class="secondary" type="button" data-memory-action="reload">重试</button>
      </div>
    `;
    if (panel.loading) return `<div class="contact-memory-empty">正在加载记忆...</div>`;
    const entries = Array.isArray(panel.entries) ? panel.entries : [];
    if (!entries.length) return `<div class="contact-memory-empty">暂无记忆</div>`;
    return `
      <div class="contact-memory-list">
        ${entries.map((entry) => {
          const id = window.miaMarkdown.escapeHtml(entry.id || "");
          const updated = String(entry.updatedAt || entry.createdAt || "").slice(0, 16).replace("T", " ");
          return `
            <article class="contact-memory-row" data-memory-id="${id}">
              ${updated ? `<div class="contact-memory-meta">${window.miaMarkdown.escapeHtml(updated)}</div>` : ""}
              <p>${window.miaMarkdown.escapeHtml(entry.text || "")}</p>
              <div class="contact-memory-actions">
                <button class="contact-memory-icon-button danger" type="button" data-memory-action="delete" data-memory-id="${id}" title="删除" aria-label="删除">
                  ${window.miaMarkdown.iconParkIcon("delete", "contact-memory-action-icon")}
                </button>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    `;
  }

  async function loadContactMemoryEntries(botId = "", options = {}) {
    if (!state) return;
    const bot = botByKey(botId) || { key: botId };
    const panel = ensureContactMemoryPanel(bot);
    if (!panel.botId) return;
    if (!window.mia?.memory?.list) {
      panel.entries = [];
      panel.loaded = true;
      panel.loading = false;
      panel.error = "";
      renderContacts();
      return;
    }
    if (panel.loading && !options.force && !options.allowWhileLoading) return;
    const token = ++contactMemoryLoadToken;
    panel.loading = true;
    panel.error = "";
    renderContacts();
    try {
      const result = await withMemoryListTimeout(window.mia.memory.list({
        botId: panel.botId,
        sessionId: "default",
        scopes: ["bot"],
        limit: 120
      }));
      if (token !== contactMemoryLoadToken || panel.botId !== botId) return;
      const entries = Array.isArray(result) ? result : (result?.entries || result?.memories || []);
      panel.entries = entries.filter((entry) => !entry.scope || entry.scope === "bot");
      panel.loaded = true;
    } catch (error) {
      if (token !== contactMemoryLoadToken) return;
      panel.entries = [];
      panel.loaded = true;
      panel.error = error?.message || "记忆加载失败";
    } finally {
      if (token === contactMemoryLoadToken) {
        panel.loading = false;
        renderContacts();
      }
    }
  }

  async function deleteContactMemory(bot, memoryId = "") {
    if (!bot?.key || !memoryId || !window.mia?.memory?.delete) return;
    if (!window.confirm?.("删除这条记忆？")) return;
    const panel = ensureContactMemoryPanel(bot);
    panel.loading = true;
    panel.error = "";
    renderContacts();
    try {
      await window.mia.memory.delete({ memoryId });
      await loadContactMemoryEntries(contactMemoryBotId(bot), { force: true });
    } catch (error) {
      panel.error = error?.message || "记忆删除失败";
      panel.loading = false;
      renderContacts();
    }
  }

  function wireContactMemoryPanel(bot) {
    if (!els || !els.contactDetail || !bot) return;
    const panelEl = els.contactDetail.querySelector(".contact-memory-card");
    panelEl?.addEventListener("toggle", () => {
      if (!state.openMemoryPanelKeys) state.openMemoryPanelKeys = new Set();
      if (panelEl.open) state.openMemoryPanelKeys.add(bot.key);
      else state.openMemoryPanelKeys.delete(bot.key);
    });
    panelEl?.querySelectorAll("[data-memory-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.memoryAction || "";
        const memoryId = button.dataset.memoryId || "";
        if (action === "reload") await loadContactMemoryEntries(contactMemoryBotId(bot), { force: true });
        if (action === "delete") await deleteContactMemory(bot, memoryId);
      });
    });
  }

  function refreshContactMemoryForBot(botId = "") {
    if (!state || !botId) return;
    const activeBot = botByKey(state.activeContactKey);
    const activeIds = [activeBot?.key, activeBot?.id].map((value) => String(value || "")).filter(Boolean);
    if (!activeBot || !activeIds.includes(String(botId || ""))) return;
    loadContactMemoryEntries(activeBot.key, { force: true });
  }

  function botRunsOnOtherDevice(bot = {}) {
    return runtimeTargetProjection(bot).runsOnOtherDevice;
  }

  function runtimeTargetOptionsCache() {
    if (!state.botRuntimeTargetOptions || typeof state.botRuntimeTargetOptions.get !== "function") {
      state.botRuntimeTargetOptions = new Map();
    }
    return state.botRuntimeTargetOptions;
  }

  function runtimeTargetOptionsLoadingKeys() {
    if (!state.botRuntimeTargetOptionsLoading || typeof state.botRuntimeTargetOptionsLoading.has !== "function") {
      state.botRuntimeTargetOptionsLoading = new Set();
    }
    return state.botRuntimeTargetOptionsLoading;
  }

  function runtimeTargetOptionsKey(bot = {}) {
    return String(bot.key || bot.id || "").trim();
  }

  function cachedRuntimeTargetOptions(bot = {}) {
    const key = runtimeTargetOptionsKey(bot);
    return key ? runtimeTargetOptionsCache().get(key) : null;
  }

  function loadRuntimeTargetOptions(bot = {}) {
    const key = runtimeTargetOptionsKey(bot);
    if (!key || typeof window.mia?.social?.getBotRuntimeTargetOptions !== "function") return;
    const cache = runtimeTargetOptionsCache();
    if (cache.has(key)) return;
    const loading = runtimeTargetOptionsLoadingKeys();
    if (loading.has(key)) return;
    loading.add(key);
    window.mia.social.getBotRuntimeTargetOptions({
      bot,
      runtime: state?.runtime || {},
      engineCapabilities: state?.engineCapabilities || {},
      preferredAgentEngine: state?.preferredAgentEngine || ""
    })
      .then((result) => {
        const data = result?.data || result || {};
        cache.set(key, data);
        renderContacts();
      })
      .catch((error) => console.warn("[bot-manager] runtime target options load failed:", error?.message || error))
      .finally(() => {
        loading.delete(key);
      });
  }

  function targetOptionHtml(option = {}, bot = {}) {
    const runtimeKind = String(option.runtimeKind || option.runtime_kind || "desktop-local");
    const agentEngine = String(option.agentEngine || option.agent_engine || "");
    const deviceId = String(option.deviceId || option.device_id || "");
    const deviceName = String(option.deviceName || option.device_name || "");
    const title = String(option.title || "");
    const saving = state?.savingBotRuntimeTargets?.has?.(bot?.key);
    const disabled = Boolean(saving || option.disabled);
    const attrs = runtimeKind === "cloud-claude-code"
      ? `data-runtime-kind="cloud-claude-code" data-agent-engine="${window.miaMarkdown.escapeHtml(agentEngine)}"`
      : `data-runtime-kind="desktop-local" data-device-id="${window.miaMarkdown.escapeHtml(deviceId)}" data-device-name="${window.miaMarkdown.escapeHtml(deviceName)}" data-agent-engine="${window.miaMarkdown.escapeHtml(agentEngine)}"`;
    return `
      <button type="button" class="runtime-target-option${option.selected ? " selected" : ""}${saving ? " saving" : ""}" ${attrs} title="${window.miaMarkdown.escapeHtml(title)}" ${disabled ? "disabled" : ""}>
        ${engineLogoHtml(option.iconKind || agentEngine)}
        <span>
          <strong>${window.miaMarkdown.escapeHtml(option.engineLabel || option.label || engineLabel(agentEngine))}</strong>
        </span>
      </button>
    `;
  }

  function renderBotRuntimeTargetPanel(bot) {
    const options = cachedRuntimeTargetOptions(bot);
    const groups = Array.isArray(options?.groups) ? options.groups : [];
    const panelOpen = state?.openRuntimeTargetPanelKeys?.has?.(bot?.key);
    return `
      <details class="contact-runtime-target accordion-details" data-runtime-panel-key="${window.miaMarkdown.escapeHtml(bot?.key || "")}"${panelOpen ? " open" : ""}>
        <summary>
          <div>
            <strong>运行位置和 Agent 内核</strong>
            <p>${window.miaMarkdown.escapeHtml(botDeviceLabel(bot))}</p>
          </div>
          <span class="runtime-target-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="accordion-body">
          <div class="runtime-target-list">
            ${groups.length ? groups.map((group) => `
              <section class="runtime-device-group">
                <div>
                  <strong>${window.miaMarkdown.escapeHtml(group.label || "运行目标")}</strong>
                  <small>${window.miaMarkdown.escapeHtml(group.statusLabel || group.status_label || "")}</small>
                </div>
                <div>
                  ${Array.isArray(group.options) && group.options.length
                    ? group.options.map((option) => targetOptionHtml(option, bot)).join("")
                    : '<p class="runtime-target-empty">没有可用 Agent</p>'}
                </div>
              </section>
            `).join("") : '<p class="runtime-target-empty">正在同步运行目标...</p>'}
          </div>
        </div>
      </details>
    `;
  }

  function refreshRuntimeDevicesForContacts() {
    const now = Date.now();
    if (runtimeDevicesLoading || !state?.runtime?.cloud?.enabled || typeof window.mia?.social?.listBridgeDevices !== "function") return;
    if (now - runtimeDevicesLoadedAt < RUNTIME_DEVICE_REFRESH_INTERVAL_MS) return;
    runtimeDevicesLoading = true;
    runtimeDevicesLoadedAt = now;
    window.mia.social.listBridgeDevices({ includeOffline: true })
      .then((result) => {
        const devices = result?.data?.devices || result?.devices || [];
        if (!Array.isArray(devices)) return;
        state.runtime = {
          ...(state.runtime || {}),
          cloud: {
            ...(state.runtime?.cloud || {}),
            devices
          }
        };
        runtimeTargetOptionsCache().clear();
        renderContacts();
      })
      .catch((error) => console.warn("[bot-manager] bridge devices load failed:", error?.message || error))
      .finally(() => { runtimeDevicesLoading = false; });
  }

  function renderContacts() {
    if (!state || !els || !els.contactList || !els.contactDetail) return;
    if (!state.skillsLoading && !(state.skillLibrary.extensions || []).length && !(state.skillLibrary.skills || []).length) {
      loadSkills().catch(() => {});
    }
    const bots = allOwnedBots();
    bots.forEach((bot) => loadRuntimeTargetOptions(bot));
    const pendingRequests = window.miaSocial?.pendingRequestCount?.() || 0;
    if (!bots.length && !pendingRequests) {
      els.contactList.innerHTML = `<div class="contact-empty">还没有联系人</div>`;
      els.contactDetail.__miaContactDetailHtmlKey = "";
      els.contactDetail.__miaContactDetailAvatarKey = "";
      els.contactDetail.innerHTML = `<div class="contact-empty detail-empty">添加一个伙伴后会显示在这里</div>`;
      return;
    }
    const onRequests = state.activeContactKey === FRIEND_REQUESTS_KEY;
    const sortedBots = sortBotsForSidebar(bots);
    const primarySortedBots = sortBotsForSidebar(bots.filter((bot) => !botRunsOnOtherDevice(bot)));
    const defaultActiveBot = primarySortedBots[0] || sortedBots[0] || null;
    if (onRequests && !pendingRequests) {
      // The pending list emptied (all accepted/rejected) — fall back to a real contact.
      state.activeContactKey = defaultActiveBot?.key || null;
    } else if (!onRequests && !bots.some((bot) => bot.key === state.activeContactKey)) {
      state.activeContactKey = defaultActiveBot?.key || (pendingRequests ? FRIEND_REQUESTS_KEY : null);
    }
    const filter = state.contactFilter.trim().toLowerCase();
    const filterActive = Boolean(filter);
    const visibleContacts = sortBotsForSidebar(filterActive
      ? bots.filter((bot) => `${bot.name || ""} ${bot.key || ""} ${bot.bio || ""}`.toLowerCase().includes(filter))
      : sortedBots);
    const contactGroups = contactGroupsForSidebar(visibleContacts);
    const listRenderKey = contactListRenderKey({ pendingRequests, filter, contactGroups, filterActive });
    if (els.contactList.__miaContactListRenderKey !== listRenderKey) {
      els.contactList.innerHTML = "";
      if (pendingRequests && !filter) {
        els.contactList.appendChild(buildFriendRequestRow(pendingRequests));
      }
      for (const group of contactGroups) {
        const collapsed = isContactGroupCollapsed(group.key, { forceExpanded: filterActive });
        appendContactGroupHeader(group, { collapsed });
        if (collapsed) continue;
        for (const bot of group.bots) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `contact-row${bot.key === state.activeContactKey ? " active" : ""}`;
          button.innerHTML = `
            <span class="avatar bot-photo"></span>
            <span class="contact-row-main">
              <strong>${renderBotNameWithBadgeHtml(bot)}</strong>
              ${botRunsOnOtherDevice(bot) ? `<small>${window.miaMarkdown.escapeHtml(botDeviceLabel(bot))}</small>` : ""}
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
      }
      initNameBadgeLotties(els.contactList);
      if (!visibleContacts.length && filter) {
        els.contactList.innerHTML = `<div class="contact-empty">没有匹配的联系人</div>`;
      }
      els.contactList.__miaContactListRenderKey = listRenderKey;
    }
    if (state.activeContactKey === FRIEND_REQUESTS_KEY && pendingRequests) {
      setText(els.contactPageTitle, "新的好友");
      setText(els.contactPageMeta, "");
      els.contactDetail.__miaContactDetailHtmlKey = "";
      els.contactDetail.__miaContactDetailAvatarKey = "";
      window.miaSocial.renderRequestsInto(els.contactDetail);
    } else {
      renderContactDetail(sortedBots.find((bot) => bot.key === state.activeContactKey) || visibleContacts[0] || sortedBots[0]);
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

  function contactListAvatarKey(bot = {}) {
    const avatar = avatarForBot(bot);
    return {
      image: avatar.image || "",
      crop: avatar.crop || null,
      color: avatar.color || "",
      text: avatar.text || ""
    };
  }

  function contactListBotKey(bot = {}) {
    const otherDevice = botRunsOnOtherDevice(bot);
    return {
      key: bot.key || "",
      active: bot.key === state.activeContactKey,
      name: bot.name || bot.displayName || bot.display_name || bot.key || bot.id || "",
      statusBadge: statusBadgeFrom(bot) || null,
      otherDevice,
      deviceLabel: otherDevice ? botDeviceLabel(bot) : "",
      avatar: contactListAvatarKey(bot)
    };
  }

  function contactListRenderKey({ pendingRequests, filter, contactGroups, filterActive }) {
    return JSON.stringify({
      activeContactKey: state.activeContactKey || "",
      filter,
      pendingRequests,
      groups: contactGroups.map((group) => {
        const collapsed = isContactGroupCollapsed(group.key, { forceExpanded: filterActive });
        return {
          key: group.key,
          label: group.label,
          count: group.bots.length,
          collapsed,
          bots: collapsed ? [] : group.bots.map(contactListBotKey)
        };
      })
    });
  }

  function renderContactDetail(bot) {
    if (!state || !els || !els.contactDetail || !bot) return;
    const engine = bot.agentEngine || bot.agent_engine || bot.engine || "hermes";
    const uid = contactUid(bot);
    setBotNameWithBadge(els.contactPageTitle, bot, bot.name || "联系人");
    setText(els.contactPageMeta, botDeviceLabel(bot));
    const canEditBot = bot.canEditIdentity !== false;
    const canDeleteBot = bot.canDelete !== false;
    const avatar = avatarForBot(bot);
    loadRuntimeTargetOptions(bot);
    loadBotCapabilityOptions(bot);
    const avatarKey = JSON.stringify({
      image: avatar.image || "",
      crop: avatar.crop || null,
      color: avatar.color || "",
      text: avatar.text || ""
    });
    const html = `
      <article class="contact-profile">
        <header class="contact-profile-head">
          <button class="contact-profile-avatar" type="button" ${canEditBot ? 'data-contact-action="edit" title="编辑联系人头像"' : 'title="联系人头像"'}></button>
          <div class="contact-profile-title">
            <h2>${renderBotNameWithBadgeHtml(bot, bot.name || "联系人")}</h2>
            <div class="contact-engine-badge" title="Agent 内核">
              ${engineLogoHtml(engine)}
              <span class="contact-engine-copy">
                <small>Agent</small>
                <strong>${window.miaMarkdown.escapeHtml(engineLabel(engine))}</strong>
              </span>
            </div>
            ${uid ? `<p class="contact-profile-uid"><span>UID</span><code>${window.miaMarkdown.escapeHtml(uid)}</code></p>` : ""}
          </div>
          <div class="contact-actions">
            <button class="primary contact-message-action" type="button" data-contact-action="message" title="发消息" aria-label="发消息">${window.miaMarkdown.iconParkIcon("message", "contact-action-icon")}</button>
            ${canEditBot ? `<button class="secondary" type="button" data-contact-action="edit">编辑</button>` : ""}
            ${canDeleteBot ? `<button class="secondary danger" type="button" data-contact-action="delete">删除伙伴</button>` : ""}
          </div>
        </header>
        <section class="contact-info-card">
          ${renderBotRuntimeTargetPanel(bot)}
          ${bot.canConfigureCapabilities !== false ? renderBotCapabilitiesPanel(bot) : ""}
          ${renderBotPersonaPanel(bot)}
          ${renderContactMemoryPanel(bot)}
        </section>
      </article>
    `;
    const htmlChanged = els.contactDetail.__miaContactDetailHtmlKey !== html;
    if (htmlChanged) {
      els.contactDetail.innerHTML = html;
      els.contactDetail.__miaContactDetailHtmlKey = html;
      initNameBadgeLotties(els.contactDetail);
      els.contactDetail.querySelector('[data-contact-action="message"]')?.addEventListener("click", () => openBotChat(bot.key));
      els.contactDetail.querySelectorAll('[data-contact-action="edit"]').forEach((button) => {
        button.addEventListener("click", () => openEditBotDialog(bot.key));
      });
      els.contactDetail.querySelector('[data-contact-action="delete"]')?.addEventListener("click", async () => {
        await deleteBot(bot.key);
      });
      if (bot.canConfigureCapabilities !== false) wireBotCapabilities(bot);
      wireBotPersonaPanel(bot);
      wireContactMemoryPanel(bot);
      wireBotRuntimeTargets(bot);
    }
    if (htmlChanged || els.contactDetail.__miaContactDetailAvatarKey !== avatarKey) {
      window.miaAvatar.applyAvatarMedia(
        els.contactDetail.querySelector(".contact-profile-avatar"),
        avatar.image,
        avatar.crop,
        avatar.color,
        avatar.text
      );
      els.contactDetail.__miaContactDetailAvatarKey = avatarKey;
    }
    refreshRuntimeDevicesForContacts();
  }

  async function saveBotRuntimeTarget(bot, target = {}) {
    if (!bot?.key || !state) return;
    if (!state.savingBotRuntimeTargets) state.savingBotRuntimeTargets = new Set();
    state.savingBotRuntimeTargets.add(bot.key);
    try {
      const result = await window.miaBotCommands.saveBotRuntimeTarget({
        state,
        bot,
        runtimeKind: target.runtimeKind,
        targetDeviceId: target.deviceId,
        targetDeviceName: target.deviceName,
        agentEngine: target.agentEngine,
        api: window.mia,
        social: window.miaSocial,
        engineContracts: window.miaEngineContracts,
        modelSettings: window.miaModelSettings,
        engineOptions: window.miaEngineOptions
      });
      if (result?.runtime) state.runtime = result.runtime;
      runtimeTargetOptionsCache().delete(bot.key);
    } catch (error) {
      window.alert(`保存运行设置失败：${error.message || error}`);
    } finally {
      state.savingBotRuntimeTargets.delete(bot.key);
      renderContacts();
    }
  }

  function wireBotRuntimeTargets(bot) {
    if (!els || !els.contactDetail || !bot) return;
    const panel = els.contactDetail.querySelector(".contact-runtime-target");
    panel?.addEventListener("toggle", () => {
      if (!state.openRuntimeTargetPanelKeys) state.openRuntimeTargetPanelKeys = new Set();
      if (panel.open) state.openRuntimeTargetPanelKeys.add(bot.key);
      else state.openRuntimeTargetPanelKeys.delete(bot.key);
    });
    els.contactDetail.querySelectorAll("[data-runtime-kind]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (button.classList.contains("selected")) return;
        await saveBotRuntimeTarget(bot, {
          runtimeKind: button.dataset.runtimeKind || "desktop-local",
          deviceId: button.dataset.deviceId || "",
          deviceName: button.dataset.deviceName || "",
          agentEngine: button.dataset.runtimeKind === "cloud-claude-code" ? (button.dataset.agentEngine || "") : (button.dataset.agentEngine || "hermes")
        });
      });
    });
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

  async function saveBotCapabilityIntent(bot, intent) {
    if (!bot?.key || !state) return;
    const api = capabilityOptionsApi();
    if (typeof api !== "function") throw new Error("Bot 能力配置接口不可用。");
    ensureCapabilityOptionsState();
    const response = await api(capabilityOptionsRequest(bot, intent));
    const options = normalizeCoreCapabilityOptions(response);
    if (!options.capabilities || typeof options.capabilities !== "object") {
      throw new Error("Bot 能力配置结果无效。");
    }
    state.botCapabilityOptionsCache.set(capabilityOptionsKey(bot), options);
    await saveBotCapabilities(bot, options.capabilities);
  }

  function wireBotCapabilities(bot) {
    if (!els || !els.contactDetail || !bot) return;
    const panel = els.contactDetail.querySelector(".contact-capabilities");
    panel?.addEventListener("toggle", () => {
      if (!state.openCapabilityPanelKeys) state.openCapabilityPanelKeys = new Set();
      if (panel.open) state.openCapabilityPanelKeys.add(bot.key);
      else state.openCapabilityPanelKeys.delete(bot.key);
    });
    els.contactDetail.querySelectorAll("[data-capability-type][data-capability-id]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.dataset.capabilityId || "";
        const type = input.dataset.capabilityType || "";
        try {
          await saveBotCapabilityIntent(bot, {
            capabilityType: type,
            capabilityId: id,
            checked: input.checked
          });
        } catch (error) {
          window.alert(`保存能力设置失败：${error.message || error}`);
          renderContacts();
        }
      });
    });
  }

  function wireBotPersonaPanel(bot) {
    if (!els || !els.contactDetail || !bot) return;
    const panel = els.contactDetail.querySelector(".contact-persona-card");
    panel?.addEventListener("toggle", () => {
      if (!state.openPersonaPanelKeys) state.openPersonaPanelKeys = new Set();
      if (panel.open) state.openPersonaPanelKeys.add(bot.key);
      else state.openPersonaPanelKeys.delete(bot.key);
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
    contactPetLabel,
    openBotChat,
    engineLabel,
    capabilityOptionsRequest,
    normalizeCoreCapabilityOptions,
    loadBotCapabilityOptions,
    botCapabilityOptions,
    botDeviceLabel,
    botRunsOnOtherDevice,
    botPersonaText,
    engineLogoHtml,
    renderCapabilityCheckbox,
    renderBotCapabilitiesPanel,
    renderBotPersonaPanel,
    renderBotRuntimeTargetPanel,
    renderContactMemoryPanel,
    loadContactMemoryEntries,
    refreshContactMemoryForBot,
    renderContacts,
    renderContactDetail,
    saveBotRuntimeTarget,
    wireBotRuntimeTargets,
    saveBotCapabilities,
    saveBotCapabilityIntent,
    wireBotCapabilities,
    wireBotPersonaPanel,
    wireContactMemoryPanel,
    petStatusForKey,
    openBotContextMenu,
    closeBotContextMenu,
    renderBotContextMenu,
  };
})();
