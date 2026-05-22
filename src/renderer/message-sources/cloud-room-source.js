(function (global) {
  "use strict";

  function spec() { return global.aimashiMessageSpec || require("../../shared/message-spec"); }
  function contact() { return global.aimashiContact || require("../../shared/contact"); }

  function safeJsonArray(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

  function createCloudRoomSource({ room, messages, members, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const selfId = ctx.self?.id || "";
    const memberArr = Array.isArray(members) ? members : [];

    function authorForMessage(m) {
      if (m.sender_kind === "user") {
        if (m.sender_ref === selfId) return resolveContact({ kind: ContactKind.Self }, ctx);
        return resolveContact({ kind: ContactKind.User, ref: m.sender_ref }, ctx);
      }
      if (m.sender_kind === "fellow") {
        const member = memberArr.find((mem) => mem.member_kind === "fellow" && mem.member_ref === m.sender_ref);
        const ownerLabel = member ? (member.owner?.username || member.owner_username) : "";
        let owner = ownerLabel;
        if (!owner && member?.owner_id) {
          const friend = (ctx.friends || []).find((f) => f.id === member.owner_id);
          if (friend) owner = friend.username || friend.account || "";
          if (!owner && selfId === member.owner_id) owner = ctx.self?.username || "";
        }
        // If this fellow belongs to me, hydrate its avatar from my local
        // fellow registry so it renders identically to the same fellow
        // in fellow-private and local-group views.
        let avatar = { image: "", crop: null, color: "#5e5ce6" };
        if (member?.owner_id === selfId) {
          const localFellow = resolveContact({ kind: ContactKind.Fellow, ref: m.sender_ref }, ctx);
          if (localFellow.avatar?.image) avatar = localFellow.avatar;
        }
        const displayName = owner ? `${m.sender_ref} (${owner})` : m.sender_ref;
        return {
          kind: ContactKind.Fellow,
          id: m.sender_ref,
          displayName,
          avatar
        };
      }
      if (m.sender_kind === "system") {
        return { kind: "system", id: "system", displayName: "系统", avatar: { image: "", crop: null, color: "#888" } };
      }
      return { kind: "", id: "", displayName: m.sender_ref || "", avatar: { image: "", crop: null, color: "#888" } };
    }

    function listMessages() {
      const msgs = Array.isArray(messages) ? messages : [];
      return msgs.map((m, idx) => {
        const author = authorForMessage(m);
        const isOwnUser = m.sender_kind === "user" && m.sender_ref === selfId;
        return normalizeSpec({
          source: "cloud-room",
          conversationId: room.id,
          messageId: m.id || `${room.id}#${m.seq || idx}`,
          messageIndex: idx,
          role: m.sender_kind === "fellow" ? "assistant" : (m.sender_kind === "system" ? "system" : "user"),
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.body_md || ""),
          createdAt: m.created_at || "",
          attachments: m.attachments_json ? safeJsonArray(m.attachments_json) : (Array.isArray(m.attachments) ? m.attachments : []),
          mentions: m.mentions_json ? safeJsonArray(m.mentions_json) : (Array.isArray(m.mentions) ? m.mentions : []),
          isOwn: isOwnUser,
          capabilities: { reply: true, copy: true, pin: false, delete: false }
        });
      });
    }

    return { kind: "cloud-room", id: room.id, listMessages };
  }

  global.aimashiCloudRoomSource = { createCloudRoomSource };
})(typeof window !== "undefined" ? window : globalThis);
