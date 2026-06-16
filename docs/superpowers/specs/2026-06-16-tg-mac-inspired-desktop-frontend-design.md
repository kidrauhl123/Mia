# TG Mac 启发的 Mia 桌面前端设计基线

日期：2026-06-16

Status: planning baseline. This document turns the Telegram macOS source reading into concrete frontend architecture rules for Mia desktop implementation.

## 背景

Telegram macOS 最新源码已经浅克隆到本地 `~/github/telegram-macos`。它不是 Telegram Desktop Qt 版，而是 Apple 平台原生 AppKit/Swift 项目。Mia 不能照搬它的代码或框架，但可以借鉴它对聊天产品前端复杂度的分层方式。

Mia 当前桌面端是 Electron renderer + DOM + CSS，主产品面在桌面。已有基础包括：

- `src/renderer/styles.css` 的 CSS token 和 macOS 窗口样式。
- `src/main/mac-window-controls.js` 的原生交通灯控制。
- `src/renderer/app-state.js` 的集中初始状态。
- `apps/mobile-rn/src/theme.ts` 的移动端 theme token。

主要问题是桌面 renderer 仍然过度集中：`src/renderer/app.js` 和 `src/renderer/styles.css` 已经很宽，继续直接堆 UI 逻辑会让聊天、Agent trace、技能市场、运行时控制互相牵连。

## TG Mac 观察结论

### Row model first

TG Mac 的长列表不是直接渲染原始数据。核心模式是 `TableRowItem -> TableRowView`：

- `TableRowItem` 带 `stableId`、尺寸、排序、view class、菜单、可见性等渲染元数据。
- `TableRowView` 负责 hover、右键、双击、pressure click、layer 绘制等行级交互。
- 列表通过稳定 ID 和 transition 做差量更新，而不是整块重画。

本地参考：

- `~/github/telegram-macos/packages/TGUIKit/Sources/TableRowItem.swift`
- `~/github/telegram-macos/packages/TGUIKit/Sources/TableRowView.swift`
- `~/github/telegram-macos/Telegram-Mac/ChatListController.swift`

### Timeline entries are product semantics

TG Mac 的聊天流先把原始消息转成 `ChatHistoryEntry`。日期分割、未读线、服务消息、媒体组、topic 分隔都不是渲染时临时拼出来的 DOM，而是一等 timeline entry。

这对 Mia 更重要：Mia 的聊天流除了普通消息，还有 Agent tool call、审批、runtime 变化、checkpoint、错误、技能调用、模型切换、桥接状态等产品事件。

本地参考：

- `~/github/telegram-macos/Telegram-Mac/ChatHistoryEntry.swift`
- `~/github/telegram-macos/Telegram-Mac/ChatInterfaceState.swift`

### Presentation is more than colors

TG Mac 的 presentation/theme 层不只是颜色变量，还包含 appearance、图标资源、派生资源缓存、聊天列表状态色、气泡资源和平台外观适配。

Mia 已有 CSS variables 和 RN theme，但缺少跨桌面/移动的语义 presentation 层。颜色名不应该直接泄露到业务渲染逻辑里。

本地参考：

- `~/github/telegram-macos/packages/TGUIKit/Sources/PresentationTheme.swift`
- `~/github/telegram-macos/Telegram-Mac/Appearance.swift`

### Mac feeling comes from restrained native affordances

TG Mac 的 macOS 感来自窗口 chrome、traffic light、安全区、vibrancy、行交互、右键菜单、键盘路径和系统外观适配。毛玻璃不是目的，也不是每个卡片都该使用。

Mia 应该采用轻量、可关闭、可降级的 macOS polish：侧栏/顶部 chrome 可用 vibrancy，消息阅读面保持清晰稳定。

本地参考：

- `~/github/telegram-macos/packages/TGUIKit/Sources/VisualEffectView.swift`
- `~/github/telegram-macos/packages/TGUIKit/Sources/Window.swift`

