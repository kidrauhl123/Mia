const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function jsonRequest(baseUrl, requestPath, { method = "GET", token = "", body } = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

function fakeResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  };
}

function createFixture() {
  const dataDir = tempDir("mia-cloud-im-channels-");
  const outbound = [];
  let server = null;
  const dispatcher = {
    async handleUserMessage({ userId, conversationId, message }) {
      const botMember = server.mia.socialStore.listConversationMembers(conversationId)
        .find((member) => member.member_kind === "bot");
      return server.mia.messagesStore.appendMessage({
        conversationId,
        senderKind: "bot",
        senderRef: botMember.member_ref,
        senderOwnerId: userId,
        bodyMd: "这是来自 Mia 的回复",
        triggerMessageId: message.id,
        status: "complete"
      });
    }
  };
  server = createMiaCloudServer({
    dataDir,
    publicUrl: "https://mia.test",
    imEncryptionKey: "test-im-channel-encryption-key",
    cloudAgentDispatcher: dispatcher,
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      outbound.push({ target, options });
      if (target.includes("tenant_access_token")) {
        return fakeResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      if (target.includes("/im/v1/messages/") && target.endsWith("/reply")) {
        return fakeResponse({ code: 0, data: { message_id: "om_reply" } });
      }
      throw new Error(`Unexpected provider request ${target}`);
    }
  });
  const account = loginCloudUser(server.mia.cloudStore, "im-channel-user");
  const bot = server.mia.botsStore.upsertBot(account.user.id, {
    id: "im_test_bot",
    displayName: "IM 测试 Bot"
  });
  return { dataDir, outbound, server, account, bot };
}

async function destroyFixture(fixture) {
  await close(fixture.server);
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
}

