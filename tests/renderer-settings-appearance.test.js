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
      serif: "serif"
    },
    DEFAULT_ACCENT_COLOR: "#318ad3",
    DEFAULT_USER_BUBBLE_COLOR: "#eeffde",
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
    appearanceFontPreset: { value: "serif" },
    appearanceAccentColor: { value: "#318ad3" },
    appearanceAccentPreview: { style: {} },
    appearanceGlassOpacity: { value: "82" },
    appearanceGlassOpacityValue: { textContent: "" },
    appearanceUserBubbleColor: { value: "#eeffde" },
    appearanceUserBubblePreview: { style: {} },
    appearanceSelectionStyle: { value: "solid" },
    appearanceShowHoverBackground: settingsSwitch(true),
    appearanceShowDesktopNotifications: settingsSwitch(true),
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
  assert.equal(api.normalizeGlassOpacity(72.4), 72);
  assert.equal(api.normalizeGlassOpacity("91"), 91);
  assert.equal(api.normalizeGlassOpacity(40), 60);
  assert.equal(api.normalizeGlassOpacity(141), 100);
  assert.equal(api.normalizeGlassOpacity("bad"), 82);
});

test("applyAppearance writes card and soft choices to document state", () => {
  const { api, documentElement, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    fontPreset: "serif",
    accentColor: "#318ad3",
    userBubbleColor: "#eeffde",
    listStyle: "card",
    selectionStyle: "soft",
    glassOpacity: 91
  });

  assert.equal(documentElement.dataset.selectionStyle, "soft");
  assert.equal(styleValues.get("--list-active-text"), "#318ad3");
  assert.equal(styleValues.get("--rail-glass-bg"), "color-mix(in srgb, var(--surface-layer) 91%, transparent)");

  api.applyAppearance({ theme: "light", glassOpacity: 100 });

  assert.equal(styleValues.get("--rail-glass-bg"), "color-mix(in srgb, var(--surface-layer) 100%, transparent)");
});

