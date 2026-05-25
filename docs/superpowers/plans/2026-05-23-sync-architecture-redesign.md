# Mia 数据 / 同步架构重新设计

**Date**: 2026-05-23
**作用**: 终结"本地一套云端一套"问题。给出一份对标主流聊天系统的 canonical 设计。
**关联**: 上一份 `2026-05-23-shared-migration.md` 解决"shared 模块没人用"；本份解决更深的"两个数据源"。

---

## 1. 当前架构的真正问题

读完代码 + 对照 AionUi / LobsterAI / TG / 飞书后的结论。**不是"shall we Postgres"的问题，是底层同步模型设计就漏了**。

### 1.1 服务器端 event hub 是 in-memory 的

`scripts/serve-cloud.js:293` 的 `createEventHub`：

```js
function createEventHub() {
  return {
    socketsByUser: new Map()
  };
}
```

**意味着**：
- 客户端断线（手机进后台 / Mac 睡眠 / 网络抖动），期间所有 WS 事件**永久丢失**
- 重连后没有"补传"机制
- 这就是为啥要有"同步按钮" —— 它是事件丢失的兜底补丁

主流聊天系统**都不是这么做的**（详见 §2）。

### 1.2 每种数据各搞各的同步路径

| 数据 | 推送方式 | 持久 | 重连补 |
|------|---------|------|------|
| 好友 / 加好友请求 | WS broadcast | ❌ in-memory | ❌ |
| Room 消息 | WS + room_id+seq 顺序号 | ✓ 已存 SQLite，能 fetch since_seq | ✓ 可以 |
| Room 元数据 (rename/delete) | WS broadcast | ❌ | ❌ |
| Workspace conversations | WS + 整体 PATCH | ✓ SQLite | 半（pull merge） |
| Profile | manual PATCH /api/me/profile | ✓ SQLite | ❌ |
| Fellow 定义 | **从未上云** | 桌面本地 JSON | n/a |
| 本地群（fellow-only） | **手动 sync 才上云** | 桌面本地 JSON | n/a |
| Pin 状态 | **从不同步** | 各端 localStorage 独立 | n/a |
| 未读状态 | **从不同步** | 各端内存 / localStorage | n/a |
| 外观设置 | **从不同步** | 各端 localStorage | n/a |

**只有 messages 这一类做对了**（per-room seq + since_seq fetch）。其它全是临时方案。

### 1.3 多种存储后端形成镜像，又不对齐

- 桌面本地：`group-store.js` (文件 JSON) + `chat-store.js` (文件 JSON) + `settings-store.js`
- 云端：SQLite tables `rooms` / `messages` / `users` / `workspaces` ...
- Web 浏览器：localStorage（pin, appearance, unread）
- Mobile：localStorage（只通过 relay 桥接桌面）

**每加一类数据 → 在 4 个地方各做一遍**，新功能开发是 N 倍工作量。重复实现错位是必然的。

### 1.4 "本地 vs 云端"概念泄漏到 UI 层

最直接的痛 —— 用户层面只该有"一个群"，但代码里有 local-group + cloud-room 两套形状，加上 fellow-private + cloud-DM 两套，等于 4 种 conversation 类型。每个都自己的渲染、菜单、动作。我之前几次"统一"都是表层补丁。

---

## 2. 主流聊天系统是怎么做同步的

### 2.1 Telegram (MTProto Updates / pts model)

- 服务器是 canonical
- 每个用户有 `pts` (point-to-sequence) —— 单调递增的"用户操作序号"
- 任何对用户状态的修改（加好友 / 收消息 / 改群名 / 已读）都 +1 pts，写入 update log
- 客户端持本地 `pts`
- 重连后 `getDifference(pts)` —— 服务器回放从 `client.pts` 到 `server.pts` 之间的所有 updates
- WS 推送时附带 `pts`，客户端发现 server.pts > client.pts + 1 ⇒ 主动 `getDifference`

