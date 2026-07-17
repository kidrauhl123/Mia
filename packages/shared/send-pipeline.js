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

  function clientOpIdForTraceId(traceId) {
    const trace = String(traceId || "").trim();
    return trace ? `op_${trace}` : "";
  }

  function memberDisplayName(member) {
    const m = member && typeof member === "object" ? member : {};
    const identity = m.identity && typeof m.identity === "object" ? m.identity : {};
    const user = m.user && typeof m.user === "object" ? m.user : {};
    return m.name
      || m.bot_name
      || m.displayName
      || m.display_name
      || m.username
      || identity.displayName
      || identity.display_name
      || identity.name
      || user.displayName
      || user.display_name
      || user.username
      || "";
  }

  function parseMentions(text, members) {
    const list = Array.isArray(members) ? members : [];
    if (!list.length) return [];
    const byRef = new Map();
    const byNameLower = new Map();
    for (const m of list) {
      if (!m) continue;
      const identity = m.identity && typeof m.identity === "object" ? m.identity : {};
      const name = memberDisplayName(m);
      const kind = m.kind || m.member_kind || identity.kind || "";
      if (kind !== MemberKind.Bot && kind !== MemberKind.User) continue;
      const ref = kind === MemberKind.Bot
        ? (m.ref || m.member_ref || m.botId || m.bot_id || m.id || identity.id || "")
        : (m.ref || m.member_ref || m.userId || m.user_id || m.id || identity.id || "");
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

    const clientTraceId = generateClientTraceId();
    const result = {
      bodyMd,
      mentions: bodyMd ? parseMentions(bodyMd, ctxObj.members) : [],
      attachments,
      clientTraceId,
      clientOpId: clientOpIdForTraceId(clientTraceId)
    };
    if (input.replyTo) result.replyTo = input.replyTo;
    return result;
  }

  return {
    prepareOutgoingMessage,
    parseMentions,
    generateClientTraceId,
    clientOpIdForTraceId,
    MemberKind,
    DEFAULT_MAX_LENGTH
  };
});
