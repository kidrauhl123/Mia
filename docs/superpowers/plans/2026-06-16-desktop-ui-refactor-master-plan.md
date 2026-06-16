# Mia 桌面 UI 重构总计划

> **分支：** `UI重构`
>
> **设计基线：** `docs/superpowers/specs/2026-06-16-tg-mac-inspired-desktop-frontend-design.md`
>
> **目标：** 把 Mia 桌面端从“宽入口 DOM 控制器 + 局部视觉修补”重构成稳定、平台化、适合聊天和 Agent 长任务的桌面界面。macOS 要贴近 Apple / Telegram Mac 的现代浮动导航和系统外壳；Windows 要贴近 Windows 自己的窗口与交互习惯；两者共享同一套产品语义和渲染模型。

## 核心结论

Mia 是类聊天软件，但不是普通聊天软件。普通聊天软件的核心是“人和人发消息”；Mia 的核心是“人在聊天里驱动 Agent 工作”。所以这次 UI 重构不能只做皮肤，要同时解决：

- 聊天消息流如何稳定渲染。
- Agent 工具调用、审批、checkpoint、runtime 切换如何成为一等时间线。
- macOS / Windows 如何各自像原生应用。
- Apple Liquid Glass / Telegram 浮动导航风格如何服务 Mia，而不是变成纯装饰。
- `src/renderer/app.js` 如何持续变薄。

## 不可变决策

1. **一个产品设计，两个平台外壳。**
   macOS 和 Windows 不做两套产品。会话、聊天、Agent 时间线、技能市场、设置结构、状态 ownership 和渲染模型必须共用。

2. **平台差异只放在 shell 和 affordance 层。**
   窗口按钮、标题栏、拖拽区、系统材质、快捷键标签、右键菜单、全屏/最大化语义、密度微调可以按平台分支。

3. **不做大爆炸式重写。**
   这次仍然基于 Electron renderer + DOM。逐步引入 render model、keyed renderer、presentation token 和平台 shell adapter。

4. **`src/renderer/app.js` 必须变薄。**
   新 UI 行为进 feature 模块。`app.js` 只做装配、路由和依赖传递。

5. **Agent 时间线是一等 UI。**
   tool call、approval、runtime change、checkpoint、model switch、error、bridge state 都是 timeline entry，不是随手塞进 message bubble 里的临时块。

6. **macOS 主窗口使用原生交通灯。**
   macOS 桌面主窗口不继续手绘 traffic lights。手绘 SVG 可以留给 Web 预览、fallback 或非主 shell。主窗口交通灯由 Electron/macOS 原生按钮负责，renderer 里的 traffic light DOM 在 macOS 下隐藏。

7. **Windows 不模仿 macOS。**
   Windows 使用右上窗口控制、Windows 最大化/Snap 习惯、Windows 快捷键语义。Windows 不显示 macOS 交通灯。

8. **玻璃感只用于导航和控制层。**
   Apple / TG 风格的玻璃浮层用于 topbar、sidebar、composer controls、搜索、过滤、运行时控制等“操作层”。消息正文、代码块、工具长输出、审批正文以可读性优先。

9. **macOS 窗口外壳先写死为 iOS 26 / Liquid Glass 方向。**
   Telegram Mac 开源代码主窗口没有发现按 macOS 版本显式切大/小圆角的实现；它主要依赖原生 `NSWindow`，局部浮层才自绘固定圆角。因此 Mia 先采用自己的产品选择：macOS 主窗口使用透明 BrowserWindow + renderer 根节点裁 `--window-corner-radius: 28px`；最大化和全屏时取消外框圆角。

10. **rail 浮空必须是真浮空。**
    rail 的浮空不是换一个灰色背景，而是扩大 rail column、给 rail 自身 margin、圆角、阴影、backdrop blur，并让窗口左侧露出外壳背景。禁止用“保留原顶栏/原布局，只把底色调灰或调透明”的方式冒充浮层。

11. **四个 rail 页面共享一张连续地板。**
    `消息`、`发现/联系人`、`能力库`、`任务` 都不能各自再铺页面级底板。全局地板只由 `.app-shell` 提供；`.workspace`、各页面 layout、topbar、discover topbar、聊天 layout 都必须透明。保留的只能是承载内容或操作的具体浮层：会话/联系人中栏、内容卡片、详情卡片、composer card、sheet、popover、菜单、chip 和 modal。

