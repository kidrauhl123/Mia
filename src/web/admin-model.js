const els = {
  summary: document.getElementById("adminSummary"),
  badge: document.getElementById("adminStatusBadge"),
  form: document.getElementById("modelAdminForm"),
  provider: document.getElementById("providerSelect"),
  upstream: document.getElementById("upstreamModelInput"),
  apiKey: document.getElementById("apiKeyInput"),
  apiBase: document.getElementById("apiBaseInput"),
  apiVersion: document.getElementById("apiVersionInput"),
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

function renderStatus(data) {
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
    els.summary.textContent = "还没有配置 mia-default。";
    return;
  }
  els.badge.textContent = "已设置";
  els.summary.textContent = `${model.model_name} -> ${model.litellm_params?.model || "未知模型"}`;
  if (!els.upstream.value && model.litellm_params?.model) els.upstream.value = model.litellm_params.model;
  if (model.litellm_params?.api_base) els.apiBase.value = model.litellm_params.api_base;
  if (model.litellm_params?.api_version) els.apiVersion.value = model.litellm_params.api_version;
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
        provider: els.provider.value,
        upstreamModel: els.upstream.value,
        apiKey: els.apiKey.value,
        apiBase: els.apiBase.value,
        apiVersion: els.apiVersion.value
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
