const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const { createMiaCloudServer } = require("../scripts/serve-cloud.js");
const { loginCloudUser } = require("./helpers/cloud-auth.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function mcpRequest(baseUrl, token, body, options = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: options.method || "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    },
    body: (options.method || "POST") === "POST"
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : undefined
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, body: data };
}

function rpc(id, method, params) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  };
}

function toolValue(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body?.result?.isError, false);
  return response.body.result.structuredContent;
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for websocket message."));
    }, 2000);
    function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }
    ws.on("message", onMessage);
    ws.on("error", reject);
  });
}

function closeWs(ws) {
  if (!ws) return;
  try {
    ws.close();
  } catch {
    // Best-effort test cleanup.
  }
}

function wsTokenProtocol(token) {
  return [`mia-token.${token}`];
}

async function apiJson(baseUrl, token, requestPath, body) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || `HTTP ${response.status}`);
  return data;
}

test("authenticated stateless HTTP MCP exposes only the six Mia chat tools", async () => {
  const dataDir = tempDir("mia-cloud-chat-mcp-protocol-");
  const server = createMiaCloudServer({ dataDir });
  const account = loginCloudUser(server.mia.cloudStore, "mcp-protocol");
  const baseUrl = await listen(server);
  try {
    const unauthenticated = await mcpRequest(baseUrl, "", rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }));
    assert.equal(unauthenticated.status, 401);

    const badOrigin = await mcpRequest(baseUrl, account.token, rpc(2, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }), {
      headers: { Origin: "https://attacker.invalid" }
    });
    assert.equal(badOrigin.status, 403);

    const initialized = await mcpRequest(baseUrl, account.token, rpc(3, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }));
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.protocolVersion, "2025-11-25");
    assert.deepEqual(initialized.body.result.capabilities, { tools: {} });

    const notification = await mcpRequest(baseUrl, account.token, {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, {
      headers: { "MCP-Protocol-Version": "2025-11-25" }
    });
    assert.equal(notification.status, 202);
    assert.equal(notification.body, null);

    const tools = await mcpRequest(baseUrl, account.token, rpc(4, "tools/list", {}), {
      headers: { "MCP-Protocol-Version": "2025-11-25" }
    });
    assert.equal(tools.status, 200);
    assert.deepEqual(
      tools.body.result.tools.map((tool) => tool.name),
      [
        "list_bots",
        "create_bot",
        "list_conversations",
        "create_conversation",
        "send_message",
        "get_messages"
      ]
    );
    assert.equal(
      tools.body.result.tools.some((tool) => /task|schedule|shell|file|desktop/i.test(tool.name)),
      false
    );

    const unsupportedVersion = await mcpRequest(baseUrl, account.token, rpc(5, "ping"), {
      headers: { "MCP-Protocol-Version": "2099-01-01" }
    });
    assert.equal(unsupportedVersion.status, 400);
    assert.equal(unsupportedVersion.body.error.code, -32600);

    const get = await mcpRequest(baseUrl, account.token, null, { method: "GET" });
    assert.equal(get.status, 405);
    assert.match(get.headers.get("allow"), /POST/);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Mia chat MCP creates bots and conversations and returns canonical replies", async () => {
  const dataDir = tempDir("mia-cloud-chat-mcp-flow-");
  const server = createMiaCloudServer({
    dataDir,
    platformModelId: "mia-default"
  });
  const account = loginCloudUser(server.mia.cloudStore, "mcp-flow");
  server.mia.cloudAgentRuntime = {
    mode: "claude-code",
    runtimeKind: "cloud-claude-code",
    agentEngine: "claude-code",
    available: true,
    source: "test"
  };
  server.mia.cloudAgentDispatcher = {
    async handleUserMessage({ userId, conversationId, message }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const conversation = server.mia.socialStore.getConversation(conversationId);
      const botId = conversation.decorations.botId;
      return server.mia.messagesStore.appendMessage({
        conversationId,
        senderKind: "bot",
        senderRef: botId,
        senderOwnerId: userId,
        bodyMd: `reply:${message.body_md}`,
        turnId: message.turn_id,
        triggerMessageId: message.id,
        status: "complete"
      });
    }
  };
  const baseUrl = await listen(server);
  let nextId = 1;
  const call = (name, args = {}) => mcpRequest(
    baseUrl,
    account.token,
    rpc(nextId++, "tools/call", { name, arguments: args }),
    {
      headers: {
        "MCP-Protocol-Version": "2025-11-25",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name
      }
    }
  );

  try {
    const createdBot = toolValue(await call("create_bot", {
      name: "Researcher",
      persona: "Answer carefully.",
      description: "A test bot."
    }));
    assert.match(createdBot.bot.id, /^[1-9][0-9]{6}$/);
    assert.equal(createdBot.bot.name, "Researcher");
    assert.equal(createdBot.bot.persona, "Answer carefully.");
    assert.equal(createdBot.bot.runtime.kind, "cloud-claude-code");
    assert.equal(createdBot.bot.runtime.agent_engine, "claude-code");

    const listedBots = toolValue(await call("list_bots"));
    assert.equal(listedBots.bots.some((bot) => bot.id === createdBot.bot.id), true);

    const createdConversation = toolValue(await call("create_conversation", {
      bot_id: createdBot.bot.id,
      title: "New research"
    }));
    assert.match(createdConversation.conversation.id, /^botc_/);
    assert.equal(createdConversation.conversation.title, "New research");
    assert.equal(createdConversation.conversation.bot_id, createdBot.bot.id);

    const listedConversations = toolValue(await call("list_conversations", {
      bot_id: createdBot.bot.id
    }));
    assert.deepEqual(
      listedConversations.conversations.map((conversation) => conversation.id),
      [createdConversation.conversation.id]
    );

    const sent = toolValue(await call("send_message", {
      conversation_id: createdConversation.conversation.id,
      text: "hello",
      wait_timeout_seconds: 2
    }));
    assert.equal(sent.timed_out, false);
    assert.equal(sent.message.role, "user");
    assert.equal(sent.reply.role, "assistant");
    assert.equal(sent.reply.text, "reply:hello");
    assert.equal(sent.reply.trigger_message_id, sent.message.id);

    server.mia.cloudAgentDispatcher = {
      async handleUserMessage({ userId, conversationId, message }) {
        setTimeout(() => {
          const conversation = server.mia.socialStore.getConversation(conversationId);
          server.mia.messagesStore.appendMessage({
            conversationId,
            senderKind: "bot",
            senderRef: conversation.decorations.botId,
            senderOwnerId: userId,
            bodyMd: `delayed:${message.body_md}`,
            turnId: message.turn_id,
            triggerMessageId: message.id,
            status: "complete"
          });
        }, 30);
        return null;
      }
    };
    const delayed = toolValue(await call("send_message", {
      conversation_id: createdConversation.conversation.id,
      text: "poll me",
      wait_timeout_seconds: 2
    }));
    assert.equal(delayed.timed_out, false);
    assert.equal(delayed.reply.text, "delayed:poll me");

    const messages = toolValue(await call("get_messages", {
      conversation_id: createdConversation.conversation.id,
      limit: 20
    }));
    assert.deepEqual(
      messages.messages.map((message) => [message.role, message.text]),
      [
        ["user", "hello"],
        ["assistant", "reply:hello"],
        ["user", "poll me"],
        ["assistant", "delayed:poll me"]
      ]
    );

    const otherAccount = loginCloudUser(server.mia.cloudStore, "mcp-flow-other");
    const otherBots = toolValue(await mcpRequest(
      baseUrl,
      otherAccount.token,
      rpc(100, "tools/call", { name: "list_bots", arguments: {} })
    ));
    assert.equal(otherBots.bots.some((bot) => bot.id === createdBot.bot.id), false);
    const forbiddenMessages = await mcpRequest(
      baseUrl,
      otherAccount.token,
      rpc(101, "tools/call", {
        name: "get_messages",
        arguments: { conversation_id: createdConversation.conversation.id }
      })
    );
    assert.equal(forbiddenMessages.status, 200);
    assert.equal(forbiddenMessages.body.result.isError, true);
    assert.equal(forbiddenMessages.body.result.structuredContent.code, "forbidden");
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Mia chat MCP reaches a desktop bot through the existing Cloud Bridge", async () => {
  const dataDir = tempDir("mia-cloud-chat-mcp-bridge-");
  const server = createMiaCloudServer({ dataDir });
  const account = loginCloudUser(server.mia.cloudStore, "mcp-bridge");
  const baseUrl = await listen(server);
  const wsBaseUrl = baseUrl.replace(/^http:/, "ws:");
  let bridgeWs = null;
  let eventsWs = null;
  let nextId = 1;
  const call = (name, args = {}) => mcpRequest(
    baseUrl,
    account.token,
    rpc(nextId++, "tools/call", { name, arguments: args })
  );

  try {
    const bridgeUrl = new URL(`${wsBaseUrl}/api/bridge`);
    bridgeUrl.searchParams.set("deviceId", "mcp-desktop");
    bridgeUrl.searchParams.set("deviceName", "MCP Test Desktop");
    bridgeUrl.searchParams.set("engine", "codex");
    bridgeWs = new WebSocket(bridgeUrl, wsTokenProtocol(account.token));
    const bridgeReady = await waitForMessage(bridgeWs, (message) => message.type === "bridge_ready");

    eventsWs = new WebSocket(`${wsBaseUrl}/api/events`, wsTokenProtocol(account.token));
    await waitForMessage(eventsWs, (message) => message.type === "events_ready");

    const createdBot = toolValue(await call("create_bot", {
      name: "Desktop Codex",
      runtime_kind: "desktop-local",
      agent_engine: "codex",
      device_id: bridgeReady.deviceId
    }));
    assert.equal(createdBot.bot.runtime.kind, "desktop-local");
    assert.equal(createdBot.bot.runtime.device_id, bridgeReady.deviceId);

    const createdConversation = toolValue(await call("create_conversation", {
      bot_id: createdBot.bot.id
    }));
    const conversationId = createdConversation.conversation.id;
    const invocationPromise = waitForMessage(eventsWs, (message) => (
      message.type === "conversation.bot_invocation_requested"
      && message.conversationId === conversationId
      && message.botId === createdBot.bot.id
    ));

    const sendPromise = call("send_message", {
      conversation_id: conversationId,
      text: "from remote MCP",
      wait_timeout_seconds: 2
    });
    const invocation = await invocationPromise;
    assert.equal(invocation.targetDeviceId, bridgeReady.deviceId);
    assert.equal(invocation.runtimeConfig.agentEngine, "codex");
    assert.equal(invocation.triggeringMessage.body_md, "from remote MCP");

    await apiJson(
      baseUrl,
      account.token,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/as-bot`,
      {
        botId: createdBot.bot.id,
        bodyMd: "reply from local Codex",
        triggerMessageId: invocation.triggeringMessage.id,
        turnId: invocation.triggeringMessage.turn_id
      }
    );
    const sent = toolValue(await sendPromise);
    assert.equal(sent.timed_out, false);
    assert.equal(sent.reply.text, "reply from local Codex");
    assert.equal(sent.reply.trigger_message_id, sent.message.id);
  } finally {
    closeWs(eventsWs);
    closeWs(bridgeWs);
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
