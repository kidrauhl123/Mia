const els = {
  summary: document.getElementById("adminSummary"),
  badge: document.getElementById("adminStatusBadge"),
  form: document.getElementById("modelAdminForm"),
  publicModel: document.getElementById("publicModelInput"),
  provider: document.getElementById("providerSelect"),
  upstream: document.getElementById("upstreamModelInput"),
  apiKey: document.getElementById("apiKeyInput"),
  apiBase: document.getElementById("apiBaseInput"),
  apiVersion: document.getElementById("apiVersionInput"),
  inputPrice: document.getElementById("inputPriceInput"),
  outputPrice: document.getElementById("outputPriceInput"),
  markup: document.getElementById("markupInput"),
  save: document.getElementById("saveModelButton"),
  test: document.getElementById("testModelButton"),
  output: document.getElementById("adminOutput")
};

function writeOutput(text) {
  els.output.textContent = String(text || "");
}

function setBusy(busy) {
  els.save.disabled = busy;
  els.test.disabled = busy;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function selectedPresetModel() {
  return els.provider.selectedOptions[0]?.dataset?.model || "";
}

function applyProviderPreset() {
  const model = selectedPresetModel();
  if (model) els.upstream.value = model;
}

function setFieldValue(element, value) {
  if (!element) return;
  element.value = value === undefined || value === null ? "" : String(value);
}

function renderDeepSeekStatus(data) {
  const model = data.models?.[0] || {};
  const settings = data.settings || {};
  const configured = Boolean(data.gateway?.configured);
  els.badge.textContent = configured ? "已设置" : "缺 API Key";
  els.summary.textContent = configured
    ? `DeepSeek · ${settings.modelId || model.id || data.modelName || "mia-default"} -> ${settings.upstreamModel || model.upstreamModel || "deepseek-chat"}`
    : "请保存 DeepSeek API Key 后再开放用户调用。";
  els.provider.value = "deepseek";
  setFieldValue(els.publicModel, settings.modelId || model.id || data.modelName || "mia-default");
  setFieldValue(els.upstream, settings.upstreamModel || model.upstreamModel || "deepseek-chat");
  setFieldValue(els.apiBase, settings.apiBase || data.gateway?.baseUrl || "https://api.deepseek.com/v1");
  setFieldValue(els.inputPrice, settings.inputMicrousdPerMillion ?? data.pricing?.inputMicrousdPerMillion ?? 140000);
  setFieldValue(els.outputPrice, settings.outputMicrousdPerMillion ?? data.pricing?.outputMicrousdPerMillion ?? 280000);
  setFieldValue(els.markup, settings.markup ?? data.pricing?.markup ?? 1);
  els.apiKey.required = !configured;
  els.apiKey.placeholder = configured ? "留空则保留已保存 key" : "填写 DeepSeek API Key";
  els.apiVersion.disabled = true;
  els.apiVersion.placeholder = "DeepSeek 直连不需要";
}

function renderLiteLLMStatus(data) {
  els.apiKey.required = true;
  els.apiKey.placeholder = "保存时必须填写";
  els.apiVersion.disabled = false;
  els.apiVersion.placeholder = "可选，Azure 等服务才需要";
  const model = data.models?.[0];
  if (!data.gateway?.adminConfigured) {
    els.badge.textContent = "未配置";
    els.summary.textContent = "服务器还没有配置 LiteLLM 管理 key。";
    return;
  }
  if (!data.gateway?.serviceKeyConfigured) {
    els.badge.textContent = "缺服务 key";
    els.summary.textContent = "Mia 服务还没有注入内部 LiteLLM key。";
    return;
  }
  if (!model) {
    els.badge.textContent = "未设置";
    els.summary.textContent = "还没有配置平台模型。";
    return;
  }
  els.badge.textContent = "已设置";
  const models = Array.isArray(data.models) ? data.models : [];
  els.summary.textContent = `${models.length} 个模型：${models.map((item) => item.model_name).join("、")}`;
  if (!els.publicModel.value && model.model_name) els.publicModel.value = model.model_name;
  if (!els.upstream.value && model.litellm_params?.model) els.upstream.value = model.litellm_params.model;
  if (model.litellm_params?.api_base) els.apiBase.value = model.litellm_params.api_base;
  if (model.litellm_params?.api_version) els.apiVersion.value = model.litellm_params.api_version;
}

function renderStatus(data) {
  if (data.gateway?.mode === "deepseek") {
    renderDeepSeekStatus(data);
    return;
  }
  renderLiteLLMStatus(data);
}

async function loadStatus() {
  try {
    const data = await requestJson("/api/admin/model-gateway");
    renderStatus(data);
    writeOutput(JSON.stringify(data, null, 2));
  } catch (error) {
    els.badge.textContent = "异常";
    els.summary.textContent = error.message;
    writeOutput(error.message);
  }
}

els.provider.addEventListener("change", applyProviderPreset);

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  writeOutput("正在保存...");
  try {
    const data = await requestJson("/api/admin/model-gateway", {
      method: "POST",
      body: JSON.stringify({
        modelName: els.publicModel.value,
        provider: els.provider.value,
        upstreamModel: els.upstream.value,
        apiKey: els.apiKey.value,
        apiBase: els.apiBase.value,
        apiVersion: els.apiVersion.value,
        inputMicrousdPerMillion: els.inputPrice.value,
        outputMicrousdPerMillion: els.outputPrice.value,
        markup: els.markup.value
      })
    });
    els.apiKey.value = "";
    writeOutput(JSON.stringify(data, null, 2));
    await loadStatus();
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
});

els.test.addEventListener("click", async () => {
  setBusy(true);
  writeOutput("正在测试...");
  try {
    const data = await requestJson("/api/admin/model-gateway/test", { method: "POST", body: "{}" });
    writeOutput(JSON.stringify(data, null, 2));
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
});

applyProviderPreset();
loadStatus();
