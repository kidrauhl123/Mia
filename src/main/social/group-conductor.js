"use strict";

const { MemberKind, SenderKind } = require("../../shared/conversation-kinds.js");
const { EngineId, normalizeAgentEngine } = require("../../shared/engine-contracts.js");
const { buildInvocation } = require("./fellow-invocation.js");

const PROCESSED_CAP = 500;
const SEARCH_INTENT_RE = /(搜|搜索|查一下|查找|找一下|找下|联网|上网|新闻|热点|最新|\bweb\b|\bsearch\b|\bnews\b|\blatest\b|\brecent\b)/iu;

function fillTemplate(template, vars) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ""
  );
}

function formatMembers(members) {
  return members.map((member) => `- ${member.name} (id=${member.id})`).join("\n");
}

function formatMessages(messages, fellowNamesById) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message.sender_kind === SenderKind.User) {
      return `${message.sender_username || message.sender_ref || "用户"}: ${message.body_md || ""}`;
    }
    const name = fellowNamesById[message.sender_ref] || message.sender_ref || "Fellow";
    return `${name}: ${message.body_md || ""}`;
  }).join("\n");
}

function buildDispatchPrompt(template, ctx) {
  return fillTemplate(template, {
    members: formatMembers(ctx.members),
    summary: ctx.summary || "（暂无摘要）",
    recent: formatMessages(ctx.recentMessages, ctx.fellowNamesById),
    userMessage: ctx.userMessage || ""
  });
}

