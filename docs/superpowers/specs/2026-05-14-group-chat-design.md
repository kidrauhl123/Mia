# Mia 群聊（Group Chat）设计

状态：已确认，待写实施计划
日期：2026-05-14

## 1. 目标 & 非目标

### 目标

为 mia 增加"群聊"概念：用户可以把多个 Fellow 拉到同一个会话里，让它们既能日常陪聊（A 场景），又能在用户挂上目标/待办后协作完成任务（B 场景）。B 由 A 自然涌现，不作为独立 IA 实体存在。

### 非目标（v1）

- 桌宠同屏（v2）
- 跨设备多端实时同步群状态（沿用现有 daemon/relay 能力，无新机制）
- 完整的"产出物"系统（文档/代码工件）—— v1 只做 pinnedGoal 一种 decoration
- 大群（>5 Fellow）—— v1 限制最大成员数 5
- 群主以外的 Fellow 主动发起多 Fellow 协作（v1 仅群主 Fellow 承担调度）

## 2. 核心概念

### Group

侧边栏新增一种会话实体，独立于 1v1 单聊（不强行抽象统一）。

```ts
Group {
  id: string;
  name: string;
  avatar: string | null;         // null 时 UI 按成员头像合成
  members: FellowId[];           // 含 hostFellowId
  hostFellowId: FellowId;        // 群主，是 members 之一
  decorations: {
    pinnedGoal?: string;         // B 场景涌现的目标
    todos?: Todo[];              // 预留，v1 不实现
  };
  contextCard: {
    summary: string;             // 群主生成的群上下文摘要
    summaryUpToMsgId: string;    // 摘要覆盖到的最后一条消息
    updatedAt: number;
  } | null;                      // 首次摘要前为 null
  createdAt: number;
  updatedAt: number;
}
```

### 群主 Fellow（Host Fellow）

群主就是 `members` 里的一个普通 Fellow。在群中承担三种行为：

| 行为 | 是否在群里可见 | Prompt 类型 | 引擎 |
|---|---|---|---|
| 接话发言 | 可见 | Fellow 自己的人设 + 群上下文 | 群主 Fellow 的引擎 |
| 调度决策（决定谁发言） | 不可见 | 系统 prompt，无人设 | 群主 Fellow 的引擎 |
| 摘要生成 | 不可见 | 系统 prompt，无人设 | 群主 Fellow 的引擎 |

**关键**：调度/摘要调用是无状态的（每次重建 prompt），不写入群主 Fellow 自己的引擎 session 历史，避免污染人设。

### Message

扩展现有消息 schema：

```ts
Message {
  id: string;
  groupId: string;
  role: 'user' | 'fellow' | 'system';   // 没有独立的 conductor role
  senderFellowId?: FellowId;             // role='fellow' 时存在，包括群主接话
  mentions: FellowId[];                  // 从 content 解析的 @ 列表
  turnId: string;                        // 同一用户发言下属于同一 turn
  content: string;
  attachments?: Attachment[];
  status: 'streaming' | 'complete' | 'error';
  error?: { code: string; message: string };
  createdAt: number;
}
```

`role='system'` 仅用于错误/降级提示（例如"X 离开了群"），不用于调度或摘要——这两类调用对用户不可见。

## 3. 存储

沿用 `engine-home` 风格：

```
~/Library/Application Support/Mia/runtime/engine-home/groups/
  manifest.json              # 所有群的元信息索引
  <group-id>/
    group.json               # 单个群的完整元信息 + decorations
    messages.jsonl           # 追加写，每行一条 Message
    context-card.json        # 当前摘要快照
```

写策略：
- `messages.jsonl` 追加写，按行；并发写用进程内 mutex（renderer 侧 ChatService 单实例）
- `context-card.json` 全量写，原子 rename
- `group.json` 全量写，原子 rename，更新 `manifest.json` 索引

## 4. 创群 & 群生命周期

### 创群流程

1. 用户从侧边栏点"新建群聊"
2. 弹出 `GroupCreateDialog`：勾选 Fellow（>=2，<=5）→ 输入群名 → 选群主（默认第一个勾选的 Fellow）
3. 创建 `group.json`，写 `manifest.json`，跳转到新群

### 加/移除成员

- 群信息抽屉里编辑
- 移除群主时强制要求先指派新群主，或将该 Fellow 标记为离群（自动指派下一个成员）
- 群里只剩 1 个 Fellow 时，群信息抽屉提示"是否转为单聊？"，**不自动转换**（避免数据迁移误操作）

### 切换群主

