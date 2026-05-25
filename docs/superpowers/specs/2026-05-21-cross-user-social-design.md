# Mia 跨用户社交（Cross-User Social）设计

状态：已确认设计，待写实施计划
日期：2026-05-21

## 1. 目标 & 非目标

### 目标

在现有"对话是入口、Agent 是肉"的基础上，把 contacts 从"只有自己的 AI Fellow"扩到"还包含其他真人用户"，让 mia 用户之间：

1. **私聊**：互加好友、1:1 文字消息。MVP 必备项。
2. **跨用户群聊**：把好友和各自的 AI Fellow 拉到同一群里，真人 + Fellow 并列为成员；群里别的真人可以 @ 我的 Fellow 跟它对话、让它办事；Fellow 在群里能区分发言来自哪个用户。
3. **多端基础一致性**：用户在桌面 / 移动 / Web 任一端发消息，其他端按时序拉到。

### 非目标（本期）

- 端到端加密（用户明确不想为安全过度复杂化；好友之间默认信任）
- 消息撤回 / 编辑
- 已读回执 / 多端未读分裂消解（多端一致只做到"消息时序 + 离线追赶"两层）
- 富媒体（语音、视频、文件预览深度集成）—— 图片附件复用现有 cloud attachment 通道即可
- 跨 cloud 实例联邦（同一个 mia cloud 内）
- 群语音 / 屏幕共享
- per-friend ACL（亲近的人之间不引入细粒度权限）
- 桌宠同屏 / 群成员桌宠互动（v2）

## 2. 与 2026-05-14 群聊 spec 的关系

2026-05-14 已经定义了"群聊（Group）" —— 单用户视角下，把多个**自己的 Fellow** 拉到同一会话，承担 A（陪聊）和 B（多 Fellow 协作完成目标）场景。members 是 `FellowId[]`。

本期跨用户社交对"群"的定义在语义上是同一件事，**不另起 SocialRoom 概念**。但为此需要把现有 Group 模型重构为更通用的 Member 抽象 —— 先重构、再叠社交。

### 重构方向

引入抽象：

```ts
type Member =
  | { kind: 'fellow'; fellowId: FellowId; ownerId: UserId }
  | { kind: 'user';   userId: UserId };
```

- `kind='fellow'` 时 `ownerId` 标识该 Fellow 的主人（本期之前，所有 Fellow 的 ownerId = 当前用户自己）
- `kind='user'` 表示该成员是真人用户

现有 Group schema 改为：

```ts
Group {
  id: string;
  name: string;
  avatar: string | null;
  members: Member[];                 // 原 FellowId[]
  hostMember: Member | null;         // 原 hostFellowId；本期 group 场景 host 仍约束为 fellow，私聊（§6）场景为 null
  decorations: { pinnedGoal?: string; todos?: Todo[] };
  contextCard: ContextCard | null;
  createdAt: number;
  updatedAt: number;
}
```

### 重构期 host 约束

本期 host 仍然必须是 `kind='fellow'`，**理由是**：群主承担调度 / 摘要这类无状态 LLM 调用，需要可被程序化调度的 Agent runtime；真人 user 不具备这种能力。host=user 的语义本期不打开。

但 schema 上 `hostMember: Member` 允许将来扩展，例如"无 host 的纯人际群"或"由某个云端编排器做 host"。

### 重构与新功能的关系

| 阶段 | 内容 | 影响范围 |
|---|---|---|
| R | 现有 group 模型重构为 Member 抽象，behavior 不变 | `src/main/group/*`、`src/renderer/group/*`、`src/cloud/sqlite-store.js` 中 group 相关表 |
| S1 | 加好友 + 1:1 私聊 | 新文件，不动 group |
| S2 | 在 R 的基础上叠跨用户群成员 | 复用重构后的 Member |

R 必须先于 S2。S1 可以与 R 并行（私聊不依赖 group schema）。

## 3. Contacts 模型

当前 `src/cloud/sqlite-store.js` 中的 `contacts` 是种子数据列表（`contact_mia`、`contact_codex`），实际上是 Fellow 的展示元数据。本期不动这层语义，仅在 UI 列表层引入"contact 类型"概念，**不增加新的持久表来塞混合数据**。

UI 层 contacts 列表（侧边栏）按以下顺序拼出：