12. **聊天底部必须有连续地板。**
    聊天区底部不再保留一块“输入栏承载面板”。`.chat-layout` 是连续的聊天地板，`.composer` 只是浮在地板上的 overlay；真正可见的只有输入卡片、附件 chips、回复 chips、权限提示和菜单。底部历史容器必须透明且不占单独 grid 行。

## 参考来源

### 本地代码参考

- `~/github/telegram-macos/packages/TGUIKit/Sources/TableRowItem.swift`
- `~/github/telegram-macos/packages/TGUIKit/Sources/TableRowView.swift`
- `~/github/telegram-macos/Telegram-Mac/ChatHistoryEntry.swift`
- `~/github/telegram-macos/Telegram-Mac/ChatListController.swift`
- `~/github/telegram-macos/packages/TGUIKit/Sources/PresentationTheme.swift`
- `~/github/telegram-macos/Telegram-Mac/Appearance.swift`
- `~/github/telegram-macos/packages/TGUIKit/Sources/VisualEffectView.swift`
- `~/github/telegram-macos/packages/TGUIKit/Sources/Window.swift`

### 外部设计参考

- Apple Liquid Glass / new design system：`https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass`
- Apple HIG Materials：`https://developer.apple.com/design/human-interface-guidelines/materials`
- Apple HIG Tab Bars：`https://developer.apple.com/design/human-interface-guidelines/tab-bars`
- WWDC25 Get to know the new design system：`https://developer.apple.com/videos/play/wwdc2025/356/`
- Telegram Liquid Glass-like update 报道：`https://9to5mac.com/2025/10/13/telegram-adopts-a-liquid-glass-like-design-no-ios-26-required/`

## 目标架构

Mia 桌面 UI 分四层：

```text
Cloud / Main / Runtime 状态
        │
        ▼
产品渲染模型
  - chat entries
  - conversation entries
  - settings rows
  - skill market entries
  - run/task entries
        │
        ▼
Renderer 模块
  - keyed timeline renderer
  - row/list renderer
  - composer controller
  - shell controller
  - presentation controller
        │
        ▼
平台表现层
  - CSS variables
  - body platform classes
  - native window controls
  - macOS / Windows material
  - keyboard / context menu affordances
```

平台层可以改变“感觉”，不能改变“产品是什么”。

## macOS 和 Windows 的分工

### 共享部分

- 信息架构。
- 会话列表数据模型。
- 聊天 timeline entry kinds 和排序。
- 日期分割、未读线、系统消息、消息分组。
- Agent trace、tool call、approval、checkpoint、runtime change 的语义模型。
- Composer state。
- 技能市场结构。
- 设置页分组和持久化语义。
- 主题 token 名称。
- render model 和状态转换测试。

### macOS 专属部分

- 左上原生 traffic lights。
- hidden titlebar / full-size content view。
- `setWindowButtonPosition` 安全定位。
- 侧栏和顶部操作区的轻量 vibrancy / glass。
- macOS 全屏行为，不照搬 Windows 最大化。
- `Cmd` 快捷键标签和菜单行为。
- 触控板滚动、hover、轻量 swipe 行为。
- 窄窗下保持交通灯安全区，不让导航/搜索遮挡。

### Windows 专属部分

- 右上 close / minimize / maximize。
- Windows Snap Layout 兼容。
- Windows 最大化/还原 hit region。
- `Ctrl` 快捷键标签。
- 可选 Mica / Acrylic-like 背景，但必须稳定可读。
- 标准 Windows hover、focus、context menu。
- 高 DPI / 混合缩放检查。

### Linux / 未知平台 fallback

- 稳定自定义标题栏和按钮。
- 不依赖 macOS vibrancy 或 Windows material。
- 共享产品 render model 和基础 CSS token。

## Apple / TG 浮动玻璃风格在 Mia 的落地方案

### 风格定义

这类风格不是简单“半透明背景”。真正有用的设计规则是：

- 内容层铺满底部。
- 导航和操作浮在内容上方，像独立功能岛。
- 控件按功能分组，变成胶囊、圆形按钮或短 toolbar。
- 背景有 blur / tint / highlight / shadow，但不能压过内容。
- 滚动、焦点、窗口状态变化时，浮层可以收缩、隐藏、变清晰或变轻。

