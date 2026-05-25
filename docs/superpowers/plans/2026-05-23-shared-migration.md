# Shared-module Forced Migration

**Date**: 2026-05-23
**Supersedes**: `2026-05-22-chat-consistency.md`（已删除）

## 为什么有这份 plan

上一份 plan 让前一个 AI 创建了 `src/shared/{time-format,contact,message-spec,ipc-channels,cloud-events,engine-contracts}.js` 和 `src/renderer/message-sources/{fellow-session,cloud-room,local-group}-source.js`。**这些文件全部建成**。但 plan 的"Definition of Done"只验收了"模块存在 + 单元测试通过"，没要求删除老副本。结果：

- `shared/time-format.js` 已存在，仅被 1 个测试文件 import。`app.js` / `web/app.js` / `message-bubble-renderer.js` 各自的 `toLocaleTimeString` 副本一字未改。
- `shared/contact.js` + `shared/message-spec.js` 被 `message-sources/` 三个适配器正确使用 —— 但 `web/app.js:740-779` 的 `buildRoomMessageArticle`、`social/social-groups.js`、`renderer/app.js` 里渲染逻辑**绕开了适配器**，自己 `m.sender_kind === "fellow"` 一通解析。
- 多处 `kind === "group" / "fellow" / "dm"` 字面量散落（CLAUDE.md 明文禁止）。
- 未读、发送入口、成员标识 fallback 链各端各写一份。

**本 plan 的反向 DOD**：每个 task 验收命令必须是 `grep ... | wc -l` 返回 0（或不超过白名单数）。**只创建不删除 = task 失败**。

## 范围

6 个高痛点 + 2 个元规律（A: 渲染端不许自造解析；C: 强制删副本）。Storage adapter 化（本地 group / 云端 room 统一）**不在本 plan**，因为它牵涉 schema 迁移，风险与回退成本与本 plan 完全不同，留待独立 plan。

## 执行约定

- 每个 task 起一个 subagent 在 git worktree 里干，互不阻塞除非有 blockedBy。
- 每个 task 完成后跑验收命令，截图/输出贴回主会话；任何一条 grep 返回非 0/非白名单数 → task 状态保持 `in_progress`，subagent 继续直到为 0。
- 全程禁止"新建一个抽象一统全国"型改造。本 plan 只做"把已有的 shared 用起来 + 删副本"。新增模块只允许 Stage 3（unread）、Stage 5（kinds）、Stage 6（send-pipeline 的 prepare 函数）三处。
- 每个 task 单独 commit，commit message 含 task ID。

---

## Stage 1 — `shared/time-format` 强制接管

**现状**：`shared/time-format.js` 已导出 `formatConversationTime` / `formatMessageTime`。零真实调用方。

### Task 1.1 — 桌面渲染器迁移

**改动**：
- `src/renderer/app.js:698-722` 删除 `formatConversationTime`、`formatMessageTime`、`formatMessageTimeHtml` 三个本地函数；改为顶部 `const { formatConversationTime, formatMessageTime } = window.miaTimeFormat || require("../shared/time-format");`（沿用现有 IIFE 双源模式）。如果 `formatMessageTimeHtml` 是 HTML 包装（带 `<time>` 标签），保留 wrapper 但内部调 shared 函数。
- `src/renderer/message-bubble-renderer.js:14-18` 删 `shortTime`，改用 `formatMessageTime`。

**验收**：
```bash
grep -rn "toLocaleTimeString\|toLocaleDateString" src/renderer/ | grep -v "shared/time-format" | wc -l
# 必须返回 0
node --test tests/shared-time-format.test.js tests/renderer-*.test.js
# 必须全绿
```

### Task 1.2 — Web 端迁移

**改动**：
- `src/web/app.js:93-104` 删本地时间格式函数。
- 在 web 端 entry HTML 里加载 `src/shared/time-format.js`（或通过 bundling）。后续渲染调 `window.miaTimeFormat.formatMessageTime`。

**验收**：
```bash
grep -n "toLocaleTimeString\|toLocaleDateString" src/web/app.js | wc -l
# 必须返回 0
```
+ 浏览器手测：会话卡片时间、气泡时间显示正确。

