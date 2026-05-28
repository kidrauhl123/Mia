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
      : { MemberKind: { Fellow: "fellow", User: "user" }, SenderKind: { Fellow: "fellow", User: "user", System: "system" } });

  function safeJsonArray(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

  function createCloudConversationSource({ conversation, messages, members, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const { resolveAvatarForContact } = avatarResolve();
    const selfId = ctx.self?.id || "";
    const memberArr = Array.isArray(members) ? members : [];

    function authorForMessage(m) {
      if (m.sender_kind === SenderKind.User) {
        if (m.sender_ref === selfId) return resolveContact({ kind: ContactKind.Self }, ctx);
        return resolveContact({ kind: ContactKind.User, ref: m.sender_ref }, ctx);
      }
      if (m.sender_kind === SenderKind.Fellow) {
        const member = memberArr.find((mem) => mem.member_kind === MemberKind.Fellow && mem.member_ref === m.sender_ref);
        // displayName priority: own fellow registry → server-enriched
        // fellow_name on member row → conversation name (for a 1:1 fellow
        // chat that hasn't been auto-titled) → raw sender_ref. Owner
        // attribution intentionally omitted — UX showed it as
        // "(${ownerUsername})" before but users found it noisy ("不要括号
        // 展示其主人"). If we need owner context later it belongs in the
        // contact card, not the message label.
        const localFellow = resolveContact({ kind: ContactKind.Fellow, ref: m.sender_ref }, ctx);
        const ownedByMe = Boolean(localFellow.displayName && localFellow.displayName !== m.sender_ref);
        let displayName;
        if (ownedByMe) {
          displayName = localFellow.displayName;
        } else if (member && member.fellow_name) {
          displayName = member.fellow_name;
        } else {
          const conversationFellowKey = conversation.decorations?.fellowKey
            || (String(conversation.id || "").startsWith("fellow:")
              ? String(conversation.id || "").split(":").slice(2).join(":")
              : "");
          displayName = conversationFellowKey === m.sender_ref && conversation.name
            ? conversation.name
            : m.sender_ref;
        }
        // Avatar priority mirrors displayName: own fellow first, then
        // server-enriched member row, then identity-deterministic preset
        // from the shared resolver. Color is always hashed from the id by
        // the resolver — there is no per-fellow stored color.
        const avatar = resolveAvatarForContact({
          id: m.sender_ref,
          avatarImage: (ownedByMe && localFellow.avatar?.image) || member?.fellow_avatar_image,
          avatarCrop: (ownedByMe && localFellow.avatar?.crop) || member?.fellow_avatar_crop
        });
        return {
          kind: ContactKind.Fellow,
          id: m.sender_ref,
          displayName,
          avatar
        };
      }
      if (m.sender_kind === SenderKind.System) {
        return { kind: "system", id: "system", displayName: "系统", avatar: { image: "", crop: null, color: "#888" } };
      }
      return { kind: "", id: "", displayName: m.sender_ref || "", avatar: { image: "", crop: null, color: "#888" } };
    }

    function listMessages() {
      const msgs = Array.isArray(messages) ? messages : [];
      return msgs.map((m, idx) => {
        const author = authorForMessage(m);
        const isOwnUser = m.sender_kind === SenderKind.User && m.sender_ref === selfId;
        return normalizeSpec({
          source: "cloud-conversation",
          conversationId: conversation.id,
          messageId: m.id || `${conversation.id}#${m.seq || idx}`,
          messageIndex: idx,
          role: m.sender_kind === SenderKind.Fellow ? "assistant" : (m.sender_kind === SenderKind.System ? "system" : "user"),
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
        });
      });
    }

    // Resolve a raw `@word` mention token (without the leading "@") against
    // this conversation's member list. Returns `{ kind: "fellow", fellowId }` when
    // the token matches a fellow member, or `null` otherwise. Consumers must
    // NOT reach into `members` themselves — go through this resolver so the
    // fellow membership rule lives in one place.
    function resolveMention(token) {
      if (!token) return null;
      const fellow = memberArr.find((mem) => mem.member_kind === MemberKind.Fellow && mem.member_ref === token);
      if (fellow) return { kind: ContactKind.Fellow, fellowId: token };
      return null;
    }

    return { kind: "cloud-conversation", id: conversation.id, listMessages, resolveMention };
  }

  global.miaCloudConversationSource = { createCloudConversationSource };
})(typeof window !== "undefined" ? window : globalThis);