### Mia 应该使用玻璃浮层的位置

0. **左侧 AppRail**
   - 第一阶段优先做。
   - macOS rail 采用独立浮岛：圆润外框、轻阴影、blur/tint、独立拖拽区。
   - 交通灯不画在 DOM 按钮里，macOS 使用原生按钮并安全定位到 rail 顶部区域。

1. **聊天顶部浮动控制区**
   - 当前会话标题。
   - 搜索按钮。
   - 会话详情 / 更多按钮。
   - 运行中 Agent 状态。
   - 重要 approval 数量。
   - 这一项必须等布局层级重做后再做；不能只把现有 topbar 背景改成半透明。

2. **右侧聊天区顶部上下文岛**
   - 当前 Bot / Agent 身份。
   - 当前 model/provider/effort 简要状态。
   - Bridge / desktop-local / cloud 状态。
   - 点击后展开运行时控制。

3. **底部 composer 浮层**
   - 输入框。
   - 附件按钮。
   - skill / tool 快捷入口。
   - permission mode。
   - 语音或 send 按钮。
   - composer 外层 form 不作为视觉面板存在，只负责定位、拖放和菜单锚点。
   - 回复、附件、权限提示可以随 composer 浮在地板上，但不能再各自长成大面板。

4. **侧栏搜索和筛选**
   - 搜索框可以是玻璃胶囊。
   - 会话 filter tabs 可以从满宽 tab row 改为浮动 segmented control。
   - 未读、运行中、Bot、群组等过滤项作为小胶囊。

5. **Agent 阻塞态提示**
   - Approval pending 可以用浮动 action pill，而不是普通 alert。
   - 长任务运行时可以在聊天区顶部或 composer 上方显示轻量状态岛。

### Mia 不应该玻璃化的位置

- 消息正文。
- 代码块。
- 工具调用长输出。
- 审批详情正文。
- 设置表单输入区。
- 技能详情正文。
- 错误堆栈和日志。

这些区域以阅读、复制、选择、对比为主，玻璃效果会降低效率。

### 聊天软件里的具体布局建议

Mia 的首页 shell 使用三槽位模型：

```text
AppRail | Optional IndexPane | Workspace
```

`Optional IndexPane` 不是一个永久左栏，而是 AppRail 的展开状态：

- `消息`、`联系人` 需要索引列表时，rail 右侧展开一个浮动抽屉，和 rail 同圆角、同地板、同外壳系统。
- `发现 AI 同事`、`能力库`、`任务`、`设置` 不需要索引列表时，rail 保持收起，workspace 直接占用右侧。
- 窄窗口下不能保留桌面四列模板；必须退化为 `AppRail + 当前内容` 两列。进入聊天/联系人详情时隐藏中栏，返回按钮切回中栏。
- 窄窗口聊天顶部只保留返回 + 当前对象核心身份，隐藏桌面端聊天历史胶囊；composer 降密度，消息气泡按内容列重新计算宽度。

具体规则：

- `消息`：默认三槽位，`AppRail + 会话中栏 + 聊天 workspace`。
- `联系人 rail`：默认进入 `发现 AI 同事`，这是全宽 workspace，不显示中栏。
- `联系人` 子页：从发现/联系人顶部胶囊切换进入，使用三槽位，`AppRail + 联系人中栏 + 联系人详情 workspace`。
- `能力库`、`任务`、`设置`：默认全宽 workspace，不保留空中栏。

桌面宽屏：

```text
┌─────────────────────────────────────────────────────────┐
│ 原生窗口 shell / 平台安全区                              │
├───────────────┬─────────────────────────────────────────┤
│ 侧栏           │ 聊天内容背景                             │
│               │   ┌───────────────┐ ┌────┐ ┌────┐       │
│ 搜索胶囊       │   │ 会话标题/状态岛 │ │搜索│ │更多│       │
│ filter 胶囊    │   └───────────────┘ └────┘ └────┘       │
│ 会话列表 rows  │                                         │
│               │   timeline entries                       │
│               │                                         │
│               │   ┌───────────────────────────────┐     │
│               │   │ composer 浮动胶囊              │     │
│               │   └───────────────────────────────┘     │
└───────────────┴─────────────────────────────────────────┘
```