### Task 1.3 — Mobile 迁移

**改动**：
- `src/mobile/app.js:1084-1086` 删本地实现，引入 `shared/time-format`。

**验收**：
```bash
grep -n "toLocaleTimeString\|toLocaleDateString" src/mobile/app.js | wc -l
# 必须返回 0
```

### Stage 1 出口闸

```bash
grep -rn "toLocaleTimeString\|toLocaleDateString" src/ | grep -v "shared/time-format" | wc -l
# 必须返回 0
```

---

## Stage 2 — 渲染层强制经过 `message-sources/` 适配器

**现状**：`fellow-session-source.js` / `cloud-room-source.js` / `local-group-source.js` 已经正确用 `shared/message-spec` + `shared/contact` 把消息归一化成 `MessageSpec`。但消费方（实际渲染）有两条非法绕道：
- `src/web/app.js:740-779 buildRoomMessageArticle` 自己解析 `sender_kind` + `member_kind` + `member_ref`，绕开 `cloud-room-source`。
- `src/renderer/social/social-groups.js:22-32, 79, 138` 自己解析 fellow sender。
- `src/renderer/app.js` 部分路径（参考 `541` 行 `m.member_kind === "fellow"`）也未走适配器。

### Task 2.1 — Web 端走 cloud-room-source

**改动**：
- `src/web/app.js:740-779` 删除 `buildRoomMessageArticle` 里内联的 sender 解析。先在文件顶部加载 `src/renderer/message-sources/cloud-room-source.js`（web 也能用 —— 它只依赖 shared，不依赖 electron）。每条消息渲染前先调 `cloudRoomSource.toMessageSpec(m, ctx)`，拿到 `MessageSpec` 后只读取 `spec.authorName / spec.avatar / spec.role / spec.bodyMd / spec.isOwn` 渲染。

**注意**：web 端的 `room` 数据形状要和 desktop 一致。如果有字段缺失，**修 source adapter 让它能处理 web 的 ctx**，不许在 web 里 fork 一份。

**验收**：
```bash
grep -n "sender_kind\|member_kind\|member_ref" src/web/app.js | wc -l
# 必须返回 0（web 不再自己解析）
```

### Task 2.2 — `social/social-groups.js` 走适配器

**改动**：
- `src/renderer/social/social-groups.js:22-32, 79, 138, 306` 全部内联解析改为调用 `cloud-room-source` 或 `local-group-source`（按 group 类型）。`social-groups.js` 应该退化成"取数据 + 调适配器 + 渲染"，没有任何 `m.sender_kind ===` 字符串比较。

**验收**：
```bash
grep -n "sender_kind\|member_kind\|member_ref" src/renderer/social/social-groups.js | wc -l
# 必须 = 0
```

### Task 2.3 — `renderer/app.js` 走适配器

**改动**：
- `src/renderer/app.js:541` 和其他 `m.member_kind === "fellow"`、`m.sender_kind === ...` 出现的所有位置改为通过适配器。

**验收**：
```bash
grep -n "m\.sender_kind\s*===\|m\.member_kind\s*===\|msg\.sender_kind\s*===\|msg\.member_kind\s*===" src/renderer/app.js | wc -l
# 必须 = 0
```

### Stage 2 出口闸

```bash
# 适配器和适配器自身实现以外，禁止出现 sender_kind / member_kind 字符串比较
grep -rn "sender_kind\s*===\|member_kind\s*===" src/ \
  | grep -v "message-sources/" \
  | grep -v "main/group/member-model.js" \
  | grep -v "main/group-store.js" \
  | grep -v "shared/" \
  | wc -l
# 必须 = 0
```

（`member-model.js` 和 `group-store.js` 是存储层，允许保留；适配器以上的渲染层不允许。）

---

## Stage 3 — 创建 `shared/unread.js` + 强制接管

**现状**：未读计算 4 处，badge HTML 3 处（"99+" 截断逻辑各写各的）。无 shared 模块。

### Task 3.1 — 新建 `src/shared/unread.js`

