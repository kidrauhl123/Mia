# Task Detail Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-column task management dialog with a compact, result-first card that presents real run output as an assistant chat bubble.

**Architecture:** Keep task selection, real local/cloud data, and action ownership inside the existing task panel. Replace only the detail renderer and task-specific CSS; the detail stacks every projected run as a chronological assistant bubble and has no nested instruction/history controls.

**Tech Stack:** Electron renderer, vanilla JavaScript, CSS, Node test runner.

## Global Constraints

- The detail contains no “运行一次” action or equivalent.
- “打开对话” is an icon beside the assistant output bubble, not a text button.
- The detail exposes neither original instructions nor a run-history control.
- A task with multiple runs renders one chronological output bubble per run.
- All displayed output comes from the real task/run projection; no placeholders are introduced.
- Local and cloud task actions continue to pass `task.taskSource` to the preload API.
- The toolbar contains only the task title and its action buttons; it has no metadata subtitle.
- Every rendered run uses the executor Bot's resolved avatar through `window.miaAvatar.avatarHtml(...)`.

---

### Task 1: Lock the compact-card contract with renderer tests

**Files:**
- Modify: `tests/tasks-panel-render.test.js`

**Interfaces:**
- Consumes: `window.miaTasksPanel.renderTaskView()` and the existing task state shape.
- Produces: assertions for `.task-detail-card`, one `.task-output-row.message.assistant` per run, `.bubble`, `[data-jump-conversation]`, no history/instruction controls, and absence of `run-now`.

- [x] **Step 1: Add a failing render test**

Create a completed cloud task with two real runs, select the task, and assert that both outputs appear as chronological assistant bubbles, each conversation control has `aria-label="打开对话"`, and the HTML contains neither instruction/history controls, `data-action="run-now"`, nor the old sidebar shell.

- [x] **Step 2: Add a failing selected-history test**

Set `selectedRunId` to the older run and assert that the detail still contains every real output without rendering a history selector, `.run-detail-output`, or a “返回任务” control.

- [x] **Step 3: Run the focused test and confirm red**

Run: `node --test tests/tasks-panel-render.test.js`

Expected: the new compact-card assertions fail against the current two-column renderer.

---

### Task 2: Replace nested task/run detail rendering

**Files:**
- Modify: `src/renderer/tasks/tasks-panel.js`

**Interfaces:**
- Consumes: `task.runs`, `taskInstructionText(task)`, `taskConversationId(task)`, `mia.tasks.pause/resume/delete`.
- Produces: one `renderTaskDetail(task)` surface that shows every run output.

- [x] **Step 1: Render one result-first card**

Replace the sidebar/main shell with `.task-detail-card`: a compact metadata row and one assistant bubble row per run with an adjacent icon button. Do not render original instructions or history controls.

- [x] **Step 2: Keep only applicable management actions**

Render pause/resume and delete inside a `<details class="task-more-menu">`; remove every task-detail `run-now` branch. Keep `data-jump-conversation` on the icon control and pass `task.taskSource` for pause/resume/delete.

- [x] **Step 3: Show every run in one output stack**

Keep `data-run-id` only on the fourth-column history cards. Sort the task's runs chronologically and render every run in `renderTaskDetail`; delete nested history selection, `renderRunDetail`, and back-to-task/run-now handlers.

- [x] **Step 4: Run focused tests and confirm green**

Run: `node --test tests/tasks-panel-render.test.js`

Expected: all task panel tests pass.

---

### Task 3: Style and verify the real Electron UI

**Files:**
- Modify: `src/renderer/styles/tasks.css`
- Modify: `src/renderer/index.html` only if the static dialog shell needs a smaller accessibility label or structure adjustment.

**Interfaces:**
- Consumes: shared chat `.message.assistant` and `.bubble` visual language from `src/renderer/styles/chat.css`.
- Produces: a roughly 560px modal, responsive narrow layout, output bubble row, icon control, and anchored more menu.

- [x] **Step 1: Replace the wide two-column CSS**

Set `.task-preview-card` to `width: min(560px, calc(100vw - 32px))` and content-sized height with a viewport maximum. Remove sidebar/main, disclosure, and detail-history rules; add scoped card, metadata, output-row, icon, and more-menu styles.

- [x] **Step 2: Verify static and automated checks**

