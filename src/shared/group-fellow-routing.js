"use strict";

const { MemberKind, SenderKind } = require("./conversation-kinds.js");
const { EngineId, normalizeAgentEngine } = require("./engine-contracts.js");

const SEARCH_INTENT_RE = /(搜|搜索|查一下|查找|找一下|找下|联网|上网|新闻|热点|最新|\bweb\b|\bsearch\b|\bnews\b|\blatest\b|\brecent\b)/iu;
const DEFAULT_DISPATCH_PROMPT = [
  "你正在协调一个多 Fellow 群聊。你的任务：根据最近的群上下文，决定接下来该让哪个或哪几个 Fellow 发言。",
  "",
  "群成员（不含用户自己）：",
  "{{members}}",
  "",
  "群摘要：",
  "{{summary}}",
  "",
  "最近 6 条消息：",
  "{{recent}}",
  "",
  "用户刚发了：",
  "{{userMessage}}",
  "",
  "输出 JSON，仅一行，格式：",
  "{\"speak\": [\"<fellowId>\", ...]}",
  "- 选 0 到 3 个 fellowId",
  "- 选 0 个表示\"暂时没人发言合适\"",
  "- 不要解释，只输出 JSON"
].join("\n");

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageHasMentions(message = {}) {
  return parseJsonArray(message.mentions).length > 0 || parseJsonArray(message.mentions_json).length > 0;
}

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

function fellowForMember(member, fellows) {
  const ref = member?.member_ref;
  return (Array.isArray(fellows) ? fellows : [])
    .find((item) => item?.id === ref || item?.key === ref) || null;
}

function messageAsksForSearch(text) {
  return SEARCH_INTENT_RE.test(String(text || ""));
}

function capabilitySignalsSearch(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(capabilitySignalsSearch);
  if (typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => {
      const keyLooksSearch = /search|web|internet/i.test(String(key || ""));
      if (keyLooksSearch && nested !== false && nested != null) return true;
      return capabilitySignalsSearch(nested);
    });
  }
  return /search|web|internet/i.test(String(value || ""));
}

function fellowHasSearchCapability(fellow) {
  if (!fellow) return false;
  if (fellow.canSearch || fellow.webSearchEnabled || fellow.searchEnabled) return true;
  if (capabilitySignalsSearch(fellow.capabilities)) return true;
  const engine = fellow.agentEngine || fellow.agent_engine || fellow.engine || fellow.engineConfig?.agentEngine;
  return normalizeAgentEngine(engine) === EngineId.Codex;
}

function textNamesOwnedFellow(text, ownFellowMembers, fellows) {
  const haystack = normalizeComparable(text);
  if (!haystack) return null;
  for (const member of Array.isArray(ownFellowMembers) ? ownFellowMembers : []) {
    const fellow = fellowForMember(member, fellows);
    const candidates = [
      member.member_ref,
      member.fellow_name,
      fellow?.name,
      fellow?.id,
      fellow?.key
    ];
    const matched = candidates.some((candidate) => {
      const needle = normalizeComparable(candidate);
      return needle.length >= 2 && haystack.includes(needle);
    });
    if (matched) return member.member_ref;
  }
  return null;
}

function searchCapableOwnedFellowId(text, ownFellowMembers, fellows) {
  if (!messageAsksForSearch(text)) return null;
  const namedFellowId = textNamesOwnedFellow(text, ownFellowMembers, fellows);
  if (namedFellowId) {
    const namedMember = ownFellowMembers.find((member) => member.member_ref === namedFellowId);
    if (fellowHasSearchCapability(fellowForMember(namedMember, fellows))) return namedFellowId;
  }
  const capableMember = ownFellowMembers.find((member) =>
    fellowHasSearchCapability(fellowForMember(member, fellows))
  );
  return capableMember?.member_ref || null;
}

function directFellowIdsForMessage(message, fellowMembers, ownFellowMembers, fellows) {
  const allFellowMembers = Array.isArray(fellowMembers) ? fellowMembers : [];
  const ownedMembers = Array.isArray(ownFellowMembers) ? ownFellowMembers : [];
  if (allFellowMembers.length === 1 && ownedMembers.length === 1) {
    return [ownedMembers[0].member_ref];
  }
  const text = message?.body_md || "";
  const searchFellowId = searchCapableOwnedFellowId(text, ownedMembers, fellows);
  if (searchFellowId) return [searchFellowId];
  const namedFellowId = textNamesOwnedFellow(text, ownedMembers, fellows);
  return namedFellowId ? [namedFellowId] : [];
}

function fillTemplate(template, vars) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ""
  );
}

function formatDispatchMembers(members) {
  return members.map((member) => `- ${member.name} (id=${member.id})`).join("\n");
}

function formatDispatchMessages(messages, fellowNamesById = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message.sender_kind === SenderKind.User) {
      return `${message.sender_username || message.sender_ref || "用户"}: ${message.body_md || ""}`;
    }
    const name = fellowNamesById[message.sender_ref] || message.sender_ref || "Fellow";
    return `${name}: ${message.body_md || ""}`;
  }).join("\n");
}

function buildDispatchPrompt(template, ctx) {
  return fillTemplate(template || DEFAULT_DISPATCH_PROMPT, {
    members: formatDispatchMembers(ctx.members || []),
    summary: ctx.summary || "（暂无摘要）",
    recent: formatDispatchMessages(ctx.recentMessages, ctx.fellowNamesById || {}),
    userMessage: ctx.userMessage || ""
  });
}

function parseDispatchSpeak(text) {
  if (!text || typeof text !== "string") return [];
  try {
    const match = text.match(/\{[^}]*"speak"[^}]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    return Array.isArray(parsed?.speak)
      ? parsed.speak.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function hostFellowIdFor(conversation, ownFellowMembers, fellowMembers = []) {
  const explicit = conversation?.decorations?.hostMember || conversation?.hostMember;
  if (explicit && explicit.kind === MemberKind.Fellow && explicit.fellowId) return explicit.fellowId;
  if (fellowMembers.some((member) => !ownFellowMembers.includes(member))) return null;
  return ownFellowMembers[0]?.member_ref || null;
}

module.exports = {
  DEFAULT_DISPATCH_PROMPT,
  buildDispatchPrompt,
  directFellowIdsForMessage,
  fellowForMember,
  fellowHasSearchCapability,
  hostFellowIdFor,
  messageHasMentions,
  parseDispatchSpeak,
  searchCapableOwnedFellowId,
  textNamesOwnedFellow
};