窄窗：

- 侧栏和聊天区不强行并排。
- 顶部浮动控制收缩成标题 + 返回 + 更多。
- 搜索进入单独浮层或 command palette。
- Composer 保持底部，但减少 runtime 控件，只展示当前状态入口。

### 视觉语气

Mia 不应该做 Telegram 贴纸/娱乐化风格。Mia 的玻璃感应更偏：

- 清晰。
- 安静。
- 专业。
- 有平台质感。
- 让 Agent 状态更容易扫读。

可参考 Apple/TG 的“浮动、分组、玻璃层级”，不复制它们的表情、色彩和装饰密度。

## 主实施流

这些流可以并行，但集成顺序要谨慎。

### A. 渲染模型基础

目的：先让 UI 输出可预测，再改视觉。

目标文件：

- `src/renderer/chat/chat-entry-builder.js`
- `src/renderer/chat/chat-entry-ids.js`
- `src/renderer/conversations/conversation-entry-builder.js`
- `src/renderer/rows/row-interaction.js`

职责：

- 把 raw messages / events 转成稳定 timeline entries。
- 定义 stable entry ID 规则。
- 把排序、分组、系统 entry 从 DOM 代码里抽走。
- 保持 scroll 和 streaming identity。
- 提供不依赖 Electron 的单测。

### B. Keyed rendering

目的：长列表和 timeline 更新不再整块重建。

目标文件：

- `src/renderer/chat/chat-timeline-renderer.js`
- `src/renderer/conversations/conversation-list-renderer.js`
- `src/renderer/rows/keyed-list-renderer.js`

职责：

- 按 entry ID 复用 DOM node。
- patch 变化状态，而不是替换整条列表。
- 保持 selection、focus、scroll position、pending state。
- 支持 streaming assistant message 和 tool update。

### C. 平台 shell

目的：先让窗口外壳正确，再做视觉。

目标文件：

- `src/main/mac-window-controls.js`
- `src/main/ipc/window-ipc.js`
- `src/main.js` BrowserWindow 创建路径。
- `src/renderer/shell/window-shell.js`
- `src/renderer/styles/window-shell.css`

职责：

- 定义各平台窗口控制策略。
- macOS 主 shell 移除手绘 traffic lights。
- 保持 Windows 控制按钮和 Snap Layout。
- 维护 drag / no-drag 区域。
- 处理 focus、blur、fullscreen、maximize 状态。

### D. Presentation layer

目的：统一语义化外观，不再散落 magic color / spacing。

目标文件：

- `src/renderer/presentation/presentation-state.js`
- `src/renderer/presentation/platform-presentation.js`
- `src/renderer/styles/presentation.css`
- 逐步迁移 `src/renderer/styles.css` 中的平台和 token 片段。

职责：

- 把 app state + OS + theme + accessibility settings 映射成 semantic tokens。
- 输出 CSS variables 和 platform classes。
- 支持 dark / light、reduced transparency、compact density、platform material。
- 禁止业务 JS 新增硬编码颜色。

### E. Agent timeline UX

目的：围绕 Agent 工作设计，而不是只做普通聊天气泡。

目标文件：

- `src/renderer/agent-timeline/`
- `src/renderer/chat/chat-entry-builder.js`
- `src/renderer/styles/agent-timeline.css`

职责：

- tool call、approval、checkpoint、runtime change、error 一等渲染。
- 统一 collapsed / expanded 状态。
- copy、retry、inspect、approval action 有稳定入口。
- 长工具输出默认不占满首屏。

### F. Composer 和运行时控制

目的：输入框不只是发消息，而是 Agent run setup surface。

目标文件：

- `src/renderer/composer/composer-state.js`
- `src/renderer/composer/composer-renderer.js`
- `src/renderer/styles/composer.css`

职责：

- 建模 text、attachments、reply target、selected Bot、model/provider、effort、permission mode、skill context。
- Runtime 控件紧凑但可发现。
- macOS / Windows 快捷键标签正确。
- 与移动端共享语义状态，平台 UI 各自实现。

## 分阶段计划

## Phase 0：现状盘点

目标：改动前明确现状，避免边改边猜。

任务：

