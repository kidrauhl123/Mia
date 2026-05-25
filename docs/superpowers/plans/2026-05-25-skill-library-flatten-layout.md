# 技能库布局拍平（子项目 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「能力库」视图从两栏（中栏 DIRECTORY 侧栏 + 右栏内容）改为单列全屏技能卡片网格，砍掉永远为空的 `插件 / 应用连接`，只保留本地技能。

**Architecture:** 纯前端/渲染层改动。`skill-library.js` 的 `renderSkillLibrary()` 收敛为单一技能路径并产出带图标的卡片；`index.html` 删除 `#skillsSidebar`、把搜索框移进 `#skillsView` 顶部；`app.js` 清掉对已删节点的引用并在进入 skills 视图时让 `.app-shell` 折叠侧栏列；技能样式抽到新的 `styles/skills.css`，`styles.css` 净减少。主进程 `skills-loader.js` 不动。

**Tech Stack:** Vanilla JS（IIFE + `window.miaXxx`）、原生 CSS Grid、`node --test` 源码断言测试。

---

## File Structure

- `src/renderer/skills/skill-library.js` — 收敛为单一技能网格渲染；删除 plugins/connectors/extensions 渲染与导航。
- `src/renderer/index.html` — 删除 `#skillsSidebar`；搜索框进 `#skillsView` 顶部；新增 `styles/skills.css` 链接。
- `src/renderer/app.js` — 删除对 `skillsSidebar`/`skillNav` 的引用与 toggle；进入 skills 视图时给 `.app-shell` 打 `data-active-view`；保留 `#skillSearch` 事件。
- `src/renderer/styles/skills.css` —（新建）技能视图全部样式：全屏网格、卡片、图标、搜索、chip、折叠侧栏列。
- `src/renderer/styles.css` — 删除 `.skills-sidebar` / `.skills-nav` / `.skill-filter-row` / `.skill-section-label` / `.plugin-icon*` / `.extension-*` / `.skills-workspace` / `.skills-layout` / `.skill-chip-row*` / `.skill-card*` / `.skill-row-card*` / `.skill-dot*` 等技能专属规则（迁往 skills.css 或随功能删除）。
- `tests/skill-library-layout.test.js` —（新建）本计划的源码断言测试。

---

### Task 1: skill-library.js 收敛为单一技能网格

**Files:**
- Modify: `src/renderer/skills/skill-library.js`
- Test: `tests/skill-library-layout.test.js`

- [ ] **Step 1: 写失败测试**

新建 `tests/skill-library-layout.test.js`：

```javascript
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("skill-library renders a single skill grid with icon cards", () => {
  const src = read("src/renderer/skills/skill-library.js");
  // 卡片带图标 + 数据驱动分类，仍走 selectSkill 预览
  assert.match(src, /skill-card-icon/);
  assert.match(src, /data-skill-select=/);
  // 不再有 plugins/connectors/extensions 的渲染与目录导航
  assert.doesNotMatch(src, /renderPluginCard|renderConnectorCard|renderExtensionDetail|renderExtensionNavRow|renderDirectorySectionRow|directorySectionRows/);
  assert.doesNotMatch(src, /data-directory-section|data-extension-select|data-extension-install|data-skill-plugin/);
  assert.doesNotMatch(src, /state\.directorySection|state\.skillLibraryMode|state\.selectedExtensionId|state\.skillPluginFilter|state\.skillStatusFilter/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- 2>&1 | grep -A3 "single skill grid"` 或 `node --test tests/skill-library-layout.test.js`
Expected: FAIL（当前源码仍含 `renderPluginCard` / `state.directorySection` 等）。

- [ ] **Step 3: 重写 skill-library.js**

整文件替换为下面内容（删除 plugins/connectors/extensions 全部分支、目录导航、`skillSourceStatusBase` 的过滤参数收敛为只按分类）：

