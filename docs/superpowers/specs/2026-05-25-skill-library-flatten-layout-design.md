# 技能库布局拍平（子项目 A）设计

日期：2026-05-25
状态：已批准，待出实现计划

## 背景

当前「能力库」视图是两栏结构：

- 中栏 `#skillsSidebar` —— 一个 `DIRECTORY` 侧栏，含搜索框 + `#skillNav`（`插件 / 技能 / 应用连接` 三个 section 切换）。
- 右栏 `#skillsView` —— topbar 标题 + `#skillChipRow`（分类 chip）+ `#skillCardGrid`（卡片列表）。

对一个本质上是扁平列表的东西，这个两栏结构过重：中栏永远只有三行，却吃掉整块宽度，右侧卡片被挤成窄条。

### 代码实情（决定了范围）

排查 `src/main/skills-loader.js` 后确认，三个 section 里**只有「技能」有真实数据**：

- `enumerateConnectors()`（:152）开头即 `const connectors = []`，永远返回空 → 截图中 `应用连接 0`。
- `enumerateExtensions()`（:180）为 `return [].map(...)`，永远返回空 → `插件 0`。安装入口 `installMarketplacePlugin()`（:334）是一句直接抛错的桩：`"Mia 插件安装源尚未接入"`。
- `enumeratePlugins()`（:191）读「Mia 官方库」manifest，但那是**技能的来源文件夹**（SKILL.md 的 root），最终喂给「技能」栏，不是可安装插件。

MCP 现状：mia 仅作为 **outbound MCP server** 把调度器 `schedule.*` 工具注入底层 Claude Code / Codex 引擎（`scheduler-mcp-server.js` + 两个 chat-adapter 的 `mcpServers` 配置）；**没有**消费用户自配 MCP 的客户端/host 能力，也无对应 UI。

结论：`插件` 与 `应用连接` 是结构存在、数据永远为空的占位。

## 目标

把「技能」视图从两栏改为**单列全屏卡片网格**，砍掉中栏 `DIRECTORY` 侧栏与永远为空的 `插件 / 应用连接` 入口，只保留技能。运行在**现有本地数据**上，不引入任何后端、不造安装量。

## 范围边界

本子项目（A）**只**做布局壳与本地技能网格。以下属于后续子项目 B（mia Cloud 注册表），A 不做：

- 排序（最热）、`我的技能` 切换、`添加`/安装按钮、`X万人添加` 安装量
- 办公学习 / 电脑设置 / 生活日常 / 休闲娱乐 等**云端固定分类**与 3D 分类图标
- 任何远程技能源、可安装插件、用户自配 MCP

A 的产物是一个干净的本地技能网格，结构上为 B 接入远程品类预留位置，但不提前实现 B 的任何外壳。

## 设计

### 视图结构

移除 skills 视图的中栏 `#skillsSidebar`（该 aside 为 skills 专用），工作区 `#skillsView` 变为单列：

```
┌─────────────────────────────────────────────────────────┐
│  技能                                   [⌕ 搜索能力      ] │   顶部:标题 + 搜索(从中栏挪上来)
│                                                           │
│  [全部] [uncategorized] [ ...数据里真实出现过的 category ] │   pill 行(数据驱动)
│                                                           │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐           │
│  │ ▣ 名称      │ │ ▣ 名称      │ │ ▣ 名称      │           │   全屏自适应多列卡片网格
│  │   来源       │ │   来源       │ │   来源       │           │
│  │   描述…      │ │   描述…      │ │   描述…      │           │
│  └────────────┘ └────────────┘ └────────────┘           │
└─────────────────────────────────────────────────────────┘
```

左侧 app 图标栏（`data-view="skills"` 能力库入口）保持不变。

### 分类 pill（数据驱动）

- `pill = 全部 + 本地技能里真实出现过的 category`，点击过滤。
- 复用现有 `skillCategories()` 计数逻辑与 `state.skillCategoryFilter`。
- 当前本地仅 1 个技能（`uncategorized`），pill 会偏少——这是真实状态，等 B 上云端分类后自然变丰富。不硬编码空分类（遵循 CLAUDE.md「不造假数据」）。

### 搜索

- 复用现有 `state.skillFilter` 过滤逻辑，仅把输入框从中栏 header 挪到 `#skillsView` 顶部。

### 卡片与交互

- 卡片字段：图标/首字母色块、名称、来源/作者标签、截断描述——全部来自现有本地数据。
- 点击卡片 → 沿用现有 `#skillPreviewDialog`（SKILL.md 预览弹窗），不重做。
- 右键 → 沿用现有上下文菜单（预览 / 打开目录 / 删除）。
- 响应式列数：窄窗 1 列，宽屏 3~4 列（`grid` + `auto-fill` + `minmax`）。

## 改动清单

- **`src/renderer/index.html`**
  - 删除 `#skillsSidebar` aside（含 `#skillNav`、原 `#skillSearch`）。
  - 在 `#skillsView` 顶部放置搜索输入（沿用 `#skillSearch` id 与既有事件绑定）。
- **`src/renderer/skills/skill-library.js`**
  - 删除 plugins / connectors / extensions 的渲染与导航分支：`renderPluginCard`、`renderConnectorCard`、`renderExtensionDetail`、`renderExtensionNavRow`、`renderSkillFilterRow`、`directorySectionRows`、`renderDirectorySectionRow`、`visibleConnectors`、`visibleExtensions`、`countBy`（若仅被上述使用）及对应事件绑定与 `state.directorySection` 分支。
  - `renderSkillLibrary()` 收敛为单一技能网格路径。
  - 删除随之产生的孤立 export。
- **`src/main/skills-loader.js`** —— **不动**。`enumerateExtensions/Connectors` 空桩留给 B；UI 不再消费其返回的 `extensions/connectors` 字段即可。
- **`src/renderer/styles/`**
  - `#skillCardGrid` 改为全屏自适应网格。
  - 清理 `.skills-sidebar` / `#skillNav` 相关样式与 skills 视图的两栏布局规则。
  - 顶部搜索与 pill 行样式对齐网格宽度。
- **`src/renderer/app.js`** —— 视图切换处对 `#skillsSidebar` 的 show/hide 引用需相应清理（避免引用已删除节点）。

## 状态字段处理

- 保留：`state.skillFilter`、`state.skillCategoryFilter`、`state.selectedSkillId`、`state.selectedSkillDetail`、`state.skillPreviewOpen`、`state.skillContextMenu`、`state.skillsLoading`、`state.skillLibrary.skills`。
- 不再使用（随分支删除一并清理对其的读写）：`state.directorySection`、`state.skillLibraryMode`、`state.selectedExtensionId`、`state.skillPluginFilter`、`state.skillStatusFilter`、`state.installingExtensions`。
- `state.skillLibrary.extensions/connectors` 字段仍由 loader 返回，但 UI 不再读取。

## 验证

- `npm test`、`npm run check` 通过。
- `npm start` 手动确认：技能视图为单列全屏网格；中栏消失；搜索/分类 pill/卡片点击预览/右键菜单均工作；窄窗与宽窗列数自适应；切到其它视图再切回无残留节点报错。

## 后续（子项目 B，另起 spec）

mia Cloud 技能注册表：远程目录、真实安装量、分类体系、`添加`/安装流程、`我的技能` 与商店的区分。B 落地时把远程品类填进 A 已建好的网格壳。
