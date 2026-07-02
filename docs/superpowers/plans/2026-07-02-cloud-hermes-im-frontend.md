# 云端 Hermes 作为 Mia IM 前台实施计划

> For agentic workers: REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for parallel implementation, or `superpowers:executing-plans` for a single inline worker. Track every checklist item below and run the verification commands before claiming completion.

**Goal:** 把 Mia Cloud 的 `cloud-hermes` 改成 gateway-only 的 Hermes IM 前台，不再保留 `/v1/runs` 旧逻辑或备用路径。

**Architecture:** Mia Cloud 继续保存 conversation/message，Hermes 只作为云端 Agent runtime。worker 暴露最小 `tui_gateway` WebSocket，dispatcher 只通过 JSON-RPC `session.create/resume`、附件 RPC、`prompt.submit` 和事件流驱动 Hermes；旧 `/v1/runs` client 在 gateway 路径完成后删除。

**Tech Stack:** Node.js CommonJS、`ws`、SQLite `node:sqlite`、Hermes `tui_gateway.ws.handle_ws`、FastAPI shim。

## Global Constraints

- 不做 `/v1/runs` 备用路径；gateway 连不上就是云端 Hermes runtime 配置错误。
- 完成 gateway 接入后删除 `src/cloud-agent/hermes-runs-client.js` 和对应测试。
- `mia-auto` 是 Mia 平台默认模型，约等于用户 99% 情况下要用的 Mia 托管 DeepSeek；不能被归一化成 Hermes 默认模型或 provider 原生默认模型。
- worker config 继续使用 Mia 内部模型代理：`provider: "mia"`、`default: "mia-auto"`、`api_mode: "chat_completions"`。
- 浏览器不直连 Hermes worker；只连 Mia Cloud。

---

## 目标

把 Mia Cloud 的 `cloud-hermes` 从“调用 Hermes `/v1/runs` API”改成“像 Hermes desktop/web 一样，通过 `tui_gateway` 的 JSON-RPC WebSocket 驱动 Hermes 会话”。用户仍然只看到 Mia 的聊天界面，Hermes 只作为云端 Agent runtime。

核心判断：

- Mia 当前路径在 `src/cloud-agent/dispatcher.js`，通过 `hermesRunsClient.runChat()` 调 `src/cloud-agent/hermes-runs-client.js`。
- 当前 `hermes-worker-manager.js` 只配置了 Hermes `api_server`，也就是 `/v1/runs`、SSE events、approval API。
- Hermes 官方 desktop/web 已经统一使用 `tui_gateway` JSON-RPC 协议：`session.create`、`session.resume`、附件 RPC、`prompt.submit`、`approval.respond`、`message.delta/message.complete` 事件。
- Hermes 的 dashboard `/api/ws` 带浏览器鉴权，不适合直接当 Mia worker 内部通道；更稳的方案是借用 upstream `tui_gateway.ws.handle_ws`，在 worker 里挂一个最小 `/api/ws`。

## 非目标

- 不把 Hermes 的 web UI 搬进 Mia。
- 不改 desktop-local runtime。
- 不保留 cloud-hermes 的 `/v1/runs` 备用路径。
- 不让浏览器直接连 Hermes worker。浏览器仍然只连 Mia Cloud。

## 最终架构

用户发消息后：

1. `scripts/serve-cloud.js` 写入 Mia `messages`。
2. `createCloudAgentDispatcher()` 判断 Bot 绑定为 `cloud-hermes`。
3. `workerManager.ensureWorker(ownerId)` 返回 `baseUrl`、`gatewayWsUrl`、`apiKey`、worker paths。
4. 新的 `hermesImClient.runChat()` 连接 `gatewayWsUrl`。
5. `hermesImClient` 创建或恢复 Hermes session。
6. Mia 已经 materialize 的附件通过 Hermes gateway RPC attach 到 session。
7. `prompt.submit` 发出本轮文本。
8. Hermes `message.delta`、`tool.start`、`approval.request` 等事件被归一化后继续走 Mia 现有 `cloud_agent_run_event` 广播。
9. 收到 `message.complete` 后，Mia 仍然把最终回复写入自己的 `messages` 表。

