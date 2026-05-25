# Mia 任务面板（Task Rail）设计

状态：已确认，待写实施计划
日期：2026-05-20

## 1. 目标 & 非目标

### 目标

把现有 rail 第 4 项「工作台」换成「任务」，作为 mia 的"定时 / 日程"一级入口。任务通过日常对话创建，由 daemon 调度，输出落回原 fellow 会话；任务页本身承担调度可视化、微操编辑、历史回看。

### 非目标（V1）

- 事件触发型任务（webhook / 文件变化 / 邮件 poller）—— schema 留 `"event"` 占位，运行时拒绝
- 失败自动重试 / 错过补跑 —— daemon 关期间错过的 fire 默认丢失
- 任务模板 / 任务市场
- 任务依赖（链式触发）
- 多 fellow 协作的任务（每条任务只绑一个 fellow）
- 多步骤工作流（一次 fire = 一次 engine 调用，多步交给 AI 自己 ReAct）
- 跨时区 cron —— 用 daemon 所在时区
- 能力库（rail 第 3 项）—— 本次设计不涉及，保持原状

## 2. 产品哲学

mia 的核心宗旨是"对话即一切，降低用户心智"。任务的所有创建、复杂修改都走对话；任务页只承担**可视化**和**微操**。

落地体现：

- **没有"新建任务"按钮 / 表单 / 向导**
- AI 解析"每天 9 点帮我巡检日志"这种自然语言，调 `schedule.create` 工具自动建任务
- 任务页右栏的字段可直接编辑（时间、prompt、状态开关），用于不值得开口的小改动
- 复杂改动（"改成只在工作日跑"）跳回原对话让 AI 改

## 3. 导航变更

| 变更前 | 变更后 |
|---|---|
| 消息 / 联系人 / 能力库 / **工作台** / 设置 | 消息 / 联系人 / 能力库 / **任务** / 设置 |

整段工作台代码删除：`workbenchView` / `workbenchSidebar` / `workbenchNav` / `workbenchContent` / `renderWorkbench*` / `workbenchSections` / `state.workbenchSection` / `state.workbenchFilter`。

新增任务模块：`tasksView` / `tasksSidebar` / `tasksNav` / `taskWorkspace` 等对应节点和渲染函数。

## 4. 任务实体

```ts
Task {
  id: string;
  title: string;                       // AI 解析对话生成，可在右栏改
  fellowId: string;                    // 创建时所在 session 的 fellow，自动绑定
  sessionId: string;                   // 输出消息要 append 到的会话
  originMessageId: string;             // 创建任务时用户那条原始指令的 message id
  trigger: {
    type: "cron" | "oneshot" | "event"; // V1 只支持前两种，event 留位
    cron?: string;                     // "0 9 * * *"
    at?: string;                       // ISO 8601 timestamp（oneshot）
    event?: { source: string; filter: unknown }; // V1 拒绝
  };
  timezone: string;                    // 默认 daemon 所在时区
  prompt: string;                      // fire 时发给 fellow 的指令文本
  status: "active" | "paused" | "done" | "failed";
  runs: Array<{
    id: string;
    firedAt: number;
    finishedAt: number | null;
    status: "ok" | "failed" | "skipped"; // skipped: 前一次未结束时被跳过
    outputMessageId: string | null;    // 指向 sessions.json 里的具体 message
    error?: string;
  }>;
  createdAt: number;
  updatedAt: number;
}
```

**约束**

- Task 必须绑定一个已存在的 fellow 和 session
- 一次性任务 fire 成功后 `status` 自动转 `done`，进"历史"折叠区，不删除
- `runs[]` 永远保留（不限长度），UI 默认显示最近 20 条，更多走"展开全部"
- run 的"输出"不重复存：消息本体在 `mia-sessions.json` 里，靠 `outputMessageId` 引用

## 5. 用户流程

### 5.1 创建

```
用户在任意会话里说"每天 9 点帮我巡检 Hermes 日志"
  ↓
fellow（背后是 engine：Claude Code / Codex / Hermes）识别意图
  ↓
调 schedule.create(title, trigger, prompt) tool
  ↓
daemon 写入 mia-tasks.json，返回 taskId
  ↓
fellow 在对话里输出一条确认卡片：
  ┌──────────────────────────────────────┐
  │ 📅 已创建定时任务                       │
  │ "巡检 Hermes 日志"                     │
  │ 每天 09:00 · Mia · 下次 明天 09:00 │
  │ [查看] [改时间] [取消任务]              │
  └──────────────────────────────────────┘
```

