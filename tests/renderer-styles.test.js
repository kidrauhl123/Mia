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

function rendererCssFiles() {
  const files = [];
  const stack = [path.join(root, "src/renderer")];

  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        files.push(filePath);
      }
    }
  }

  return files.sort();
}

function rendererInlineStyleFiles() {
  const files = [];
  const stack = [path.join(root, "src/renderer")];
  const lottieAssetsDir = `${path.sep}assets${path.sep}lottie${path.sep}`;

  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (
        entry.isFile() &&
        !filePath.includes(lottieAssetsDir) &&
        (entry.name.endsWith(".js") || entry.name.endsWith(".html"))
      ) {
        files.push(filePath);
      }
    }
  }

  return files.sort();
}

function cssFontSizeToPx(value, inheritedPx) {
  const normalized = value.trim().toLowerCase();
  let match = normalized.match(/^([0-9]*\.?[0-9]+)px$/);
  if (match) return Number(match[1]);
  match = normalized.match(/^([0-9]*\.?[0-9]+)rem$/);
  if (match) return Number(match[1]) * 16;
  match = normalized.match(/^([0-9]*\.?[0-9]+)em$/);
  if (match) return Number(match[1]) * inheritedPx;
  return null;
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
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

  assert.match(chatCss, /\.message-time\s*\{[\s\S]*?color:\s*var\(--floor-faint\);/);
  assert.match(chatCss, /\.message-send-status\s*\{[\s\S]*?color:\s*var\(--floor-faint\);/);
  assert.match(chatCss, /\.trace\s*\{[\s\S]*?color:\s*var\(--floor-muted\);[\s\S]*?opacity:\s*1;/);
  assert.doesNotMatch(chatCss, /\.trace-row:hover\s*>\s*summary\s*\{[\s\S]*?background:/);
  assert.doesNotMatch(webCss, /\.trace-row:hover\s*>\s*summary\s*\{[\s\S]*?background:/);
  assert.doesNotMatch(baseCss, /data-hover-background/);
  assert.doesNotMatch(chatCss, /data-hover-background/);
  assert.match(chatCss, /\.trace-cmd\s*\{[\s\S]*?color:\s*var\(--floor-text\);/);
  assert.match(chatCss, /\.trace-arg\s*\{[\s\S]*?color:\s*var\(--floor-muted\);/);
  assert.match(chatCss, /\.trace-meta\s*\{[\s\S]*?color:\s*var\(--floor-faint\);/);
  assert.match(chatCss, /\.trace-body\s*\{[\s\S]*?border-left-color:\s*var\(--floor-line\);[\s\S]*?color:\s*var\(--floor-muted\);[\s\S]*?opacity:\s*1;/);
  assert.doesNotMatch(chatCss, /--text-dim/);
  assert.doesNotMatch(chatCss, /:root\[data-theme="dark"\]\s+\.message-time/);
});

test("user message skill chips remain readable on light user bubbles", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const userSkillChipRule = cssRuleBody(baseCss, ".message.user .message-skill-chip");

  assert.match(userSkillChipRule, /color:\s*var\(--user-bubble-text\);/);
  assert.doesNotMatch(userSkillChipRule, /color:\s*#fff\b/);
});

test("custom scrollbar overlay uses a narrow thumb", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  const overlayRule = cssRuleBody(baseCss, ".scrollbar-overlay");
  assert.match(overlayRule, /width:\s*6px;/);
  assert.match(overlayRule, /min-height:\s*28px;/);
  assert.match(baseCss, /\.scrollbar-overlay:hover,\s*\.scrollbar-overlay\.dragging\s*\{[\s\S]*?width:\s*8px;/);
});

test("new tail messages reveal like Telegram without ignoring reduced motion", () => {
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const webCss = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

  for (const css of [chatCss, webCss]) {
    const keyframesStart = css.indexOf("@keyframes messageTailEnter");
    assert.notEqual(keyframesStart, -1, "missing messageTailEnter keyframes");
    const keyframesEnd = css.indexOf(".message .avatar", keyframesStart);
    assert.ok(keyframesEnd > keyframesStart, "messageTailEnter keyframes should end before message avatar styles");
    const keyframesBody = css.slice(keyframesStart, keyframesEnd);

    assert.match(css, /\.message\.message-tail-enter\s*\{[\s\S]*?animation:\s*messageTailEnter\s*220ms/);
    assert.match(css, /\.message\.message-tail-enter\s*\{[\s\S]*?will-change:\s*transform,\s*opacity;/);
    assert.match(keyframesBody, /opacity:\s*0;[\s\S]*?translateY\(12px\) scale\(0\.985\)/);
    assert.match(keyframesBody, /opacity:\s*1;[\s\S]*?translateY\(0\) scale\(1\)/);
    assert.doesNotMatch(css, /--message-tail-enter-height/);
    assert.doesNotMatch(keyframesBody, /max-height:/);
    assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.message\.message-tail-enter\s*\{[\s\S]*?animation:\s*none/);
  }
});

test("deleted messages leave a ghost while remaining rows FLIP into place", () => {
  const chatCss = fs.readFileSync(path.join(root, "src/renderer/styles/chat.css"), "utf8");
  const ghostRule = cssRuleBody(chatCss, ".message.message-remove-ghost");

  assert.match(ghostRule, /animation:\s*messageRemoveGhost\s*180ms/);
  assert.match(ghostRule, /will-change:\s*transform,\s*opacity;/);
  assert.match(chatCss, /@keyframes messageRemoveGhost\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?translateY\(0\) scale\(1\)[\s\S]*?opacity:\s*0;[\s\S]*?translateY\(-6px\) scale\(0\.985\)/);
  assert.match(chatCss, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.message\.message-remove-ghost\s*\{[\s\S]*?animation:\s*none/);
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

test("assistant store detail sheet stays form-free on constrained viewports", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(css, /\.bot-store-sheet\s*\{[\s\S]*?max-height:\s*calc\(100vh - 56px\);[\s\S]*?overflow:\s*auto;/);
  assert.match(css, /\.bot-store-sheet-section\s*\{[^}]*display:\s*grid;[^}]*gap:\s*6px;/);
  assert.match(css, /\.bot-store-sheet\.is-enrolling\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.bot-store-enroll-console\s*\{[\s\S]*?display:\s*grid;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.bot-store-badge-stage\s*\{[\s\S]*?place-items:\s*center;/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.bot-store-sheet,\s*\.bot-store-sheet\.is-enrolling\s*\{[\s\S]*?max-height:\s*calc\(100vh - 28px\);/);
  assert.doesNotMatch(css, /\.bot-store-setup-fields/);
  assert.doesNotMatch(css, /\.bot-store-setup-field/);
  assert.doesNotMatch(css, /\.bot-store-badge-target-select/);
});

test("sidebar and chat headers use the same surface without a header divider", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

  assert.match(baseCss, /--surface-layer:\s*#f5f7f8;/);
  assert.match(
    baseCss,
    /\.sidebar\s*\{[^}]*background:\s*var\(--surface-layer\);/,
    "message middle pane should use the shared non-white layer surface"
  );
  const sidebarToolsRule = cssRuleBody(baseCss, ".sidebar-tools");
  assert.match(sidebarToolsRule, /background:\s*var\(--surface-layer\);/);
  assert.doesNotMatch(sidebarToolsRule, /border-bottom:/);
  assert.match(
    baseCss,
    /\.conversation-section,\s*\.contact-section\s*\{[^}]*border-top:\s*0;/,
    "sidebar body should not draw a second adjacent divider that can drift from the topbar line"
  );
  const conversationSidebarToolsRule = cssRuleBody(baseCss, ".conversation-sidebar .sidebar-tools");
  const conversationSidebarToolsWithFiltersRule = cssRuleBody(baseCss, ".conversation-sidebar .sidebar-tools.has-tag-filters");
  const contactsSidebarToolsRule = cssRuleBody(baseCss, ".contacts-sidebar .sidebar-tools");
  assert.match(
    conversationSidebarToolsRule,
    /-webkit-app-region:\s*drag;/,
    "conversation sidebar header should be a draggable window region"
  );
  assert.match(
    conversationSidebarToolsWithFiltersRule,
    /-webkit-app-region:\s*drag;/,
    "conversation folder header gaps should stay draggable even when folder tabs are visible"
  );
  assert.match(
    contactsSidebarToolsRule,
    /-webkit-app-region:\s*drag;/,
    "contacts sidebar header should match task-like top drag behavior"
  );
  assert.match(
    baseCss,
    /\.conversation-sidebar \.sidebar-tools button,\s*\.conversation-sidebar \.sidebar-tools input,\s*\.conversation-sidebar \.sidebar-tools \.search-box,\s*\.conversation-sidebar \.sidebar-tools \.create-menu,\s*\.conversation-sidebar \.sidebar-tools \.sidebar-tag-filters,[\s\S]*?\.contacts-sidebar \.sidebar-tools \.create-menu\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    "conversation sidebar header controls should remain clickable instead of dragging the window"
  );
  assert.match(
    baseCss,
    /\.contacts-sidebar \.sidebar-tools button,\s*\.contacts-sidebar \.sidebar-tools input,\s*\.contacts-sidebar \.sidebar-tools \.search-box,\s*\.contacts-sidebar \.sidebar-tools \.create-menu\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    "contacts sidebar header controls should remain clickable instead of dragging the window"
  );
});

test("conversation search uses a theme-aware field without focus highlight", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const conversationSearchRule = cssRuleBody(baseCss, ".conversation-sidebar .search-box");
  const darkConversationSearchRule = cssRuleBody(baseCss, ':root[data-theme="dark"] .conversation-sidebar .search-box');
  const searchFocusRule = cssRuleBody(baseCss, ".search-box:focus-within");

  assert.match(conversationSearchRule, /background:\s*#fff;/);
  assert.match(darkConversationSearchRule, /background:\s*#000;/);
  assert.match(conversationSearchRule, /grid-column:\s*1\s*\/\s*-1;/);
  assert.match(conversationSearchRule, /height:\s*32px;/);
  assert.match(searchFocusRule, /box-shadow:\s*none;/);
  assert.match(
    baseCss,
    /\.conversation-sidebar \.search-box:focus-within \.search-box-icon,[\s\S]*?\.conversation-sidebar \.sidebar-tools\.search-active \.search-box \.search-box-icon\s*\{[\s\S]*?left:\s*12px;[\s\S]*?transform:\s*translateX\(0\);/,
    "focused conversation search should move the icon from the centered prompt to the left edge"
  );
  assert.match(
    baseCss,
    /\.conversation-sidebar \.search-box:focus-within \.search-box-label,[\s\S]*?\.conversation-sidebar \.sidebar-tools\.search-active \.search-box \.search-box-label\s*\{[\s\S]*?left:\s*44px;[\s\S]*?transform:\s*translateY\(-50%\);/,
    "focused conversation search should animate the visual label from the centered prompt to the left"
  );
  assert.match(baseCss, /\.conversation-sidebar \.search-box\.has-query \.search-box-label\s*\{[\s\S]*?opacity:\s*0;/);
});

test("icon buttons use shared svg glyph sizing", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const socialSource = fs.readFileSync(path.join(root, "src/renderer/social/social.js"), "utf8");
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const iconButtonSvgRule = cssRuleBody(baseCss, ".icon-button svg");

  for (const id of [
    "newPersona",
    "newContact",
    "newSession",
    "groupInfoButton",
    "closeSkillPicker",
    "closeTaskPreview",
    "appearanceAccentReset",
    "appearanceWorkspaceBackgroundReset",
    "appearanceUserBubbleReset",
    "closeProfileDialog",
    "closeBotDialog",
    "closePetGenerateDialog",
    "cancelAvatarCrop",
    "groupCreateClose",
    "groupInfoClose",
    "closeTaskCreate"
  ]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[\\s\\S]*?<svg viewBox="0 0 24 24"`),
      `${id} should render an svg icon instead of a text glyph`
    );
  }

  assert.doesNotMatch(
    html,
    /<button[^>]*class="[^"]*\bicon-button\b[^"]*"[^>]*>\s*(?:＋|×|↺|ℹ︎)\s*<\/button>/,
    "icon-only buttons should not use font-rendered symbols"
  );
  assert.doesNotMatch(
    socialSource,
    /className\s*=\s*"icon-button"[\s\S]{0,300}?textContent\s*=\s*"(?:＋|×|↺|ℹ︎)"/,
    "dynamic icon-only buttons should not use font-rendered symbols"
  );
  assert.match(
    socialSource,
    /className\s*=\s*"icon-button"[\s\S]{0,300}?<svg viewBox="0 0 24 24"/,
    "dynamic icon-only buttons should render svg icons"
  );
  assert.match(iconButtonSvgRule, /width:\s*18px;/);
  assert.match(iconButtonSvgRule, /height:\s*18px;/);
  assert.match(iconButtonSvgRule, /stroke:\s*currentColor;/);
  assert.match(iconButtonSvgRule, /stroke-width:\s*1\.35;/);
  assert.match(iconButtonSvgRule, /stroke-linecap:\s*round;/);
  assert.match(iconButtonSvgRule, /stroke-linejoin:\s*round;/);
  assert.match(baseCss, /\.icon-button svg :where\(path,\s*circle,\s*line,\s*polyline,\s*rect\)\s*\{[\s\S]*?vector-effect:\s*non-scaling-stroke;[\s\S]*?stroke-width:\s*inherit;/);
  assert.match(
    baseCss,
    /\.sidebar-search-trigger svg,\s*\.conversation-sidebar #newPersona svg,\s*\.sidebar-search-close svg\s*\{[\s\S]*?width:\s*19px;[\s\S]*?height:\s*19px;/,
    "message sidebar header actions should share one optical icon size"
  );
});

test("conversation tag grouping uses Telegram-style text tabs with a moving underline", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const filtersRule = cssRuleBody(baseCss, ".sidebar-tag-filters", baseCss.indexOf("\n.sidebar-tag-filters {"));
  const stripRule = cssRuleBody(baseCss, ".sidebar-tag-filter-strip", baseCss.indexOf("\n.sidebar-tag-filter-strip {"));
  const trackRule = cssRuleBody(baseCss, ".sidebar-tag-filter-track", baseCss.indexOf("\n.sidebar-tag-filter-track {"));
  const tabRule = cssRuleBody(baseCss, ".sidebar-tag-filter", baseCss.indexOf("\n.sidebar-tag-filter {"));
  const activeRule = cssRuleBody(baseCss, ".sidebar-tag-filter.active", baseCss.indexOf("\n.sidebar-tag-filter.active {"));
  const indicatorRule = cssRuleBody(baseCss, ".sidebar-tag-filter-indicator");

  assert.match(baseCss, /--capsule-tab-font-size:\s*13px;/);
  assert.match(baseCss, /--capsule-tab-font-weight:\s*430;/);
  assert.match(baseCss, /--capsule-tab-active-font-weight:\s*430;/);
  assert.match(baseCss, /--ui-text-max-size:\s*14px;/);
  assert.match(baseCss, /--ui-text-max-weight:\s*500;/);
  assert.match(filtersRule, /height:\s*30px;/);
  assert.match(stripRule, /height:\s*30px;/);
  assert.match(stripRule, /position:\s*relative;/);
  assert.doesNotMatch(stripRule, /padding-right:/);
  assert.match(stripRule, /border-bottom:\s*1px solid var\(--line\);/);
  assert.match(stripRule, /overflow:\s*hidden;/);
  assert.match(stripRule, /-ms-overflow-style:\s*none;/);
  assert.match(stripRule, /scrollbar-width:\s*none !important;/);
  assert.match(stripRule, /scrollbar-color:\s*transparent transparent !important;/);
  assert.doesNotMatch(stripRule, /mask-image:/);
  assert.doesNotMatch(stripRule, /-webkit-mask-image:/);
  assert.match(baseCss, /\.sidebar-tag-filter-strip::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none !important;[\s\S]*?width:\s*0 !important;[\s\S]*?height:\s*0 !important;/);
  assert.match(baseCss, /\.sidebar-tag-filter-strip::-webkit-scrollbar-track,[\s\S]*?\.sidebar-tag-filter-strip::-webkit-scrollbar-thumb,[\s\S]*?\.sidebar-tag-filter-strip::-webkit-scrollbar-corner\s*\{[\s\S]*?display:\s*none !important;/);
  assert.match(trackRule, /display:\s*inline-flex;/);
  assert.match(trackRule, /gap:\s*22px;/);
  assert.match(trackRule, /width:\s*max-content;/);
  assert.match(trackRule, /min-width:\s*100%;/);
  assert.match(trackRule, /height:\s*30px;/);
  assert.match(trackRule, /transform:\s*translateX\(calc\(var\(--tag-scroll-x,\s*0px\) \* -1\)\);/);
  assert.match(trackRule, /transition:\s*transform 220ms cubic-bezier\(0\.2,\s*0\.7,\s*0\.2,\s*1\);/);
  assert.match(baseCss, /\.sidebar-tag-filter-strip\.reordering \.sidebar-tag-filter-track\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(tabRule, /height:\s*30px;/);
  assert.match(tabRule, /line-height:\s*30px;/);
  assert.match(tabRule, /font-size:\s*var\(--capsule-tab-font-size\);/);
  assert.match(tabRule, /font-weight:\s*var\(--capsule-tab-font-weight\);/);
  assert.match(tabRule, /border-radius:\s*0;/);
  assert.match(tabRule, /background:\s*transparent;/);
  assert.match(tabRule, /color:\s*var\(--muted\);/);
  assert.match(activeRule, /background:\s*transparent;/);
  assert.match(activeRule, /color:\s*var\(--text\);/);
  assert.match(activeRule, /font-weight:\s*var\(--capsule-tab-active-font-weight\);/);
  assert.match(indicatorRule, /width:\s*var\(--tag-indicator-width,\s*0px\);/);
  assert.match(indicatorRule, /height:\s*2\.5px;/);
  assert.match(indicatorRule, /bottom:\s*-1px;/);
  assert.match(indicatorRule, /z-index:\s*1;/);
  assert.match(indicatorRule, /transform:\s*translateX\(var\(--tag-indicator-x,\s*0px\)\);/);
  assert.match(indicatorRule, /transition:\s*transform 220ms/);
  assert.doesNotMatch(baseCss, /\.sidebar-tag-filter::after\s*\{/);
  assert.match(baseCss, /\.sidebar-tag-filter-strip\.reordering\s*\{[\s\S]*?cursor:\s*grabbing;[\s\S]*?user-select:\s*none;/);
  assert.match(baseCss, /\.sidebar-tag-filter\.dragging\s*\{[\s\S]*?opacity:\s*0\.82;/);
  assert.match(baseCss, /\.persona-list\.folder-page-forward\s*\{/);
  assert.match(baseCss, /\.persona-list\.folder-page-back\s*\{/);
  assert.match(baseCss, /@keyframes conversationFolderPageForward/);
  assert.match(baseCss, /@keyframes conversationFolderPageBack/);
});

test("message list cards sit close to the folder underline with slimmer chrome", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const stripRule = cssRuleBody(baseCss, ".sidebar-tag-filter-strip", baseCss.indexOf("\n.sidebar-tag-filter-strip {"));
  const listRule = cssRuleBody(baseCss, ".persona-list", baseCss.indexOf("\n.persona-list {"));
  const cardRule = cssRuleBody(baseCss, ".persona", baseCss.indexOf("\n.persona {"));

  assert.match(stripRule, /height:\s*30px;/);
  assert.match(stripRule, /border-bottom:\s*1px solid var\(--line\);/);
  assert.match(listRule, /gap:\s*4px;/);
  assert.match(listRule, /padding:\s*2px 0 6px;/);
  assert.match(cardRule, /grid-template-columns:\s*42px minmax\(0,\s*1fr\);/);
  assert.match(cardRule, /min-height:\s*62px;/);
  assert.match(cardRule, /padding:\s*5px 9px;/);
  assert.match(cardRule, /border-radius:\s*14px;/);
});

test("contact bot groups use compact collapsible headers", () => {
  const baseCss = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const headerRule = cssRuleBody(baseCss, ".contact-group-header");
  const rowRule = cssRuleBody(baseCss, ".contact-row", baseCss.indexOf("\n.contact-row {"));
  const mainRule = cssRuleBody(baseCss, ".contact-row-main", baseCss.indexOf("\n.contact-row-main {"));

  assert.match(headerRule, /display:\s*flex;/);
  assert.match(headerRule, /width:\s*calc\(100% - 28px\);/);
  assert.match(headerRule, /border:\s*0;/);
  assert.match(headerRule, /background:\s*transparent;/);
  assert.match(headerRule, /text-align:\s*left;/);
  assert.match(baseCss, /\.contact-group-toggle::after\s*\{[\s\S]*?content:\s*"⌄";[\s\S]*?margin-left:\s*auto;/);
  assert.match(baseCss, /\.contact-group-toggle\.collapsed::after\s*\{[\s\S]*?transform:\s*rotate\(-90deg\);/);
  assert.match(rowRule, /grid-template-columns:\s*32px minmax\(0,\s*1fr\) auto;/);
  assert.match(rowRule, /min-height:\s*48px;/);
  assert.match(rowRule, /padding:\s*6px 8px;/);
  assert.match(mainRule, /align-content:\s*center;/);
  assert.match(mainRule, /overflow:\s*hidden;/);
  assert.match(baseCss, /\.contact-row-main strong\s*\{[\s\S]*?line-height:\s*1\.24;/);
  assert.match(baseCss, /\.contact-row-main small\s*\{[\s\S]*?line-height:\s*1\.25;/);
});

test("renderer text styles stay within the message title ceiling", () => {
  const maxPx = 14;
  const maxWeight = 500;
  const allowedSizeVars = /^var\(--(?:ui-text-max-size|capsule-tab-font-size)(?:,\s*14px)?\)$/;
  const allowedWeightVars = /^var\(--(?:ui-text-max-weight|capsule-tab-font-weight|capsule-tab-active-font-weight)(?:,\s*500)?\)$/;

  for (const file of rendererCssFiles()) {
    const relativeFile = path.relative(root, file);
    const css = fs.readFileSync(file, "utf8");

    for (const match of css.matchAll(/font-size:\s*([^;{}]+);/g)) {
      const value = match[1].trim();
      const normalized = value.toLowerCase();
      if (normalized === "inherit" || normalized === "initial" || normalized === "unset" || normalized === "0") continue;
      if (normalized.startsWith("var(")) {
        assert.match(normalized, allowedSizeVars, `${relativeFile} uses an unchecked font-size variable: ${value}`);
        continue;
      }
      const px = cssFontSizeToPx(value, maxPx);
      assert.notEqual(px, null, `${relativeFile} uses an unchecked font-size expression: ${value}`);
      assert.ok(px <= maxPx, `${relativeFile} font-size ${value} exceeds ${maxPx}px`);
    }

    for (const match of css.matchAll(/font-weight:\s*([^;{}]+);/g)) {
      const value = match[1].trim();
      const normalized = value.toLowerCase();
      if (normalized === "inherit" || normalized === "initial" || normalized === "unset" || normalized === "normal") continue;
      if (normalized.startsWith("var(")) {
        assert.match(normalized, allowedWeightVars, `${relativeFile} uses an unchecked font-weight variable: ${value}`);
        continue;
      }
      const weight = Number(normalized);
      assert.ok(Number.isFinite(weight), `${relativeFile} uses an unchecked font-weight expression: ${value}`);
      assert.ok(weight <= maxWeight, `${relativeFile} font-weight ${value} exceeds ${maxWeight}`);
    }

    for (const match of css.matchAll(/(?:^|[{\s;])font:\s*([^;{}]+);/g)) {
      const value = match[1].trim();
      if (value.toLowerCase() === "inherit") continue;
      const parts = value.split(/\s+/);
      const explicitWeight = parts.find((part) => /^(?:[1-9]00|[1-9][0-9]{2}|bold|bolder)$/i.test(part));
      if (explicitWeight) {
        assert.doesNotMatch(explicitWeight.toLowerCase(), /^(?:bold|bolder)$/, `${relativeFile} font shorthand uses ${explicitWeight}`);
        assert.ok(Number(explicitWeight) <= maxWeight, `${relativeFile} font shorthand weight ${explicitWeight} exceeds ${maxWeight}`);
      }
      const sizeToken = parts.find((part) => /\d(?:px|rem|em)(?:\/|$)|^var\(/i.test(part));
      assert.ok(sizeToken, `${relativeFile} font shorthand is missing an auditable size: ${value}`);
      const sizeValue = sizeToken.split("/")[0].toLowerCase();
      if (sizeValue.startsWith("var(")) {
        assert.match(sizeValue, allowedSizeVars, `${relativeFile} font shorthand uses an unchecked size variable: ${sizeValue}`);
      } else {
        const px = cssFontSizeToPx(sizeValue, maxPx);
        assert.notEqual(px, null, `${relativeFile} font shorthand uses an unchecked size: ${sizeValue}`);
        assert.ok(px <= maxPx, `${relativeFile} font shorthand size ${sizeValue} exceeds ${maxPx}px`);
      }
    }
  }
});

test("renderer inline text styles stay within the message title ceiling", () => {
  const maxPx = 14;
  const maxWeight = 500;

  for (const file of rendererInlineStyleFiles()) {
    const relativeFile = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");

    for (const match of source.matchAll(/font-size\s*:\s*([0-9]*\.?[0-9]+(?:px|rem|em))/gi)) {
      const px = cssFontSizeToPx(match[1], maxPx);
      assert.notEqual(px, null, `${relativeFile} inline font-size is not auditable: ${match[1]}`);
      assert.ok(px <= maxPx, `${relativeFile} inline font-size ${match[1]} exceeds ${maxPx}px`);
    }

    for (const match of source.matchAll(/font-weight\s*:\s*(bold|bolder|[0-9]+)/gi)) {
      const value = match[1].toLowerCase();
      assert.doesNotMatch(value, /^(?:bold|bolder)$/, `${relativeFile} inline font-weight uses ${match[1]}`);
      assert.ok(Number(value) <= maxWeight, `${relativeFile} inline font-weight ${match[1]} exceeds ${maxWeight}`);
    }

    for (const match of source.matchAll(/fontSize\s*=\s*["'`]([0-9]*\.?[0-9]+(?:px|rem|em))["'`]/g)) {
      const px = cssFontSizeToPx(match[1], maxPx);
      assert.notEqual(px, null, `${relativeFile} style.fontSize is not auditable: ${match[1]}`);
      assert.ok(px <= maxPx, `${relativeFile} style.fontSize ${match[1]} exceeds ${maxPx}px`);
    }

    for (const match of source.matchAll(/fontWeight\s*=\s*["'`]?(bold|bolder|[0-9]+)/g)) {
      const value = match[1].toLowerCase();
      assert.doesNotMatch(value, /^(?:bold|bolder)$/, `${relativeFile} style.fontWeight uses ${match[1]}`);
      assert.ok(Number(value) <= maxWeight, `${relativeFile} style.fontWeight ${match[1]} exceeds ${maxWeight}`);
    }
  }
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
  assert.match(chatCss, /\.bubble code\.inline-code\s*\{[\s\S]*?cursor:\s*default;/);
  assert.match(chatCss, /\.message\.search-focus \.bubble\s*\{[\s\S]*?animation:\s*messageSearchFocus/);
  assert.match(chatCss, /@keyframes messageSearchFocus/);
  assert.match(baseCss, /\.persona-tag-chip\s*\{[\s\S]*?cursor:\s*default;/);
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
  const appUpdateNotesRule = cssRuleBody(baseCss, ".app-update-notes");
  assert.match(appUpdateNotesRule, /max-height:\s*112px;/);
  assert.match(appUpdateNotesRule, /overflow-y:\s*auto;/);
  assert.doesNotMatch(appUpdateNotesRule, /overflow:\s*hidden;/);
  assert.match(baseCss, /\.persona-tag-chip\s*\{[\s\S]*?border:\s*0;[\s\S]*?height:\s*16px;[\s\S]*?font-size:\s*11px;[\s\S]*?font-weight:\s*var\(--capsule-tab-font-weight\);/);
  assert.match(baseCss, /\.persona-tag-chip\s*\{[\s\S]*?border-radius:\s*5px;/);
  assert.match(baseCss, /\.persona-tag-chip\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--tag-color,\s*#64748b\) 14%,\s*transparent\);[\s\S]*?color:\s*var\(--tag-color,\s*#64748b\);/);
  assert.match(baseCss, /\.persona-tag-chip\.filtered\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--tag-color,\s*#64748b\) 28%,\s*transparent\);[\s\S]*?box-shadow:\s*none;/);
  assert.match(baseCss, /\.search-clear\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--faint\);/);
  assert.match(baseCss, /\.search-clear:hover\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--muted\);/);
  assert.match(baseCss, /\.persona\.search-result\s*\{[\s\S]*?grid-template-columns:\s*34px minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*50px;/);
  assert.match(baseCss, /\.persona\.search-result:hover:not\(\.active\)\s*\{[\s\S]*?background:\s*rgba\(var\(--accent-rgb\),\s*0\.08\);/);
  const identityBadgeChoiceHoverRule = cssRuleBody(baseCss, ".identity-badge-choices button:hover");
  assert.match(identityBadgeChoiceHoverRule, /background:\s*var\(--hover\);/);
  assert.match(identityBadgeChoiceHoverRule, /outline:\s*0;/);
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
  const settingsTitleRule = cssRuleBody(baseCss, ".settings-tabs-title", baseCss.indexOf("\n.settings-tabs-title {"));
  assert.match(settingsTitleRule, /font-size:\s*var\(--ui-text-max-size,\s*14px\);/, "settings title should stay within the message title ceiling");
  assert.match(settingsTitleRule, /font-weight:\s*500;/, "settings title should not use heavy display weight");
  const sidebarTitleRule = cssRuleBody(baseCss, ".sidebar-title");
  assert.match(sidebarTitleRule, /font-size:\s*var\(--ui-text-max-size\);/, "conversation sidebar title should define the renderer text ceiling");
  assert.match(sidebarTitleRule, /font-weight:\s*var\(--ui-text-max-weight\);/, "conversation sidebar title should define the renderer weight ceiling");
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
  assert.match(
    baseCss,
    /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\]\s+\.settings-tab\s*\{[\s\S]*?font-size:\s*var\(--capsule-tab-font-size\);[\s\S]*?font-weight:\s*var\(--capsule-tab-font-weight\);/,
    "settings bottom-nav capsule tabs should reuse the shared capsule label typography"
  );
  assert.match(
    baseCss,
    /\.app-shell\[data-nav-layout="sidebar-bottom"\]\[data-active-view="settings"\]\s+\.settings-tab\.active\s*\{[\s\S]*?font-weight:\s*var\(--capsule-tab-active-font-weight\);/,
    "settings bottom-nav active capsule tab should reuse the shared active weight"
  );
  assert.match(
    baseCss,
    /\.settings-sidebar-tabs \.settings-tab\s*\{[\s\S]*?color:\s*var\(--text\);[\s\S]*?font-size:\s*var\(--ui-text-max-size,\s*14px\);[\s\S]*?font-weight:\s*400;/,
    "settings sidebar inactive tabs should use normal text color instead of muted grey"
  );
  assert.match(
    baseCss,
    /\.settings-sidebar-tabs \.settings-tab\.active\s*\{[\s\S]*?color:\s*var\(--list-active-text\);[\s\S]*?font-weight:\s*400;/,
    "settings sidebar active tabs should keep active contrast after the inactive color override"
  );
  const narrowSettingsMatch = baseCss.match(/\.settings-layout\s*\{\s*grid-template-columns:\s*1fr;/);
  const narrowSettingsIndex = narrowSettingsMatch?.index ?? -1;
  assert.notEqual(narrowSettingsIndex, -1, "settings narrow-window media query should exist");
  const narrowSettingsTitleRule = cssRuleBody(baseCss, ".settings-tabs-title", narrowSettingsIndex);
  assert.match(narrowSettingsTitleRule, /display:\s*none;/, "settings compact title should be hidden so the tab capsule stays slim");
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
    /\[data-lottie\]:not\(\.setup-scan-lottie\):not\(\.name-with-badge-badge-lottie\):not\(\.tasks-empty-lottie\)\s+svg\s+path\[fill-opacity="0"\]\s*\{[^}]*stroke:\s*currentColor\s*!important;/,
    "only hollow Lottie outline paths should receive the theme stroke"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\):not\(\.name-with-badge-badge-lottie\):not\(\.tasks-empty-lottie\)\s+svg\s+path:not\(\[fill-opacity="0"\]\)\s*\{[^}]*stroke:\s*none\s*!important;/,
    "filled Lottie paths must clear inherited rail SVG strokes"
  );
  assert.match(
    baseCss,
    /\[data-lottie\]:not\(\.setup-scan-lottie\):not\(\.name-with-badge-badge-lottie\):not\(\.tasks-empty-lottie\)\s+svg\s+path\s*\{[^}]*fill:\s*currentColor\s*!important;/,
    "theme repainting should apply only to app icon Lotties"
  );
  assert.doesNotMatch(
    baseCss,
    /\.setup-scan-lottie\s+svg\s+path\s*\{[^}]*fill:\s*currentColor/,
    "startup scan animation should keep the source LottieFiles colors"
  );
  assert.doesNotMatch(
    baseCss,
    /\.tasks-empty-lottie\s+svg\s+path\s*\{[^}]*fill:\s*currentColor/,
    "task empty-state animation should keep the source TGS colors"
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
      new RegExp(`\\.${selector}\\s+button\\s*\\{[^}]*color:\\s*var\\(--muted\\);[^}]*font-size:\\s*var\\(--capsule-tab-font-size\\);[^}]*font-weight:\\s*var\\(--capsule-tab-font-weight\\);`),
      `${name} inactive toggle labels should use the floating card text palette`
    );
    assert.match(
      css,
      new RegExp(`\\.${selector}\\s+button\\.active\\s*\\{[^}]*background:\\s*transparent;[^}]*color:\\s*var\\(--segmented-control-active-text\\);[^}]*font-weight:\\s*var\\(--capsule-tab-active-font-weight\\);`),
      `${name} active labels should sit on the theme-colored capsule`
    );
  }

  assert.match(
    botStoreCss,
    /\.bot-store-layout\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*auto;[^}]*overflow-x:\s*hidden;/,
    "bot store layout should not let category contents create a page-level horizontal overflow"
  );
  assert.match(
    botStoreCss,
    /\.bot-store-cap\s*\{[^}]*width:\s*fit-content;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*inline-size:\s*fit-content;[^}]*min-inline-size:\s*0;[^}]*max-inline-size:\s*100%;[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/,
    "bot store category rail should use content width on wide screens, cap to the available viewport width, and scroll internally"
  );
  assert.match(
    botStoreCss,
    /\.bot-store-cap::before\s*\{[^}]*width:\s*var\(--pill-w,\s*0px\);[^}]*background:\s*rgb\(var\(--accent-rgb\) \/ 0\.14\);[^}]*box-shadow:\s*none;[^}]*transform:\s*translateX\(var\(--pill-x,\s*0px\)\);/,
    "bot store category selected pill should use a soft theme-tinted background"
  );
  assert.match(
    botStoreCss,
    /\.bot-store-cap button\s*\{[^}]*flex:\s*0 0 auto;[^}]*color:\s*var\(--muted\);[^}]*font-size:\s*var\(--capsule-tab-font-size\);[^}]*font-weight:\s*var\(--capsule-tab-font-weight\);/,
    "bot store category buttons should not compress when the rail scrolls"
  );
  assert.match(
    botStoreCss,
    /\.bot-store-cap button\.active\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--accent\);[^}]*font-weight:\s*var\(--capsule-tab-active-font-weight\);/,
    "bot store active category text should use the theme color"
  );
  assert.match(
    botStoreCss,
    /\.bot-store-cap::-webkit-scrollbar\s*\{[^}]*display:\s*none;/,
    "bot store category rail should hide the scrollbar while remaining scrollable"
  );
  assert.match(
    fs.readFileSync(path.join(root, "src/renderer/bot/bot-store.js"), "utf8"),
    /function scrollCategoryButtonIntoView\(button,\s*behavior = "smooth"\)[\s\S]*button\.scrollIntoView\(\{[\s\S]*inline:\s*"center"[\s\S]*\}\);[\s\S]*const pillX = Number\.isFinite\(a\.offsetLeft\)[\s\S]*const pillW = Number\.isFinite\(a\.offsetWidth\)/,
    "bot store category rail should center selected edge items and position the pill in scroll coordinates"
  );

  assert.match(botStoreCss, /\.discover-mode-toggle\s+button\s*\{[^}]*cursor:\s*default;/);
  assert.match(skillCss, /\.skill-mode-toggle\s+button\s*\{[^}]*cursor:\s*default;/);

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
    /\.app-shell\[data-active-view="contacts"\]\s+\.discover-top-bar,\s*\.app-shell\[data-active-view="bot-store"\]\s+\.discover-top-bar\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*height:\s*84px;[^}]*padding:\s*16px 0 0;[^}]*pointer-events:\s*auto;[^}]*-webkit-app-region:\s*drag;/,
    "discover topbar container should provide a real draggable top strip while preserving the visual offset"
  );
  assert.match(
    botStoreCss,
    /\.discover-mode-toggle\s*\{[^}]*pointer-events:\s*auto;[^}]*-webkit-app-region:\s*drag;/,
    "discover mode toggle gaps should also be draggable"
  );
  assert.match(
    botStoreCss,
    /\.discover-mode-toggle button\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    "discover mode toggle buttons should remain clickable instead of dragging the window"
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
  assert.match(botStoreJs, /bot-store-card-description/);
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

test("skill category filters reuse the discover segmented capsule", () => {
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");

  assert.match(
    skillCss,
    /\.skill-chip-row\s*\{[^}]*position:\s*relative;[^}]*display:\s*inline-flex;[^}]*flex-wrap:\s*nowrap;[^}]*width:\s*fit-content;[^}]*overflow-x:\s*auto;[^}]*border-radius:\s*999px;[^}]*background:\s*var\(--segmented-control-bg\);[^}]*box-shadow:\s*var\(--segmented-control-shadow\);/,
    "skill filters should use the same continuous capsule surface as discover categories"
  );
  assert.match(
    skillCss,
    /\.skill-chip-row::before\s*\{[^}]*width:\s*var\(--pill-w,\s*0px\);[^}]*background:\s*rgb\(var\(--accent-rgb\) \/ 0\.14\);[^}]*transform:\s*translateX\(var\(--pill-x,\s*0px\)\);/,
    "skill filters should move one selected capsule instead of replacing the row"
  );
  assert.match(
    skillCss,
    /\.skill-chip-row button\s*\{[^}]*flex:\s*0 0 auto;[^}]*background:\s*transparent;[^}]*color:\s*var\(--muted\);[^}]*font-size:\s*var\(--capsule-tab-font-size\);[^}]*font-weight:\s*var\(--capsule-tab-font-weight\);[^}]*font-variant-numeric:\s*tabular-nums;[^}]*white-space:\s*nowrap;/,
    "skill filter labels should keep stable sizing inside the capsule"
  );
  assert.match(
    skillCss,
    /\.skill-chip-row button\.active\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--accent\);[^}]*font-weight:\s*var\(--capsule-tab-active-font-weight\);/,
    "skill active filter text should sit on the moved capsule"
  );
});

