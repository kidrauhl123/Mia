// Model / permission / effort settings UI module.
// The renderer supplies UI snapshots to Rust Core and renders the returned
// option catalog. Core owns engine/model/permission/effort selection policy.
(function () {
  "use strict";

  let state, els;
  let escapeHtml, setText, updateModelFieldVisibility, render;
  let providerLabels = {};
  let runtimeOptionsCacheKey = "";
  let runtimeOptionsCache = null;
  const runtimeOptionsInFlight = new Set();
  const runtimeOptionsBackoff = window.miaRequestBackoff?.createRequestBackoff?.({
    baseDelayMs: 1_000,
    maxDelayMs: 30_000
  }) || {
    canRun: () => true,
    fail: () => {},
    succeed: () => {}
  };
  const RUNTIME_OPTIONS_REQUEST_KEY = "settings-runtime-options";

  function initModelSettings(deps) {
    state = deps.state;
    els = deps.els;
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    updateModelFieldVisibility = deps.updateModelFieldVisibility;
    render = deps.render;
    if (deps.providerLabels) providerLabels = deps.providerLabels;
  }

  function runtimeControlOptionsRequest(runtime = state?.runtime) {
    return {
      activeAgentEngine: window.miaEngineOptions?.activeAgentEngine?.() || "hermes",
      runtime: runtime || {},
      engineConfig: window.miaEngineOptions?.engineConfigForPersona?.() || {},
      modelCatalog: window.miaModelHelpers?.catalogEntries?.() || [],
      platformModels: Array.isArray(state?.platformModels) ? state.platformModels : [],
      engineCapabilities: state?.engineCapabilities || {},
      codexModels: state?.codexModels || []
    };
  }

  function runtimeControlOptionsKey(request) {
    try {
      return JSON.stringify(request);
    } catch (_error) {
      return `${request.activeAgentEngine || "hermes"}:${Date.now()}`;
    }
  }

  function runtimeControlOptionsPayload(result) {
    return result?.data && typeof result.data === "object" ? result.data : result;
  }

  function requestRuntimeControlOptions(runtime = state?.runtime) {
    const api = window.mia?.getSettingsRuntimeControlOptions;
    if (typeof api !== "function") return;
    const request = runtimeControlOptionsRequest(runtime);
    const key = runtimeControlOptionsKey(request);
    if (runtimeOptionsCacheKey === key && runtimeOptionsCache) return;
    if (runtimeOptionsInFlight.has(key) || !runtimeOptionsBackoff.canRun(RUNTIME_OPTIONS_REQUEST_KEY)) return;
    runtimeOptionsInFlight.add(key);
    api(request)
      .then((result) => {
        if (result && result.ok === false) throw new Error(result.error || result.message || "Settings runtime options failed");
        const options = runtimeControlOptionsPayload(result);
        if (options && typeof options === "object") {
          runtimeOptionsCacheKey = key;
          runtimeOptionsCache = options;
        } else {
          throw new Error("Settings runtime options response was empty");
        }
        runtimeOptionsBackoff.succeed(RUNTIME_OPTIONS_REQUEST_KEY);
        if (typeof render === "function") render();
      })
      .catch((error) => {
        runtimeOptionsBackoff.fail(RUNTIME_OPTIONS_REQUEST_KEY);
        console.warn("[renderer] settings runtime options failed:", error?.message || error);
      })
      .finally(() => {
        runtimeOptionsInFlight.delete(key);
      });
  }

  function runtimeControlOptions(runtime = state?.runtime) {
    const request = runtimeControlOptionsRequest(runtime);
    const key = runtimeControlOptionsKey(request);
    if (runtimeOptionsCacheKey === key && runtimeOptionsCache) return runtimeOptionsCache;
    requestRuntimeControlOptions(runtime);
    return null;
  }

  function optionValue(entry = {}) {
    return String(entry.id || entry.value || entry.modelProfileId || entry.model || entry.provider || "").trim();
  }

  function optionLabel(entries = [], value = "", fallback = "") {
    const raw = String(value || "").trim();
    const entry = entries.find((item) => optionValue(item) === raw || item.value === raw || item.model === raw);
    return entry?.label || fallback || raw;
  }

  function controlForSelect(select) {
    return select?.closest?.(".model-switcher, .effort-switcher, .permission-switcher") || null;
  }

  function setControlVisible(select, visible) {
    const control = controlForSelect(select);
    control?.classList.toggle("hidden", !visible);
    control?.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function clearSelect(select) {
    if (!select) return;
    select.innerHTML = "";
    select.value = "";
    select.disabled = true;
  }

  function setRuntimeSelectOptions(select, entries, currentValue) {
    if (!select) return "";
    const previous = select.value || currentValue;
    select.innerHTML = "";
    if (!entries.length) {
      clearSelect(select);
      return "";
    }
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = optionValue(entry);
      option.textContent = entry.label || entry.model || entry.value || entry.id || "Default";
      option.title = entry.title || "";
      select.appendChild(option);
    }
    const values = new Set(entries.map(optionValue));
    if (values.has(previous)) select.value = previous;
    else if (values.has(currentValue)) select.value = currentValue;
    else select.value = optionValue(entries[0]);
    return select.selectedOptions?.[0]?.textContent || optionLabel(entries, select.value);
  }

  function setEffortSelectOptions(_engine, currentLevel) {
    if (!els || !els.effortSelect) return;
    const options = runtimeControlOptions()?.effortOptions || [];
    setRuntimeSelectOptions(els.effortSelect, options, currentLevel);
  }

  function syncEffortControl(runtime = state?.runtime) {
    if (!state || !els || !els.effortSelect || !els.effortLabel) return;
    const options = runtimeControlOptions(runtime);
    const entries = Array.isArray(options?.effortOptions) ? options.effortOptions : [];
    const selected = options?.selectedEffort || "";
    setControlVisible(els.effortSelect, Boolean(entries.length));
    if (!entries.length) {
      clearSelect(els.effortSelect);
      setText(els.effortLabel, "");
      els.effortSelect.title = "";
      return;
    }
    if (document.activeElement !== els.effortSelect) {
      setRuntimeSelectOptions(els.effortSelect, entries, selected);
    }
    const label = optionLabel(entries, els.effortSelect.value || selected);
    setText(els.effortLabel, label);
    els.effortSelect.title = `推理强度：${label}`;
    els.effortSelect.disabled = !options || !entries.length;
  }

  function setSelectOptions(select, entries, currentId) {
    if (!select) return;
    const previous = select.value || currentId;
    select.innerHTML = "";
    if (!entries.length) {
      clearSelect(select);
      syncQuickModelLabel();
      return;
    }
    const groups = new Map();
    for (const entry of entries) {
      const provider = entry.provider || "custom";
      if (!groups.has(provider)) {
        groups.set(provider, {
          label: entry.providerLabel || providerLabels[provider] || provider,
          entries: []
        });
      }
      groups.get(provider).entries.push(entry);
    }
    for (const group of groups.values()) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const entry of group.entries) {
        const option = document.createElement("option");
        option.value = optionValue(entry);
        option.textContent = entry.label || entry.model || "Local Model";
        option.title = entry.title || "";
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
    const ids = new Set(entries.map(optionValue));
    if (ids.has(previous)) select.value = previous;
    else if (ids.has(currentId)) select.value = currentId;
    else select.value = optionValue(entries[0]);
    syncQuickModelLabel();
  }

  function syncQuickModelLabel() {
    if (!els || !els.quickModelLabel || !els.quickModelSelect) return;
    const hasOptions = els.quickModelSelect.options && els.quickModelSelect.options.length > 0;
    setControlVisible(els.quickModelSelect, Boolean(hasOptions));
    if (!hasOptions || els.quickModelSelect.disabled) {
      setText(els.quickModelLabel, "");
      return;
    }
    if (!els.quickModelSelect.value) {
      setText(els.quickModelLabel, "");
      return;
    }
    const selected = els.quickModelSelect.selectedOptions?.[0];
    setText(els.quickModelLabel, selected?.textContent || "");
  }

  function permissionLabelForMode(mode = "") {
    if (!els) return String(mode || "");
    const selected = els.permissionMode?.selectedOptions?.[0];
    if (selected?.textContent) return selected.textContent;
    if (mode === "smart") return "Smart";
    if (mode === "ask" || mode === "manual" || mode === "default") return "Ask";
    if (mode === "yolo" || mode === "off" || mode === "bypassPermissions") return "YOLO";
    if (mode === "deny" || mode === "dontAsk") return "Deny";
    if (mode === "acceptEdits") return "Accept Edits";
    if (mode === "plan") return "Plan Mode";
    if (mode === "auto") return "Auto Mode";
    if (mode === "readOnly") return "Read";
    if (mode === ":workspace") return "Workspace";
    if (mode === ":read-only") return "Read Only";
    if (mode === ":danger-full-access") return "Full Access";
    return String(mode || "");
  }

  function setPermissionSelectOptions(_engine, currentMode) {
    if (!els || !els.permissionMode) return;
    const options = runtimeControlOptions()?.permissionOptions || [];
    setRuntimeSelectOptions(els.permissionMode, options, currentMode);
  }

  function syncPermissionControl(runtime = state?.runtime) {
    if (!state || !els || !els.permissionMode || !els.permissionLabel) return;
    const options = runtimeControlOptions(runtime);
    const entries = Array.isArray(options?.permissionOptions) ? options.permissionOptions : [];
    const mode = options?.selectedPermission || "";
    setControlVisible(els.permissionMode, Boolean(entries.length));
    if (!entries.length) {
      clearSelect(els.permissionMode);
      setText(els.permissionLabel, "");
      els.permissionMode.title = "";
      return;
    }
    if (document.activeElement !== els.permissionMode) {
      setRuntimeSelectOptions(els.permissionMode, entries, mode);
    }
    const label = optionLabel(entries, els.permissionMode.value || mode, permissionLabelForMode(els.permissionMode.value || mode));
    setText(els.permissionLabel, label);
    els.permissionMode.title = `权限模式：${label}`;
    els.permissionMode.disabled = !options || !entries.length;
    const engine = options?.agentEngine || "hermes";
    const switcher = els.permissionMode.closest(".permission-switcher");
    switcher?.classList.toggle("yolo", els.permissionMode.value === "yolo" || els.permissionMode.value === "off" || els.permissionMode.value === ":danger-full-access" || (engine !== "claude-code" && els.permissionMode.value === "bypassPermissions"));
    switcher?.classList.toggle("claude-bypass", engine === "claude-code" && els.permissionMode.value === "bypassPermissions");
  }

  function setProviderOptions(select, entries, currentProvider) {
    if (!select) return;
    const previous = select.value || currentProvider;
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = entries.length ? "选择要连接的提供商" : "没有更多可添加的提供商";
    select.appendChild(placeholder);
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.provider;
      option.textContent = entry.providerLabel || entry.label || entry.provider;
      select.appendChild(option);
    }
    const ids = new Set(entries.map((entry) => entry.provider));
    if (ids.has(previous)) select.value = previous;
    else if (ids.has(currentProvider)) select.value = currentProvider;
    else select.value = "";
  }

  function providerIsConnected(provider, runtime = state?.runtime) {
    if (!provider) return false;
    if (provider === "mia") return Boolean(runtime?.cloud?.enabled);
    return Boolean((runtime?.connectedProviders || []).some((entry) => entry.provider === provider && entry.hasApiKey));
  }

  function connectedModelEntries(runtime = state?.runtime) {
    return runtimeControlOptions(runtime)?.modelOptions || [];
  }

  function renderModelSelectors(runtime = state?.runtime) {
    if (!state || !els) return;
    const options = runtimeControlOptions(runtime);
    const modelEntries = Array.isArray(options?.modelOptions) ? options.modelOptions : [];
    const providerEntries = Array.isArray(options?.addProviderOptions) ? options.addProviderOptions : [];
    setProviderOptions(els.modelSelect, providerEntries, "");
    setSelectOptions(els.quickModelSelect, modelEntries, options?.selectedModel || "");
    setControlVisible(els.quickModelSelect, Boolean(modelEntries.length));
    if (els.quickModelSelect) els.quickModelSelect.disabled = !options || !modelEntries.length;
    syncQuickModelLabel();
  }

  function modelAuthCopy(entry, runtime = state?.runtime) {
    const authType = String(entry?.authType || "api_key");
    if (!entry) return { state: "未选择", hint: "选择提供商后，Mia 会显示它需要的登录方式。" };
    if (entry.provider === "openai-codex") {
      return runtime?.auth?.codexLoggedIn
        ? { state: "已授权 OpenAI Codex", hint: "OAuth token 已保存在 Mia 私有 runtime；具体 Codex 模型在聊天框下方切换。" }
        : { state: "需要 OpenAI 登录", hint: "选择 OpenAI Codex 后，用 OpenAI 登录完成授权；不需要 API key。" };
    }
    if (entry.provider === "mia") {
      return runtime?.cloud?.enabled
        ? { state: "已连接 Mia", hint: "Mia 托管模型使用当前 Mia Cloud 账号，不需要额外 API key。" }
        : { state: "需要登录 Mia", hint: "登录 Mia Cloud 后即可使用 Mia 托管模型。" };
    }
    if (authType.startsWith("oauth")) {
      return { state: "需要登录", hint: "这个 Hermes Provider 使用 OAuth。点击登录后，Mia 会展示浏览器链接、激活码和登录日志。" };
    }
    if (entry.provider === "lmstudio") {
      return { state: "本地服务", hint: "LM Studio 通常不需要 API key；请确认本地服务已启动并加载模型。" };
    }
    return runtime?.model?.provider === entry.provider && runtime?.model?.hasApiKey
      ? { state: "已保存 API key", hint: "留空保存会继续使用已保存的 key；具体模型在聊天框下方切换。" }
      : { state: "需要 API key", hint: `填写 ${window.miaModelHelpers.apiKeyPromptLabel(entry)} 后保存，Mia Core 会接管配置并重启 Hermes。` };
  }

  function renderConnectedProviders(runtime = state?.runtime) {
    if (!els || !els.connectedProviderList) return;
    const providers = runtime?.connectedProviders || [];
    const section = els.connectedProviderList.closest(".connected-providers");
    section?.classList.toggle("hidden", !providers.length);
    els.connectedProviderList.innerHTML = "";
    if (!providers.length) return;
    for (const provider of providers) {
      const row = document.createElement("div");
      row.className = "connected-provider";
      row.innerHTML = `
        <span class="provider-logo-wrap"><img class="provider-logo" src="${escapeHtml(window.miaModelHelpers.modelIconSrc({ provider: provider.provider }))}" alt="" onerror="this.style.display='none'"></span>
        <span class="provider-main">
          <strong>${escapeHtml(provider.providerLabel || provider.provider)}</strong>
        </span>
        <span class="provider-check">✓</span>
      `;
      els.connectedProviderList.appendChild(row);
    }
  }

  window.miaModelSettings = {
    initModelSettings,
    runtimeControlOptionsRequest,
    runtimeControlOptions,
    requestRuntimeControlOptions,
    setEffortSelectOptions,
    syncEffortControl,
    setSelectOptions,
    syncQuickModelLabel,
    permissionLabelForMode,
    setPermissionSelectOptions,
    syncPermissionControl,
    setProviderOptions,
    providerIsConnected,
    connectedModelEntries,
    renderModelSelectors,
    modelAuthCopy,
    renderConnectedProviders,
  };
})();
