const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("renderer styles are split into feature stylesheets", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const groupsCss = fs.readFileSync(path.join(root, "src/renderer/styles/groups.css"), "utf8");
  const tasksCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  assert.match(html, /styles\.css[\s\S]*styles\/chat\.css[\s\S]*styles\/groups\.css[\s\S]*styles\/tasks\.css/);
  assert.match(chatCss, /\.chat-layout/);
  assert.match(chatCss, /\.trace/);
  assert.match(groupsCss, /\.group-create-card/);
  assert.match(tasksCss, /\.task-card/);
  assert.doesNotMatch(baseCss, /\.chat-layout/);
  assert.doesNotMatch(baseCss, /\.group-create-card/);
  assert.doesNotMatch(baseCss, /\.task-card/);
});

test("group create member picker uses compact filled contact rows", () => {
  const groupsCss = fs.readFileSync(path.join(root, "src/renderer/styles/groups.css"), "utf8");

  assert.match(groupsCss, /\.group-create-members\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*var\(--field\);/);
  assert.match(groupsCss, /\.group-create-member-row\s*\{[\s\S]*?grid-template-columns:\s*26px minmax\(0,\s*1fr\) 22px;/);
  assert.match(groupsCss, /\.group-create-member-row\s*\{[\s\S]*?min-height:\s*32px;/);
  assert.match(groupsCss, /\.group-create-member-row\s*\{[\s\S]*?cursor:\s*default;/);
  assert.match(groupsCss, /\.group-create-member-row:hover\s*\{\s*background:\s*var\(--hover-background\);\s*\}/);
  assert.match(groupsCss, /\.group-create-member-row \.member-avatar\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;[\s\S]*?border:\s*0;/);
  assert.doesNotMatch(groupsCss, /\.group-create-member-row\.is-selected\s*\{[\s\S]*?background:/);
  assert.match(groupsCss, /\.group-create-member-row\.is-selected \.member-check\s*\{[\s\S]*?background:\s*var\(--accent\);/);
});

test("chat topbar stays on the white surface while the transcript canvas is gray", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");

  assert.match(baseCss, /--chat-background:\s*#f0f0f3;/);
  assert.match(baseCss, /#chatView \.topbar\s*\{[^}]*background:\s*var\(--surface\);/);
  assert.doesNotMatch(baseCss, /#chatView \.topbar\s*\{[^}]*background:\s*var\(--chat-background\);/);
  assert.match(chatCss, /\.chat-layout\s*\{[^}]*background:\s*var\(--chat-background\);/);
});

test("sidebar and chat headers use the same surface and own their divider line", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(
    baseCss,
    /\.sidebar-tools\s*\{[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*background:\s*var\(--surface\);/,
    "sidebar header should draw the same bottom divider as the chat topbar on the same surface"
  );
  assert.match(
    baseCss,
    /\.conversation-section,\s*\.contact-section\s*\{[^}]*border-top:\s*0;/,
    "sidebar body should not draw a second adjacent divider that can drift from the topbar line"
  );
});

test("lottie icon styles keep filled shapes from gaining outline strokes", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.doesNotMatch(
    baseCss,
    /\[data-lottie\]\s+svg\s+path\s*\{[^}]*stroke:/,
    "generic Lottie path styling must not add strokes to filled dots or accents"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\)\s+svg\s+path\[fill-opacity="0"\]\s*\{[^}]*stroke:\s*currentColor\s*!important;/,
    "only hollow Lottie outline paths should receive the theme stroke"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\)\s+svg\s+path:not\(\[fill-opacity="0"\]\)\s*\{[^}]*stroke:\s*none\s*!important;/,
    "filled Lottie paths must clear inherited rail SVG strokes"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\)\s+svg\s+path\s*\{[^}]*fill:\s*currentColor\s*!important;/,
    "theme repainting should apply only to app icon Lotties"
  );
  assert.doesNotMatch(
    baseCss,
    /\.setup-scan-lottie\s+svg\s+path\s*\{[^}]*fill:\s*currentColor/,
    "startup scan animation should keep the source LottieFiles colors"
  );
  assert.match(
    baseCss,
    /\.rail-lottie\s+svg\s+path\[fill-opacity="0"\]\s*\{[^}]*stroke-width:\s*1\.8px\s*!important;[^}]*vector-effect:\s*non-scaling-stroke\s*!important;/,
    "rail Lottie outlines should keep the same screen stroke weight as static rail icons"
  );
  assert.match(
    baseCss,
    /\.menu-item-icon\s+svg\s+path\[fill-opacity="0"\]\s*\{[^}]*stroke-width:\s*1px\s*!important;[^}]*vector-effect:\s*non-scaling-stroke\s*!important;/,
    "menu Lottie animation outlines should stay as light as their static rest silhouettes"
  );
  assert.match(
    baseCss,
    /\.menu-item-icon\[data-lottie="translate"\]\s+svg\s+path\[fill-opacity="0"\]\s*\{[^}]*stroke-width:\s*0\.72px\s*!important;/,
    "the scaled translate glyph needs a thinner source stroke to avoid looking heavier"
  );
});

test("topbar mode toggles animate a shared selected capsule indicator", () => {
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const skillLibrary = fs.readFileSync(path.join(root, "src/renderer/skills/skill-library.js"), "utf8");
  const taskPanel = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");

  for (const [name, selector, css] of [
    ["skills", "skill-mode-toggle", skillCss],
    ["tasks", "task-mode-toggle", taskCss]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s*\\{[^}]*position:\\s*relative;[^}]*isolation:\\s*isolate;`),
      `${name} topbar toggle should establish a positioning layer for the animated capsule`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}::before\\s*\\{[^}]*width:\\s*var\\(--pill-w,\\s*0px\\);[^}]*transform:\\s*translateX\\(var\\(--pill-x,\\s*0px\\)\\);[^}]*transition:\\s*transform\\s+\\d+ms[^;]*,\\s*width\\s+\\d+ms[^;]*,\\s*opacity\\s+\\d+ms`),
      `${name} topbar toggle should move one selected capsule instead of swapping button backgrounds`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\.active\\s*\\{[^}]*background:\\s*transparent;`),
      `${name} active button background should not fight the animated capsule layer`
    );
  }

  assert.match(
    `${skillCss}\n${taskCss}`,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.(?:skill|task)-mode-toggle::before\s*\{[^}]*transition:\s*none;/,
    "topbar toggle capsule animation should respect reduced-motion preferences"
  );
  assert.match(
    skillLibrary,
    /syncModeToggleIndicator\(els\.skillModeToggle\)/,
    "skill mode toggle should sync the selected capsule after render"
  );
  assert.match(
    taskPanel,
    /syncModeToggleIndicator\(host\)/,
    "task mode toggle should sync the selected capsule after render"
  );
});

test("task preview dialog uses a structured inspector layout", () => {
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const taskPanel = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");

  assert.match(taskPanel, /task-detail-shell/);
  assert.match(taskPanel, /task-detail-sidebar/);
  assert.match(taskPanel, /task-detail-main/);
  assert.match(taskPanel, /task-primary-actions/);
  assert.match(taskPanel, /task-status-pill/);
  assert.match(taskPanel, /task-section/);
  assert.doesNotMatch(taskPanel, /run-detail-actions\" style=/);

  assert.match(taskCss, /\.task-detail-shell\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*260px\)\s+minmax\(0,\s*1fr\);/);
  assert.match(taskCss, /\.task-detail-sidebar\s*\{[^}]*position:\s*sticky;/);
  assert.match(taskCss, /\.task-primary-actions\s*\{[^}]*grid-template-columns:\s*1fr;/);
  assert.match(taskCss, /\.task-section\s*\{[^}]*border:\s*1px solid var\(--line\);/);
  assert.match(taskCss, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.task-detail-shell\s*\{[^}]*grid-template-columns:\s*1fr;/);
});

test("chat history session menus constrain long history lists to an internal scroller", () => {
  const rendererCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const webCss = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

  for (const [name, css] of [["renderer", rendererCss], ["web", webCss]]) {
    assert.match(
      css,
      /\.session-menu\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/,
      `${name} session menu should reserve a bounded row for the scrollable history list`
    );
    assert.match(
      css,
      /\.session-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/,
      `${name} session list should scroll internally instead of painting outside the menu`
    );
  }
});