1. **Fellow contacts**（来自现有 Fellow 数据） —— 类型 `fellow`
2. **Human contacts**（来自新表 `friendships`） —— 类型 `human`
3. **Groups**（来自现有 group 数据，可能含真人成员） —— 类型 `group`

UI 上一个列表混合渲染，按 `updatedAt` 排序。"并列"语义在视觉上自然达成，不需要在 schema 里硬塞 union。

## 4. 数据模型

所有新表加在 cloud sqlite（`src/cloud/sqlite-store.js` 现有 db），但**新建独立 store 文件** `src/cloud/social-store.js` 承担其 CRUD，避免 sqlite-store.js 继续膨胀（当前 708 行已近上限）。

### 4.1 好友关系

```sql
CREATE TABLE friendships (
  user_a       TEXT NOT NULL,        -- 字典序较小的 user_id
  user_b       TEXT NOT NULL,        -- 字典序较大的 user_id
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);

CREATE TABLE friend_requests (
  id           TEXT PRIMARY KEY,
  from_user    TEXT NOT NULL,
  to_user      TEXT,                  -- 可空，短码场景下未指定具体对方
  code         TEXT,                  -- 短码 / QR payload，索引
  status       TEXT NOT NULL,         -- 'pending' | 'accepted' | 'rejected' | 'expired'
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  UNIQUE (code)
);
CREATE INDEX idx_friend_requests_to ON friend_requests(to_user, status);
```

`user_a`/`user_b` 用字典序归一化，避免双向关系出现两条记录。

### 4.2 群（沿用并扩展 2026-05-14 schema）

2026-05-14 spec 未指定持久化格式（当时只描述了运行时 schema）。本期落地为：

```sql
CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  avatar       TEXT,
  host_member_json  TEXT,            -- 序列化的 Member；私聊场景为 NULL，群聊场景本期约束 kind='fellow'
  decorations_json  TEXT,             -- pinnedGoal/todos
  context_card_json TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE room_members (
  room_id      TEXT NOT NULL,
  member_kind  TEXT NOT NULL,        -- 'fellow' | 'user'
  member_ref   TEXT NOT NULL,        -- fellowId 或 userId
  owner_id     TEXT,                  -- member_kind='fellow' 时为 fellow 的主人 user_id
  ai_perms_json TEXT,                 -- 仅 fellow 类型，对此群的 permission override
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (room_id, member_kind, member_ref)
);
CREATE INDEX idx_room_members_user ON room_members(member_kind, member_ref);
```

### 4.3 消息（统一私聊和群聊）

私聊和群聊消息共用一张表，私聊用 `room_id` = 自动派生的 1:1 room id（`dm:<user_a>:<user_b>` 字典序归一），避免两套消息流：

```sql
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL,   -- 服务端权威递增，per-room
  turn_id         TEXT,                -- 来自 2026-05-14 group spec
  sender_kind     TEXT NOT NULL,      -- 'user' | 'fellow' | 'system'
  sender_ref      TEXT NOT NULL,      -- userId 或 fellowId
  sender_owner_id TEXT,                -- sender_kind='fellow' 时 fellow 的主人
  body_md         TEXT NOT NULL,
  attachments_json TEXT,
  mentions_json   TEXT,                -- 解析出的 @ 列表（Member 编码）
  status          TEXT NOT NULL,      -- 'streaming' | 'complete' | 'error'
  error_json      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (room_id, seq)
);
CREATE INDEX idx_messages_room_seq ON messages(room_id, seq);
```

`seq` 是核心 —— 服务端在写入时分配，是多端一致性的权威序列号（见 §8）。

## 5. 加好友流程

### 5.1 短码 + QR

复用 `package.json` 已声明的 `qrcode` 依赖。流程：

1. 用户 A 在"联系人 → 加好友"页点击"生成邀请码"
2. 客户端调 `POST /v1/social/invite-codes`，cloud 写 `friend_requests`（`from_user=A, to_user=null, code=<random>, status=pending`），返回 code
3. UI 展示短码 + QR（QR payload 含 cloud origin + code，便于跨实例容灾，但本期实例唯一）
4. 用户 B 在自己的"加好友"页粘贴短码 / 扫码，客户端调 `POST /v1/social/invite-codes/:code/accept`
5. cloud 校验 code 未过期未消费 → 写 `friendships` → 把 `friend_requests` 标记 accepted → 给 A 推送事件（走 `cloudEventsClient` 现有通道）
6. 双方 contacts 列表新增对方

