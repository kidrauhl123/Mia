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

test("agent run loading status keeps the shimmer on text without a container card", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  const statusRule = cssRuleBody(baseCss, ".agent-run-status");
  assert.match(statusRule, /background:\s*transparent;/);
  assert.match(statusRule, /border:\s*0;/);
  assert.match(statusRule, /box-shadow:\s*none;/);
  assert.match(statusRule, /--agent-run-status-text:\s*var\(--floor-muted,\s*var\(--muted\)\);/);
  assert.match(statusRule, /--agent-run-status-strong:\s*var\(--floor-text,\s*var\(--text\)\);/);
  assert.doesNotMatch(baseCss, /\.agent-run-status::before/);

  const loaderRule = cssRuleBody(baseCss, ".agent-run-status-loader");
  assert.doesNotMatch(loaderRule, /--accent/);
  assert.match(loaderRule, /grid-template-columns:\s*repeat\(5,\s*2px\);/);
  assert.match(loaderRule, /grid-template-rows:\s*repeat\(5,\s*2px\);/);

  const orbDotRule = cssRuleBody(baseCss, ".agent-run-status-orb-dot");
  assert.doesNotMatch(orbDotRule, /--accent/);
  assert.match(orbDotRule, /var\(--agent-run-status-loader-strong\)/);

  const loadingLabelRule = cssRuleBody(baseCss, ".agent-run-status.is-loading .agent-run-status-label");
  assert.match(loadingLabelRule, /background:[\s\S]*linear-gradient/);
  assert.doesNotMatch(loadingLabelRule, /--accent/);
  assert.match(loadingLabelRule, /var\(--agent-run-status-shine\)/);
  assert.match(loadingLabelRule, /background-clip:\s*text;/);
  assert.match(loadingLabelRule, /animation:\s*agentRunStatusTextSweep\s*4\.8s\s*ease-in-out\s*infinite;/);
  assert.match(loadingLabelRule, /animation-delay:\s*calc\(var\(--agent-run-animation-age,\s*0ms\) \* -1\);/);

  assert.doesNotMatch(baseCss, /animation:\s*agentRunPhaseOrb/);
  assert.doesNotMatch(baseCss, /@keyframes agentRunPhaseOrb/);
  assert.doesNotMatch(baseCss, /@keyframes agentRunStatusSpin/);

  const dotRule = cssRuleBody(baseCss, ".agent-run-status-loading-dots span");
  assert.match(dotRule, /animation:\s*agentRunStatusDot\s*1\.8s\s*ease-in-out\s*infinite;/);
  assert.match(dotRule, /animation-delay:\s*calc\(var\(--agent-run-animation-age,\s*0ms\) \* -1\);/);

  assert.match(
    baseCss,
    /:where\(\.message\.user,\s*\.persona\.active,\s*\.contact-row\.active\) \.agent-run-status\s*\{[\s\S]*?--agent-run-status-text:\s*rgba\(255,\s*255,\s*255,\s*0\.78\);[\s\S]*?--agent-run-status-strong:\s*rgba\(255,\s*255,\s*255,\s*0\.94\);/,
    "status line should expose an on-strong-background color override"
  );

});