Mia 是 IM 前台，Hermes 是云端 Agent runtime。两边都有 session，但 Mia 的 conversation/message 仍是产品侧真相，Hermes session 是 runtime 侧上下文。

## 任务 1：给 Docker worker 暴露最小 Hermes Gateway

修改文件：

- `src/cloud-agent/hermes-worker-manager.js`
- `tests/cloud-agent-hermes-client.test.js`

新增配置：

- `MIA_CLOUD_HERMES_WS_PATH=/api/ws`，默认 `/api/ws`
- `MIA_CLOUD_HERMES_GATEWAY_WS_URL`，仅 static 模式显式覆盖
- 删除或忽略 `MIA_CLOUD_HERMES_TRANSPORT`；不再支持 `auto` 或 `runs` 选择。

实现要点：

- Docker gateway 模式不直接启动 Hermes dashboard，因为 dashboard 的 `/api/ws` 在非 loopback 下走浏览器鉴权。
- 在 `/data/hermes-home/mia-hermes-gateway-server.py` 写入一个最小 FastAPI server。
- 这个 server 只提供 `/health` 和 `/api/ws`，`/api/ws` 内部直接调用 upstream `tui_gateway.ws.handle_ws`。
- 鉴权只接受 Mia worker token，也就是现有 `apiKey`。

在 `hermes-worker-manager.js` 增加：

```js
const GATEWAY_SHIM_FILENAME = "mia-hermes-gateway-server.py";

function renderHermesGatewayShim() {
  return [
    "import os",
    "from fastapi import FastAPI, WebSocket",
    "from fastapi.responses import JSONResponse",
    "from tui_gateway.ws import handle_ws",
    "",
    "app = FastAPI(title='Mia Hermes Gateway')",
    "TOKEN = os.environ.get('MIA_HERMES_GATEWAY_TOKEN') or os.environ.get('API_SERVER_KEY') or ''",
    "",
    "def _authorized(ws):",
    "    if not TOKEN:",
    "        return True",
    "    query_token = ws.query_params.get('token', '')",
    "    auth = ws.headers.get('authorization', '')",
    "    return query_token == TOKEN or auth == f'Bearer {TOKEN}'",
    "",
    "@app.get('/health')",
    "async def health():",
    "    return JSONResponse({'ok': True, 'transport': 'tui_gateway'})",
    "",
    "@app.websocket('/api/ws')",
    "async def gateway_ws(ws: WebSocket):",
    "    if not _authorized(ws):",
    "        await ws.close(code=4401)",
    "        return",
    "    await handle_ws(ws)",
    "",
    "if __name__ == '__main__':",
    "    import uvicorn",
    "    host = os.environ.get('MIA_HERMES_GATEWAY_HOST', '0.0.0.0')",
    "    port = int(os.environ.get('MIA_HERMES_GATEWAY_PORT') or os.environ.get('API_SERVER_PORT') or '8765')",
    "    uvicorn.run(app, host=host, port=port, log_level='info')",
    ""
  ].join("\\n");
}

function gatewayWsUrlForBaseUrl(baseUrl, apiKey, wsPath = "/api/ws") {
  const base = cleanBaseUrl(baseUrl);
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = String(wsPath || "/api/ws").startsWith("/")
    ? String(wsPath || "/api/ws")
    : `/${wsPath}`;
  url.search = "";
  if (apiKey) url.searchParams.set("token", apiKey);
  return url.toString();
}
```

改 `ensureUserDirs()`：

- 继续写 `config.yaml`。
- 额外写 gateway shim 文件。

改 `ensureWorker()` 返回值：

```js
return {
  userId: paths.userId,
  baseUrl,
  gatewayWsUrl: explicitGatewayWsUrl || gatewayWsUrlForBaseUrl(baseUrl, apiKey, wsPath),
  apiKey,
  model,
  modelProvider,
  modelApiMode,
  paths,
  env: envForUser(paths.userId),
  containerName: name
};
```

改 `startDockerContainer()`：

- gateway 模式下传：
  - `MIA_HERMES_GATEWAY_TOKEN=${apiKey}`
  - `MIA_HERMES_GATEWAY_PORT=${containerPort}`
  - `MIA_HERMES_GATEWAY_HOST=0.0.0.0`
