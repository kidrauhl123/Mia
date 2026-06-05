(function attachSendPipeline(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaSendPipeline = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildSendPipeline() {
  const MemberKind = Object.freeze({ Bot: "bot", User: "user" });
  const DEFAULT_MAX_LENGTH = 8000;
  const MENTION_REGEX = /(\\@|@([A-Za-z0-9_.\-一-龥぀-ヿ]+))/g;

  function generateClientTraceId() {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function parseMentions(text, members) {
    const list = Array.isArray(members) ? members : [];
    if (!list.length) return [];
    const byRef = new Map();
    const byNameLower = new Map();
    for (const m of list) {
      if (!m) continue;
      const ref = m.ref || m.member_ref || m.botId || m.bot_id || m.fellowId || m.id || m.key || "";
      const name = m.name || m.displayName || m.username || "";
      const rawKind = m.kind || m.member_kind || MemberKind.Bot;
      const kind = rawKind === "fellow" ? MemberKind.Bot : rawKind;
      if (ref && !byRef.has(ref)) byRef.set(ref, { kind, ref });
      if (name) {
        const lower = name.toLowerCase();
        if (!byNameLower.has(lower)) byNameLower.set(lower, { kind, ref: ref || name });
      }
    }

    const out = [];
    const seen = new Set();
    const re = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[1] === "\\@") continue;
      const token = match[2];
      if (!token) continue;
      let hit = byRef.get(token);
      if (!hit) hit = byNameLower.get(token.toLowerCase());
      if (!hit) continue;
      const dedupKey = `${hit.kind}:${hit.ref}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      out.push({ kind: hit.kind, ref: hit.ref });
    }
    return out;
  }

  function prepareOutgoingMessage(rawInput, ctx) {
    const input = rawInput || {};
    const ctxObj = ctx || {};
    const rawText = typeof input.text === "string" ? input.text : "";
    const bodyMd = rawText.trim();
    const attachments = Array.isArray(input.attachments) ? input.attachments.slice() : [];

    if (!bodyMd && !attachments.length) {
      const err = new Error("send-pipeline: empty message (no text and no attachments)");
      err.code = "EMPTY_MESSAGE";
      throw err;
    }

    const maxLength = typeof ctxObj.maxLength === "number" && ctxObj.maxLength > 0
      ? ctxObj.maxLength
      : DEFAULT_MAX_LENGTH;
    if (bodyMd.length > maxLength) {
      const err = new Error(`send-pipeline: message exceeds ${maxLength} chars (got ${bodyMd.length})`);
      err.code = "MESSAGE_TOO_LONG";
      throw err;
    }

    const result = {
      bodyMd,
      mentions: bodyMd ? parseMentions(bodyMd, ctxObj.members) : [],
      attachments,
      clientTraceId: generateClientTraceId()
    };
    if (input.replyTo) result.replyTo = input.replyTo;
    return result;
  }

  return {
    prepareOutgoingMessage,
    parseMentions,
    generateClientTraceId,
    MemberKind,
    DEFAULT_MAX_LENGTH
  };
});
