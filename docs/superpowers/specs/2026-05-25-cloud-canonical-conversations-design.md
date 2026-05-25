# Cloud Canonical Conversations 设计

状态：已确认方向，待写实施计划
日期：2026-05-25

## 1. 背景

Mia 当前已经有一部分 cloud-canonical 基础：

- Cloud `rooms` 是 DM、群聊、Fellow room 的统一会话表。
- Cloud `messages` 是房间消息流，带 per-room `seq`。
- Cloud `user_events` 是登录用户的持久事件回放通道。
- Cloud `fellows` 保存 Fellow 身份形状：名字、头像、人设、能力。
- Web 端已经只显示 cloud rooms。

但桌面端仍保留本地 Fellow 私聊权威源：

- `mia-sessions.json` 存本地 Fellow 私聊。
- `src/renderer/app.js` 的私聊发送仍走 `activeSession()`、`saveChatSession()`、`sendChat()`、再尝试 `cloudPushMessage()`。
- Cloud fellow rooms 在桌面侧边栏被隐藏，因为它们被当成本地 session 的镜像。
- 登录态下，本地 JSON、cloud rooms、renderer social snapshot 三者都可能影响 UI。

这导致用户看到“本地和远端不一样”，也让清理数据、删除好友、群聊回复、Fellow 私聊同步变得脆弱。项目已有 ADR `2026-05-22-conversation-state-canonical-owner.md` 明确决定：登录 Mia Cloud 后，cloud 是 conversation state 的写权威。本设计把这个决定落到 Fellow 私聊和桌面 UI。

## 2. 目标

1. 登录态下，所有用户可见 conversation 都以 cloud `rooms/messages` 为唯一权威源。
2. Fellow 私聊变成 `room.type='fellow'` 的 cloud room，桌面、Web、移动端读取同一份消息。
3. 桌面端发送 Fellow 私聊消息时先写 cloud，再由本地或云端 Agent 将回复写回同一个 room。
4. `mia-sessions.json` 不再作为登录态聊天真相，只保留未登录本地模式和一次性迁移输入。
5. 桌面侧边栏不再隐藏 fellow rooms；用户看到的 Fellow 私聊来自 cloud room。
6. 删除、清空、重启、跨端登录后，旧本地 JSON 不会再把历史私聊推回云端。
7. 保留本地 Agent runtime 能力：Claude Code、Codex、Hermes 的外部 thread/session id 仍存在本机，因为这些运行态绑定物理机器。

## 3. 非目标

- 本期不重写 cloud agent worker 隔离模型。
- 本期不把未登录本地模式删掉。
- 本期不实现端到端加密。
- 本期不把所有 renderer 文件一次性重构到理想大小。
- 本期不解决多服务器部署；仍按当前单 cloud 服务 + SQLite 模型。
- 本期不迁移历史测试数据；当前环境已经手动清空。本期只提供代码路径，避免新数据继续分裂。

## 4. 核心决策

### 4.1 登录态 conversation authority

登录态定义为：`runtime.cloud.enabled === true` 且有有效 token 与 user id。

登录态下：

- Conversation 列表来自 `GET /api/rooms`。
- Conversation 消息来自 `GET /api/rooms/:id/messages` 和 `room.message_appended` events。
- New chat、send、rename、delete、pin、read mark 等用户可见 conversation 操作都写 cloud。
- 本地 `mia-sessions.json` 不参与登录态 UI 合并，不做登录态自动 backfill。

未登录态下：

- 桌面端继续使用本地 `mia-sessions.json`，保持离线 Fellow 私聊可用。
- 用户登录后，后续新消息走 cloud；历史迁移作为显式动作，不在普通启动时自动执行。

### 4.2 Fellow 私聊 room 模型

每个 Fellow 私聊使用 stable room：

```text
room.id = fellow:<userId>:<fellowKey>
room.type = fellow
room.decorations = { fellowKey, runtimeKind? }
room_members:
  { member_kind: 'user', member_ref: userId }
  { member_kind: 'fellow', member_ref: fellowKey, owner_id: userId }
```

不再为每个本地 session id 创建一个 cloud fellow room。一个 Fellow 对用户表现为一个连续会话。后续如果需要多线程聊天，再引入显式 thread 概念，而不是复用旧本地 session id。

### 4.3 桌面发送路径

登录态打开 Fellow 私聊时：

1. 桌面通过 social module 选择 `fellow:<userId>:<fellowKey>` room。
2. 用户消息走 `POST /api/rooms/:id/messages`。
3. 服务端持久化 user message，广播 `room.message_appended`。
4. 桌面 daemon 或 cloud agent 根据 room 中的 Fellow membership 触发对应 Agent。
5. Agent 回复走 `POST /api/rooms/:id/messages/as-fellow`，写入同一个 room。

桌面 renderer 不再在登录态私聊里调用 `appendChat()` 写本地 session 后再 push cloud。UI 可以乐观显示 pending 消息，但最终以 cloud 返回的 message id、seq、created_at 为准。

### 4.4 本地 Agent session 映射

本地 Agent 仍需要恢复 Claude Code / Codex / Hermes 的外部 thread。该状态不是聊天内容权威，而是 runtime resume metadata。

保留 `mia-agent-sessions.json` 或等价 store，但 key 改为 cloud room 维度：

```text
<engine>:<fellowKey>:room:<roomId>
```

这避免同一个 cloud room 在不同本地 session id 下重复开 thread，也避免“回复落到另一个本地 session”。

### 4.5 历史迁移

登录后的普通启动不自动把 `mia-sessions.json` 全量推到 cloud。原因：

- 自动 backfill 会把用户刚清掉的测试历史重新推回云端。
- 旧本地消息可能已经在 cloud 有镜像，自动合并容易重复。
- 本期目标是停止继续分裂，不是无损考古。