## 设计目标

1. 让 Mia 桌面聊天 UI 从“直接渲染数据”转向“先构造稳定 render model，再差量渲染”。
2. 把 Agent 相关系统事件提升为一等 timeline entry，而不是附着在 message bubble 内部的临时块。
3. 让 `src/renderer/app.js` 继续变薄，新增复杂 UI 进入 feature 模块。
4. 建立桌面和移动端可以共享的聊天语义模型，具体平台保留各自 presentation。
5. 提升 macOS 贴合度，但不牺牲可读性、性能和跨平台稳定性。

## 非目标

- 不迁移到 Swift/AppKit。
- 不导入或复制 Telegram 源码。
- 不做 Telegram 皮肤、品牌或交互克隆。
- 不进行一次性 React 重写。
- 不改变 Cloud 作为登录态 conversation state 写入权威的既有 ADR。
- 不把 macOS vibrancy/glass 当成所有界面的默认背景。

## Mia 前端规则

### 1. 新长列表必须有 stable entry

聊天消息、会话列表、技能市场、任务/运行列表等新增或重构时，应先构造 entry model：

```js
{
  id: "message:abc",
  kind: "message",
  orderKey: "00000123",
  timestamp: 1718530000000,
  renderState: {},
  actionState: {}
}
```

`id` 必须稳定，不能依赖当前数组下标。渲染层只能根据 entry 更新 DOM，不直接拥有业务排序规则。

### 2. 聊天流先走 `buildChatEntries`

Mia 桌面聊天流应引入纯函数：

```js
buildChatEntries({
  messages,
  conversation,
  members,
  runtimeState,
  approvalQueue,
  now
})
```

初始 entry kinds：

| kind | 用途 |
| --- | --- |
| `message` | 普通用户、Bot、Agent 消息 |
| `date-divider` | 日期分割 |
| `unread-divider` | 未读位置 |
| `agent-event` | Agent 开始、完成、取消、失败 |
| `tool-call` | 工具调用、参数、结果、状态 |
| `approval` | 权限请求和决策结果 |
| `checkpoint` | 长任务阶段、恢复点 |
| `runtime-change` | 模型、provider、effort、permission mode 切换 |
| `system` | 邀请、成员、同步、桥接等系统提示 |
| `error` | 可恢复错误和不可恢复错误展示 |

这个函数必须可单测，不读 DOM，不依赖 Electron。

### 3. Renderer feature 模块拥有交互，入口只装配

新增桌面 UI 模块优先进入聚焦目录，例如：

- `src/renderer/chat/`
- `src/renderer/conversations/`
- `src/renderer/presentation/`
- `src/renderer/agent-timeline/`

`app.js` 只传入 `state`、`els`、`api`、`render` 等窄依赖，不新增大段业务逻辑。

### 4. Row interaction contract 统一

行级 UI 应明确支持这些能力，而不是每个列表各写一套：

- hover / active / selected / disabled 状态。
- context menu / overflow menu。
- keyboard focus 和快捷键入口。
- primary action、secondary action。
- pending、failed、stale、offline 等状态。

第一版不必抽象成大型 UI kit，但同一类交互不应散落在多个文件里重复实现。

### 5. Presentation token 语义化

Mia 应新增一个语义 presentation 层，负责把平台、主题、密度和系统效果映射成 UI token。

示例 token：

```js
{
  surface: {
    app: "...",
    sidebar: "...",
    chat: "...",
    floating: "..."
  },
  bubble: {
    user: "...",
    assistant: "...",
    system: "..."
  },
  timeline: {
    divider: "...",
    agentEvent: "...",
    toolCall: "...",
    approval: "..."
  },
  chrome: {
    macVibrancy: true,
    trafficLightInset: "..."
  }
}
```

CSS 仍然是最终渲染载体，但业务模块不直接散落 magic color、magic spacing。

### 6. Mac polish must be progressive

macOS 专属体验可以包括：

