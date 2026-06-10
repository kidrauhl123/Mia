const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudBridgeClient } = require("../src/main/cloud/cloud-bridge-client.js");

function fakeWebSocketClass() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.handlers = {};
      this.sent = [];
      this.closed = null;
      sockets.push(this);
    }

    on(name, handler) {
      this.handlers[name] = handler;
    }

    emit(name, arg) {
      if (this.handlers[name]) this.handlers[name](arg);
    }

    send(payload) {
      this.sent.push(JSON.parse(String(payload)));
    }

    close(code, reason) {
      this.readyState = FakeWebSocket.CLOSED;
      this.closed = { code, reason };
    }
  }
  return { FakeWebSocket, sockets };
}

function setup(overrides = {}) {
  const { FakeWebSocket, sockets } = fakeWebSocketClass();
  const calls = { chat: [], engines: [], logs: [], timers: [] };
  let settings = {
    enabled: true,
    token: "tok_1",
    url: "https://cloud.example",
    user: { id: "u_1", username: "jung" }
  };
  const client = createCloudBridgeClient({
    WebSocketImpl: FakeWebSocket,
    getSettings: () => settings,
    isDaemonProcess: false,
    isDaemonEnabled: () => false,
    cloudBridgeUrl: () => "wss://cloud.example/api/bridge?deviceName=Mac",
    cloudWebSocketProtocols: (s) => [`mia-token.${s.token}`],
    createActiveBridgeChatAdapter: (engine) => ({
      sendChat: async (args) => {
        calls.engines.push(engine);
        calls.chat.push(args);
        return {
          choices: [{
            message: {
              content: "done",
              attachments: [{ type: "image", name: "cat.webp", dataUrl: "data:image/webp;base64,abc" }]
            }
          }]
        };
      }
    }),
    resolveBotCapabilities: overrides.resolveBotCapabilities || (() => ({})),
    randomUUID: () => "uuid_1",
    setTimeoutFn: (fn, delayMs) => {
      const timer = { fn, delayMs };
      calls.timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    ...overrides
  });
  return { client, calls, sockets, FakeWebSocket, setSettings: (patch) => { settings = { ...settings, ...patch }; } };
}

test("start gates foreground bridge when daemon is enabled", () => {
  const { client, sockets } = setup({ isDaemonEnabled: () => true });

  client.start();

  assert.equal(sockets.length, 0);
  assert.deepEqual(client.status(), {
    enabled: true,
    connected: false,
    connecting: false,
    url: "https://cloud.example",
    user: { id: "u_1", username: "jung" },
    deviceId: "",
    lastError: "",
    logs: []
  });
});

test("start opens one bridge socket and ready updates status", () => {
  const { client, sockets } = setup();

  client.start();
  client.start();

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://cloud.example/api/bridge?deviceName=Mac");
  assert.deepEqual(sockets[0].protocols, ["mia-token.tok_1"]);

  sockets[0].emit("message", JSON.stringify({ type: "bridge_ready", deviceId: "dev_1" }));

  assert.equal(client.status().connected, true);
  assert.equal(client.status().connecting, false);
  assert.equal(client.status().deviceId, "dev_1");
});

test("run messages execute the requested Agent engine through the bridge Module", async () => {
  const { client, calls, sockets, FakeWebSocket } = setup();
  client.start();
  const ws = sockets[0];
  ws.readyState = FakeWebSocket.OPEN;

  client.handleMessage(ws, JSON.stringify({
    type: "run",
    runId: "run_1",
    conversationId: "c_1",
    text: "生成猫图",
    attachments: [{ name: "brief.txt", path: "/tmp/brief.txt" }]
  }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.chat.length, 1);
  assert.deepEqual(calls.engines, ["codex"]);
  assert.equal(calls.chat[0].bot.agentEngine, "codex");
  assert.equal(calls.chat[0].bot.engineConfig.permissionMode, "default");
  assert.equal(calls.chat[0].runtimeConfig.agentEngine, "codex");
  assert.equal(calls.chat[0].sessionId, "cloud:c_1");
  assert.equal(calls.chat[0].messages[0].content, "生成猫图");
  assert.deepEqual(calls.chat[0].messages[0].attachments, [{ name: "brief.txt", path: "/tmp/brief.txt" }]);
  assert.deepEqual(ws.sent, [
    { type: "run_event", runId: "run_1", event: { kind: "status", text: "本机 Codex 已开始运行。" } },
    {
      type: "run_result",
      runId: "run_1",
      ok: true,
      text: "done",
      attachments: [{ id: "att_uuid_1", type: "image", name: "cat.webp", mimeType: "", dataUrl: "data:image/webp;base64,abc", url: "" }]
    }
  ]);
});

test("run messages forward resolved bot capabilities to the bridge adapter", async () => {
  const { client, calls, sockets, FakeWebSocket } = setup({
    resolveBotCapabilities: ({ botKey, botName }) => {
      assert.equal(botKey, "paper-buddy");
      assert.equal(botName, "论文搭子");
      return { enabledSkills: ["mia-official:paper-research"] };
    }
  });
  client.start();
  const ws = sockets[0];
  ws.readyState = FakeWebSocket.OPEN;

  client.handleMessage(ws, JSON.stringify({
    type: "run",
    runId: "run_caps",
    conversationId: "c_1",
    text: "读论文",
    botId: "paper-buddy",
    botName: "论文搭子",
    runtimeConfig: { agentEngine: "codex" }
  }));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls.chat[0].bot.capabilities, { enabledSkills: ["mia-official:paper-research"] });
});

test("run messages can choose Claude Code instead of the legacy Codex bridge", async () => {
  const { client, calls, sockets, FakeWebSocket } = setup();
  client.start();
  const ws = sockets[0];
  ws.readyState = FakeWebSocket.OPEN;

  client.handleMessage(ws, JSON.stringify({
    type: "run",
    runId: "run_claude",
    conversationId: "c_2",
    text: "总结一下",
    runtimeConfig: {
      agentEngine: "claude-code",
      permissionMode: "bypassPermissions",
      model: "sonnet"
    },
    botId: "helper",
    botName: "Helper"
  }));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls.engines, ["claude-code"]);
  assert.equal(calls.chat[0].bot.key, "helper");
  assert.equal(calls.chat[0].bot.name, "Helper");
  assert.equal(calls.chat[0].bot.agentEngine, "claude-code");
  assert.equal(calls.chat[0].bot.engineConfig.permissionMode, "bypassPermissions");
  assert.equal(calls.chat[0].bot.engineConfig.model, "sonnet");
  assert.equal(calls.chat[0].runtimeConfig.agentEngine, "claude-code");
  assert.equal(ws.sent[0].event.text, "本机 Claude Code 已开始运行。");
});

