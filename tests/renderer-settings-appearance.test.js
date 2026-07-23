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

function themeSwitch() {
  return {
    classNames: new Set(),
    attributes: {},
    textContent: "",
    classList: {
      toggle(name, enabled) {
        if (enabled) this.owner.classNames.add(name);
        else this.owner.classNames.delete(name);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] || "";
    }
  };
}

function appearanceControls(overrides = {}) {
  return {
    appearanceTheme: { value: "light" },
    appearanceThemeToggle: null,
    appearanceThemeToggleText: null,
    appearanceFontPreset: { value: "system" },
    appearanceAccentColor: { value: "#318ad3" },
    appearanceAccentPreview: { style: {} },
    appearanceUserBubbleColor: { value: "#eeffde" },
    appearanceUserBubblePreview: { style: {} },
    appearanceSelectionStyle: { value: "solid" },
    appearanceShowDesktopNotifications: settingsSwitch(true),
    appearanceShowUserAvatar: settingsSwitch(true),
    appearanceShowAssistantAvatar: settingsSwitch(true),
    appearanceWorkspaceBackgroundColor: { value: "#f0f0f3" },
    appearanceWorkspaceBackgroundImage: { value: "" },
    appearanceWorkspaceBackgroundPreview: { style: {} },
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
  assert.equal(api.normalizeSelectionStyle("soft"), "solid");
  assert.equal(api.normalizeSelectionStyle("solid"), "solid");
  assert.equal(api.normalizeSelectionStyle("invalid"), "solid");
});

test("applyAppearance writes card and solid choices to document state", () => {
  const titleBarThemes = [];
  const { api, documentElement, styleValues } = loadAppearanceModule({
    windowOverrides: {
      mia: {
        window: {
          setTitleBarTheme(appearance) {
            titleBarThemes.push(appearance);
            return Promise.resolve();
          }
        }
      }
    }
  });

  api.applyAppearance({
    theme: "light",
    fontPreset: "serif",
    accentColor: "#318ad3",
    userBubbleColor: "#eeffde",
    listStyle: "card",
    selectionStyle: "soft"
  });

  assert.equal(documentElement.dataset.selectionStyle, "solid");
  assert.equal(styleValues.get("--list-active"), "#318ad3");
  assert.equal(styleValues.get("--list-active-text"), "#ffffff");
  assert.equal(styleValues.has("--rail-glass-bg"), false);
  assert.equal(JSON.stringify(titleBarThemes.at(-1)), JSON.stringify({ theme: "light" }));

  api.applyAppearance({ theme: "light" });

  assert.equal(styleValues.has("--rail-glass-bg"), false);
  assert.equal(JSON.stringify(titleBarThemes.at(-1)), JSON.stringify({ theme: "light" }));

  api.applyAppearance({ theme: "dark" });

  assert.equal(JSON.stringify(titleBarThemes.at(-1)), JSON.stringify({ theme: "dark" }));
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

test("applyAppearance writes bottom board color and clears image variables", () => {
  const { api, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#aabbcc",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.equal(styleValues.get("--workspace-floor"), "#aabbcc");
  assert.equal(styleValues.get("--workspace-floor-image"), "none");
});

test("applyAppearance can use the doodle bottom board presets", () => {
  const { api, styleValues } = loadAppearanceModule();
  const grayImage = 'url("file:///Users/jung/GitHub/UI%E8%B5%84%E6%BA%90/%E8%83%8C%E6%99%AF%E8%89%B2/%E6%B6%82%E9%B8%A6.png")';
  const greenImage = 'url("assets/green-doodle-wallpaper.png")';

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#f0f0f3",
    workspaceBackgroundImage: grayImage
  });

  assert.equal(api.normalizeWorkspaceBackgroundImage(grayImage), grayImage);
  assert.equal(styleValues.get("--workspace-floor"), "#f0f0f3");
  assert.equal(styleValues.get("--workspace-floor-image"), grayImage);

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#f0f0f3",
    workspaceBackgroundImage: greenImage
  });

  assert.equal(api.normalizeWorkspaceBackgroundImage(greenImage), greenImage);
  assert.equal(styleValues.get("--workspace-floor-image"), greenImage);
});

