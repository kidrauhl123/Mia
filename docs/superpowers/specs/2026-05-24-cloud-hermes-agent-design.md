# 云端 Hermes Agent 设计

状态：已确认设计，待写实施计划
日期：2026-05-24

## 1. 背景

Mia 现在的核心模型已经逐步收敛到：

- `rooms` 是统一会话入口，`type='fellow'` 表示用户与自己的 Fellow 私聊。
- `messages` 是统一消息流，Fellow 回复也是同一张表里的 `sender_kind='fellow'` 消息。
- `user_events` 是登录用户的持久事件回放通道。
- `fellows` 只保存身份形状：名字、头像、人设、能力等；runtime 配置不放在这里。
- 桌面端 Hermes 已经通过 `POST /v1/runs`、`GET /v1/runs/{run_id}/events`、`X-Mia-Fellow`、`conversation_history` 等机制发送对话，并通过 Hermes overlay 注入 Fellow 人设。

本设计要把“本地运行的 Hermes Agent”扩展为“云端运行的 Hermes Agent”，但用户视角不应出现两套产品：云端 Agent 仍然是一个普通 Fellow，只是运行位置从本机变成服务器。

## 2. 目标

1. 新注册或登录到 Web 的用户自动获得一个默认 cloud-backed Fellow，先只做一个 Fellow。
2. Web 端注册完成后可以直接和该 Fellow 对话；桌面端登录同一账号后也能看到并继续同一类 Fellow 会话。
3. 云端 Agent 与本地 Agent 复用现有 Fellow、room、message、event、Hermes `/v1/runs` 语义，不建立割裂的“云端聊天 API”。
4. 多用户文件系统必须硬隔离。一个用户的 Hermes 工具、终端、代码执行、附件、产物不能看到或写到另一个用户的数据。
5. Fellow 身份和 runtime 绑定分离，保留现有 `fellows` 表“只存身份”的边界。
6. 为后续多个 cloud-backed Fellows、审批 UI、生成文件回传留下自然扩展点。

## 3. 非目标

- 本期不做多个默认云端 Fellows；只创建一个默认 Fellow。
- 本期不把 Claude Code、Codex 迁到云端。
- 本期不重写 Hermes 工具系统，也不 fork Hermes。
- 本期不实现跨服务器联邦或端到端加密。
- 本期不把 cloud-backed Fellow 做成新的联系人类型；它仍然是 Fellow。
- 本期不把所有危险工具默认静默放行；需要审批的能力仍走 Hermes/Mia 的审批事件。

## 4. 关键决策

### 4.1 Fellow 是身份，Cloud Hermes 是 runtime 绑定

继续让 `fellows` 保存身份，不把端口、容器、模型、路径等运行信息塞进去。新增 runtime 绑定表：

```sql
CREATE TABLE fellow_runtime_bindings (
  user_id      TEXT NOT NULL,
  fellow_id    TEXT NOT NULL,
  runtime_kind TEXT NOT NULL, -- 'cloud-hermes' | 'desktop-local'
  enabled      INTEGER NOT NULL DEFAULT 1,
  config_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, fellow_id, runtime_kind)
);
CREATE INDEX idx_fellow_runtime_bindings_user
  ON fellow_runtime_bindings(user_id, enabled);
```

默认云端 Fellow 的身份记录在 `fellows` 中，运行方式由 `fellow_runtime_bindings.runtime_kind='cloud-hermes'` 表达。这样同一个 Fellow 概念可以被 Web、桌面端、后续移动端复用。

### 4.2 每用户一个 Hermes worker，使用容器级文件隔离

云端不能用一个全局 Hermes 进程服务所有用户。Hermes 工具包含终端、文件读写、补丁、搜索、代码执行、浏览器、图片生成等能力；仅靠 prompt、环境变量或 `HERMES_WRITE_SAFE_ROOT` 无法阻止终端命令访问宿主或其他用户目录。

本期采用“每用户 Hermes worker 容器”的隔离模型：

```text
/var/lib/mia-cloud-agent-users/<userId>/
  hermes-home/
  home/
  workspace/
  attachments/
  logs/
```

容器内只挂载该用户目录：

```text
/data/hermes-home
/data/home
/data/workspace
/data/attachments
/data/logs
```

容器环境：

```text
HERMES_HOME=/data/hermes-home
HOME=/data/home
TERMINAL_CWD=/data/workspace
HERMES_WRITE_SAFE_ROOT=/data/workspace
```

worker 的 Hermes API 只监听容器内或宿主 `127.0.0.1` 随机端口，由 cloud 进程代理调用。容器不挂载 Docker socket，不挂载全局上传目录，不挂载其他用户目录，并设置 CPU、内存、进程数、磁盘配额和空闲回收。

### 4.3 对话流复用现有 room/message/event

默认 Fellow 会话使用已有 fellow room 语义：

```text
room.id = fellow:<userId>:<fellowId>
room.type = fellow
room_members:
  { member_kind: 'user', member_ref: userId }
  { member_kind: 'fellow', member_ref: fellowId, owner_id: userId }
```

