const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");
const { wechatMpSignature } = require("../src/cloud/wechat-auth.js");

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
      if (target.includes("cgi-bin/token")) {
        return fakeResponse({ access_token: "wechat-token", expires_in: 7200 });
      }
      if (target.includes("message/custom/send")) {
        return fakeResponse({ errcode: 0 });
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

test("微信公众号 IM 通道验证签名，并用客服消息 API 回投", async () => {
  const fixture = createFixture();
  const baseUrl = await listen(fixture.server);
  try {
    const created = await jsonRequest(baseUrl, "/api/me/im-channels", {
      method: "POST",
      token: fixture.account.token,
      body: {
        provider: "wechat_official_account",
        botId: fixture.bot.id,
        enabled: true,
        settings: { allowedSenderIds: ["wx_openid_allowed"] },
        credentials: {
          appId: "wx_test",
          appSecret: "wechat-super-secret",
          token: "verify-wechat"
        }
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const channel = created.data.channel;
    const timestamp = "1710000000";
    const nonce = "nonce-1";
    const signature = wechatMpSignature({ token: "verify-wechat", timestamp, nonce });

    const verification = await fetch(`${baseUrl}/api/im/wechat/${channel.id}/events?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello-wechat`);
    assert.equal(verification.status, 200);
    assert.equal(await verification.text(), "hello-wechat");

    const xml = "<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[wx_openid_allowed]]></FromUserName><CreateTime>1710000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好公众号]]></Content><MsgId>123456789</MsgId></xml>";
    const callback = await fetch(`${baseUrl}/api/im/wechat/${channel.id}/events?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml
    });
    assert.equal(callback.status, 200);
    assert.equal(await callback.text(), "success");
    await fixture.server.mia.imChannelsService.idle();
    const customerServiceRequests = fixture.outbound.filter((item) => item.target.includes("message/custom/send"));
    assert.equal(customerServiceRequests.length, 1);
    const payload = JSON.parse(customerServiceRequests[0].options.body);
    assert.equal(payload.touser, "wx_openid_allowed");
    assert.equal(payload.text.content, "这是来自 Mia 的回复");
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
