(function (global) {
  "use strict";

  function spec() { return global.miaMessageSpec || require("../../shared/message-spec"); }
  function contact() { return global.miaContact || require("../../shared/contact"); }
  const { MemberKind, SenderKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../../shared/conversation-kinds");

  function safeJsonArray(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

  function createCloudConversationSource({ conversation, messages, members, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const selfId = ctx.self?.id || "";
    const memberArr = Array.isArray(members) ? members : [];

    function fallbackFellowAvatar(fellowId, color = "#5e5ce6") {
      const image = typeof ctx.avatarAssetForKey === "function" ? ctx.avatarAssetForKey(fellowId) : "";
      return { image, crop: null, color };
    }

    function authorForMessage(m) {
      if (m.sender_kind === SenderKind.User) {
        if (m.sender_ref === selfId) return resolveContact({ kind: ContactKind.Self }, ctx);
        return resolveContact({ kind: ContactKind.User, ref: m.sender_ref }, ctx);
      }
      if (m.sender_kind === SenderKind.Fellow) {
        const member = memberArr.find((mem) => mem.member_kind === MemberKind.Fellow && mem.member_ref === m.sender_ref);
        // Resolution priority for fellow display name + avatar:
        //   1. local fellow registry (if I own this fellow)
        //   2. server-enriched fellow_name / fellow_avatar_image on the
        //      member row (covers cross-owner fellows uniformly)
        //   3. raw sender_ref as last resort
        // Owner attribution intentionally omitted — UX showed it as
        // "(${ownerUsername})" before but users found it noisy ("不要括号
        // 展示其主人"). If we need owner context later it belongs in the
        // contact card, not the message label.
        const localFellow = resolveContact({ kind: ContactKind.Fellow, ref: m.sender_ref }, ctx);
        let displayName = "";
        let avatar = fallbackFellowAvatar(m.sender_ref);
        if (localFellow.displayName && localFellow.displayName !== m.sender_ref) {
          displayName = localFellow.displayName;
          avatar = localFellow.avatar?.image
            ? localFellow.avatar
            : fallbackFellowAvatar(m.sender_ref, localFellow.avatar?.color || avatar.color);
        } else if (member && member.fellow_name) {
          displayName = member.fellow_name;
          if (member.fellow_avatar_image) {
            avatar = {
              image: member.fellow_avatar_image,
              crop: member.fellow_avatar_crop || null,
              color: member.fellow_color || "#5e5ce6"
            };
          } else {
            avatar = fallbackFellowAvatar(m.sender_ref, member.fellow_color || avatar.color);
          }
        } else {
          const conversationFellowKey = conversation.decorations?.fellowKey || (String(conversation.id || "").startsWith("fellow:") ? String(conversation.id || "").split(":").slice(2).join(":") : "");
          displayName = conversationFellowKey === m.sender_ref && conversation.name ? conversation.name : m.sender_ref;
        }
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
