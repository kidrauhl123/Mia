(function attachHermesPermissionMenu(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaHermesPermissionMenu = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildHermesPermissionMenu(root) {
  const configurations = new WeakMap();

  const FALLBACK_COPY = {
    manual: { label: "手动", description: "危险操作每次都询问" },
    smart: { label: "智能", description: "低风险自动通过，高风险操作询问" },
    off: { label: "关闭", description: "不再询问，直接执行" }
  };

  function configure({ select, enabled, sessionYoloActive = false, approvalMode = "smart", onToggleYolo } = {}) {
    if (!select) return;
    if (!enabled) {
      clear(select);
      return;
    }
    configurations.set(select, {
      approvalMode: String(approvalMode || "smart"),
      sessionYoloActive: Boolean(sessionYoloActive),
      onToggleYolo: typeof onToggleYolo === "function" ? onToggleYolo : null
    });
    select.dataset.hermesPermissionMenu = "true";
  }

  function clear(select) {
    if (!select) return;
    configurations.delete(select);
    delete select.dataset.hermesPermissionMenu;
    root?.miaReactSelectMenu?.close?.(select);
  }

  function getConfiguration(select) {
    const configuration = configurations.get(select);
    if (!configuration || select?.dataset?.hermesPermissionMenu !== "true") return null;
    return {
      approvalMode: configuration.approvalMode,
      sessionYoloActive: configuration.sessionYoloActive,
      toggleYolo: configuration.onToggleYolo
    };
  }

  function copyFor(entry = {}) {
    const value = String(entry.value || "");
    const fallback = FALLBACK_COPY[value] || { label: value, description: "" };
    return {
      label: String(entry.label || fallback.label),
      description: String(entry.title || fallback.description)
    };
  }

  return {
    configure,
    clear,
    getConfiguration,
    copyFor
  };
});
