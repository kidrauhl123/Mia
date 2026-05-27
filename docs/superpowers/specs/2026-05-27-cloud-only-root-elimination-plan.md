# 云独占 · 根除本地会话路径（实施计划）

状态：执行中
取代：`2026-05-25-cloud-canonical-conversations-design.md` 里"本期不删本地模式"的非目标。

## 决定（用户已选）

只保留云。登录 → 一切是云 room（一条路）；未登录 → 引导登录。
删除：renderer 的本地会话存储 / 发送 / 渲染 / ~25 个 `cloud.enabled` 分叉。新功能只写一遍。

**保留**：本地 Agent runtime 的 resume（Hermes / Claude Code / Codex 的物理机 session id）。
它走 cloud fellow room → `local-fellow-responder` → 主进程 `sendChat`，与 renderer 的
`chatStore` 会话存储无关，删 renderer 不影响它。

## 现状（已核对）

- 提交处理器 `app.js:4064`：先判活跃云 room → `sendInActiveRoom`；否则 `if cloud.enabled return`（4086）。
  → 登录后本地块（4091+）已是死代码。
- 渲染 `renderChat`（~1874）：云 `social.renderRoomChat` vs 本地 `renderMessageHtml` 二选一。
- 侧栏（~1349）：`localConversationRows = cloudSignedIn ? [] : visiblePersonas.map(...)`。
- 云路已有 streaming（`_buildCloudAgentStreamingArticle`）与登录 UI（`cloudLoginBox`）。

## 分片

### Slice 1 — renderer 单路（核心根除）
- 提交：删 4091+ 本地块；只留云 room 发送 + 无 room 守卫。
- `renderChat`：删本地分支；只留云渲染 + 未登录/无 room 的空态。
- 侧栏：删 `localConversationRows`；只列云 rooms；未登录 → 登录引导，不列本地 fellow。
- 验证：`npm test` + 手动登录态确认聊天正常。

### Slice 2 — 强制登录入口
- 未登录主视图 = 复用现有 `cloudLoginBox` 登录/注册；登录后进云。

### Slice 1 — 完成 ✅
- `renderChat` / 侧栏 / 提交处理器三处本地分支已删；未登录走登录引导。
- renderer 物理上只剩云一条会话路。renderer-shell 26/26 通过。

### Slice 3 — 技能 chip 随消息走（最终：存进云消息）✅
**演进**：最初做了 desktop 本地旁路（`social:set-pending-room-skills` + `pendingRoomSkills` Map），
但用户指出 chip 应该①发送后从输入框清除、②跟着消息进到用户气泡里。于是改成
**skill 作为消息字段存进云**，并**删除整个旁路**（一处真相、多设备一致、可持久 + 可显示）。

落地：
- 云：`messages.skills_json` 列（v12 迁移）；`appendMessage({skills})` 存；POST 房间消息透传 `body.skills`。
- 引擎方向：`local-fellow-responder` 不再读旁路，改从触发它的那条消息取 skill
  （`activeSkillIdsFromMessage`，在 `fellow-invocation` / `fellow-room-responder` 里接入）→
  `sendChat` 的 `activeSkillIds` → 合进 `enabledSkills` + 注入"就用这些 Skill"指令
  （`buildActiveSkillsDirective`，关键：仅"启用"在全开场景是无操作，指令才让 AI 真用）。
- 显示：气泡顶部渲染 chip（`_renderMsgSkills` 读 `skills_json`），乐观消息也带上即时显示。
- 清除：发送时 snapshot 后清空 `composerActiveSkills`，chip 随消息走。
- chip 不跨 fellow：绑定到加它时的房间，`render()` 每次重算，切房间自动清空。

**需要重新部署 VPS**（动了云 server）。删除的旁路：IPC channel / preload / main Map / 注入。

#### 原始现状（参考）
现状：`local-fellow-responder.respond()` 在 desktop 本地跑，由云事件回灌触发，
chip 的 `state.composerActiveSkills` 在 renderer，触发事件里没有它。
方案（不动云 schema、不重部署，覆盖"自己电脑回自己 fellow"常态）：
- 新 IPC：renderer 发消息时同时 `setPendingRoomSkills(roomId, skillIds)`。
- 主进程按 roomId 暂存；`respond()` 取出并清除，合并进该轮 `sendChat` 的 `activeSkillIds`
  →（已有逻辑）并进 `capabilities.enabledSkills` → `buildEnabledSkillsContext`。
- renderer 发送后清空 chip。
- 限制：多设备时另一台不持有 pending；可接受，后续要全对再走云透传。

### Slice 4 — 清理死掉的本地会话机器（谨慎缓做）
现状：Slice 1 后 `appendChat`/`activeSession`/`chatStore` 仍被
**引擎安装/启动/OAuth 失败提示**、**切换外部会话**等非会话代码引用——和引擎管理缠绕，
不是纯会话死码。完整删除是大面积外科手术，风险高，且不是消除"双写"的必要条件
（双会话路径已没）。留作后续独立、谨慎的清理，保留 agent-runtime resume 链路。

## 约束
- 改动外科手术化；codex adversarial-review 后再 push；commit 用 pathspec 避免裹挟。
- 测试不写真实用户数据目录。