test("applyAppearance keeps bottom board overrides light-mode only", () => {
  const { api, styleValues } = loadAppearanceModule();

  api.applyAppearance({
    theme: "light",
    workspaceBackgroundColor: "#aabbcc",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.equal(styleValues.get("--workspace-floor"), "#aabbcc");
  assert.equal(styleValues.get("--workspace-floor-image"), "none");

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
      appearanceUserBubbleColor: { value: "#eeffde" },
      appearanceSelectionStyle: { value: "solid" },
      appearanceShowDesktopNotifications: { getAttribute: () => "false" },
      appearanceShowUserAvatar: { getAttribute: () => "true" },
      appearanceShowAssistantAvatar: { getAttribute: () => "true" },
      appearanceWorkspaceBackgroundColor: {
        value: "#f0f0f3",
        dataset: { custom: "false" }
      },
      appearanceWorkspaceBackgroundImage: {
        value: 'url("assets/green-doodle-wallpaper.png")'
      }
    }
  });

  assert.equal(api.currentAppearanceDraft().workspaceBackgroundColor, "#f0f0f3");
  assert.equal(api.currentAppearanceDraft().workspaceBackgroundImage, 'url("assets/green-doodle-wallpaper.png")');
  assert.equal(api.currentAppearanceDraft().selectionStyle, "solid");
  assert.equal(Object.hasOwn(api.currentAppearanceDraft(), "glassOpacity"), false);
  assert.equal(api.currentAppearanceDraft().showDesktopNotifications, false);
  assert.equal(Object.hasOwn(api.currentAppearanceDraft(), "showHoverBackground"), false);
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
  const image = 'url("assets/green-doodle-wallpaper.png")';

  const merged = api.mergeCloudAppearance(
    { theme: "light", workspaceBackgroundColor: "#2ca1ff", workspaceBackgroundImage: image },
    { theme: "dark", workspaceBackgroundColor: "", workspaceBackgroundImage: "" }
  );

  assert.equal(merged.theme, "dark");
  assert.equal(merged.workspaceBackgroundColor, "#2ca1ff");
  assert.equal(merged.workspaceBackgroundImage, image);
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

  assert.match(styleValues.get("--app-font"), /-apple-system/);
  assert.equal(styleValues.get("--accent"), "#318ad3");
  assert.equal(styleValues.has("--rail-glass-bg"), false);
  assert.equal(documentElement.dataset.selectionStyle, "solid");
});