- sidebar / topbar 的轻量 vibrancy。
- 更贴近系统的 traffic light inset 和 drag region。
- 紧凑但清晰的列表密度。
- 原生感右键菜单、快捷键、焦点环。

必须满足：

- 内容阅读区优先清晰。
- 深浅色主题都可读。
- 非 macOS 平台有稳定 fallback。
- 用户设置里可以关闭重视觉效果或跟随系统降低透明度。

## 实施阶段

### Phase 1: Chat entry builder

新增纯逻辑模块和测试，把当前消息、日期分割、系统状态、Agent trace 的输入统一映射成 timeline entries。

建议文件：

- `src/renderer/chat/chat-entry-builder.js`
- `tests/renderer-chat-entry-builder.test.js`

验收：

- 不改 UI 行为。
- 覆盖普通消息、日期分割、未读线、tool call、approval、runtime-change。
- `node --test tests/renderer-chat-entry-builder.test.js` 通过。

### Phase 2: Keyed timeline renderer

在现有聊天渲染路径后面接入 keyed update。第一版可以只服务聊天消息流，不急着推广到全部列表。

建议文件：

- `src/renderer/chat/chat-timeline-renderer.js`
- `src/renderer/styles/chat-timeline.css`

验收：

- 不因单条消息更新而重建整条 timeline。
- streaming / pending / failed 状态能稳定更新同一个 DOM node。
- message action、copy、delete、retry、approval sheet 现有行为不回退。

### Phase 3: Presentation layer

把桌面 CSS token 和移动端 theme 的共同语义收敛为 presentation baseline，再由平台样式消费。

建议文件：

- `src/renderer/presentation/presentation-state.js`
- `src/renderer/styles/presentation.css`

验收：

- macOS vibrancy / compact density / dark mode 由语义 token 控制。
- 新增 token 有默认值和深色值。
- 业务 JS 不直接写新的颜色常量。

### Phase 4: Mac desktop polish pass

在结构稳定后做视觉与交互层调整：

- sidebar/topbar 轻量 macOS material。
- 会话列表密度、active/hover 状态、未读和运行中状态统一。
- 聊天区系统 entry、tool entry、approval entry 视觉统一。
- 右键菜单、键盘路径、焦点态补齐。

验收：

- macOS 截图在深浅色下都可读。
- 窄窗不溢出，不遮挡 traffic light。
- 非 macOS fallback 不破版。

### Phase 5: Broader list model

将 stable entry + keyed renderer 的模式推广到：

- conversation list。
- skill market。
- task/run list。
- settings rows。

验收：

- 每个列表都有稳定 ID。
- 搜索、筛选、加载、刷新不闪空缓存内容。
- 行级菜单和键盘行为一致。

## 第一批落地清单

1. 建 `chat-entry-builder`，先不接 UI。
2. 给 builder 写覆盖 Agent timeline 语义的单测。
3. 找出现有聊天渲染入口，标注最小接入点。
4. 建 presentation baseline，先只映射现有 CSS variables，不改视觉。
5. 在 macOS 下小范围试 sidebar/topbar material，保持可关闭和 fallback。

## 测试策略

- 纯 entry builder 用 `node --test`。
- keyed renderer 用 DOM fixture 测稳定 ID、节点复用、状态更新。
- CSS 用现有 renderer style 测试覆盖关键 selector 和 token。
- 真实交互改动再用 `npm start` 人工验证 macOS 深浅色、窄窗、右键菜单和键盘路径。

## 决策

- Mia 借鉴 TG Mac 的 render model / diff / presentation 思路，不借鉴实现语言和 UI 皮肤。
- 桌面端继续是主产品面，移动端跟随共享语义模型，而不是复制桌面 DOM。
- Agent timeline 是 Mia 相对普通聊天软件的核心差异，必须变成一等渲染模型。
- macOS 贴合度应落在 chrome、density、interaction、material 的克制使用上，而不是全局 glass 化。