用户在 Web 或桌面端发送消息时，仍走现有 `/api/rooms/:roomId/messages`。服务端写入用户消息并广播 `user_events` 后，cloud agent dispatcher 识别该 room 绑定了 `cloud-hermes` runtime，创建一次 agent run。

dispatcher 调用该用户的 worker Hermes：

```text
POST /v1/runs
X-Mia-Fellow: <fellowId>
X-Alkaka-Fellow: <fellowId>
X-Hermes-Session-Key: cloud:<userId>:<fellowId>:<roomId>
```

请求体包含：

```json
{
  "model": "hermes-agent",
  "input": "<latest user input>",
  "session_id": "cloud:<userId>:<fellowId>:<roomId>",
  "conversation_history": [],
  "metadata": {
    "fellow_key": "<fellowId>",
    "persona_key": "<fellowId>",
    "account_id": "<userId>",
    "route_profile": "cloud-hermes",
    "room_id": "<roomId>"
  }
}
```

`conversation_history` 从当前 room 的 messages 转换，规则复用本地 Hermes adapter 的语义：用户消息映射为 user，Fellow 消息映射为 assistant，system 消息保持 system。Hermes SSE 的最终文本写回同一个 `messages` 表：

```js
messagesStore.appendMessage({
  roomId,
  senderKind: "fellow",
  senderRef: fellowId,
  senderOwnerId: userId,
  bodyMd: finalText,
  status: "complete"
});
```

写入后通过 `user_events` 广播 `room.message_appended`，Web 和桌面端都按现有消息源刷新。

## 5. 注册与登录引导

在用户注册成功、首次登录或 cloud bootstrap 时执行幂等 ensure：

1. 确保默认 Fellow 存在：`id='mia'`，owner 是当前用户，persona 文本写入 `fellows.persona_text`。
2. 确保 `fellow_runtime_bindings(userId, 'mia', 'cloud-hermes')` 存在且 enabled。
3. 确保 `fellow:<userId>:mia` room 存在，且 room members 包含该 user 和该 Fellow。
4. 确保用户列表和 room bootstrap 会返回这个 room。

所有 ensure 都必须幂等，避免多端同时登录创建重复 room 或重复 binding。

## 6. 模块划分

新增代码放在独立目录，避免继续扩大 `scripts/serve-cloud.js`：

```text
src/cloud-agent/
  default-fellow.js
  runtime-bindings-store.js
  cloud-agent-runs-store.js
  dispatcher.js
  hermes-worker-manager.js
  hermes-runs-client.js
  attachment-materializer.js
```

职责边界：

- `default-fellow.js`：注册/登录/bootstrap 的默认 Fellow、binding、room 幂等创建。
- `runtime-bindings-store.js`：`fellow_runtime_bindings` 的 CRUD 和查询。
- `cloud-agent-runs-store.js`：记录 cloud run 状态、Hermes run id、错误、重试信息。
- `dispatcher.js`：监听用户消息写入后的触发点，判断是否需要 cloud Hermes 回复。
- `hermes-worker-manager.js`：按 userId 启动、复用、健康检查、停止 worker 容器。
- `hermes-runs-client.js`：封装 Hermes `/v1/runs` 和 SSE 读取，保持与本地 Hermes adapter 语义一致。
- `attachment-materializer.js`：把用户附件安全地映射进容器，并把生成产物写回该用户的 cloud files。

`scripts/serve-cloud.js` 只负责组装依赖和挂载路由，不承载 agent 业务逻辑。

## 7. 文件与附件隔离

### 7.1 输入附件

`/api/files` 仍是附件权威来源，且必须按用户鉴权读取。cloud agent run 只能通过类似 `getFileForUser(userId, fileId)` 的接口解析附件，不能直接拼路径访问上传目录。

运行前，`attachment-materializer` 将该用户本次消息可见的附件复制或硬链接到：

```text
/var/lib/mia-cloud-agent-users/<userId>/attachments/<fileId>/
```

容器内看到的是：

```text
/data/attachments/<fileId>/
```

消息和工具结果中不暴露宿主绝对路径。

### 7.2 生成文件

Hermes 在 `/data/workspace` 或 `/data/attachments` 生成的可交付文件，需要通过 cloud files store 归档为当前用户的文件记录，再以普通附件或链接形式写回消息。归档时服务端强制使用当前 run 的 `userId`，不接受 Hermes 返回的 owner。

### 7.3 目录与权限

用户容器只挂载自己的 `/var/lib/mia-cloud-agent-users/<userId>` 子树。即使 Hermes 终端执行 `ls /`、`find /data` 或脚本读写，也只能看到容器内命名空间和该用户目录。服务器宿主文件、其他用户目录、cloud sqlite、全局 uploads 目录都不进入容器挂载。

## 8. 运行状态、并发与恢复

新增 `cloud_agent_runs` 表：

```sql
CREATE TABLE cloud_agent_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  fellow_id       TEXT NOT NULL,
  room_id         TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  hermes_run_id   TEXT,
  status          TEXT NOT NULL, -- queued | running | complete | error | cancelled
  error_json      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_cloud_agent_runs_room
  ON cloud_agent_runs(room_id, created_at);
```

