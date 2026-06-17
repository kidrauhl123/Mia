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
  const { windowOverrides = {}, documentOverrides = {}, ...initOverrides } = depsOverride;
  const source = fs.readFileSync(path.join(root, "src/renderer/settings/settings-appearance.js"), "utf8");
  const styleValues = new Map();
  const documentElement = {
    dataset: {},
    style: {
      setProperty(name, value) {
        styleValues.set(name, value);
      },
      removeProperty(name) {
        styleValues.delete(name);
      }
    }
  };
  const documentApi = {
    documentElement,
    querySelectorAll() {
      return [];
    },
    ...documentOverrides
  };
  const sandbox = {
    console,
    window: {
      clearTimeout() {},
      setTimeout() { return 1; },
      mia: null,
      miaSettingsAppearance: null,
      ...windowOverrides
    },
    document: documentApi
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
    ...initOverrides
  });
  return { api, documentElement, styleValues, sandbox };
}

function settingsSwitch(checked = true) {
  return {
    checked,
    classList: { toggle() {} },
    getAttribute(name) {
      return name === "aria-checked" ? (this.checked ? "true" : "false") : "";
    },
    setAttribute(name, value) {
      if (name === "aria-checked") this.checked = value !== "false";
    }
  };
}

function appearanceControls(overrides = {}) {
  return {
    appearanceTheme: { value: "light" },
    appearanceFontPreset: { value: "system" },
    appearanceAccentColor: { value: "#0162db" },
    appearanceAccentPreview: { style: {} },
    appearanceUserBubbleColor: { value: "#0162db" },
    appearanceUserBubblePreview: { style: {} },
    appearanceSelectionStyle: { value: "solid" },
    appearanceShowHoverBackground: settingsSwitch(true),
    appearanceShowUserAvatar: settingsSwitch(true),
    appearanceShowAssistantAvatar: settingsSwitch(true),
    appearanceWorkspaceBackgroundColor: { value: "#f0f0f3" },
    appearanceWorkspaceBackgroundPreview: { style: {} },
    appearanceWorkspaceBackgroundImage: { value: "" },
    appearanceWorkspaceBackgroundImageLabel: { textContent: "" },
    appearanceWorkspaceBackgroundImageClear: { disabled: true },
    appearanceSaveStatus: {
      textContent: "",
      dataset: {},
      classList: { toggle() {}, remove() {} }
    },
    ...overrides
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
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

test("applyAppearance writes bottom board color and image variables", () => {
  const { api, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#aabbcc",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.equal(styleValues.get("--workspace-floor"), "#aabbcc");
  assert.equal(styleValues.get("--workspace-floor-image"), 'url("data:image/png;base64,abc123")');
});

test("currentAppearanceDraft always saves the visible bottom board color", () => {
  const { api } = loadAppearanceModule({
    els: {
      appearanceTheme: { value: "light" },
      appearanceFontPreset: { value: "system" },
      appearanceAccentColor: { value: "#0162db" },
      appearanceUserBubbleColor: { value: "#0162db" },
      appearanceSelectionStyle: { value: "solid" },
      appearanceShowHoverBackground: { getAttribute: () => "true" },
      appearanceShowUserAvatar: { getAttribute: () => "true" },
      appearanceShowAssistantAvatar: { getAttribute: () => "true" },
      appearanceWorkspaceBackgroundColor: {
        value: "#f0f0f3",
        dataset: { custom: "false" }
      },
      appearanceWorkspaceBackgroundImage: { value: "" }
    }
  });

  assert.equal(api.currentAppearanceDraft().workspaceBackgroundColor, "#f0f0f3");
});

test("stale bottom board save response cannot roll back a newer color draft", async () => {
  const timers = new Map();
  let nextTimerId = 1;
  const runTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  let resolveFirstSave;
  let resolveSecondSave;
  const saveResponses = [
    new Promise((resolve) => { resolveFirstSave = resolve; }),
    new Promise((resolve) => { resolveSecondSave = resolve; })
  ];
  const savedDrafts = [];
  const controls = appearanceControls();

  const { api, styleValues } = loadAppearanceModule({
    state: { runtime: { appearance: { workspaceBackgroundColor: "#f0f0f3" } } },
    els: controls,
    windowOverrides: {
      setTimeout(fn, delay = 0) {
        const id = nextTimerId++;
        timers.set(id, { fn, delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      mia: {
        saveAppearance: async (appearance) => {
          savedDrafts.push(appearance);
          return saveResponses[savedDrafts.length - 1];
        }
      }
    }
  });

  controls.appearanceWorkspaceBackgroundColor.value = "#dbeafe";
  api.scheduleAppearanceSave(0);
  runTimers(0);
  assert.equal(savedDrafts[0].workspaceBackgroundColor, "#dbeafe");

  controls.appearanceWorkspaceBackgroundColor.value = "#dcfce7";
  api.scheduleAppearanceSave(0);
  resolveFirstSave({ appearance: { workspaceBackgroundColor: "#f0f0f3" } });
  await flushMicrotasks();

  assert.equal(controls.appearanceWorkspaceBackgroundColor.value, "#dcfce7");
  assert.equal(styleValues.get("--workspace-floor"), "#dcfce7");

  runTimers(0);
  assert.equal(savedDrafts[1].workspaceBackgroundColor, "#dcfce7");
  resolveSecondSave({ appearance: { workspaceBackgroundColor: "#dcfce7" } });
  await flushMicrotasks();

  assert.equal(controls.appearanceWorkspaceBackgroundColor.value, "#dcfce7");
  assert.equal(styleValues.get("--workspace-floor"), "#dcfce7");
});

test("cloud appearance empty bottom board values do not overwrite local bottom board choices", () => {
  const { api } = loadAppearanceModule();

  const merged = api.mergeCloudAppearance(
    { theme: "light", workspaceBackgroundColor: "#dbeafe", workspaceBackgroundImage: "data:image/png;base64,abc123" },
    { theme: "dark", workspaceBackgroundColor: "", workspaceBackgroundImage: "" }
  );

  assert.equal(merged.theme, "dark");
  assert.equal(merged.workspaceBackgroundColor, "#dbeafe");
  assert.equal(merged.workspaceBackgroundImage, "data:image/png;base64,abc123");
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

test("desktop appearance settings expose bottom board color and image controls", () => {
  assert.match(htmlSource, /<strong>底板背景<\/strong>/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundPresets"/);
  assert.match(htmlSource, /data-workspace-background-color="#f0f0f3"/);
  assert.match(htmlSource, /data-workspace-background-color="#dbeafe"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundColor"[^>]*type="color"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundImageFile"[^>]*type="file"[^>]*accept="image\/\*"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundImage"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundReset"/);
  assert.match(appSource, /appearanceWorkspaceBackgroundColor:\s*document\.getElementById\("appearanceWorkspaceBackgroundColor"\)/);
  assert.match(appSource, /appearanceWorkspaceBackgroundPresets:\s*document\.getElementById\("appearanceWorkspaceBackgroundPresets"\)/);
  assert.match(appSource, /appearanceWorkspaceBackgroundImageFile:\s*document\.getElementById\("appearanceWorkspaceBackgroundImageFile"\)/);
  assert.match(appSource, /appearanceWorkspaceBackgroundColor\?\.addEventListener\("change"/);
  assert.match(appSource, /closest\("\[data-workspace-background-color\]"\)/);
  assert.match(appSource, /mergeCloudAppearance\?\.\(\s*state\.runtime\?\.appearance/);
  assert.match(appSource, /mergeCloudAppearance\?\.\(\s*state\.runtime\.appearance,\s*runtime\.appearance/);
  assert.match(appSource, /function saveWorkspaceBackgroundColor\(\)\s*\{\s*window\.miaSettingsAppearance\.scheduleAppearanceSave\(0\);/);
  assert.doesNotMatch(appSource, /appearanceWorkspaceBackgroundColor[^;\n]+dataset\.custom/);
  assert.match(cssSource, /\.workspace-background-presets \.avatar-color-chip\.is-selected\s*\{[\s\S]*border-color:\s*rgb\(var\(--accent-rgb\) \/ 0\.38\);[\s\S]*box-shadow:\s*0 0 0 2px rgb\(var\(--accent-rgb\) \/ 0\.10\);/);
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
