const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  isExpoPushToken,
  buildChatPushMessage,
  sendExpoPushMessages,
} = require("../src/cloud/push-notifications.js");

test("isExpoPushToken accepts Expo token shapes and rejects junk", () => {
  assert.ok(isExpoPushToken("ExponentPushToken[abc123]"));
  assert.ok(isExpoPushToken("ExpoPushToken[xyz]"));
  assert.ok(!isExpoPushToken("not-a-token"));
  assert.ok(!isExpoPushToken("ExponentPushToken[]"));
  assert.ok(!isExpoPushToken(""));
  assert.ok(!isExpoPushToken(null));
});

test("buildChatPushMessage carries conversation deep-link data and a safe fallback body", () => {
  const msg = buildChatPushMessage("ExponentPushToken[t]", {
    title: "小明",
    body: "在吗",
    conversationId: "dm:a:b",
  });
  assert.equal(msg.to, "ExponentPushToken[t]");
  assert.equal(msg.title, "小明");
  assert.equal(msg.body, "在吗");
  assert.equal(msg.channelId, "messages");
  assert.equal(msg.data.conversationId, "dm:a:b");

  // Attachment-only messages still raise a non-empty notification.
  const empty = buildChatPushMessage("ExponentPushToken[t]", { title: "小明", body: "   " });
  assert.equal(empty.body, "[附件]");
});

test("sendExpoPushMessages drops invalid tokens, batches by 100, and reports DeviceNotRegistered", async () => {
  const sent = [];
  const fetchImpl = async (_url, opts) => {
    const batch = JSON.parse(opts.body);
    sent.push(batch);
    return {
      json: async () => ({
        data: batch.map((m) =>
          m.to === "ExponentPushToken[dead]"
            ? { status: "error", details: { error: "DeviceNotRegistered" } }
            : { status: "ok" }
        ),
      }),
    };
  };

  const messages = [];
  for (let i = 0; i < 150; i++) messages.push({ to: `ExponentPushToken[u${i}]` });
  messages.push({ to: "ExponentPushToken[dead]" });
  messages.push({ to: "garbage-token" }); // filtered out before sending

  const { invalidTokens } = await sendExpoPushMessages(messages, { fetchImpl });

  // 151 valid tokens → batches of 100 + 51.
  assert.equal(sent.length, 2);
  assert.equal(sent[0].length, 100);
  assert.equal(sent[1].length, 51);
  assert.ok(sent.flat().every((m) => m.to.startsWith("ExponentPushToken[")));
  assert.deepEqual(invalidTokens, ["ExponentPushToken[dead]"]);
});

test("sendExpoPushMessages swallows network errors", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const { invalidTokens } = await sendExpoPushMessages(
    [{ to: "ExponentPushToken[t]" }],
    { fetchImpl }
  );
  assert.deepEqual(invalidTokens, []);
});