**关键性质**：客户端可以**离线任意长时间，重连一定能补齐**。

### 2.2 WeChat / 微信

- 类似模型：服务器持久化所有 message_id，`sync_key` 是版本指针
- HTTP long-polling `sync` 接口接受 client `sync_key`，返回 ≤ N 条新消息 + 新 sync_key
- 失败重试幂等（同 sync_key 同结果）
- 群、好友、设置、已读全部走同一个 sync 管道

### 2.3 飞书 / Lark

- IM 走"持久化 event stream"模型
- 每个 user 有一个 event-id 单调序号
- WS push 事件带 event-id，断连后 REST API 取 since-event-id

### 2.4 AionUi (我读了源码)

- **不是 server-canonical**：桌面 Electron 主进程是 source-of-truth
- WebServer 模块（`src/process/webserver/`）开 WebSocket，把主进程的 broadcast 桥到浏览器/手机
- 是"远程屏幕 + 远程命令"模型，不是真同步 —— Web 端不能独立工作，必须有桌面在跑
- **跟 mia 已选的"独立云端"路线不同**，所以 AionUi 这部分参考有限

LobsterAI 单机本地应用，**没有多端同步**，only `better-sqlite3` 本地存储。也不参考。

### 2.5 共同规律

把它们都做的事抽出来：

1. **服务器 canonical**，所有共享数据有唯一权威源
2. **持久化 event log**，离线/重连不丢
3. **单调序号** 作为同步指针（pts / sync_key / event_id）
4. **统一同步管道**，所有数据类型走同一接口，不是 N 种 ad-hoc 通道
5. **客户端本地缓存** 作为离线/启动加速，不是另一个 authority
6. **写操作幂等**（client-uuid），重试安全

mia 当前做对了 1（部分） + 部分 3（仅 messages 有 seq）。其它全缺。

---

## 3. 推荐架构

### 3.1 核心原则

**服务器是所有可同步数据的 canonical**。桌面/web/mobile 都是 cache + view。物理上不能上云的东西（Agent runtime 进程、Hermes Python、本地 LLM 实例）才保留桌面唯一。

**所有写操作 → server → event log → 推所有在线 client + 等待离线 client 来 pull**。

### 3.2 Postgres vs SQLite

**结论：现阶段继续用 SQLite (`node:sqlite`)，不切 Postgres。**

理由：

| 维度 | SQLite (`node:sqlite`) | Postgres |
|------|-----|-----|
| 并发写 | 单进程串行（够用）| 并发好 |
| 部署 | 零额外组件 | 多一个进程 + 备份 / 升级运维 |
| 文件备份 | `cp` 即可 | pg_dump / WAL replication |
| 全文检索 | FTS5 自带 | 需扩展 |
| JSON | 1.38+ 有 `json_*` 函数 | 原生 jsonb |
| 适用场景 | 单服务器、单用户、~10K msgs | 多用户、多 server、统计 |

mia 是单服务器（自己跑或部署一份）、用户量小（每个部署 1-N 用户）、消息量小。SQLite 完全够。如果未来要做 SaaS 多租户或者多 server 横向扩展，再切 Postgres。

**真正决定能否多端互通的是同步协议设计，不是底层 DB**。先把协议搞对，DB 替换是 1 周工作量，可以后做。

### 3.3 Schema 设计（新增 + 改动）

#### 3.3.1 新增：`user_events` 表 —— 持久化 event log

```sql
CREATE TABLE user_events (
  id          INTEGER PRIMARY KEY,           -- 全局自增
  user_id     TEXT NOT NULL,                  -- 事件归属
  seq         INTEGER NOT NULL,               -- 该 user 单调序号
  kind        TEXT NOT NULL,                  -- "room.message" / "room.updated" / "pin" 等
  scope_kind  TEXT,                           -- "room" / "fellow" / "user" / "self"
  scope_ref   TEXT,                           -- room_id / fellow_id / user_id
  payload     TEXT NOT NULL,                  -- JSON 详细
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, seq)
);
CREATE INDEX idx_user_events_user_seq ON user_events(user_id, seq);
```

