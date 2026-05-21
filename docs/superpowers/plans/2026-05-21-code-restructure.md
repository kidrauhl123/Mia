# Aimashi 代码结构重整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/main.js`（~7800 行）和 `src/renderer/app.js`（~8050 行）按 CLAUDE.md「代码组织」节的目标布局重构，让 `main.js` < 500 行（只剩启动 + 装配）、`app.js` < 800 行（只剩装配 + 路由），其余按特性独立成模块。

**Architecture:** 渲染端复用 `src/renderer/group.js` 已验证的样板：IIFE + `window.aimashi<Feature>` 命名空间 + `init<Feature>({...deps})` 注入依赖；主进程端复用 `src/main/codex-chat-adapter.js` 样板：CommonJS module + `main.js` 装配点 require。**零行为变更**——本计划只挪位置和重组依赖注入，不优化、不重命名 API、不改样式、不补功能。

**Tech Stack:** Vanilla JS, Electron, Node `node:test`，`node src/check.js` 做结构校验，`npm test` 做后端测试，`npm run open` 启动 app 做手测。

---

## 拆分前必读

### 验证方式
渲染端目前**没有自动化测试**，所以每个 renderer 任务的验证靠：
- `node src/check.js` 通过（结构 / 显式注册）
- `npm test` 通过且用例数不减少
- `npm run open` 后手测对应功能区，行为与拆分前完全一致

主进程改动有部分覆盖（IPC、cloud、tasks 有 test），但 fellow/engine 等大块也无 renderer 级测试。手测仍是最终安全网。

### 样板对照
- **渲染端**：参考 `src/renderer/group.js` —— 完整 IIFE，结尾 `window.aimashiGroup = {...}`，`app.js` 启动时 `await window.aimashiGroup.initGroupModule({ state, els, deps... })`；HTML 引入 `<script src="./group.js"></script>` 放在 `app.js` 之前。
- **主进程**：参考 `src/main/codex-chat-adapter.js` —— `module.exports = { fn1, fn2, ... }`，`main.js` 顶部 `const codexAdapter = require('./main/codex-chat-adapter.js')`，装配时调用。

### 风险红旗（每个任务都要意识到）
1. **`state.activeKey` 30+ 处读写** —— 不拆这个 state 对象本身，只拆使用它的函数
2. **`els.<id>` 200+ 处使用** —— `els` 容器保留在 `app.js`，新模块通过 init 注入 `els` 引用
3. **`render()` / `renderView()` 是唯一编排** —— 新模块的 render 函数由 `app.js` 的主 `render()` 调用，不能丢调用点
4. **`state.runtime` 多模块读写** —— 修改 shape 必须审查所有读取点
5. **IPC channel 名不能变** —— main / renderer 之间的字符串契约
6. **流式事件链** —— `chat-send` / `chat-render` / `appendChat` 是耦合最重的，本计划**不拆 chat 主流程**，只拆周边

### 任务分批
- **Phase A**：渲染端低耦合特性（独立面板和对话框）
- **Phase B**：渲染端中等耦合（fellow、session、消息菜单）
- **Phase C**：渲染端常量、helpers、事件监听拆分
- **Phase D**：主进程特性模块拆分
- **Phase E**：主进程 IPC handlers 按域拆分
- **Phase F**：最终验收

每个 Task 一个 commit。Phase 边界处停下来汇报进度，等用户确认再进下一 Phase。

---

## Phase A: 渲染端低耦合特性

### Task A1: 抽取 Tasks 面板

**Files:**
- Create: `src/renderer/tasks-panel.js`
- Modify: `src/renderer/app.js`（移除约 450 行：3973-4440，及相关 helpers）
- Modify: `src/renderer/index.html`（加 `<script src="./tasks-panel.js"></script>`）
- Modify: `src/check.js`（如果有显式注册新文件清单，要登记）

- [ ] **Step 1: 定位行号**

读取 `src/renderer/app.js` 行 3973-4440（任务面板渲染主体）+ 用 grep 找其它任务相关函数：
```bash
grep -n "renderTask\|loadTasksFromDaemon\|subscribeTaskEvents\|renderRunDetail\|renderTraceBlocks" src/renderer/app.js
```
列出完整行号清单。

- [ ] **Step 2: 创建新模块（IIFE 样板）**

仿 `src/renderer/group.js` 结构：
```javascript
(function () {
  "use strict";

  let deps = null;

  function init(injected) {
    deps = injected;
    // 后续函数从 deps.state / deps.els / deps.window 取依赖
  }

  function renderTaskSidebar() { /* 从 app.js 挪过来 */ }
  function renderTaskView() { /* ... */ }
  function renderTaskDetail() { /* ... */ }
  function renderRunDetail() { /* ... */ }
  function renderTraceBlocks() { /* ... */ }
  function loadTasksFromDaemon() { /* ... */ }
  function subscribeTaskEvents() { /* ... */ }
  // ... 其余 task 相关函数

  window.aimashiTasksPanel = {
    initTasksPanel: init,
    renderTaskSidebar,
    renderTaskView,
    renderTaskDetail,
    renderRunDetail,
    loadTasksFromDaemon,
    subscribeTaskEvents,
  };
})();
```
所有原本访问 `state.xxx` / `els.xxx` 的地方改为 `deps.state.xxx` / `deps.els.xxx`。

- [ ] **Step 3: 在 `app.js` 装配点注入**

找到 `initializeRuntime()`（约行 6116-6175），在 group module 初始化的旁边加：
```javascript
if (window.aimashiTasksPanel) {
  window.aimashiTasksPanel.initTasksPanel({ state, els, aimashi: window.aimashi });
}
```
找到 `render()` / `renderView()` 中所有调用 `renderTaskSidebar()` / `renderTaskView()` / `renderTaskDetail()` / `renderRunDetail()` 的地方，改为 `window.aimashiTasksPanel.renderTaskXxx()`。
找到调用 `loadTasksFromDaemon()` / `subscribeTaskEvents()` 的地方，同样改为 `window.aimashiTasksPanel.xxx`。

- [ ] **Step 4: 从 `app.js` 删除已迁移代码**

按 Step 1 的行号清单删除原始函数。注意：保留任何同时被其它非 task 代码引用的 helper（grep 确认）。

- [ ] **Step 5: 加 script 引入**

