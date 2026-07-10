// Settings - Appearance tab module
// Extracted from app.js. Holds theme/font/color/switch logic and the
// appearance auto-save loop. Constants (fontPresets, DEFAULT_*) and small
// element refs come in via initSettingsAppearance().
(function () {
  "use strict";

  const FALLBACK_FONT_PRESETS = Object.freeze({
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    serif: 'ui-serif, "Iowan Old Style", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif'
  });
  const FALLBACK_ACCENT_COLOR = "#318ad3";
  const FALLBACK_USER_BUBBLE_COLOR = "#eeffde";
  const FALLBACK_SELECTION_STYLE = "solid";
  const FALLBACK_WORKSPACE_BACKGROUND_COLOR = "#f0f0f3";
  const FALLBACK_DARK_WORKSPACE_BACKGROUND_COLOR = "#171920";
  const GRAY_DOODLE_WORKSPACE_BACKGROUND_IMAGE = 'url("file:///Users/jung/GitHub/UI%E8%B5%84%E6%BA%90/%E8%83%8C%E6%99%AF%E8%89%B2/%E6%B6%82%E9%B8%A6.png")';
  const GREEN_DOODLE_WORKSPACE_BACKGROUND_IMAGE = 'url("assets/green-doodle-wallpaper.png")';

  let state, els, mia;
  let fontPresets, DEFAULT_ACCENT_COLOR, DEFAULT_USER_BUBBLE_COLOR, DEFAULT_SELECTION_STYLE;

  // Module-local timers, formerly top-of-app.js lets 22-24.
  let appearanceSaveStatusTimer = 0;
  let appearanceAutoSaveTimer = 0;
  let appearanceAutoSaveSeq = 0;

  function initSettingsAppearance(deps = {}) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    fontPresets = deps.fontPresets;
    DEFAULT_ACCENT_COLOR = deps.DEFAULT_ACCENT_COLOR;
    DEFAULT_USER_BUBBLE_COLOR = deps.DEFAULT_USER_BUBBLE_COLOR;
    DEFAULT_SELECTION_STYLE = deps.DEFAULT_SELECTION_STYLE;
  }

  function configuredFontPresets() {
    return fontPresets && typeof fontPresets === "object" ? fontPresets : FALLBACK_FONT_PRESETS;
  }

  function defaultAccentColor() {
    return DEFAULT_ACCENT_COLOR || FALLBACK_ACCENT_COLOR;
  }

  function defaultUserBubbleColor() {
    return DEFAULT_USER_BUBBLE_COLOR || FALLBACK_USER_BUBBLE_COLOR;
  }

  function defaultWorkspaceBackgroundColor(theme = "light") {
    return theme === "dark" ? FALLBACK_DARK_WORKSPACE_BACKGROUND_COLOR : FALLBACK_WORKSPACE_BACKGROUND_COLOR;
  }

  function defaultSelectionStyle() {
    return DEFAULT_SELECTION_STYLE === "solid" ? "solid" : FALLBACK_SELECTION_STYLE;
  }

  function showAppearanceSaveStatus(text, kind = "ok") {
    const controls = els || {};
    if (!controls.appearanceSaveStatus) return;
    if (appearanceSaveStatusTimer) window.clearTimeout(appearanceSaveStatusTimer);
    controls.appearanceSaveStatus.textContent = text;
    controls.appearanceSaveStatus.dataset.kind = kind;
    controls.appearanceSaveStatus.classList.toggle("visible", Boolean(text));
    if (!text) return;
    appearanceSaveStatusTimer = window.setTimeout(() => {
      controls.appearanceSaveStatus.textContent = "";
      controls.appearanceSaveStatus.classList.remove("visible");
      delete controls.appearanceSaveStatus.dataset.kind;
      appearanceSaveStatusTimer = 0;
    }, kind === "error" ? 3600 : 1800);
  }

  function normalizeHexColor(value, fallback = defaultAccentColor()) {
    const raw = String(value || "").trim();
    const expanded = raw.replace(/^#([0-9a-fA-F]{3})$/, (_, hex) => `#${hex.split("").map((part) => part + part).join("")}`);
    return /^#[0-9a-fA-F]{6}$/.test(expanded) ? expanded.toLowerCase() : fallback;
  }

  function normalizeWorkspaceBackgroundImage(value) {
    const raw = String(value || "").trim();
    if (raw === GRAY_DOODLE_WORKSPACE_BACKGROUND_IMAGE || raw === GREEN_DOODLE_WORKSPACE_BACKGROUND_IMAGE) return raw;
    return "";
  }

  function normalizeListStyle(value) {
    return "card";
  }

  function normalizeSelectionStyle(value) {
    return value === "solid" ? "solid" : defaultSelectionStyle();
  }

  function hexToRgb(value) {
    const hex = normalizeHexColor(value).slice(1);
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }

  function relativeLuminance(rgb) {
    const channel = (value) => {
      const next = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
      return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function selectionTextColors(rgb) {
    const lightBackground = relativeLuminance(rgb) > 0.56;
    return lightBackground
      ? {
          text: "rgba(0, 0, 0, 0.90)",
          muted: "rgba(0, 0, 0, 0.66)",
          faint: "rgba(0, 0, 0, 0.48)"
        }
      : {
          text: "#ffffff",
          muted: "rgba(255, 255, 255, 0.78)",
          faint: "rgba(255, 255, 255, 0.62)"
        };
  }

  function isDefaultWorkspaceBackgroundColor(value, theme = "light") {
    const color = normalizeHexColor(value, "");
    if (!color) return false;
    return color === defaultWorkspaceBackgroundColor(theme === "dark" ? "dark" : "light");
  }

  function floorTextColors(rgb) {
    const lightBackground = relativeLuminance(rgb) > 0.50;
    return lightBackground
      ? {
          text: "rgba(0, 0, 0, 0.88)",
          muted: "rgba(0, 0, 0, 0.64)",
          faint: "rgba(0, 0, 0, 0.48)",
          line: "rgba(0, 0, 0, 0.16)",
          hover: "rgba(0, 0, 0, 0.07)"
        }
      : {
          text: "rgba(255, 255, 255, 0.96)",
          muted: "rgba(255, 255, 255, 0.80)",
          faint: "rgba(255, 255, 255, 0.66)",
          line: "rgba(255, 255, 255, 0.22)",
          hover: "rgba(255, 255, 255, 0.10)"
        };
  }

  function fontStackForAppearance(appearance = {}) {
    const presets = configuredFontPresets();
    return presets[appearance.fontPreset || "system"] || presets.system || presets.serif;
  }

  function avatarToggleEnabled(value) {
    return value === true;
  }

  function applyAppearance(appearance = {}) {
    const theme = appearance.theme === "dark" ? "dark" : "light";
    const accentColor = normalizeHexColor(appearance.accentColor);
    const rgb = hexToRgb(accentColor);
    const userBubbleColor = normalizeHexColor(appearance.userBubbleColor, defaultUserBubbleColor());
    const userBubbleRgb = hexToRgb(userBubbleColor);
    const userBubbleText = selectionTextColors(userBubbleRgb).text;
    const selectionStyle = normalizeSelectionStyle(appearance.selectionStyle);
    const workspaceBackgroundColor = normalizeHexColor(appearance.workspaceBackgroundColor, "");
    const workspaceBackgroundImage = normalizeWorkspaceBackgroundImage(appearance.workspaceBackgroundImage);
    const resolvedWorkspaceBackgroundColor = workspaceBackgroundColor || defaultWorkspaceBackgroundColor("light");
    const floorColors = floorTextColors(hexToRgb(resolvedWorkspaceBackgroundColor));
    const softActive = `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${theme === "dark" ? "0.22" : "0.16"})`;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.selectionStyle = selectionStyle;
    document.documentElement.dataset.showUserAvatar = avatarToggleEnabled(appearance.showUserAvatar) ? "true" : "false";
    document.documentElement.dataset.showAssistantAvatar = avatarToggleEnabled(appearance.showAssistantAvatar) ? "true" : "false";
    document.documentElement.style.setProperty("--app-font", fontStackForAppearance(appearance));
    document.documentElement.style.setProperty("--accent", accentColor);
    document.documentElement.style.setProperty("--accent-rgb", `${rgb.r} ${rgb.g} ${rgb.b}`);
    document.documentElement.style.setProperty("--active", softActive);
    document.documentElement.style.removeProperty?.("--rail-glass-bg");
    document.documentElement.style.setProperty("--user-bubble", userBubbleColor);
    document.documentElement.style.setProperty("--user-bubble-text", userBubbleText);
    if (theme === "light") {
      document.documentElement.style.setProperty("--floor-text", floorColors.text);
      document.documentElement.style.setProperty("--floor-muted", floorColors.muted);
      document.documentElement.style.setProperty("--floor-faint", floorColors.faint);
      document.documentElement.style.setProperty("--floor-line", floorColors.line);
      document.documentElement.style.setProperty("--floor-hover", floorColors.hover);
      if (workspaceBackgroundColor) {
        document.documentElement.style.setProperty("--workspace-floor", workspaceBackgroundColor);
      } else {
        document.documentElement.style.removeProperty?.("--workspace-floor");
      }
      document.documentElement.style.setProperty(
        "--workspace-floor-image",
        workspaceBackgroundImage || "none"
      );
    } else {
      document.documentElement.style.removeProperty?.("--floor-text");
      document.documentElement.style.removeProperty?.("--floor-muted");
      document.documentElement.style.removeProperty?.("--floor-faint");
      document.documentElement.style.removeProperty?.("--floor-line");
      document.documentElement.style.removeProperty?.("--floor-hover");
      document.documentElement.style.removeProperty?.("--workspace-floor");
      document.documentElement.style.removeProperty?.("--workspace-floor-image");
    }
    const textColors = selectionTextColors(rgb);
    document.documentElement.style.setProperty("--list-active", accentColor);
    document.documentElement.style.setProperty("--list-active-text", textColors.text);
    document.documentElement.style.setProperty("--list-active-muted", textColors.muted);
    document.documentElement.style.setProperty("--list-active-faint", textColors.faint);
    try {
      (mia || window.mia)?.window?.setTitleBarTheme?.({
        theme
      })?.catch?.(() => {});
    } catch {
      // Window titlebar theming is optional in browser mocks and non-Windows shells.
    }
  }

  function currentAppearanceDraft() {
    const controls = els || {};
    const theme = controls.appearanceTheme?.value || "light";
    const workspaceBackgroundColor = normalizeHexColor(
      controls.appearanceWorkspaceBackgroundColor?.value,
      defaultWorkspaceBackgroundColor("light")
    );
    return {
      theme,
      fontPreset: controls.appearanceFontPreset?.value || "system",
      accentColor: normalizeHexColor(controls.appearanceAccentColor?.value),
      userBubbleColor: normalizeHexColor(controls.appearanceUserBubbleColor?.value, defaultUserBubbleColor()),
      showUserAvatar: controls.appearanceShowUserAvatar?.getAttribute("aria-checked") === "true",
      showAssistantAvatar: controls.appearanceShowAssistantAvatar?.getAttribute("aria-checked") === "true",
      showDesktopNotifications: controls.appearanceShowDesktopNotifications?.getAttribute("aria-checked") !== "false",
      listStyle: "card",
      selectionStyle: defaultSelectionStyle(),
      workspaceBackgroundColor,
      workspaceBackgroundImage: normalizeWorkspaceBackgroundImage(controls.appearanceWorkspaceBackgroundImage?.value)
    };
  }

  function mergeCloudAppearance(current = {}, incoming = {}) {
    const base = current && typeof current === "object" ? current : {};
    const patch = incoming && typeof incoming === "object" ? incoming : {};
    const next = { ...base, ...patch };
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    if (has("workspaceBackgroundColor")) {
      const incomingColor = normalizeHexColor(patch.workspaceBackgroundColor, "");
      const currentColor = normalizeHexColor(base.workspaceBackgroundColor, "");
      const incomingTheme = patch.theme === "dark" ? "dark" : (base.theme === "dark" ? "dark" : "light");
      const currentTheme = base.theme === "dark" ? "dark" : "light";
      const incomingIsDefault = isDefaultWorkspaceBackgroundColor(incomingColor, incomingTheme);
      const currentIsCustom = currentColor && !isDefaultWorkspaceBackgroundColor(currentColor, currentTheme);
      next.workspaceBackgroundColor = (!incomingColor || (incomingIsDefault && currentIsCustom))
        ? currentColor || ""
        : incomingColor;
    }
    if (has("workspaceBackgroundImage") || base.workspaceBackgroundImage) {
      const incomingImage = normalizeWorkspaceBackgroundImage(patch.workspaceBackgroundImage);
      const currentImage = normalizeWorkspaceBackgroundImage(base.workspaceBackgroundImage);
      next.workspaceBackgroundImage = incomingImage || currentImage || "";
    }
    return next;
  }

  function setSettingsSwitch(button, enabled) {
    if (!button) return;
    button.classList.toggle("active", Boolean(enabled));
    button.setAttribute("aria-checked", enabled ? "true" : "false");
  }

  function toggleSettingsSwitch(button) {
    const next = button?.getAttribute("aria-checked") !== "true";
    setSettingsSwitch(button, next);
    scheduleAppearanceSave(0);
  }

  function syncThemeControl(theme) {
    const controls = els || {};
    const nextTheme = theme === "dark" ? "dark" : "light";
    if (controls.appearanceTheme) controls.appearanceTheme.value = nextTheme;
    const toggle = controls.appearanceThemeToggle;
    if (!toggle) return;
    const isDark = nextTheme === "dark";
    toggle.classList.toggle("is-dark", isDark);
    toggle.setAttribute("aria-pressed", isDark ? "true" : "false");
    toggle.setAttribute("aria-label", isDark ? "切换浅色模式" : "切换深色模式");
    if (controls.appearanceThemeToggleText) {
      controls.appearanceThemeToggleText.textContent = isDark ? "深色" : "浅色";
    }
  }

  function syncAppearanceControls(appearance = currentAppearanceDraft()) {
    const controls = els || {};
    syncThemeControl(appearance.theme);
    const presets = configuredFontPresets();
    const fontPreset = presets[appearance.fontPreset] ? appearance.fontPreset : "system";
    if (controls.appearanceFontPreset) controls.appearanceFontPreset.value = fontPreset;
    document.querySelectorAll("[data-font-preset]").forEach((button) => {
      const active = button.dataset.fontPreset === fontPreset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    const accentColor = normalizeHexColor(appearance.accentColor);
    if (controls.appearanceAccentColor) controls.appearanceAccentColor.value = accentColor;
    if (controls.appearanceAccentPreview) controls.appearanceAccentPreview.style.backgroundColor = accentColor;
    const userBubbleColor = normalizeHexColor(appearance.userBubbleColor, defaultUserBubbleColor());
    if (controls.appearanceUserBubbleColor) controls.appearanceUserBubbleColor.value = userBubbleColor;
    if (controls.appearanceUserBubblePreview) controls.appearanceUserBubblePreview.style.backgroundColor = userBubbleColor;
    const workspaceBackgroundDefault = defaultWorkspaceBackgroundColor("light");
    const workspaceBackgroundColor = normalizeHexColor(appearance.workspaceBackgroundColor, workspaceBackgroundDefault);
    const workspaceBackgroundImage = normalizeWorkspaceBackgroundImage(appearance.workspaceBackgroundImage);
    if (controls.appearanceWorkspaceBackgroundColor) {
      controls.appearanceWorkspaceBackgroundColor.value = workspaceBackgroundColor;
    }
    if (controls.appearanceWorkspaceBackgroundImage) controls.appearanceWorkspaceBackgroundImage.value = workspaceBackgroundImage;
    if (controls.appearanceWorkspaceBackgroundPreview) {
      controls.appearanceWorkspaceBackgroundPreview.style.backgroundColor = workspaceBackgroundColor;
      controls.appearanceWorkspaceBackgroundPreview.style.backgroundImage = workspaceBackgroundImage;
      controls.appearanceWorkspaceBackgroundPreview.style.backgroundSize = workspaceBackgroundImage ? "cover" : "";
    }
    document.querySelectorAll("[data-workspace-background-color]").forEach((button) => {
      const active = !workspaceBackgroundImage && String(button.dataset.workspaceBackgroundColor || "").toLowerCase() === workspaceBackgroundColor;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    document.querySelectorAll("[data-workspace-background-image-preset]").forEach((button) => {
      const active = normalizeWorkspaceBackgroundImage(button.dataset.workspaceBackgroundImage) === workspaceBackgroundImage && Boolean(workspaceBackgroundImage);
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    setSettingsSwitch(controls.appearanceShowDesktopNotifications, appearance.showDesktopNotifications !== false);
    setSettingsSwitch(controls.appearanceShowUserAvatar, avatarToggleEnabled(appearance.showUserAvatar));
    setSettingsSwitch(controls.appearanceShowAssistantAvatar, avatarToggleEnabled(appearance.showAssistantAvatar));
  }

  function resetWorkspaceBackground() {
    const controls = els || {};
    if (controls.appearanceWorkspaceBackgroundColor) {
      controls.appearanceWorkspaceBackgroundColor.value = defaultWorkspaceBackgroundColor("light");
    }
    if (controls.appearanceWorkspaceBackgroundImage) controls.appearanceWorkspaceBackgroundImage.value = "";
    scheduleAppearanceSave(0);
  }

  function mergeRuntimeAppearance(appearance) {
    if (!state) return;
    state.runtime = {
      ...(state.runtime || {}),
      appearance: {
        ...(state.runtime?.appearance || {}),
        ...appearance
      }
    };
  }

  async function persistAppearanceDraft(appearance, seq = ++appearanceAutoSaveSeq) {
    if (!window.mia?.saveAppearance) return;
    try {
      const runtime = await window.mia.saveAppearance(appearance);
      if (seq !== appearanceAutoSaveSeq) return;
      const nextAppearance = {
        ...(runtime?.appearance || {}),
        ...appearance
      };
      state.runtime = {
        ...(runtime || {}),
        appearance: nextAppearance
      };
      applyAppearance(nextAppearance);
      syncAppearanceControls(nextAppearance);
      showAppearanceSaveStatus("已保存");
    } catch (error) {
      if (seq !== appearanceAutoSaveSeq) return;
      console.error(error);
      showAppearanceSaveStatus("保存失败", "error");
    }
  }

  function scheduleAppearanceSave(delay = 160) {
    const next = currentAppearanceDraft();
    const seq = ++appearanceAutoSaveSeq;
    applyAppearance(next);
    syncAppearanceControls(next);
    mergeRuntimeAppearance(next);
    showAppearanceSaveStatus("正在保存...");
    if (appearanceAutoSaveTimer) window.clearTimeout(appearanceAutoSaveTimer);
    appearanceAutoSaveTimer = window.setTimeout(() => {
      appearanceAutoSaveTimer = 0;
      persistAppearanceDraft(next, seq);
    }, delay);
  }

  window.miaSettingsAppearance = {
    initSettingsAppearance,
    showAppearanceSaveStatus,
    normalizeHexColor,
    normalizeWorkspaceBackgroundImage,
    normalizeListStyle,
    normalizeSelectionStyle,
    hexToRgb,
    relativeLuminance,
    selectionTextColors,
    floorTextColors,
    fontStackForAppearance,
    applyAppearance,
    currentAppearanceDraft,
    mergeCloudAppearance,
    setSettingsSwitch,
    toggleSettingsSwitch,
    syncAppearanceControls,
    resetWorkspaceBackground,
    mergeRuntimeAppearance,
    persistAppearanceDraft,
    scheduleAppearanceSave,
  };
})();
