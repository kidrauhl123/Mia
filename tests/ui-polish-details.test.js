const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function sourceFiles(dir, extensions) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(abs, extensions));
      continue;
    }
    if (extensions.has(path.extname(entry.name))) {
      files.push(path.relative(root, abs));
    }
  }
  return files;
}

function cssSelectorAt(css, offset) {
  const open = css.lastIndexOf("{", offset);
  const close = css.lastIndexOf("}", offset);
  if (open === -1 || close > open) return "";
  const previousClose = css.lastIndexOf("}", open - 1);
  return css
    .slice(previousClose + 1, open)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cssBlock(css, selector) {
  const escaped = selector
    .split(",")
    .map((part) => part.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*,\\s*");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `${selector} block should exist`);
  return match[1];
}

function cssBlocks(css, selector) {
  const escaped = selector
    .split(",")
    .map((part) => part.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*,\\s*");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map((match) => match[1]);
}

function assertTabular(css, selector) {
  const blocks = cssBlocks(css, selector);
  assert.ok(blocks.length > 0, `${selector} block should exist`);
  assert.ok(
    blocks.some((block) => /font-variant-numeric:\s*tabular-nums;/.test(block)),
    `${selector} should use tabular numbers`
  );
}

function cssBlockMatching(css, selector, pattern) {
  const block = cssBlocks(css, selector).find((item) => pattern.test(item));
  assert.ok(block, `${selector} block matching ${pattern} should exist`);
  return block;
}

function htmlTag(html, id) {
  const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
  assert.ok(match, `${id} button should exist`);
  return match[0];
}

function htmlButtonBlock(html, id) {
  const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/button>`));
  assert.ok(match, `${id} button block should exist`);
  return match[0];
}

test("main desktop and web surfaces use crisp macOS text rendering", () => {
  const desktopCss = read("src/renderer/styles.css");
  const webCss = read("src/web/styles.css");

  assert.match(cssBlock(desktopCss, "body"), /-webkit-font-smoothing:\s*antialiased;/);
  assert.match(cssBlock(webCss, "html, body"), /-webkit-font-smoothing:\s*antialiased;/);
});

test("only message bubble links use the hand cursor", () => {
  const violations = [];
  const files = sourceFiles(path.join(root, "src"), new Set([".css", ".html", ".js"]));

  for (const file of files) {
    const text = read(file);
    for (const match of text.matchAll(/cursor\s*:\s*pointer\b/g)) {
      const selector = path.extname(file) === ".css" ? cssSelectorAt(text, match.index || 0) : "";
      if (selector === ".bubble a.message-link") continue;
      const line = text.slice(0, match.index || 0).split("\n").length;
      violations.push(`${file}:${line}${selector ? ` ${selector}` : ""}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("dynamic badges and unread counts use tabular numbers", () => {
  const desktopCss = read("src/renderer/styles.css");
  const desktopTasksCss = read("src/renderer/styles/tasks.css");
  const webCss = read("src/web/styles.css");

  for (const selector of [".rail-button em", ".rail-badge", ".sidebar-bottom-badge", ".persona-unread"]) {
    assertTabular(desktopCss, selector);
  }
  assertTabular(desktopTasksCss, ".task-mode-unread");

  for (const selector of [".rail-button em", ".persona-unread"]) {
    assertTabular(webCss, selector);
  }
});

test("press feedback uses the subtle 0.96 scale from the polish guide", () => {
  const desktopCss = read("src/renderer/styles.css");
  const desktopGroupsCss = read("src/renderer/styles/groups.css");
  const webCss = read("src/web/styles.css");

  assert.match(cssBlock(desktopCss, ".send-button:not(:disabled):active"), /transform:\s*scale\(0\.96\);/);
  assert.match(cssBlock(desktopGroupsCss, ".add-friend-icon-button:active:not(:disabled)"), /transform:\s*scale\(0\.96\);/);
  assert.match(cssBlock(webCss, ".send-button:active"), /transform:\s*scale\(0\.96\);/);
  assert.match(cssBlock(webCss, ".add-friend-icon-button:active:not(:disabled)"), /transform:\s*scale\(0\.96\);/);
});

test("compact icon buttons keep a 40px hit target without changing visual size", () => {
  const desktopCss = read("src/renderer/styles.css");
  const webCss = read("src/web/styles.css");

  for (const css of [desktopCss, webCss]) {
    const button = cssBlock(css, ".icon-button");
    const target = cssBlock(css, ".icon-button::before");
    assert.match(button, /position:\s*relative;/);
    assert.match(button, /width:\s*32px;/);
    assert.match(button, /height:\s*32px;/);
    assert.match(target, /content:\s*"";/);
    assert.match(target, /position:\s*absolute;/);
    assert.match(target, /inset:\s*-4px;/);
    assert.match(target, /border-radius:\s*14px;/);
  }
});

test("compact icon buttons expose and style selected/open states", () => {
  const desktopCss = read("src/renderer/styles.css");
  const webCss = read("src/web/styles.css");
  const desktopHtml = read("src/renderer/index.html");
  const webHtml = read("src/web/app/index.html");
  const desktopApp = read("src/renderer/app.js");
  const webApp = read("src/web/app.js");

  for (const css of [desktopCss, webCss]) {
    const openState = cssBlock(css, ".icon-button.active, .icon-button[aria-expanded=\"true\"], .icon-button[aria-pressed=\"true\"]");
    assert.match(openState, /background:\s*var\(--field\);/);
    assert.match(openState, /color:\s*var\(--text\);/);
    assert.match(openState, /box-shadow:\s*none;/);
    assert.doesNotMatch(openState, /accent|border/);
    assert.doesNotMatch(css, /plus-toggle/);
  }

  for (const [html, id, controls] of [
    [desktopHtml, "newPersona", "botCreateMenu"],
    [desktopHtml, "newContact", "contactCreateMenu"],
    [webHtml, "newConversation", "conversationCreateMenu"]
  ]) {
    const tag = htmlTag(html, id);
    const block = htmlButtonBlock(html, id);
    assert.doesNotMatch(tag, /\bplus-toggle-button\b/);
    assert.match(tag, /aria-haspopup="menu"/);
    assert.match(tag, /aria-expanded="false"/);
    assert.match(tag, new RegExp(`aria-controls="${controls}"`));
    assert.doesNotMatch(block, /data-lottie="plusToX"|plus-toggle-glyph/);
    assert.match(block, />＋<\/button>|<svg[\s\S]*M12 5v14M5 12h14/);
  }

  assert.match(desktopApp, /els\.newPersona\?\.setAttribute\("aria-expanded", state\.botMenuOpen \? "true" : "false"\);/);
  assert.match(desktopApp, /els\.newContact\?\.setAttribute\("aria-expanded", state\.contactMenuOpen \? "true" : "false"\);/);
  assert.match(webApp, /els\.newConversation\?\.setAttribute\("aria-expanded", state\.createMenuOpen \? "true" : "false"\);/);
  assert.doesNotMatch(desktopApp, /syncPlusToggleButton/);
  assert.doesNotMatch(webApp, /syncPlusToggleButton/);
});

test("sidebar bottom nav labels stay lighter than content headings", () => {
  const desktopCss = read("src/renderer/styles.css");
  const label = cssBlock(desktopCss, ".sidebar-bottom-label");

  assert.match(label, /font-weight:\s*430;/);
  assert.doesNotMatch(label, /font-weight:\s*(?:5[2-9]0|[6-9]\d{2});/);
});

test("message list conversation cards paint hover backgrounds while preserving selection", () => {
  const desktopCss = read("src/renderer/styles.css");
  const webCss = read("src/web/styles.css");

  assert.doesNotMatch(
    desktopCss,
    /(?:^|\n)\.persona:hover\s*(?:,|\{)/,
    "desktop sidebar personas should not receive the shared hover background"
  );
  assert.match(
    desktopCss,
    /(?:^|\n)\.message-card:hover:not\(\.active\)\s*\{[\s\S]*?background:\s*var\(--hover-background\);/,
    "desktop message cards should paint a hover background"
  );
  assert.match(cssBlock(desktopCss, ".persona.active"), /background:\s*var\(--list-active\);/);

  assert.doesNotMatch(
    webCss,
    /(?:^|\n)\.persona-row:hover\s*\{[\s\S]*?background:/,
    "web conversation rows should not paint a hover background"
  );
  assert.match(
    webCss,
    /(?:^|\n)\.persona-row\.active\s*\{[\s\S]*?background:\s*var\(--list-active\);/,
    "web conversation rows should keep their base selected background"
  );
});

test("sidebar header stays visually continuous with the message list", () => {
  const desktopCss = read("src/renderer/styles.css");

  assert.doesNotMatch(
    cssBlock(desktopCss, ".sidebar-tools"),
    /border-bottom:/,
    "desktop sidebar header should not draw a divider under 消息"
  );
});

test("sidebar bottom nav icon state changes animate contextually", () => {
  const desktopCss = read("src/renderer/styles.css");

  const sharedIconState = cssBlock(desktopCss, ".sidebar-bottom-icon-regular, .sidebar-bottom-icon-fill");
  const fillIdle = cssBlockMatching(desktopCss, ".sidebar-bottom-icon-fill", /opacity:\s*0;/);
  const activeRegular = cssBlockMatching(desktopCss, ".sidebar-bottom-nav-button.active .sidebar-bottom-icon-regular", /opacity:\s*0;/);
  const activeFill = cssBlockMatching(desktopCss, ".sidebar-bottom-nav-button.active .sidebar-bottom-icon-fill", /opacity:\s*1;/);

  assert.match(sharedIconState, /transition:\s*opacity 160ms[^;]*,\s*transform 160ms[^;]*,\s*filter 160ms[^;]*;/);
  assert.match(fillIdle, /opacity:\s*0;/);
  assert.match(fillIdle, /transform:\s*scale\(0\.25\);/);
  assert.match(fillIdle, /filter:\s*blur\(4px\);/);
  assert.doesNotMatch(fillIdle, /display:\s*none;/);
  assert.match(activeRegular, /opacity:\s*0;/);
  assert.match(activeRegular, /transform:\s*scale\(0\.25\);/);
  assert.match(activeRegular, /filter:\s*blur\(4px\);/);
  assert.doesNotMatch(activeRegular, /display:\s*none;/);
  assert.match(activeFill, /opacity:\s*1;/);
  assert.match(activeFill, /transform:\s*scale\(1\);/);
  assert.match(activeFill, /filter:\s*blur\(0px\);/);
  assert.doesNotMatch(activeFill, /display:\s*block;/);
});

test("menu surfaces keep concentric radius and shadow-led depth", () => {
  const desktopCss = read("src/renderer/styles.css");
  const webCss = read("src/web/styles.css");

  assert.match(cssBlock(desktopCss, ".composer-select-menu"), /padding:\s*6px;[\s\S]*border-radius:\s*14px;[\s\S]*box-shadow:\s*var\(--menu-shadow\);/);
  assert.match(cssBlock(desktopCss, ".composer-select-option"), /border-radius:\s*8px;/);
  assert.match(cssBlock(desktopCss, ".session-menu"), /padding:\s*8px;[\s\S]*border-radius:\s*14px;[\s\S]*box-shadow:\s*var\(--menu-shadow\);/);
  assert.match(cssBlock(desktopCss, ".session-row"), /border-radius:\s*9px;/);

  assert.match(cssBlock(webCss, ".session-menu"), /padding:\s*8px;[\s\S]*border-radius:\s*14px;[\s\S]*box-shadow:\s*var\(--shadow\);/);
  assert.match(cssBlock(webCss, ".session-row"), /border-radius:\s*9px;/);
});