test("task category filters stay as stable individual chips", () => {
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");

  assert.match(
    taskCss,
    /\.task-chip-row\s*\{[^}]*padding:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*flex-wrap:\s*wrap;/,
    "task filters should remain individual floating chips"
  );
  assert.match(
    taskCss,
    /\.task-chip-row button\s*\{[^}]*background:\s*var\(--floating-control-bg\);[^}]*box-shadow:\s*var\(--floating-control-shadow\);[^}]*font-size:\s*var\(--capsule-tab-font-size\);[^}]*font-weight:\s*var\(--capsule-tab-font-weight\);[^}]*font-variant-numeric:\s*tabular-nums;[^}]*white-space:\s*nowrap;/,
    "task category buttons should keep one width model so active state does not shift positions"
  );
  assert.match(
    taskCss,
    /\.task-chip-row button\.active\s*\{[^}]*font-weight:\s*var\(--capsule-tab-active-font-weight\);/,
    "task active category buttons should reuse the capsule active weight"
  );
});

test("floating capsule controls keep hover geometry stable", () => {
  const botStoreCss = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");
  const skillCss = fs.readFileSync(path.join(root, "src/renderer/styles/skills.css"), "utf8");
  const taskCss = fs.readFileSync(path.join(root, "src/renderer/styles/tasks.css"), "utf8");
  const controls = [
    ["discover topbar toggle", botStoreCss, ".discover-mode-toggle", ".discover-mode-toggle button:not(.active):hover"],
    ["bot store category rail", botStoreCss, ".bot-store-cap", ".bot-store-cap button:not(.active):hover"],
    ["skill topbar toggle", skillCss, ".skill-mode-toggle", ".skill-mode-toggle button:not(.active):hover"],
    ["skill category rail", skillCss, ".skill-chip-row", ".skill-chip-row button:hover"],
    ["task topbar toggle", taskCss, ".task-mode-toggle", ".task-mode-toggle button:not(.active):hover"],
    ["task history chips", taskCss, ".task-chip-row", ".task-chip-row button:hover"]
  ];

  for (const [name, css, selector, hoverSelector] of controls) {
    const buttonRule = cssRuleBody(css, `${selector} button`);
    assert.doesNotMatch(
      buttonRule,
      /transition:[^;]*(?:box-shadow|filter|transform|width|height|padding|margin)/,
      `${name} buttons should not animate geometry-affecting properties`
    );

    const hoverRule = cssRuleBody(css, hoverSelector);
    assert.doesNotMatch(
      hoverRule,
      /\b(?:font-weight|padding|margin|border(?:-width)?|width|height|min-width|min-height|transform|filter|box-shadow)\s*:/,
      `${name} hover should not change layout, hit area, or compositor geometry`
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

test("assistant store cards keep description and skill metadata compact", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(css, /\.bot-store-card-description\s*\{[^}]*-webkit-line-clamp:\s*3;/);
  assert.match(css, /\.bot-store-card-skills\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.bot-store-skill-chip\s*\{[^}]*border-radius:\s*999px;/);
  assert.match(css, /\.bot-store-sheet-section\s*\{[^}]*display:\s*grid;/);
  assert.doesNotMatch(css, /\.bot-store-template-meta/);
  assert.doesNotMatch(css, /\.bot-store-demo/);
});

test("assistant store does not expose setup form controls in the detail sheet", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(css, /\.bot-store-sheet-section\s*\{[^}]*display:\s*grid;/);
  assert.match(css, /\.bot-store-badge-card/);
  assert.match(css, /\.bot-store-badge-stamp/);
  assert.match(css, /@keyframes bot-store-badge-stamp-slam/);
  assert.doesNotMatch(css, /\.bot-store-setup-fields/);
  assert.doesNotMatch(css, /\.bot-store-setup-field/);
  assert.doesNotMatch(css, /\.bot-store-badge-target-select/);
});