test("cancel messages abort the active bridge run", async () => {
  let resolveRun;
  const { client, calls, sockets, FakeWebSocket } = setup({
    createActiveBridgeChatAdapter: (engine) => ({
      sendChat: async (args) => {
        calls.engines.push(engine);
        calls.chat.push(args);
        return new Promise((resolve) => {
          resolveRun = () => resolve({ choices: [{ message: { content: "cancelled" } }] });
        });
      }
    })
  });
  client.start();
  const ws = sockets[0];
  ws.readyState = FakeWebSocket.OPEN;

  client.handleMessage(ws, JSON.stringify({ type: "run", runId: "run_cancel", text: "stop me" }));
  await Promise.resolve();
  assert.equal(calls.chat[0].signal.aborted, false);

  client.handleMessage(ws, JSON.stringify({ type: "cancel", runId: "run_cancel" }));
  assert.equal(calls.chat[0].signal.aborted, true);
  resolveRun();
  await Promise.resolve();
});

test("close clears only the active socket and schedules one reconnect", () => {
  const { client, calls, sockets } = setup();

  client.start();
  const first = sockets[0];
  client.stop();
  assert.deepEqual(first.closed, { code: 1000, reason: "cloud disabled" });

  client.start();
  const second = sockets[1];
  first.emit("close");
  assert.equal(calls.timers.length, 0);

  second.emit("close");
  second.emit("close");
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delayMs, 3000);
});