- docker args 在 image 后追加：

```js
const dockerArgs = baseDockerArgs.concat([image]);
dockerArgs.push("python", `/data/hermes-home/${GATEWAY_SHIM_FILENAME}`);
```

验收测试：

- static mode 能从 `baseUrl` 推导 `gatewayWsUrl`。
- docker mode 会写 shim 文件。
- docker args 会追加 python shim 命令。
- 不再有 runs 相关分支。

## 任务 1.5：锁定 `mia-auto` / DeepSeek 兼容

修改文件：

- `src/cloud-agent/cloud-hermes-model.js`
- `src/cloud-agent/hermes-worker-manager.js`
- `tests/cloud-agent-hermes-client.test.js`
- `tests/cloud-agent-hermes-im-client.test.js`

规则：

- `DEFAULT_CLOUD_HERMES_MODEL` 保持 `"mia-auto"`。
- `normalizeCloudHermesModel("", { defaultModel: worker.model })` 在 worker.model 是 `"mia-auto"` 时必须返回 `"mia-auto"`。
- 用户配置为空、`auto`、`default`、`hermes`、`mia`、`mia:auto`、`mia-default` 时都归一到 `"mia-auto"`。
- `workerManager.renderHermesConfig()` 必须继续写：

```yaml
model:
  provider: "mia"
  default: "mia-auto"
  base_url: "https://mia.example.invalid/api/internal/model-proxy/v1"
  api_mode: "chat_completions"

providers:
  "mia":
    name: "Mia Billing"
    base_url: "https://mia.example.invalid/api/internal/model-proxy/v1"
    key_env: "MIA_CLOUD_AGENT_MODEL_API_KEY"
    default_model: "mia-auto"
    api_mode: "chat_completions"
```

`hermes-im-client.js` 创建 session 时必须显式传模型和 provider：

```js
const model = normalizeCloudHermesModel(args.model, { defaultModel: args.workerModel || "mia-auto" });
const provider = String(args.modelProvider || "mia").trim() || "mia";
await gateway.request("session.create", {
  title: botDisplayName(args.bot, botKey(args.bot)),
  source: "mia-cloud",
  cwd: "/data/workspace",
  model,
  provider,
  reasoning_effort: args.effortLevel || "medium",
  messages: normalizeSeedMessages(args.seedMessages || [])
});
```

测试覆盖：

- `normalizeCloudHermesModel("auto", { defaultModel: "mia-auto" })` 返回 `"mia-auto"`。
- `normalizeCloudHermesModel("mia-auto", { defaultModel: "mia-auto" })` 返回 `"mia-auto"`。
- `session.create` 请求里包含 `model: "mia-auto"` 和 `provider: "mia"`。
- 用户显式配置其它模型时才传其它模型；不显式配置时绝不落到 Hermes 自己的默认模型。

## 任务 2：新增低层 JSON-RPC WebSocket Client

新增文件：

- `src/cloud-agent/hermes-gateway-client.js`
- `tests/cloud-agent-hermes-gateway-client.test.js`

实现目标：

- CommonJS 版本的 Hermes `JsonRpcGatewayClient`。
- 使用现有依赖 `ws`，不新增 npm package。
- 支持 EventEmitter 形态和浏览器 `addEventListener` 形态，方便测试。
- 支持 JSON-RPC request/response、event dispatch、request timeout、abort、close。
- 能处理单个 WS frame 里有多行 JSON 的情况。

核心接口：

