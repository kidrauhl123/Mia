(function (global) {
  "use strict";

  function spec() { return global.aimashiMessageSpec || require("../../shared/message-spec"); }
  function contact() { return global.aimashiContact || require("../../shared/contact"); }

  function createLocalGroupSource({ group, messages, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const selfContact = resolveContact({ kind: ContactKind.Self }, ctx);

    function authorForMessage(m) {
      if (m.role === "user") return selfContact;
      if (m.role === "system") {
        return { kind: "system", id: "system", displayName: "系统", avatar: { image: "", crop: null, color: "#888" } };
      }
      const fellowKey = m.senderFellowId || m.fellowId || (group.hostMember && group.hostMember.fellowId);
      return resolveContact({ kind: ContactKind.Fellow, ref: fellowKey }, ctx);
    }

    function listMessages() {
      const msgs = Array.isArray(messages) ? messages : [];
      return msgs.map((m, idx) => {
        const isOwn = m.role === "user";
        const author = authorForMessage(m);
        return normalizeSpec({
          source: "local-group",
          conversationId: group.id,
          messageId: m.id || `${group.id}#${idx}`,
          messageIndex: idx,
          role: m.role,
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.content || m.text || ""),
          createdAt: m.createdAt || "",
          attachments: Array.isArray(m.attachments) ? m.attachments : [],
          mentions: Array.isArray(m.mentions) ? m.mentions : [],
          isOwn,
          capabilities: { reply: true, copy: true, pin: true, delete: true }
        });
      });
    }

    return { kind: "local-group", id: group.id, listMessages };
  }

  global.aimashiLocalGroupSource = { createLocalGroupSource };
})(typeof window !== "undefined" ? window : globalThis);