```javascript
// Skill library UI module
// Single full-width skill grid: search + category pills + skill cards.
// Plugins / connectors / extensions were removed — those data types are
//永远为空 today and return with the future Cloud registry (sub-project B).
// Data helpers live in skill-helpers.js (window.miaSkillHelpers).
(function () {
  "use strict";

  let state, els, mia;
  let escapeHtml, setText, menuItemHtml;
  let syncTopbarClickCapture;
  let closeGroupContextMenu, showNarrowContent;
  let deleteSkill, openSkillDirectory;

  function initSkillLibrary(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    menuItemHtml = deps.menuItemHtml;
    syncTopbarClickCapture = deps.syncTopbarClickCapture;
    closeGroupContextMenu = deps.closeGroupContextMenu;
    showNarrowContent = deps.showNarrowContent;
    deleteSkill = deps.deleteSkill;
    openSkillDirectory = deps.openSkillDirectory;
  }

  function skillMatchesFilters(skill) {
    if (!state) return false;
    const needle = state.skillFilter.trim().toLowerCase();
    const category = state.skillCategoryFilter.trim().toLowerCase();
    const haystack = [
      skill.name,
      skill.title,
      skill.description,
      window.miaSkillHelpers.skillDisplayName(skill),
      window.miaSkillHelpers.skillSummaryZh(skill),
      skill.category,
      skill.sourceLabel,
      skill.relPath,
      ...(skill.tags || [])
    ].join(" ").toLowerCase();
    return (!needle || haystack.includes(needle)) && (!category || String(skill.category || "") === category);
  }

  function visibleSkills() {
    if (!state) return [];
    return (state.skillLibrary.skills || []).filter(skillMatchesFilters);
  }

  function skillCategories() {
    const counts = new Map();
    for (const skill of (state.skillLibrary.skills || [])) {
      const category = skill.category || "uncategorized";
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  async function selectSkill(skillId, openPreview = true) {
    if (!skillId || !state) return;
    state.selectedSkillId = skillId;
    const listed = state.skillLibrary.skills.find((skill) => skill.id === skillId);
    state.selectedSkillDetail = listed || null;
    if (openPreview) state.skillPreviewOpen = true;
    renderSkillLibrary();
    renderSkillPreview();
    try {
      state.selectedSkillDetail = await window.mia.readSkill(skillId);
    } catch (error) {
      console.error("Failed to read skill", error);
    }
    renderSkillLibrary();
    renderSkillPreview();
  }

  function skillEmptyText() {
    if (state.skillsLoading) return "正在扫描本地 Skill...";
    return "没有匹配的 Skill";
  }

  function renderSkillCard(skill) {
    const tone = window.miaSkillHelpers.skillTone(skill);
    const initials = window.miaSkillHelpers.skillInitials(skill.name);
    return `
      <article class="skill-card${skill.id === state.selectedSkillId ? " featured" : ""}" data-skill-select="${escapeHtml(skill.id)}">
        <header>
          <span class="skill-card-icon ${escapeHtml(tone)}" aria-hidden="true">${escapeHtml(initials)}</span>
          <div class="skill-card-head">
            <strong>${escapeHtml(window.miaSkillHelpers.skillDisplayName(skill))}</strong>
            <small>${escapeHtml(skill.pluginLabel || window.miaSkillHelpers.skillAuthorLabel(skill))}</small>
          </div>
        </header>
        <p>${escapeHtml(window.miaSkillHelpers.skillSummaryZh(skill))}</p>
      </article>
    `;
  }

  function renderSkillLibrary() {
    if (!state || !els || !els.skillChipRow || !els.skillCardGrid) return;
    setText(els.skillPageTitle, state.skillsLoading ? "正在扫描能力" : "技能");

    const categories = skillCategories();
    els.skillChipRow.innerHTML = [
      `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
      ...categories.slice(0, 12).map(([category, count]) => `
        <button class="${state.skillCategoryFilter === category ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(category)}">
          ${escapeHtml(category)} <span>${count}</span>
        </button>
      `)
    ].join("");

    const shown = visibleSkills();
    els.skillCardGrid.innerHTML = shown.length
      ? shown.map((skill) => renderSkillCard(skill)).join("")
      : `<div class="skill-empty-state">${skillEmptyText()}</div>`;

    els.skillCardGrid.querySelectorAll("[data-skill-select]").forEach((card) => {
      card.addEventListener("click", () => selectSkill(card.dataset.skillSelect));
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openSkillContextMenu(card.dataset.skillSelect, event.clientX, event.clientY);
      });
    });
    els.skillChipRow.querySelectorAll("[data-skill-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.skillCategoryFilter = button.dataset.skillFilter || "";
        closeSkillContextMenu();
        renderSkillLibrary();
      });
    });
    renderSkillContextMenu();
  }

  function renderSkillPreview() {
    if (!state || !els || !els.skillPreviewDialog) return;
    els.skillPreviewDialog.classList.toggle("hidden", !state.skillPreviewOpen);
    const skill = state.selectedSkillDetail || state.skillLibrary.skills.find((item) => item.id === state.selectedSkillId);
    if (!skill) return;
    els.skillPreviewMark.className = `skill-dot ${window.miaSkillHelpers.skillTone(skill)}`;
    els.skillPreviewMark.textContent = window.miaSkillHelpers.skillInitials(skill.name);
    setText(els.skillPreviewTitle, window.miaSkillHelpers.skillDisplayName(skill));
    setText(els.skillPreviewMeta, `${skill.name || "Skill"} · ${skill.sourceLabel || "Local"} · ${skill.relPath || skill.category || ""}`);
    els.skillPreviewBody.innerHTML = skill.body
      ? window.miaSkillHelpers.renderSkillMarkdownSource(skill.body)
      : `<div class="skill-empty-state">正在读取 SKILL.md...</div>`;
    els.skillPreviewBody.querySelectorAll("a[href]").forEach((link) => {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noreferrer");
    });
  }

  function openSkillContextMenu(skillId, x, y) {
    if (!skillId || !state) return;
    window.miaMessageMenu?.closeMessageContextMenu();
    closeGroupContextMenu?.();
    state.skillContextMenu = { open: true, x, y, skillId };
    renderSkillContextMenu();
  }

  function closeSkillContextMenu() {
    if (!state || !state.skillContextMenu.open) return;
    state.skillContextMenu = { open: false, x: 0, y: 0, skillId: "" };
    renderSkillContextMenu();
  }

  function renderSkillContextMenu() {
    if (!state || !els || !els.skillContextMenu) return;
    const menu = els.skillContextMenu;
    const skill = state.skillLibrary.skills.find((item) => item.id === state.skillContextMenu.skillId);
    const open = state.skillContextMenu.open && skill;
    menu.classList.toggle("hidden", !open);
    syncTopbarClickCapture();
    if (!open) return;
    const canDelete = skill.source === "mia";
    menu.innerHTML = `
      ${menuItemHtml({ icon: "preview", label: "预览", attrs: 'data-skill-action="preview"' })}
      ${menuItemHtml({ icon: "folderOpen", label: "打开目录", attrs: 'data-skill-action="open-directory"' })}
      <div class="skill-context-menu-separator" role="separator"></div>
      ${menuItemHtml({ icon: "delete", label: "删除", attrs: `data-skill-action="delete" ${canDelete ? "" : "disabled"}`, className: "danger" })}
    `;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 112;
    const height = rect.height || 122;
    menu.style.left = `${Math.max(8, Math.min(state.skillContextMenu.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(state.skillContextMenu.y, window.innerHeight - height - 8))}px`;
    menu.querySelector('[data-skill-action="preview"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      selectSkill(skill.id);
    });
    menu.querySelector('[data-skill-action="delete"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      deleteSkill(skill.id);
    });
    menu.querySelector('[data-skill-action="open-directory"]')?.addEventListener("click", () => {
      closeSkillContextMenu();
      openSkillDirectory(skill.id);
    });
  }

  window.miaSkillLibrary = {
    initSkillLibrary,
    skillMatchesFilters,
    visibleSkills,
    skillCategories,
    selectSkill,
    renderSkillCard,
    skillEmptyText,
    renderSkillLibrary,
    renderSkillPreview,
    openSkillContextMenu,
    closeSkillContextMenu,
    renderSkillContextMenu,
  };
})();
```

- [ ] **Step 4: 检查 initSkillLibrary 调用方不再传已删依赖**

Run: `grep -n "initSkillLibrary\|installExtension" src/renderer/app.js`
若 `app.js` 给 `initSkillLibrary({...})` 传了 `installExtension`，删掉那一行参数（Task 3 处理）。本步仅确认位置。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/skill-library-layout.test.js`
Expected: 该用例 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/skills/skill-library.js tests/skill-library-layout.test.js
git commit -m "refactor(skills): collapse skill library to single grid path"
```

---

### Task 2: index.html 删侧栏、搜索进顶部、链接 skills.css

**Files:**
- Modify: `src/renderer/index.html`
- Test: `tests/skill-library-layout.test.js`

- [ ] **Step 1: 追加失败测试**

在 `tests/skill-library-layout.test.js` 末尾追加：

```javascript
test("skills view has no DIRECTORY sidebar and search lives in the workspace", () => {
  const html = read("src/renderer/index.html");
  assert.doesNotMatch(html, /id="skillsSidebar"/);
  assert.doesNotMatch(html, /id="skillNav"/);
  // 搜索框在 skillsView 工作区内
  const view = html.slice(html.indexOf('id="skillsView"'), html.indexOf('id="skillPreviewDialog"'));
  assert.match(view, /id="skillSearch"/);
  // skills.css 已链接
  assert.match(html, /styles\/skills\.css/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/skill-library-layout.test.js`
Expected: 新用例 FAIL（仍存在 `#skillsSidebar`，搜索在侧栏，未链接 skills.css）。

- [ ] **Step 3: 删除 `#skillsSidebar` aside**

删除整段（`src/renderer/index.html` 第 139–147 行）：

```html
    <aside id="skillsSidebar" class="sidebar skills-sidebar hidden">
      <header class="sidebar-tools skills-sidebar-tools">
        <label class="search-box">
          <span>⌕</span>
          <input id="skillSearch" autocomplete="off" placeholder="搜索能力">
        </label>
      </header>
      <section id="skillNav" class="skills-nav"></section>
    </aside>
```

- [ ] **Step 4: 把搜索框放进 `#skillsView` 顶部**

把 `#skillsView` 的 header 段（第 280–287 行附近）替换为带搜索的版本：

```html
      <header class="topbar skills-topbar">
        <button class="narrow-back-button" type="button" data-narrow-back title="返回能力库" aria-label="返回能力库">‹</button>
        <div class="group-title">
          <div>
            <h1><span id="skillPageTitle">能力库</span></h1>
          </div>
        </div>
        <label class="search-box skills-search">
          <span>⌕</span>
          <input id="skillSearch" autocomplete="off" placeholder="搜索能力">
        </label>
      </header>
```

- [ ] **Step 5: 链接 skills.css**

把第 7–10 行的样式链接补一行（放在 tasks.css 后）：

```html
  <link rel="stylesheet" href="./styles.css">
  <link rel="stylesheet" href="./styles/chat.css">
  <link rel="stylesheet" href="./styles/groups.css">
  <link rel="stylesheet" href="./styles/tasks.css">
  <link rel="stylesheet" href="./styles/skills.css">
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/skill-library-layout.test.js`
Expected: PASS（两个用例）。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/index.html tests/skill-library-layout.test.js
git commit -m "refactor(skills): drop DIRECTORY sidebar, move search into workspace"
```

---

### Task 3: app.js 清理引用 + 折叠侧栏列

**Files:**
- Modify: `src/renderer/app.js`
- Test: `tests/skill-library-layout.test.js`

- [ ] **Step 1: 追加失败测试**

追加：

```javascript
test("app.js drops skills sidebar refs and collapses the shell column", () => {
  const src = read("src/renderer/app.js");
  assert.doesNotMatch(src, /skillsSidebar:\s*document\.getElementById/);
  assert.doesNotMatch(src, /els\.skillsSidebar\?\.classList\.toggle/);
  assert.doesNotMatch(src, /skillNav:\s*document\.getElementById/);
  assert.doesNotMatch(src, /state\.skillLibraryMode\s*=\s*"plugins"/);
  // 进入视图时把 activeView 写到 app-shell，供 CSS 折叠侧栏列
  assert.match(src, /appShell\?\.setAttribute\("data-active-view"/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/skill-library-layout.test.js`
Expected: 新用例 FAIL。

- [ ] **Step 3: 删 `els.skillsSidebar` / `els.skillNav` 定义**

删除 `src/renderer/app.js:85` 与 `:110`：

```javascript
  skillsSidebar: document.getElementById("skillsSidebar"),
```
```javascript
  skillNav: document.getElementById("skillNav"),
```

- [ ] **Step 4: 删 skillsSidebar 的 hidden toggle**

删除 `src/renderer/app.js:1370`：

```javascript
  els.skillsSidebar?.classList.toggle("hidden", state.activeView !== "skills");
```

- [ ] **Step 5: 在同处写 app-shell 的 data-active-view**

在 `els.tasksView?.classList.toggle(...)` 行（约 1375）之后新增一行：

```javascript
  els.appShell?.setAttribute("data-active-view", state.activeView);
```

- [ ] **Step 6: 删 installMarketplace 安装回调里的死赋值**

把 `src/renderer/app.js:1530-1531`：

```javascript
    state.skillLibraryMode = "plugins";
    state.selectedExtensionId = "";
```
整两行删除（其外层 install 流程已无 UI 入口；若整个 `installExtension` 函数已无调用方，连同 `initSkillLibrary({... installExtension})` 的传参一并删除——见 Step 7）。

- [ ] **Step 7: 清理 initSkillLibrary 传参**

Run: `grep -n "installExtension\|initSkillLibrary" src/renderer/app.js`
若 `initSkillLibrary({...})` 仍传 `installExtension`，删除该键；若 `installExtension` 函数已无其它调用方，删除该函数定义及其孤立 import。仅删本任务造成无主的代码，不动其它。

- [ ] **Step 8: 跑测试确认通过 + 全量测试**

Run: `node --test tests/skill-library-layout.test.js && npm test 2>&1 | tail -5`
Expected: 新用例 PASS；`npm test` 全绿（644+ 通过）。

- [ ] **Step 9: 提交**

```bash
git add src/renderer/app.js
git commit -m "refactor(skills): drop sidebar refs, mark active view on app-shell"
```

---

### Task 4: 抽 styles/skills.css，全屏网格，折叠侧栏列

**Files:**
- Create: `src/renderer/styles/skills.css`
- Modify: `src/renderer/styles.css`
- Test: `tests/skill-library-layout.test.js`

- [ ] **Step 1: 追加失败测试**

追加：

```javascript
test("skill styles moved to feature stylesheet and grid is full-width", () => {
  const skillsCss = (() => { try { return read("src/renderer/styles/skills.css"); } catch { return ""; } })();
  const baseCss = read("src/renderer/styles.css");
  // 新表存在且含全屏网格 + 折叠侧栏列规则
  assert.match(skillsCss, /\.skill-card-grid/);
  assert.match(skillsCss, /\.skill-card-icon/);
  assert.match(skillsCss, /\.app-shell\[data-active-view="skills"\]/);
  // base 表不再含已删/已迁移的技能专属规则
  assert.doesNotMatch(baseCss, /\.skills-sidebar\b/);
  assert.doesNotMatch(baseCss, /\.extension-detail\b/);
  assert.doesNotMatch(baseCss, /\.skill-row-card\b/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/skill-library-layout.test.js`
Expected: FAIL（skills.css 不存在；base 仍含旧规则）。

- [ ] **Step 3: 新建 `src/renderer/styles/skills.css`**

```css
/* 技能库 — 单列全屏卡片网格。从 styles.css 抽出 + 重做布局。 */

/* 进入技能视图时折叠侧栏列，让工作区铺满 */
.app-shell[data-active-view="skills"] {
  grid-template-columns: 60px 0 0 minmax(0, 1fr);
}

.skills-workspace {
  grid-template-rows: auto minmax(0, 1fr);
}

.skills-topbar {
  align-items: center;
}

.skills-search {
  max-width: 280px;
  margin-left: auto;
}

.skills-layout {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
  padding: 18px 22px;
  background: var(--surface);
  overflow: auto;
}

.skill-chip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.skill-chip-row button {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}

.skill-chip-row button span {
  color: var(--faint);
  font-size: 11px;
}

.skill-chip-row button.active,
.skill-chip-row button:hover {
  border-color: var(--line-strong);
  background: transparent;
}

.skill-chip-row button.active {
  border-color: var(--accent);
  color: var(--accent);
}

.skill-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  align-content: start;
  align-items: start;
  gap: 14px;
  min-width: 0;
}

.skill-card {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
  min-height: 132px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
  box-shadow: 0 1px 2px rgba(20, 30, 50, 0.04);
  cursor: pointer;
}

.skill-card:hover {
  border-color: var(--line-strong);
  background: var(--surface);
}

.skill-card.featured {
  border-color: var(--accent);
}

.skill-card header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.skill-card-head {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.skill-card-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
}

.skill-card-icon.docs { background: #2563eb; }
.skill-card-icon.creative { background: #0f766e; }
.skill-card-icon.build { background: #7c3aed; }
.skill-card-icon.ops { background: #475569; }

.skill-card header strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-card header small {
  color: var(--faint);
  font-size: 12px;
}

.skill-card p {
  margin: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.skill-empty-state {
  padding: 40px 12px;
  color: var(--faint);
  text-align: center;
  font-size: 13px;
}
```

- [ ] **Step 4: 从 styles.css 删除已迁移/已废弃的技能规则**

删除 `src/renderer/styles.css` 中以下规则块（按 Task 0 勘查的行号，删时以选择器为准，逐块删除其完整 `{...}`）：
- `.skills-sidebar`（:432 起整块）
- `.skills-nav`、`:root[data-list-style="flush"] .skills-nav`（:586、:1073）
- `.skill-section-label`（:601）
- `.skill-filter-row` 及其所有变体/`flush`/`solid` 派生（:681–:760 区间内全部 `.skill-filter-row*`，及 :1081–:1122 的 flush/solid 派生）
- `.skill-dot` 及四个 tone（:760–:786）— 预览仍用 `.skill-dot`，**迁到 skills.css**（见 Step 5）
- `.skills-workspace`、`.skills-layout`（:1666、:1670）
- `.skill-chip-row*`（:1680–:1715）
- `.skill-card*`、`.skill-row-card*`、`.skill-card-grid` 及 `:has(.plugin-card)`/`:has(.skill-row-card)` 覆盖（:1717–:1795，以及 :5049 媒体查询内同名覆盖）
- `.plugin-icon*`（:1818–:1860）
- `.extension-action*`、`.extension-detail*`、`.extension-skill-list*`（:1928–:2120）

删除后确认 `styles.css` 不再出现 `.skills-sidebar` / `.extension-detail` / `.skill-row-card` / `.plugin-icon` / `.skill-filter-row`。

- [ ] **Step 5: 把预览用的 `.skill-dot` 迁入 skills.css**

在 `skills.css` 末尾追加（预览弹窗的 `#skillPreviewMark` 仍用 `.skill-dot`）：

```css
.skill-dot {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: #fff;
  font-size: 10px;
  font-weight: 430;
}

.skill-dot.docs { background: #2563eb; }
.skill-dot.creative { background: #0f766e; }
.skill-dot.build { background: #7c3aed; }
.skill-dot.ops { background: #475569; }
```

- [ ] **Step 6: 跑测试 + 验证 base 表样式断言不回归**

Run: `node --test tests/skill-library-layout.test.js && node --test tests/renderer-styles.test.js`
Expected: 全 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/styles/skills.css src/renderer/styles.css tests/skill-library-layout.test.js
git commit -m "style(skills): extract skills.css, full-width grid, collapse sidebar column"
```

---

### Task 5: 全量验证 + 手动核对

**Files:** 无（验证）

- [ ] **Step 1: 全量自动化**

Run: `npm test 2>&1 | tail -6 && npm run check`
Expected: 测试全绿；`Mia project structure OK`。

- [ ] **Step 2: 手动启动核对**

Run: `npm start`
核对清单：
- 技能视图为**单列全屏**网格，中栏 DIRECTORY 消失。
- 顶部有标题 + 右侧搜索框；分类 pill 数据驱动（当前多为 `全部 / uncategorized`）。
- 卡片有图标色块 + 名称 + 来源 + 截断描述；点击 → SKILL.md 预览弹窗；右键 → 预览/打开目录/删除。
- 搜索、分类过滤生效。
- 窄窗 1 列、宽屏多列自适应。
- 切到「聊天/联系人/任务」再切回「技能」，无 console 报错、无残留空白侧栏列。

- [ ] **Step 3: 收尾说明**

如手动核对发现 `data-active-view` 折叠列在窄屏/全屏模式下有空隙，检查 `styles.css:5026` 媒体查询是否需要同样的 `[data-active-view="skills"]` 覆盖；按需在 skills.css 的对应媒体查询补一条。

---

## Self-Review

- **Spec coverage:** 结构（删中栏）→ T2/T3/T4；数据驱动 pill → T1；卡片+预览+右键 → T1；搜索移位 → T2；CSS 抽 feature 表 → T4；loader 不动 → 计划未触 `skills-loader.js`；状态字段清理 → T1/T3 覆盖 `directorySection/skillLibraryMode/selectedExtensionId/skillPluginFilter/skillStatusFilter`。`installingExtensions` 仅在 install 流程用，T3 Step 6/7 处理其残留。
- **Placeholder scan:** 无 TBD/TODO；每个改码步骤含完整代码或精确删除目标。
- **Type consistency:** 渲染函数 `renderSkillCard`/`renderSkillLibrary`/`renderSkillPreview` 命名与导出一致；CSS 类 `.skill-card-icon` 在 JS（T1）与 CSS（T4）两处拼写一致；`data-active-view` 在 app.js（T3）与 skills.css（T4）一致。