test("appearance controls default missing font presets to system", () => {
  const buttons = [
    {
      dataset: { fontPreset: "system" },
      classList: { active: false, toggle(_name, active) { this.active = active; } },
      setAttribute(name, value) { if (name === "aria-checked") this.ariaChecked = value; }
    },
    {
      dataset: { fontPreset: "serif" },
      classList: { active: false, toggle(_name, active) { this.active = active; } },
      setAttribute(name, value) { if (name === "aria-checked") this.ariaChecked = value; }
    }
  ];
  const controls = appearanceControls({ appearanceFontPreset: { value: "" } });
  const { api } = loadAppearanceModule({
    els: controls,
    documentOverrides: {
      querySelectorAll(selector) {
        return selector === "[data-font-preset]" ? buttons : [];
      }
    }
  });

  api.syncAppearanceControls({});

  assert.equal(controls.appearanceFontPreset.value, "system");
  assert.equal(buttons[0].ariaChecked, "true");
  assert.equal(buttons[1].ariaChecked, "false");
  assert.equal(api.currentAppearanceDraft().fontPreset, "system");
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
      selectionStyle: "solid"
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

test("desktop appearance settings no longer expose the selection style switch", () => {
  assert.doesNotMatch(htmlSource, /appearanceSelectionStyle/);
  assert.doesNotMatch(htmlSource, /<option value="solid">/);
});

test("web appearance settings keep solid selection fixed without exposing a switch", () => {
  const webHtmlSource = fs.readFileSync(path.join(root, "src/web/app/index.html"), "utf8");
  const webAppSource = fs.readFileSync(path.join(root, "src/web/app.js"), "utf8");
  const webAppearanceSource = fs.readFileSync(path.join(root, "src/web/appearance.js"), "utf8");
  const webCssSource = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

  assert.doesNotMatch(webHtmlSource, /appearanceSelectionStyle/);
  assert.doesNotMatch(webHtmlSource, /<option value="solid">/);
  assert.doesNotMatch(webAppSource, /appearanceSelectionStyle/);
  assert.match(webAppearanceSource, /selectionStyle:\s*"solid"/);
  assert.match(webAppearanceSource, /dataset\.selectionStyle\s*=\s*"solid"/);
  assert.match(webCssSource, /data-selection-style="solid"/);
});

test("appearance settings no longer expose a global hover background switch", () => {
  const settingsSource = fs.readFileSync(path.join(root, "src/renderer/settings/settings-appearance.js"), "utf8");
  const webHtmlSource = fs.readFileSync(path.join(root, "src/web/app/index.html"), "utf8");
  const webAppSource = fs.readFileSync(path.join(root, "src/web/app.js"), "utf8");
  const webAppearanceSource = fs.readFileSync(path.join(root, "src/web/appearance.js"), "utf8");
  const webCssSource = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

  for (const source of [htmlSource, appSource, settingsSource, cssSource, webHtmlSource, webAppSource, webAppearanceSource, webCssSource]) {
    assert.doesNotMatch(source, /悬停底色|appearanceShowHoverBackground|appearanceHoverBackground|showHoverBackground|hoverBackground|data-hover-background/);
  }
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

test("desktop theme setting uses a single icon button instead of a capsule switch", () => {
  assert.match(htmlSource, /id="appearanceThemeToggle"[^>]*class="appearance-theme-toggle"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(htmlSource, /id="appearanceThemeToggle"[^>]*role="switch"/);
  assert.match(htmlSource, /class="[^"]*appearance-theme-toggle-sun/);
  assert.match(htmlSource, /class="[^"]*appearance-theme-toggle-moon/);
  assert.doesNotMatch(htmlSource, /appearance-theme-toggle-thumb/);
  assert.match(htmlSource, /id="appearanceTheme"[^>]*class="visually-hidden"[^>]*aria-hidden="true"[^>]*tabindex="-1"/);
  assert.match(appSource, /appearanceThemeToggle:\s*document\.getElementById\("appearanceThemeToggle"\)/);
  assert.match(appSource, /appearanceThemeToggleText:\s*document\.getElementById\("appearanceThemeToggleText"\)/);
  assert.match(appSource, /appearanceThemeToggle\?\.addEventListener\("click"/);
  assert.match(cssSource, /\.appearance-theme-toggle\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;/);
  assert.match(cssSource, /\.appearance-theme-toggle-sky\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;/);
  assert.match(cssSource, /\.appearance-theme-toggle-icon\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*1;/);
  assert.match(cssSource, /\.appearance-theme-toggle\.is-dark\s+\./);
});

test("theme switch mirrors the saved light and dark appearance state", () => {
  const toggle = themeSwitch();
  toggle.classList.owner = toggle;
  const label = { textContent: "" };
  const controls = appearanceControls({
    appearanceTheme: { value: "light" },
    appearanceThemeToggle: toggle,
    appearanceThemeToggleText: label
  });
  const { api } = loadAppearanceModule({ els: controls });

  api.syncAppearanceControls({ theme: "dark" });

  assert.equal(controls.appearanceTheme.value, "dark");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.classNames.has("is-dark"), true);
  assert.equal(label.textContent, "深色");

  api.syncAppearanceControls({ theme: "light" });

  assert.equal(controls.appearanceTheme.value, "light");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(toggle.classNames.has("is-dark"), false);
  assert.equal(label.textContent, "浅色");
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

test("desktop appearance settings expose bottom board color controls", () => {
  assert.match(htmlSource, /<strong>底板背景<\/strong>/);
  assert.match(htmlSource, /调整浅色模式下窗口底层工作区的底色。/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundPresets"/);
  assert.match(htmlSource, /data-workspace-background-color="#f0f0f3"/);
  assert.match(htmlSource, /data-workspace-background-color="#2ca1ff"/);
  assert.match(htmlSource, /title="#2CA1FF"/);
  assert.doesNotMatch(htmlSource, /data-workspace-background-color="#0f766e"/);
  assert.match(htmlSource, /data-workspace-background-color="#1f2937"/);
  assert.match(htmlSource, /data-workspace-background-image-preset="gray-doodle"/);
  assert.match(htmlSource, /data-workspace-background-image="url\(&quot;file:\/\/\/Users\/jung\/GitHub\/UI%E8%B5%84%E6%BA%90\/%E8%83%8C%E6%99%AF%E8%89%B2\/%E6%B6%82%E9%B8%A6\.png&quot;\)"/);
  assert.match(htmlSource, /data-workspace-background-image-preset="green-doodle"/);
  assert.match(htmlSource, /data-workspace-background-image="url\(&quot;assets\/green-doodle-wallpaper\.png&quot;\)"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundColor"[^>]*type="color"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundImage"[^>]*type="hidden"/);
  assert.match(htmlSource, /id="appearanceWorkspaceBackgroundReset"/);
  assert.doesNotMatch(htmlSource, /也可上传图片/);
  assert.doesNotMatch(htmlSource, /未选择图片/);
  assert.match(appSource, /appearanceWorkspaceBackgroundColor:\s*document\.getElementById\("appearanceWorkspaceBackgroundColor"\)/);
  assert.match(appSource, /appearanceWorkspaceBackgroundImage:\s*document\.getElementById\("appearanceWorkspaceBackgroundImage"\)/);
  assert.match(appSource, /appearanceWorkspaceBackgroundPresets:\s*document\.getElementById\("appearanceWorkspaceBackgroundPresets"\)/);
  assert.doesNotMatch(appSource, /readWorkspaceBackgroundImage/);
  assert.match(appSource, /appearanceWorkspaceBackgroundColor\?\.addEventListener\("change"/);
  assert.match(appSource, /closest\("\[data-workspace-background-color\],\s*\[data-workspace-background-image-preset\]"\)/);
  assert.match(appSource, /button\.dataset\.workspaceBackgroundImage/);
  assert.doesNotMatch(appSource, /applyCloudAppearance/);
  assert.match(appSource, /mergeCloudAppearance\?\.\(\s*state\.runtime\.appearance,\s*runtime\.appearance/);
  assert.match(appSource, /function clearWorkspaceBackgroundImageDraft\(\)/);
  assert.match(appSource, /function saveWorkspaceBackgroundColor\(\)\s*\{[\s\S]*?clearWorkspaceBackgroundImageDraft\(\);[\s\S]*?window\.miaSettingsAppearance\.scheduleAppearanceSave\(0\);/);
  assert.doesNotMatch(appSource, /appearanceWorkspaceBackgroundColor[^;\n]+dataset\.custom/);
  assert.match(cssSource, /\.workspace-background-presets \.avatar-color-chip\.is-selected\s*\{[\s\S]*border-color:\s*rgb\(var\(--accent-rgb\) \/ 0\.38\);[\s\S]*box-shadow:\s*0 0 0 2px rgb\(var\(--accent-rgb\) \/ 0\.10\);/);
  assert.match(cssSource, /\.workspace-background-controls \.accent-swatch\s*\{[\s\S]*border-radius:\s*8px;/);
  assert.match(cssSource, /\.workspace-background-controls \.accent-swatch span\s*\{[\s\S]*border-radius:\s*6px;/);
  assert.match(cssSource, /\.workspace-background-presets \.avatar-color-chip\s*\{[\s\S]*border-radius:\s*6px;/);
  assert.match(cssSource, /\.workspace-background-presets \.workspace-background-image-chip\s*\{[\s\S]*background-size:\s*cover;/);
});

test("desktop appearance settings do not expose glass opacity controls", () => {
  assert.doesNotMatch(htmlSource, /玻璃不透明度|appearanceGlassOpacity|glass-opacity-control/);
  assert.doesNotMatch(appSource, /appearanceGlassOpacity/);
  assert.doesNotMatch(cssSource, /\.glass-opacity-control/);
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

test("runtime refresh stays gated until renderer modules finish initialization", () => {
  const refreshGuard = appSource.indexOf("if (!rendererModulesReady) return state.runtime;");
  const modulesReady = appSource.indexOf("rendererModulesReady = true;");
  const firstRuntimeRefresh = appSource.indexOf("const runtime = await window.mia.runtimeStatus();");
  const firstFullRenderAfterInit = appSource.indexOf("\n  render();", modulesReady);

  assert.notEqual(refreshGuard, -1, "runtime refresh must be gated during renderer initialization");
  assert.notEqual(modulesReady, -1, "renderer initialization must publish a ready state");
  assert.ok(refreshGuard < firstRuntimeRefresh, "runtime refresh guard must run before runtimeStatus");
  assert.ok(modulesReady < firstFullRenderAfterInit, "renderer modules must be marked ready before the first full render");
});

test("hover background toggle does not erase controls that already have a fill", () => {
  assert.match(cssBlock(".session-trigger:hover"), /background:\s*var\(--field\);/);
  assert.match(cssBlock(".agent-permission-button:hover:not(:disabled)"), /background:\s*var\(--field\);/);
  assert.match(cssBlock(".settings-panel .secondary:hover:not(:disabled)"), /background:\s*rgb\(0 0 0 \/ 0\.055\);/);
});