### 5.2 Fire

```
scheduler 到点
  ↓
取 task.fellowId → 对应 engine adapter
  ↓
复用 runRemoteChatRequest({ sessionId, prompt, meta: { taskId, taskRunId } }, eventSink)
  ↓
adapter 流式写 message 到 mia-sessions.json
  message.meta.taskRunId = runId, message.meta.taskId = taskId
  ↓
daemon 写 runs[] 条目，更新 task.updatedAt
  ↓
SSE 广播 { type: "finished", taskId, runId, sessionId, messageId } 给所有订阅 GUI
  ↓
GUI（如果在线）刷新 rail 角标、任务页中栏、若 chatView 正展示该 session 触发流式渲染
```

### 5.3 查看

- rail 点「任务」→ 进任务页
- 中栏：分组列表，单位是 task 的"下一次 fire"（今天 / 即将 7 天）+ 已执行的 run（历史）
- 右栏：两态切换（详见 §6）

### 5.4 编辑（小改动 inline）

任务页右栏 task 详情区的字段都是 autosave：

- trigger.type 单选切换
- cron 表达式 / at 时间 / timezone 改完即保存
- prompt textarea 改完即保存
- status 开关（暂停 / 启用）

所有保存都 PATCH 到 daemon `/api/tasks/:id`，daemon 收到后重排 scheduler。

### 5.5 编辑（复杂改动走对话）

右键菜单 / 顶栏 "⋯" → "在对话里改" → deep-link 跳回原 session + 预填 prompt "把任务「X」改成 ..."，用户补完语义再发送。

### 5.6 暂停 / 立即跑一次 / 删除

右栏顶栏按钮 + 中栏行右键菜单。所有操作走 daemon HTTP，无表单弹窗。

## 6. 任务页布局

### 6.1 中栏 `tasksSidebar`

```
┌─────────────────────────┐
│ ⌕ 搜索任务              │
├─────────────────────────┤
│ 今天 (3)                │
│ ● 09:00  Mia        │
│   巡检 Hermes 日志       │
│ ● 14:00  文档伙伴        │
│   整理 PR 摘要           │
│ ● 18:30  Hermes         │
│   备份 vendor           │
├─────────────────────────┤
│ 即将 7 天 (5)            │
│ ○ 周四 09:00 ·...       │
│ ...                     │
├─────────────────────────┤
│ 历史 (12 ⌄) [默认折叠]   │
├─────────────────────────┤
│ 已停用 (2 ⌄) [默认折叠]  │
└─────────────────────────┘
```

约定：

- ● 实点 = 活跃任务；○ 空圈 = 即将；✓ / ✗ = 历史 run 状态
- 列表"单位"混装：上半（今天 / 即将）= 任务的下一次 fire；下半（历史）= 已完成的 run
- "历史"和"已停用"默认折叠
- 不出现"运行 / run"等技术词；UI 文案统一用"任务 / 记录 / 历史"

### 6.2 右栏状态 a —— 选中任务

```
[Topbar] 巡检 Hermes 日志        [运行一次] [暂停] [⋯]
来源会话: "Hermes 后台" · Mia · 5/19 16:23  [打开 →]

调度 [可编辑]
  ◉ 重复    ○ 一次性    ○ 事件触发（V1 不可用，置灰）
  Cron [ 0 9 * * * ]    时区 [ Asia/Shanghai ]
  下次:  明天 09:00 (倒计时 12h 33m)

Prompt [可编辑 textarea]
  巡检 Hermes 日志，发现错误就报告

历史记录 (12)
  ✓ 5/19 09:00       → 查看本次输出
  ✓ 5/18 09:00       → 查看本次输出
  ✗ 5/17 09:00 失败  → 查看本次输出
  ...
```

### 6.3 右栏状态 b —— 选中历史记录

```
[← 返回任务] 巡检 Hermes 日志 · 5/19 09:00 完成
                                  [打开对话 →] [运行一次]

▸ 原始指令（折叠）
  巡检 Hermes 日志，发现错误就报告

AI 输出
  ┌──────────────────────────────────────────┐
  │ [完整复用 chatView 的 message renderer：  │
  │  markdown / 代码块 / tool calls /         │
  │  附件 / thinking 等都正常显示]            │
  └──────────────────────────────────────────┘
```

