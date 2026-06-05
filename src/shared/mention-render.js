// Highlight "@name" tokens in a rendered message body. ONE source of truth
// for what counts as a mention in a chat bubble — the desktop renderer, the
// web app, and any future surface walk the same regex + member-resolution
// rules already used by send-pipeline.parseMentions, so what you typed and
// what you see in the bubble line up.
//
// Inputs:
//   html    — already-rendered (markdown) HTML for the message body.
//   members — array of conversation members in any of the shapes used
//             elsewhere ({ kind|member_kind, ref|member_ref|botId|id,
//             name|displayName|bot_name|username }).
//
// Output: same HTML with text-region @tokens that match a member wrapped in
//   <span class="mention" data-member-kind="..." data-member-ref="...">@name</span>
// Tokens inside <pre>, <code>, <a>, or existing <span class="mention"> are
// left untouched so code samples and link text do not get re-wrapped.

(function attachMentionRender(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaMentionRender = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildMentionRender() {
  "use strict";

  const MENTION_TOKEN_REGEX = /(\\@|@([A-Za-z0-9_.\-一-龥぀-ヿ]+))/g;
  const SKIP_TAG_REGEX = /<(pre|code|a)\b[^>]*>[\s\S]*?<\/\1>|<span\b[^>]*class="[^"]*\bmention\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function memberRef(member) {
    return member?.ref || member?.member_ref || member?.botId || member?.bot_id || member?.id || member?.key || "";
  }

  function memberName(member) {
    return member?.name || member?.displayName || member?.bot_name || member?.username || memberRef(member) || "";
  }

  function memberKind(member) {
    return member?.kind || member?.member_kind || "bot";
  }

  function buildLookup(members) {
    const byRef = new Map();
    const byNameLower = new Map();
    const list = Array.isArray(members) ? members : [];
    for (const m of list) {
      if (!m) continue;
      const ref = memberRef(m);
      const name = memberName(m);
      const kind = memberKind(m);
      if (ref && !byRef.has(ref)) byRef.set(ref, { kind, ref, name });
      if (name) {
        const lower = name.toLowerCase();
        if (!byNameLower.has(lower)) byNameLower.set(lower, { kind, ref: ref || name, name });
      }
    }
    return { byRef, byNameLower };
  }

  function highlightInSegment(segment, lookup) {
    const re = new RegExp(MENTION_TOKEN_REGEX.source, MENTION_TOKEN_REGEX.flags);
    return segment.replace(re, (full, _capture, token) => {
      if (full === "\\@") return full;
      if (!token) return full;
      const hit = lookup.byRef.get(token) || lookup.byNameLower.get(token.toLowerCase());
      if (!hit) return full;
      const displayName = hit.name || hit.ref;
      return `<span class="mention" data-member-kind="${escapeHtml(hit.kind)}" data-member-ref="${escapeHtml(hit.ref)}">@${escapeHtml(displayName)}</span>`;
    });
  }

  function highlightMentions(html, members) {
    const lookup = buildLookup(members);
    if (!lookup.byRef.size && !lookup.byNameLower.size) return String(html ?? "");
    const source = String(html ?? "");
    const out = [];
    let lastIndex = 0;
    const skip = new RegExp(SKIP_TAG_REGEX.source, SKIP_TAG_REGEX.flags);
    let match;
    while ((match = skip.exec(source)) !== null) {
      out.push(highlightInSegment(source.slice(lastIndex, match.index), lookup));
      out.push(match[0]);
      lastIndex = match.index + match[0].length;
    }
    out.push(highlightInSegment(source.slice(lastIndex), lookup));
    return out.join("");
  }

  return { highlightMentions };
});