function safeParseJSON(text) {
  if (!text || typeof text !== "string") return null;
  try {
    const match = text.match(/\{[^}]*"speak"[^}]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

function inferRoomType(room) {
  if (!room) return null;
  if (room.type) return room.type;
  if (room.id?.startsWith("dm:")) return "dm";
  if (room.id?.startsWith("fellow:")) return "fellow";
  if (room.id?.startsWith("g_") || room.id?.startsWith("g-")) return "group";
  return null;
}

function responseModeFor(room) {
  return room?.decorations?.responseMode === "mentions-only" ? "mentions-only" : "conductor";
}

function hostFellowIdFor(room, ownFellowMembers) {
  const explicit = room?.decorations?.hostMember || room?.hostMember;
  if (explicit && explicit.kind === MemberKind.Fellow && explicit.fellowId) return explicit.fellowId;
  return ownFellowMembers[0]?.member_ref || null;
}

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

function messageHasMentions(message) {
  return parseJsonArray(message?.mentions).length > 0 || parseJsonArray(message?.mentions_json).length > 0;
}

function normalizeMessages(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
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

function fellowHasSearchCapability(fellow) {
  if (!fellow) return false;
  if (fellow.canSearch || fellow.webSearchEnabled || fellow.searchEnabled) return true;
  const capabilities = Array.isArray(fellow.capabilities) ? fellow.capabilities : [];
  if (capabilities.some((capability) => /search|web|internet/i.test(String(capability || "")))) return true;
  const engine = fellow.agentEngine || fellow.agent_engine || fellow.engine || fellow.engineConfig?.agentEngine;
  return normalizeAgentEngine(engine) === EngineId.Codex;
}

function textNamesOwnedFellow(text, ownFellowMembers, fellows) {
  const haystack = normalizeComparable(text);
  if (!haystack) return null;
  for (const member of ownFellowMembers) {
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
  if (fellowMembers.length === 1 && ownFellowMembers.length === 1) {
    return [ownFellowMembers[0].member_ref];
  }
  const text = message?.body_md || "";
  const searchFellowId = searchCapableOwnedFellowId(text, ownFellowMembers, fellows);
  if (searchFellowId) return [searchFellowId];
  const namedFellowId = textNamesOwnedFellow(text, ownFellowMembers, fellows);
  return namedFellowId ? [namedFellowId] : [];
}

function createMainGroupConductor({
  getCurrentUserId,
  listFellows,
  loadPrompts,
  getRoomDetails,
  listRecentMessages,
  sendChatStateless,
  responder,
  log = () => {}
}) {
  const processed = new Set();

  function markProcessed(messageId) {
    processed.add(messageId);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function handleRoomMessageAppended(payload) {
    const { roomId, message } = payload || {};
    if (!roomId || !message?.id) return;
    if (message.sender_kind !== SenderKind.User) return;
    if (messageHasMentions(message)) return;
    if (processed.has(message.id)) return;

    const userId = getCurrentUserId();
    if (!userId) return;

    let details;
    try {
      details = await getRoomDetails(roomId);
    } catch (error) {
      log(`[main-group-conductor] get room failed: ${error?.message || error}`);
      return;
    }
    const room = details?.room || details;
    if (inferRoomType(room) !== "group") return;
    if (responseModeFor(room) !== "conductor") return;

    const members = Array.isArray(details?.members) ? details.members : [];
    const fellowMembers = members.filter((member) => member.member_kind === MemberKind.Fellow);
    const ownFellowMembers = fellowMembers.filter((member) => member.owner_id === userId);
    if (!ownFellowMembers.length) return;

    const hostFellowId = hostFellowIdFor(room, ownFellowMembers);
    const hostMember = fellowMembers.find((member) => member.member_ref === hostFellowId);
    if (!hostMember || hostMember.owner_id !== userId) return;

    markProcessed(message.id);

    const fellowList = listFellows();
    const fellows = Array.isArray(fellowList) ? fellowList : [];
    const fellowNamesById = {};
    const memberDescriptors = fellowMembers.map((member) => {
      const fellow = fellowForMember(member, fellows);
      const name = fellow?.name || member.fellow_name || member.member_ref;
      fellowNamesById[member.member_ref] = name;
      return { id: member.member_ref, name };
    });
    const sinceSeq = Math.max(0, Number(message.seq || 0) - 6);
    const recentMessages = normalizeMessages(await listRecentMessages(roomId, sinceSeq, 6));

    const respondToChosen = async (chosen) => {
      for (const fellowId of chosen) {
        const member = fellowMembers.find((item) => item.member_ref === fellowId);
        if (!member || member.owner_id !== userId) continue;
        const args = buildInvocation({
          roomId,
          fellowId,
          invokedBy: { username: "conductor" },
          triggeringMessage: message,
          recentMessages
        }, fellows);
        if (args) await responder.respond(args);
      }
    };

    const directChosen = directFellowIdsForMessage(message, fellowMembers, ownFellowMembers, fellows);
    if (directChosen.length) {
      await respondToChosen(directChosen);
      return;
    }

    let prompts;
    try {
      prompts = await loadPrompts();
    } catch (error) {
      log(`[main-group-conductor] load prompts failed: ${error?.message || error}`);
      return;
    }
    if (!prompts?.dispatch) return;

    const dispatchPrompt = buildDispatchPrompt(prompts.dispatch, {
      members: memberDescriptors,
      summary: room.contextCard?.summary || room.decorations?.pinnedGoal || null,
      recentMessages,
      fellowNamesById,
      userMessage: message.body_md || ""
    });

    let raw = "";
    try {
      const result = await sendChatStateless({
        fellowKey: hostFellowId,
        systemPrompt: "你是群聊调度器，无人设。",
        userPrompt: dispatchPrompt
      });
      raw = result && typeof result.content === "string" ? result.content : "";
    } catch (error) {
      log(`[main-group-conductor] dispatch failed: ${error?.message || error}`);
      return;
    }

    const parsed = safeParseJSON(raw);
    const suggested = Array.isArray(parsed?.speak) ? parsed.speak : [];
    const chosen = suggested.length ? suggested : [hostFellowId];
    await respondToChosen(chosen);
  }

  return { handleRoomMessageAppended };
}

module.exports = {
  createMainGroupConductor,
  buildDispatchPrompt,
  messageHasMentions
};
