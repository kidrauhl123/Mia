(function (global) {
  "use strict";

  function spec() {
    return global.miaMessageSpec || require("../../shared/message-spec");
  }
  function contact() {
    return global.miaContact || require("../../shared/contact");
  }

  function createBotSessionSource({ session, persona, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, IdentityKind } = contact();
    const botContact = resolveContact({ kind: IdentityKind.Bot, ref: persona.id || persona.key }, ctx);
    const selfContact = resolveContact({ kind: "self" }, ctx);

    function listMessages() {
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      return msgs.map((m, idx) => {
        const isUser = m.role === "user";
        const author = isUser ? selfContact : botContact;
        return normalizeSpec({
          source: "bot-session",
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

    return { kind: "bot-session", id: session.id, listMessages };
  }

  global.miaBotSessionSource = { createBotSessionSource };
})(typeof window !== "undefined" ? window : globalThis);