`src/renderer/index.html` 找到 `<script src="./group.js"></script>` 那行，在它前面加：
```html
<script src="./tasks-panel.js"></script>
```
（顺序：先 tasks-panel，再 group，最后 app.js —— 让所有 `window.aimashi*` 在 `app.js` init 之前就绪）

- [ ] **Step 6: 静态校验**

运行：
```bash
node src/check.js
```
Expected: PASS（无报错）。若 `check.js` 内有显式登记的文件清单，把 `src/renderer/tasks-panel.js` 加进去。

- [ ] **Step 7: 后端测试**

```bash
npm test
```
Expected: 全部通过，用例数与拆前一致（grep `# tests ` 行数核对）。

- [ ] **Step 8: 手测**

```bash
npm run open
```
逐项确认（拆前的行为为对照）：
- [ ] 点左侧 rail 的"任务"图标，打开 Tasks 面板
- [ ] 已有任务能在 sidebar 列出，未读 badge 正确
- [ ] 点击任务进入详情，详情面板正常
- [ ] 任务历史 run 能展开
- [ ] 触发一次任务 fire（如有可触发的任务），实时事件能到达
- [ ] 空状态 onboarding 文字正常显示
- [ ] 切回聊天 / Fellow 等其它视图，再切回 Tasks，状态保持

- [ ] **Step 9: Commit**

```bash
git add src/renderer/tasks-panel.js src/renderer/app.js src/renderer/index.html src/check.js
git commit -m "$(cat <<'EOF'
refactor(renderer): extract tasks panel into tasks-panel.js module

Move ~450 lines of task sidebar / detail / runs rendering and daemon
event subscription out of app.js into a self-contained module behind
window.aimashiTasksPanel, mirroring the group.js extraction pattern.

Zero behavior change; verified via npm test and manual smoke of the
tasks panel against pre-refactor app.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: 抽取 Pet 生成对话框

**Files:**
- Create: `src/renderer/pet-dialog.js`
- Modify: `src/renderer/app.js`（移除约 100-150 行：4955-5046 + 相关）
- Modify: `src/renderer/index.html`

- [ ] **Step 1: 定位行号**

```bash
grep -n "openPetGenerateDialog\|closePetGenerateDialog\|renderPetGenerateDialog\|readPetReferenceFile\|refreshPetJobs\|renderPetJobs\|placeFellowPet\|recallFellowPet" src/renderer/app.js
```

- [ ] **Step 2: 创建模块**

`src/renderer/pet-dialog.js`，IIFE，导出 `window.aimashiPetDialog = { initPetDialog, open, close, renderJobs, refreshJobs, placePet, recallPet }`。

- [ ] **Step 3: 装配 + 改调用点**

`app.js initializeRuntime()` 加 `window.aimashiPetDialog.initPetDialog({ state, els, aimashi })`。
将原本调 `openPetGenerateDialog()` / `placeFellowPet()` 等的位置改为 `window.aimashiPetDialog.open()` / `window.aimashiPetDialog.placePet()`。

- [ ] **Step 4: 从 app.js 删除**

- [ ] **Step 5: 加 script 引入**

`<script src="./pet-dialog.js"></script>` 在 `app.js` 之前。

- [ ] **Step 6: 校验 + 测试**

```bash
node src/check.js && npm test
```

- [ ] **Step 7: 手测**

```bash
npm run open
```
- [ ] 打开任意 Fellow 详情，点"生成头像"，对话框正常弹出
- [ ] 选择参考图、填提示词、提交生成 job
- [ ] Job 列表正确显示进度
- [ ] 关闭对话框正常
- [ ] Pet 远程窗口的 place / recall 操作（如 fellow 有 pet 已生成）

- [ ] **Step 8: Commit**

```bash
git add src/renderer/pet-dialog.js src/renderer/app.js src/renderer/index.html
git commit -m "refactor(renderer): extract pet generate dialog into pet-dialog.js

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: 抽取 Skills 库面板

**Files:**
- Create: `src/renderer/skill-library.js`
- Modify: `src/renderer/app.js`（移除约 450 行：3060-3527）
- Modify: `src/renderer/index.html`

- [ ] **Step 1: 定位行号**

```bash
grep -n "loadSkills\|renderSkillLibrary\|renderSkillPreview\|renderExtensionDetail\|selectSkill\|renderConnectorCard\|renderPluginCard" src/renderer/app.js
```

- [ ] **Step 2: 创建模块**

`src/renderer/skill-library.js`，IIFE，导出 `window.aimashiSkillLibrary = { initSkillLibrary, loadSkills, renderSkillLibrary, renderSkillPreview, ... }`。

- [ ] **Step 3: 装配 + 调用点改写**

- [ ] **Step 4: 删 app.js 内代码**

- [ ] **Step 5: 加 `<script src="./skill-library.js"></script>`**

- [ ] **Step 6: `node src/check.js && npm test`**

- [ ] **Step 7: 手测**

- [ ] 左 rail 进 Skills 视图
- [ ] 列表加载、搜索框、过滤标签都正常
- [ ] 点 skill 进入预览，详情正确
- [ ] 安装 plugin（如有可装的）按钮、外部目录打开按钮都正常
- [ ] 返回其它视图后回到 Skills，状态正确

- [ ] **Step 8: Commit**