每次任何对用户可见状态的修改 → 一行 user_events。这是 sync 的唯一真实记账。

#### 3.3.2 改动：`users` 表加 `event_seq INTEGER NOT NULL DEFAULT 0`

服务器侧记录该用户当前最大 event seq。等于 `MAX(seq) WHERE user_id=?`，但缓存到 users 表加速。

#### 3.3.3 改动：扩展现有 `rooms` 表语义为统一 `conversations`

不新建表，rooms 已经是。把"workspace conversation"（桌面 fellow 聊天会话）也搬进 rooms：
- `rooms.type` 新增字段：`"fellow"` / `"dm"` / `"group"`
- fellow-private 也是一个 room，host_member 是该 fellow

这样**只有一种"对话"**，没有 fellow-private vs DM-room vs local-group vs cloud-group 之分。

#### 3.3.4 新增：`user_settings` 表

```sql
CREATE TABLE user_settings (
  user_id    TEXT PRIMARY KEY,
  pins       TEXT NOT NULL DEFAULT '[]',     -- JSON array of room_id
  read_marks TEXT NOT NULL DEFAULT '{}',     -- JSON {room_id: last_seq_seen}
  appearance TEXT NOT NULL DEFAULT '{}',     -- JSON 主题 / 字号 / 颜色
  updated_at TEXT NOT NULL
);
```

Pin / 未读 / 外观设置全部上云。这一张表统一所有"用户级"小数据。

#### 3.3.5 新增：`fellows` 表 —— Fellow 定义上云

```sql
CREATE TABLE fellows (
  id            TEXT PRIMARY KEY,             -- 等于本地的 fellow.key
  owner_user_id TEXT NOT NULL,                -- 哪个用户拥有
  name          TEXT NOT NULL,
  avatar_image  TEXT,
  avatar_crop_json TEXT,
  color         TEXT,
  persona_text  TEXT,                         -- 系统提示词
  capabilities  TEXT NOT NULL DEFAULT '[]',   -- JSON 能力列表
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_fellows_owner ON fellows(owner_user_id);
```

桌面创建/编辑 fellow → 立即 PUT /api/me/fellows/:id → 事件推到其它端。其它端读到能渲染头像 + 名字。

**不会上云的字段**: agent runtime config (engine binary path 等) —— 因物理设备而异，保留桌面本地 settings。

### 3.4 同步协议

#### 3.4.1 WS 连接

```
GET /ws/events?token=...&since_seq=N
```

服务器握手时：
1. 验 token，确认 user
2. 读 `users.event_seq`，记为 `server_seq`
3. 如果 `since_seq < server_seq`：先把 `user_events WHERE user_id=? AND seq > since_seq ORDER BY seq` 全部发完，再开始接受新事件
4. 之后任何新事件实时推

客户端：
1. 启动时从本地缓存读 `last_seen_seq`
2. WS 连接附 `since_seq=last_seen_seq`
3. 每收一条 event 处理 + 更新 `last_seen_seq`
4. 网络断 → 自动重连 → 服务器自动补回

**这就是 TG 的 pts 模型，mia 版本**。

#### 3.4.2 写操作

所有写入 REST API（POST / PATCH / DELETE）：
1. 服务器执行写
2. **同事务** insert user_events 行
3. 同事务 +1 users.event_seq
4. commit
5. broadcast user_events 行到所有在线 sockets

如果 broadcast 失败 / client 离线，下次 ws 连上 since_seq 会取回这条。**永不丢事件**。

#### 3.4.3 写幂等

所有写请求 body 接受 `clientOpId: uuid`。服务器对每个用户记最近 100 个 clientOpId → result hash。重复请求直接返回旧 result。

