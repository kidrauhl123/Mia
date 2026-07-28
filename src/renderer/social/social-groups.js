// Renderer-side group-conversation feature: group message rendering, @mention send,
// and the create-group dialog.
// Loaded by <script src="./social/social-groups.js"> AFTER social.js.
// Uses window.miaSocial._internalCtx to share state.

(function (global) {
  const { MemberKind, SenderKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../../shared/conversation-kinds");

  let ctx = null; // set by attach()
  const pendingMemberFetches = new Set();
  const memberFetchPromises = new Map();
  const memberFetchQueue = [];
  const failedMemberFetches = new Map();
  const MEMBER_FETCH_CONCURRENCY = 3;
  const MEMBER_FETCH_TRANSIENT_COOLDOWN_MS = 15_000;
  const MEMBER_FETCH_NOT_FOUND_COOLDOWN_MS = 120_000;
  let activeMemberFetches = 0;
  let memberRenderTimer = 0;

  function attach(internalCtx) {
    ctx = internalCtx;
  }

  // Build the adapter-facing ctx ({ self, bots, friends }) from
  // social's internal ctx + the renderer's runtime state. All cloud-conversation
  // sender resolution must go through this; raw cloud-message schema fields
  // (sender kind / member kind / refs) are off-limits to this file —
  // consume MessageSpec from cloud-conversation-source.js instead.
  function _adapterCtx() {
    if (ctx && typeof ctx.adapterCtx === "function") return ctx.adapterCtx();
    const { moduleState, deps } = ctx;
    const runtimeState = deps && typeof deps.getState === "function" ? deps.getState() : {};
    const runtime = runtimeState.runtime || {};
    const identityBots = Array.isArray(moduleState.bots) ? moduleState.bots : [];
    const bots = window.miaBotDirectory
      ? window.miaBotDirectory.listOwnedBots({ identityBots, runtime })
      : identityBots;
    const selfIdentity = typeof window !== "undefined" && window.miaSelfIdentity;
    const self = selfIdentity
      ? selfIdentity.resolveSelfIdentity({
          cloudUser: runtime.cloud?.user || {},
          localUser: runtime.user || {},
          myUserId: moduleState.myUserId,
          myUsername: moduleState.myUsername
        })
      : { id: moduleState.myUserId || "", username: moduleState.myUsername || "" };
    return {
      self,
      bots,
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

  function normalizeToolStatus(status) {
    const value = String(status || "").trim();
    if (value === "complete" || value === "completed") return "completed";
    if (value === "error" || value === "failed") return "error";
    return "running";
  }

  function parseTraceJson(value) {
    if (!value) return null;
    let parsed = value;
    if (typeof value === "string") {
      try { parsed = JSON.parse(value); } catch { return null; }
    }
    if (!parsed || typeof parsed !== "object") return null;
    const reasoning = String(parsed.reasoning || "").trim();
    const rawDuration = Number(parsed.duration ?? parsed.durationSeconds);
    const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    const tools = Array.isArray(parsed.tools)
      ? parsed.tools.map((tool, idx) => {
        if (!tool || typeof tool !== "object") return null;
        const name = String(tool.name || "").trim();
        if (!name) return null;
        return {
          id: String(tool.id || `tool_${idx}`),
          name,
          preview: String(tool.preview || ""),
          status: normalizeToolStatus(tool.status),
          duration: typeof tool.duration === "number" ? tool.duration : null,
          error: Boolean(tool.error)
        };
      }).filter(Boolean)
      : [];
    if (!reasoning && !tools.length && !durationSeconds) return null;
    return { reasoning, tools, durationSeconds };
  }

  function parseContentBlocksJson(value) {
    if (!value) return [];
    let parsed = value;
    if (typeof value === "string") {
      try { parsed = JSON.parse(value); } catch { return []; }
    }
    const normalizer = global.miaAssistantContentBlocks;
    if (normalizer && typeof normalizer.normalizeContentBlocks === "function") {
      return normalizer.normalizeContentBlocks(parsed);
    }
    return Array.isArray(parsed) ? parsed.filter((block) => block && typeof block === "object") : [];
  }

  function contentBlocksFromMessage(msg) {
    const blocks = parseContentBlocksJson(msg?.content_blocks_json || msg?.contentBlocks || msg?.content_blocks);
    if (!blocks.length) return [];
    const normalizer = global.miaAssistantContentBlocks;
    return normalizer && typeof normalizer.contentBlocksWithFinalText === "function"
      ? normalizer.contentBlocksWithFinalText(blocks, msg?.body_md || msg?.bodyMd || "")
      : blocks;
  }

  function assistantMessageIsProcessing(message) {
    const renderer = global.miaTraceBlocks;
    if (renderer && typeof renderer.isAssistantMessageProcessing === "function") {
      return renderer.isAssistantMessageProcessing(message);
    }
    const status = String(message?.status || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    return status === "streaming"
      || status === "running"
      || status === "in_progress"
      || status === "pending"
      || status === "cancelling";
  }

  function renderTraceForMessage(msg, content) {
    if (msg.sender_kind !== SenderKind.Bot) return "";
    if (contentBlocksFromMessage(msg).length) return "";
    const trace = parseTraceJson(msg.trace_json || msg.trace);
    if (!trace) return "";
    const renderer = global.miaTraceBlocks;
    if (!renderer || typeof renderer.renderTraceBlocks !== "function") return "";
    const processing = assistantMessageIsProcessing(msg);
    return renderer.renderTraceBlocks({
      reasoning: trace.reasoning,
      tools: trace.tools,
      content,
      completed: !processing,
      processing,
      expanded: false,
      scopeKey: `cloud-msg:${msg.id || ""}`,
      durationSeconds: trace.durationSeconds
    });
  }

  function renderOrderedAssistantBlocks({ blocks, completed, processing, expanded, scopeKey, renderTextBlock, durationSeconds }) {
    const renderer = global.miaTraceBlocks;
    if (!renderer || typeof renderer.renderAssistantContentBlocks !== "function") return "";
    return renderer.renderAssistantContentBlocks({
      blocks,
      completed,
      processing,
      expanded,
      scopeKey,
      renderTextBlock,
      durationSeconds
    });
  }

  function renderNameWithBadgeHtml({ identity, fallbackName, statusBadge } = {}) {
    const renderer = global.miaNameWithBadge;
    if (renderer && typeof renderer.renderNameWithBadgeHtml === "function") {
      try {
        return renderer.renderNameWithBadgeHtml({ identity, fallbackName, statusBadge });
      } catch {
        // Optional badge payloads must not break group message rendering.
      }
    }
    return ctx.escapeHtml(fallbackName || identity?.displayName || "");
  }

  function statusBadgeFrom(...sources) {
    for (const source of sources) {
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
    }
    return undefined;
  }

  function cleanDisplayText(value) {
    return String(value || "").trim();
  }

  function friendDisplayName(friend = {}, adapterCtx = {}) {
    const explicitName = cleanDisplayText(
      friend.displayName
      || friend.display_name
      || friend.nickname
      || friend.nickName
      || friend.nick_name
      || friend.name
      || friend.identity?.displayName
      || friend.identity?.display_name
    );
    if (explicitName) return explicitName;
    const contact = global.miaContact?.resolveContact?.(
      { kind: global.miaContact.IdentityKind?.User || "user", ref: friend.id },
      { ...adapterCtx, friends: [friend] }
    );
    return cleanDisplayText(contact?.displayName || friend.username || friend.account || friend.id);
  }

  function initNameBadgeLotties(root) {
    try { global.miaNameWithBadge?.initLottieBadges?.(root); } catch { /* optional badge animation */ }
  }

  function memberFetchFailureCooldownMs(errorOrResponse) {
    const status = Number(errorOrResponse?.status || errorOrResponse?.statusCode || 0);
    const message = String(errorOrResponse?.message || errorOrResponse?.error || errorOrResponse || "");
    return status === 404 || /\b404\b|not found/i.test(message)
      ? MEMBER_FETCH_NOT_FOUND_COOLDOWN_MS
      : MEMBER_FETCH_TRANSIENT_COOLDOWN_MS;
  }

  function rememberMemberFetchFailure(conversationId, errorOrResponse) {
    failedMemberFetches.set(conversationId, Date.now() + memberFetchFailureCooldownMs(errorOrResponse));
  }

  function isMemberFetchCoolingDown(conversationId) {
    const retryAt = failedMemberFetches.get(conversationId) || 0;
    if (!retryAt) return false;
    if (retryAt > Date.now()) return true;
    failedMemberFetches.delete(conversationId);
    return false;
  }

  // Group bubble mirrors bot chat's renderMessageHtml shape EXACTLY
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
    const memberAccent = window.miaMemberColor.memberAccentColor;
    const senderColor = memberAccent(msg.sender_ref || authorName);
    const avatarColor = avatar.color || senderColor;
    const avatarHelpers = window.miaAvatar;
    const avatarLetter = avatar.image ? "" : (avatar.text || ((authorName || "?").trim().slice(0, 2) || "?"));
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
    // Index in the conversation's message cache — used by the chat-level contextmenu
    // dispatcher in app.js to look up the message for the floating menu.
    const cache = moduleState.messageCache.get(conversationId);
    const messageIndex = cache ? cache.messages.findIndex((m) => m.id === msg.id) : -1;
    const bodyMd = (spec ? spec.bodyMd : msg.body_md) || "";
    const senderTitleHtml = senderLabel
      ? `<span class="bubble-sender" style="color:${escapeHtml(avatarColor)};">${renderNameWithBadgeHtml({
          identity: spec?.authorIdentity,
          fallbackName: senderLabel,
          statusBadge: spec?.statusBadge
        })}</span>`
      : "";
    const rawBodyHtml = renderMsgBody(bodyMd);
    const bodyHtml = global.miaMentionRender
      ? global.miaMentionRender.highlightMentions(rawBodyHtml, members || [])
      : rawBodyHtml;
    const attachmentHtml = typeof ctx.renderAttachmentChips === "function"
      ? ctx.renderAttachmentChips(spec?.attachments || msg.attachments || [])
      : "";
    const attachmentBeforeBodyHtml = isOwn ? attachmentHtml : "";
    const attachmentAfterBodyHtml = isOwn ? "" : attachmentHtml;
    const contentBlocks = !isOwn ? contentBlocksFromMessage(msg) : [];
    const processing = !isOwn && assistantMessageIsProcessing(msg);
    const persistedTrace = !isOwn ? parseTraceJson(msg.trace_json || msg.trace) : null;
    let renderedFirstTextBlock = false;
    const orderedBlocksHtml = contentBlocks.length
      ? renderOrderedAssistantBlocks({
        blocks: contentBlocks,
        completed: !processing,
        processing,
        expanded: false,
        scopeKey: `cloud-msg:${msg.id || ""}`,
        durationSeconds: persistedTrace?.durationSeconds || 0,
        renderTextBlock(block, _blockIndex, renderState = {}) {
          const prefixHtml = renderedFirstTextBlock || renderState.process
            ? ""
            : `${attachmentBeforeBodyHtml}${senderTitleHtml}`;
          if (!renderState.process) renderedFirstTextBlock = true;
          const rawBlockHtml = renderMsgBody(block.text || "");
          const blockHtml = global.miaMentionRender
            ? global.miaMentionRender.highlightMentions(rawBlockHtml, members || [])
            : rawBlockHtml;
          return `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${prefixHtml}${blockHtml}</div>`;
        }
      })
      : "";
    const traceHtml = orderedBlocksHtml ? "" : renderTraceForMessage(msg, bodyMd);
    const orderedBlocksLeadingBubbleHtml = orderedBlocksHtml && !renderedFirstTextBlock && (attachmentBeforeBodyHtml || senderTitleHtml)
      ? `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${attachmentBeforeBodyHtml}${senderTitleHtml}</div>`
      : "";
    const orderedBlocksTrailingBubbleHtml = orderedBlocksHtml && attachmentAfterBodyHtml
      ? `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${attachmentAfterBodyHtml}</div>`
      : "";
    const orderedBlocksWithAttachments = orderedBlocksHtml
      ? `${orderedBlocksLeadingBubbleHtml}${orderedBlocksHtml}${orderedBlocksTrailingBubbleHtml}`
      : "";
    const sendStatusHtml = typeof ctx.renderSendStatus === "function"
      ? ctx.renderSendStatus(msg)
      : "";
    const createdAt = msg.created_at || msg.createdAt || "";
    const timeHtml = createdAt
      ? `<time class="message-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(window.miaTimeFormat.formatMessageTime(createdAt))}</time>`
      : "";

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
    article.className = `message ${roleClass} group-message`;
    if (typeof article.setAttribute === "function") {
      article.setAttribute("data-message-id", msg.id || "");
    } else {
      article.dataset = { ...(article.dataset || {}), messageId: msg.id || "" };
    }
    // Name color tracks the resolved avatar color, so a member's set accent
    // color shows here too; falls back to the id hash when none is set.
    article.innerHTML = `
      ${avatarHtml}
      <div class="message-stack">
        ${traceHtml}
        ${orderedBlocksWithAttachments || `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${attachmentBeforeBodyHtml}${senderTitleHtml}${bodyHtml}${attachmentAfterBodyHtml}</div>`}
        ${translationHtml}
        ${timeHtml}
        ${sendStatusHtml}
      </div>
    `;
    initNameBadgeLotties(article);
    return article;
  }

  function scheduleMemberRender() {
    if (memberRenderTimer) return;
    memberRenderTimer = global.setTimeout(() => {
      memberRenderTimer = 0;
      if (ctx?.deps && typeof ctx.deps.render === "function") ctx.deps.render();
    }, 60);
  }

  async function runMemberFetch(conversationId) {
    try {
      const res = await global.mia.social.getConversation(conversationId);
      if (res.ok && res.data && Array.isArray(res.data.members)) {
        failedMemberFetches.delete(conversationId);
        ctx.conversationMembersCache.set(conversationId, res.data.members);
        scheduleMemberRender();
      } else if (!res?.ok) {
        rememberMemberFetchFailure(conversationId, res);
      }
    } catch (err) {
      rememberMemberFetchFailure(conversationId, err);
      console.warn("[social-groups] fetchAndCacheConversationMembers failed:", conversationId, err?.message || err);
    }
  }

  function pumpMemberFetchQueue() {
    while (activeMemberFetches < MEMBER_FETCH_CONCURRENCY && memberFetchQueue.length) {
      const job = memberFetchQueue.shift();
      activeMemberFetches += 1;
      runMemberFetch(job.conversationId).finally(() => {
        activeMemberFetches -= 1;
        pendingMemberFetches.delete(job.conversationId);
        memberFetchPromises.delete(job.conversationId);
        job.resolve();
        pumpMemberFetchQueue();
      });
    }
  }

  function fetchAndCacheConversationMembers(conversationId) {
    if (!conversationId || !ctx) return Promise.resolve();
    if (ctx.conversationMembersCache?.has(conversationId)) return Promise.resolve();
    if (memberFetchPromises.has(conversationId)) return memberFetchPromises.get(conversationId);
    if (isMemberFetchCoolingDown(conversationId)) return Promise.resolve();
    if (!global.mia || !global.mia.social || typeof global.mia.social.getConversation !== "function") {
      return Promise.resolve();
    }
    let resolveJob;
    const promise = new Promise((resolve) => { resolveJob = resolve; });
    memberFetchPromises.set(conversationId, promise);
    pendingMemberFetches.add(conversationId);
    memberFetchQueue.push({ conversationId, resolve: resolveJob });
    pumpMemberFetchQueue();
    return promise;
  }

  // ── group send ────────────────────────────────────────────────────────────
  // Message sending is intentionally owned by social.js so cloud DM, bot,
  // and group conversations share one optimistic-send/reconcile pipeline.

  async function sendInActiveGroupConversation(text) {
    if (global.miaSocial && typeof global.miaSocial.sendInActiveConversation === "function") {
      return global.miaSocial.sendInActiveConversation(text);
    }
    console.warn("[social-groups] unified social send path is unavailable");
  }

  // ── openCreateGroupDialog ─────────────────────────────────────────────────
  // React renders the dialog. This adapter builds one mixed contact list and
  // performs the cloud-conversation mutation.

  function openCreateGroupDialog() {
    const { moduleState, deps, conversationMembersCache, dedup } = ctx;
    const { friends, bots: ownedBots } = _adapterCtx();
    const entries = [];
    for (const friend of friends) {
      const name = friendDisplayName(friend, { friends, bots: ownedBots });
      const avatar = window.miaAvatarResolve.resolveAvatarForContact({
        id: friend.id,
        displayName: name,
        avatarImage: friend.avatarImage || "",
        avatarCrop: friend.avatarCrop || null,
        color: friend.avatarColor || friend.avatar_color || friend.color || ""
      });
      entries.push({
        kind: "friend",
        id: friend.id,
        name,
        identity: { kind: "user", id: friend.id, displayName: name, statusBadge: statusBadgeFrom(friend) },
        statusBadge: statusBadgeFrom(friend),
        color: avatar.color,
        image: avatar.image,
        crop: avatar.crop,
        text: avatar.text
      });
    }
    for (const bot of ownedBots) {
      const id = bot.key || bot.id;
      const name = bot.name || id;
      const avatar = window.miaContact?.resolveContact?.(
        { kind: window.miaContact.IdentityKind?.Bot || "bot", ref: id },
        { bots: ownedBots }
      )?.avatar || window.miaAvatarResolve.resolveAvatarForContact({
        id: window.miaContact?.botAvatarIdentityId?.(id, bot) || id,
        displayName: name,
        avatarImage: bot.avatarImage || "",
        avatarCrop: bot.avatarCrop || null,
        color: bot.color || bot.avatarColor || bot.avatar_color || ""
      });
      entries.push({
        kind: "bot",
        id,
        name,
        identity: { kind: "bot", id, displayName: name, statusBadge: statusBadgeFrom(bot) },
        statusBadge: statusBadgeFrom(bot),
        runtimeKind: bot.runtimeKind || bot.runtime_kind || "cloud-claude-code",
        color: avatar.color,
        image: avatar.image,
        crop: avatar.crop,
        text: avatar.text
      });
    }
    const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    const close = () => global.miaReactDialogs?.publish?.({ dialog: { kind: "closed" } });
    global.miaReactDialogs?.publish?.({
      dialog: {
        close,
        kind: "group-create",
        members: entries.map((entry) => ({
          avatar: {
            color: entry.color || "#5e5ce6",
            crop: entry.crop || null,
            image: entry.image || "",
            text: entry.text || entry.name || ""
          },
          badge: entry.statusBadge || null,
          id: entry.id,
          key: `${entry.kind}:${entry.id}`,
          name: entry.name
        })),
        submit: async (memberKeys, requestedName) => {
          const selected = memberKeys.map((key) => byKey.get(key)).filter(Boolean);
          if (!selected.length) return "至少选择 1 位联系人";
          const name = String(requestedName || "").trim() || selected.map((entry) => entry.name).join(" · ");
          const memberFriendUserIds = selected.filter((entry) => entry.kind === "friend").map((entry) => entry.id);
          const botEntries = selected.filter((entry) => entry.kind === "bot");
      try {
        const memberBots = botEntries.map((entry) => ({
          botId: entry.id,
          runtimeKind: entry.runtimeKind || "cloud-claude-code"
        }));
        const res = await window.mia.social.createConversation({ name, memberBots, memberFriendUserIds });
        if (!res.ok) return "创建失败：" + (res.error || "");
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
          return "";
        }
        return "创建失败：无效响应";
      } catch (err) {
        return "创建失败：" + (err?.message || err);
      }
        }
      }
    });
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