```bash
git commit -am "refactor(renderer): extract skill library into skill-library.js

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A4: 抽取消息 Context Menu

**Files:**
- Create: `src/renderer/message-menu.js`
- Modify: `src/renderer/app.js`（移除约 300 行：4632-4835 + 4141-4623 中的菜单部分）

- [ ] **Step 1: 定位行号**

```bash
grep -n "openMessageContextMenu\|closeMessageContextMenu\|renderMessageContextMenu\|replyToMessage\|highlightMessageSelection\|hasActiveMessageTextSelection\|clearMessageSelectionHighlight" src/renderer/app.js
```

- [ ] **Step 2-5: 同前**

`src/renderer/message-menu.js` 导出 `window.aimashiMessageMenu = { initMessageMenu, open, close, render, replyTo, highlightSelection, clearSelection }`。

- [ ] **Step 6: 校验 + 测试**

- [ ] **Step 7: 手测**

- [ ] 聊天里右键任意消息，菜单弹出
- [ ] 复制 / 引用 / 删除（如有）等操作正确
- [ ] 选中消息文字后右键，"引用"等选项可用
- [ ] 点 reply，composer 顶部出现引用 chip
- [ ] 切走视图再回来，菜单不残留

- [ ] **Step 8: Commit**

---

## Phase A 完成检查点

Phase A 4 个 task 全部 commit 后：

- [ ] 跑 `wc -l src/renderer/app.js` —— 应该减少约 1300-1500 行（剩余约 6500 行）
- [ ] 跑 `wc -l src/renderer/*.js` —— 应出现 4 个新文件
- [ ] 跑 `git log --oneline | head -8` —— 看到 4 个 refactor commit
- [ ] 完整手测一遍 app 主要功能：聊天能发消息、Fellow 能切换、Settings 能开、Skills 能浏览、Tasks 能开、群聊能开

**Phase A 完成后停下来向用户汇报**，等确认再进 Phase B。

---

## Phase B: 渲染端中等耦合特性

### Task B1: 抽取 Settings - 外观 tab

**Files:**
- Create: `src/renderer/settings-appearance.js`
- Modify: `src/renderer/app.js`（移除约 150 行）

- [ ] **Step 1: 定位**

```bash
grep -n "syncAppearanceControls\|applyAppearance\|persistAppearanceDraft\|scheduleAppearanceSave\|currentAppearanceDraft\|mergeRuntimeAppearance\|appearanceTheme\|appearanceForm" src/renderer/app.js
```

- [ ] **Step 2-5: 创建模块、装配、删除、引入**

`src/renderer/settings-appearance.js` 导出 `window.aimashiSettingsAppearance = { initAppearance, applyAppearance, syncControls, persistDraft, scheduleSave }`。

`app.js` 中 settings tab 切换时调 `window.aimashiSettingsAppearance.syncControls()`。

- [ ] **Step 6: 校验**

- [ ] **Step 7: 手测**

- [ ] 打开设置 → 外观 tab
- [ ] 切换浅色/深色，立即生效
- [ ] 字体切换正常
- [ ] 主色 / 用户气泡颜色调整正常
- [ ] 关闭设置后重启 app，配置持久化

- [ ] **Step 8: Commit**

---

### Task B2: 抽取 Settings - 模型 tab

**Files:**
- Create: `src/renderer/settings-model.js`
- Modify: `src/renderer/app.js`（移除约 500 行）

- [ ] **Step 1: 定位**

```bash
grep -n "renderModelSelectors\|applyModelEntryToFields\|fillModelFieldsFromPreset\|updateModelFieldVisibility\|renderConnectedProviders\|modelAuthCopy\|setProviderOptions\|syncQuickModelLabel" src/renderer/app.js
```

- [ ] **Step 2-5: 同前**

注意：模型 tab 涉及 provider OAuth 触发，IPC 调用通过 `deps.aimashi.startProviderOAuth()` 等，不要直接引用 `window.aimashi`。

- [ ] **Step 6: 校验**

- [ ] **Step 7: 手测**

- [ ] 设置 → 模型 tab
- [ ] 切换 provider 下拉，model 列表正确更新
- [ ] 已连接的 provider 显示"已连接"
- [ ] 未连接的 provider 点登录按钮，OAuth 流程能跳出
- [ ] 顶部快速模型切换器也跟着同步
- [ ] Hermes 运行时状态显示正确（已装 / 未装 / 启动中）
- [ ] 安装 / 启动 / 停止 / 卸载 Hermes 按钮（只点不操作，确认按钮状态正确）

- [ ] **Step 8: Commit**

---

### Task B3: 抽取 Settings - 跨设备连接 tab

**Files:**
- Create: `src/renderer/settings-remote.js`
- Modify: `src/renderer/app.js`（移除约 200 行）

- [ ] **Step 1: 定位**

```bash
grep -n "renderMobilePairing\|renderRelayPairing\|renderCloudAccount\|refreshDaemonPairing\|refreshRelayPairing\|cloudLogin\|cloudLogout\|mobileRelayQr\|mobileRelayBox" src/renderer/app.js
```

- [ ] **Step 2-5: 同前**

警告：这个 tab 和 cloud bridge / daemon 状态耦合最深，仔细确认所有 IPC 调用通过 deps 注入。

- [ ] **Step 6: 校验**

- [ ] **Step 7: 手测**

- [ ] 设置 → 跨设备连接 tab
- [ ] Cloud 登录表单显示 / 输入 / 登录按钮工作
- [ ] 登录后能看到账号信息和登出按钮
- [ ] 局域网 QR 码 / 链接显示
- [ ] Relay 配置显示，启用 / 停用按钮
- [ ] Daemon 启用状态切换

- [ ] **Step 8: Commit**

---

### Task B4: 抽取 Session 管理

**Files:**
- Create: `src/renderer/session-manager.js`
- Modify: `src/renderer/app.js`（移除约 200-250 行）

- [ ] **Step 1: 定位**

```bash
grep -n "loadChatSessions\|activeSession\|sessionsForPersona\|persistSession\|persistSessionQuietly\|replacePersistedSessionQuietly\|createNewSessionForActive\|markPersonaRead\|latestAssistantMessageTime\|unreadCountForPersona\|totalUnreadCount" src/renderer/app.js
```

- [ ] **Step 2-5: 同前**

注意：`activeSession()` 和 `sessionsForPersona()` 被聊天主流程频繁调用，导出形式必须稳定。建议保留 `app.js` 顶部一行 `const { activeSession, sessionsForPersona } = window.aimashiSessionManager` 简化下游引用。

- [ ] **Step 6: 校验**

- [ ] **Step 7: 手测**

- [ ] 切换不同 Fellow / 群组，session 列表正确
- [ ] 新建 session 按钮工作
- [ ] 重命名 session（如有 UI）正常
- [ ] 切换 session 后消息正确显示
- [ ] 关闭重启后 session 历史持久化
- [ ] 未读 badge 正确

- [ ] **Step 8: Commit**

---

### Task B5: 抽取 Fellow 管理

**Files:**
- Create: `src/renderer/fellow-manager.js`
- Modify: `src/renderer/app.js`（移除约 600-700 行）

- [ ] **Step 1: 定位**

```bash
grep -n "renderContacts\|renderContactDetail\|openFellowDialog\|closeFellowDialog\|setFellowAvatarDraft\|openAvatarCropEditor\|renderAvatarCropEditor\|renderFellowCapabilitiesPanel\|wireFellowCapabilities" src/renderer/app.js
```

- [ ] **Step 2: 创建模块**

这是 Phase B 最大的一刀，单独审慎处理。Fellow 头像裁剪 editor 是独立的子功能，可以考虑再拆 `src/renderer/fellow-avatar-editor.js` 出去——**但这次先合在一起**，避免一次改动太大。

- [ ] **Step 3-5: 装配、删除、引入**

- [ ] **Step 6: 校验**

- [ ] **Step 7: 手测**（这一刀最重要的手测）

- [ ] Contacts 视图列出所有 Fellow，分组、置顶正常
- [ ] 点 Fellow 进入详情面板，引擎 / 能力 / pet 状态都正确
- [ ] 新建 Fellow 对话框打开 / 填表 / 保存
- [ ] 编辑 Fellow（人设 seed、名字、引擎配置）保存生效
- [ ] 上传头像、裁剪、保存生效
- [ ] 选择预设头像
- [ ] 删除 Fellow（要确认 UI 还在）
- [ ] 置顶 / 取消置顶
- [ ] 切回聊天，Fellow 信息正确显示

- [ ] **Step 8: Commit**

---

## Phase B 完成检查点

- [ ] `wc -l src/renderer/app.js` —— 应再减约 1600-1900 行（累计剩约 4600-4900 行）
- [ ] `wc -l src/renderer/*.js` —— 至少 9 个独立文件
- [ ] 全面手测：聊天、Fellow、Skills、Tasks、Settings 三 tab、群聊、Pet

**Phase B 完成后停下来向用户汇报。**

---

## Phase C: 渲染端常量、Helpers、事件监听拆分

### Task C1: 抽取常量

**Files:**
- Create: `src/renderer/constants/ui.js` / `providers.js` / `avatar.js` / `codes.js`
- Modify: `src/renderer/app.js`（移除约 300 行常量定义，换成 `<script>` 注入的全局 `AIMASHI_CONSTANTS_*` 或直接通过 `window.AimashiConstants`）

- [ ] **Step 1: 定位常量块**

按 Explore 报告：
- `fallbackSlashCommands` / `SIDEBAR_WIDTH_*`（行 1-43）
- `providerPresets` / `providerLabels` / `EFFORT_LABELS` / `APPROVAL_LABELS`（行 615-677, 2248-2263）
- `fontPresets` / 默认 accent color（行 1187-1230）
- `avatarPresetGroups` / `DEFAULT_AVATAR_CROP`（行 1394-1461）
- `ICON_PARK` / code highlight patterns（行 1573-1645）

- [ ] **Step 2: 创建 4 个 constants 文件**

每个文件用 IIFE：
```javascript
(function () {
  window.AimashiConstantsUI = {
    SIDEBAR_WIDTH_MIN: 240,
    SIDEBAR_WIDTH_MAX: 420,
    // ...
  };
})();
```

- [ ] **Step 3: 引入到 HTML**

```html
<script src="./constants/ui.js"></script>
<script src="./constants/providers.js"></script>
<script src="./constants/avatar.js"></script>
<script src="./constants/codes.js"></script>
```
放在所有 feature module 和 `app.js` 之前。

- [ ] **Step 4: 在 app.js + 已拆模块中改引用**

例如原本 `SIDEBAR_WIDTH_MIN` → `window.AimashiConstantsUI.SIDEBAR_WIDTH_MIN`。
全文 search-replace 风险高，建议每个常量逐个替换，或在 app.js 顶部加 `const { SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } = window.AimashiConstantsUI` 简化。

- [ ] **Step 5: 校验**

- [ ] **Step 6: 手测**

完整跑一遍所有 UI，确认任何视觉 / 行为差异都没有。常量错引用最容易出 silent 失败。

- [ ] **Step 7: Commit**

---

### Task C2: 抽取 Helpers - 格式化

**Files:**
- Create: `src/renderer/helpers/format.js`
- Modify: `src/renderer/app.js`

- [ ] **Step 1: 列出迁移函数**

`formatBytes`, `formatConversationTime`, `formatMessageTime`, `renderMessageTime`, `copyTextToClipboard`, `escapeHtml`, `renderMarkdown`, `flashCopiedCode`。

- [ ] **Step 2: 模块导出**

```javascript
(function () {
  window.AimashiFormat = { formatBytes, formatConversationTime, ... };
})();
```

- [ ] **Step 3-5: 引入 + 改引用 + 删除**

- [ ] **Step 6: 校验 + 手测（消息时间显示 / 复制按钮 / markdown 渲染 / 字节数显示）**

- [ ] **Step 7: Commit**

---

### Task C3: 抽取 Helpers - 模型 / Provider

**Files:**
- Create: `src/renderer/helpers/model.js`
- Modify: `src/renderer/app.js`

迁移：`modelKey`, `catalogEntries`, `providerEntries`, `modelsForProvider`, `selectedModelEntry`, `providerIsConnected`, `defaultModelForProvider`, `modelDisplayName`, `effortLabelForLevel`, `externalPermissionOptions`, `effortOptions`, `permissionLabelForMode`。

同前流程。手测重点：模型切换 / provider 显示。

---

### Task C4: 抽取 Helpers - 头像

**Files:**
- Create: `src/renderer/helpers/avatar.js`

迁移：`canonicalAvatarSrc`, `avatarPresetBySrc`, `avatarThumbForSrc`, `avatarDefaultCropForSrc`, `isNeutralAvatarCrop`, `avatarCropForImage`, `cropsClose`, `avatarImageSrc`, `normalizeCrop`, `avatarBackgroundStyle`, `applyFellowAvatar`, `applyUserAvatar`, `applyAvatar`, `initials`。

手测重点：所有头像显示正确（Fellow 列表 / 聊天消息头像 / 设置头像 / Pet 头像）。

---

### Task C5: 抽取 Helpers - UI 原语

**Files:**
- Create: `src/renderer/helpers/ui.js`

迁移：`clampSidebarWidth`, `savedSidebarWidth`, `setText`, `renderQr`, `attachmentKind`, `attachmentGlyph`, `renderAttachmentChips`, `renderAttachmentThumb`, `maybeShowScrollbarForPointer`。

手测：sidebar 拖拽宽度、QR 码显示、附件 chip、滚动条触发。

---

### Task C6: 抽取事件监听 - Settings 域

**Files:**
- Create: `src/renderer/listeners/settings.js`
- Modify: `src/renderer/app.js`（移除 settings 相关 addEventListener 块）

- [ ] **Step 1: 定位**

```bash
grep -n "openSettings.addEventListener\|closeSettings.addEventListener\|settingsView.addEventListener\|settings-tab" src/renderer/app.js
```

- [ ] **Step 2: 模块**

```javascript
(function () {
  function attach({ state, els, render }) {
    els.openSettings?.addEventListener("click", () => { state.settingsOpen = true; render(); });
    els.closeSettings?.addEventListener("click", () => { state.settingsOpen = false; render(); });
    // ...
  }
  window.aimashiListenersSettings = { attach };
})();
```

- [ ] **Step 3-5: 装配 + 删除 + 引入**

`app.js` 在 DOM ready 后调 `window.aimashiListenersSettings.attach({ state, els, render })`。

- [ ] **Step 6-7: 校验 + 手测开 / 关 / tab 切换**

- [ ] **Step 8: Commit**

---

### Task C7: 抽取事件监听 - Chat / Composer 域

类似 C6，迁移 composer 相关 listener（chat form 提交、input 事件、attachments、slash menu、skill picker、composer add menu）。

手测：发消息、上传附件、slash 命令唤起、技能选择器。

---

### Task C8: 抽取事件监听 - Fellow / Skill / 其它

剩余的 listener 块按域归类，**避免**新建 `listeners-misc.js` 万能桶。最终每个 listener 文件 100-300 行内。

---

## Phase C 完成检查点

- [ ] `wc -l src/renderer/app.js` —— 应已经接近 800 行目标
- [ ] `wc -l src/renderer/*.js src/renderer/constants/*.js src/renderer/helpers/*.js src/renderer/listeners/*.js` —— 20+ 个文件
- [ ] **如果 app.js 仍 > 800 行**，停下来汇报：可能需要再拆 render() / renderView() 或追加 listener 拆分。

**Phase C 完成后停下来向用户汇报。**

---

## Phase D: 主进程特性模块拆分

### Task D1: 抽取 Pet 生成（主进程侧）

**Files:**
- Create: `src/main/pet-generator.js`
- Modify: `src/main.js`（移除约 300 行：2022-2215, 2244-2315）

- [ ] **Step 1: 定位**

```bash
grep -n "startFellowPetGeneration\|placeFellowPet\|recallFellowPet\|notifyFellowPetMessage\|resizePetWindow\|styleSettingsForPet\|petRemoteCodexSettings\|getPetJobs\|petWindows\|petMessageTimers\|petJobs" src/main.js
```

- [ ] **Step 2: 模块**

```javascript
// src/main/pet-generator.js
const { spawn } = require('child_process');
// ...

function createPetGenerator({ runtimePaths, getMainWindow, ... }) {
  const state = { petWindows: new Map(), petMessageTimers: new Map(), petJobs: new Map() };

  function startFellowPetGeneration(fellow, options) { /* ... */ }
  function placeFellowPet(fellow) { /* ... */ }
  // ...

  return {
    startFellowPetGeneration,
    placeFellowPet,
    recallFellowPet,
    notifyFellowPetMessage,
    getJobs: () => Array.from(state.petJobs.values()),
  };
}

