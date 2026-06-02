const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

function loadAppearanceModule() {
  const source = fs.readFileSync(path.join(root, "src/renderer/settings/settings-appearance.js"), "utf8");
  const styleValues = new Map();
  const documentElement = {
    dataset: {},
    style: {
      setProperty(name, value) {
        styleValues.set(name, value);
      }
    }
  };
  const sandbox = {
    console,
    window: {
      clearTimeout() {},
      setTimeout() { return 1; },
      mia: null,
      miaSettingsAppearance: null
    },
    document: {
      documentElement,
      querySelectorAll() {
        return [];
      }
    }
  };
  vm.runInNewContext(source, sandbox, { filename: "settings-appearance.js" });
  const api = sandbox.window.miaSettingsAppearance;
  api.initSettingsAppearance({
    state: { runtime: {} },
    els: {},
    mia: null,
    fontPresets: {
      system: "system-ui",
      pingfang: "PingFang SC"
    },
    DEFAULT_ACCENT_COLOR: "#0162db",
    DEFAULT_USER_BUBBLE_COLOR: "#0162db",
    DEFAULT_LIST_STYLE: "flush",
    DEFAULT_SELECTION_STYLE: "solid"
  });
  return { api, documentElement, styleValues };
}

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

test("appearance normalizers preserve both list and selection choices", () => {
  const { api } = loadAppearanceModule();

  assert.equal(api.normalizeListStyle("card"), "card");
  assert.equal(api.normalizeListStyle("flush"), "flush");
  assert.equal(api.normalizeListStyle("invalid"), "flush");
  assert.equal(api.normalizeSelectionStyle("soft"), "soft");
  assert.equal(api.normalizeSelectionStyle("solid"), "solid");
  assert.equal(api.normalizeSelectionStyle("invalid"), "solid");
});

test("applyAppearance writes card and soft choices to document state", () => {
  const { api, documentElement, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    fontPreset: "pingfang",
    accentColor: "#0162db",
    userBubbleColor: "#0162db",
    listStyle: "card",
    selectionStyle: "soft"
  });

  assert.equal(documentElement.dataset.listStyle, "card");
  assert.equal(documentElement.dataset.selectionStyle, "soft");
  assert.equal(styleValues.get("--list-active-text"), "#0162db");
});

test("desktop appearance settings expose a serif font preset", () => {
  assert.match(appSource, /serif:\s*['"][^'"]*ui-serif/);
  assert.match(htmlSource, /data-font-preset="serif"[\s\S]*衬线/);
  assert.match(htmlSource, /<option value="serif">Serif<\/option>/);
  assert.match(cssSource, /\.font-choice\[data-font-preset="serif"\]/);
});

test("desktop appearance settings do not expose removed font presets", () => {
  assert.doesNotMatch(appSource, /"sf-pro":/);
  assert.doesNotMatch(appSource, /mono:\s*['"][^'"]*SF Mono/);
  assert.doesNotMatch(htmlSource, /data-font-preset="sf-pro"/);
  assert.doesNotMatch(htmlSource, /data-font-preset="mono"/);
  assert.doesNotMatch(htmlSource, /<option value="sf-pro">/);
  assert.doesNotMatch(htmlSource, /<option value="mono">/);
  assert.doesNotMatch(cssSource, /\.font-choice\[data-font-preset="sf-pro"\]/);
  assert.doesNotMatch(cssSource, /\.font-choice\[data-font-preset="mono"\]/);
});

test("hover background toggle does not erase controls that already have a fill", () => {
  assert.match(cssBlock(".session-trigger:hover"), /background:\s*var\(--field\);/);
  assert.match(cssBlock(".agent-permission-button:hover:not(:disabled)"), /background:\s*var\(--field\);/);
  assert.match(cssBlock(".settings-panel .secondary:hover:not(:disabled)"), /background:\s*rgb\(0 0 0 \/ 0\.055\);/);
});