```js
function createHermesGatewayClient(deps = {}) {
  const WebSocketImpl = deps.WebSocket || require("ws");
  const requestTimeoutMs = Number(deps.requestTimeoutMs || 120000);
  const connectTimeoutMs = Number(deps.connectTimeoutMs || 15000);
  let socket = null;
  let nextId = 0;
  const pending = new Map();
  const handlers = new Map();

  function on(type, handler) {
    const set = handlers.get(type) || new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  }

  function emit(event) {
    for (const handler of handlers.get(event.type) || []) handler(event);
    for (const handler of handlers.get("*") || []) handler(event);
  }

  function handleFrame(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
    for (const line of text.split(/\\n+/).map((item) => item.trim()).filter(Boolean)) {
      let frame = null;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.id !== undefined && frame.id !== null) {
        const call = pending.get(frame.id);
        if (!call) continue;
        clearTimeout(call.timer);
        pending.delete(frame.id);
        if (frame.error) call.reject(new Error(frame.error.message || "Hermes RPC failed"));
        else call.resolve(frame.result);
        continue;
      }
      if (frame.method === "event" && frame.params?.type) emit(frame.params);
    }
  }

  async function connect(wsUrl) {
    if (socket && socket.readyState === WebSocketImpl.OPEN) return;
    socket = new WebSocketImpl(wsUrl);
    addSocketListener(socket, "message", (event) => handleFrame(event.data ?? event));
    await waitForOpen(socket, connectTimeoutMs);
  }

  function request(method, params = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? requestTimeoutMs);
    const id = `m${++nextId}`;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request timed out: ${method}`));
        }, timeoutMs)
        : null;
      pending.set(id, { resolve, reject, timer });
      socket.send(payload);
    });
  }

  function close() {
    if (!socket) return;
    try { socket.close(); } catch {}
    socket = null;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new Error("Hermes gateway connection closed"));
      pending.delete(id);
    }
  }

  return { connect, request, on, close };
}
```

测试覆盖：

- `request()` 发出的 frame 是 `{jsonrpc:"2.0",id,method,params}`。
- 收到同 id response 后 resolve。
- 收到 `method:"event"` 且 `params.type` 后触发 handler。
- 多行 JSON frame 能逐行处理。
- request timeout 会 reject 并清理 pending。
- close 会 reject 未完成请求。

## 任务 3：新增 Hermes session 映射表和 store

修改文件：

- `src/cloud/sqlite-store.js`
- `tests/cloud-agent-stores.test.js`

新增文件：

- `src/cloud-agent/cloud-hermes-sessions-store.js`

新增表，migration 版本用 `23`：

```sql
CREATE TABLE IF NOT EXISTS cloud_hermes_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  runtime_session_id TEXT NOT NULL DEFAULT '',
  stored_session_id TEXT NOT NULL DEFAULT '',
  last_trigger_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, bot_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_hermes_sessions_conversation
  ON cloud_hermes_sessions(conversation_id, updated_at);
