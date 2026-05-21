// Model / permission / effort settings UI module (Task B2b)
// Extracted from app.js. Render layer that turns engine-options data and
// model-helpers catalog into populated <select> elements + label / preview
// strings for the chat composer and the Settings - Model tab.
//
// Data layer dependencies (already-extracted modules):
//   - window.aimashiEngineOptions: activeAgentEngine, engineConfigForPersona,
//     effortOptions, effortLabelForLevel, externalModelEntries, externalPermissionOptions
//   - window.aimashiModelHelpers: modelKey, catalogEntryForModel, providerEntries,
//     modelsForProvider, modelIconSrc
//
// Defensive `if (!state || !els)` guards keep early calls safe.
(function () {
  "use strict";

  let state, els;
  let escapeHtml, setText, updateModelFieldVisibility;
  let providerPresets = {};
  let providerLabels = {};

  function initModelSettings(deps) {
    state = deps.state;
    els = deps.els;
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    updateModelFieldVisibility = deps.updateModelFieldVisibility;
    if (deps.providerPresets) providerPresets = deps.providerPresets;
    if (deps.providerLabels) providerLabels = deps.providerLabels;
  }

  function setEffortSelectOptions(engine, currentLevel) {
    if (!els || !els.effortSelect) return;
    const previous = els.effortSelect.value;
    const options = window.aimashiEngineOptions.effortOptions(engine);
    const ids = new Set(options.map((option) => option.value));
    const nextValue = ids.has(currentLevel) ? currentLevel : ids.has(previous) ? previous : "medium";
    els.effortSelect.innerHTML = "";
    for (const item of options) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      els.effortSelect.appendChild(option);
    }
    els.effortSelect.value = ids.has(nextValue) ? nextValue : options[0]?.value || "";
  }

  function syncEffortControl(runtime = state?.runtime) {
    if (!state || !els || !els.effortSelect || !els.effortLabel) return;
    const engine = window.aimashiEngineOptions.activeAgentEngine();
    const external = engine === "claude-code" || engine === "codex";
    const level = external ? (window.aimashiEngineOptions.engineConfigForPersona().effortLevel || "medium") : (runtime?.effort?.level || "medium");
    if (document.activeElement !== els.effortSelect) setEffortSelectOptions(engine, level);
    if (document.activeElement !== els.effortSelect) {
      els.effortSelect.value = [...els.effortSelect.options].some((option) => option.value === level) ? level : "medium";
    }
    setText(els.effortLabel, window.aimashiEngineOptions.effortLabelForLevel(els.effortSelect.value));
    els.effortSelect.title = `推理强度：${window.aimashiEngineOptions.effortLabelForLevel(els.effortSelect.value)}`;
  }

  function fillModelFieldsFromPreset(key) {
    if (!els) return;
    const preset = providerPresets[key];
    if (!preset) return;
    els.modelProvider.value = preset.provider;
    els.modelName.value = preset.model;
    els.modelKeyEnv.value = preset.apiKeyEnv;
    els.modelBaseUrl.value = preset.baseUrl;
    els.modelApiMode.value = preset.apiMode;
    els.authMethod.value = key === "openai-codex" ? "openai-codex" : "api-key";
    els.modelPreset.value = key;
    if (key === "openai-codex") els.modelApiKey.value = "";
    if (typeof updateModelFieldVisibility === "function") updateModelFieldVisibility();
  }

  function setSelectOptions(select, entries, currentId) {
    if (!select) return;
    const previous = select.value || currentId;
    select.innerHTML = "";
    if (!entries.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "先连接模型提供商";
      select.appendChild(option);
      select.value = "";
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
        option.value = entry.id;
        option.textContent = entry.label || entry.model || "Local Model";
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
    const ids = new Set(entries.map((entry) => entry.id));
    if (ids.has(previous)) select.value = previous;
    else if (ids.has(currentId)) select.value = currentId;
    else if (entries[0]) select.value = entries[0].id;
    syncQuickModelLabel();
  }

  function syncQuickModelLabel() {
    if (!els || !els.quickModelLabel || !els.quickModelSelect) return;
    const hasOptions = els.quickModelSelect.options && els.quickModelSelect.options.length > 0;
    if (!hasOptions || els.quickModelSelect.disabled) {
      setText(els.quickModelLabel, "未配置模型");
      return;
    }
    const selected = els.quickModelSelect.selectedOptions?.[0];
    setText(els.quickModelLabel, selected?.textContent || "未配置模型");
  }

  function permissionLabelForMode(mode = "") {
    if (!els) return "Ask";
    const selected = els.permissionMode?.selectedOptions?.[0];
    if (selected?.textContent) return selected.textContent;
    if (mode === "smart") return "Smart";
    if (mode === "ask" || mode === "manual") return "Ask";
    if (mode === "yolo" || mode === "off") return "YOLO";
    if (mode === "deny" || mode === "dontAsk") return "Deny";
    if (mode === "acceptEdits") return window.aimashiEngineOptions.activeAgentEngine() === "claude-code" ? "Accept Edits" : "Edits";
    if (mode === "plan") return window.aimashiEngineOptions.activeAgentEngine() === "claude-code" ? "Plan Mode" : "Plan";
    if (mode === "auto") return "Auto Mode";
    if (mode === "bypassPermissions") return window.aimashiEngineOptions.activeAgentEngine() === "claude-code" ? "Bypass Permissions" : "YOLO";
    if (mode === "readOnly") return "Read";
    return "Ask";
  }

  function setPermissionSelectOptions(engine, currentMode) {
    if (!els || !els.permissionMode) return;
    const previous = els.permissionMode.value;
    const options = window.aimashiEngineOptions.externalPermissionOptions(engine);
    const ids = new Set(options.map((option) => option.value));
    const nextValue = ids.has(currentMode) ? currentMode : ids.has(previous) ? previous : options[0]?.value || "";
    els.permissionMode.innerHTML = "";
    for (const item of options) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.title = item.title || "";
      els.permissionMode.appendChild(option);
    }
    els.permissionMode.value = nextValue;
  }

  function syncPermissionControl(runtime = state?.runtime) {
    if (!state || !els || !els.permissionMode || !els.permissionLabel) return;
    const engine = window.aimashiEngineOptions.activeAgentEngine();
    const external = engine === "claude-code" || engine === "codex";
    const mode = external ? (window.aimashiEngineOptions.engineConfigForPersona().permissionMode || "default") : (runtime?.permissions?.mode || "manual");
    setPermissionSelectOptions(engine, mode);
    if (document.activeElement !== els.permissionMode) {
      els.permissionMode.value = [...els.permissionMode.options].some((option) => option.value === mode) ? mode : els.permissionMode.options[0]?.value || "";
    }
    setText(els.permissionLabel, permissionLabelForMode(els.permissionMode.value));
    els.permissionMode.title = `权限模式：${permissionLabelForMode(els.permissionMode.value)}`;
    const switcher = els.permissionMode.closest(".permission-switcher");
    switcher?.classList.toggle("yolo", els.permissionMode.value === "yolo" || els.permissionMode.value === "off" || (engine !== "claude-code" && els.permissionMode.value === "bypassPermissions"));
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
    return Boolean((runtime?.connectedProviders || []).some((entry) => entry.provider === provider && entry.hasApiKey));
  }

  function connectedModelEntries(runtime = state?.runtime) {
    const connectedProviders = (runtime?.connectedProviders || []).map((entry) => entry.provider);
    const entries = connectedProviders.flatMap((provider) => window.aimashiModelHelpers.modelsForProvider(provider));
    const current = window.aimashiModelHelpers.catalogEntryForModel(runtime?.model || {});
    if (current && providerIsConnected(current.provider, runtime) && !entries.some((entry) => entry.id === current.id)) return [current, ...entries];
    return entries;
  }

  function renderModelSelectors(runtime = state?.runtime) {
    if (!state || !els) return;
    const engine = window.aimashiEngineOptions.activeAgentEngine();
    if (engine === "claude-code" || engine === "codex") {
      const config = window.aimashiEngineOptions.engineConfigForPersona();
      const entries = window.aimashiEngineOptions.externalModelEntries(engine);
      setSelectOptions(els.quickModelSelect, entries, config.model || "default");
      if (els.quickModelSelect) els.quickModelSelect.disabled = !entries.length;
      setProviderOptions(els.modelSelect, window.aimashiModelHelpers.providerEntries().filter((entry) => !providerIsConnected(entry.provider, runtime)), "");
      return;
    }
    const providers = window.aimashiModelHelpers.providerEntries().filter((entry) => !providerIsConnected(entry.provider, runtime));
    const currentId = window.aimashiModelHelpers.catalogEntryForModel(runtime?.model || {})?.id || window.aimashiModelHelpers.modelKey(runtime?.model || {});
    setProviderOptions(els.modelSelect, providers, "");
    const connectedEntries = connectedModelEntries(runtime);
    setSelectOptions(els.quickModelSelect, connectedEntries, currentId);
    if (els.quickModelSelect) {
      els.quickModelSelect.disabled = !connectedEntries.length;
    }
  }

  function applyModelEntryToFields(entry) {
    if (!els || !entry) return;
    els.modelProvider.value = entry.provider || "";
    els.modelName.value = entry.model || "";
    els.modelKeyEnv.value = entry.apiKeyEnv || "";
    els.modelBaseUrl.value = entry.baseUrl || "";
    els.modelApiMode.value = entry.apiMode || "";
    els.authMethod.value = String(entry.authType || "").startsWith("oauth") ? entry.provider : "api-key";
  }

  function modelAuthCopy(entry, runtime = state?.runtime) {
    const authType = String(entry?.authType || "api_key");
    if (!entry) return { state: "未选择", hint: "选择提供商后，Aimashi 会显示它需要的登录方式。" };
    if (entry.provider === "openai-codex") {
      return runtime?.auth?.codexLoggedIn
        ? { state: "已授权 OpenAI Codex", hint: "OAuth token 已保存在 Aimashi 私有 runtime；具体 Codex 模型在聊天框下方切换。" }
        : { state: "需要 OpenAI 登录", hint: "选择 OpenAI Codex 后，用 OpenAI 登录完成授权；不需要 API key。" };
    }
    if (authType.startsWith("oauth")) {
      return { state: "需要登录", hint: "这个 Hermes Provider 使用 OAuth。点击登录后，Aimashi 会展示浏览器链接、激活码和登录日志。" };
    }
    if (entry.provider === "lmstudio") {
      return { state: "本地服务", hint: "LM Studio 通常不需要 API key；请确认本地服务已启动并加载模型。" };
    }
    return runtime?.model?.provider === entry.provider && runtime?.model?.hasApiKey
      ? { state: "已保存 API key", hint: "留空保存会继续使用已保存的 key；具体模型在聊天框下方切换。" }
      : { state: "需要 API key", hint: `填写 ${entry.apiKeyEnv || "API Key"} 后保存，Aimashi 会写入私有 runtime 并重启 Hermes。` };
  }

  function renderConnectedProviders(runtime = state?.runtime) {
    if (!els || !els.connectedProviderList) return;
    const providers = runtime?.connectedProviders || [];
    els.connectedProviderList.innerHTML = "";
    if (!providers.length) {
      const empty = document.createElement("div");
      empty.className = "connected-provider-empty";
      empty.textContent = "还没有连接模型提供商";
      els.connectedProviderList.appendChild(empty);
      return;
    }
    for (const provider of providers) {
      const row = document.createElement("div");
      row.className = "connected-provider";
      row.innerHTML = `
        <span class="provider-logo-wrap"><img class="provider-logo" src="${escapeHtml(window.aimashiModelHelpers.modelIconSrc({ provider: provider.provider }))}" alt="" onerror="this.style.display='none'"></span>
        <span class="provider-main">
          <strong>${escapeHtml(provider.providerLabel || provider.provider)}</strong>
        </span>
        <span class="provider-check">✓</span>
      `;
      els.connectedProviderList.appendChild(row);
    }
  }

  window.aimashiModelSettings = {
    initModelSettings,
    setEffortSelectOptions,
    syncEffortControl,
    fillModelFieldsFromPreset,
    setSelectOptions,
    syncQuickModelLabel,
    permissionLabelForMode,
    setPermissionSelectOptions,
    syncPermissionControl,
    setProviderOptions,
    providerIsConnected,
    connectedModelEntries,
    renderModelSelectors,
    applyModelEntryToFields,
    modelAuthCopy,
    renderConnectedProviders,
  };
})();