```sql
CREATE TABLE op_idempotency (
  user_id     TEXT NOT NULL,
  client_op   TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, client_op)
);
```

老化清理：定期删 > 24h 的。

### 3.5 客户端缓存

桌面 / web / mobile 都按同一形状本地缓存：

```
local_cache:
  rooms:           Map<room_id, Room>
  members:         Map<room_id, Member[]>
  messages:        Map<room_id, Message[]>  // last 100 per room or LRU
  fellows:         Map<fellow_id, Fellow>
  friends:         Map<user_id, User>
  settings:        UserSettings
  last_seen_seq:   number
```

- 桌面：用 `node:sqlite` 本地 file
- Web / Mobile：IndexedDB
- 启动时：从 cache 渲染（即时显示）；同时 WS 连接 + since_seq 补差量；新事件 patch UI

**永远没有"local 群"vs"cloud 群" —— 都是从同一 cache 读、cache 永远跟服务器一致**。

---

## 4. 迁移路径（不是 big-bang）

### Phase 1 — Event log infrastructure（不改 UI 不删功能）

- 加 `user_events` 表 + `users.event_seq` 列
- 改写所有现有 broadcast 点：在事务内 insert event + 增 seq，broadcast 时附带 event
- WS 握手支持 `since_seq` query param
- 加 `op_idempotency` 表
- 客户端 cache `last_seen_seq`，重连传 since_seq

**End state**: 离线/重连不再丢事件。"同步"按钮的语义变成"主动 ping 一次"，不是兜底。

### Phase 2 — Fellow 上云

- 加 `fellows` 表
- 加 `GET /api/me/fellows` / `PUT /api/me/fellows/:id` / `DELETE /api/me/fellows/:id`
- 桌面：fellow 创建/编辑/删除时同步 PUT；启动时 fetch 一次（覆盖本地缓存）
- 加 fellow event kinds: `fellow.added` / `fellow.updated` / `fellow.deleted`
- Web / Mobile 端能渲染 fellow 头像和名字

**End state**: 换机器、开 web、用手机 —— 看得到自己的 fellow。

### Phase 3 — Pin / 未读 / 外观上云

- 加 `user_settings` 表 + 3 个 endpoints
- 客户端读 settings 用 cache 优先 + WS 增量
- 删所有客户端 localStorage 的 pin / unread / appearance

**End state**: A 端改设置 / 置顶 / 标已读 → B 端秒同步。

### Phase 4 — Conversation 统一

- 把 fellow-private 也搬进 rooms 表（type='fellow'）
- 把 local-group（桌面 group-store.js JSON）也搬进 rooms (type='group', members 全 fellow)
- 一次性迁移脚本：扫桌面 group-store + chat-store，全部 createRoom 上云
- 然后**删 group-store.js 和 chat-store.js 本地写入路径**（保留读法兼容，1 个版本后删）
- 渲染层只有 `Room` 一种类型，根据 type 分发

**End state**: 代码里没有任何"是本地群还是云端群"的 if。`socialRows` / `visibleGroups` 二分消失。

### Phase 5 — 旧 Sync 收尾

- "同步"按钮变成可选的"强制重 pull"按钮（troubleshooting）
- 默认不需要点 —— WS event-log 自动维持一致
- `syncMiaCloudWorkspace` 缩成"读 since_seq=0 拉全量"，仅用于首次登录或损坏恢复

---

## 5. 不在本次范围

- **Mobile relay 模型**: 你说保留现状用作"不登录多端"。本设计假定 Mobile 也走云时跟桌面 web 同协议。
- **多服务器 / 跨机房**: 当前 mia 是单服务器部署。Phase 1-5 不需要。如果未来要，Postgres + 流复制是替换路径，但 sync 协议（pts / event log）保持不变。
- **端到端加密**: TG/WeChat 在 secret chat 有 E2E。mia 当前明文，暂不涉及。