test("飞书 IM 通道保存凭据但 API 不泄露，并把 Bot 回复回投一次", async () => {
  const fixture = createFixture();
  const baseUrl = await listen(fixture.server);
  try {
    const created = await jsonRequest(baseUrl, "/api/me/im-channels", {
      method: "POST",
      token: fixture.account.token,
      body: {
        provider: "feishu",
        botId: fixture.bot.id,
        name: "飞书团队助手",
        enabled: true,
        settings: { allowedSenderIds: ["ou_allowed"] },
        credentials: {
          appId: "cli_test",
          appSecret: "feishu-super-secret",
          verificationToken: "verify-feishu"
        }
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const channel = created.data.channel;
    assert.match(channel.callbackUrl, /^https:\/\/mia\.test\/api\/im\/feishu\/imc_/);
    assert.equal(JSON.stringify(created.data).includes("feishu-super-secret"), false);
    assert.equal(channel.hasCredentials, true);
    const stored = fixture.server.mia.cloudStore.getDb()
      .prepare("SELECT secrets_ciphertext FROM im_channels WHERE id = ?")
      .get(channel.id);
    assert.notEqual(stored.secrets_ciphertext, "feishu-super-secret");
    assert.equal(stored.secrets_ciphertext.includes("feishu-super-secret"), false);

    const challenge = await jsonRequest(baseUrl, `/api/im/feishu/${channel.id}/events`, {
      method: "POST",
      body: { type: "url_verification", token: "verify-feishu", challenge: "challenge-value" }
    });
    assert.equal(challenge.status, 200);
    assert.deepEqual(challenge.data, { challenge: "challenge-value" });

    const event = {
      header: {
        event_type: "im.message.receive_v1",
        event_id: "feishu-event-1",
        token: "verify-feishu"
      },
      event: {
        sender: { sender_id: { open_id: "ou_allowed" } },
        message: {
          message_id: "om_message_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你好，Mia" })
        }
      }
    };
    const callback = await jsonRequest(baseUrl, `/api/im/feishu/${channel.id}/events`, {
      method: "POST",
      body: event
    });
    assert.equal(callback.status, 200);
    assert.deepEqual(callback.data, { code: 0 });
    await fixture.server.mia.imChannelsService.idle();
    const replyRequests = fixture.outbound.filter((item) => item.target.includes("/im/v1/messages/"));
    assert.equal(replyRequests.length, 1);
    assert.match(String(replyRequests[0].options.body), /这是来自 Mia 的回复/);

    const duplicate = await jsonRequest(baseUrl, `/api/im/feishu/${channel.id}/events`, {
      method: "POST",
      body: event
    });
    assert.equal(duplicate.status, 200);
    await fixture.server.mia.imChannelsService.idle();
    assert.equal(fixture.outbound.filter((item) => item.target.includes("/im/v1/messages/")).length, 1);

    const imConversation = fixture.server.mia.socialStore.listConversationsForUser(fixture.account.user.id)
      .find((conversation) => conversation.decorations?.source === "im-channel");
    assert.ok(imConversation, "expected the provider callback to create a Mia conversation");
    const deletedConversation = await jsonRequest(baseUrl, `/api/conversations/${imConversation.id}`, {
      method: "DELETE",
      token: fixture.account.token,
      body: {}
    });
    assert.equal(deletedConversation.status, 200);
    assert.ok(fixture.server.mia.botsStore.getBot(fixture.bot.id), "deleting an IM thread must not delete its bound Bot");

    const denied = await jsonRequest(baseUrl, `/api/im/feishu/${channel.id}/events`, {
      method: "POST",
      body: {
        ...event,
        header: { ...event.header, event_id: "feishu-event-denied" },
        event: {
          ...event.event,
          sender: { sender_id: { open_id: "ou_untrusted" } },
          message: { ...event.event.message, message_id: "om_message_denied" }
        }
      }
    });
    assert.equal(denied.status, 200);
    await fixture.server.mia.imChannelsService.idle();
    assert.equal(fixture.outbound.filter((item) => item.target.includes("/im/v1/messages/")).length, 1);
  } finally {
    await destroyFixture(fixture);
  }
});

test("移除的旧 IM provider 不再可创建或接收回调", async () => {
  const fixture = createFixture();
  const baseUrl = await listen(fixture.server);
  try {
    const created = await jsonRequest(baseUrl, "/api/me/im-channels", {
      method: "POST",
      token: fixture.account.token,
      body: {
        provider: "wechat_official_account",
        botId: fixture.bot.id
      }
    });
    assert.equal(created.status, 400);
    assert.match(created.data.error, /尚不支持/);
    const callback = await fetch(`${baseUrl}/api/im/wechat/imc_legacy/events`, {
      headers: { Authorization: `Bearer ${fixture.account.token}` }
    });
    assert.equal(callback.status, 404);
  } finally {
    await destroyFixture(fixture);
  }
});

test("IM 通道默认拒绝未知发送者，且启用时要求发送者策略", async () => {
  const fixture = createFixture();
  const baseUrl = await listen(fixture.server);
  try {
    const rejected = await jsonRequest(baseUrl, "/api/me/im-channels", {
      method: "POST",
      token: fixture.account.token,
      body: {
        provider: "feishu",
        botId: fixture.bot.id,
        enabled: true,
        credentials: { appId: "cli_test", appSecret: "secret", verificationToken: "token" }
      }
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /可信发送者|允许所有发送者/);
  } finally {
    await destroyFixture(fixture);
  }
});

test("微信通过受控本机中继投递，Cloud 不保存微信回复上下文", async () => {
  const fixture = createFixture();
  const baseUrl = await listen(fixture.server);
  try {
    const created = await jsonRequest(baseUrl, "/api/me/im-channels", {
      method: "POST",
      token: fixture.account.token,
      body: {
        provider: "wechat_clawbot",
        botId: fixture.bot.id,
        enabled: true,
        settings: {
          relayDeviceId: "device_local_1",
          allowedSenderIds: ["stale_manual_id"],
          allowAllSenders: true,
          allowGroupMessages: true
        }
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const channel = created.data.channel;
    assert.equal(channel.hasCredentials, false);
    assert.equal(channel.callbackUrl, "");
    assert.equal(channel.settings.relayDeviceId, "device_local_1");
    assert.equal(channel.settings.allowGroupMessages, false);
    assert.equal(channel.settings.allowAllSenders, false);
    assert.deepEqual(channel.settings.allowedSenderIds, []);

    const forbidden = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/relay/inbound`, {
      method: "POST",
      token: fixture.account.token,
      body: {
        deviceId: "device_other",
        eventId: "wx_inbound_1",
        senderId: "wx_clawbot_sender",
        externalChatId: "wx_clawbot_sender",
        chatType: "p2p",
        text: "你好微信"
      }
    });
    assert.equal(forbidden.status, 403);

    const inbound = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/relay/inbound`, {
      method: "POST",
      token: fixture.account.token,
      body: {
        deviceId: "device_local_1",
        eventId: "wx_inbound_1",
        senderId: "wx_clawbot_sender",
        senderLabel: "微信测试用户",
        externalChatId: "wx_clawbot_sender",
        chatType: "p2p",
        text: "你好微信"
      }
    });
    assert.equal(inbound.status, 202, JSON.stringify(inbound.data));
    assert.equal(inbound.data.accepted, true);
    assert.match(inbound.data.deliveryId, /^imd_/);
    const waiting = fixture.server.mia.cloudStore.getDb()
      .prepare("SELECT status FROM im_channel_deliveries WHERE id = ?")
      .get(inbound.data.deliveryId);
    assert.equal(waiting.status, "awaiting_relay_activation");
    const activate = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/relay/deliveries/${inbound.data.deliveryId}/activate`, {
      method: "POST",
      token: fixture.account.token,
      body: { deviceId: "device_local_1" }
    });
    assert.equal(activate.status, 202, JSON.stringify(activate.data));
    assert.equal(activate.data.activated, true);
    await fixture.server.mia.imChannelsService.idle();

    const relayEvent = fixture.server.mia.eventLog
      .listEventsSince(fixture.account.user.id, 0)
      .find((event) => event.payload?.type === "im_channel.delivery_requested");
    assert.ok(relayEvent, "expected a durable device relay event");
    assert.equal(relayEvent.payload.channelId, channel.id);
    assert.equal(relayEvent.payload.deliveryId, inbound.data.deliveryId);
    assert.equal(relayEvent.payload.targetDeviceId, "device_local_1");
    assert.match(relayEvent.payload.text, /这是来自 Mia 的回复/);
    assert.equal(JSON.stringify(relayEvent.payload).includes("context_token"), false);
    assert.equal(JSON.stringify(relayEvent.payload).includes("Bearer"), false);

    const storedDelivery = fixture.server.mia.cloudStore.getDb()
      .prepare("SELECT status, reply_ref, recipient_json, attempt_count FROM im_channel_deliveries WHERE id = ?")
      .get(inbound.data.deliveryId);
    assert.equal(storedDelivery.status, "relay_requested");
    assert.equal(storedDelivery.reply_ref, "");
    assert.equal(storedDelivery.recipient_json, "{}");
    assert.equal(storedDelivery.attempt_count, 1);

    const duplicate = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/relay/inbound`, {
      method: "POST",
      token: fixture.account.token,
      body: {
        deviceId: "device_local_1",
        eventId: "wx_inbound_1",
        senderId: "wx_clawbot_sender",
        externalChatId: "wx_clawbot_sender",
        chatType: "p2p",
        text: "你好微信"
      }
    });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.deliveryId, inbound.data.deliveryId);

    const ack = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/relay/deliveries/${inbound.data.deliveryId}/ack`, {
      method: "POST",
      token: fixture.account.token,
      body: { deviceId: "device_local_1", ok: true }
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.data));
    assert.equal(ack.data.status, "delivered");

    const originalReply = fixture.server.mia.messagesStore
      .listMessagesSince(inbound.data.conversationId, 0, 20)
      .find((message) => message.trigger_message_id === inbound.data.messageId);
    assert.ok(originalReply, "expected the original IM-triggered reply");
    const replay = await fixture.server.mia.imChannelsService.deliverBotReply({
      conversationId: inbound.data.conversationId,
      message: originalReply
    });
    assert.equal(replay.ignored, "already_handled");

    const desktopReply = fixture.server.mia.messagesStore.appendMessage({
      conversationId: inbound.data.conversationId,
      senderKind: "bot",
      senderRef: fixture.bot.id,
      senderOwnerId: fixture.account.user.id,
      bodyMd: "桌面端回复",
      triggerMessageId: "desktop_prompt_1",
      status: "complete"
    });
    const desktopDelivery = await fixture.server.mia.imChannelsService.deliverBotReply({
      conversationId: inbound.data.conversationId,
      message: desktopReply
    });
    assert.equal(desktopDelivery.queued, true);

    const scheduledReply = fixture.server.mia.messagesStore.appendMessage({
      conversationId: inbound.data.conversationId,
      senderKind: "bot",
      senderRef: fixture.bot.id,
      senderOwnerId: fixture.account.user.id,
      bodyMd: "定时任务结果",
      status: "complete"
    });
    const scheduledDelivery = await fixture.server.mia.imChannelsService.deliverBotReply({
      conversationId: inbound.data.conversationId,
      message: scheduledReply
    });
    assert.equal(scheduledDelivery.queued, true);

    const relayEvents = fixture.server.mia.eventLog
      .listEventsSince(fixture.account.user.id, 0)
      .filter((event) => event.payload?.type === "im_channel.delivery_requested");
    assert.equal(relayEvents.length, 3);
    for (const event of relayEvents.slice(1)) {
      assert.equal(event.payload.deliveryMode, "conversation_output");
      assert.equal(event.payload.conversationId, inbound.data.conversationId);
      assert.equal(JSON.stringify(event.payload).includes("context_token"), false);
    }
    assert.equal(relayEvents[1].payload.triggerMessageId, desktopReply.id);
    assert.equal(relayEvents[2].payload.triggerMessageId, scheduledReply.id);
    const outputDeliveries = fixture.server.mia.cloudStore.getDb()
      .prepare("SELECT trigger_message_id, recipient_json, status FROM im_channel_deliveries WHERE conversation_id = ? AND trigger_message_id IN (?, ?) ORDER BY trigger_message_id ASC")
      .all(inbound.data.conversationId, desktopReply.id, scheduledReply.id);
    assert.equal(outputDeliveries.length, 2);
    for (const delivery of outputDeliveries) {
      assert.deepEqual(JSON.parse(delivery.recipient_json), { relayMode: "conversation_output" });
      assert.equal(delivery.status, "relay_requested");
    }
  } finally {
    await destroyFixture(fixture);
  }
});