- AI 输出复用现有 chatView 的 message 渲染器（同一份代码，传 message id 进去即可渲染）
- "打开对话 →" 仅在需要前后上下文时点；任务页本身自给自足，不强制跳转
- 中栏点其他任务可直接切走；点"← 返回任务"回到状态 a

### 6.4 会话内的 task-fire 角标

chatView 里来自定时任务的 AI 消息，上方多一条灰色 affordance bar：

```
─── 📅 来自定时任务「巡检日志」· 5/19 09:00 · [打开任务] ───

[AI 消息正文 正常显示]
```

不折叠、不静默；保持"对话即一切"。

### 6.5 角标

rail 上「任务」按钮显示**未读 fire 计数**：当 daemon 推送一个 `finished` 事件时计数 +1；用户进入任务页并看到对应任务条目（或在 chatView 滚动到 task-fire 消息）时该条目清零。

### 6.6 空状态

```
       📅
   还没有定时任务

  回到任意聊天告诉 Mia：
  "每天 9 点帮我做 X"
  它会自动帮你建好任务。
```

## 7. 架构

### 7.1 Scheduler 跑在 daemon

mia 已有 daemon 模式（`--daemon` / `MIA_DAEMON=1`），通过 macOS LaunchAgent `ai.mia.daemon` 自动启动，已有 HTTP 控制服务器 + relay 客户端。

**Scheduler 只在 daemon 进程初始化**：

```js
if (IS_DAEMON_PROCESS) {
  initScheduler();
}
```

GUI 进程绝不启动 scheduler，避免双重 fire。Daemon 是任务的唯一权威源，唯一写入者。

**好处**：
- 用户关 GUI → daemon 由 launchd 拉着，scheduler 照跑
- 云端部署 → daemon 跑在云服务器，本地 / 手机通过 relay 连接，调度从云上跑
- 本地和云端共用一份代码、一份协议

### 7.2 HTTP API（加到现有 control server）

所有路由走现有 `Authorization: Bearer ${daemonToken()}` 鉴权（参考 `notifyDaemonRelay`）。

```
GET    /api/tasks                  → Task[]
GET    /api/tasks/:id              → Task
POST   /api/tasks                  → 创建（通常由 schedule MCP tool 调）
PATCH  /api/tasks/:id              → 改 trigger / prompt / status / title
DELETE /api/tasks/:id
POST   /api/tasks/:id/run-now
GET    /api/tasks/events           → SSE: lifecycle 事件流
                                     types: fired / started / finished / failed
                                            updated / deleted / paused / resumed
```

SSE 沿用现有 `/api/chat/stream` 的写法。

### 7.3 GUI 端通信

GUI 通过 preload 暴露的 `tasks:*` IPC 调主进程，主进程再走 HTTP 调 daemon。token 不出 main 进程，renderer 永远拿不到。

GUI 启动建立长连接订阅 `/api/tasks/events`，断线重连补差；本地维护一份 task 状态镜像。

GUI **不直接读 `mia-tasks.json`**，避免与 daemon 写入竞争。

### 7.4 MCP server `mia-scheduler`

新增 MCP server 注册到现有 bridge（参考 `bridgeSkillsDir`）。

工具：

```
schedule.create(title, trigger, prompt) → { taskId }
schedule.list() → Task[]
schedule.update(id, partial) → Task
schedule.delete(id) → void
schedule.pause(id) / schedule.resume(id) → Task
```

- Claude Code / Codex 通过 MCP 调用
- Hermes 在 daemon 内**直接调内部函数**（不绕回自家 HTTP），保持调用最短路径

### 7.5 持久化

新文件 `~/Library/Application Support/Mia/mia-tasks.json`（和 `mia-sessions.json` 同目录），原子写入（沿用既有模式）。

Daemon 是唯一写入者；GUI 永远走 HTTP 读。

### 7.6 Cron 表达式解析

引入小依赖 `cron-parser`（NPM 上 ~50KB，稳定）。

Scheduler 实现：维护一个 min-heap 按 next fire time 排序，单 `setTimeout` 醒到最近的下次，fire 完重排。任务 CRUD 触发立即重排。

