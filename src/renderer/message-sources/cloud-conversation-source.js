(function (global) {
  "use strict";

  function spec() {
    if (global.miaMessageSpec) return global.miaMessageSpec;
    if (typeof require === "function") return require("../../shared/message-spec");
    throw new Error("cloud-conversation-source: shared/message-spec.js must load first");
  }
  function contact() {
    if (global.miaContact) return global.miaContact;
    if (typeof require === "function") return require("../../shared/contact");
    throw new Error("cloud-conversation-source: shared/contact.js must load first");
  }
  function avatarResolve() {
    if (global.miaAvatarResolve) return global.miaAvatarResolve;
    if (typeof require === "function") return require("../../shared/avatar-resolve");
    throw new Error("cloud-conversation-source: shared/avatar-resolve.js must load first");
  }
  const { MemberKind, SenderKind } = global.miaConversationKinds
    || (typeof require === "function"
      ? require("../../shared/conversation-kinds")
      : { MemberKind: { Bot: "bot", User: "user" }, SenderKind: { Bot: "bot", User: "user", System: "system" } });

  function hasOwn(obj, key) {
    return Boolean(obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key));
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function statusBadgeFrom(...sources) {
    for (const source of sources) {
      if (hasOwn(source, "statusBadge")) return source.statusBadge;
      if (hasOwn(source, "status_badge")) return source.status_badge;
    }
    return undefined;
  }

  function attachStatusBadge(target, ...sources) {
    const badge = statusBadgeFrom(...sources);
    if (typeof badge !== "undefined") target.statusBadge = badge;
    return target;
  }

  function safeJsonArray(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

  function createCloudConversationSource({ conversation, messages, members, ctx }) {
    const { normalizeSpec } = spec();
    const contactApi = contact();
    const { resolveContact, IdentityKind } = contactApi;
    const UserKind = IdentityKind?.User || "user";
    const BotKind = IdentityKind?.Bot || "bot";
    const { resolveAvatarForContact, hasAvatarIdentityFields } = avatarResolve();
    const selfId = ctx.self?.id || "";
    const memberArr = Array.isArray(members) ? members : [];

    function botRecord(ref) {
      return (Array.isArray(ctx.bots) ? ctx.bots : [])
        .find((f) => f && (f.key === ref || f.id === ref)) || null;
    }

    function botAvatarIdentityId(ref, bot = {}, member = {}) {
      const identity = member?.identity || {};
      const record = {
        ...(bot || {}),
        member_ref: ref,
        globalId: bot?.globalId || bot?.global_id || identity.globalId || identity.global_id,
        ownerUserId: bot?.ownerUserId || bot?.owner_user_id || bot?.ownerId || bot?.owner_id
          || member?.owner_user_id || member?.owner_id || identity.ownerUserId || identity.owner_id
      };
      return contactApi.botAvatarIdentityId?.(ref, record)
        || record.globalId
        || ref;
    }

    function authorForMessage(m) {
      if (m.sender_kind === SenderKind.User) {
        if (m.sender_ref === selfId) return resolveContact({ kind: "self" }, ctx);
        const member = memberArr.find((mem) => mem.member_kind === MemberKind.User && mem.member_ref === m.sender_ref);
        if (member?.identity) {
          return attachStatusBadge({
            kind: UserKind,
            id: member.identity.id || m.sender_ref,
            displayName: member.identity.displayName || m.sender_ref,
            avatar: member.identity.avatar || { image: "", crop: null, color: "", text: "" }
          }, member.identity);
        }
        return resolveContact({ kind: UserKind, ref: m.sender_ref }, ctx);
      }
      if (m.sender_kind === "bot") {
        const member = memberArr.find((mem) => mem.member_kind === "bot" && mem.member_ref === m.sender_ref);
        const rawBot = botRecord(m.sender_ref);
        const localBot = resolveContact({ kind: BotKind, ref: m.sender_ref }, ctx);
        const ownedByMe = Boolean(rawBot);
        const ownAvatarIsHydrated = Boolean(rawBot && hasAvatarIdentityFields?.(rawBot));
        let displayName;
        if (ownedByMe) {
          displayName = rawBot.displayName || rawBot.display_name || rawBot.name || localBot.displayName;
        } else if (member?.identity?.displayName) {
          displayName = member.identity.displayName;
        } else if (member && member.bot_name) {
          displayName = member.bot_name;
        } else {
          const conversationBotKey = conversation.decorations?.botId || conversation.botId || conversation.bot_id || "";
          displayName = conversationBotKey === m.sender_ref && conversation.name
            ? conversation.name
            : m.sender_ref;
        }
        const avatar = (!ownAvatarIsHydrated && member?.identity?.avatar)
          ? member.identity.avatar
          : resolveAvatarForContact({
              id: botAvatarIdentityId(m.sender_ref, rawBot || {}, member || {}),
              displayName,
              avatarImage: ownAvatarIsHydrated ? (rawBot.avatarImage || rawBot.avatar_image) : member?.bot_avatar_image,
              avatarCrop: ownAvatarIsHydrated ? (rawBot.avatarCrop || rawBot.avatar_crop) : member?.bot_avatar_crop,
              color: ownAvatarIsHydrated
                ? (rawBot.color || rawBot.avatarColor || rawBot.avatar_color || "")
                : (member?.identity?.avatar?.color || member?.bot_color || member?.avatarColor || member?.avatar_color || "")
            });
        return attachStatusBadge({
          kind: BotKind,
          id: firstNonEmpty(member?.identity?.id, rawBot?.id, rawBot?.botId, rawBot?.bot_id, m.sender_ref),
          ownerUserId: firstNonEmpty(member?.identity?.ownerUserId, member?.identity?.owner_user_id, rawBot?.ownerUserId, rawBot?.owner_user_id, member?.owner_user_id, member?.owner_id),
          displayName,
          avatar
        }, member?.identity, rawBot);
      }
      if (m.sender_kind === SenderKind.System) {
        return { kind: "system", id: "system", displayName: "系统", avatar: { image: "", crop: null, color: "#888", text: "系统" } };
      }
      return { kind: "", id: "", displayName: m.sender_ref || "", avatar: { image: "", crop: null, color: "#888", text: String(m.sender_ref || "?").slice(0, 2) || "?" } };
    }

    function listMessages() {
      const msgs = Array.isArray(messages) ? messages : [];
      return msgs.map((m, idx) => {
        const author = authorForMessage(m);
        const isOwnUser = m.sender_kind === SenderKind.User && m.sender_ref === selfId;
        const authorIdentity = (author.kind === UserKind || author.kind === BotKind)
          ? {
              kind: author.kind,
              id: author.id,
              ...(author.ownerUserId ? { ownerUserId: author.ownerUserId } : {}),
              displayName: author.displayName,
              avatar: author.avatar,
              ...(hasOwn(author, "statusBadge") ? { statusBadge: author.statusBadge } : {})
            }
          : null;
        const specInput = {
          source: "cloud-conversation",
          conversationId: conversation.id,
          messageId: m.id || `${conversation.id}#${m.seq || idx}`,
          messageIndex: idx,
          role: m.sender_kind === "bot" ? "assistant" : (m.sender_kind === SenderKind.System ? "system" : "user"),
          authorIdentity,
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.body_md || ""),
          createdAt: m.created_at || "",
          attachments: m.attachments_json ? safeJsonArray(m.attachments_json) : (Array.isArray(m.attachments) ? m.attachments : []),
          mentions: m.mentions_json ? safeJsonArray(m.mentions_json) : (Array.isArray(m.mentions) ? m.mentions : []),
          isOwn: isOwnUser,
          isPending: Boolean(m._localPending || m.status === "sending" || m.status === "pending"),
          // delete = WeChat-style local hide (any member may remove a message
          // from their own view); pin has no per-message meaning in a shared conversation.
          capabilities: { reply: true, copy: true, pin: false, delete: true }
        };
        if (hasOwn(author, "statusBadge")) specInput.statusBadge = author.statusBadge;
        return normalizeSpec(specInput);
      });
    }

    // Resolve a raw `@word` mention token (without the leading "@") against
    // this conversation's member list. Returns `{ kind: "bot", botId }` when
    // the token matches a bot member, or `null` otherwise. Consumers must
    // NOT reach into `members` themselves — go through this resolver so the
    // bot membership rule lives in one place.
    function resolveMention(token) {
      if (!token) return null;
      const wanted = String(token || "").trim();
      const bot = memberArr.find((mem) => mem.member_kind === "bot"
        && (mem.member_ref === wanted || mem.bot_name === wanted || mem.identity?.displayName === wanted));
      if (bot) return { kind: "bot", botId: bot.member_ref };
      return null;
    }

    return { kind: "cloud-conversation", id: conversation.id, listMessages, resolveMention };
  }

  global.miaCloudConversationSource = { createCloudConversationSource };
})(typeof window !== "undefined" ? window : globalThis);