**导出**：
```js
function computeUnreadForConversation(conversation, readState) { ... }
function totalUnreadFromConversations(conversations, readState) { ... }
function unreadBadgeHtml(count, { maxDisplay = 99 } = {}) {
  if (!count) return "";
  const text = count > maxDisplay ? `${maxDisplay}+` : String(count);
  return `<span class="unread-badge">${text}</span>`;
}
```
沿用现有 shared/ IIFE 双源模式（attachUnread + module.exports）。

**配套测试**：`tests/shared-unread.test.js` 覆盖 0、1、99、100、999 边界。

**验收**：
```bash
node --test tests/shared-unread.test.js
# 全绿
```

### Task 3.2 — 桌面端迁移

**改动**：
- `src/renderer/sessions/session-read-state.js:57-72` 删 `unreadCountForPersona` 和 `totalUnreadCount` 的本地实现（保留对外签名），内部调 `shared/unread`。
- `src/renderer/social/social.js:803-806` 删 `getUnreadForRoom`、`getTotalRoomUnread` 本地实现，调 shared。
- `src/renderer/sidebar-card-renderer.js:46` 和 `src/renderer/tasks/tasks-panel.js:95` 改为调 `unreadBadgeHtml`。

**验收**：
```bash
grep -rn "> 99 ? .99+." src/renderer/ src/web/ | wc -l
# 必须 = 0（"99+" 字面量只许在 shared/unread.js）
grep -rn "99 ?" src/ | grep -v "shared/unread" | grep -v test | wc -l
# 同样
```

### Task 3.3 — Web 端迁移

**改动**：
- `src/web/app.js:594-623` 删本地未读计算和 `renderRailUnreadBadge`，全部走 shared。

**验收**：
```bash
grep -n "unread" src/web/app.js | grep -v "miaUnread\|shared/unread" | wc -l
# 应只剩状态字段名（state.unread），不应有任何独立计算/渲染
```

### Stage 3 出口闸

桌面、web 显示的未读数字与角标样式完全一致；故意造一条未读消息，badge 在 rail/card/tasks-panel 三处显示数字相同。

---

## Stage 4 — `resolveContact` 强制接管成员标识

**现状**：`shared/contact.js` 已导出 `resolveContact({ kind, ref }, ctx)`。`message-sources/*` 已用上。但 `group-dispatch.js:11,28,36`、`tasks/tasks-panel.js:27-30`、`group/group.js:44-53,311-312` 仍有 `member_ref || fellowId || id || key` fallback 链。

### Task 4.1 — `group-dispatch.js`

**改动**：
- `src/renderer/group-dispatch.js:11,28,36` 改为调 `resolveContact({ kind: m.kind, ref: m.member_ref || m.fellowId }, ctx)`，下游只读 `contact.id`、`contact.displayName`、`contact.avatar`。

**验收**：
```bash
grep -n "member_ref\s*||\s*\|fellowId\s*||\s*" src/renderer/group-dispatch.js | wc -l
# = 0
```

### Task 4.2 — `tasks-panel.js`

**改动**：
- `src/renderer/tasks/tasks-panel.js:27-30` 同上。

**验收**：grep 同样模式 = 0。

### Task 4.3 — `renderer/group/group.js`

**改动**：
- `src/renderer/group/group.js:44-53` 的 `fellowMember` helper、`311-312` 的 `fellowById` —— 这些是基础设施函数，删掉，改成 `resolveContact({ kind: ContactKind.Fellow, ref: id }, ctx)`。调用方相应改。

**验收**：
```bash
grep -n "function fellowMember\|function fellowById" src/renderer/ -r | wc -l
# = 0
```

### Stage 4 出口闸

```bash
grep -rn "\.member_ref\s*||\s*\|\.fellowId\s*||\s*" src/renderer/ | wc -l
# = 0
```

---

## Stage 5 — 创建 `shared/conversation-kinds.js`

**现状**：`kind === "group"` / `"fellow"` / `"dm"` / `"system"` 字面量散布在 12+ 文件、25+ 行。CLAUDE.md 明文禁止。

### Task 5.1 — 新建模块