提供一个显式迁移入口：

- 只在用户点击“迁移本机历史到云端”时执行。
- 以 Fellow key 分组，把本地 messages 追加到 stable fellow room。
- 每条消息使用稳定 `clientOpId`，重复点击不会重复写。
- 迁移完成后本地原始 JSON 保留为备份，不再参与 UI。

当前测试环境已清空，因此本期可以先实现迁移函数和测试，不一定暴露完整 UI。

### 4.6 Renderer 数据流

桌面 renderer 只保留两种 conversation source：

- 登录态：cloud room source。
- 未登录态：local fellow session source。

登录态侧边栏显示：

- DM room。
- Group room。
- Fellow room。

Fellow room 的标题和头像从 cloud fellow identity 或本地 fellow manifest 解析；如果解析不到，显示 room name 和默认头像。

`mia.social.snapshot.v1` 仍可作为启动渲染缓存，但它只是 cloud rooms 的缓存。bootstrap 完成后必须被 cloud 结果覆盖，不能把已删除的本地 Fellow/session 再注入 conversation list。

## 5. 关键模块影响

### Cloud server

- `scripts/serve-cloud.js`
  - 新增 `PUT /api/me/fellows/:fellowId/room`，创建或返回 stable fellow room `fellow:<userId>:<fellowId>`。
  - 旧 `PUT /api/me/fellow-rooms/:id` 保留兼容历史迁移，但登录态新发送路径不再调用它。
  - `POST /api/rooms/:id/messages` 已是用户消息权威入口。
  - `POST /api/rooms/:id/messages/as-fellow` 已是 Fellow 回复权威入口。

- `src/cloud/social-store.js`
  - 保持 room/member 模型。
  - fellow room 创建必须幂等。

### Main process

- `src/main/cloud/desktop-sync-client.js`
  - 删除登录态自动 `pushAllFellowSessionsToCloudRooms()` backfill。
  - `pushDesktopMessage()` 不再从本地 session 镜像消息；登录态消息已经由 social API 直接写 cloud。

- `src/main/social/local-fellow-responder.js`
  - 继续负责本地 Agent 回复 cloud room。
  - 使用 room id 作为 Agent resume key。

- `src/main/social/group-conductor.js`
  - 群聊和 Fellow room 都是 room message 流；是否触发多个 Fellow 由 room type 和 mentions/协调者策略决定。

- `src/main/chat-store.js` 与 `src/main/chat-session-service.js`
  - 保留未登录模式。
  - 登录态 renderer 不再依赖这些作为 conversation truth。

### Renderer

- `src/renderer/social/social.js`
  - 成为登录态 conversation list 的唯一入口。
  - 不再把 fellow rooms 当镜像隐藏。

- `src/renderer/app.js`
  - 登录态 Fellow 点击打开 cloud fellow room。
  - 登录态 submit 走 `window.miaSocial.sendInActiveRoom()`。
  - 未登录态仍走本地 `sendChat()` + `saveChatSession()`。

- `src/renderer/message-sources/cloud-room-source.js`
  - 继续负责统一渲染 DM/group/fellow rooms。

## 6. 错误处理

- Cloud 未登录或 token 失效：桌面回到未登录本地模式，并提示用户登录后多端同步才可用。
- Cloud 写消息失败：输入框内容恢复，显示错误，不写本地 session 作为假成功。
- Agent 回复失败：在同一个 room 写入失败状态消息或错误事件，不能把错误写到本地私聊。
- WebSocket 断线：客户端使用已有 event log / rooms pull 重新拉取，不从本地 session 补消息。
- Cloud fellow identity 缺失：仍显示 fellow room，标题用 `room.name || fellowKey`，并在后台尝试重新 push fellow identity。

## 7. 测试策略

### Unit tests

- `desktop-sync-client`：登录态 sync 不再自动 backfill 本地 sessions。
- `social-store` 或 cloud API：stable fellow room 创建幂等。
- `local-fellow-responder`：Agent resume key 使用 `room:<roomId>`。
- `renderer-shell`：登录态 active Fellow submit 走 social room，不写 local session。

### Integration tests

- 桌面登录后，Fellow room 出现在 conversation list，不被隐藏。
- 用户在桌面 Fellow 私聊发送消息，cloud `messages` 增加 user message。
- 本地 Agent 回复写入同一个 cloud room，Web 拉取能看到。
- 清空本地 `mia-sessions.json` 后重启，cloud room 历史仍可见。
- 清空 cloud room 后重启，旧本地 session 不会自动回填。

### Regression tests

- 群聊发送仍走同一个 room send path。
- DM 发送不受 Fellow 私聊改动影响。
- 未登录本地 Fellow 私聊仍可发送和保存。
- 已修复的异步回复串会话问题保持不回归。

## 8. 验收标准

1. 登录同一账号的桌面和 Web 看到同一组 Fellow/DM/group rooms。
2. Fellow 私聊消息从桌面发送后，Web 不需要手动同步即可看到。
3. Web 或 cloud agent 写入的 Fellow room 消息，桌面重连后能看到。
4. `mia-sessions.json` 中的旧消息不会在普通启动或 cloud sync 时重新推到 cloud。
5. 桌面登录态 conversation list 不再同时显示“本地 Fellow 卡片”和“cloud fellow room 镜像”两套入口。
6. `npm test` 和 `npm run check` 通过。

## 9. 后续清理

本期完成后仍可继续：

- 把未登录 local session UI 与登录态 cloud room UI 拆成更明确的 adapters。
- 为历史迁移加完整 UI 和进度反馈。
- 为 read mark 改成 per-room seq，而不是仅靠本地快照。
- 删除已无调用的 legacy cloud workspace 文件和旧 sync 按钮语义。