test("appearance avatar toggles default off unless explicitly enabled", () => {
  const controls = appearanceControls();
  const { api, documentElement } = loadAppearanceModule({ els: controls });

  api.applyAppearance({});

  assert.equal(documentElement.dataset.showUserAvatar, "false");
  assert.equal(documentElement.dataset.showAssistantAvatar, "false");

  api.syncAppearanceControls({});

  assert.equal(controls.appearanceShowUserAvatar.getAttribute("aria-checked"), "false");
  assert.equal(controls.appearanceShowAssistantAvatar.getAttribute("aria-checked"), "false");

  api.applyAppearance({ showUserAvatar: true, showAssistantAvatar: true });

  assert.equal(documentElement.dataset.showUserAvatar, "true");
  assert.equal(documentElement.dataset.showAssistantAvatar, "true");
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

test("applyAppearance keeps bottom board overrides light-mode only", () => {
  const { api, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#aabbcc",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.equal(styleValues.get("--workspace-floor"), "#aabbcc");
  assert.equal(styleValues.get("--workspace-floor-image"), 'url("data:image/png;base64,abc123")');

  api.applyAppearance({
    theme: "dark",
    workspaceBackgroundColor: "#aabbcc",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.equal(styleValues.has("--workspace-floor"), false);
  assert.equal(styleValues.has("--workspace-floor-image"), false);
  assert.equal(styleValues.has("--floor-text"), false);
  assert.equal(styleValues.has("--floor-muted"), false);
  assert.equal(styleValues.has("--floor-faint"), false);
  assert.equal(styleValues.has("--floor-line"), false);
  assert.equal(styleValues.has("--floor-hover"), false);
});

test("applyAppearance derives readable floor text from the bottom board color", () => {
  const { api, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#4096f3"
  });

  assert.equal(styleValues.get("--floor-text"), "rgba(255, 255, 255, 0.96)");
  assert.equal(styleValues.get("--floor-muted"), "rgba(255, 255, 255, 0.80)");
  assert.equal(styleValues.get("--floor-faint"), "rgba(255, 255, 255, 0.66)");
  assert.equal(styleValues.get("--floor-line"), "rgba(255, 255, 255, 0.22)");
  assert.equal(styleValues.get("--floor-hover"), "rgba(255, 255, 255, 0.10)");

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#f8fafc"
  });

  assert.equal(styleValues.get("--floor-text"), "rgba(0, 0, 0, 0.88)");
  assert.equal(styleValues.get("--floor-muted"), "rgba(0, 0, 0, 0.64)");
  assert.equal(styleValues.get("--floor-faint"), "rgba(0, 0, 0, 0.48)");
  assert.equal(styleValues.get("--floor-line"), "rgba(0, 0, 0, 0.16)");
  assert.equal(styleValues.get("--floor-hover"), "rgba(0, 0, 0, 0.07)");
});

test("currentAppearanceDraft always saves the visible bottom board color", () => {
  const { api } = loadAppearanceModule({
    els: {
      appearanceTheme: { value: "light" },
      appearanceFontPreset: { value: "system" },
      appearanceAccentColor: { value: "#318ad3" },
      appearanceGlassOpacity: { value: "91" },
      appearanceUserBubbleColor: { value: "#eeffde" },
      appearanceSelectionStyle: { value: "solid" },
      appearanceShowHoverBackground: { getAttribute: () => "true" },
      appearanceShowDesktopNotifications: { getAttribute: () => "false" },
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
  assert.equal(api.currentAppearanceDraft().glassOpacity, 91);
  assert.equal(api.currentAppearanceDraft().showDesktopNotifications, false);
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
    { theme: "light", workspaceBackgroundColor: "#2ca1ff", workspaceBackgroundImage: "data:image/png;base64,abc123" },
    { theme: "dark", workspaceBackgroundColor: "", workspaceBackgroundImage: "" }
  );

  assert.equal(merged.theme, "dark");
  assert.equal(merged.workspaceBackgroundColor, "#2ca1ff");
  assert.equal(merged.workspaceBackgroundImage, "data:image/png;base64,abc123");
});

test("cloud appearance stale default bottom board does not overwrite local custom color", () => {
  const { api } = loadAppearanceModule();

  const merged = api.mergeCloudAppearance(
    { theme: "light", workspaceBackgroundColor: "#2ca1ff" },
    { theme: "light", workspaceBackgroundColor: "#f0f0f3", accentColor: "#112233" }
  );

  assert.equal(merged.accentColor, "#112233");
  assert.equal(merged.workspaceBackgroundColor, "#2ca1ff");
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
    listStyle: "card",
    selectionStyle: "soft"
  });

  assert.match(styleValues.get("--app-font"), /ui-serif/);
  assert.equal(styleValues.get("--accent"), "#318ad3");
  assert.equal(styleValues.get("--rail-glass-bg"), "color-mix(in srgb, var(--surface-layer) 82%, transparent)");
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
      fontPreset: "serif",
      accentColor: "#318ad3",
      userBubbleColor: "#eeffde",
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
  assert.match(cssSource, /\.font-choice-grid\s*\{[\s\S]*?justify-self:\s*end;[\s\S]*?width:\s*min\(180px,\s*100%\);/);
  assert.match(cssSource, /\.font-choice-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
});

test("desktop appearance settings no longer expose PingFang as a separate preset", () => {
  assert.doesNotMatch(appSource, /pingfang:/);
  assert.doesNotMatch(htmlSource, /data-font-preset="pingfang"/);
  assert.doesNotMatch(htmlSource, /<option value="pingfang">/);
  assert.doesNotMatch(cssSource, /\.font-choice\[data-font-preset="pingfang"\]/);
});

test("desktop appearance settings no longer expose the middle list style switch", () => {
  assert.doesNotMatch(htmlSource, /中栏列表/);
  assert.doesNotMatch(htmlSource, /appearanceListStyle/);
  assert.doesNotMatch(appSource, /appearanceListStyle/);
  assert.doesNotMatch(cssSource, /data-list-style="flush"/);
});

test("desktop avatar display switches are initially off", () => {
  assert.match(htmlSource, /id="appearanceShowUserAvatar"[^>]*aria-checked="false"/);
  assert.match(htmlSource, /id="appearanceShowAssistantAvatar"[^>]*aria-checked="false"/);
});

test("desktop notification switch is initially on", () => {
  assert.match(htmlSource, /id="appearanceShowDesktopNotifications"[^>]*aria-checked="true"/);
  assert.match(appSource, /appearanceShowDesktopNotifications:\s*document\.getElementById\("appearanceShowDesktopNotifications"\)/);
  assert.match(appSource, /appearanceShowDesktopNotifications\?\.addEventListener\("click"/);
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
  assert.match(htmlSource, /调整浅色模式下窗口底层工作区的底色，也可上传图片。/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundPresets"/);
  assert.match(htmlSource, /data-workspace-background-color="#f0f0f3"/);
  assert.match(htmlSource, /data-workspace-background-color="#2ca1ff"/);
  assert.match(htmlSource, /title="#2CA1FF"/);
  assert.match(htmlSource, /data-workspace-background-color="#0f766e"/);
  assert.match(htmlSource, /data-workspace-background-color="#1f2937"/);
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
  assert.match(cssSource, /\.workspace-background-controls \.accent-swatch\s*\{[\s\S]*border-radius:\s*8px;/);
  assert.match(cssSource, /\.workspace-background-controls \.accent-swatch span\s*\{[\s\S]*border-radius:\s*6px;/);
  assert.match(cssSource, /\.workspace-background-presets \.avatar-color-chip\s*\{[\s\S]*border-radius:\s*6px;/);
});

test("desktop appearance settings expose the shared glass opacity control", () => {
  assert.match(htmlSource, /<strong>玻璃不透明度<\/strong>/);
  assert.match(htmlSource, /id="appearanceGlassOpacity"[^>]*type="range"[^>]*min="60"[^>]*max="100"[^>]*value="82"/);
  assert.match(htmlSource, /id="appearanceGlassOpacityValue">82%/);
  assert.match(appSource, /appearanceGlassOpacity:\s*document\.getElementById\("appearanceGlassOpacity"\)/);
  assert.match(appSource, /appearanceGlassOpacityValue:\s*document\.getElementById\("appearanceGlassOpacityValue"\)/);
  assert.match(appSource, /appearanceGlassOpacity\?\.addEventListener\("input"/);
  assert.match(appSource, /appearanceGlassOpacity\?\.addEventListener\("change"/);
  assert.match(cssSource, /\.glass-opacity-control\s*\{[\s\S]*?grid-template-columns:\s*minmax\(120px,\s*1fr\)\s+44px;/);
  assert.match(cssSource, /\.glass-opacity-control input\[type="range"\]\s*\{[\s\S]*?accent-color:\s*var\(--accent\);/);
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