- [ ] 记录当前 BrowserWindow options、traffic light 路径、drag region、focus/blur、fullscreen/maximize。
- [ ] 盘点 `app.js` 里的 render 函数，按 shell、conversation list、chat timeline、composer、settings、skills、social、runtime 分组。
- [ ] 找出当前聊天消息渲染入口和所有触发更新的位置。
- [ ] 找出当前会话列表渲染入口和所有触发更新的位置。
- [ ] 记录当前 CSS token 和 platform selector。
- [ ] 记录现有 shell、settings、skill market、appearance 相关测试。
- [ ] 截 macOS 手工基线图：浅色、深色、聚焦、失焦、全屏、窄窗。
- [ ] Windows 可用时截基线图：浅色、深色、最大化、还原、高 DPI。

验收：

- 有一份简短 inventory note。
- 不改变行为。
- Phase 1/2 的接入点明确。

## Phase 1：渲染模型基础，不改视觉

目标：先建立稳定 timeline entries 和 presentation baseline。

任务：

- [ ] 创建 `chat-entry-builder`。
- [ ] 定义 message、date-divider、unread-divider、system、tool-call、approval、checkpoint、runtime-change、error 的 entry ID 规则。
- [ ] 添加 entry 排序、分组、stable ID 测试。
- [ ] 创建初始 presentation state module，只映射现有 theme/platform，不改变视觉。
- [ ] 创建 renderer shell platform helper。
- [ ] 在 `app.js` 标注未来抽取边界，避免新大函数继续进入入口。

验收：

- 单测证明 chat entries 稳定。
- 预期没有可见 UI 变化。
- 没有新的大段业务逻辑进入 `app.js`。

## Phase 2：平台 shell 重构

目标：先解决窗口外壳、交通灯、标题栏、拖拽区。

### macOS 任务

- [ ] 主窗口切到原生 traffic lights。
- [ ] macOS primary shell 隐藏或移除 renderer SVG traffic-light buttons。
- [ ] 使用 `setWindowButtonVisibility` 和 `setWindowButtonPosition`。
- [ ] 验证普通、全屏、窄窗下不遮挡侧栏内容。
- [ ] 验证 drag / no-drag 不阻塞按钮、tab、composer、菜单。
- [ ] 手绘 traffic-light 资产只保留给 Web/mock/fallback。

### Windows 任务

- [ ] 明确 Windows titlebar 策略：native frame、custom frame 或 Electron overlay。
- [ ] 保留右上 minimize/maximize/close。
- [ ] 验证 maximize/restore 和 Snap Layout。
- [ ] Windows 不显示 macOS traffic lights。
- [ ] focus/blur/maximized 状态映射到 body classes 和 aria labels。

### 共享任务

- [ ] 把 shell wiring 从 `app.js` 移到 `src/renderer/shell/window-shell.js`。
- [ ] 把 shell CSS 移到 `src/renderer/styles/window-shell.css` 或聚焦平台段落。
- [ ] 增加 renderer shell 测试，覆盖平台控制按钮可见性和标签。

验收：

- macOS 主 shell 使用原生交通灯。
- Windows 保持 Windows 控制按钮和最大化行为。
- 两个平台 drag region 正确。
- 现有 window IPC 不回退。

## Phase 3：Mia 风格浮动导航首版

目标：在不破坏结构的前提下，把 Apple/TG 的浮动导航思想落到 Mia。

任务：

- [ ] 定义 `floating-surface`、`floating-pill`、`floating-control-group` 语义 class。
- [ ] 聊天顶部从满宽 header 过渡到浮动标题/状态岛。
- [ ] 搜索和更多操作变成独立浮动 control group。
- [ ] Composer 外层改为底部浮动胶囊，但正文输入保持高可读。
- [ ] 侧栏搜索框和 filter row 改为轻量浮动/胶囊风格。
- [ ] macOS 使用 vibrancy/backdrop-filter；Windows 使用稳定 fallback 或 Mica-like token。
- [ ] 增加 reduced transparency fallback。

验收：

- 看起来有现代 Apple/TG 浮动层级。
- 不遮挡消息内容。
- 不影响搜索、更多、发送、审批操作。
- 深浅色都可读。
- 透明/模糊不可用时仍然正常。

## Phase 4：Keyed chat timeline

目标：聊天流改为稳定 entry rendering。