**导出**：
```js
const ConversationKind = Object.freeze({
  FellowPrivate: "fellow",
  LocalGroup: "local-group",
  CloudDM: "dm",
  CloudGroup: "group"
});
const MemberKind = Object.freeze({ Fellow: "fellow", User: "user" });
const SenderKind = Object.freeze({ Fellow: "fellow", User: "user", System: "system" });

function isGroup(conv) { ... }
function isPrivate(conv) { ... }
function isCloudBacked(conv) { ... }
```
配测试 `tests/shared-conversation-kinds.test.js`。

### Task 5.2 — 替换所有 `kind === "..."` 字面量

**改动**：以下行逐一改：
- `src/renderer/app.js:645,672,675,685,686,1313` （6 处）
- `src/renderer/social/social-groups.js:31,32,79,138,306`
- `src/renderer/social/social.js:332,341`
- `src/renderer/group-dispatch.js:18,28`
- `src/renderer/message-sources/cloud-room-source.js:28,29,70`
- `src/web/app.js:581,752,754`
- `src/main/group-store.js:100` 和 `src/main/group/member-model.js:8,20`（存储层也得用 —— 这两个文件 import `shared/conversation-kinds`）

每处把字面量换成 `ConversationKind.X` 或 `MemberKind.X` 或 `SenderKind.X`。

**验收**：
```bash
grep -rn --include="*.js" -E "(kind|sender_kind|member_kind)\s*===\s*[\"'](group|fellow|dm|system|local-group|user)[\"']" src/ \
  | grep -v "shared/conversation-kinds" \
  | wc -l
# = 0
```

### Stage 5 出口闸

测试套件全绿；上面 grep = 0。

---

## Stage 6 — `shared/send-pipeline.js`：最小可用统一

**现状**：4 个发送入口（chat:send IPC、social.postRoomMessage、web/app.js 内联、mobile sendMessage），各自做文本剪裁/mention 解析/草稿快照。

**注意**：这 4 个入口跨 IPC/REST 边界，**不能**变成同一个函数调用。能统一的是它们都该先经过同一个 "prepare" 函数：把用户输入归一化成 `{ bodyMd, mentions, attachments, clientTraceId }`。dispatch 部分仍各走各的。

### Task 6.1 — 新建 `src/shared/send-pipeline.js`

**导出**：
```js
function prepareOutgoingMessage(rawInput, ctx) {
  // 输入：composer 取到的 text + 附件 + 当前 conversation
  // 输出：{ bodyMd, mentions: [{ kind, ref }], attachments, clientTraceId }
  // 内部处理：trim、长度上限、@mention 解析、附件验证
}
```
配测试。

### Task 6.2 — 4 个入口接入

**改动**：每个入口在调 IPC/REST 前先调 `prepareOutgoingMessage`：
- `src/renderer/app.js:3915` chat:send 调用前。
- `src/renderer/social/social.js:771` postRoomMessage 调用前。
- `src/web/app.js:405` web 发送前。
- `src/mobile/app.js:1979` mobile sendMessage 函数开头。

每个入口删除自己原有的 trim/mention 解析代码。

**验收**：
```bash
# 4 个入口都必须 import 且调用 prepareOutgoingMessage
grep -n "prepareOutgoingMessage" src/renderer/app.js src/renderer/social/social.js src/web/app.js src/mobile/app.js | wc -l
# 必须 >= 4
# 同时不允许在 4 个入口附近残留 @\w+ 的本地解析
```

### Stage 6 出口闸

随便发一条 `@alice hello`，4 端（fellow / local-group / cloud-dm / cloud-group）解析出的 mentions 字段结构完全一致。

---

## 元规律 A 兜底 — 渲染层不许直接读 sender_kind

在 `tests/no-bypass-message-adapter.test.js` 新增"宪法测试"：

