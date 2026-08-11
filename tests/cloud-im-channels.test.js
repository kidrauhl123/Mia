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

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("timed out waiting for expected result");
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

test("云端 Bot 把微信会话、轮询和回复留在 Mia Cloud，重启后不需要本机 Core", async () => {
  const dataDir = tempDir("mia-cloud-wechat-clawbot-");
  const outbound = [];
  let updateCalls = 0;
  let server = null;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    outbound.push({ target, options });
    if (target.includes("get_bot_qrcode")) {
      return fakeResponse({ qrcode: "wx_qr_1", qrcode_img_content: "weixin://cloud-qr" });
    }
    if (target.includes("get_qrcode_status")) {
      return fakeResponse({
        status: "confirmed",
        bot_token: "cloud-wechat-bot-token",
        ilink_bot_id: "wx_cloud_bot",
        ilink_user_id: "wx_cloud_owner",
        baseurl: "https://ilinkai.weixin.qq.com"
      });
    }
    if (target.includes("notifystart") || target.includes("notifystop")) return fakeResponse({ ret: 0 });
    if (target.includes("getupdates")) {
      updateCalls += 1;
      if (updateCalls === 1) {
        return fakeResponse({
          ret: 0,
          get_updates_buf: "wx_cursor_1",
          msgs: [{
            message_id: "wx_cloud_message_1",
            message_type: 1,
            from_user_id: "wx_cloud_owner",
            context_token: "cloud-context-token",
            item_list: [{ type: 1, text_item: { text: "云端微信你好" } }]
          }]
        });
      }
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (target.includes("sendmessage")) return fakeResponse({ ret: 0 });
    throw new Error(`Unexpected provider request ${target}`);
  };
  const dispatcher = {
    async handleUserMessage({ userId, conversationId, message }) {
      const botMember = server.mia.socialStore.listConversationMembers(conversationId)
        .find((member) => member.member_kind === "bot");
      return server.mia.messagesStore.appendMessage({
        conversationId,
        senderKind: "bot",
        senderRef: botMember.member_ref,
        senderOwnerId: userId,
        bodyMd: "云端 Bot 已回复",
        triggerMessageId: message.id,
        status: "complete"
      });
    }
  };
  server = createMiaCloudServer({
    dataDir,
    publicUrl: "https://mia.test",
    imEncryptionKey: "cloud-wechat-encryption-key",
    cloudAgentDispatcher: dispatcher,
    fetchImpl
  });
  const account = loginCloudUser(server.mia.cloudStore, "cloud-wechat-user");
  const bot = server.mia.botsStore.upsertBot(account.user.id, {
    id: "cloud_wechat_bot",
    displayName: "云端微信 Bot"
  });
  server.mia.runtimeBindingsStore.upsertBinding({
    userId: account.user.id,
    botId: bot.id,
    runtimeKind: "cloud-claude-code",
    config: {},
    activate: true
  });
  const baseUrl = await listen(server);
  try {
    const created = await jsonRequest(baseUrl, "/api/me/im-channels", {
      method: "POST",
      token: account.token,
      body: { provider: "wechat_clawbot", botId: bot.id, enabled: true, settings: {} }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const channel = created.data.channel;
    assert.equal(channel.transport, "cloud");
    assert.equal(channel.settings.transport, "cloud");
    assert.equal(channel.settings.relayDeviceId, "");

    const linking = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/wechat-clawbot/link`, {
      method: "POST",
      token: account.token,
      body: {}
    });
    assert.equal(linking.status, 200, JSON.stringify(linking.data));
    assert.equal(linking.data.status.linked, false);
    assert.equal(linking.data.status.qrUrl, "weixin://cloud-qr");

    await waitFor(() => outbound.some((item) => item.target.includes("sendmessage")));
    await server.mia.imChannelsService.idle();
    const sent = outbound.filter((item) => item.target.includes("sendmessage"));
    assert.equal(sent.length, 1);
    assert.match(String(sent[0].options.body), /云端 Bot 已回复/);
    assert.equal(String(sent[0].options.body).includes("cloud-wechat-bot-token"), false);

    const status = await jsonRequest(baseUrl, `/api/me/im-channels/${channel.id}/wechat-clawbot/status`, {
      token: account.token
    });
    assert.equal(status.status, 200, JSON.stringify(status.data));
    assert.equal(status.data.status.linked, true);
    assert.equal(JSON.stringify(status.data).includes("cloud-wechat-bot-token"), false);
    assert.equal(JSON.stringify(status.data).includes("cloud-context-token"), false);

    const stored = server.mia.cloudStore.getDb()
      .prepare("SELECT secrets_ciphertext FROM im_channels WHERE id = ?")
      .get(channel.id);
    assert.notEqual(stored.secrets_ciphertext, "cloud-wechat-bot-token");
    assert.equal(stored.secrets_ciphertext.includes("cloud-wechat-bot-token"), false);
    const delivery = server.mia.cloudStore.getDb()
      .prepare("SELECT recipient_json, status FROM im_channel_deliveries WHERE channel_id = ?")
      .get(channel.id);
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.recipient_json.includes("cloud-context-token"), false);

    const conversation = server.mia.socialStore.listConversationsForUser(account.user.id)
      .find((item) => item.decorations?.imChannelId === channel.id);
    const scheduledReply = server.mia.messagesStore.appendMessage({
      conversationId: conversation.id,
      senderKind: "bot",
      senderRef: bot.id,
      senderOwnerId: account.user.id,
      bodyMd: "云端定时任务回复",
      status: "complete"
    });
    const scheduledDelivery = await server.mia.imChannelsService.deliverBotReply({
      conversationId: conversation.id,
      message: scheduledReply
    });
    assert.equal(scheduledDelivery.delivered, true);
    assert.equal(outbound.filter((item) => item.target.includes("sendmessage")).length, 2);

    server.mia.runtimeBindingsStore.upsertBinding({
      userId: account.user.id,
      botId: bot.id,
      runtimeKind: "desktop-local",
      config: { agentEngine: "claude-code", deviceId: "desktop_test_device" },
      activate: true
    });
    server.mia.wechatClawbotService.onRuntimeChanged(account.user.id, bot.id);
    await waitFor(() => outbound.some((item) => item.target.includes("notifystop")));
    assert.throws(
      () => server.mia.wechatClawbotService.status(account.user.id, channel.id),
      (error) => error?.code === "MIA_WECHAT_CLAWBOT_LOCAL_RUNTIME"
    );

    server.mia.runtimeBindingsStore.upsertBinding({
      userId: account.user.id,
      botId: bot.id,
      runtimeKind: "cloud-claude-code",
      config: {},
      activate: true
    });
    server.mia.wechatClawbotService.onRuntimeChanged(account.user.id, bot.id);
    await waitFor(() => server.mia.wechatClawbotService.status(account.user.id, channel.id).linked === true);

    await server.shutdown();
    server = createMiaCloudServer({
      dataDir,
      publicUrl: "https://mia.test",
      imEncryptionKey: "cloud-wechat-encryption-key",
      cloudAgentDispatcher: dispatcher,
      fetchImpl
    });
    const restartedBaseUrl = await listen(server);
    const restarted = await jsonRequest(restartedBaseUrl, `/api/me/im-channels/${channel.id}/wechat-clawbot/status`, {
      token: account.token
    });
    assert.equal(restarted.status, 200, JSON.stringify(restarted.data));
    assert.equal(restarted.data.status.linked, true);
    assert.equal(restarted.data.status.qrUrl, "");
  } finally {
    if (server.listening) await server.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