任务：

- [ ] 创建 `chat-timeline-renderer` 消费 `buildChatEntries`。
- [ ] 风险高时先加 feature flag 或窄接入开关。
- [ ] 第一版保留现有 message bubble renderer 渲染 `message` entry。
- [ ] 单独渲染 `date-divider`、`unread-divider`、`system`、`error`、`runtime-change`。
- [ ] 把 tool / trace / approval 展示迁到明确 entry renderer。
- [ ] 保持 scroll position。
- [ ] streaming 时复用同一个 DOM node。
- [ ] 保留 copy/delete/retry/approval 行为。
- [ ] 添加 DOM fixture 测试，验证 node reuse 和状态 patch。

验收：

- 单条消息更新不会重建整条 timeline。
- streaming、pending、failed、approved 状态原地更新。
- 现有聊天操作不回退。
- Agent 事件作为结构化 timeline entries 可见。

## Phase 5：会话列表和侧栏

目标：左侧会话区稳定、紧凑、平台化。

任务：

- [ ] 创建 conversation entry builder。
- [ ] entry 包含 unread、pin、active run、last message preview、member/avatar、offline/bridge 状态。
- [ ] 会话列表改成 keyed rows。
- [ ] 统一 row interaction：active、selected、hover、context menu、keyboard focus。
- [ ] 通过 token 微调 macOS / Windows 密度，不复制 markup。
- [ ] 刷新时保留缓存内容，避免闪空。

验收：

- 会话列表更新不明显闪烁。
- active conversation 和 unread 状态稳定。
- macOS / Windows 只在 shell、density、presentation token 层有差异。

## Phase 6：Presentation system

目标：建立语义 token，停止散乱样式。

任务：

- [ ] 定义 surface、bubble、timeline、row、chrome、focus、status、runtime token。
- [ ] 先把现有 CSS variables 映射进语义层。
- [ ] 增加 dark/light 和平台变体。
- [ ] 增加 reduced transparency fallback。
- [ ] 新 CSS 进入 `src/renderer/styles/<feature>.css`。
- [ ] 添加 style tests 覆盖关键 token 和 platform selector。

验收：

- 新 UI 模块消费语义变量。
- macOS material 和 Windows material 可以开关/降级。
- 业务 JS 不新增硬编码颜色。

## Phase 7：Agent timeline 视觉系统

目标：让长 Agent 任务可以被扫读和操作。

任务：

- [ ] 定义 `tool-call`、`approval`、`checkpoint`、`runtime-change`、`agent-event`、`error` 视觉样式。
- [ ] 添加 collapsed / expanded 状态。
- [ ] 添加 copy / inspect / retry / approve / deny 入口。
- [ ] 长日志和工具输出默认折叠。
- [ ] approval entry 接入现有审批流程。
- [ ] Agent timeline 空态、错误态、加载态统一。

验收：

- 长 Agent run 不需要看 dev log 也能理解。
- 阻塞审批显眼且可操作。
- 工具输出不展开时不压垮聊天流。

## Phase 8：Composer 和 runtime controls

目标：输入区成为清晰的 Agent 运行控制面。

任务：

- [ ] 创建 `ComposerState`。
- [ ] 状态包含 text、selection、reply、attachment drafts、Bot、model/provider、effort、permission mode、skill context。
- [ ] 把 composer render/update 从 `app.js` 移出。
- [ ] Runtime controls 紧凑呈现，点击展开。
- [ ] macOS / Windows shortcut labels 正确。
- [ ] send disabled / pending / failed 状态明确。
- [ ] 预留 attachment slot，不强行一次完成上传功能。

验收：

- Composer 行为由一个状态对象控制。
- model / effort / permission 可见且一致。
- 键盘行为符合平台。

## Phase 9：设置、技能和次级列表

目标：把同一套 row/render/presentation 模型推广到次级界面。

任务：

- [ ] 技能市场卡片/列表改用 stable entries。
- [ ] 设置 rows 使用统一 row interaction。
- [ ] task/run list 使用 stable run entries。
- [ ] 空态、加载态、错误态统一。
- [ ] 模块稳定后删除重复 row/menu 逻辑。

验收：

- 次级界面和聊天/侧栏同一种交互语言。
- `app.js` 不新增大 feature 代码。

