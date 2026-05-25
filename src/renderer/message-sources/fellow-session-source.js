(function (global) {
  "use strict";

  function spec() {
    return global.miaMessageSpec || require("../../shared/message-spec");
  }
  function contact() {
    return global.miaContact || require("../../shared/contact");
  }

  function createFellowSessionSource({ session, persona, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const fellowContact = resolveContact({ kind: ContactKind.Fellow, ref: persona.key || persona.id }, ctx);
    const selfContact = resolveContact({ kind: ContactKind.Self }, ctx);

    function listMessages() {
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      return msgs.map((m, idx) => {
        const isUser = m.role === "user";
        const author = isUser ? selfContact : fellowContact;
        return normalizeSpec({
          source: "fellow-session",
          conversationId: session.id,
          messageId: m.id || `${session.id}#${idx}`,
          messageIndex: idx,
          role: m.role,
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.content || m.text || ""),
          createdAt: m.createdAt || "",
          attachments: Array.isArray(m.attachments) ? m.attachments : [],
          isOwn: isUser,
          capabilities: { reply: true, copy: true, pin: true, delete: true }
        });
      });
    }

    return { kind: "fellow-session", id: session.id, listMessages };
  }

  global.miaFellowSessionSource = { createFellowSessionSource };
})(typeof window !== "undefined" ? window : globalThis);
