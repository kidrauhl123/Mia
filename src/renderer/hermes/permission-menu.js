(function attachHermesPermissionMenu(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaHermesPermissionMenu = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildHermesPermissionMenu(root) {
  const configurations = new WeakMap();
  let activeMenu = null;

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
    if (activeMenu?.select === select) resetMenu(activeMenu.menu);
  }

  function copyFor(entry = {}) {
    const value = String(entry.value || "");
    const fallback = FALLBACK_COPY[value] || { label: value, description: "" };
    return {
      label: String(entry.label || fallback.label),
      description: String(entry.title || fallback.description)
    };
  }

  function renderMenu({ select, menu, entries = [], selectedValue = "", escapeHtml = String } = {}) {
    const configuration = configurations.get(select);
    if (!configuration || !menu || select?.dataset?.hermesPermissionMenu !== "true") return false;
    const options = entries.filter((entry) => entry?.type === "option" && !entry.placeholder);
    if (!options.length) return false;
    const mode = String(selectedValue || configuration.approvalMode || "ask");
    const globalBypass = ["off", "yolo"].includes(mode.trim().toLowerCase());
    const yoloActive = Boolean(configuration.sessionYoloActive);
    const yoloDescription = "允许完全访问，危险操作不再询问";
    menu.classList.add("hermes-permission-menu");
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <div class="hermes-permission-heading">
        <span>审批策略</span>
        <span class="hermes-permission-scope">持久化</span>
      </div>
      <div class="hermes-approval-options">
        ${options.map((entry) => {
          const selected = String(entry.value) === mode;
          const copy = copyFor(entry);
          return `<button class="composer-select-option hermes-approval-option${selected ? " selected" : ""}" type="button" role="menuitemradio" aria-checked="${selected ? "true" : "false"}" data-value="${escapeHtml(entry.value)}"${entry.disabled ? " disabled" : ""}>
            <span class="hermes-approval-copy">
              <span class="hermes-approval-label">${escapeHtml(copy.label)}</span>
              <span class="hermes-approval-description">${escapeHtml(copy.description)}</span>
            </span>
            <span class="hermes-approval-check" aria-hidden="true">✓</span>
          </button>`;
        }).join("")}
      </div>
      <div class="hermes-permission-separator" role="separator"></div>
      <button class="hermes-session-yolo" type="button" data-hermes-session-yolo aria-pressed="${yoloActive ? "true" : "false"}"${globalBypass || !configuration.onToggleYolo ? " disabled" : ""}>
        <span class="hermes-yolo-copy">
          <span class="hermes-yolo-label">YOLO（仅本会话）</span>
          <span class="hermes-yolo-description">${escapeHtml(yoloDescription)}</span>
        </span>
        <span class="hermes-yolo-switch" aria-hidden="true"><span></span></span>
      </button>`;
    activeMenu = { menu, select };
    return true;
  }

  function resetMenu(menu) {
    menu?.classList?.remove("hermes-permission-menu");
    menu?.setAttribute?.("role", "listbox");
    if (!menu || activeMenu?.menu === menu) activeMenu = null;
  }

  function handleClick(event) {
    const button = event.target?.closest?.("[data-hermes-session-yolo]");
    if (!button || !activeMenu?.menu?.contains?.(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.disabled) return;
    const configuration = configurations.get(activeMenu.select);
    if (!configuration?.onToggleYolo) return;
    button.disabled = true;
    button.classList.add("pending");
    void Promise.resolve(configuration.onToggleYolo(!configuration.sessionYoloActive));
  }

  function handleKeydown(event) {
    const button = event.target?.closest?.("[data-hermes-session-yolo]");
    if (!button || !activeMenu?.menu?.contains?.(button)) return;
    if (event.key === "Enter" || event.key === " ") event.stopImmediatePropagation();
  }

  root?.document?.addEventListener?.("click", handleClick);
  root?.document?.addEventListener?.("keydown", handleKeydown);

  return {
    configure,
    clear,
    renderMenu,
    resetMenu,
    copyFor
  };
});