```

store API：

```js
function createCloudHermesSessionsStore(db) {
  function getSession(userId, botId, conversationId) {}
  function upsertSession({ userId, botId, conversationId, runtimeSessionId, storedSessionId, lastTriggerMessageId }) {}
  function clearRuntimeSession(userId, botId, conversationId) {}
  return { getSession, upsertSession, clearRuntimeSession };
}
```

规则：

- `stored_session_id` 是 Hermes DB 里的持久 session key，优先保存。
- `runtime_session_id` 是当前 gateway 进程内的短 id，worker 重启后可能失效。
- 如果 `prompt.submit` 返回 session not found，清掉 `runtime_session_id`，再用 `stored_session_id` 走 `session.resume`。
- 如果没有 `stored_session_id`，走 `session.create`。

测试覆盖：

- 新库包含 `cloud_hermes_sessions`。
- migration 记录包含 `23`。
- upsert 后能按 `userId + botId + conversationId` 读回。
- clear runtime 只清 `runtime_session_id`，不清 `stored_session_id`。

## 任务 4：新增 Gateway 事件归一化

新增文件：

- `src/cloud-agent/hermes-gateway-events.js`
- `tests/cloud-agent-hermes-gateway-events.test.js`

修改文件：

- `src/shared/assistant-content-blocks.js`
- `tests/assistant-content-blocks.test.js`

Hermes gateway event 形态是：

```json
{
  "type": "message.delta",
  "session_id": "abc123",
  "payload": { "text": "你好" }
}
```

Mia 当前 collector 更偏 `/v1/runs` 形态，所以先归一化：

```js
function normalizeGatewayEvent(event = {}) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const sourceType = String(event.type || "").trim();
  const typeMap = {
    "reasoning.delta": "reasoning_delta",
    "thinking.delta": "thinking_delta",
    "tool.start": "tool.started",
    "tool.progress": "tool.delta",
    "tool.complete": "tool.completed"
  };
  const type = typeMap[sourceType] || sourceType;
  return Object.assign({
    type,
    session_id: event.session_id || event.sessionId || "",
    rawGatewayEvent: event
  }, payload);
}
```

同时让 `createAssistantContentBlockCollector()` 原生接受 Hermes 名字，避免未来重复归一化：

- `reasoning.delta`
- `thinking.delta`
- `tool.start`
- `tool.progress`
- `tool.complete`

`createTraceCollector()` 在 `dispatcher.js` 里也要使用归一化事件，否则工具 trace 会丢。

测试覆盖：

- `message.delta` 的 `payload.text` 被提取成 text block。
- `reasoning.delta` 被提取成 thinking block。
- `tool.start/tool.complete` 被提取成 tool block。
- `approval.request` 保持原名，方便前端继续用现有权限 banner。

## 任务 5：新增 Hermes IM 高层 client

新增文件：

- `src/cloud-agent/hermes-im-client.js`
- `src/cloud-agent/hermes-im-attachments.js`
- `tests/cloud-agent-hermes-im-client.test.js`
- `tests/cloud-agent-hermes-im-attachments.test.js`

目标：提供一个清晰的 gateway-only `runChat()` 接口，让 dispatcher 不再认识旧 runs client。

接口：

```js
function createHermesImClient(deps = {}) {
  return {
    runChat,
    submitApproval
  };
}
```

`runChat()` 参数沿用现在的调用：

```js
await hermesImClient.runChat({
  gatewayWsUrl,
  apiKey,
  userId,
  bot,
  conversationId,
  sessionId,
  instructions,
  model,
  workerModel,
  modelProvider,
  effortLevel,
  permissionMode,
  input,
  seedMessages,
  attachments,
  onRunCreated,
  onEvent,
  signal
});
```

session 创建和恢复：

```js
async function ensureGatewaySession({ gateway, sessionsStore, args }) {
  const existing = sessionsStore.getSession(args.userId, botKey(args.bot), args.conversationId);
  if (existing?.storedSessionId) {
    try {
      const resumed = await gateway.request("session.resume", {
        session_id: existing.storedSessionId,
        cols: 100,
        cwd: "/data/workspace"
      });
      return rememberSession(resumed, existing);
    } catch (error) {
      sessionsStore.clearRuntimeSession(args.userId, botKey(args.bot), args.conversationId);
    }
  }

  const model = normalizeCloudHermesModel(args.model, { defaultModel: args.workerModel || "mia-auto" });
  const provider = String(args.modelProvider || "mia").trim() || "mia";
  const created = await gateway.request("session.create", {
    title: botDisplayName(args.bot, botKey(args.bot)),
    source: "mia-cloud",
    cwd: "/data/workspace",
    model,
    provider,
    reasoning_effort: args.effortLevel || "medium",
    messages: normalizeSeedMessages(args.seedMessages || [])
  });
  return rememberSession(created, null);
}
```

附件同步：

```js
async function syncHermesImAttachments({ gateway, sessionId, attachments = [] }) {
  const refs = [];
  const attached = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      const result = await gateway.request("image.attach", {
        session_id: sessionId,
        path: attachment.path
      });
      attached.push(result);
      continue;
    }
    if (attachment.kind === "pdf") {
      const result = await gateway.request("pdf.attach", {
        session_id: sessionId,
        path: attachment.path
      });
      attached.push(result);
      continue;
    }
    const result = await gateway.request("file.attach", {
      session_id: sessionId,
      path: attachment.path,
      name: attachment.name
    });
    attached.push(result);
    if (result.ref_text) refs.push(result.ref_text);
  }
  return { attached, promptPrefix: refs.join("\\n") };
}
```

发送 prompt：

```js
async function submitAndWait({ gateway, sessionId, text, onEvent, signal }) {
  let finalText = "";
  const events = [];
  let completed = false;
  let failure = "";
  const off = gateway.on("*", (event) => {
    if (event.session_id && event.session_id !== sessionId) return;
    const normalized = normalizeGatewayEvent(event);
    events.push(normalized);
    onEvent?.(normalized);
    if (normalized.type === "message.delta" && typeof normalized.text === "string") {
      finalText += normalized.text;
    }
    if (normalized.type === "message.complete") {
      completed = true;
      finalText = normalized.text || normalized.content || finalText;
    }
    if (normalized.type === "error") {
      failure = normalized.message || "Hermes gateway error";
    }
  });

  try {
    await gateway.request("prompt.submit", { session_id: sessionId, text }, { timeoutMs: 1800000, signal });
    await waitUntil(() => completed || failure, { timeoutMs: 1800000, signal });
  } finally {
    off();
  }
  if (failure) throw new Error(failure);
  return { content: finalText, events };
}
```

approval：

```js
async function submitApproval({ gatewayWsUrl, sessionId, choice, all = false }) {
  const gateway = createHermesGatewayClient();
  try {
    await gateway.connect(gatewayWsUrl);
    return await gateway.request("approval.respond", {
      session_id: sessionId,
      choice,
      all
    });
  } finally {
    gateway.close();
  }
}
```

测试覆盖：

- 无 mapping 时调用 `session.create`，保存 `runtime_session_id` 和 `stored_session_id`。
- 有 `stored_session_id` 时调用 `session.resume`。
- resume 失败后会重新 `session.create`。
- 图片走 `image.attach`。
- PDF 走 `pdf.attach`。
- 普通文件走 `file.attach`，并把 `ref_text` prepend 到 prompt。
- `message.delta` 可以实时触发 `onEvent`。
- `message.complete` 决定最终 `content`。
- `approval.request` 可以实时触发 `onEvent`，不阻塞前端权限弹窗。

## 任务 6：接入 Cloud Agent Dispatcher

修改文件：

- `src/cloud-agent/dispatcher.js`
- `src/cloud-agent/group-orchestrator.js`
- `scripts/serve-cloud.js`
- `tests/cloud-agent-dispatcher.test.js`

`scripts/serve-cloud.js` 初始化时新增：

```js
let createHermesImClient = null;
let createCloudHermesSessionsStore = null;
```

创建 store 和 client：

```js
context.cloudHermesSessionsStore = createCloudHermesSessionsStore
  ? createCloudHermesSessionsStore(context.cloudStore.getDb())
  : null;