Run: `node -c src/renderer/tasks/tasks-panel.js`

Run: `node --test tests/tasks-panel-render.test.js tests/renderer-styles.test.js`

Run: `npm run check`

Expected: every command exits 0 with no failures.

- [x] **Step 3: Inspect the real cloud task in Electron**

Open the fourth column, History, and the real “吃饭提醒” cloud task. Confirm the compact dimensions, true output bubbles, icon jump affordance, no instruction/history controls, no “运行一次”, and no horizontal overflow at a narrow window size.

- [x] **Step 4: Run regression checks**

Run: `node --test tests/mia-core-ui-adapter.test.js tests/task-projection.test.js tests/tasks-panel-render.test.js`

Run: `git diff --check`

Expected: all tests pass and the diff check has no output.

---

### Task 4: Simplify the toolbar and add executor avatars

**Files:**
- Modify: `tests/tasks-panel-render.test.js`
- Modify: `tests/renderer-styles.test.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/tasks/tasks-panel.js`
- Modify: `src/renderer/styles/tasks.css`

**Interfaces:**
- Consumes: `miaContact.resolveContact({ kind: "bot", ref }, { bots })`, the returned `avatar` descriptor, and `window.miaAvatar.avatarHtml(...)`.
- Produces: `.task-output-avatar` inside every completed `.task-output-row`; a toolbar with no `#taskPreviewMeta` node.

- [x] **Step 1: Write failing structure tests**

Make the task renderer mock expose `miaAvatar.avatarHtml`. Assert that two runs render two `.task-output-avatar` elements carrying the resolved executor image, and assert that `src/renderer/index.html` and the task renderer contain no `taskPreviewMeta`.

- [x] **Step 2: Run focused tests and confirm red**

Run: `node --test tests/tasks-panel-render.test.js tests/renderer-styles.test.js`

Expected: FAIL because the toolbar still contains `#taskPreviewMeta` and output rows do not contain avatars.

- [x] **Step 3: Implement the minimal renderer change**

Resolve the task Bot once through the shared contact boundary, pass its `avatar.image`, `avatar.crop`, `avatar.color`, and `avatar.text` to `window.miaAvatar.avatarHtml`, render the result before each run bubble, and remove the static subtitle plus its renderer write.

- [x] **Step 4: Align compact layout CSS**

Reduce the toolbar to a single-line 56px row, align each run's time/status metadata with the bubble after the 42px avatar, and reserve row width for the avatar plus the existing conversation icon.

- [x] **Step 5: Verify tests and the real UI**

Run: `node -c src/renderer/tasks/tasks-panel.js`

Run: `node --test tests/tasks-panel-render.test.js tests/renderer-styles.test.js`

Run: `npm run check`

Expected: every command exits 0. Refresh Electron, open the real cloud “吃饭提醒” task, and confirm the title-only toolbar plus Mia's real avatar beside the output bubble.

---

### Task 5: Group history cards by task

**Files:**
- Modify: `tests/tasks-panel-render.test.js`
- Modify: `src/renderer/tasks/tasks-panel.js`

**Interfaces:**
- Consumes: each task's real `runs` array.
- Produces: one `.task-history-card[data-task-id]` per task, using its latest run for preview/status/time and its full run count for the execution label.

- [x] **Step 1: Add a failing render test**

Create one task with two runs and assert that History renders one card, shows `执行 2 次`, uses the latest run preview, and counts History as one task.

- [x] **Step 2: Run the focused test and confirm red**

Run: `node --test tests/tasks-panel-render.test.js`

Expected: FAIL because the current renderer flattens runs into two cards.

- [x] **Step 3: Replace run flattening with task grouping**

Sort tasks by latest run time, filter them by title/instructions/any output, classify success/failure from the latest run, and bind history cards by `data-task-id` only. Remove `data-run-card`, `data-run-id`, and obsolete `selectedRunId` branches.

- [x] **Step 4: Verify tests and real UI**

Run: `node -c src/renderer/tasks/tasks-panel.js`

Run: `node --test tests/tasks-panel-render.test.js tests/renderer-styles.test.js`

Run: `npm run check`

Expected: every command exits 0. Refresh Electron and confirm “活动提醒” appears once with `执行 2 次`, while its detail still contains two output bubbles.
