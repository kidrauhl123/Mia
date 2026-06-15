"use strict";

// Expo push delivery for Mia mobile.
//
// The cloud sends a notification to a user's registered device tokens when a
// chat message arrives while that user has no live event socket (app closed, or
// backgrounded long enough that the WebSocket dropped). Foreground delivery is
// handled live over the socket, so push is purely the offline complement — we
// never push to a user who is currently connected.
//
// Expo's push service fans out to FCM (Android) / APNs (iOS) for us, so the
// server never holds raw FCM/APNs credentials; those are uploaded once to the
// Expo project (`eas credentials`). A missed push must never break the
// message-send request that triggered it, so every failure here is swallowed.
//
// Docs: https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
// Expo accepts at most 100 messages per request.
const EXPO_BATCH_SIZE = 100;

function isExpoPushToken(token) {
  return typeof token === "string" && EXPO_TOKEN_RE.test(token.trim());
}

// Build one Expo push message for a chat event. `title`/`body` are already
// resolved by the caller (sender label, group name, message text). `data`
// rides along so a tap can deep-link straight to the conversation.
function buildChatPushMessage(token, { title, body, conversationId = "", data = {} } = {}) {
  const text = String(body || "").trim();
  return {
    to: token,
    title: String(title || "Mia").slice(0, 100),
    // Expo truncates long bodies anyway; cap so one message can't bloat a batch.
    body: (text || "[附件]").slice(0, 178),
    sound: "default",
    channelId: "messages",
    priority: "high",
    data: { conversationId, ...data },
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// POST messages to Expo in batches. Returns the tokens Expo reported as
// DeviceNotRegistered so the caller can prune them. Errors are logged, not
// thrown.
async function sendExpoPushMessages(messages, { fetchImpl = fetch, log = () => {} } = {}) {
  const valid = (messages || []).filter((m) => m && isExpoPushToken(m.to));
  const invalidTokens = new Set();
  for (const batch of chunk(valid, EXPO_BATCH_SIZE)) {
    let json;
    try {
      const res = await fetchImpl(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(batch),
      });
      json = await res.json();
    } catch (err) {
      log("expo push request failed", err?.message);
      continue;
    }
    const tickets = Array.isArray(json?.data) ? json.data : [];
    tickets.forEach((ticket, i) => {
      if (ticket?.status === "error" && ticket?.details?.error === "DeviceNotRegistered") {
        invalidTokens.add(batch[i].to);
      }
    });
  }
  return { invalidTokens: [...invalidTokens] };
}

module.exports = {
  EXPO_PUSH_ENDPOINT,
  isExpoPushToken,
  buildChatPushMessage,
  sendExpoPushMessages,
};