## 8. 文件级改动

### 新增

- `src/main/scheduler.js` —— Scheduler 引擎，仅 daemon 启动
- `src/main/tasks-store.js` —— `mia-tasks.json` 读写（daemon 端）
- `src/main/tasks-routes.js` —— `/api/tasks/*` 路由处理器，挂到现有 `handleControlRequest`
- `src/main/scheduler-mcp.js` —— MCP server 实现
- `src/renderer/daemon-client.js` —— GUI HTTP / SSE 客户端封装

### 修改

- `src/main.js`
  - daemon 分支里 `initScheduler()`
  - `handleControlRequest` wire `/api/tasks/*` 和 `/api/tasks/events`
  - MCP bridge 注册新 server
  - 删 workbench 相关 IPC handler
- `src/preload.js` —— 暴露 `tasks:list / get / create / update / delete / runNow / subscribe`
- `src/renderer/app.js`
  - 删 `renderWorkbench` / `renderWorkbenchNav` / `renderWorkbenchAction` / `renderWorkbenchExample` / `workbenchSections`
  - 删 `state.workbenchSection` / `state.workbenchFilter`
  - 抽 `renderChatMessage` 为纯函数 `renderMessage(message, ctx)`，让任务页历史详情能复用
  - 加 `renderTaskSidebar` / `renderTaskView` / `renderTaskHistory` / `renderTaskFireBadge`
  - rail 第 4 项事件绑定改向 tasksView
  - rail 角标未读计数订阅 `/api/tasks/events`
- `src/renderer/index.html`
  - 删 `workbenchView` / `workbenchSidebar` / `workbenchNav` / `workbenchContent`
  - 加 `tasksView` / `tasksSidebar` / `tasksNav` / `taskWorkspace`
  - rail 第 4 项 button 改 label / icon / `data-view="tasks"`

### 删

- 上面 workbench 标记的所有节点和函数

## 9. 不变量 / 边界条件

- Task 必须有 `fellowId` + `sessionId`，缺一不能创建
- `trigger.type === "event"` 在 V1 创建时 daemon 直接返回 400
- Daemon 重启时载入所有 active 任务，重新计算 next fire；中间错过的不补
- 同一时刻同一 task 不能并发 fire（前一次未结束则跳过本次并记一条 `skipped` run）
- 删除 fellow 时级联：把该 fellow 名下所有 task 转 `paused`，不删，UI 显示 "fellow 已删除，无法运行"
- 删除 session 时级联：该 session 下所有 task 自动 paused 并标记孤儿
- Task 的 `title` 是 AI 生成的"摘要"，可被用户改；用户改过的 title 不会被后续 AI 操作覆盖
- 一次性任务过期未跑（daemon 关期间错过）→ daemon 重启时直接转 `failed`，不补跑，理由记在 last run 的 error 字段

## 10. 未来扩展（V2+ 留位）

- `trigger.type === "event"` 真实实现：先支持 GitHub webhook → 走 relay 反向推送（已有基础设施）
- 失败重试：在 Task 加 `retryPolicy: { maxAttempts, backoff }`
- 补跑：daemon settings 加 `catchupOnRestart: boolean`
- 多 fellow 任务：需要先有"任务对话"概念，可能跟群聊设计合并
- 多步骤工作流：等用户反馈具体场景再设计
- 任务模板 / 市场：等基础任务用法成熟

## 11. 实施细节决定

- **Cron 解析**：引入 `cron-parser`（NPM 上 ~50KB），不手写
- **时区可见性**：右栏调度区显示当前 daemon 时区标签；云端 daemon 模式下，"下次时间"按云端时区原值显示，括号注本地等效时间（例：`明天 09:00 (CST) (你的本地 10:00 PST)`）
- **历史记录可见性**：默认显示最近 20 条 run，更多走"展开全部"

---

**附**：与既有架构的契合点

- 复用 `runRemoteChatRequest`（main.js）作为 fire 时的 engine 调用入口，确保任务 fire 和手动聊天走完全一致的引擎链路
- 复用 daemon 的 HTTP control server + SSE 机制
- 复用 daemon token 鉴权
- 复用现有 message renderer
- 复用 MCP bridge 注册机制（参考 `bridgeSkillsDir`）
