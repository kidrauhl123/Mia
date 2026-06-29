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
  const RUNTIME_DEVICE_REFRESH_INTERVAL_MS = 15000;
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

  function botIdentity() {
    if (typeof window !== "undefined" && window.miaBotIdentity) return window.miaBotIdentity;
    if (typeof require === "function") {
      try { return require("../../shared/bot-identity.js"); } catch { /* fallback below */ }
    }
    return null;
  }

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
      cloudBots: socialBots,
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
    const identity = botIdentity();
    if (typeof identity?.botCapabilitiesWithPresetDefaults === "function") {
      return identity.botCapabilitiesWithPresetDefaults(bot, state?.skillLibrary?.botPresets || []);
    }
    const normalizer = identity?.normalizeBotCapabilities;
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
    return window.miaEngineContracts?.engineLabel?.(engine) || "Hermes";
  }

  function engineLogoKind(engine = "") {
    const normalized = window.miaEngineContracts?.normalizeAgentEngine?.(engine) || engine;
    if (normalized === "claude-code") return "claude";
    if (normalized === "codex") return "codex";
    if (normalized === "openclaw") return "openclaw";
    return "hermes";
  }

  function engineLogoHtml(engine = "") {
    const kind = engineLogoKind(engine);
    const iconSrc = {
      hermes: "./assets/engine-icons/hermesagent.svg",
      claude: "./assets/engine-icons/claudecode.svg",
      codex: "./assets/engine-icons/codex-color.svg",
      openclaw: "./assets/provider-icons/openclaw-color.svg"
    }[kind];
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
    return window.miaBotDirectory.runtimeLabelFor(bot, state?.runtime || {});
  }

  function contactUid(bot = {}) {
    return firstNonEmpty(bot.uid, bot.publicId, bot.public_id, bot.id, bot.key, bot.globalId, bot.global_id);
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

  function capabilityTitle(item = {}, type = "") {
    if (type === "skill") {
      const skill = {
        ...item,
        name: item.name || String(item.id || "").replace(/^mia-official:/, ""),
        source: item.source || (String(item.id || "").startsWith("mia-official:") ? "mia-official" : "")
      };
      const title = window.miaSkillHelpers?.skillDisplayName?.(skill);
      if (title) return title;
      return item.marketNameZh || item.name_zh || item.title || item.name || item.label || item.id;
    }
    return item.label || item.name || item.id;
  }

  function renderCapabilityCheckbox({ item, checked, type }) {
    const title = capabilityTitle(item, type);
    return `
      <label class="capability-row">
        <input type="checkbox" data-capability-type="${window.miaMarkdown.escapeHtml(type)}" data-capability-id="${window.miaMarkdown.escapeHtml(item.id)}" ${checked ? "checked" : ""}>
        <span class="capability-copy">
          <strong>${window.miaMarkdown.escapeHtml(title)}</strong>
        </span>
        <span class="capability-check" aria-hidden="true"></span>
      </label>
    `;
  }

  function renderBotCapabilitiesPanel(bot) {
    const capabilities = botCapabilities(bot);
    const { skills } = botCapabilityItems(bot);
    const panelOpen = state?.openCapabilityPanelKeys?.has?.(bot?.key);
    return `
      <details class="contact-capabilities accordion-details" data-capabilities-panel-key="${window.miaMarkdown.escapeHtml(bot?.key || "")}"${panelOpen ? " open" : ""}>
        <summary>
          <div>
            <strong>能力</strong>
            <p>${skills.length} 技能</p>
          </div>
          <span class="runtime-target-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="accordion-body">
          <div class="capability-list">
            ${skills.length ? skills.map((item) => renderCapabilityCheckbox({
              item,
              checked: capabilityChecked(capabilities, item.id, "enabledSkills", "disabledSkills"),
              type: "skill"
            })).join("") : `<div class="capability-empty">当前引擎没有可选技能</div>`}
          </div>
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

  function normalizeDevice(input = {}) {
    const id = String(input.id || input.deviceId || "").trim();
    if (!id) return null;
    return {
      ...input,
      id,
      deviceName: firstNonEmpty(input.deviceName, input.device_name, input.name, id),
      status: String(input.status || "").trim(),
      isLocal: Boolean(input.isLocal),
      capabilities: input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {}
    };
  }

  function isSameLocalDevice(device, local) {
    return Boolean(device && local && device.id === local.id);
  }

  function mergeEngineLists(left = {}, right = {}) {
    const out = [];
    for (const source of [left, right]) {
      const engines = Array.isArray(source.capabilities?.engines) ? source.capabilities.engines : [];
      for (const engine of engines) {
        const id = String(engine || "").trim();
        if (id && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  function mergeDevices(existing, incoming) {
    if (!existing) return incoming;
    const engines = mergeEngineLists(existing, incoming);
    const isLocal = Boolean(existing.isLocal || incoming.isLocal);
    const status = isLocal
      ? "local"
      : ([existing.status, incoming.status].includes("online") ? "online" : (incoming.status || existing.status || ""));
    return {
      ...existing,
      ...incoming,
      id: existing.id || incoming.id,
      deviceName: incoming.deviceName || existing.deviceName,
      status,
      isLocal,
      capabilities: {
        ...(existing.capabilities || {}),
        ...(incoming.capabilities || {}),
        ...(engines.length ? { engines } : {})
      }
    };
  }

  function localDeviceCandidate() {
    const runtime = state?.runtime || {};
    const id = firstNonEmpty(runtime.localDevice?.id, runtime.cloud?.deviceId, "current-device");
    const engines = [];
    if (runtime.agentEngines?.hermes?.available || runtime.agentEngines?.hermes?.installed || runtime.engineInstalled || runtime.engineRunning) engines.push("hermes");
    if (runtime.agentEngines?.claudeCode?.available) engines.push("claude-code");
    if (runtime.agentEngines?.codex?.available) engines.push("codex");
    if (runtime.agentEngines?.openClaw?.available || runtime.agentEngines?.openClaw?.installed) engines.push("openclaw");
    if (!engines.length) engines.push(window.miaBotDirectory.normalizeAgentEngine(state?.preferredAgentEngine || "hermes", "desktop-local"));
    return normalizeDevice({
      id,
      deviceName: firstNonEmpty(runtime.localDevice?.name, runtime.cloud?.deviceName, "当前设备"),
      status: "local",
      isLocal: true,
      capabilities: { engines }
    });
  }

  function runtimeDevices() {
    const byId = new Map();
    const add = (device) => {
      const normalized = normalizeDevice(device);
      if (!normalized) return;
      byId.set(normalized.id, mergeDevices(byId.get(normalized.id), normalized));
    };
    for (const device of state?.runtime?.cloud?.devices || state?.runtime?.cloud?.bridgeDevices || []) add(device);
    add(localDeviceCandidate());
    return [...byId.values()];
  }

  function editableRuntimeDevices() {
    const local = localDeviceCandidate();
    return local ? [local] : [];
  }

  function deviceStatusLabel(device = {}) {
    if (device.isLocal || device.status === "local") return "本机";
    if (device.status === "online") return "在线";
    return "离线";
  }

  function compactDeviceName(value = "") {
    return String(value || "")
      .trim()
      .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)(?=\s*(?:·|-|$))/gi, "")
      .replace(/\.local(?=\s|$)/gi, "")
      .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function runtimeDeviceDisplayName(device = {}) {
    if (device.isLocal || device.status === "local") return "本机";
    return compactDeviceName(device.deviceName || device.device_name || device.name || "") || String(device.id || "").trim() || "设备";
  }

  function deviceEngines(device = {}) {
    const advertised = Array.isArray(device.capabilities?.engines)
      ? device.capabilities.engines.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (advertised.length) return advertised.filter((id) => ["hermes", "claude-code", "codex", "openclaw"].includes(id));
    const engine = String(device.engine || "").trim();
    return ["hermes", "claude-code", "codex", "openclaw"].includes(engine) ? [engine] : [];
  }

  function activeRuntimeTarget(bot = {}) {
    const kind = window.miaBotDirectory.normalizeRuntimeKind(bot.runtimeKind || bot.runtime_kind, "desktop-local");
    if (kind === "cloud-hermes") return { runtimeKind: "cloud-hermes", deviceId: "", agentEngine: "hermes" };
    return {
      runtimeKind: "desktop-local",
      deviceId: firstNonEmpty(bot.targetDeviceId, bot.target_device_id, bot.deviceId, bot.device_id, bot.runtimeConfig?.deviceId, state?.runtime?.localDevice?.id, state?.runtime?.cloud?.deviceId, "current-device"),
      agentEngine: window.miaBotDirectory.normalizeAgentEngine(bot.agentEngine || bot.agent_engine || bot.runtimeConfig?.agentEngine || "hermes", "desktop-local")
    };
  }

  function botRunsOnOtherDevice(bot = {}) {
    const target = activeRuntimeTarget(bot);
    if (target.runtimeKind !== "desktop-local") return false;
    const local = localDeviceCandidate();
    const targetDeviceId = firstNonEmpty(
      target.deviceId,
      bot.targetDeviceId,
      bot.target_device_id,
      bot.deviceId,
      bot.device_id,
      bot.runtimeConfig?.deviceId
    );
    if (!local || !targetDeviceId) return false;
    const targetDevice = normalizeDevice({
      id: targetDeviceId,
      deviceName: firstNonEmpty(
        bot.targetDeviceName,
        bot.target_device_name,
        bot.deviceName,
        bot.device_name,
        bot.runtimeConfig?.deviceName
      )
    });
    return Boolean(targetDevice && !isSameLocalDevice(targetDevice, local));
  }

  function targetButtonHtml({ bot, runtimeKind, device = null, engine = "hermes" }) {
    const active = activeRuntimeTarget(bot);
    const selected = runtimeKind === "cloud-hermes"
      ? active.runtimeKind === "cloud-hermes"
      : active.runtimeKind === "desktop-local" && device?.id === active.deviceId && active.agentEngine === engine;
    const displayName = runtimeKind === "cloud-hermes" ? "Mia Cloud" : runtimeDeviceDisplayName(device);
    const attrs = runtimeKind === "cloud-hermes"
      ? 'data-runtime-kind="cloud-hermes"'
      : `data-runtime-kind="desktop-local" data-device-id="${window.miaMarkdown.escapeHtml(device?.id || "")}" data-device-name="${window.miaMarkdown.escapeHtml(displayName)}" data-agent-engine="${window.miaMarkdown.escapeHtml(engine)}"`;
    const title = runtimeKind === "cloud-hermes" ? "Mia Cloud · Hermes" : `${displayName} · ${engineLabel(engine)}`;
    const saving = state?.savingBotRuntimeTargets?.has?.(bot?.key);
    return `
      <button type="button" class="runtime-target-option${selected ? " selected" : ""}${saving ? " saving" : ""}" ${attrs} title="${window.miaMarkdown.escapeHtml(title)}" ${saving ? "disabled" : ""}>
        ${engineLogoHtml(runtimeKind === "cloud-hermes" ? "hermes" : engine)}
        <span>
          <strong>${window.miaMarkdown.escapeHtml(engineLabel(runtimeKind === "cloud-hermes" ? "hermes" : engine))}</strong>
        </span>
      </button>
    `;
  }

  function renderBotRuntimeTargetPanel(bot) {
    const devices = editableRuntimeDevices();
    const cloudEnabled = Boolean(state?.runtime?.cloud?.enabled);
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
            ${cloudEnabled ? `
              <section class="runtime-device-group">
                <div>
                  <strong>Mia Cloud</strong>
                  <small>在线</small>
                </div>
                <div>
                  ${targetButtonHtml({ bot, runtimeKind: "cloud-hermes" })}
                </div>
              </section>
            ` : ""}
            ${devices.map((device) => {
              const engines = deviceEngines(device);
              return `
              <section class="runtime-device-group">
                <div>
                  <strong>${window.miaMarkdown.escapeHtml(runtimeDeviceDisplayName(device))}</strong>
                  <small>${window.miaMarkdown.escapeHtml(deviceStatusLabel(device))}</small>
                </div>
                <div>
                  ${engines.length
                    ? engines.map((engine) => targetButtonHtml({ bot, runtimeKind: "desktop-local", device, engine })).join("")
                    : '<p class="runtime-target-empty">没有可用 Agent</p>'}
                </div>
              </section>
            `; }).join("")}
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

  function renderContactDetail(bot) {
    if (!state || !els || !els.contactDetail || !bot) return;
    const engine = bot.agentEngine || bot.agent_engine || bot.engine || "hermes";
    const uid = contactUid(bot);
    setBotNameWithBadge(els.contactPageTitle, bot, bot.name || "联系人");
    setText(els.contactPageMeta, botDeviceLabel(bot));
    const canEditBot = bot.canEditIdentity !== false;
    const canDeleteBot = bot.canDelete !== false;
    const avatar = avatarForBot(bot);
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
          agentEngine: button.dataset.agentEngine || "hermes"
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
        let capabilities = botCapabilities(bot);
        if (type === "skill") {
          capabilities = toggleCapabilityId(capabilities, id, "enabledSkills", "disabledSkills", input.checked);
        }
        await saveBotCapabilities(bot, capabilities);
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
    defaultBotCapabilities,
    normalizeCapabilityIds,
    botCapabilities,
    capabilityForEngine,
    engineLabel,
    botCapabilityItems,
    capabilityChecked,
    botDeviceLabel,
    botRunsOnOtherDevice,
    botPersonaText,
    engineLogoHtml,
    renderCapabilityCheckbox,
    renderBotCapabilitiesPanel,
    renderBotPersonaPanel,
    renderBotRuntimeTargetPanel,
    renderContacts,
    renderContactDetail,
    saveBotRuntimeTarget,
    wireBotRuntimeTargets,
    saveBotCapabilities,
    toggleCapabilityId,
    wireBotCapabilities,
    wireBotPersonaPanel,
    petStatusForKey,
    openBotContextMenu,
    closeBotContextMenu,
    renderBotContextMenu,
  };
})();