### 5.2 过期与撤销

- 邀请码默认 24 小时过期（一个常数即可，无需配置）
- 用户可在自己的"已生成邀请"列表里撤销未消费的 code
- 同一邀请码只能被消费一次

### 5.3 不做

- 不做"用户名直接搜索加好友"，避免被陌生人骚扰且省去 user 搜索基础设施
- 不做手机号 / 邮箱反查（cloud 不暴露这类查询接口）

## 6. 私聊（MVP）

私聊 = "只有两个 `kind='user'` 成员、无 host" 的退化群。

- room id 规则：`dm:<userId 小>:<userId 大>`
- 首次发消息时由 cloud 隐式创建 room 记录（不要求显式"开始私聊"按钮）
- room_members 写两条 user 记录
- UI 上私聊不显示群相关 affordance（群名编辑、添加成员、调度面板）—— 在 renderer 中按 "room 是否两人且都是 user 且无 fellow 成员" 这一 derived 状态切换 UI

私聊不引入 fellow，**fellow 只在群里出场**。如果用户想跟自己的 fellow 聊，那是现有 1v1 session（已有功能）。

## 7. 跨用户群聊语义

### 7.1 谁能拉谁

- 创建群：群创建者可拉任意自己的好友（kind=user）+ 自己的任意 fellow（kind=fellow, ownerId=自己）
- 群里加成员：当前成员中的任意 user 可邀好友进群（kind=user），可拉自己的 fellow（kind=fellow, ownerId=自己）
- 不能拉别人的 fellow（别人的 fellow 由别人决定是否在场）

### 7.2 AI 在群里看到什么

Fellow 在群里被调用时，看到**该群的全部历史消息**（受 contextCard 摘要 + 滚动窗口约束，沿用 2026-05-14 spec 现有机制）。Prompt 渲染时为每条消息打上发言者标签：

```
[@alice] 这段代码怎么改？
[@bob 的 Codex] 我可以试试 …
[小明] 等一下，先看下日志
```

格式规则：
- `kind='user'` → `[@<user_handle>]`
- `kind='fellow', ownerId==self` → `[<fellow_name>]`（自家 fellow 不带主人前缀，跟 1v1 体验一致）
- `kind='fellow', ownerId!=self` → `[@<owner_handle> 的 <fellow_name>]`

这样 Fellow 能自然分辨"谁在说话"且区分"我家 fellow vs 别家 fellow"。

### 7.3 AI 调度

2026-05-14 spec 的 host fellow 调度逻辑沿用不变：host 决定下一句谁说。重构后 host 看到的成员列表包含 user 成员，但**host 的调度只能选择 fellow 成员发言**（不能"调度 user 说话"，那是真人行为）。

host 失效场景（host fellow 的主人离线、host 是云端 fellow 但 cloud 不可达）：
- 群里没有 AI 接话，只是变成纯人际聊天，不抛错
- UI 上群顶部出现弱提示"群主 fellow 暂不可达，AI 协调暂停"

### 7.4 在线状态

- 云端 Fellow（runtime 在 cloud，例如 `contact_mia`）：始终在线
- 本地 Bridge Fellow（runtime 在主人桌面端，例如 `contact_codex`）：跟随主人桌面端 Bridge 在线状态
  - 主人桌面端 Bridge 通过 `cloudBridgeClient` 注册 presence
  - cloud 维护 `fellow_presence(fellow_id, owner_id, status, updated_at)` 内存表（不持久化，重启清空）
  - 群里该 fellow 头像置灰，被 @ 时不触发跑回复，UI 显示 "[fellow] 离线"
  - 主人桌面端恢复在线后，cloud 不补发"那段离线时间被 @ 的消息" —— 主人回来正常浏览群历史即可，避免离线追赶的复杂语义

## 8. AI 在群里的权限

复用 `src/permission-modes.js` 现有四档（`ask` / `yolo` / `deny` / `smart`），新增"按群 override"：

- 全局：每个 Fellow 自身的 permissionMode（现有）
- 群范围：`room_members.ai_perms_json` —— 仅 fellow 类型成员可写，字段 `{ mode?: 'ask'|'yolo'|'deny'|'smart' }`
- 解析顺序：群 override → fellow 全局 → 系统默认

