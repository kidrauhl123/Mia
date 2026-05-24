// Click-on-avatar contact card for cloud rooms.
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

  const { MemberKind } = (typeof window !== "undefined" && window.aimashiConversationKinds)
    || require("../../shared/conversation-kinds");

  let _ctx = null;
  let _popover = null;
  let _onOutside = null;
  let _onEsc = null;

  function attach(internalCtx) { _ctx = internalCtx; }

  function escapeHtml(value) {
    return global.aimashiMarkdown?.escapeHtml?.(value)
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

  function avatarStyleFor(avatar) {
    if (avatar?.image) {
      const helper = global.aimashiAvatar?.avatarThumbBackgroundStyle;
      if (helper) return helper(avatar.image, avatar.crop, avatar.color || "#5e5ce6");
    }
    return `background-color:${avatar?.color || "#5e5ce6"};`;
  }

  function localFellow(ref) {
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    const fellows = runtime.fellows || runtime.personas || [];
    return fellows.find((f) => (f.id || f.key) === ref) || null;
  }

  function findFellowRoomMember(roomId, ref) {
    const members = _ctx?.roomMembersCache?.get?.(roomId) || [];
    return members.find((m) => m.member_kind === MemberKind.Fellow && m.member_ref === ref) || null;
  }

  function friend(ref) {
    const friends = _ctx?.moduleState?.friends || [];
    return friends.find((f) => f.id === ref) || null;
  }

  function selfUser() {
    const runtime = _ctx?.deps?.getState?.()?.runtime || {};
    return runtime.cloud?.user || runtime.user || {};
  }

  // Fellow card with live engineConfig selectors (model / effort / permission)
  // that mirror the topbar composer-bottom controls in private chat.
  function renderFellowCard(args) {
    const { ref, roomId } = args;
    const local = localFellow(ref);
    const member = findFellowRoomMember(roomId, ref);
    const ownerId = member?.owner_id || "";
    const me = selfUser();
    const isMine = ownerId === me.id;

    const name = local?.name || member?.fellow_name || ref;
    const avatar = local
      ? { image: local.avatarImage, crop: local.avatarCrop, color: local.color }
      : { image: member?.fellow_avatar_image, crop: member?.fellow_avatar_crop, color: member?.fellow_color || "#5e5ce6" };

    const card = document.createElement("div");
    card.className = "contact-card";
    card.setAttribute("role", "dialog");

    if (!local) {
      card.innerHTML = `
        <div class="contact-card-head">
          <span class="avatar contact-card-avatar" style="${avatarStyleFor(avatar)}"></span>
          <div class="contact-card-head-text">
            <strong class="contact-card-name">${escapeHtml(name)}</strong>
            <span class="contact-card-kind">AI · 远端</span>
          </div>
        </div>
        <p class="contact-card-empty">这位 AI 不在你的本地 fellow 列表里，只能看到名字。</p>
        <div class="contact-card-actions">
          <button type="button" data-card-action="close" class="button-primary">关闭</button>
        </div>
      `;
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-card-action]")) closeCard();
      });
      return card;
    }

    const engineOptions = global.aimashiEngineOptions;
    const engine = engineOptions?.activeAgentEngine
      ? (local.agentEngine || local.agent_engine || "hermes")
      : (local.agentEngine || "hermes");
    const config = local.engineConfig || local.engine_config || {};
    const modelEntries = engineOptions?.externalModelEntries?.(engine) || [];
    const effortEntries = engineOptions?.effortOptions?.(engine) || [];
    const permissionEntries = engineOptions?.externalPermissionOptions?.(engine) || [];

    const isExternal = engine === "claude-code" || engine === "codex";
    const modelDefaultEntry = modelEntries.find((m) => m.id === "default");
    const currentModelId = (() => {
      if (!isExternal) return "";
      const cur = config.model || "";
      if (!cur) return modelDefaultEntry?.id || "default";
      const match = modelEntries.find((m) => m.model === cur || m.id === cur);
      return match?.id || cur;
    })();
    const currentEffort = config.effortLevel || (effortEntries.find((e) => e.value === "medium")?.value || effortEntries[0]?.value || "");
    const currentPermission = config.permissionMode || (permissionEntries.find((p) => p.value === "default")?.value || permissionEntries[0]?.value || "");

    function optionList(entries, valueKey, labelKey, selectedValue) {
      return entries.map((e) => {
        const value = e[valueKey];
        const sel = value === selectedValue ? " selected" : "";
        return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(e[labelKey])}</option>`;
      }).join("");
    }

    card.innerHTML = `
      <div class="contact-card-head">
        <span class="avatar contact-card-avatar" style="${avatarStyleFor(avatar)}"></span>
        <div class="contact-card-head-text">
          <strong class="contact-card-name">${escapeHtml(name)}</strong>
          <span class="contact-card-kind">AI · ${escapeHtml(engine)}</span>
        </div>
      </div>
      <dl class="contact-card-fields contact-card-fields-editable">
        <div>
          <dt>模型</dt>
          <dd>${isExternal && modelEntries.length
            ? `<select data-fellow-field="model">${optionList(modelEntries, "id", "label", currentModelId)}</select>`
            : `<span class="contact-card-muted">由全局模型决定</span>`}</dd>
        </div>
        <div>
          <dt>思考强度</dt>
          <dd>${effortEntries.length
            ? `<select data-fellow-field="effortLevel">${optionList(effortEntries, "value", "label", currentEffort)}</select>`
            : `<span class="contact-card-muted">不适用</span>`}</dd>
        </div>
        <div>
          <dt>权限模式</dt>
          <dd>${permissionEntries.length
            ? `<select data-fellow-field="permissionMode">${optionList(permissionEntries, "value", "label", currentPermission)}</select>`
            : `<span class="contact-card-muted">不适用</span>`}</dd>
        </div>
      </dl>
      <div class="contact-card-actions">
        ${isMine ? `<button type="button" data-card-action="edit-fellow" class="button-soft">编辑人设</button>` : ""}
        <button type="button" data-card-action="close" class="button-primary">关闭</button>
      </div>
    `;

    async function persistField(field, value) {
      try {
        const update = {};
        if (field === "model") {
          // The select option value is the model entry id; we need the actual
          // `.model` string (which is "" for the "default" entry — encoded as
          // a missing field in storage).
          const entry = modelEntries.find((m) => m.id === value);
          update.model = entry?.model || "";
        } else {
          update[field] = value;
        }
        await global.aimashi.saveFellowEngine({
          key: local.key,
          agentEngine: engine,
          engineConfig: update,
        });
      } catch (err) {
        alert("保存失败：" + (err?.message || err));
      }
    }

    card.addEventListener("change", (event) => {
      const sel = event.target.closest("[data-fellow-field]");
      if (!sel) return;
      persistField(sel.dataset.fellowField, sel.value);
    });
    card.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-card-action]");
      if (!btn) return;
      event.stopPropagation();
      if (btn.dataset.cardAction === "edit-fellow") {
        closeCard();
        global.aimashiFellowDialog?.openFellowDialog?.(local, local.personaText || "");
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
    const avatar = {
      image: f?.avatarImage || "",
      crop: f?.avatarCrop || null,
      color: f?.avatarColor || "#5e5ce6"
    };
    const card = document.createElement("div");
    card.className = "contact-card";
    card.setAttribute("role", "dialog");
    card.innerHTML = `
      <div class="contact-card-head">
        <span class="avatar contact-card-avatar" style="${avatarStyleFor(avatar)}"></span>
        <div class="contact-card-head-text">
          <strong class="contact-card-name">${escapeHtml(name)}</strong>
          <span class="contact-card-kind">${isSelf ? "我" : "联系人"}</span>
        </div>
      </div>
      <div class="contact-card-actions">
        <button type="button" data-card-action="close" class="button-primary">关闭</button>
      </div>
    `;
    card.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-card-action]");
      if (!btn) return;
      event.stopPropagation();
      closeCard();
    });
    return card;
  }

  function openCard({ kind, ref, roomId, anchor }) {
    closeCard();
    const card = kind === MemberKind.Fellow
      ? renderFellowCard({ ref, roomId })
      : renderUserCard({ ref, roomId });
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

  function openContextMenu({ kind, ref, roomId, anchor, x, y }) {
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
      if (btn.dataset.cardMenu === "card") openCard({ kind, ref, roomId, anchor });
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

  global.aimashiContactCard = {
    attach,
    openCard,
    openContextMenu,
    closeCard,
  };

  if (global.aimashiSocial && global.aimashiSocial._internalCtx) {
    attach(global.aimashiSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);
