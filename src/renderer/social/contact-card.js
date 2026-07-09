// Click-on-avatar contact card for cloud conversations.
//
// Two interactions on a group-message avatar:
//   - Left click → open this card. AI cards show current 模型 / effort /
//     权限 from Core runtime-control options and open the full bot-dialog
//     for editing. Human cards show username + 私聊 button.
//   - Right click → small action menu (e.g. @提到, 私聊).
//
// The card is a floating popover anchored to the clicked avatar; clicking
// outside closes it.

(function (global) {
  "use strict";

  const { MemberKind } = (typeof window !== "undefined" && window.miaConversationKinds)
    || require("../../shared/conversation-kinds");

  let _ctx = null;
  let _popover = null;
  let _onOutside = null;
  let _onEsc = null;
  const botRuntimeBindingCache = new Map();
  const botRuntimeControlOptionsCache = new Map();
  const botRuntimeControlOptionsInFlight = new Set();

  function attach(internalCtx) { _ctx = internalCtx; }

  function escapeHtml(value) {
    return global.miaMarkdown?.escapeHtml?.(value)
      ?? String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]));
  }

  function statusBadgeFrom(...sources) {
    for (const source of sources) {
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
    }
    return undefined;
  }

  function renderNameWithBadgeHtml({ identity, fallbackName, statusBadge } = {}) {
    const renderer = global.miaNameWithBadge;
    if (renderer && typeof renderer.renderNameWithBadgeHtml === "function") {
      try {
        return renderer.renderNameWithBadgeHtml({ identity, fallbackName, statusBadge });
      } catch {
        // Optional badge payloads must not break contact cards.
      }
    }
    return escapeHtml(fallbackName || identity?.displayName || "");
  }

  function initNameBadgeLotties(root) {
    try { global.miaNameWithBadge?.initLottieBadges?.(root); } catch { /* optional badge animation */ }
  }

  function closeCard() {
    if (_popover) { _popover.remove(); _popover = null; }
    if (_onOutside) { document.removeEventListener("click", _onOutside, true); _onOutside = null; }
    if (_onEsc) { document.removeEventListener("keydown", _onEsc); _onEsc = null; }
  }

  function position(node, anchorRect) {
    const rect = node.getBoundingClientRect();
    const margin = 8;
    let x = anchorRect.right + margin;
    if (x + rect.width > window.innerWidth) x = anchorRect.left - rect.width - margin;
    if (x < margin) x = margin;
    let y = anchorRect.top;
    if (y + rect.height > window.innerHeight - margin) y = Math.max(margin, window.innerHeight - rect.height - margin);
    node.style.position = "fixed";
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.zIndex = "1000";
  }

  function paintContactCardAvatar(card, avatar) {
    const avatarEl = card?.querySelector?.(".contact-card-avatar");
    if (!avatarEl) return;
    global.miaAvatar.paintAvatar(avatarEl, avatar || {});
  }

  function resolveCardAvatar(input = {}) {
    if (global.miaAvatarResolve?.resolveAvatarForContact) {
      return global.miaAvatarResolve.resolveAvatarForContact(input);
    }
    const text = String(input.displayName || input.id || "?").trim().slice(0, 2) || "?";
    return {
      image: input.avatarImage || "",
      crop: input.avatarCrop || null,
      color: global.miaMemberColor?.memberAccentColor?.(input.id || "") || "#5e5ce6",
      text
    };
  }

  function contact() {
    return global.miaContact || null;
  }

  function sessionHistory() {
    return global.miaSessionHistory || null;
  }

  function botAvatarIdentityId(ref, bot = {}, member = null, conversationId = "") {
    void conversationId;
    const identity = member?.identity || {};
    return contact()?.botAvatarIdentityId?.(ref, {
      ...(bot || {}),
      id: bot?.id || bot?.key || identity.id || ref,
      member_ref: ref,
    }) || identity.id || bot?.id || bot?.key || ref;
  }

  function localBot(ref) {
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    const cloudBots = Array.isArray(_ctx?.moduleState?.bots) ? _ctx.moduleState.bots : [];
    const bots = _ctx?.adapterCtx?.()?.bots
      || (global.miaBotDirectory
        ? global.miaBotDirectory.listOwnedBots({ cloudBots: cloudBots, runtime })
        : cloudBots);
    const target = String(ref || "");
    return bots.find((f) => String(f.key || "") === target || String(f.id || "") === target) || null;
  }

  function findBotConversationMember(conversationId, ref) {
    const members = _ctx?.conversationMembersCache?.get?.(conversationId) || [];
    return members.find((m) => m.member_kind === MemberKind.Bot && m.member_ref === ref) || null;
  }

  function friend(ref) {
    const friends = _ctx?.moduleState?.friends || [];
    return friends.find((f) => f.id === ref) || null;
  }

  function selfUser() {
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    if (global.miaSelfIdentity) {
      return global.miaSelfIdentity.resolveSelfIdentity({
        cloudUser: runtime.cloud?.user || {},
        localUser: runtime.user || {},
        myUserId: _ctx?.moduleState?.myUserId,
        myUsername: _ctx?.moduleState?.myUsername
      });
    }
    const local = runtime.user || {};
    const cloud = runtime.cloud?.user || {};
    return {
      ...local,
      ...cloud,
      id: _ctx?.moduleState?.myUserId || cloud.id || local.id || ""
    };
  }

  function runtimeCacheKey(botKey, runtimeKind) {
    return global.miaBotCommands?.runtimeCacheKey?.(botKey, runtimeKind)
      || `${botKey}:${runtimeKind || "cloud-claude-code"}`;
  }

  function bindingForBot(botKey, runtimeKind) {
    return botRuntimeBindingCache.get(runtimeCacheKey(botKey, runtimeKind)) || null;
  }

  function controlOptionsForBot(botKey, runtimeKind) {
    return botRuntimeControlOptionsCache.get(runtimeCacheKey(botKey, runtimeKind)) || null;
  }

  function runtimeControlArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function runtimeControlStateSnapshot(appState = {}) {
    return {
      modelCatalog: global.miaModelHelpers?.catalogEntries?.() || [],
      platformModels: Array.isArray(appState.platformModels) ? appState.platformModels : [],
      engineCapabilities: appState.engineCapabilities || {},
      codexModels: appState.codexModels || []
    };
  }

  function runtimeControlOptionsRequest(bot, runtimeKind) {
    const appState = _ctx?.deps?.getState?.() || {};
    const runtime = appState.runtime || {};
    const botKey = String(bot?.key || bot?.id || "").trim();
    return {
      runtimeKind,
      bot,
      runtime,
      binding: bindingForBot(botKey, runtimeKind) || {},
      ...runtimeControlStateSnapshot(appState)
    };
  }

  function runtimeControlPayload(result) {
    return result?.data && typeof result.data === "object" ? result.data : result;
  }

  function runtimeOptionValue(entry = {}) {
    return String(entry.id || entry.value || entry.model || "").trim();
  }

  function options(entries, selectedValue, fallbackLabel = "加载中", allowEmpty = false) {
    const normalized = runtimeControlArray(entries);
    if (!normalized.length) return `<option value="">${escapeHtml(fallbackLabel)}</option>`;
    const rows = allowEmpty ? [{ id: "", value: "", label: fallbackLabel }] : [];
    rows.push(...normalized);
    return rows.map((entry) => {
      const value = runtimeOptionValue(entry);
      const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(String) : [];
      const selected = value === selectedValue || aliases.includes(selectedValue) ? " selected" : "";
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(entry.label || value)}</option>`;
    }).join("");
  }

  function modelLogoSrcForOption(entry = {}, engine = "hermes", runtime = {}) {
    const helper = global.miaModelHelpers;
    if (!helper?.modelIconSrc) return "";
    if (entry && (entry.provider || entry.model || entry.id || entry.value)) {
      return helper.modelIconSrc({
        provider: entry.provider || entry.providerConnectionId || entry.provider_connection_id || (engine === "codex" ? "openai-codex" : engine === "claude-code" ? "anthropic" : engine),
        model: entry.model || entry.id || entry.value || ""
      }) || "";
    }
    return helper.modelIconSrc(runtime.model || {}) || "";
  }

  function runtimeControlsHtml(optionsPayload, runtimeKind, runtime = {}) {
    const ready = Boolean(optionsPayload);
    const engine = String(optionsPayload?.agentEngine || "hermes").trim() || "hermes";
    const modelEntries = runtimeControlArray(optionsPayload?.modelOptions);
    const effortEntries = runtimeControlArray(optionsPayload?.effortOptions);
    const permissionEntries = runtimeControlArray(optionsPayload?.permissionOptions);
    const selectedModel = String(optionsPayload?.selectedModel || "").trim();
    const selectedModelEntry = selectedModel
      ? (optionsPayload?.selectedModelEntry
        || modelEntries.find((entry) => runtimeOptionValue(entry) === selectedModel)
        || {})
      : {};
    const modelLabel = selectedModelEntry?.label || (ready ? "模型" : "加载中");
    const selectedEffort = String(optionsPayload?.selectedEffort || "medium").trim();
    const effortLabel = effortEntries.find((entry) => runtimeOptionValue(entry) === selectedEffort)?.label || (ready ? "Medium" : "加载中");
    const selectedPermission = String(optionsPayload?.selectedPermission || (runtimeKind === "cloud-claude-code" ? "bypassPermissions" : "default")).trim();
    const permissionLabel = permissionEntries.find((entry) => runtimeOptionValue(entry) === selectedPermission)?.label || (ready ? "Ask" : "加载中");
    const hasModelEntries = modelEntries.length > 0;
    const hasSelectedModelEntry = Boolean(selectedModelEntry?.id || selectedModelEntry?.value || selectedModelEntry?.model || selectedModelEntry?.provider);
    const modelLogoSrc = hasSelectedModelEntry ? modelLogoSrcForOption(selectedModelEntry, engine, runtime) : "";
    const modelLogoStyle = modelLogoSrc
      ? `background-image:url('${escapeHtml(modelLogoSrc)}');background-color:transparent;`
      : "";
    const modelDisabled = ready && hasModelEntries ? "" : " disabled";
    const disabled = ready ? "" : " disabled";
    return `
        <div class="contact-card-row">
          <dt>模型</dt>
          <dd>
            <label class="model-switcher${hasSelectedModelEntry ? "" : " model-switcher--no-avatar"}" title="切换模型">
              <span class="model-avatar${hasSelectedModelEntry ? "" : " hidden"}" style="${modelLogoStyle}" aria-hidden="true">${modelLogoSrc ? "" : "◇"}</span>
              <span class="model-current-label">${escapeHtml(modelLabel)}</span>
              <select data-bot-field="model" aria-label="切换模型"${modelDisabled}>${options(modelEntries, selectedModel, "模型", true)}</select>
            </label>
          </dd>
        </div>
        <div class="contact-card-row">
          <dt>推理强度</dt>
          <dd>
            <label class="effort-switcher" title="切换推理强度">
              <span class="effort-label">${escapeHtml(effortLabel)}</span>
              <select data-bot-field="effortLevel" aria-label="切换推理强度"${disabled}>${options(effortEntries, selectedEffort)}</select>
            </label>
          </dd>
        </div>
        <div class="contact-card-row">
          <dt>权限</dt>
          <dd>
            <label class="permission-switcher" title="权限模式">
              <span class="permission-label">${escapeHtml(permissionLabel)}</span>
              <select data-bot-field="permissionMode" aria-label="权限模式"${disabled}>${options(permissionEntries, selectedPermission)}</select>
            </label>
          </dd>
        </div>
    `;
  }

  function applyRuntimeControlOptionsToCard(card, payload) {
    const controls = card?.querySelector?.(".contact-card-controls");
    if (!controls || !payload) return;
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    controls.innerHTML = runtimeControlsHtml(payload, payload.runtimeKind || "desktop-local", runtime);
  }

  function loadRuntimeControlOptions(card, bot, runtimeKind, options = {}) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    const cacheKey = runtimeCacheKey(botKey, runtimeKind);
    const api = global.mia?.social?.getBotRuntimeControlOptions;
    if (!botKey || typeof api !== "function") return;
    if (botRuntimeControlOptionsInFlight.has(cacheKey) && !options.force) return;
    botRuntimeControlOptionsInFlight.add(cacheKey);
    api(runtimeControlOptionsRequest(bot, runtimeKind))
      .then((result) => {
        if (result && result.ok === false) throw new Error(result.error || result.message || "Runtime control options failed");
        const payload = runtimeControlPayload(result);
        if (!payload || typeof payload !== "object") return;
        botRuntimeControlOptionsCache.set(cacheKey, { ...payload, runtimeKind });
        if (_popover === card) applyRuntimeControlOptionsToCard(card, { ...payload, runtimeKind });
      })
      .catch((error) => {
        console.warn?.("[contact-card] bot runtime control options failed:", error?.message || error);
      })
      .finally(() => {
        botRuntimeControlOptionsInFlight.delete(cacheKey);
      });
  }

  function hydrateBotRuntimeBinding(card, bot, runtimeKind) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    if (!botKey || runtimeKind !== "cloud-claude-code") return;
    if (typeof global.miaBotCommands?.getBotRuntimeBinding !== "function") return;
    global.miaBotCommands.getBotRuntimeBinding({
      api: global.mia,
      cache: botRuntimeBindingCache,
      botKey,
      runtimeKind
    }).then((binding) => {
      if (!binding) return;
      botRuntimeBindingCache.set(runtimeCacheKey(botKey, runtimeKind), binding);
      botRuntimeControlOptionsCache.delete(runtimeCacheKey(botKey, runtimeKind));
      if (_popover === card) loadRuntimeControlOptions(card, bot, runtimeKind, { force: true });
    }).catch((error) => {
      console.warn?.("[contact-card] bot runtime binding load failed:", error?.message || error);
    });
  }

  // Bot card with live Core-backed selectors (model / effort / permission)
  // that mirror the topbar composer controls in private chat.
  function renderBotCard(args) {
    const { ref, conversationId } = args;
    const member = findBotConversationMember(conversationId, ref);
    const ownerId = member?.owner_id || "";
    const me = selfUser();
    // In a shared conversation, trust the member row's owner_id. Only when
    // there's NO conversation member (private bot chat) does an owned cloud bot
    // identity count as ours — there's no owner_id to read there.
    const isMine = member ? (ownerId === me.id) : Boolean(localBot(ref));
    // Bind the owned bot identity ONLY when it's actually ours. A same-key bot
    // owned by another conversation member must fall through to the remote-only card —
    // otherwise its name/avatar/controls would mirror, and edits would persist
    // to my own bot identity.
    const local = isMine ? localBot(ref) : null;

    const name = local?.name || member?.identity?.displayName || member?.bot_name || ref;
    const identityAvatar = member?.identity?.avatar || {};
    const avatarId = botAvatarIdentityId(ref, local || {}, member || null, conversationId);
    const avatar = resolveCardAvatar({
      id: avatarId,
      displayName: name,
      avatarImage: local ? (local.avatarImage || local.avatar_image) : (identityAvatar.image || member?.bot_avatar_image || ""),
      avatarCrop: local ? (local.avatarCrop || local.avatar_crop) : (identityAvatar.crop || member?.bot_avatar_crop || null),
      color: local
        ? (local.color || local.avatarColor || local.avatar_color || "")
        : (identityAvatar.color || member?.bot_color || member?.avatarColor || member?.avatar_color || "")
    });

    const card = document.createElement("div");
    card.className = "contact-card";
    card.setAttribute("role", "dialog");

    if (!local) {
      card.innerHTML = `
        <div class="contact-card-head">
          <span class="avatar contact-card-avatar"></span>
          <div class="contact-card-head-text">
            <strong class="contact-card-name">${renderNameWithBadgeHtml({
              identity: member?.identity || { kind: "bot", id: ref, displayName: name },
              fallbackName: name,
              statusBadge: statusBadgeFrom(member?.identity, member)
            })}</strong>
            <span class="contact-card-kind">远端</span>
          </div>
        </div>
        <p class="contact-card-empty">这位 Bot 不属于你，只能看到名字。</p>
        <div class="contact-card-actions">
          <button type="button" data-card-action="close" class="button-primary">关闭</button>
        </div>
      `;
      paintContactCardAvatar(card, avatar);
      initNameBadgeLotties(card);
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-card-action]")) closeCard();
      });
      return card;
    }

    const appState = _ctx?.deps?.getState?.() || {};
    const runtime = appState.runtime || {};
    const runtimeKind = local.runtimeKind || "desktop-local";
    const isCloudRuntime = runtimeKind === "cloud-claude-code";
    const botKey = String(local.key || local.id || ref || "").trim();
    const controlOptions = controlOptionsForBot(botKey, runtimeKind);
    const controlsHtml = runtimeControlsHtml(controlOptions, runtimeKind, runtime);
    const runtimeLabel = local.runtimeLabel || controlOptions?.statusText || (isCloudRuntime ? "Mia Cloud" : (controlOptions?.agentEngine || local.agentEngine || local.agent_engine || "hermes"));

    card.innerHTML = `
        <div class="contact-card-head">
          <span class="avatar contact-card-avatar"></span>
          <div class="contact-card-head-text">
          <strong class="contact-card-name">${renderNameWithBadgeHtml({
            identity: { kind: "bot", id: local.id || local.key || ref, displayName: name, statusBadge: statusBadgeFrom(local) },
            fallbackName: name,
            statusBadge: statusBadgeFrom(local)
          })}</strong>
          <span class="contact-card-kind">${escapeHtml(runtimeLabel)}</span>
        </div>
      </div>
      <dl class="contact-card-controls">${controlsHtml}</dl>
      <div class="contact-card-actions">
        ${isMine ? `<button type="button" data-card-action="edit-bot" class="button-soft">编辑人设</button>` : ""}
        <button type="button" data-card-action="close" class="button-primary">关闭</button>
      </div>
    `;
    paintContactCardAvatar(card, avatar);
    initNameBadgeLotties(card);

    async function persistField(field, value) {
      const latestOptions = controlOptionsForBot(botKey, runtimeKind) || {};
      try {
        await global.miaBotCommands?.saveBotRuntimeControl?.({
          api: global.mia,
          bot: local,
          runtimeKind,
          field,
          value,
          modelEntries: runtimeControlArray(latestOptions.modelOptions)
        });
        botRuntimeControlOptionsCache.delete(runtimeCacheKey(botKey, runtimeKind));
        loadRuntimeControlOptions(card, local, runtimeKind, { force: true });
      } catch (err) {
        alert("保存失败：" + (err?.message || err));
      }
    }

    card.addEventListener("change", (event) => {
      const sel = event.target.closest("[data-bot-field]");
      if (!sel) return;
      const newLabel = sel.options[sel.selectedIndex]?.textContent || "";
      const labelSpan = sel.parentElement?.querySelector(".model-current-label, .effort-label, .permission-label");
      if (labelSpan) labelSpan.textContent = newLabel;
      persistField(sel.dataset.botField, sel.value);
    });
    loadRuntimeControlOptions(card, local, runtimeKind);
    if (isCloudRuntime) hydrateBotRuntimeBinding(card, local, runtimeKind);
    card.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-card-action]");
      if (!btn) return;
      event.stopPropagation();
      if (btn.dataset.cardAction === "edit-bot") {
        closeCard();
        global.miaBotDialog?.openBotDialog?.(local, local.personaText || "");
      } else {
        closeCard();
      }
    });
    return card;
  }

  function renderUserCard(args) {
    const { ref } = args;
    const me = selfUser();
    const isSelf = ref === me.id;
    const f = isSelf ? me : friend(ref);
    // Self uses the canonical resolved display name so the card matches the
    // chat bubbles and rail; friends still show their username/account.
    const name = isSelf
      ? (me.displayName || me.username || ref)
      : (f?.username || f?.account || ref);
    const avatar = resolveCardAvatar({
      id: ref,
      displayName: name,
      avatarImage: f?.avatarImage || "",
      avatarCrop: f?.avatarCrop || null,
      color: f?.avatarColor || f?.avatar_color || f?.color || ""
    });
    const card = document.createElement("div");
    card.className = "contact-card";
    card.setAttribute("role", "dialog");
    card.innerHTML = `
      <div class="contact-card-head">
        <span class="avatar contact-card-avatar"></span>
        <div class="contact-card-head-text">
          <strong class="contact-card-name">${renderNameWithBadgeHtml({
            identity: { kind: "user", id: ref, displayName: name, statusBadge: statusBadgeFrom(f) },
            fallbackName: name,
            statusBadge: statusBadgeFrom(f)
          })}</strong>
          <span class="contact-card-kind">${isSelf ? "我" : "联系人"}</span>
        </div>
      </div>
      <div class="contact-card-actions">
        <button type="button" data-card-action="close" class="button-primary">关闭</button>
      </div>
    `;
    paintContactCardAvatar(card, avatar);
    initNameBadgeLotties(card);
    card.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-card-action]");
      if (!btn) return;
      event.stopPropagation();
      closeCard();
    });
    return card;
  }

  function openCard({ kind, ref, conversationId, anchor }) {
    closeCard();
    const card = kind === MemberKind.Bot
      ? renderBotCard({ ref, conversationId })
      : renderUserCard({ ref, conversationId });
    document.body.appendChild(card);
    _popover = card;
    const anchorRect = anchor?.getBoundingClientRect?.() || { right: window.innerWidth / 2, top: window.innerHeight / 2, left: 0 };
    position(card, anchorRect);
    setTimeout(() => {
      _onOutside = (event) => { if (!card.contains(event.target)) closeCard(); };
      _onEsc = (event) => { if (event.key === "Escape") closeCard(); };
      document.addEventListener("click", _onOutside, true);
      document.addEventListener("keydown", _onEsc);
    }, 0);
  }

  function openContextMenu({ kind, ref, conversationId, anchor, x, y }) {
    closeCard();
    const menu = document.createElement("div");
    menu.className = "skill-context-menu";
    const items = [];
    items.push(`<button type="button" data-card-menu="card">查看名片</button>`);
    if (kind === MemberKind.Bot) {
      items.push(`<button type="button" data-card-menu="mention">在输入框 @ 提到</button>`);
    }
    menu.innerHTML = items.join("");
    document.body.appendChild(menu);
    _popover = menu;
    menu.style.position = "fixed";
    menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 96)}px`;
    menu.style.zIndex = "1000";
    menu.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-card-menu]");
      if (!btn) return;
      event.stopPropagation();
      closeCard();
      if (btn.dataset.cardMenu === "card") openCard({ kind, ref, conversationId, anchor });
      else if (btn.dataset.cardMenu === "mention") insertMentionInComposer(ref);
    });
    setTimeout(() => {
      _onOutside = (event) => { if (!menu.contains(event.target)) closeCard(); };
      _onEsc = (event) => { if (event.key === "Escape") closeCard(); };
      document.addEventListener("click", _onOutside, true);
      document.addEventListener("keydown", _onEsc);
    }, 0);
  }

  function insertMentionInComposer(ref) {
    const input = document.getElementById("chatInput");
    if (!input) return;
    const token = `@${ref} `;
    input.value = (input.value || "") + token;
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  global.miaContactCard = {
    attach,
    openCard,
    openContextMenu,
    closeCard,
  };

  if (global.miaSocial && global.miaSocial._internalCtx) {
    attach(global.miaSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);