UI：

- 群成员列表右键自己的 fellow 头像 → 复用现有 permission 选择控件（`els.permissionMode` 那套）→ 写入 `room_members.ai_perms_json`
- 非该 fellow 的主人**看不到**这个右键项 —— 别人无权改

不引入 per-friend ACL（"alice 能让我的 Codex 跑工具，bob 不能"这类粒度）。理由：用户明确表示亲近圈子不做这种区分。

## 9. 多端基础一致性

目标：**消息时序 + 离线追赶**。不做已读 / 未读分裂消解。

### 9.1 服务端权威 seq

- 每条消息写入 cloud 时由 cloud 分配 `messages.seq`，per-room 递增
- 客户端发送消息时只携带 client-side `tempId`，cloud 返回 `(seq, id)` 后客户端替换本地占位

### 9.2 端的增量拉取

- 每端在本地 sqlite 记录每个 room 的 `last_seen_seq`
- 重连 / 启动时调 `GET /v1/rooms/:id/messages?since_seq=N`，cloud 返回 `seq > N` 的消息
- 长连接（cloudEventsClient 现有通道）实时推送新消息，端按 seq 写入本地

### 9.3 gap detection

- 长连接收到的消息 seq 不连续（收到 105 但 last_seen=103）→ 主动拉 104
- 简单的"端发现 gap 就回填"，不引入 ack / nack

### 9.4 一致性边界

显式不保证：

- 多端同一用户的未读计数完全一致
- 已读回执（"对方已读"红点）
- 撤回 / 编辑的最终一致

这些**有意推到未来**，留出现版能 ship 的最小完整子集。

## 10. 传输架构

### 10.1 server 端

新增 cloud HTTP / WS endpoints（加在现有 cloud server，不另起服务）：

```
POST   /v1/social/invite-codes
POST   /v1/social/invite-codes/:code/accept
DELETE /v1/social/invite-codes/:code
GET    /v1/social/friends
DELETE /v1/social/friends/:userId

GET    /v1/rooms
POST   /v1/rooms
GET    /v1/rooms/:id
PATCH  /v1/rooms/:id                       # 改名、改 avatar、改 decorations
POST   /v1/rooms/:id/members
DELETE /v1/rooms/:id/members/:memberKey
PATCH  /v1/rooms/:id/members/:memberKey    # ai_perms override

GET    /v1/rooms/:id/messages?since_seq=N&limit=100
POST   /v1/rooms/:id/messages
```

WS 事件（沿用 `cloudEventsClient` 通道，新增事件类型）：

- `social.friend_request_received`
- `social.friend_added`
- `room.message_appended`
- `room.member_changed`
- `room.fellow_presence_changed`

### 10.2 客户端 → cloud 路由

- 桌面端 / 移动端 / web 端**统一走 cloud**，不直连 relay 做社交消息
- `src/relay/server.js` 当前是局域网桥接用途（手机连桌面端），跟社交无关，**本期不动 relay**

### 10.3 Fellow 调用路由

群里某个 fellow 被调用时：

- 云端 fellow（如 `contact_mia`）→ cloud 内部直接调度，不出 cloud
- 本地 Bridge fellow（如 `contact_codex`）→ cloud 发 `bridge.run` 给主人桌面端的 `cloudBridgeClient` → 桌面端跑完把结果回发 cloud → cloud 写入 messages 表并广播
- 调用现有 `cloudBridgeAbortControllers` / `cloudBridgeState` 机制不变

## 11. 文件布局

遵循 CLAUDE.md "新功能 = 新文件" 硬规则，单文件目标 100–500 行。`src/cloud/` 下的文件是 cloud server bundle（部署到 `/opt/mia-cloud/server.js`，见 `docs/cloud-deployment.md`），`src/main/` 是桌面端 Electron 主进程：