## Phase 10：跨平台 QA 和合并门槛

目标：证明重构稳定后再合并。

必须检查：

- [ ] 改动 renderer JS 跑 `node -c`。
- [ ] 定向跑 `node --test tests/renderer-*.test.js`。
- [ ] shell、settings、skill market、appearance 相关测试通过。
- [ ] macOS 手工检查：浅色、深色、聚焦、失焦、全屏、窄窗、traffic lights、drag region、快捷键。
- [ ] Windows 手工检查：浅色、深色、最大化、还原、Snap Layout、高 DPI、窗口按钮、快捷键。
- [ ] 长 Agent run 手工检查：streaming、tool call、approval、failure、retry。
- [ ] 透明/模糊不可用 fallback 检查。

合并门槛：

- 窄窗无 UI 控件重叠。
- 刷新时 unread / active conversation 不闪。
- keyed renderer 落地后，单条消息更新不重建整条 timeline。
- macOS 主 shell 不使用手绘 traffic lights。
- Windows 不出现 macOS traffic-light 隐喻。
- 玻璃浮层不影响正文、代码、工具输出的阅读和复制。

## 文件归属规则

优先新增聚焦模块：

- `src/renderer/chat/`
- `src/renderer/conversations/`
- `src/renderer/composer/`
- `src/renderer/shell/`
- `src/renderer/presentation/`
- `src/renderer/agent-timeline/`
- `src/renderer/rows/`
- `src/renderer/styles/<feature>.css`

避免：

- 往 `src/renderer/app.js` 加大型新函数。
- 新建宽泛 `utils.js` / `helpers.js`。
- 为 macOS / Windows 复制两套完整页面 markup。
- 增加无法被语义 token 解释的纯视觉 CSS。
- 把消息正文、代码、日志做成高透明玻璃。

## 风险表

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 原生 traffic lights 和侧栏内容重叠 | macOS shell 破坏感强 | Phase 2 先做 shell，设置安全区 token，截图验证 |
| Windows Snap Layout 被 custom chrome 破坏 | Windows 可用性下降 | 先定 Windows titlebar 策略，再做视觉 |
| 玻璃浮层影响阅读 | Agent 输出难读 | 玻璃只用于导航/控制层，正文层保持清晰 |
| Timeline renderer 破坏 scroll position | streaming 体验变差 | keyed renderer 测试和 scroll anchoring 测试 |
| Agent event shape 和后端不一致 | timeline entries 混乱 | 用真实 message/event fixture 建 builder 测试 |
| `app.js` 继续膨胀 | 架构目标失败 | 新功能必须进 feature module |
| 平台样式 fork | 维护成本翻倍 | 共享 semantic token，平台只补 shell/material/density |
| 视觉追 TG 过头 | Mia 失去产品性格 | 借鉴浮动/分组/层级，不复制娱乐化装饰 |

## 推荐实施顺序

1. Phase 0：现状盘点。
2. Phase 1：chat entry builder 和测试。
3. Phase 2：平台 shell，先解决交通灯/标题栏/拖拽区。
4. Phase 3：Mia 风格浮动导航首版。
5. Phase 4：keyed chat timeline。
6. Phase 5：会话列表和侧栏。
7. Phase 6：presentation token。
8. Phase 7：Agent timeline 视觉系统。
9. Phase 8：composer/runtime controls。
10. Phase 9：设置、技能和次级列表。
11. Phase 10：跨平台 QA。

顺序可以因阻塞调整，但不要在 Phase 2 前做大面积视觉 polish，也不要在 Phase 1 前重写 timeline 渲染。

## 完成定义

这次 UI 重构完成时，Mia 应该满足：

- 聊天 timeline 和主长列表有共享 render model。
- `app.js` 明显变薄，至少不再继续承载新大 UI 域。
- macOS shell 使用原生窗口按钮，看起来像 macOS 应用。
- Windows shell 看起来像 Windows 应用，最大化和 Snap 行为正常。
- Apple/TG 的浮动玻璃风格被吸收到 Mia 的导航和控制层。
- Agent 工作被结构化为 timeline entries。
- Presentation token 控制平台样式。
- 定向测试和跨平台手工检查通过。
- 最终结果不是 Telegram 克隆，而是一个更成熟、更原生、更适合 Agent 工作的 Mia。