module.exports = { createPetGenerator };
```

- [ ] **Step 3: 装配**

`main.js` 顶部加 require，初始化时：
```javascript
const { createPetGenerator } = require('./main/pet-generator.js');
const petGenerator = createPetGenerator({ runtimePaths, getMainWindow: () => mainWindow, ... });
```
原来直接调用 `placeFellowPet(...)` 的地方改为 `petGenerator.placeFellowPet(...)`。

- [ ] **Step 4-6: 删除 + 校验 + 测试**

```bash
node src/check.js && npm test
```

- [ ] **Step 7: 手测**

- [ ] 触发一次 pet 生成，job 启动 / 完成
- [ ] Pet 窗口能 place / recall
- [ ] Pet 收到消息时的通知动画

- [ ] **Step 8: Commit**

---

### Task D2: 抽取 Relay 客户端

**Files:**
- Create: `src/main/relay-client.js`
- Modify: `src/main.js`（移除约 350 行：5886-6167）

迁移：`startRelayClient`, `stopRelayClient`, `scheduleRelayReconnect`, `handleRelayMessage`, `appendRelayLog`, `relayState`, `relayClient`。

同前流程。手测：在 settings 中触发 relay 启用 / 停用，配对页面有内容。

---

### Task D3: 抽取 Skills Loader

**Files:**
- Create: `src/main/skills-loader.js`
- Modify: `src/main.js`（移除约 200 行：3587-3805）

迁移：`loadLocalSkills`, `readLocalSkill`, `deleteLocalSkill`, `openLocalSkillDirectory`, `installMarketplacePlugin`, `fetchHermesSkillsCatalog`。

手测：Skills 视图加载 / 预览 / 安装插件。

---

### Task D4: 抽取 Commands Loader

**Files:**
- Create: `src/main/commands-loader.js`
- Modify: `src/main.js`（移除约 350 行：3334-3586, 3113-3174）

迁移：`loadHermesSlashCommands`, `loadHermesSlashCommandsInner`, `loadEngineCapabilities`, `loadExternalAgentCommands`, `executeExternalAgentCommand`。

手测：composer 内 `/` 唤起 slash menu，Hermes 命令列表正确；Claude Code / Codex 外部命令可执行。

---

### Task D5: 抽取 OAuth 流程

**Files:**
- Create: `src/main/oauth-flow.js`
- Modify: `src/main.js`（移除约 400 行：authState 块 + 6402-6498 + 相关）

迁移：`startCodexOAuth`, `cancelCodexOAuth`, `startProviderOAuth`, `cancelProviderOAuth`, `requestCodexDeviceCode`, `pollCodexAuthorization`, `exchangeCodexTokens`, `finishCodexOAuth`, `authState`, `authProcess`。

手测：Settings → 模型 → 任意未登录 provider 触发 OAuth；Codex 设备码流（如方便）。

---

### Task D6: 抽取 Chat Store

**Files:**
- Create: `src/main/chat-store.js`
- Modify: `src/main.js`（移除约 400 行：1352-1623）

迁移：`defaultChatStore`, `loadChatStore`, `saveChatStore`, `createChatSession`, `normalizeChatStore`, `generateSessionTitle`, `persistSession` 等。

注意：这是聊天数据的真源，迁移时要确保 cloud-bridge 的 `mergeCloudWorkspaceIntoChatStore` 等仍能正确读写——必须导出兼容接口。

手测：发消息、关闭重启、消息保留；新建 session；切换 session。**这是高风险刀，单独 commit 后跑 `npm test` 一定要看 cloud-sqlite-store / serve-cloud-bridge 等测试全过。**

---

### Task D7: 抽取 Fellow Manager

**Files:**
- Create: `src/main/fellow-manager.js`
- Modify: `src/main.js`（移除约 650 行：1201-1741, 1538-1650, 7486-7625）

迁移：`loadFellowManifest`, `saveFellowManifest`, `normalizeFellow`, `saveFellow`, `getFellowDetails`, `readFellowPersona`, `deleteFellow`, `setFellowPinned`, `saveFellowEngineConfig`, 以及 pet 状态查询函数（`petStatusForFellow`, `findFellowPetPackage`）。

手测：Fellow CRUD 完整跑一遍。

---

### Task D8: 抽取 Daemon Server

**Files:**
- Create: `src/main/daemon-server.js`
- Modify: `src/main.js`（移除约 800 行：5128-5541, 4735-4925）

迁移：`startControlServer`, `stopControlServer`, `getDaemonStatus`, `getDaemonPairingInfo`, `appendDaemonLog`, `writeDaemonLaunchAgentPlist`, `startDaemonLaunchAgent`, `stopDaemonLaunchAgent`, `controlServerState`。

**这是主进程最大一刀**。Daemon 包含 HTTP server + IPC 代理 + token 验证 + 路由分发。迁移时严格保留原有路由签名。

手测：
- 启动 daemon、关闭 daemon
- 通过 daemon 收发消息（Web 端或 mobile 端连接）
- Tasks scheduler 触发任务时 daemon 路径通畅

**如果手测发现任何 cloud / web / mobile / task 走不通，立刻回滚。**

---

### Task D9: 抽取 Cloud Bridge

**Files:**
- Create: `src/main/cloud-bridge.js`
- Modify: `src/main.js`（移除约 700 行：5543-5954）

迁移：`cloudApi`, `loginAimashiCloud`, `logoutAimashiCloud`, `syncAimashiCloudWorkspace`, `pushDesktopMessageToCloud`, `startCloudBridge`, `stopCloudBridge`, `startCloudEvents`, `stopCloudEvents`, `mergeCloudWorkspaceIntoChatStore`, `cloudBridgeState`, `cloudBridgeClient`。

注意：与 `src/cloud/desktop-sync.js` / `src/cloud/sqlite-store.js` 协作，不要重复职责。Cloud settings 留在 settings 模块。

手测：登录 cloud、收发跨端消息（Web 或 desktop）、文件预览、登出。

---

### Task D10: 抽取 Engine Lifecycle

**Files:**
- Create: `src/main/engine-lifecycle.js`
- Modify: `src/main.js`（移除约 900 行：273-332, 821-927, 4025-4730, 6168-6324）

**这是主进程最复杂的一刀**——Hermes 引擎装 / 起 / 停 / 健康检查 / 插件注入。

迁移：`isEngineInstalled`, `officialEngineUrl`, `officialEngineRequirement`, `selectOfficialEnginePython`, `pythonVersion`, `refreshSystemHermesAsync`, `startEngine`, `stopEngine`, `isEngineHealthy`, `waitForHealth`, `adoptRunningEngine`, `installEngine`, `uninstallStandaloneEngine`, `restartEngineIfRunning`, `ensureEnginePlugins`, `engineState`, `engineProcess`。

**风险最高**：engine 启动顺序影响 daemon / cloud / chat 全部链路。建议在 worktree 里先试一次，确认 startup sequence 不变。

手测：
- 冷启动 app（无 hermes 已装），引擎自动检测 / 安装提示流程
- 已装 hermes，启动 app，chat 能立刻发消息
- 卸载 Hermes 私有副本、重装
- 停止 / 重启引擎按钮工作

**任何一项不通，回滚并停下汇报。**

---

### Task D11: 抽取 Settings 持久化（主进程）

**Files:**
- Create: `src/main/settings-store.js`
- Modify: `src/main.js`（移除约 550 行：177-187, 343-547, 549-615, 679-778）

迁移：所有 `defaultXxxSettings`、`writeXxxSettings`、`xxxSettings` 读写函数（model / appearance / permission / effort / daemon / relay / cloud）。

手测：Settings 三 tab 所有项保存生效、重启持久化。

---

### Task D12: 抽取路径 / 资源工具

**Files:**
- Create: `src/main/runtime-paths.js`
- Modify: `src/main.js`（移除约 220 行：155-278, 1980-2006）

迁移：`runtimePaths`, `venvPythonPath`, `bundledHermesRuntimeDir`, `bundledPython`, `bundledSitePackages`, `buildPythonPath`, `petGeneratorRoot`, `aimashiSkillsRoot`, `officialLibraryManifestPath`，外加 `writeFileIfMissing` / `readJson` 这两个底层工具。

注意：这是底层依赖，几乎所有模块都用它，最好**最早或最晚拆**。本计划放在 D 最后，是因为前面已经把消费方拆出去了，这时调整 import 路径较清晰。

手测：app 能正常启动；所有需要文件系统访问的路径都正确。

---

## Phase D 完成检查点

- [ ] `wc -l src/main.js` —— 应已减少 5000+ 行，剩约 2000-2500 行
- [ ] `wc -l src/main/*.js` —— 至少 15+ 文件
- [ ] `npm test` 全过，无后端测试退化
- [ ] 完整手测：聊天、Fellow、Skills、Tasks、Settings、Cloud 登录、Daemon 启停、Pet 生成、Relay 启停、OAuth、Hermes 装卸

**Phase D 完成后停下来向用户汇报。**

---

## Phase E: 主进程 IPC Handlers 按域拆分

`main.js` 行 7247-7678（约 430 行）是 `ipcMain.handle()` 大集合，拆分到 8 个域模块。

### Task E1: 创建 IPC handler 装配机制

**Files:**
- Create: `src/main/ipc/register.js`
- Modify: `src/main.js`

- [ ] **Step 1: 模块**

```javascript
// src/main/ipc/register.js
const { ipcMain } = require('electron');

function registerIpcHandlers(modules, context) {
  for (const mod of modules) {
    const handlers = typeof mod === 'function' ? mod(context) : mod;
    for (const [channel, fn] of Object.entries(handlers)) {
      ipcMain.handle(channel, fn);
    }
  }
}

module.exports = { registerIpcHandlers };
```

- [ ] **Step 2: 在 main.js 装配点调用**

```javascript
const { registerIpcHandlers } = require('./main/ipc/register.js');
const ipcModules = [
  require('./main/ipc/window.js'),
  require('./main/ipc/chat.js'),
  // 后续 task 填入
];
registerIpcHandlers(ipcModules, { /* 注入上下文 */ });
```

先建空骨架，后面 task 逐个填充。

- [ ] **Step 3: Commit 装配机制（暂不迁 handler）**

---

### Task E2-E9: 按域拆 handler

为每个域建一个文件，从 `main.js` 迁出对应的 `ipcMain.handle(...)` 调用，转成模块导出的 `{ channelName: handlerFn }`。

每个 task 走一遍：定位 → 迁移 → 改装配 → 删原代码 → 校验 → 手测对应功能 → commit。

域划分（每个 task 一个文件）：

- **E2**: `src/main/ipc/window.js` —— window control / open external link / minimize / close
- **E3**: `src/main/ipc/chat.js` —— sendChat / stopChat / loadSessions / saveSession / read state / generate title
- **E4**: `src/main/ipc/settings.js` —— model / appearance / permission / effort / daemon / relay / cloud save
- **E5**: `src/main/ipc/fellow.js` —— fellow CRUD / pet / group
- **E6**: `src/main/ipc/engine.js` —— engine install / start / stop / capabilities
- **E7**: `src/main/ipc/auth.js` —— Codex / provider OAuth
- **E8**: `src/main/ipc/cloud.js` —— cloud login / logout / sync / push
- **E9**: `src/main/ipc/skills-commands.js` —— skills CRUD + slash commands + agent commands

每个 task 单独 commit。

---

## Phase E 完成检查点

- [ ] `wc -l src/main.js` —— 接近 500 行目标
- [ ] `src/main/ipc/` 下 9 个文件
- [ ] `npm test` 全过
- [ ] 全功能手测无回归

**Phase E 完成后停下来向用户汇报。**

---

## Phase F: 最终验收

### Task F1: 行数验证

- [ ] `wc -l src/main.js` —— **应 < 500**
- [ ] `wc -l src/renderer/app.js` —— **应 < 800**
- [ ] `wc -l src/main/*.js src/renderer/*.js src/renderer/**/*.js`：所有新文件应 < 800 行（少数复杂特性允许 800-1000）

如未达标，分析哪些文件还可以再拆，追加 task。

### Task F2: 全测试与全手测

- [ ] `node src/check.js` 通过
- [ ] `npm test` 通过且**用例数不少于重构前**
- [ ] `npm run open` 完整手测每个功能区：
  - [ ] 聊天主流程（文本 / 流式 / 附件 / slash / stop）
  - [ ] 会话 CRUD（新建 / 切换 / 持久化 / 未读）
  - [ ] Fellow CRUD（新建 / 编辑 / 头像 / 删除 / 置顶 / engine 配置）
  - [ ] 群聊（创建 / 编辑 / 群内消息）
  - [ ] Skills 库（浏览 / 预览 / 安装 / 删除）
  - [ ] Tasks 面板（列表 / 详情 / 历史 / 实时事件）
  - [ ] Pet 生成 + Pet 窗口 place/recall
  - [ ] Settings：外观 / 模型（含 OAuth）/ 跨设备（Cloud + Relay + Daemon）
  - [ ] Hermes 装 / 启 / 停 / 卸载
  - [ ] Cloud 登录 / 同步 / 跨端消息 / 登出

### Task F3: 文档同步

- [ ] 如果发现 CLAUDE.md 的"代码组织"节有任何遗漏（比如某个新引入的约定），补充。**不要改"硬规则"**，只在样板清单加新文件。

### Task F4: Push 前确认

按 memory `feedback_codex_review_before_push`：

- [ ] 跑一次 codex adversarial-review，确保无 no-ship issue
- [ ] 等用户明确说"push"再 push

---

## 整体进度速查表

| Phase | Task 数 | 累计预期 commit | 主要风险 |
|---|---|---|---|
| A | 4 | 4 | 低 |
| B | 5 | 9 | 中（Fellow / Session 较大）|
| C | 8 | 17 | 中（常量改引用易遗漏）|
| D | 12 | 29 | 高（Daemon / Engine / Chat Store 复杂）|
| E | 9 | 38 | 中（IPC channel 名误改会全 broken）|
| F | 4 | ~39 | 验收 |

每个 commit 之前**必跑** `node src/check.js && npm test`。

每个 Phase 完成 commit 后**停下来汇报**给用户，等"go"再进下一 Phase。

---

## 执行进度（2026-05-21 实施日志）

分支：`refactor/code-restructure`，从 main 切出，所有 commit 都在该分支。

### 已完成

| Task | Commit | app.js 行数 | 说明 |
|---|---|---|---|
| baseline | c387613 | 8055 | plan 文档 commit |
| A1 Tasks panel | f731a1b | 7604 | `src/renderer/tasks-panel.js` (494 行) |
| A2 Pet dialog | 8fbaf88 | 7511 | `src/renderer/pet-dialog.js` (147 行) |
| A4 Message menu | 375289c | 7317 | `src/renderer/message-menu.js` (283 行) |
| B1 Settings Appearance | b2d6fa3 | 7133 | `src/renderer/settings-appearance.js` (244 行) + init-order bug fix |
| (plan progress) | 239c377 | 7133 | 文档更新 |
| B4a Session read-state | 9f6afb2 | 7067 | `src/renderer/session-read-state.js` (110 行) |
| **pingfang fix** | 861f831 | 7067 | 关键 bug 修复：inits 必须在 loadChatSessions 之前 |
| A3a Skill data helpers | dadcfe5 | 7011 | `src/renderer/skill-helpers.js` (77 行) |
| B3 Settings Cross-device | 44d9acd | 6852 | `src/renderer/settings-remote.js` (198 行) |
| A3b1 Skill markdown | 0c4aeb3 | 6765 | 扩展 skill-helpers.js (stripFrontmatter + 2 markdown renderers) |
| Scrollbar overlay | 4a10871 | 6613 | `src/renderer/scrollbar-overlay.js` (199 行) — 自包含 DOM 工具 |
| Format helpers | 8fe19de | 6584 | `src/renderer/format-helpers.js` (42 行) — formatBytes / attachment helpers |

**累计：app.js 从 8055 行降到 6584 行（-1471 / -18.3%）**。每个 commit 都跑过 `node src/check.js` + `npm test (241/241)` + electron 启动无 stderr 错误。

### 当前模块清单（9 个独立特性 + 1 个 helper bucket）

| 模块 | 行数 | 职责 |
|---|---|---|
| `src/renderer/group.js`（原有） | 974 | 群聊 |
| `src/renderer/tasks-panel.js` | 494 | 任务面板 |
| `src/renderer/pet-dialog.js` | 147 | 桌宠生成对话框 |
| `src/renderer/message-menu.js` | 283 | 消息右键菜单 |
| `src/renderer/settings-appearance.js` | 244 | 外观设置 tab |
| `src/renderer/settings-remote.js` | 198 | 跨设备连接 tab |
| `src/renderer/session-read-state.js` | 110 | 未读 badge / read state |
| `src/renderer/skill-helpers.js` | 187 | skill 数据 + markdown 渲染 |
| `src/renderer/scrollbar-overlay.js` | 199 | 自定义滚动条 |
| `src/renderer/format-helpers.js` | 42 | formatBytes / attachment kind/glyph |

### 关键发现 & 修复

**init-order bug 第一回**（在 B1 修复，bundle 进 b2d6fa3）：原本 `window.aimashi*.init*` 全部放在 `initializeRuntime()` 的第一次 `render()` 之后。这意味着首次 render 时模块的注入依赖还是 undefined，每次 `window.aimashi*.renderXxx()` 都在抛 TypeError。但渲染器异常不冒到 stderr，smoke 检测没抓到。第二次 render（用户交互触发）时 init 已完成，所以肉眼看不出。

修复：所有模块 init 移到 `render()` 之前。

**init-order bug 第二回 / "pingfang" 崩溃**（用户报告，在 861f831 修复）：B1 的"init 在 render() 之前"修复不够——`trackStartupTask` 在 await 任务前/后都会触发 `render()`。`initializeRuntime` 是 `await trackStartupTask("初始化 runtime", ...) → state.runtime = runtime → await trackStartupTask("加载会话", loadChatSessions) → [inits] → render()` 的序列。第二个 trackStartupTask 的内部 render() 触发时机：state.runtime 已设（不再 early-return）+ 模块还没 init → applyAppearance → fontPresets undefined → 抛 "Cannot read properties of undefined (reading 'pingfang')"。

修复：所有模块 init 移到 `state.runtime = runtime` 之后、`loadChatSessions trackStartupTask` 之前。

教训：
- 写新模块时，**对外暴露的 render 函数应该有 `if (!state || !els) return;` 防御**，避免靠 init 顺序保证安全。B4a+ 的新模块都加了这个 guard
- electron renderer 进程的 JS 异常不会冒到主进程 stderr，需要 DevTools 或 `--enable-logging=stderr` 才能看到。未来 smoke 应该主动开 logging

### Deferred Sub-Tasks

- **A3 Skills library → 推迟成 A3a/A3b**：原计划一次抽 30+ 函数 643 行，跨度太大且 `syncTopbarClickCapture` 是和非-skill 代码共用的。需要：
  - A3a：纯数据/render helper（skillTone, skillDisplayName, skillSummaryZh, visibleSkills, skillCategories, skillMatchesFilters, renderSkillInlineMarkdown, renderSkillMarkdownSource 等）
  - A3b：UI 渲染层（renderSkillLibrary, renderSkillPreview, renderConnectorCard, renderPluginCard, renderExtensionDetail + context menu）
  - **注意保留** `syncTopbarClickCapture` 在 app.js（跨域使用）
- **B4 Session manager → 推迟成 B4a/B4b**：sessionsForPersona / activeSession / persistSession 是聊天主流程高频依赖，碰这块要格外小心。建议：
  - B4a：只抽未读相关的轻量 helper（latestAssistantMessageTime, unreadCountForPersona, totalUnreadCount, markPersonaRead, persistReadStateQuietly, initializeReadStateForPersonas, ensureReadState）
  - B4b：sessionsForPersona + activeSession + persistSession 系列（要逐函数验证 chat 主流程不破）

### 下一步剩余清单（按风险递增排序）

**Phase B 剩余**：
- **B2 Settings - Model tab**（~500 行）—— 涉及 OAuth UI、provider 切换、Hermes 状态显示。需要 inject 较多 deps
- **B5 Fellow manager**（~700 行）—— Phase B 最大单刀；fellow CRUD + 头像裁剪 + 引擎配置面板
- **B4b Session manager core**（高风险）—— sessionsForPersona / activeSession / persistSession 是聊天主流程高频依赖

**Phase A 剩余**：
- **A3b2 Skills UI render**（~500 行）—— renderSkillLibrary, renderSkillPreview, context menu, filter/visible helpers。注意 `syncTopbarClickCapture` 是跨域共用的，必须保留在 app.js

**Phase C / D / E**（后续）：
- Sidebar 布局 helper（小，30 行，但有 script-load 时机问题需要解决）
- model/provider 查询函数族（modelKey, catalogEntries, providerEntries, modelsForProvider 等，~150 行）
- effort / permission options（涉及 state.engineCapabilities）
- 主进程：scheduler MCP / cloud bridge / engine lifecycle 等（参考原 plan Phase D）
- 事件监听按域拆（参考原 plan Phase C 后段）

**继续推进时建议**：每次只拆一个特性，commit 后用户先 smoke。fellow / session / chat 主流程的几大块强烈建议留到最后，因为出错代价高。当前 -18% 已经让产品代码组织显著改善——按用户最初诉求"代码精炼 + AI 改不冲突"，9 个独立模块已经覆盖了大部分非聊天主流程的特性，下一阶段收益递减且风险递增。

可以考虑：先 push 当前 refactor branch 享受收益（CLAUDE.md 已有"代码组织"规约约束未来 AI），剩下的等真有改动需求再针对性拆。
