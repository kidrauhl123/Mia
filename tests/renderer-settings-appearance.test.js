const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");

function loadAppearanceModule(depsOverride = {}) {
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
    DEFAULT_SELECTION_STYLE: "solid",
    ...depsOverride
  });
  return { api, documentElement, styleValues };
}

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

test("appearance normalizers keep the list style fixed to cards", () => {
  const { api } = loadAppearanceModule();

  assert.equal(api.normalizeListStyle("card"), "card");
  assert.equal(api.normalizeListStyle("flush"), "card");
  assert.equal(api.normalizeListStyle("invalid"), "card");
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

  assert.equal(documentElement.dataset.selectionStyle, "soft");
  assert.equal(styleValues.get("--list-active-text"), "#0162db");
});

test("applyAppearance keeps default tokens when appearance deps are missing", () => {
  const { api, documentElement, styleValues } = loadAppearanceModule({
    fontPresets: undefined,
    DEFAULT_ACCENT_COLOR: undefined,
    DEFAULT_USER_BUBBLE_COLOR: undefined,
    DEFAULT_SELECTION_STYLE: undefined
  });

  api.applyAppearance({
    theme: "light",
    fontPreset: "pingfang",
    listStyle: "card",
    selectionStyle: "soft"
  });

  assert.match(styleValues.get("--app-font"), /PingFang SC/);
  assert.equal(styleValues.get("--accent"), "#0162db");
  assert.equal(documentElement.dataset.selectionStyle, "soft");
});

test("syncAppearanceControls skips form controls when element deps are missing", () => {
  const { api } = loadAppearanceModule({
    els: undefined,
    fontPresets: undefined,
    DEFAULT_ACCENT_COLOR: undefined,
    DEFAULT_USER_BUBBLE_COLOR: undefined,
    DEFAULT_SELECTION_STYLE: undefined
  });

  assert.doesNotThrow(() => {
    api.syncAppearanceControls({
      fontPreset: "pingfang",
      accentColor: "#0162db",
      userBubbleColor: "#0162db",
      listStyle: "card",
      selectionStyle: "soft"
    });
  });
});

test("desktop appearance settings expose a serif font preset", () => {
  assert.match(appSource, /serif:\s*['"][^'"]*ui-serif/);
  assert.match(htmlSource, /data-font-preset="serif"[\s\S]*衬线/);
  assert.match(htmlSource, /<option value="serif">Serif<\/option>/);
  assert.match(cssSource, /\.font-choice\[data-font-preset="serif"\]/);
});

test("desktop appearance settings no longer expose the middle list style switch", () => {
  assert.doesNotMatch(htmlSource, /中栏列表/);
  assert.doesNotMatch(htmlSource, /appearanceListStyle/);
  assert.doesNotMatch(appSource, /appearanceListStyle/);
  assert.doesNotMatch(cssSource, /data-list-style="flush"/);
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

test("appearance settings initialize before startup modules that can render", () => {
  const appearanceInit = appSource.indexOf("window.miaSettingsAppearance.initSettingsAppearance");
  assert.notEqual(appearanceInit, -1, "missing appearance settings init");

  [
    "window.miaBotDialog.initBotDialog",
    "window.miaLoaders.initLoaders",
    "window.miaBotStore.initBotStore",
    "window.miaTasksPanel.initTasksPanel",
    "window.miaSocial.initSocialModule"
  ].forEach((moduleInit) => {
    const index = appSource.indexOf(moduleInit);
    assert.notEqual(index, -1, `missing ${moduleInit}`);
    assert.ok(appearanceInit < index, `appearance settings must initialize before ${moduleInit}`);
  });
});

test("hover background toggle does not erase controls that already have a fill", () => {
  assert.match(cssBlock(".session-trigger:hover"), /background:\s*var\(--field\);/);
  assert.match(cssBlock(".agent-permission-button:hover:not(:disabled)"), /background:\s*var\(--field\);/);
  assert.match(cssBlock(".settings-panel .secondary:hover:not(:disabled)"), /background:\s*rgb\(0 0 0 \/ 0\.055\);/);
});