const cloudAgentHermesImClient = options.cloudAgentHermesImClient
  || (cloudAgentWorkerManager && context.cloudHermesSessionsStore && createHermesImClient
    ? createHermesImClient({ sessionsStore: context.cloudHermesSessionsStore })
    : null);
```

传入 dispatcher：

```js
context.cloudAgentDispatcher = createCloudAgentDispatcher({
  socialStore: context.socialStore,
  messagesStore: context.messagesStore,
  botsStore: context.botsStore,
  runtimeBindingsStore: context.runtimeBindingsStore,
  cloudAgentRunsStore: context.cloudAgentRunsStore,
  workerManager: cloudAgentWorkerManager,
  hermesImClient: cloudAgentHermesImClient,
  attachmentMaterializer: createAttachmentMaterializer
    ? createAttachmentMaterializer({ cloudStore: context.cloudStore })
    : null,
  broadcastPersistedEvent: (userId, payload) => broadcastPersistedEvent(context, userId, payload),
  broadcastTransientEvent: (userId, payload) => broadcastTransientEvent(context.eventHub, userId, payload),
  getUserPublic: (userId) => context.cloudStore.getUserPublic(userId),
  listBridgeDevices: (userId, options = {}) => bridgeDevices(context.bridgeHub, userId, {
    includeOffline: options.includeOffline,
    cloudStore: context.cloudStore
  }),
  createScheduledTask: (userId, input) => context.cloudTasksService.create(userId, input),
  skillsCatalog
});
```

`dispatcher.js` 不再选择 runtime；`cloud-hermes` 只允许 gateway client：

```js
const hermesImClient = requireDep(deps, "hermesImClient");