```js
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("no renderer/web/mobile file outside message-sources/ reads sender_kind directly", () => {
  const offenders = [];
  function walk(dir) { /* ... */ }
  walk(path.join(__dirname, "../src"));
  for (const file of offenders) {
    if (file.includes("/message-sources/")) continue;
    if (file.includes("/shared/")) continue;
    if (file.includes("/main/group")) continue; // 存储层允许
    const text = fs.readFileSync(file, "utf8");
    if (/sender_kind\s*===|member_kind\s*===/.test(text)) {
      assert.fail(`${file} bypasses message-source adapter`);
    }
  }
});
```

这个测试以后每次 PR 都跑。**只要重新出现 `m.sender_kind === "fellow"`，CI 红。**

## 元规律 C 兜底 — 副本不许再生

`tests/no-duplicate-time-format.test.js`：

```js
test("no toLocaleTimeString outside shared/time-format.js", () => {
  // walk src/, fail if any file other than shared/time-format.js calls toLocaleTimeString
});
```

同款宪法测试用于 unread / contact resolve fallback。

---

## 任务 → Subagent 派发表

| Task | 可独立 | 依赖 | 文件范围 |
|------|------|------|------|
| 1.1 | ✅ | — | `src/renderer/app.js`, `src/renderer/message-bubble-renderer.js` |
| 1.2 | ✅ | — | `src/web/app.js` |
| 1.3 | ✅ | — | `src/mobile/app.js` |
| 2.1 | ✅ | 1.2 完成更好（避免合并冲突）| `src/web/app.js` |
| 2.2 | ✅ | — | `src/renderer/social/social-groups.js` |
| 2.3 | ✅ | 1.1 完成更好 | `src/renderer/app.js` |
| 3.1 | ✅ | — | `src/shared/unread.js`, `tests/shared-unread.test.js` |
| 3.2 | ✅ | 3.1 | `src/renderer/sessions/session-read-state.js`, `src/renderer/social/social.js`, `src/renderer/sidebar-card-renderer.js`, `src/renderer/tasks/tasks-panel.js` |
| 3.3 | ✅ | 3.1 | `src/web/app.js` |
| 4.1 | ✅ | — | `src/renderer/group-dispatch.js` |
| 4.2 | ✅ | — | `src/renderer/tasks/tasks-panel.js` |
| 4.3 | ✅ | — | `src/renderer/group/group.js` 及其调用方 |
| 5.1 | ✅ | — | `src/shared/conversation-kinds.js`, 测试 |
| 5.2 | ✅ | 5.1 | 12+ 文件，按出口闸 grep 清单 |
| 6.1 | ✅ | — | `src/shared/send-pipeline.js`, 测试 |
| 6.2 | ✅ | 6.1 | 4 个入口文件 |
| 宪法测试 A | ✅ | 2.x 完成后 | `tests/no-bypass-message-adapter.test.js` |
| 宪法测试 C | ✅ | 1.x / 3.x / 4.x 完成后 | `tests/no-duplicate-*.test.js` |

**并行批次**：
- **批次 1**（无依赖）：1.1 / 1.2 / 1.3 / 4.1 / 4.2 / 3.1 / 5.1 / 6.1
- **批次 2**（依赖批次 1 部分）：2.1 / 2.2 / 2.3 / 3.2 / 3.3 / 4.3 / 5.2 / 6.2
- **批次 3**：两个宪法测试

每批次串行 review 后再起下一批。

## 出口总闸

全部 stage 完成后跑：

```bash
node --test tests/ 2>&1 | tail -20
# 全绿，包含两个宪法测试

# 综合 grep 大检查
grep -rn "toLocaleTimeString" src/ | grep -v "shared/time-format" | wc -l  # = 0
grep -rn "sender_kind\s*===\|member_kind\s*===" src/ \
  | grep -v "message-sources/\|shared/\|main/group" | wc -l  # = 0
grep -rn --include="*.js" -E "(kind|sender_kind|member_kind)\s*===\s*[\"'](group|fellow|dm|system|local-group|user)[\"']" src/ \
  | grep -v "shared/conversation-kinds" | wc -l  # = 0
```

三条 grep 全 0 = plan 完成。任何一条非 0 = 没完成。

## Codex review

总闸通过后，跑一次 `codex review` 看是否还有遗漏的"两套实现"模式。如有，记入下一份 plan，不在本 plan 范围内修补。
