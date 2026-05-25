"use strict";

const PROCESSED_CAP = 500;

function shouldHandleLocalCloudRoomAi({ isDaemon, daemonEnabled }) {
  return Boolean(isDaemon) || !daemonEnabled;
}

function clientOpIdForDedupKey(dedupKey) {
  const safe = String(dedupKey || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return `op_fellow_reply_${safe || "unknown"}`;
}

function responseText(result) {
  const message = result?.choices?.[0]?.message || result?.message || {};
  return String(message.content || result?.content || "").trim();
}

function createLocalFellowResponder({ sendChat, postRoomMessageAsFellow, log = () => {} }) {
  const processed = new Set();

  function remember(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function respond({ roomId, fellowId, dedupKey, systemPrompt, userPrompt, turnId = null }) {
    if (!roomId || !fellowId || !dedupKey) return;
    if (processed.has(dedupKey)) return;
    remember(dedupKey);

    let text = "";
    try {
      const result = await sendChat({
        fellowKey: fellowId,
        personaKey: fellowId,
        sessionId: `room:${roomId}`,
        messages: [
          { role: "system", content: systemPrompt || "" },
          { role: "user", content: userPrompt || "" }
        ],
        group: true,
        utility: true
      });
      text = responseText(result);
    } catch (error) {
      log(`[local-fellow-responder] engine failed: ${error?.message || error}`);
      return;
    }
    if (!text) return;

    try {
      await postRoomMessageAsFellow(roomId, {
        fellowId,
        bodyMd: text,
        turnId,
        clientOpId: clientOpIdForDedupKey(dedupKey)
      });
    } catch (error) {
      log(`[local-fellow-responder] post failed: ${error?.message || error}`);
    }
  }

  return { respond };
}

module.exports = {
  clientOpIdForDedupKey,
  createLocalFellowResponder,
  responseText,
  shouldHandleLocalCloudRoomAi
};
