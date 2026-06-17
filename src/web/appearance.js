// Mia Web — appearance settings.
// Persists in localStorage and applies on document.documentElement via
// data-* attributes + CSS custom properties. The shape mirrors a subset
// of desktop's userAppearance (font preset deliberately omitted per the
// user's instruction).
(function (global) {
  "use strict";

  const STORAGE_KEY = "mia.web.appearance";
  const DEFAULT_ACCENT = "#318ad3";
  const DEFAULT_USER_BUBBLE = "#0162db";

  const defaults = {
    theme: "light",            // "light" | "dark"
    listStyle: "card",
    selectionStyle: "soft",    // "soft" | "solid"
    hoverBackground: true,
    accentColor: DEFAULT_ACCENT,
    userBubbleColor: DEFAULT_USER_BUBBLE,
    showUserAvatar: true,
    showAssistantAvatar: true,
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

  function applyToDom(next) {
    const root = document.documentElement;
    root.dataset.theme = next.theme === "dark" ? "dark" : "light";
    root.dataset.selectionStyle = next.selectionStyle === "solid" ? "solid" : "soft";
    root.dataset.hoverBackground = next.hoverBackground ? "on" : "off";
    root.dataset.showUserAvatar = next.showUserAvatar ? "on" : "off";
    root.dataset.showAssistantAvatar = next.showAssistantAvatar ? "on" : "off";
    if (next.accentColor) {
      root.style.setProperty("--accent", next.accentColor);
      const rgb = hexToRgbTriplet(next.accentColor);
      if (rgb) root.style.setProperty("--accent-rgb", rgb);
    }
    if (next.userBubbleColor) {
      root.style.setProperty("--user-bubble-color", next.userBubbleColor);
    }
    if (/^#[0-9a-fA-F]{6}$/.test(String(next.workspaceBackgroundColor || ""))) {
      root.style.setProperty("--workspace-floor", String(next.workspaceBackgroundColor).toLowerCase());
    } else {
      root.style.removeProperty("--workspace-floor");
    }
    const image = String(next.workspaceBackgroundImage || "").trim();
    root.style.setProperty(
      "--workspace-floor-image",
      /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(image) && image.length <= 4 * 1024 * 1024
        ? `url("${image.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r\f]/g, "")}")`
        : "none"
    );
  }

  function init() {
    current = load();
    applyToDom(current);
  }

  function get() { return { ...current }; }

  function update(patch) {
    current = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
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
