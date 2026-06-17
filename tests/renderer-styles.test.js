const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function cssRuleBody(source, selector, fromIndex = 0) {
  const selectorIndex = source.indexOf(selector, fromIndex);
  assert.notEqual(selectorIndex, -1, `missing CSS selector ${selector}`);
  const open = source.indexOf("{", selectorIndex);
  const close = source.indexOf("}", open);
  assert.ok(open > selectorIndex && close > open, `missing CSS body for ${selector}`);
  return source.slice(open + 1, close);
}

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

test("chat workspace uses the shared continuous floor", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");

  assert.match(baseCss, /--workspace-floor:\s*#f0f0f3;/);
  assert.match(baseCss, /--workspace-floor-image:\s*none;/);
  assert.match(baseCss, /--chat-background:\s*var\(--workspace-floor\);/);
  assert.match(baseCss, /--floor-text:\s*rgba\(0,\s*0,\s*0,\s*0\.88\);/);
  assert.match(baseCss, /--floor-muted:\s*rgba\(0,\s*0,\s*0,\s*0\.64\);/);
  assert.match(baseCss, /--floor-faint:\s*rgba\(0,\s*0,\s*0,\s*0\.48\);/);
  assert.match(baseCss, /\.app-shell\s*\{[\s\S]*?background:\s*var\(--workspace-floor-image\),\s*var\(--workspace-floor\);/);
  assert.match(baseCss, /#chatView\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(baseCss, /\.topbar\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(baseCss, /#chatView \.topbar\s*\{[^}]*background:\s*transparent;/);
  assert.match(chatCss, /\.chat-layout\s*\{[^}]*background:\s*transparent;/);
});

test("chat floor overlay text uses the adaptive floor palette", () => {
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");

  assert.match(chatCss, /\.message-time\s*\{[\s\S]*?color:\s*var\(--floor-faint\);/);
  assert.match(chatCss, /\.message-send-status\s*\{[\s\S]*?color:\s*var\(--floor-faint\);/);
  assert.match(chatCss, /\.trace\s*\{[\s\S]*?color:\s*var\(--floor-muted\);[\s\S]*?opacity:\s*1;/);
  assert.match(chatCss, /\.trace-row:hover\s*>\s*summary\s*\{[\s\S]*?background:\s*var\(--floor-hover\);/);
  assert.match(chatCss, /:root\[data-hover-background="false"\]\s+\.trace-row:hover\s*>\s*summary\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(chatCss, /\.trace-cmd\s*\{[\s\S]*?color:\s*var\(--floor-text\);/);
  assert.match(chatCss, /\.trace-arg\s*\{[\s\S]*?color:\s*var\(--floor-muted\);/);
  assert.match(chatCss, /\.trace-meta\s*\{[\s\S]*?color:\s*var\(--floor-faint\);/);
  assert.match(chatCss, /\.trace-body\s*\{[\s\S]*?border-left-color:\s*var\(--floor-line\);[\s\S]*?color:\s*var\(--floor-muted\);[\s\S]*?opacity:\s*1;/);
  assert.doesNotMatch(chatCss, /--text-dim/);
  assert.doesNotMatch(chatCss, /:root\[data-theme="dark"\]\s+\.message-time/);
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

test("conversation cards keep the default cursor outside tag controls", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const personaRule = baseCss.match(/\.persona\s*\{([\s\S]*?)\}/);

  assert.ok(personaRule, "base .persona rule should exist");
  assert.match(baseCss, /body\s*\{[\s\S]*?cursor:\s*default;[\s\S]*?user-select:\s*none;/);
  assert.doesNotMatch(
    personaRule[1],
    /cursor:\s*pointer/,
    "the whole conversation card should not turn into a hand cursor"
  );
  assert.match(personaRule[1], /cursor:\s*default;/);
  assert.match(personaRule[1], /user-select:\s*none;/);
  assert.match(chatCss, /\.message \.avatar\s*\{[\s\S]*?user-select:\s*none;/);
  assert.doesNotMatch(chatCss, /data:image\/svg\+xml/);
  assert.match(chatCss, /\.bubble\s*\{[\s\S]*?cursor:\s*default;[\s\S]*?user-select:\s*text;/);
  assert.match(chatCss, /\.bubble\.text-hit\s*\{[\s\S]*?cursor:\s*text;/);
  assert.doesNotMatch(chatCss, /cursor:\s*var\(--message-text-cursor\)/);
  assert.match(chatCss, /\.bubble a\.message-link\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.match(chatCss, /\.bubble code\.inline-code\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.match(chatCss, /\.message\.search-focus \.bubble\s*\{[\s\S]*?animation:\s*messageSearchFocus/);
  assert.match(chatCss, /@keyframes messageSearchFocus/);
  assert.match(baseCss, /\.persona-tag-chip\s*\{[\s\S]*?cursor:\s*pointer;/);
  const tagButtonRule = baseCss.match(/button\.persona-tag-chip\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(tagButtonRule, /font:\s*inherit/);
  assert.match(baseCss, /\.persona-tag-input\s*\{[\s\S]*?font-size:\s*10px;/);
  assert.match(baseCss, /\.persona-tag-input-wrap\s*\{[\s\S]*?animation:\s*tagInputOpen/);
  assert.match(baseCss, /\.persona-tag-chip\.removing\s*\{[\s\S]*?animation:\s*tagChipRemove/);
  assert.match(baseCss, /\.sidebar-tag-filter\s*\{[\s\S]*?height:\s*16px;[\s\S]*?font-size:\s*10px;/);
  assert.match(baseCss, /\.sidebar-tag-filter\s*\{[\s\S]*?border-radius:\s*5px;/);
  assert.match(baseCss, /\.sidebar-tag-filter\s*\{[\s\S]*?background:\s*rgba\(142,\s*142,\s*147,\s*0\.14\);[\s\S]*?color:\s*rgba\(60,\s*60,\s*67,\s*0\.56\);/);
  assert.match(baseCss, /\.search-clear\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--faint\);/);
  assert.match(baseCss, /\.search-clear:hover\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--muted\);/);
  assert.match(baseCss, /\.persona\.search-result\s*\{[\s\S]*?grid-template-columns:\s*34px minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*50px;/);
  assert.match(baseCss, /\.persona\.search-result:hover:not\(\.active\)\s*\{[\s\S]*?background:\s*rgba\(var\(--accent-rgb\),\s*0\.08\);/);
  assert.doesNotMatch(baseCss, /\.persona\.search-result\.search-selected/);
  assert.match(baseCss, /\.persona\.search-result \.persona-key\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?-webkit-line-clamp:\s*unset;/);
  assert.match(baseCss, /\.persona\.search-result \.persona-tag-row,\s*\.persona\.search-result \.persona-tags\s*\{[\s\S]*?display:\s*none;/);
});

test("settings workspace lives on the app floor and adapts to narrow windows", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.doesNotMatch(baseCss, /\.settings-modal/);
  assert.doesNotMatch(baseCss, /\.settings-dialog/);
  assert.doesNotMatch(baseCss, /@keyframes settingsDrawerIn/);
  assert.doesNotMatch(baseCss, /@keyframes settingsDrawerOut/);
  assert.match(
    baseCss,
    /\.app-shell\[data-active-view="settings"\]\s*\{[\s\S]*?background:\s*#f0f0f3;/,
    "settings should use a fixed default light-gray bottom board"
  );
  assert.match(
    baseCss,
    /\.settings-workspace\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*1;[\s\S]*?margin:\s*0;[\s\S]*?box-shadow:\s*none;/,
    "settings should occupy the bottom-board workspace column"
  );
  assert.match(
    baseCss,
    /\.settings-shell\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);[\s\S]*?background:\s*transparent;/,
    "settings shell should stop behaving like a large page card"
  );
  assert.doesNotMatch(baseCss, /\.settings-topbar/);
  assert.match(
    baseCss,
    /\.settings-layout\s*\{[\s\S]*?grid-template-columns:\s*max-content minmax\(0,\s*1fr\);[\s\S]*?gap:\s*18px;[\s\S]*?padding:\s*8px 28px 10px 0;/,
    "settings should size the floating middle pane from its own content"
  );
  assert.match(
    baseCss,
    /\.settings-tabs\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?min-width:\s*168px;[\s\S]*?max-width:\s*188px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);[\s\S]*?box-shadow:\s*var\(--rail-expanded-shadow\);/,
    "settings navigation should be a compact floating middle card"
  );
  const settingsTitleRule = cssRuleBody(baseCss, ".settings-tabs-title");
  assert.match(settingsTitleRule, /font-size:\s*18px;/, "settings title should stay lighter than a page headline");
  assert.match(settingsTitleRule, /font-weight:\s*500;/, "settings title should not use heavy display weight");
  const sidebarTitleRule = cssRuleBody(baseCss, ".sidebar-title");
  assert.match(sidebarTitleRule, /font-size:\s*16px;/, "conversation sidebar title should stay visually quieter on first load");
  assert.match(sidebarTitleRule, /font-weight:\s*560;/, "conversation sidebar title should not use heavy display weight");
  assert.match(
    baseCss,
    /\.settings-content\s*\{[\s\S]*?background:\s*transparent;/,
    "settings content should sit directly on the fixed floor"
  );
  assert.match(
    baseCss,
    /\.settings-content \.settings-row\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?width:\s*100%;[\s\S]*?border-radius:\s*14px;[\s\S]*?box-shadow:/,
    "settings rows should split into individual cards"
  );
  assert.match(baseCss, /\.workspace-path\s*\{[\s\S]*?display:\s*block;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(baseCss, /\.connection-row-head\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?min-width:\s*0;/);
  assert.match(baseCss, /\.cloud-actions\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.settings-layout\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);/,
    "settings workspace should stop hard-splitting into a sidebar and content column on narrow windows"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.settings-tabs\s*\{[\s\S]*?flex-direction:\s*row;[\s\S]*?overflow-x:\s*auto;/,
    "settings tabs should become a compact horizontal strip on narrow windows"
  );
  const narrowSettingsIndex = baseCss.indexOf("@media (max-width: 720px) {\n  .settings-workspace");
  assert.notEqual(narrowSettingsIndex, -1, "settings narrow-window media query should exist");
  const narrowSettingsTitleRule = cssRuleBody(baseCss, ".settings-tabs-title", narrowSettingsIndex);
  assert.match(narrowSettingsTitleRule, /font-size:\s*15px;/, "settings title should be smaller in the compact top strip");
  const narrowSettingsTabRule = cssRuleBody(baseCss, ".settings-tab {", narrowSettingsIndex);
  assert.match(narrowSettingsTabRule, /width:\s*auto;/, "narrow settings tabs should override the base full width");
  assert.match(narrowSettingsTabRule, /min-width:\s*0;/, "narrow settings tabs should override the base minimum width");
  assert.match(narrowSettingsTabRule, /flex:\s*1 1 0;/, "settings tabs should divide the narrow top strip instead of letting one tab fill it");
  assert.match(
    baseCss,
    /\.settings-panel \.secondary\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?word-break:\s*keep-all;/,
    "settings action buttons should not collapse into vertical Chinese text"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.settings-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    "very narrow settings rows should stack their controls below labels"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.font-choice-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
    "font choices should avoid keeping the wide four-column layout on the smallest settings width"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.workspace-setting\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    "model workspace card should stack instead of squeezing the path and action button"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.workspace-path\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/,
    "model workspace path should wrap on narrow settings dialogs"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.engine-row-body small\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?-webkit-line-clamp:\s*2;/,
    "engine executable paths should get a bounded wrapped preview on narrow settings dialogs"
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
    /\[data-lottie\]:not\(\.setup-scan-lottie\):not\(\.name-with-badge-badge-lottie\)\s+svg\s+path\[fill-opacity="0"\]\s*\{[^}]*stroke:\s*currentColor\s*!important;/,
    "only hollow Lottie outline paths should receive the theme stroke"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\):not\(\.name-with-badge-badge-lottie\)\s+svg\s+path:not\(\[fill-opacity="0"\]\)\s*\{[^}]*stroke:\s*none\s*!important;/,
    "filled Lottie paths must clear inherited rail SVG strokes"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\):not\(\.name-with-badge-badge-lottie\)\s+svg\s+path\s*\{[^}]*fill:\s*currentColor\s*!important;/,
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
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const skillLibrary = fs.readFileSync(path.join(root, "src/renderer/skills/skill-library.js"), "utf8");
  const taskPanel = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");

  assert.match(baseCss, /--floating-control-bg:\s*color-mix\(in srgb,\s*var\(--surface\)\s*86%,\s*transparent\);/);
  assert.match(baseCss, /--floating-control-shadow:\s*0 1px 2px rgba\(16,\s*20,\s*39,\s*0\.06\),\s*0 10px 28px rgba\(16,\s*20,\s*39,\s*0\.08\);/);
  assert.match(baseCss, /--floating-control-pill-shadow:\s*0 1px 3px rgba\(17,\s*24,\s*39,\s*0\.08\);/);

  for (const [name, selector, css] of [
    ["discover", "discover-mode-toggle", botStoreCss],
    ["bot store category", "bot-store-cap", botStoreCss],
    ["skills", "skill-mode-toggle", skillCss],
    ["tasks", "task-mode-toggle", taskCss]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s*\\{[^}]*position:\\s*relative;[^}]*background:\\s*var\\(--floating-control-bg\\);[^}]*box-shadow:\\s*var\\(--floating-control-shadow\\);[^}]*backdrop-filter:\\s*blur\\(18px\\) saturate\\(1\\.08\\);[^}]*isolation:\\s*isolate;`),
      `${name} toggle should be a floating control card on the workspace floor`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}::before\\s*\\{[^}]*width:\\s*var\\(--pill-w,\\s*0px\\);[^}]*background:\\s*var\\(--surface\\);[^}]*box-shadow:\\s*var\\(--floating-control-pill-shadow\\);[^}]*transform:\\s*translateX\\(var\\(--pill-x,\\s*0px\\)\\);[^}]*transition:\\s*transform\\s+\\d+ms[^;]*,\\s*width\\s+\\d+ms[^;]*,\\s*opacity\\s+\\d+ms`),
      `${name} topbar toggle should move one selected capsule instead of swapping button backgrounds`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\s*\\{[^}]*color:\\s*var\\(--muted\\);`),
      `${name} inactive toggle labels should use the floating card text palette`
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

test("floating-floor text uses adaptive floor colors outside surface cards", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  assert.match(
    skillCss,
    /\.skills-search\s*\{[^}]*color:\s*var\(--faint\);/,
    "skills search icon sits inside a floating card and should use the normal card palette"
  );
  assert.match(
    skillCss,
    /\.skills-search\s+input\s*\{[^}]*color:\s*var\(--text\);/,
    "skills search input sits inside a floating card and should use the normal card palette"
  );
  assert.match(
    skillCss,
    /\.skills-search\s+input::placeholder\s*\{[^}]*color:\s*var\(--muted\);/,
    "skills search placeholder sits inside a floating card and should use the normal card palette"
  );

  assert.match(baseCss, /\.contact-empty\.detail-empty\s*\{[^}]*color:\s*var\(--floor-muted\);/);
  assert.match(botStoreCss, /\.bot-store-empty\s*\{[^}]*color:\s*var\(--floor-faint\);/);
  assert.match(skillCss, /\.skill-empty-state\s*\{[^}]*color:\s*var\(--floor-faint\);/);
  assert.match(taskCss, /\.tasks-empty\s*\{[^}]*color:\s*var\(--floor-muted\);/);
  assert.match(taskCss, /\.tasks-empty h2\s*\{[^}]*color:\s*var\(--floor-text\);/);
  assert.match(taskCss, /\.tasks-empty em\s*\{[^}]*color:\s*var\(--floor-text\);/);
  assert.match(taskCss, /\.task-mode-count\s*\{[^}]*color:\s*var\(--faint\);/);
  assert.match(
    taskCss,
    /\.task-mode-toggle button\.active \.task-mode-count\s*\{[^}]*color:\s*var\(--faint\);/,
    "selected task mode counts sit on a surface capsule and should not use bright floor text"
  );
});

test("discover, skill, and task controls float over one continuous workspace floor", () => {
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\],\s*\.app-shell\[data-active-view="bot-store"\]\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/,
    "contacts and discover should not reserve a fake topbar grid row"
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\]\s+\.discover-top-bar,\s*\.app-shell\[data-active-view="bot-store"\]\s+\.discover-top-bar\s*\{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/,
    "discover topbar container should float over the floor without eating floor clicks"
  );
  assert.match(
    botStoreCss,
    /\.discover-mode-toggle\s*\{[^}]*pointer-events:\s*auto;/,
    "discover mode toggle itself should remain clickable"
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\]\s+\.contacts-sidebar\s*\{[^}]*grid-row:\s*1;/
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="bot-store"\]\s+#botStoreView\s*\{[^}]*grid-row:\s*1;/
  );
  assert.match(
    botStoreCss,
    /\.bot-store-layout\s*\{[^}]*overflow:\s*auto;/,
    "bot store should scroll the whole workspace floor, not an inner list window"
  );
  assert.match(
    botStoreCss,
    /\.bot-store-grid-scroll\s*\{[^}]*overflow:\s*visible;/,
    "bot store grid wrapper should not create a second scroll boundary"
  );

  for (const [name, css, workspaceSelector, topbarSelector, contentSelector] of [
    ["skills", skillCss, "skills-workspace", "skills-topbar", "skills-layout"],
    ["tasks", taskCss, "tasks-workspace", "tasks-topbar", "tasks-layout"]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${workspaceSelector}\\s*\\{[^}]*grid-template-rows:\\s*minmax\\(0,\\s*1fr\\);`),
      `${name} workspace should not reserve a fake topbar grid row`
    );
    assert.match(
      css,
      new RegExp(`\\.${topbarSelector}\\s*\\{[^}]*position:\\s*absolute;[^}]*pointer-events:\\s*none;`),
      `${name} topbar container should float over the floor without eating floor clicks`
    );
    assert.match(
      css,
      new RegExp(`\\.${topbarSelector}\\s*>\\s*\\*\\s*\\{[^}]*pointer-events:\\s*auto;`),
      `${name} floating topbar controls should remain clickable`
    );
    assert.match(
      css,
      new RegExp(`\\.${contentSelector}\\s*\\{[^}]*grid-template-rows:\\s*none;[^}]*overflow:\\s*auto;`),
      `${name} content should scroll as one floor rather than a row-limited panel`
    );
  }
});

test("floating-floor pages remove the workspace frame even in narrow layouts", () => {
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\],\s*\.app-shell\[data-active-view="bot-store"\]\s*\{[^}]*padding:\s*0;/,
    "contacts/discover should not keep the app-shell padding as a blue edge"
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\]\s+#contactsView,\s*\.app-shell\[data-active-view="bot-store"\]\s+#botStoreView\s*\{[^}]*margin:\s*0;[^}]*border-radius:\s*0;[^}]*overflow:\s*visible;/,
    "contacts/discover workspaces should override the narrow workspace margin and rounded frame"
  );

  for (const [name, css, activeView, viewId] of [
    ["skills", skillCss, "skills", "skillsView"],
    ["tasks", taskCss, "tasks", "tasksView"]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.app-shell\\[data-active-view="${activeView}"\\]\\s*\\{[^}]*padding:\\s*0;`),
      `${name} should not keep the app-shell padding as a blue edge`
    );
    assert.match(
      css,
      new RegExp(`\\.app-shell\\[data-active-view="${activeView}"\\]\\s+#${viewId}\\s*\\{[^}]*margin:\\s*0;[^}]*border-radius:\\s*0;[^}]*overflow:\\s*visible;`),
      `${name} workspace should override the narrow workspace margin and rounded frame`
    );
  }
});

test("skill and task category filters are redesigned as individual floating chips", () => {
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  for (const [name, selector, css] of [
    ["skills", "skill-chip-row", skillCss],
    ["tasks", "task-chip-row", taskCss]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s*\\{[^}]*padding:\\s*0;[^}]*border-radius:\\s*0;[^}]*background:\\s*transparent;[^}]*box-shadow:\\s*none;[^}]*flex-wrap:\\s*wrap;`),
      `${name} category row should not be one oversized floating card`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\s*\\{[^}]*background:\\s*var\\(--floating-control-bg\\);[^}]*box-shadow:\\s*var\\(--floating-control-shadow\\);[^}]*backdrop-filter:\\s*blur\\(18px\\) saturate\\(1\\.08\\);[^}]*color:\\s*var\\(--muted\\);`),
      `${name} inactive category chips should each be their own floating chip`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\s+span\\s*\\{[^}]*color:\\s*var\\(--faint\\);`),
      `${name} inactive category chip counts should use the normal floating card palette`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\.active\\s*\\{[^}]*background:\\s*var\\(--surface\\);[^}]*color:\\s*var\\(--text\\);[^}]*box-shadow:\\s*var\\(--floating-control-shadow\\);`),
      `${name} active category chip should stay independent instead of relying on a parent card`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button(?::hover|\\.active)\\s+span\\s*\\{[^}]*color:\\s*var\\(--faint\\);`),
      `${name} counts should return to the normal surface palette on white chips`
    );
  }
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
  assert.match(taskPanel, /task-prompt-details accordion-details/);
  assert.match(taskPanel, /class="accordion-body"/);
  assert.doesNotMatch(taskPanel, /run-detail-actions\" style=/);

  assert.match(taskCss, /\.task-detail-shell\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*260px\)\s+minmax\(0,\s*1fr\);/);
  assert.match(taskCss, /\.task-detail-sidebar\s*\{[^}]*position:\s*sticky;/);
  assert.match(taskCss, /\.task-primary-actions\s*\{[^}]*grid-template-columns:\s*1fr;/);
  assert.match(taskCss, /\.task-section\s*\{[^}]*border:\s*1px solid var\(--line\);/);
  assert.match(taskCss, /\.task-prompt-details > summary::after\s*\{[^}]*transform:\s*rotate\(45deg\);/);
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