同一个 `room_id` 默认串行处理，避免同一 Fellow 在同一会话里并发回复导致消息顺序错乱。不同用户、不同 room 可以并行。

服务重启后：

1. `queued` run 可以重新调度。
2. `running` run 标记为 `error` 或尝试查询 Hermes run 状态；本期可先标记 error，并给 room 写一条简短系统错误消息。
3. worker 容器按需懒启动，空闲超时停止，用户再次发消息时恢复。

## 9. Hermes 事件与审批

Hermes SSE 事件分两类处理：

- 最终 assistant 文本写入 `messages`。
- 工具进度、token delta、审批请求等 transient 状态映射到 Mia room/run 事件，用于 UI 展示。

需要人工确认的终端命令、文件写入或外部访问不能被 cloud dispatcher 静默绕过。审批请求应通过 Mia 现有 room/event 通道送到对应登录用户；用户批准后由 cloud 进程调用 Hermes approval endpoint，拒绝则取消对应工具调用或 run。

本期可以先保证最终文本闭环，但接口设计必须保留 `run.pending_approval` 这类事件，不把审批做死成“永远允许”。

## 10. 安全约束

必须满足：

1. worker 隔离粒度是 user，不是 fellow；同一用户多个 Fellow 未来可共享该用户工作区。
2. `userId` 只能来自已认证请求上下文或服务端调度上下文，不能来自客户端 body。
3. 所有 room、message、file、fellow、binding 查询都必须带 `userId` 或成员关系校验。
4. 容器不挂载宿主敏感目录、cloud sqlite、全局 uploads、Docker socket、其他用户目录。
5. worker API 不对公网开放。
6. 任何 Hermes 返回的路径都当作不可信字符串处理，不能直接作为宿主读取路径。
7. 日志按用户分目录保存，集中日志只记录 run id、room id、user id，不记录完整敏感文件内容。

## 11. 测试计划

单元测试：

- 默认 Fellow ensure：重复调用不会创建重复 fellow、binding、room、member。
- runtime binding store：按 userId/fellowId 查询，禁用 binding 后不会触发 run。
- dispatcher：只有 `room.type='fellow'` 且有 enabled `cloud-hermes` binding 时触发云端 run。
- Hermes run payload：包含正确 session id、Fellow header、metadata、conversation history。
- attachment materializer：用户 A 不能 materialize 用户 B 的 file id。

集成测试：

- 新用户注册或 bootstrap 后，`GET /api/rooms` 返回默认 fellow room。
- Web 发送消息到默认 fellow room 后，服务端追加 user message，并调度一次 cloud agent run。
- Hermes client fake SSE 返回文本后，`messages` 追加 `sender_kind='fellow'` 消息，并写入 `user_events`。
- 两个用户同时发消息时，worker manager 使用不同 user root、不同 HOME、不同 HERMES_HOME。
- 生成文件归档到正确用户，另一个用户无法通过 file API 读取。

手动验证：

- 新浏览器注册账号，直接看到默认 Fellow 并能对话。
- 桌面端登录同一账号，能看到同一个 fellow room 和消息历史。
- 在用户 A 的云端 Agent 中创建文件，用户 B 的 Agent 看不到。
- worker 容器重启后，用户再次发消息可以懒启动恢复。

## 12. 实施顺序

1. 加数据库迁移：`fellow_runtime_bindings`、`cloud_agent_runs`。
2. 实现 `runtime-bindings-store.js` 和 `cloud-agent-runs-store.js`。
3. 实现 `default-fellow.js`，挂到注册/登录/bootstrap 的幂等 ensure。
4. 实现 `hermes-runs-client.js`，用 fake Hermes 测试 payload 与 SSE 汇聚。
5. 实现 `hermes-worker-manager.js` 的接口和本地 dev fake；生产容器启动作为同一接口的实现。
6. 实现 `dispatcher.js`，在 room message 写入后触发 cloud run。
7. 把 Hermes 最终回复写回 `messages` 并广播 `user_events`。
8. 实现附件 materialize 与生成文件归档。
9. 补审批事件通道的最小闭环或保留明确的 pending 状态。
10. 跑 `npm run check`、相关 targeted tests、再跑完整 `npm test`。

## 13. 验收标准

本期完成时必须能证明：

1. 新用户无需桌面端即可在 Web 和默认 Fellow 对话。
2. 桌面端看到的云端 Fellow 会话仍是普通 room/message/Fellow，不需要特殊聊天模型。
3. 同一用户的云端 Hermes 有稳定独立的 HOME、HERMES_HOME、workspace。
4. 不同用户之间的文件、附件、生成产物、Hermes home、日志互不可见。
5. Fellow 身份数据仍在 `fellows`，runtime 信息在 binding/run 表，不破坏现有身份模型。
6. Hermes 调用复用 `/v1/runs` 和 Fellow header/context 注入，不 fork Hermes。
7. 自动化测试覆盖注册/bootstrap、dispatcher、payload、隔离路径、附件鉴权、消息回写。
