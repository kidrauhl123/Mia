// Model / provider lookup helpers
// Extracted from app.js. Read-only data layer for the model catalog,
// provider entries, current selection, icon resolution, and display
// labels. Used by both the chat composer and the Settings - Model tab.
//
// All exposed functions have defensive `if (!state) return null/""` guards
// so calling before init is a safe no-op.
(function () {
  "use strict";

  let state, els;
  let providerLabels = {};
  let providerPresets = {};

  function initModelHelpers(deps) {
    state = deps.state;
    els = deps.els;
    if (deps.providerLabels) providerLabels = deps.providerLabels;
    if (deps.providerPresets) providerPresets = deps.providerPresets;
  }

  function modelKey(model = {}) {
    return `${String(model.provider || "").trim()}::${String(model.model || "").trim()}`;
  }

  function fallbackCatalogFromPresets() {
    return Object.values(providerPresets).map((preset) => ({
      id: `${preset.provider}::${preset.model || ""}`,
      provider: preset.provider,
      providerLabel: providerLabels[preset.provider] || preset.provider,
      model: preset.model || "",
      label: preset.model || "Local Model",
      authType: preset.provider === "openai-codex" ? "oauth_external" : "api_key",
      apiKeyEnv: preset.apiKeyEnv,
      baseUrl: preset.baseUrl,
      apiMode: preset.apiMode || "chat_completions"
    }));
  }

  function catalogEntries() {
    if (!state) return [];
    const base = state.modelCatalog.length ? state.modelCatalog : fallbackCatalogFromPresets();
    const current = state.runtime?.model || {};
    const currentId = modelKey(current);
    if (!current.provider || base.some((entry) => entry.id === currentId)) return base;
    return [
      {
        id: currentId,
        provider: current.provider,
        providerLabel: providerLabels[current.provider] || current.provider,
        model: current.model || "",
        label: current.model || "Custom Model",
        authType: current.provider === "openai-codex" ? "oauth_external" : "api_key",
        apiKeyEnv: current.apiKeyEnv || "",
        baseUrl: current.baseUrl || "",
        apiMode: current.apiMode || "chat_completions"
      },
      ...base
    ];
  }

  function catalogEntryForModel(model = {}) {
    const key = modelKey(model);
    return catalogEntries().find((entry) => entry.id === key)
      || catalogEntries().find((entry) => entry.provider === model.provider && entry.model === model.model)
      || null;
  }

  function providerEntries() {
    const providers = new Map();
    for (const entry of catalogEntries()) {
      if (!entry.provider || providers.has(entry.provider)) continue;
      providers.set(entry.provider, {
        ...entry,
        id: entry.provider,
        model: "",
        label: entry.providerLabel || providerLabels[entry.provider] || entry.provider
      });
    }
    return [...providers.values()];
  }

  function modelsForProvider(provider) {
    return catalogEntries().filter((entry) => entry.provider === provider);
  }

  function defaultModelForProvider(provider, runtime = state?.runtime) {
    const current = runtime?.model || {};
    if (current.provider === provider) {
      const currentEntry = catalogEntryForModel(current);
      if (currentEntry) return currentEntry;
    }
    return modelsForProvider(provider).find((entry) => entry.model) || modelsForProvider(provider)[0] || null;
  }

  function providerEntryForProvider(provider) {
    return providerEntries().find((entry) => entry.provider === provider) || null;
  }

  function providerIconSrc(provider = "") {
    const id = String(provider || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    if (!id || id === "custom") return "";
    return `./assets/provider-icons/${id}.svg`;
  }

  function modelIconSrc(model = {}) {
    const id = String(model.model || model.id || model.name || "").toLowerCase();
    const provider = String(model.provider || "").toLowerCase();
    const rules = [
      [/codex|openai-codex/, "chatgpt.jpeg"],
      [/gpt-5\.1-chat/, "gpt-5.1-chat.png"],
      [/gpt-5\.1/, "gpt-5.1.png"],
      [/gpt-5.*mini/, "gpt-5-mini.png"],
      [/gpt-5.*nano/, "gpt-5-nano.png"],
      [/gpt-5/, "gpt-5.png"],
      [/gpt-4/, "gpt_4.png"],
      [/gpt-3/, "gpt_3.5.png"],
      [/claude|anthropic/, "claude.png"],
      [/deepseek/, "deepseek.png"],
      [/grok|xai/, "grok.png"],
      [/qwen|qwq|qvq|wan-/, "qwen.png"],
      [/gemini/, "gemini.png"],
      [/gemma/, "gemma.png"],
      [/llama/, "llama.png"],
      [/mistral|mixtral|codestral|ministral|magistral/, "mixtral.png"],
      [/kimi|moonshot/, "moonshot.webp"],
      [/minimax|abab|m2-her/, "minimax.png"],
      [/mimo/, "mimo.svg"],
      [/nvidia|nemotron/, "nvidia.png"],
      [/copilot/, "copilot.png"],
      [/hermes|nous/, "nousresearch.png"],
      [/hugging/, "huggingface.png"],
      [/glm|zai|zhipu/, "zhipu.png"],
      [/step/, "step.png"]
    ];
    const haystack = `${id} ${provider}`;
    const match = rules.find(([regex]) => regex.test(haystack));
    if (match) return `./assets/model-icons/${match[1]}`;
    return providerIconSrc(provider);
  }

  function providerLabel(provider = "") {
    return providerEntryForProvider(provider)?.providerLabel
      || providerLabels[provider]
      || (state?.runtime?.connectedProviders || []).find((entry) => entry.provider === provider)?.providerLabel
      || provider
      || "Provider";
  }

  function selectedProviderEntry() {
    if (!els) return null;
    const provider = els.modelSelect?.value || "";
    return provider ? providerEntryForProvider(provider) : null;
  }

  function selectedModelEntry() {
    const providerEntry = selectedProviderEntry();
    return providerEntry ? defaultModelForProvider(providerEntry.provider, state?.runtime) : null;
  }

  function presetKeyForModel(model = {}) {
    return catalogEntryForModel(model)?.id || "custom";
  }

  function modelDisplayName(model = {}) {
    const provider = String(model.provider || "").trim();
    const entry = catalogEntryForModel(model);
    const name = entry?.label || String(model.model || "").trim() || (provider === "lmstudio" ? "Local Model" : "未选择模型");
    const label = providerLabel(provider) || "Custom";
    return `${name} | ${label}`;
  }

  window.aimashiModelHelpers = {
    initModelHelpers,
    modelKey,
    fallbackCatalogFromPresets,
    catalogEntries,
    catalogEntryForModel,
    providerEntries,
    modelsForProvider,
    defaultModelForProvider,
    providerEntryForProvider,
    providerIconSrc,
    modelIconSrc,
    providerLabel,
    selectedProviderEntry,
    selectedModelEntry,
    presetKeyForModel,
    modelDisplayName,
  };
})();
