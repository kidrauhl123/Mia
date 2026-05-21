// Settings - Appearance tab module
// Extracted from app.js. Holds theme/font/color/switch logic and the
// appearance auto-save loop. Constants (fontPresets, DEFAULT_*) and small
// element refs come in via initSettingsAppearance().
(function () {
  "use strict";

  let state, els, aimashi;
  let fontPresets, DEFAULT_ACCENT_COLOR, DEFAULT_USER_BUBBLE_COLOR, DEFAULT_LIST_STYLE, DEFAULT_SELECTION_STYLE;

  // Module-local timers, formerly top-of-app.js lets 22-24.
  let appearanceSaveStatusTimer = 0;
  let appearanceAutoSaveTimer = 0;
  let appearanceAutoSaveSeq = 0;

  function initSettingsAppearance(deps) {
    state = deps.state;
    els = deps.els;
    aimashi = deps.aimashi || (typeof window !== "undefined" ? window.aimashi : null);
    fontPresets = deps.fontPresets;
    DEFAULT_ACCENT_COLOR = deps.DEFAULT_ACCENT_COLOR;
    DEFAULT_USER_BUBBLE_COLOR = deps.DEFAULT_USER_BUBBLE_COLOR;
    DEFAULT_LIST_STYLE = deps.DEFAULT_LIST_STYLE;
    DEFAULT_SELECTION_STYLE = deps.DEFAULT_SELECTION_STYLE;
  }

  function showAppearanceSaveStatus(text, kind = "ok") {
    if (!els.appearanceSaveStatus) return;
    if (appearanceSaveStatusTimer) window.clearTimeout(appearanceSaveStatusTimer);
    els.appearanceSaveStatus.textContent = text;
    els.appearanceSaveStatus.dataset.kind = kind;
    els.appearanceSaveStatus.classList.toggle("visible", Boolean(text));
    if (!text) return;
    appearanceSaveStatusTimer = window.setTimeout(() => {
      els.appearanceSaveStatus.textContent = "";
      els.appearanceSaveStatus.classList.remove("visible");
      delete els.appearanceSaveStatus.dataset.kind;
      appearanceSaveStatusTimer = 0;
    }, kind === "error" ? 3600 : 1800);
  }

  function normalizeHexColor(value, fallback = DEFAULT_ACCENT_COLOR) {
    const raw = String(value || "").trim();
    const expanded = raw.replace(/^#([0-9a-fA-F]{3})$/, (_, hex) => `#${hex.split("").map((part) => part + part).join("")}`);
    return /^#[0-9a-fA-F]{6}$/.test(expanded) ? expanded.toLowerCase() : fallback;
  }

  function normalizeListStyle(value) {
    return value === "flush" ? "flush" : DEFAULT_LIST_STYLE;
  }

  function normalizeSelectionStyle(value) {
    return value === "solid" ? "solid" : DEFAULT_SELECTION_STYLE;
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

  function fontStackForAppearance(appearance = {}) {
    return fontPresets[appearance.fontPreset || "system"] || fontPresets.system;
  }

  function applyAppearance(appearance = {}) {
    const theme = appearance.theme === "dark" ? "dark" : "light";
    const accentColor = normalizeHexColor(appearance.accentColor);
    const rgb = hexToRgb(accentColor);
    const userBubbleColor = normalizeHexColor(appearance.userBubbleColor, DEFAULT_USER_BUBBLE_COLOR);
    const userBubbleRgb = hexToRgb(userBubbleColor);
    const userBubbleText = selectionTextColors(userBubbleRgb).text;
    const listStyle = normalizeListStyle(appearance.listStyle);
    const selectionStyle = normalizeSelectionStyle(appearance.selectionStyle);
    const softActive = `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${theme === "dark" ? "0.22" : "0.16"})`;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.listStyle = listStyle;
    document.documentElement.dataset.selectionStyle = selectionStyle;
    document.documentElement.dataset.hoverBackground = appearance.showHoverBackground === false ? "false" : "true";
    document.documentElement.dataset.showUserAvatar = appearance.showUserAvatar === false ? "false" : "true";
    document.documentElement.dataset.showAssistantAvatar = appearance.showAssistantAvatar === false ? "false" : "true";
    document.documentElement.style.setProperty("--app-font", fontStackForAppearance(appearance));
    document.documentElement.style.setProperty("--accent", accentColor);
    document.documentElement.style.setProperty("--accent-rgb", `${rgb.r} ${rgb.g} ${rgb.b}`);
    document.documentElement.style.setProperty("--active", softActive);
    document.documentElement.style.setProperty("--user-bubble", userBubbleColor);
    document.documentElement.style.setProperty("--user-bubble-text", userBubbleText);
    if (selectionStyle === "solid") {
      const textColors = selectionTextColors(rgb);
      document.documentElement.style.setProperty("--list-active", accentColor);
      document.documentElement.style.setProperty("--list-active-text", textColors.text);
      document.documentElement.style.setProperty("--list-active-muted", textColors.muted);
      document.documentElement.style.setProperty("--list-active-faint", textColors.faint);
    } else {
      document.documentElement.style.setProperty("--list-active", softActive);
      document.documentElement.style.setProperty("--list-active-text", accentColor);
      document.documentElement.style.setProperty("--list-active-muted", "var(--muted)");
      document.documentElement.style.setProperty("--list-active-faint", "var(--faint)");
    }
  }

  function currentAppearanceDraft() {
    return {
      theme: els.appearanceTheme?.value || "light",
      fontPreset: els.appearanceFontPreset?.value || "system",
      accentColor: normalizeHexColor(els.appearanceAccentColor?.value),
      userBubbleColor: normalizeHexColor(els.appearanceUserBubbleColor?.value, DEFAULT_USER_BUBBLE_COLOR),
      showHoverBackground: els.appearanceShowHoverBackground?.getAttribute("aria-checked") !== "false",
      showUserAvatar: els.appearanceShowUserAvatar?.getAttribute("aria-checked") !== "false",
      showAssistantAvatar: els.appearanceShowAssistantAvatar?.getAttribute("aria-checked") !== "false",
      listStyle: normalizeListStyle(els.appearanceListStyle?.value),
      selectionStyle: normalizeSelectionStyle(els.appearanceSelectionStyle?.value)
    };
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

  function syncAppearanceControls(appearance = currentAppearanceDraft()) {
    const fontPreset = fontPresets[appearance.fontPreset] ? appearance.fontPreset : "system";
    if (els.appearanceFontPreset) els.appearanceFontPreset.value = fontPreset;
    document.querySelectorAll("[data-font-preset]").forEach((button) => {
      const active = button.dataset.fontPreset === fontPreset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    const listStyle = normalizeListStyle(appearance.listStyle);
    if (els.appearanceListStyle) els.appearanceListStyle.value = listStyle;
    document.querySelectorAll("[data-list-style]").forEach((button) => {
      const active = button.dataset.listStyle === listStyle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    const selectionStyle = normalizeSelectionStyle(appearance.selectionStyle);
    if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = selectionStyle;
    document.querySelectorAll("[data-selection-style]").forEach((button) => {
      const active = button.dataset.selectionStyle === selectionStyle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    const accentColor = normalizeHexColor(appearance.accentColor);
    if (els.appearanceAccentColor) els.appearanceAccentColor.value = accentColor;
    if (els.appearanceAccentPreview) els.appearanceAccentPreview.style.backgroundColor = accentColor;
    const userBubbleColor = normalizeHexColor(appearance.userBubbleColor, DEFAULT_USER_BUBBLE_COLOR);
    if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = userBubbleColor;
    if (els.appearanceUserBubblePreview) els.appearanceUserBubblePreview.style.backgroundColor = userBubbleColor;
    setSettingsSwitch(els.appearanceShowHoverBackground, appearance.showHoverBackground !== false);
    setSettingsSwitch(els.appearanceShowUserAvatar, appearance.showUserAvatar !== false);
    setSettingsSwitch(els.appearanceShowAssistantAvatar, appearance.showAssistantAvatar !== false);
  }

  function mergeRuntimeAppearance(appearance) {
    state.runtime = {
      ...(state.runtime || {}),
      appearance: {
        ...(state.runtime?.appearance || {}),
        ...appearance
      }
    };
  }

  async function persistAppearanceDraft(appearance) {
    if (!window.aimashi?.saveAppearance) return;
    const seq = ++appearanceAutoSaveSeq;
    try {
      const runtime = await window.aimashi.saveAppearance(appearance);
      if (seq !== appearanceAutoSaveSeq) return;
      state.runtime = runtime;
      applyAppearance(runtime.appearance || appearance);
      showAppearanceSaveStatus("已保存");
    } catch (error) {
      console.error(error);
      showAppearanceSaveStatus("保存失败", "error");
    }
  }

  function scheduleAppearanceSave(delay = 160) {
    const next = currentAppearanceDraft();
    applyAppearance(next);
    syncAppearanceControls(next);
    mergeRuntimeAppearance(next);
    showAppearanceSaveStatus("正在保存...");
    if (appearanceAutoSaveTimer) window.clearTimeout(appearanceAutoSaveTimer);
    appearanceAutoSaveTimer = window.setTimeout(() => {
      appearanceAutoSaveTimer = 0;
      persistAppearanceDraft(currentAppearanceDraft());
    }, delay);
  }

  window.aimashiSettingsAppearance = {
    initSettingsAppearance,
    showAppearanceSaveStatus,
    normalizeHexColor,
    normalizeListStyle,
    normalizeSelectionStyle,
    hexToRgb,
    relativeLuminance,
    selectionTextColors,
    fontStackForAppearance,
    applyAppearance,
    currentAppearanceDraft,
    setSettingsSwitch,
    toggleSettingsSwitch,
    syncAppearanceControls,
    mergeRuntimeAppearance,
    persistAppearanceDraft,
    scheduleAppearanceSave,
  };
})();