```
src/
  cloud/
    social-store.js               # friendships / friend_requests / rooms / room_members CRUD
    messages-store.js             # messages 表 CRUD + seq 分配
    fellow-presence.js            # 内存 presence map + 失效检测
  main/
    social/
      friends-ipc.js              # 加好友 / 列好友的 IPC handler
      rooms-ipc.js                # 房间 CRUD / 成员 / 消息发送 IPC
      room-events.js              # 订阅 cloud 事件 → renderer 推送
    group/
      member-model.js             # 新增：Member 抽象 + 校验 + 序列化（重构步骤 R）
      ... (现有 group 文件按 Member 抽象重构)
  renderer/
    social/
      friends.js                  # 联系人页好友区 + 加好友弹窗
      rooms.js                    # 跨用户房间 UI（私聊 + 群聊统一）
      member-badge.js             # 渲染"[@alice 的 Codex]"这类徽章
    group/
      ... (现有 group 文件按 Member 抽象重构)
```

不允许的命名：`utils.js` / `helpers.js` / `common.js`（CLAUDE.md 硬规则）。

## 12. 阶段切分

不写时长。阶段间有强依赖，按以下顺序推进，每阶段独立可验：

**R（重构）** — 现有 group 引入 Member 抽象
- group schema / IPC / renderer 全部接受 `Member`，行为不变
- 现有自动化测试 + 烟测全绿
- 不影响在用功能

**S1（私聊）** — 加好友 + 1:1
- social-store / friends-ipc / friends.js / rooms.js 私聊路径
- 服务端 endpoints 上线
- 不依赖 R（私聊不进 group 系统）

**S2（跨用户群聊）** — 真人 + Fellow 并列
- 依赖 R 已合
- rooms 支持 kind=user 成员、prompt 渲染加 owner 前缀
- ai_perms_json 群 override + 右键控件

**M（多端一致基础）** — seq + 增量拉取
- 可与 S1 同期落地（messages 表设计就要带 seq）
- gap detection 加在 cloudEventsClient

S1 和 R 可并行。S2 严格依赖 R 与 S1。M 与 S1 同期。

## 13. 风险与未决

### 风险

- **fellow ownership 跨用户调用的安全边界**：主人 A 把自家 Codex 拉进群，B 在群里 @ Codex 让它跑 shell 命令 —— 这条命令在 A 的机器上跑。本期靠 owner 配置 ai_perms（默认 `ask` 弹确认）兜底，但需要明确 UX：每条来自非主人的 fellow tool 调用，主人客户端必须收到"由 @B 发起，是否允许"的确认弹窗，**不能继承"all yolo"全局设置静默放行**。
  - 实施 S2 时这是关键边界，需要在 `permission-modes.js` 解析处加 `source !== owner` 这条上调一档的逻辑。

- **host fellow 在跨用户群里调度别家 fellow 时的越权**：host=A 的 fellow，调度选了 B 的 fellow 发言 —— B 的 fellow 是否回？目前没有"B 的 fellow 是否接受其他人 host 的调度"开关，本期默认接受（亲近信任语义），但记录为后续 ACL 接入点。

- **cloud 单点**：所有社交流量集中 cloud（`aiweb.buytb01.com`）。cloud 不可达时所有跨用户功能全停。relay 帮不上忙（relay 是局域网桥接）。本期接受这条限制 —— 工业级容灾不在范围。

### 未决

- **删好友是否级联踢出共同所在的群**：暂定不级联（删好友只是 friendships 表移除，不动 rooms / room_members），等真用户反馈再决定。
- **被加的人是否能匿名**：本期 user 必须有 handle / 昵称，邀请码 accept 流程要求 B 至少已注册 cloud 账号。匿名加好友不在范围。
- **群中 fellow 的对话占据自己引擎 session 还是独立 session**：2026-05-14 spec 已有 "群里 fellow 发言不污染自己 1v1 session" 的隔离，本期沿用；具体到跨用户场景，fellow 的群发言历史也不写自己 1v1 历史。

## 14. 验收（功能层）

- 两个 mia 账号互加好友后，A 发的消息 B 桌面端 + 移动端 + Web 端按时序拿到
- A 创建群，拉好友 B，拉自己 Codex；B 在群里 @ Codex，A 桌面端弹确认（默认 `ask`），A 同意后 Codex 在群里输出结果
- A 把自己 Codex 在该群权限调成 `yolo`，B 后续 @ Codex 不再弹 A 确认
- A 桌面端离线时，群里 @ A 的 Codex，群里看到 "[Codex] 离线"，A 上线后不补发但群历史可见
- 一端发消息丢包 / 重连后，端拉取 `since_seq` 补齐缺的消息
