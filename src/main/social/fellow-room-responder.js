"use strict";

const { MemberKind, SenderKind } = require("../../shared/conversation-kinds.js");

const PROCESSED_CAP = 500;

function inferRoomType(room) {
  if (!room) return null;
  if (room.type) return room.type;
  if (String(room.id || "").startsWith("fellow:")) return "fellow";
  return null;
}

function normalizeMessages(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
}

function fellowIdForRoom(room, members, currentUserId) {
  const decorated = room?.decorations?.fellowKey || room?.decorations?.fellowId || room?.fellowKey;
  if (decorated) return String(decorated);
  const fellowMember = (Array.isArray(members) ? members : [])
    .find((member) => member?.member_kind === MemberKind.Fellow && member.owner_id === currentUserId);
  return fellowMember?.member_ref || null;
}

function formatRecentMessages(messages) {
  return normalizeMessages(messages)
    .map((message) => {
      const sender = message.sender_kind === SenderKind.Fellow
        ? `fellow:${message.sender_ref || ""}`
        : `user:${message.sender_ref || ""}`;
      return `[${sender}] ${message.body_md || ""}`;
    })
    .join("\n");
}

function createMainFellowRoomResponder({
  getCurrentUserId,
  getRoomDetails,
  listRecentMessages,
  responder,
  log = () => {}
}) {
  const processed = new Set();

  function markProcessed(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function handleRoomMessageAppended(payload) {
    const { roomId, message } = payload || {};
    if (!roomId || !message?.id) return;
    if (message.sender_kind !== SenderKind.User) return;
    if (processed.has(message.id)) return;

    const currentUserId = getCurrentUserId();
    if (!currentUserId) return;
    if (message.sender_ref && message.sender_ref !== currentUserId) return;

    let details;
    try {
      details = await getRoomDetails(roomId);
    } catch (error) {
      log(`[main-fellow-room-responder] get room failed: ${error?.message || error}`);
      return;
    }

    const room = details?.room || details;
    if (inferRoomType(room) !== "fellow") return;
    const members = Array.isArray(details?.members) ? details.members : [];
    const fellowId = fellowIdForRoom(room, members, currentUserId);
    if (!fellowId) return;
    const ownedMember = members.find((member) =>
      member.member_kind === MemberKind.Fellow
      && member.member_ref === fellowId
      && member.owner_id === currentUserId
    );
    if (members.length && !ownedMember) return;

    markProcessed(message.id);
    const sinceSeq = Math.max(0, Number(message.seq || 0) - 6);
    const recentMessages = normalizeMessages(await listRecentMessages(roomId, sinceSeq, 6));
    await responder.respond({
      roomId,
      fellowId,
      dedupKey: `${message.id}:${fellowId}`,
      systemPrompt: [
        `你是 ${fellowId}，正在和用户进行一对一私聊。`,
        "最近消息上下文：",
        formatRecentMessages(recentMessages)
      ].join("\n"),
      userPrompt: message.body_md || "",
      turnId: message.turn_id || null
    });
  }

  return { handleRoomMessageAppended };
}

module.exports = {
  createMainFellowRoomResponder,
  fellowIdForRoom
};