function assertGatewayWorker(worker = {}) {
  if (!worker.gatewayWsUrl) {
    throw new Error("Cloud Hermes gateway URL missing. Worker must expose /api/ws.");
  }
}
```

在 `runHermesInline()` 里：

- `worker = await workerManager.ensureWorker(ownerId)` 后选择 client。
- gateway 模式调用：

```js
await hermesImClient.runChat({
  gatewayWsUrl: worker.gatewayWsUrl,
  apiKey: worker.apiKey,
  userId: ownerId,
  bot,
  conversationId,
  instructions: cloudRuntimeInstructions(bot, message),
  model: normalizeCloudHermesModel(runtimeConfig.model, { defaultModel: worker.model || "mia-auto" }),
  workerModel: worker.model || "mia-auto",
  modelProvider: worker.modelProvider || "mia",
  effortLevel: runtimeConfig.effortLevel || "medium",
  permissionMode: runtimeConfig.permissionMode || "ask",
  input: [
    buildSkillMaterializationContext(skillMaterialization),
    conversationInput
  ].filter(Boolean).join("\n\n"),
  seedMessages: seedMessagesForHermes(
    messagesStore.listMessagesSince(conversationId, 0, DESKTOP_INVOCATION_HISTORY_LIMIT),
    message.id
  ),
  attachments: materialized.attachments || [],
  onRunCreated,
  onEvent
});
```

- 删除 runs 模式调用。
- `onRunCreated()` 对 gateway 模式写入 `gw:${runtimeSessionId}`。
- `finalRunEvents` 继续进入 artifact archive。

seed history：

```js
function seedMessagesForHermes(messages, currentMessageId) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.id !== currentMessageId)
    .filter((message) => message.sender_kind === "user" || message.sender_kind === BOT_SENDER_KIND)
    .slice(-40)
    .map((message) => ({
      role: message.sender_kind === BOT_SENDER_KIND ? "assistant" : "user",
      content: String(message.body_md || "").trim()
    }))
    .filter((message) => message.content);
}
```

`respondApproval()`：

- 只走 `hermesImClient.submitApproval()`。
- 如果 `run.hermesRunId` 不是 `gw:` 前缀，返回 `{ ok: false, error: "run is not a Hermes gateway session" }`，并记录日志，不能调用 `/v1/runs/{runId}/approval`。
- gateway approval 的 `sessionId` 从 `gw:${runtimeSessionId}` 解析；如果为空，再从 `cloud_hermes_sessions` 按 `run.userId + run.botId + run.conversationId` 查询。

`group-orchestrator.js`：

- 参数名改为 `hermesImClient`。
- conductor 也能用 gateway `runChat()`。
- conductor 使用 transient session，不写入 `cloud_hermes_sessions` 的正式 bot conversation mapping，避免污染用户对话 session。

测试覆盖：

- gateway worker 优先调用 `hermesImClient.runChat()`。
- 无 gateway 时写入用户可见错误，不调用旧 runs client。
- gateway 事件仍广播为 `cloud_agent_run_event`。
- gateway final reply 写入 `messages`，trace/content blocks 保留。
- gateway approval route 最终调用 `approval.respond`。
- 非 gateway run id 的 approval 返回 409。
- group conductor 在 gateway client 下仍能选择 bot。

## 任务 7：附件和产物保持 Mia 现有体验

沿用现有文件：

- `src/cloud-agent/attachment-materializer.js`

规则：

- 用户上传附件仍先由 Mia materialize 到 worker bind mount。
- gateway attach 使用容器路径，也就是 `attachment.path`，例如 `/data/attachments/car_123/1-input.txt`。
- 普通文件 `file.attach` 返回的 `ref_text` 必须加入 prompt 前缀，Hermes 才能通过 `@file:` 读取。
- `archiveGeneratedAttachments()` 继续从最终文本、events、tool result 中扫描 `/data/workspace` 和 `/data/home` 路径。
- `redactGeneratedArtifactPaths()` 继续在最终回复和 trace 里隐藏内部路径。

需要补一类测试：

- gateway `tool.complete.payload.result` 里包含 `/data/workspace/out.csv` 时，最终 reply attachments 能归档这个文件。

## 任务 8：并发和超时

新增约束：

- 同一个 `userId + botId + conversationId` 同时只允许一个 gateway turn。
- 如果同会话已有 turn 在跑，dispatcher 按当前行为串行等待，不新开第二个 Hermes session。
- `prompt.submit` ack timeout 使用 Hermes desktop 的 `1_800_000ms`。
- 等 `message.complete` 的 timeout 也使用 `1_800_000ms`，可通过 `MIA_CLOUD_HERMES_TURN_TIMEOUT_MS` 覆盖。

实现位置：

- 在 `hermes-im-client.js` 放一个 `locks` Map。
- key 为 `${userId}:${botId}:${conversationId}`。
- 每个 `runChat()` 进入前排队，结束后释放。

## 任务 8.5：删除旧 `/v1/runs` 逻辑

删除文件：

- `src/cloud-agent/hermes-runs-client.js`
- `tests/cloud-agent-hermes-runs-client.test.js`

修改文件：

- `scripts/serve-cloud.js`
- `src/cloud-agent/dispatcher.js`
- `src/cloud-agent/group-orchestrator.js`
- `tests/cloud-agent-hermes-client.test.js`
- `tests/cloud-agent-dispatcher.test.js`
- `tests/cloud-agent-stores.test.js`

要求：

- 删除 `createHermesRunsClient` 的 require 兼容分支。
- 删除 `hermesRunsClient` 依赖注入。
- 删除 `/v1/runs`、`/v1/runs/{runId}/events`、`/v1/runs/{runId}/approval` 相关测试断言。
- `cloud_agent_runs.hermes_run_id` 字段可以先保留，但含义改成运行时外部 id；gateway 模式写 `gw:${runtimeSessionId}`。
- `tests/project-structure-check.test.js` 如果有文件存在性断言，需要改成断言不存在旧 runs client。

删除后的检查：

```bash
rg -n "hermesRunsClient|createHermesRunsClient|/v1/runs|submitApproval\\(\\{ baseUrl" src scripts tests
```

期望：

- 只允许在迁移注释或历史文档里出现 `/v1/runs`。
- `src/`、`scripts/`、`tests/cloud-*` 里不再出现 `hermesRunsClient` 或 `createHermesRunsClient`。

## 任务 9：验证

先跑单元测试：

```bash
node --test tests/cloud-agent-hermes-gateway-client.test.js
node --test tests/cloud-agent-hermes-im-client.test.js
node --test tests/cloud-agent-hermes-im-attachments.test.js
node --test tests/cloud-agent-hermes-gateway-events.test.js
node --test tests/cloud-agent-stores.test.js
node --test tests/cloud-agent-hermes-client.test.js
node --test tests/cloud-agent-dispatcher.test.js
```

再跑项目检查：

```bash
npm run check
```

本地手测：

```bash
MIA_CLOUD_AGENT_MODE=docker \
MIA_CLOUD_HERMES_IMAGE=mia-hermes-agent:local \
npm run cloud
```

手测场景：

- 普通文字私聊，能流式看到回复。
- 发送图片，Hermes 能读取图片。
- 发送文本或代码文件，Hermes 能通过 `@file:` 引用读取。
- 让 Hermes 执行一个需要 approval 的命令，Mia 前端出现权限弹窗，允许后继续流式输出。
- 重启 worker 后同一个 Mia conversation 再发一条消息，能通过 `stored_session_id` resume。
- group chat 多 bot 场景，conductor 仍能选择发言 bot。

## 失败策略

- 不走备用路径。
- worker 没有 `gatewayWsUrl` 时，Mia 写一条用户可见错误：`云端 Hermes gateway 未启动，请检查 worker 配置。`
- gateway 连接失败时，Mia 写一条用户可见错误：`云端 Hermes gateway 连接失败，请稍后再试。`
- 错误 trace 里保留机器可读类型：`cloud_hermes_gateway_unavailable` 或 `cloud_hermes_gateway_connect_failed`。
- 日志写具体底层错误，但不把 token、内部 URL query 参数或模型代理 token 写入日志。

## 完成定义

- Mia cloud-hermes 只走 gateway IM 协议。
- active cloud-hermes 代码里没有 `/v1/runs` 备用路径。
- `mia-auto` 在 worker config、session.create 和测试中都保持为 Mia 托管 DeepSeek 默认模型。
- 附件、approval、trace/content blocks、产物归档都保持现有 Mia 体验。
- Hermes session 能跨消息延续，worker 重启后能用 `stored_session_id` 恢复。
- 所有任务 9 的测试通过。