---

## 6. 风险

| 风险 | 缓解 |
|------|------|
| Phase 4 一次性迁移有 fellow 没匹配上 fellow id（云端没这 fellow 定义） | Phase 2 必须先做 + 全部 fellow 上云 |
| 用户已经手动造了 dup（如刚才的 4大金刚 ×2） | Phase 4 迁移前提供一个 dedup 工具，自动按 name+members 合并 |
| client_op_idempotency 表无限增长 | 每天清理 > 24h |
| event log 表无限增长 | 90 天前的事件归档 / drop；客户端 since_seq 超过被 drop 的位置时退化为全量 pull |
| 多个 device 同时改同一字段 | last-writer-wins by event seq；用户感知不到，因为最终都收到最后那条 |

---

## 7. 验收

每个 Phase 完成的 acceptance test：

**Phase 1**:
```bash
# 关闭客户端 60 秒 → 在另一端发 5 条消息 → 启动客户端 → 5 条全到位
# 网络抖动期间 server fire 100 events → 重连后 client 全收
```

**Phase 2**:
```bash
# 桌面创建 fellow X → 等 < 5s → web 端能看到 X 的名字和头像
# 删 X → web 端 X 消失
```

**Phase 3**:
```bash
# 桌面置顶群 A → web 立刻显示置顶
# 桌面打开群 A 读完所有消息 → web 角标清零
```

**Phase 4**:
```
grep -rn "local-group\|cloud-group\|cloud-room\|dm-room" src/ \
  | grep -v "shared/conversation-kinds" \
  | wc -l == 0
```

**Phase 5**:
```
# 整个 day 不点同步按钮，所有内容自动一致
# 把"同步"按钮按 10 次 → 无副作用（因为已经是一致状态）
```

---

## 8. 数据库选择小结

**SQLite + node:sqlite 继续用**。
- 服务器单进程，单用户量小，SQLite 完全够
- node:sqlite 内置免依赖

如果未来真的要切 Postgres，触发条件：
- 单服务器 QPS > 1000 写
- 数据量 > 10 GB
- 多 server 横向扩展
- 需要外部 BI / 报表工具读库

**切换路径**（如果有一天要做）：
- 用 better-sqlite3 (or node:sqlite) → Drizzle ORM 抽象 → 切到 Postgres 是改 connector
- 现在的纯 SQL 字符串写法也可以手动迁移，但花的时间多

---

## 9. 你需要的决定

1. **认可这份设计的方向吗？**（server canonical + event log + pts-style 同步）
2. **从哪个 Phase 开始？** 建议从 Phase 1 启动（不破坏现有功能，只加基础设施），同时为 Phase 2 准备 fellow schema
3. **要写 implementation plan 吗？**（拆 task、验收 grep、TDD 测试，跟之前 `2026-05-23-shared-migration.md` 同样形状）
4. **mobile 真的不动？** 现在 relay 模式保留，但未来某天接到云端的话，本设计的协议直接适用

---

## 附：跟"主流聊天软件"对照表

| 特性 | TG | 微信 | 飞书 | mia 现状 | mia 目标 |
|------|----|----|------|--------|--------|
| Server canonical | ✓ | ✓ | ✓ | 部分 | ✓ |
| Event log 持久化 | updates table | ✓ | ✓ | ❌ (in-memory) | ✓ |
| 单调序号 | pts | sync_key | event_id | 仅 messages.seq | user-level event_seq |
| 离线重连补差 | getDifference | sync | event_id 拉取 | ❌ | ✓ |
| 写幂等 | random_id | client_msg_id | client_token | 部分 | clientOpId 统一 |
| 客户端本地缓存 | sqlite | LevelDB-like | sqlite | 部分（JSON + sqlite 混）| sqlite/IndexedDB 统一 |
| 配置/置顶/已读上云 | ✓ | ✓ | ✓ | ❌ | ✓ |
