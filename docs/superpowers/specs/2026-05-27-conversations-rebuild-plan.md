# 对话层重建:room → conversation + 每个 fellow 多对话

状态:改名已完成(全量绿)。

## 实际怎么做的(与下面分阶段计划不同)

发现关键点:**id 前缀(`fellow:` / `dm:`)里根本没有 "room" 这个词**,所以一次**全局大小写感知替换**
(`Room→Conversation`、`room→conversation`,覆盖 .js / .html / .css + git mv 10 个含 room 的文件)
就能让代码/DB/路由/事件/IPC/**测试**全部一致地改掉——一致就还能跑。结果:866/866 测试全绿。

**保留 id 方案**(`fellow:<u>:<f>` / `dm:<a>:<b>`):用户不可见、多对话已在其上跑通、改成 `conv_<id>`
是高风险零收益的不可见 churn,且会破坏靠 id 前缀判类型的逻辑。故只让 "room" 这个词退役。

**多对话能力本就存在**(聊天记录菜单 + 新对话 + `ensureFellowSessionConversation` 等),改名后照常工作。

部署:VPS 旧 DB 是 `rooms`/`room_id` 旧 schema,与新 `conversations`/`conversation_id` 不兼容 →
**部署时清空 VPS DB**(用户已确认测试数据可弃)。

---

## 原始分阶段计划(未采用,留档)
状态:执行中
背景:用户确认"彻底重建 + 改名",处于早期开发,**可删库重来、无需数据迁移/向后兼容**。

## 目标

1. `conversation` 成为基本单元,`room` 这个词在代码/DB/id/IPC/测试/web 全量退役。
2. **一个 fellow 可有多条对话**;人(DM)/群各一条。
3. 每条 fellow 对话独立 agent session → 上下文分线、不互相污染。

## 数据模型(云)

- 表 `conversations`(替换 `rooms`):
  `id`(`conv_<hex>`,全部随机)、`type`(fellow|dm|group)、`owner_id`(仅 fellow:该 fellow 的属主)、
  `fellow_key`(仅 fellow)、`dm_pair_key`(仅 dm:排序后的 user 对,唯一索引去重)、
  `title`、`created_at`、`updated_at`,以及原有 decorations/host/context 列按需保留。
- 表 `conversation_members`(替换 `room_members`)。
- `messages.conversation_id`(替换 `room_id`)。
- **id 方案变化**:不再用 `fellow:<u>:<f>` / `dm:<a>:<b>` 编码语义;改用随机 `conv_<hex>` + 上述列。
  - DM 去重靠 `dm_pair_key` 唯一索引(find-or-create)。
  - fellow 可建多条(每条新 `conv_` id)。
  - group 维持 find/create-by-id 语义但 id 也走 `conv_`。
- **删库重来**:迁移里 DROP 旧 `rooms`/`room_members`/`messages`(及相关),重建。部署时清空 VPS DB。

## Agent 会话隔离

本地 agent resume key:`<engine>:<fellowKey>:conv:<conversationId>`(替换 `room:<roomId>`)。
每条 fellow 对话各自上下文。

## UI

- 侧栏:联系人(fellow)+ 群 + DM 列表。
- 点 人/群 → 其唯一对话。
- 点 fellow → 其对话列表(默认最新)+ 顶部切换器 + "新对话"。
- "使用技能" → 进该 fellow 的当前/最新对话(沿用),或可选"新对话"(后续决定)。

## 阶段(每阶段:可跑 + npm test 绿 + 单独 commit)

- **P1 云数据层**:`sqlite-store`(schema + DROP 旧表 + conversations/conversation_members/messages.conversation_id)、
  `social-store`(rooms→conversations CRUD + dm_pair_key 去重 + fellow 多条)、`messages-store`、`dm-room`。
  + 对应 store 测试改写。
- **P2 云服务端路由**:`/api/rooms/*` → `/api/conversations/*`;新增 fellow 对话 创建/列举;
  事件 `room.*` → `conversation.*`;cloud-agent(`dispatcher`/`default-fellow`/runs-store)跟进。
- **P3 桌面 main**:`social-api`、三个 responder、`desktop-sync-client`、IPC channel 改名、`preload`、
  `shared/ipc-channels`、`session-history`、`unread`、`group-tiles`。
- **P4 renderer**:`social.js`(room→conversation 全量 + moduleState)、`app.js`(getActiveConversationId/
  openFellowConversation/submit)、`message-sources`、sidebar-cards、`group.js`、composer;
  + **fellow 多对话 UI**(列表/切换器/新对话)。
- **P5 web 端**:`src/web/app.js` 等。
- **P6 收尾**:测试全量改写、`audit-cloud-productization` 源码断言、文档;`npm run check` + 全绿;
  codex review;部署(清空 VPS DB)。

## 约束

- 每阶段跨进程边界要两侧同改,避免中途半 rename 跑不起来。
- 改完 codex adversarial-review 再 push;部署清库。
- 不写时间估计。
