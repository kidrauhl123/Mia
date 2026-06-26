# src/renderer 工作指南

这里是 Electron renderer。规则重点是：DOM 只在 renderer，系统能力只走 preload，入口文件持续变薄，用户看到的文案默认中文。

## 目录职责

- `src/renderer/app.js` 是装配和路由入口，不继续承载新业务的大段实现。
- `src/renderer/app-state.js` 放初始 UI 状态；新状态要有清晰 owner 和默认值。
- 复杂功能放 `src/renderer/<feature>/`，小功能可以是 `src/renderer/<feature>.js`。
- CSS 放 `src/renderer/styles/<feature>.css`，由 `index.html` 引入。
- 共享渲染工具要按领域命名，不要新增 `utils.js` / `helpers.js` 桶文件。

## 验证命令

```bash
node -c src/renderer/<changed-file>.js
node --test tests/renderer-*.test.js
node --test tests/renderer-styles.test.js
npm run check
```

涉及窗口真实交互时再用 `npm start`。不要用打包验证 renderer 普通改动。

## Feature 模块模式

新增 renderer feature 优先照这个形状：

```js
(() => {
  function initFeature({ state, els, render, api }) {
    // bind events and expose narrow methods
  }

  window.miaFeature = { initFeature };
})();
```

入口文件只负责传 `state`、`els`、`render`、`window.mia` 这类依赖。不要让 feature 模块自己重新查找全局状态 owner。

事件绑定优先在模块内完成。跨模块调用必须通过窄方法，例如 `window.miaSocial.refresh()`，不要直接改别的模块内部 map/set。

## Preload 边界

- Renderer 不直接 `require("electron")`、`fs`、`path`、`child_process`。
- 需要系统能力时先检查 `src/preload.js` 是否已有窄方法。
- 新方法名按用户动作命名，例如 `readSkill(id)`，不要暴露 `invoke(channel, args)`。
- 错误展示在 renderer，错误来源和诊断细节留在 main/cloud 日志。

## UI 和文案

- 用户可见文案默认中文。技术标识、模型名、文件名、CLI 名可以保留英文。
- 新按钮、tab、空状态、错误提示都要有明确中文，不要留下英文占位。
- 功能文案保持克制，只保留完成任务必要的标签、状态和错误；不要默认添加解释性副文案、教学句或注释式说明。
- 不要用套话摘要掩盖未知内容。没有可靠中文摘要时，宁可写具体来源/状态，或隐藏未精选内容。
- 不要默认把长原文、日志、源码、SKILL.md 正文铺在首屏；保留明确入口让用户展开。

## CSS 和布局

- 新界面样式优先进 `src/renderer/styles/<feature>.css`。
- 固定格式元素要有稳定尺寸：toolbar、icon button、grid cell、卡片动作区、计数器、modal header。
- UI 尺寸、颜色、spacing 落 CSS 或 design token，不在 JS 里散落 magic number。
- 文本必须在窄窗和宽屏都不溢出按钮/卡片；长词用省略或换行策略。
- 不要在页面大 section 外套漂浮卡片；卡片只用于重复 item、modal、工具面板。
- 不要把卡片套卡片。

## 状态和渲染

- 状态字段必须有默认值，删除字段时同步删所有 render/event/escape/backdrop 分支。
- 同一个弹窗/菜单只保留一个 open source of truth。
- 删除实体时要关闭或刷新对应详情弹窗，避免 dangling selection。
- 长列表搜索、筛选、加载态要区分“缓存可展示”和“前台刷新中”，不要把已缓存内容闪成空白。

## 测试

- UI 结构测试优先检查真实文件中的入口、selector、事件和状态字段。
- 样式测试检查关键 selector 和约束，不要只测类名存在。
- 改中文文案时，测试要覆盖关键 fallback，防止英文或套话回流到首屏。