- 群信息抽屉直接选另一个成员为群主
- 切换后保留 `contextCard`（摘要内容与人设无关）
- 新群主无缝接管调度/摘要职责

## 5. 用户发言后的处理流（Data Flow）

```
user 发送 msg (含或不含 @)
  │
  ▼ ChatService.appendUserMessage(group, msg)
  │   解析 @ → mentions: FellowId[]
  │   分配 turnId
  │   写入 messages.jsonl
  │   emit ipc 'group:msg:appended'
  │
  ▼ ConductorService.onUserMessage(group, msg)
  │
  ├─ msg.mentions.length > 0
  │   └─► 跳过调度 LLM，直接 dispatch 到 mentioned Fellows
  │
  └─ msg.mentions.length === 0
      └─► 调用群主 Fellow 引擎执行 dispatch:
          prompt = [
            system: "你是群聊调度员（无人设）。下一步谁该说话？",
            context: contextCard.summary + 最近 6 条消息预览,
            user: msg.content
          ]
          返回 FellowId[] | 'none'
          - 'none' → 不触发任何 Fellow
          - FellowId[] → dispatch
  │
  ▼ 对每个被选中 Fellow，并发执行 groupAdapters.send():
  │   构造输入：
  │     - contextCard.summary
  │     - 最近 3 轮"被该 Fellow 参与或 @"的完整消息（按 turn 过滤，不足 3 轮就取实际数）
  │     - 当前 turn 的用户消息
  │   按 Fellow 引擎类型走不同适配器：
  │     - Hermes: header X-Mia-Group-Context 传摘要
  │     - Claude Code: 拼到 SDK 调用的 user message 前面
  │     - Codex: 拼到 SDK 调用的 user message 前面
  │   流式响应回 renderer，写入 messages.jsonl
  │
  ▼ 所有 Fellow 完成 / 错误后
      ConductorService.maybeSummarize(group):
      if (turnsSinceLastSummary >= 4):
        调用群主 Fellow 引擎执行 summarize:
          prompt = [
            system: "你是群聊摘要器（无人设）。压缩最近对话…",
            context: 旧摘要 + 新增消息
          ]
          → 写 context-card.json

      ConductorService.maybeNudge(group):
      if (group.decorations.pinnedGoal && 满足 nudge 条件):
        以群主 Fellow 身份发起一次接话，prompt 注入 pinnedGoal
```

### 调度阈值

- **明确 @**：跳过调度 LLM，节省 token，尊重用户意志
- **无 @**：每次都过调度 LLM；返回 'none' 时群里就只有用户独白（不强制 Fellow 回应）

### 摘要阈值

- **按 turn 数**：每 4 个用户 turn 触发一次（不按消息数，避免多 Fellow 抢答导致摘要频繁）
- **首次**：群里满 4 turn 后第一次生成
- **失败**：保留上一次成功的摘要，下个 turn 重试，不告知用户

### Nudge 阈值（v1 简化）

- 仅当 `pinnedGoal` 存在
- 用户连续 2 个 turn 没说话 + 上次 nudge 距今 >= 5 分钟 → 群主 Fellow 主动接话推进
- v1 实现保守，宁可少 nudge 也不打扰

## 6. 跨引擎共群

每个 Fellow 维护自己的引擎 session，群上下文按 dispatch 时机注入：

### Hermes Fellow

- 现有：`X-Mia-Fellow` header 标识当前 Fellow
- 新增：`X-Mia-Group-Context` header（base64-encoded JSON），含摘要 + 被 @ 历史
- `mia_plugins/fellow_overlay.py` 扩展：识别新 header，将群上下文拼到临时 system prompt

### Claude Code Fellow / Codex Fellow

- 在 SDK 调用前，由 `group-adapters.js` 把群上下文拼到 user message 前面：
  ```
  [群上下文]
  群名：<name>
  群摘要：<summary>
  最近相关消息：<filtered messages>
  ---
  [用户消息]
  <actual user content>
  ```
- 各 Fellow 各自的 thread/session 维持不变，群上下文不入 thread 历史（每次重传，避免 thread 污染）

## 7. 错误处理 & 降级

| 失败场景 | 行为 |
|---|---|
| 群主 dispatch 失败 | 降级到"无 @ 不发言"模式；插一条 system 气泡："群助手暂时不在线"；3 次连续失败提示换群主 |
| 群主 summarize 失败 | 沉默降级，保留旧摘要，下个 turn 重试 |
| 普通 Fellow 响应失败 | 该 Fellow 气泡显示 error + 重试按钮；其他 Fellow 不受影响；失败发言不进摘要 |
| 跨引擎 Fellow 出戏 | 群信息抽屉提供"重置群上下文"按钮，清空 contextCard 后下次发言重新生成 |
| 群主被删/离开 | 自动指派下一个成员为群主；插 system 气泡："X 离开了群，Y 成为群主" |
| 群仅剩 1 Fellow | 抽屉提示"转为单聊？"，不自动转 |

