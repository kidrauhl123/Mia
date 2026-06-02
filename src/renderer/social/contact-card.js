// Click-on-avatar contact card for cloud conversations.
//
// Two interactions on a group-message avatar:
//   - Left click → open this card. AI cards show current 模型 / effort /
//     权限 (pulled from the local fellow registry; opens the full
//     fellow-dialog for editing). Human cards show username + 私聊 button.
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
  const fellowRuntimeBindingCache = new Map();

  function attach(internalCtx) { _ctx = internalCtx; }

  function escapeHtml(value) {
    return global.miaMarkdown?.escapeHtml?.(value)
      ?? String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]));
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

  function fellowGlobalIdFromConversation(conversationId, ref) {
    const id = String(conversationId || "");
    const key = String(ref || "");
    if (!id.startsWith("fellow:") || !key) return "";
    const helper = sessionHistory();
    const fellowKey = helper?.fellowKey?.({ id }) || "";
    return fellowKey === key ? id : "";
  }

  function fellowAvatarIdentityId(ref, fellow = {}, member = null, conversationId = "") {
    const identity = member?.identity || {};
    const me = selfUser();
    const ownerUserId = fellow?.ownerUserId
      || fellow?.owner_user_id
      || fellow?.ownerId
      || fellow?.owner_id
      || member?.owner_user_id
      || member?.owner_id
      || identity.ownerUserId
      || identity.owner_id
      || (fellow ? me.id : "");
    const globalId = fellow?.globalId
      || fellow?.global_id
      || identity.globalId
      || identity.global_id
      || fellowGlobalIdFromConversation(conversationId, ref);
    return contact()?.fellowAvatarIdentityId?.(ref, {
      ...(fellow || {}),
      ownerUserId,
      globalId
    }) || globalId || (ownerUserId && ref ? sessionHistory()?.fellowConversationId?.(ownerUserId, ref) : "") || ref;
  }

  function localFellow(ref) {
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    const cloudFellows = Array.isArray(_ctx?.moduleState?.fellows) ? _ctx.moduleState.fellows : [];
    const localFellows = [
      ...(Array.isArray(runtime.fellows) ? runtime.fellows : []),
      ...(Array.isArray(runtime.personas) ? runtime.personas : [])
    ];
    const fellows = _ctx?.adapterCtx?.()?.fellows
      || (global.miaFellowDirectory
        ? global.miaFellowDirectory.listOwnedFellows({ cloudFellows, localFellows, runtime })
        : [...cloudFellows, ...localFellows]);
    const target = String(ref || "");
    return fellows.find((f) => String(f.key || "") === target || String(f.id || "") === target) || null;
  }

  function findFellowConversationMember(conversationId, ref) {
    const members = _ctx?.conversationMembersCache?.get?.(conversationId) || [];
    return members.find((m) => m.member_kind === MemberKind.Fellow && m.member_ref === ref) || null;
  }

  function friend(ref) {
    const friends = _ctx?.moduleState?.friends || [];
    return friends.find((f) => f.id === ref) || null;
  }

  function selfUser() {
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    const local = runtime.user || {};
    const cloud = runtime.cloud?.user || {};
    return {
      ...local,
      ...cloud,
      id: _ctx?.moduleState?.myUserId || cloud.id || local.id || ""
    };
  }

  function runtimeCacheKey(fellowKey, runtimeKind) {
    return global.miaFellowCommands?.runtimeCacheKey?.(fellowKey, runtimeKind)
      || `${fellowKey}:${runtimeKind || "cloud-hermes"}`;
  }

  function bindingForFellow(fellowKey, runtimeKind) {
    return fellowRuntimeBindingCache.get(runtimeCacheKey(fellowKey, runtimeKind)) || null;
  }

  function ensureOption(select, value, label) {
    if (!select || value == null) return;
    const wanted = String(value);
    const existing = Array.from(select.options || []).find((option) => String(option.value) === wanted);
    if (!existing && typeof document?.createElement === "function") {
      const option = document.createElement("option");
      option.value = wanted;
      option.textContent = label || wanted;
      select.appendChild(option);
    }
    select.value = wanted;
  }

  function applyRuntimeBindingToCard(card, binding) {
    const config = binding?.config || {};
    if (!card?.querySelector) return;
    if (config.model) {
      const select = card.querySelector('[data-fellow-field="model"]');
      ensureOption(select, config.model, config.model);
      const label = card.querySelector(".model-current-label");
      if (label) label.textContent = select?.selectedOptions?.[0]?.textContent || config.model;
    }
    if (config.effortLevel) {
      const select = card.querySelector('[data-fellow-field="effortLevel"]');
      ensureOption(select, config.effortLevel, config.effortLevel);
      const label = card.querySelector(".effort-label");
      if (label) label.textContent = select?.selectedOptions?.[0]?.textContent || config.effortLevel;
    }
    if (config.permissionMode) {
      const select = card.querySelector('[data-fellow-field="permissionMode"]');
      ensureOption(select, config.permissionMode, config.permissionMode);
      const label = card.querySelector(".permission-label");
      if (label) label.textContent = select?.selectedOptions?.[0]?.textContent || config.permissionMode;
    }
  }

  function hydrateFellowRuntimeBinding(card, fellow, runtimeKind) {
    const fellowKey = String(fellow?.key || fellow?.id || "").trim();
    if (!fellowKey || runtimeKind !== "cloud-hermes") return;
    if (typeof global.miaFellowCommands?.getFellowRuntimeBinding !== "function") return;
    global.miaFellowCommands.getFellowRuntimeBinding({
      api: global.mia,
      cache: fellowRuntimeBindingCache,
      fellowKey,
      runtimeKind
    }).then((binding) => {
      if (!binding) return;
      fellowRuntimeBindingCache.set(runtimeCacheKey(fellowKey, runtimeKind), binding);
      if (_popover === card) applyRuntimeBindingToCard(card, binding);
    }).catch((error) => {
      console.warn?.("[contact-card] fellow runtime binding load failed:", error?.message || error);
    });
  }

  // Fellow card with live engineConfig selectors (model / effort / permission)
  // that mirror the topbar composer-bottom controls in private chat.
  function renderFellowCard(args) {
    const { ref, conversationId } = args;
    const member = findFellowConversationMember(conversationId, ref);
    const ownerId = member?.owner_id || "";
    const me = selfUser();
    // In a shared conversation, trust the member row's owner_id (never elevate just
    // because a fellow key happens to collide with one of our local keys). Only
    // when there's NO conversation member (private fellow chat) does a local fellow
    // count as ours — there's no owner_id to read there.
    const isMine = member ? (ownerId === me.id) : Boolean(localFellow(ref));
    // Bind the local fellow ONLY when it's actually ours. A same-key fellow
    // owned by another conversation member must fall through to the remote-only card —
    // otherwise its name/avatar/controls would mirror, and edits would persist
    // to, my own local fellow settings.
    const local = isMine ? localFellow(ref) : null;

    const name = local?.name || member?.identity?.displayName || member?.fellow_name || ref;
    const identityAvatar = member?.identity?.avatar || {};
    const avatarId = fellowAvatarIdentityId(ref, local || {}, member || null, conversationId);
    const avatar = resolveCardAvatar({
      id: avatarId,
      displayName: name,
      avatarImage: local ? local.avatarImage : (identityAvatar.image || member?.fellow_avatar_image || ""),
      avatarCrop: local ? local.avatarCrop : (identityAvatar.crop || member?.fellow_avatar_crop || null)
    });

    const card = document.createElement("div");
    card.className = "contact-card";
    card.setAttribute("role", "dialog");

    if (!local) {
      card.innerHTML = `
        <div class="contact-card-head">
          <span class="avatar contact-card-avatar"></span>
          <div class="contact-card-head-text">
            <strong class="contact-card-name">${escapeHtml(name)}</strong>
            <span class="contact-card-kind">远端</span>
          </div>
        </div>
        <p class="contact-card-empty">这位 Fellow 不属于你，只能看到名字。</p>
        <div class="contact-card-actions">
          <button type="button" data-card-action="close" class="button-primary">关闭</button>
        </div>
      `;
      paintContactCardAvatar(card, avatar);
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-card-action]")) closeCard();
      });
      return card;
    }

    const engineOptions = global.miaEngineOptions;
    const modelHelpers = global.miaModelHelpers;
    const modelSettings = global.miaModelSettings;
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    const runtimeKind = local.runtimeKind || "desktop-local";
    const engine = local.agentEngine || local.agent_engine || "hermes";
    const isExternal = engine === "claude-code" || engine === "codex";
    const isCloudHermes = runtimeKind === "cloud-hermes";
    const fellowKey = String(local.key || local.id || ref || "").trim();
    const runtimeBinding = isCloudHermes ? bindingForFellow(fellowKey, runtimeKind) : null;
    const config = isCloudHermes
      ? { ...(local.engineConfig || local.engine_config || {}), ...(runtimeBinding?.config || {}) }
      : (local.engineConfig || local.engine_config || {});

    // Reuse the same entry sources the topbar composer-bottom uses so the
    // dropdown contents (and labels / logos) match private chat exactly.
    const modelEntries = isCloudHermes
      ? [{ id: "mia-default", model: "mia-default", label: "Mia Default", provider: "mia-cloud" }]
      : isExternal
      ? (engineOptions?.externalModelEntries?.(engine) || [])
      : (modelSettings?.connectedModelEntries?.(runtime) || []);
    const effortEntries = engineOptions?.effortOptions?.(engine) || [];
    const permissionEntries = isCloudHermes
      ? [
        { value: "ask", label: "Ask" },
        { value: "auto", label: "Auto" },
        { value: "readOnly", label: "Read" }
      ]
      : (engineOptions?.externalPermissionOptions?.(engine) || []);

    // Current selections.
    const currentModelEntry = (() => {
      if (isCloudHermes) {
        const cur = config.model || "mia-default";
        return modelEntries.find((m) => m.model === cur || m.id === cur) || modelEntries[0] || null;
      }
      if (isExternal) {
        const cur = config.model || "";
        if (!cur) return modelEntries.find((m) => m.id === "default") || modelEntries[0] || null;
        return modelEntries.find((m) => m.model === cur || m.id === cur) || null;
      }
      const currentId = modelHelpers?.catalogEntryForModel?.(runtime?.model || {})?.id
        || modelHelpers?.modelKey?.(runtime?.model || {})
        || "";
      return modelEntries.find((m) => m.id === currentId) || modelEntries[0] || null;
    })();
    const currentModelLabel = currentModelEntry?.label || (isExternal ? "默认" : (modelHelpers?.modelDisplayName?.(runtime?.model || {}) || "未配置"));
    const modelLogoSrc = (() => {
      if (isExternal) {
        return modelHelpers?.modelIconSrc?.({
          provider: engine === "claude-code" ? "anthropic" : "openai-codex",
          model: currentModelEntry?.model || ""
        }) || "";
      }
      return modelHelpers?.modelIconSrc?.(runtime?.model || {}) || "";
    })();

    const currentEffort = config.effortLevel
      || effortEntries.find((e) => e.value === "medium")?.value
      || effortEntries[0]?.value
      || "";
    const currentEffortLabel = effortEntries.find((e) => e.value === currentEffort)?.label || "Medium";

    const currentPermission = config.permissionMode
      || permissionEntries.find((p) => p.value === (isCloudHermes ? "ask" : "default"))?.value
      || permissionEntries[0]?.value
      || "";
    const currentPermissionLabel = permissionEntries.find((p) => p.value === currentPermission)?.label || "Ask";

    function options(entries, valueKey, labelKey, selectedValue) {
      return entries.map((e) => {
        const value = e[valueKey];
        const sel = value === selectedValue ? " selected" : "";
        return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(e[labelKey])}</option>`;
      }).join("");
    }

    const modelLogoStyle = modelLogoSrc
      ? `background-image:url('${escapeHtml(modelLogoSrc)}');background-color:transparent;`
      : "";

    card.innerHTML = `
      <div class="contact-card-head">
        <span class="avatar contact-card-avatar"></span>
        <div class="contact-card-head-text">
          <strong class="contact-card-name">${escapeHtml(name)}</strong>
          <span class="contact-card-kind">${escapeHtml(local.runtimeLabel || (isCloudHermes ? "Mia Cloud" : engine))}</span>
        </div>
      </div>
      <dl class="contact-card-controls">
        <div class="contact-card-row">
          <dt>模型</dt>
          <dd>
            <label class="model-switcher" title="切换模型">
              <span class="model-avatar" style="${modelLogoStyle}" aria-hidden="true">${modelLogoSrc ? "" : "◇"}</span>
              <span class="model-current-label">${escapeHtml(currentModelLabel)}</span>
              ${modelEntries.length
                ? `<select data-fellow-field="model" aria-label="切换模型">${options(modelEntries, "id", "label", currentModelEntry?.id)}</select>`
                : ""}
            </label>
          </dd>
        </div>
        <div class="contact-card-row">
          <dt>推理强度</dt>
          <dd>
            <label class="effort-switcher" title="切换推理强度">
              <span class="effort-label">${escapeHtml(currentEffortLabel)}</span>
              ${effortEntries.length
                ? `<select data-fellow-field="effortLevel" aria-label="切换推理强度">${options(effortEntries, "value", "label", currentEffort)}</select>`
                : ""}
            </label>
          </dd>
        </div>
        <div class="contact-card-row">
          <dt>权限</dt>
          <dd>
            <label class="permission-switcher" title="权限模式">
              <span class="permission-label">${escapeHtml(currentPermissionLabel)}</span>
              ${permissionEntries.length
                ? `<select data-fellow-field="permissionMode" aria-label="权限模式">${options(permissionEntries, "value", "label", currentPermission)}</select>`
                : ""}
            </label>
          </dd>
        </div>
      </dl>
      <div class="contact-card-actions">
        ${isMine ? `<button type="button" data-card-action="edit-fellow" class="button-soft">编辑人设</button>` : ""}
        <button type="button" data-card-action="close" class="button-primary">关闭</button>
      </div>
    `;
    paintContactCardAvatar(card, avatar);

    async function persistField(field, value) {
      try {
        await global.miaFellowCommands?.saveFellowRuntimeControl?.({
          api: global.mia,
          fellow: local,
          runtimeKind,
          field,
          value,
          modelEntries
        });
      } catch (err) {
        alert("保存失败：" + (err?.message || err));
      }
    }

    card.addEventListener("change", (event) => {
      const sel = event.target.closest("[data-fellow-field]");
      if (!sel) return;
      const newLabel = sel.options[sel.selectedIndex]?.textContent || "";
      const labelSpan = sel.parentElement?.querySelector(".model-current-label, .effort-label, .permission-label");
      if (labelSpan) labelSpan.textContent = newLabel;
      persistField(sel.dataset.fellowField, sel.value);
    });
    if (isCloudHermes) hydrateFellowRuntimeBinding(card, local, runtimeKind);
    card.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-card-action]");
      if (!btn) return;
      event.stopPropagation();
      if (btn.dataset.cardAction === "edit-fellow") {
        closeCard();
        global.miaFellowDialog?.openFellowDialog?.(local, local.personaText || "");
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
    const name = f?.username || f?.account || ref;
    const avatar = resolveCardAvatar({
      id: ref,
      displayName: name,
      avatarImage: f?.avatarImage || "",
      avatarCrop: f?.avatarCrop || null
    });
    const card = document.createElement("div");
    card.className = "contact-card";
    card.setAttribute("role", "dialog");
    card.innerHTML = `
      <div class="contact-card-head">
        <span class="avatar contact-card-avatar"></span>
        <div class="contact-card-head-text">
          <strong class="contact-card-name">${escapeHtml(name)}</strong>
          <span class="contact-card-kind">${isSelf ? "我" : "联系人"}</span>
        </div>
      </div>
      <div class="contact-card-actions">
        <button type="button" data-card-action="close" class="button-primary">关闭</button>
      </div>
    `;
    paintContactCardAvatar(card, avatar);
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
    const card = kind === MemberKind.Fellow
      ? renderFellowCard({ ref, conversationId })
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
    if (kind === MemberKind.Fellow) {
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
