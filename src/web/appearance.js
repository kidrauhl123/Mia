// Mia Web — appearance settings.
// Persists in localStorage and applies on document.documentElement via
// data-* attributes + CSS custom properties. The shape mirrors a subset
// of desktop's userAppearance (font preset deliberately omitted per the
// user's instruction).
(function (global) {
  "use strict";

  const STORAGE_KEY = "mia.web.appearance";
  const DEFAULT_ACCENT = "#318ad3";
  const DEFAULT_USER_BUBBLE = "#eeffde";

  const defaults = {
    theme: "light",            // "light" | "dark"
    listStyle: "card",
    selectionStyle: "solid",
    accentColor: DEFAULT_ACCENT,
    userBubbleColor: DEFAULT_USER_BUBBLE,
    showUserAvatar: false,
    showAssistantAvatar: false,
    workspaceBackgroundColor: "",
    workspaceBackgroundImage: ""
  };

  let current = { ...defaults };
  const subscribers = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      return { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch {
      return { ...defaults };
    }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch {}
  }

  // "#318ad3" → "49 138 211". Used to derive --accent-rgb so rgb(var(--accent-rgb) / 0.16)
  // works for hover/active translucent backgrounds without picking colors by hand.
  function hexToRgbTriplet(hex) {
    const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 0xff} ${(n >> 8) & 0xff} ${n & 0xff}`;
  }

  function hexToRgb(hex) {
    const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff
    };
  }

  function relativeLuminance(rgb) {
    if (!rgb) return 1;
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  // Keep the web bubble legible for both the default pale green and custom
  // dark colors. This uses the same luminance threshold as desktop.
  function userBubbleTextColor(hex) {
    return relativeLuminance(hexToRgb(hex)) > 0.56
      ? "rgba(0, 0, 0, 0.90)"
      : "#ffffff";
  }

  function applyToDom(next) {
    const root = document.documentElement;
    root.dataset.theme = next.theme === "dark" ? "dark" : "light";
    root.dataset.selectionStyle = "solid";
    root.dataset.showUserAvatar = next.showUserAvatar === true ? "on" : "off";
    root.dataset.showAssistantAvatar = next.showAssistantAvatar === true ? "on" : "off";
    if (next.accentColor) {
      root.style.setProperty("--accent", next.accentColor);
      const rgb = hexToRgbTriplet(next.accentColor);
      if (rgb) root.style.setProperty("--accent-rgb", rgb);
    }
    const userBubbleColor = /^#[0-9a-fA-F]{6}$/.test(String(next.userBubbleColor || ""))
      ? String(next.userBubbleColor).toLowerCase()
      : DEFAULT_USER_BUBBLE;
    root.style.setProperty("--user-bubble-color", userBubbleColor);
    root.style.setProperty("--user-bubble-text", userBubbleTextColor(userBubbleColor));
    if (/^#[0-9a-fA-F]{6}$/.test(String(next.workspaceBackgroundColor || ""))) {
      root.style.setProperty("--workspace-floor", String(next.workspaceBackgroundColor).toLowerCase());
    } else {
      root.style.removeProperty("--workspace-floor");
    }
    root.style.setProperty("--workspace-floor-image", "none");
  }

  function init() {
    current = load();
    current.selectionStyle = "solid";
    current.workspaceBackgroundImage = "";
    applyToDom(current);
  }

  function get() { return { ...current }; }

  function update(patch) {
    current = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
    current.selectionStyle = "solid";
    current.workspaceBackgroundImage = "";
    applyToDom(current);
    save();
    for (const cb of subscribers) {
      try { cb(get()); } catch (err) { console.warn("[appearance] subscriber error:", err); }
    }
  }

  function reset() {
    current = { ...defaults };
    applyToDom(current);
    save();
    for (const cb of subscribers) {
      try { cb(get()); } catch (err) { console.warn("[appearance] subscriber error:", err); }
    }
  }

  function subscribe(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  // Apply immediately on script load so the page doesn't flash light→dark.
  init();

  global.miaAppearance = {
    get,
    update,
    reset,
    subscribe,
    defaults: { ...defaults }
  };
})(typeof window !== "undefined" ? window : globalThis);