## 8. 组件 & 文件清单

**技术栈约束**：沿用现有 mia 风格——vanilla JS（无 React、无 TS、无构建链），扁平文件布局（与 `src/renderer/app.js`、`src/renderer/pet.js` 同级），renderer 侧 IPC 通过现有 `preload.js` 暴露 API。

### 新增

```
src/renderer/
  group.js                          # 群聊全部 renderer 逻辑（UI 渲染、@ 解析、composer、抽屉）
                                    # 跟 pet.js 同级；从 app.js 调用入口
  conductor.js                      # 调度 + 摘要 + nudge 协调层（renderer 侧无状态调用）
  group-prompts.js                  # dispatch / summarize / nudge prompt 拼装函数

src/main/
  group-store.js                    # 读写 engine-home/groups/，IPC 入口（main 进程）
  group-adapters.js                 # 三种引擎的群上下文注入（main 进程，与现有 chat adapter 同侧）

resources/conductor/
  default-prompts/
    dispatch.md
    summarize.md
    nudge.md
```

### 改动

- `src/main.js`：注册 group-store / group-adapters 的 IPC handler
- `src/preload.js`：暴露 `mia.groups.*` API
- `src/renderer/app.js`：侧边栏渲染能区分"群"和"1v1"条目；@ composer 复用现有 input；从 app.js 转发到 `group.js`
- `src/renderer/index.html` / `styles.css`：群相关 DOM 节点和样式
- `runtime/hermes-engine/mia_plugins/fellow_overlay.py`：识别 `X-Mia-Group-Context` header
- `engine-home/mia-sessions.json`：扩展 schema 支持 group sessions（保持向前兼容旧 1v1 session）

## 9. 测试策略

### 单元

- `@` 解析器（多 @、转义、不存在的 Fellow 名、@ 自己）
- Dispatch prompt 构造（含/不含 @、含/不含摘要、含/不含 pinnedGoal）
- Summarize 触发逻辑（首次、每 4 turn、retry、并发）
- GroupStore 读写（并发追加 messages.jsonl、context-card 原子写）
- 群主切换 / 群主离开的状态迁移

### 集成（mock 引擎）

- 黄金路径：3 Fellow 群，用户依次 @ 两个 + 留空，验证调度选择 + 摘要触发
- 跨引擎群：Hermes + mocked Claude Code Fellow 同群，分别验证两条注入路径
- 错误注入：dispatch 失败、单 Fellow 失败、summarize 失败的降级
- 群主切换中途状态、群主从成员里删除

### E2E / 手动 UX

- 创群 → 改群名/头像 → 加成员 → 设 pinnedGoal → 删 Fellow → 转单聊确认弹窗
- 50 turn mock 对话的摘要质量人工评估，看摘要漂移
- 多窗口：1v1 和群同时活跃，状态不冲突
- Fellow 人设一致性：群主在群里"接话"时人设是否保持，调度/摘要调用不污染单聊会话

### v1 不测

- 桌宠同屏（v2）
- todos / 完整 decorations 系统（v2）
- 大群（>5 Fellow）—— v1 限制最大 5 人

## 10. v2+ 预留方向

- 桌宠同屏：群打开时所有成员桌宠在桌面同屏，发言 Fellow 桌宠做"说话动作"
- Todos / 产出物：decorations 完整化，群里能挂任务卡片、产出文档/代码工件
- 大群：>5 Fellow 时摘要分片、调度采样而非全员评估
- 群主以外 Fellow 主动协作发起：某个 Fellow 主动 @ 队友（依赖更强的多 Agent 协议）
- 跨设备同步：通过现有 daemon/relay 实现群状态多端实时同步

## 11. 参考

- Cherry Studio（多 provider 适配的 normalizeMessage 模式）
- ClaudeCodeUI（per-CLI 适配文件布局）
- AutoGen GroupChat manager（调度模式）
- CrewAI（任务化角色协作）
- WeChat / Telegram / 飞书（群 UX：@、reply、群通知机器人）
- mia 本身的 Fellow + 引擎 + 桌宠抽象（这是设计的 anchor，所有选择以"贴合 mia 资产"为准）