test("chat avatar display settings do not hide group participant avatars", () => {
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");

  assert.match(
    chatCss,
    /:root\[data-show-assistant-avatar="false"\]\s+\.message\.assistant:not\(\.group-message\)\s+\.avatar/,
    "partner avatar toggle must only hide non-group assistant avatars"
  );
  assert.match(
    chatCss,
    /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.message:not\(\.group-message\)\s+\.avatar\s*\{\s*display:\s*none;/,
    "narrow layout must keep group participant avatars visible"
  );
});

test("sidebar and chat headers use the same surface and own their divider line", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(baseCss, /--surface-layer:\s*#f5f7f8;/);
  assert.match(
    baseCss,
    /\.sidebar\s*\{[^}]*background:\s*var\(--surface-layer\);/,
    "message middle pane should use the shared non-white layer surface"
  );
  assert.match(
    baseCss,
    /\.sidebar-tools\s*\{[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*background:\s*var\(--surface-layer\);/,
    "sidebar header should draw the same bottom divider as the message middle pane surface"
  );
  assert.match(
    baseCss,
    /\.conversation-section,\s*\.contact-section\s*\{[^}]*border-top:\s*0;/,
    "sidebar body should not draw a second adjacent divider that can drift from the topbar line"
  );
  const conversationSidebarToolsRule = cssRuleBody(baseCss, ".conversation-sidebar .sidebar-tools");
  assert.match(
    conversationSidebarToolsRule,
    /-webkit-app-region:\s*drag;/,
    "conversation sidebar header should be a draggable window region"
  );
  assert.match(
    baseCss,
    /\.conversation-sidebar \.sidebar-tools button,\s*\.conversation-sidebar \.sidebar-tools input,\s*\.conversation-sidebar \.sidebar-tools \.search-box,\s*\.conversation-sidebar \.sidebar-tools \.create-menu,\s*\.conversation-sidebar \.sidebar-tools \.sidebar-tag-filters\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    "conversation sidebar header controls should remain clickable instead of dragging the window"
  );
});

test("conversation search uses a white field without focus highlight", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const conversationSearchRule = cssRuleBody(baseCss, ".conversation-sidebar .search-box");
  const searchFocusRule = cssRuleBody(baseCss, ".search-box:focus-within");

  assert.match(conversationSearchRule, /background:\s*var\(--surface\);/);
  assert.match(searchFocusRule, /box-shadow:\s*none;/);
});

test("project styles do not draw focus highlights", () => {
  const styleFiles = [
    "src/renderer/styles.css",
    "src/renderer/styles/chat.css",
    "src/renderer/styles/groups.css",
    "src/renderer/styles/tasks.css",
    "src/renderer/styles/bot-store.css",
    "src/renderer/onboarding/onboarding.css",
    "src/web/styles.css",
    "src/web/admin-model.css",
    "src/web/assets/mia.css"
  ];
  const styles = styleFiles
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");

  assert.doesNotMatch(styles, /:focus(?:-visible|-within)?[^{]*\{[^}]*box-shadow:(?!\s*none\b)/);
  assert.doesNotMatch(styles, /:focus(?:-visible|-within)?[^{]*\{[^}]*border-color:\s*rgb\(var\(--accent-rgb\)/);
  assert.doesNotMatch(styles, /:focus(?:-visible|-within)?[^{]*\{[^}]*outline:(?!\s*(?:0|none)\b)/);
  assert.doesNotMatch(styles, /:focus(?:-visible|-within)?[^{]*\{[^}]*background(?:-color)?:\s*(?:var\(--hover|rgb\(var\(--accent-rgb\)|rgba\()/);
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
  const messageLinkRule = cssRuleBody(chatCss, ".bubble a.message-link");
  const messageLinkHoverRule = cssRuleBody(chatCss, ".bubble a.message-link:hover");
  assert.match(messageLinkRule, /color:\s*var\(--accent\);/);
  assert.match(messageLinkRule, /text-decoration:\s*none;/);
  assert.match(messageLinkRule, /text-decoration-color:\s*var\(--accent\);/);
  assert.match(messageLinkRule, /text-decoration-thickness:\s*1px;/);
  assert.match(messageLinkRule, /cursor:\s*pointer;/);
  assert.match(messageLinkHoverRule, /text-decoration:\s*underline;/);
  assert.match(messageLinkHoverRule, /text-decoration-color:\s*var\(--accent\);/);
  assert.match(messageLinkHoverRule, /text-decoration-thickness:\s*1px;/);
  assert.doesNotMatch(chatCss, /:root\[data-theme="dark"\]\s+\.bubble a\.message-link/);
  assert.doesNotMatch(chatCss, /\.message\.user \.bubble a\.message-link/);
  assert.match(chatCss, /\.bubble code\.inline-code\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.match(chatCss, /\.message\.search-focus \.bubble\s*\{[\s\S]*?animation:\s*messageSearchFocus/);
  assert.match(chatCss, /@keyframes messageSearchFocus/);
  assert.match(baseCss, /\.persona-tag-chip\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.match(
    baseCss,
    /\.persona\.active \.persona-key \.typing-status\s*\{[\s\S]*?color:\s*var\(--list-active-text\);/,
    "typing preview should switch to the active-list text color on selected conversation cards"
  );
  assert.match(
    baseCss,
    /\.app-shell\[data-shell-layout="single"\] \.persona\.active \.persona-key \.typing-status\s*\{[\s\S]*?color:\s*var\(--accent,\s*#5e5ce6\);/,
    "typing preview should return to the normal non-selected color when single-pane layout removes the active card background"
  );
  const tagButtonRule = baseCss.match(/button\.persona-tag-chip\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(tagButtonRule, /font:\s*inherit/);
  assert.match(baseCss, /\.persona-tag-input\s*\{[\s\S]*?font-size:\s*10px;/);
  assert.match(baseCss, /\.persona-tag-input-wrap\s*\{[\s\S]*?animation:\s*tagInputOpen/);
  assert.match(baseCss, /\.persona-tag-chip\.removing\s*\{[\s\S]*?animation:\s*tagChipRemove/);
  const appUpdateOverlayRule = baseCss.match(/\.app-update-overlay\s*\{([\s\S]*?)\}/)?.[1] || "";
  const appUpdatePanelRule = baseCss.match(/\.app-update-panel\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(baseCss, /body\.update-locked/);
  assert.match(appUpdateOverlayRule, /background:\s*transparent;/);
  assert.match(appUpdateOverlayRule, /backdrop-filter:\s*none;/);
  assert.match(appUpdateOverlayRule, /pointer-events:\s*none;/);
  assert.match(appUpdatePanelRule, /pointer-events:\s*auto;/);
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
  assert.doesNotMatch(
    baseCss,
    /\.app-shell\[data-active-view="settings"\]\s*\{[^}]*background:/,
    "settings should follow the shared workspace floor instead of forcing a fixed bottom board"
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
    /\.settings-tabs\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?min-width:\s*168px;[\s\S]*?max-width:\s*188px;[\s\S]*?border-radius:\s*var\(--rail-corner-radius\);[\s\S]*?background:\s*var\(--surface-layer\);[\s\S]*?box-shadow:\s*var\(--rail-expanded-shadow\);[\s\S]*?backdrop-filter:\s*none;/,
    "settings navigation should use the same non-white middle-pane surface as the message sidebar"
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
  assert.match(baseCss, /--rail-glass-bg:\s*color-mix\(in srgb,\s*var\(--surface-layer\)\s*82%,\s*transparent\);/);
  assert.match(baseCss, /--segmented-control-bg:\s*var\(--rail-glass-bg\);/);
  assert.match(baseCss, /--segmented-control-active-bg:\s*var\(--accent\);/);
  assert.match(baseCss, /--segmented-control-active-text:\s*#fff;/);

  for (const [name, selector, css] of [
    ["discover", "discover-mode-toggle", botStoreCss],
    ["bot store category", "bot-store-cap", botStoreCss],
    ["skills", "skill-mode-toggle", skillCss],
    ["tasks", "task-mode-toggle", taskCss]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s*\\{[^}]*position:\\s*relative;[^}]*background:\\s*var\\(--segmented-control-bg\\);[^}]*box-shadow:\\s*var\\(--segmented-control-shadow\\);[^}]*backdrop-filter:\\s*blur\\(24px\\) saturate\\(1\\.16\\);[^}]*isolation:\\s*isolate;`),
      `${name} toggle should use the same glass surface family as the rail`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}::before\\s*\\{[^}]*width:\\s*var\\(--pill-w,\\s*0px\\);[^}]*background:\\s*var\\(--segmented-control-active-bg\\);[^}]*box-shadow:\\s*var\\(--segmented-control-pill-shadow\\);[^}]*transform:\\s*translateX\\(var\\(--pill-x,\\s*0px\\)\\);[^}]*transition:\\s*transform\\s+\\d+ms[^;]*,\\s*width\\s+\\d+ms[^;]*,\\s*opacity\\s+\\d+ms`),
      `${name} topbar toggle should move one theme-colored selected capsule`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\s*\\{[^}]*color:\\s*var\\(--muted\\);`),
      `${name} inactive toggle labels should use the floating card text palette`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\.active\\s*\\{[^}]*background:\\s*transparent;[^}]*color:\\s*var\\(--segmented-control-active-text\\);`),
      `${name} active labels should sit on the theme-colored capsule`
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
    /\.task-mode-toggle button\.active \.task-mode-count\s*\{[^}]*color:\s*var\(--segmented-control-active-muted\);/,
    "selected task mode counts should stay readable on the theme-colored capsule"
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
    /\.bot-store-layout\s*\{[^}]*grid-template-rows:\s*none;[^}]*grid-auto-rows:\s*max-content;[^}]*align-content:\s*start;[^}]*align-items:\s*start;[^}]*overflow:\s*auto;/,
    "bot store should scroll the whole workspace floor from the top-left rather than stretch or center sparse rows"
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
      new RegExp(`\\.${contentSelector}\\s*\\{[^}]*grid-template-rows:\\s*none;[^}]*grid-auto-rows:\\s*max-content;[^}]*align-content:\\s*start;[^}]*align-items:\\s*start;[^}]*overflow:\\s*auto;`),
      `${name} content should scroll as one floor from the top-left rather than a row-limited or centered panel`
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

test("discover, skill, and task cards start from the fixed left edge", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const masonryHelper = fs.readFileSync(path.join(root, "src/renderer/helpers/masonry-grid.js"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const botStoreJs = fs.readFileSync(path.join(root, "src/renderer/bot/bot-store.js"), "utf8");
  const skillJs = fs.readFileSync(path.join(root, "src/renderer/skills/skill-library.js"), "utf8");
  const taskJs = fs.readFileSync(path.join(root, "src/renderer/tasks/tasks-panel.js"), "utf8");

  assert.match(
    html,
    /helpers\/masonry-grid\.js[\s\S]*skills\/skill-library\.js[\s\S]*bot\/bot-store\.js[\s\S]*tasks\/tasks-panel\.js/,
    "masonry helper should load before the card renderers that call it"
  );
  assert.match(masonryHelper, /const columnHeights = Array\(columnCount\)\.fill\(0\)/);
  assert.match(masonryHelper, /item\.style\.position = "absolute"/);
  assert.match(masonryHelper, /item\.style\.width = `\$\{columnWidth\}px`/);
  assert.match(masonryHelper, /item\.style\.transform = `translate3d\(\$\{x\}px, \$\{y\}px, 0\)`/);
  assert.match(masonryHelper, /grid\.style\.height = `\$\{Math\.ceil\(Math\.max\(0, height\)\)\}px`/);
  assert.doesNotMatch(masonryHelper, /gridRowEnd\s*=\s*`span/);
  assert.match(masonryHelper, /classList\.add\("masonry-grid"\)/);
  assert.match(masonryHelper, /function capture\(grid,\s*direction/);
  assert.match(masonryHelper, /cloneNode\(true\)/);
  assert.match(masonryHelper, /snapshot\.classList\.remove\("page-enter-forward",\s*"page-enter-back",\s*"page-leave-forward",\s*"page-leave-back"\)/);
  assert.match(masonryHelper, /masonry-page-shadow/);
  assert.match(masonryHelper, /page-enter-forward/);
  assert.match(masonryHelper, /options\.animate/);
  assert.doesNotMatch(masonryHelper, /page-turn-distance/);
  assert.match(baseCss, /\.masonry-grid-stage\s*\{[^}]*position:\s*relative;/);
  assert.match(baseCss, /\.masonry-page-shadow\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*2;[^}]*opacity:\s*1;[^}]*will-change:\s*transform;/);
  assert.match(baseCss, /\.masonry-grid\.page-enter-forward\s*\{[^}]*animation:\s*cardGridEnterForward\s+300ms/);
  assert.match(baseCss, /\.masonry-page-shadow\.page-leave-forward\s*\{[^}]*animation:\s*cardGridLeaveForward\s+300ms/);
  assert.match(baseCss, /@keyframes cardGridEnterForward\s*\{\s*from\s*\{\s*transform:\s*translate3d\(100%,\s*0,\s*0\);/);
  assert.match(baseCss, /@keyframes cardGridLeaveForward\s*\{[\s\S]*?to\s*\{\s*transform:\s*translate3d\(-100%,\s*0,\s*0\);/);
  assert.doesNotMatch(cssRuleBody(baseCss, "@keyframes cardGridEnterForward"), /opacity:/);
  assert.doesNotMatch(cssRuleBody(baseCss, "@keyframes cardGridLeaveForward"), /opacity:/);
  assert.match(botStoreCss, /\.bot-store-grid-scroll\.masonry-grid-stage\s*\{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*visible;/);
  assert.match(skillCss, /\.skills-layout\.masonry-grid-stage\s*\{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*auto;/);
  assert.match(taskCss, /\.tasks-layout\.masonry-grid-stage\s*\{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*auto;/);

  for (const [name, css, gridSelector, cardSelector] of [
    ["discover", botStoreCss, "bot-store-grid", "bot-store-card"],
    ["skills", skillCss, "skill-card-grid", "skill-card"],
    ["tasks", taskCss, "task-card-grid", "task-card"]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${gridSelector}\\s*\\{[^}]*display:\\s*grid;[^}]*grid-template-columns:\\s*repeat\\(4,\\s*minmax\\(0,\\s*1fr\\)\\);[^}]*justify-content:\\s*start;[^}]*gap:\\s*12px;`),
      `${name} page should use a stable left-aligned grid instead of centering sparse cards`
    );
    assert.match(
      css,
      new RegExp(`\\.${cardSelector}\\s*\\{[^}]*min-width:\\s*0;[^}]*border:\\s*1px solid rgba\\(17,\\s*24,\\s*39,\\s*0\\.05\\);[^}]*border-radius:\\s*10px;`),
      `${name} cards should stay compact inside fixed left-start columns`
    );
    assert.match(
      css,
      new RegExp(`@media\\s*\\(max-width:\\s*500px\\)\\s*\\{[\\s\\S]*?\\.${gridSelector}\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(2,\\s*minmax\\(0,\\s*1fr\\)\\);`),
      `extra narrow ${name} layout should keep two columns`
    );
    assert.doesNotMatch(
      cssRuleBody(css, `.${gridSelector}`),
      /justify-content:\s*center|column-width|column-count|auto-fill|auto-fit/,
      `${name} page should not center cards, auto-fit sparse rows, or use column balancing`
    );
    assert.match(
      css,
      new RegExp(`\\.${gridSelector}\\.masonry-grid\\s*\\{[^}]*position:\\s*relative;`),
      `${name} page should use the JS shortest-column masonry stage instead of row-span grid packing`
    );
    assert.doesNotMatch(
      cssRuleBody(css, `.${gridSelector}.masonry-grid`),
      /grid-auto-flow|grid-auto-rows|--masonry-row-size/,
      `${name} page should not use CSS row spans because they leave row-aligned gaps`
    );
    assert.match(
      css,
      new RegExp(`@media\\s*\\(min-width:\\s*501px\\)\\s*and\\s*\\(max-width:\\s*980px\\)\\s*\\{[\\s\\S]*?\\.${gridSelector}\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(3,\\s*minmax\\(0,\\s*1fr\\)\\);`),
      `${name} page should use three columns from 501px through 980px`
    );
    assert.doesNotMatch(
      css,
      new RegExp(`@media\\s*\\(min-width:\\s*981px\\)[\\s\\S]*?\\.${gridSelector}\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(3,`),
      `${name} page should not keep a three-column override above 980px`
    );
    assert.doesNotMatch(
      cssRuleBody(css, `.${cardSelector}`),
      /animation:/,
      `${name} cards should not flash or re-run entry animation while data refreshes`
    );
    assert.doesNotMatch(
      cssRuleBody(css, `.${cardSelector}`),
      /transition:[^;]*transform|transform:/,
      `${name} cards should not animate a hover float`
    );
    assert.doesNotMatch(
      cssRuleBody(css, `.${cardSelector}:hover`),
      /transform:/,
      `${name} card hover should not move the card`
    );
  }

  assert.match(botStoreJs, /bot-store-card-cover/);
  assert.match(botStoreJs, /bot-store-card-category/);
  assert.match(botStoreJs, /bot-store-card-foot/);
  assert.match(botStoreJs, /miaMasonryGrid\?\.capture\(els\.botStoreGrid,\s*pageTurnDirection\)/);
  assert.match(skillJs, /miaMasonryGrid\?\.capture\(els\.skillCardGrid,\s*pageTurnDirection\)/);
  assert.match(taskJs, /miaMasonryGrid\?\.capture\(els\.tasksContent,\s*pageTurnDirection\)/);
  assert.match(botStoreJs, /miaMasonryGrid\?\.layout\(grid,\s*"\.bot-store-card",\s*\{\s*animate:\s*pageTurnDirection\s*\}\)/);
  assert.match(skillJs, /miaMasonryGrid\?\.layout\(els\.skillCardGrid,\s*"\.skill-card",\s*\{\s*animate:\s*direction\s*\}\)/);
  assert.match(taskJs, /miaMasonryGrid\?\.layout\(els\.tasksContent,\s*"\.task-card",\s*\{\s*animate:\s*direction\s*\}\)/);
  assert.doesNotMatch(botStoreJs, /animation-delay/);
});

test("contacts detail narrow header keeps back control separate from the mode capsule", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(
    botStoreCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-active-view="contacts"\]\s+#contactsView\s*\{[^}]*position:\s*relative;/,
    "contacts detail should be the positioning context for its floating back control"
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\]\s+\.contacts-narrow-back\s*\{[^}]*position:\s*absolute;[^}]*top:\s*12px;[^}]*left:\s*14px;[^}]*background:\s*var\(--floating-control-bg\);/,
    "contacts back control should float independently instead of sharing the mode capsule"
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\]\s+\.discover-top-bar\s*\{[^}]*left:\s*calc\(var\(--rail-column-width\)\s*\+\s*66px\);/,
    "contacts mode capsule should leave room for the floating back control"
  );
  assert.match(
    botStoreCss,
    /\.app-shell\[data-active-view="contacts"\]\s+\.contacts-layout\s*\{[^}]*padding:\s*64px\s+14px\s+18px;/,
    "contacts detail should start close under the floating controls on narrow screens"
  );
  assert.match(
    baseCss,
    /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.app-shell\[data-active-view="contacts"\]\s+\.contact-profile-head\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*justify-items:\s*center;[^}]*text-align:\s*center;/,
    "contacts profile header should switch to a compact centered narrow layout"
  );
  assert.match(
    baseCss,
    /\.app-shell\[data-active-view="contacts"\]\s+\.contact-actions\s*\{[^}]*grid-column:\s*auto;[^}]*justify-content:\s*center;/,
    "contacts actions should not retain the medium-width two-column placement on narrow screens"
  );
});

test("skill and task category filters stay as stable individual chips", () => {
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  for (const [name, selector, css] of [
    ["skill", "skill-chip-row", skillCss],
    ["task", "task-chip-row", taskCss]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s*\\{[^}]*padding:\\s*0;[^}]*border-radius:\\s*0;[^}]*background:\\s*transparent;[^}]*box-shadow:\\s*none;[^}]*flex-wrap:\\s*wrap;`),
      `${name} filters should remain individual floating chips, not one clipped capsule`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\s*\\{[^}]*background:\\s*var\\(--floating-control-bg\\);[^}]*box-shadow:\\s*var\\(--floating-control-shadow\\);[^}]*font-weight:\\s*\\d+;`),
      `${name} inactive filters should each keep their own stable chip`
    );
  }
  for (const [name, selector, css] of [
    ["skill", "skill-chip-row", skillCss],
    ["task", "task-chip-row", taskCss]
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\s*\\{[^}]*font-weight:\\s*560;[^}]*font-variant-numeric:\\s*tabular-nums;[^}]*white-space:\\s*nowrap;`),
      `${name} category buttons should keep one width model so active state does not shift positions`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\.active\\s*\\{[^}]*font-weight:\\s*560;`),
      `${name} active category buttons should not change text weight`
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
