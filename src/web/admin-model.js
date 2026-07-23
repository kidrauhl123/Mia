/*
 * Console behavior adapted from the MIT-licensed One API admin frontend:
 * https://github.com/songquanpeng/one-api
 * Copyright (c) 2023 JustSong
 */
const CUSTOM_UPSTREAM_MODEL_VALUE = "__custom__";

const PAGE_META = {
  overview: { eyebrow: "Dashboard", title: "总览" },
  users: { eyebrow: "Users", title: "用户积分" },
  activities: { eyebrow: "Promotions", title: "新用户活动" },
  logs: { eyebrow: "Logs", title: "调用日志" },
  gateway: { eyebrow: "Gateway", title: "模型网关" }
};

const state = {
  activePage: "overview",
  status: null,
  usage: null,
  campaigns: null,
  selectedUser: null,
  inlinePointUserId: ""
};

const els = {
  consoleEyebrow: document.getElementById("consoleEyebrow"),
  consoleTitle: document.getElementById("consoleTitle"),
  navButtons: Array.from(document.querySelectorAll("[data-admin-nav]")),
  pageNodes: Array.from(document.querySelectorAll("[data-admin-page]")),
  jumpButtons: Array.from(document.querySelectorAll("[data-admin-nav-jump]")),
  notice: document.getElementById("adminNotice"),
  summary: document.getElementById("adminSummary"),
  badge: document.getElementById("adminStatusBadge"),
  form: document.getElementById("modelAdminForm"),
  publicModel: document.getElementById("publicModelInput"),
  provider: document.getElementById("providerSelect"),
  upstreamSelect: document.getElementById("upstreamModelSelect"),
  upstreamCustomWrap: document.getElementById("upstreamCustomWrap"),
  upstreamCustomLabel: document.getElementById("upstreamCustomLabel"),
  upstream: document.getElementById("upstreamModelInput"),
  apiKey: document.getElementById("apiKeyInput"),
  apiBase: document.getElementById("apiBaseInput"),
  apiVersion: document.getElementById("apiVersionInput"),
  cacheHitCost: document.getElementById("cacheHitCostInput"),
  cacheMissCost: document.getElementById("cacheMissCostInput"),
  outputCost: document.getElementById("outputCostInput"),
  pointsPerCnyCost: document.getElementById("pointsPerCnyCostInput"),
  save: document.getElementById("saveModelButton"),
  test: document.getElementById("testModelButton"),
  output: document.getElementById("adminOutput"),
  clearOutput: document.getElementById("clearOutputButton"),
  refreshUsage: document.getElementById("refreshUsageButton"),
  usageSummary: document.getElementById("usageSummaryText"),
  metricUsers: document.getElementById("metricUsers"),
  metricRequests: document.getElementById("metricRequests"),
  metricSuccessText: document.getElementById("metricSuccessText"),
  metricTokens: document.getElementById("metricTokens"),
  metricCharge: document.getElementById("metricCharge"),
  metricBalance: document.getElementById("metricBalance"),
  metricGateway: document.getElementById("metricGateway"),
  metricGatewayDetail: document.getElementById("metricGatewayDetail"),
  overviewUsersBody: document.getElementById("overviewUsersBody"),
  recentUsageList: document.getElementById("recentUsageList"),
  logSearch: document.getElementById("logSearchInput"),
  logStatus: document.getElementById("logStatusSelect"),
  usageLogsBody: document.getElementById("usageLogsBody"),
  userPointForm: document.getElementById("userPointForm"),
  userAccount: document.getElementById("userAccountInput"),
  lookupUser: document.getElementById("lookupUserButton"),
  selectedUserUsage: document.getElementById("selectedUserUsage"),
  usageUsersBody: document.getElementById("usageUsersBody"),
  campaignForm: document.getElementById("campaignForm"),
  campaignName: document.getElementById("campaignNameInput"),
  campaignPoints: document.getElementById("campaignPointsInput"),
  campaignStartsAt: document.getElementById("campaignStartsAtInput"),
  campaignEndsAt: document.getElementById("campaignEndsAtInput"),
  campaignGrantExpiresAt: document.getElementById("campaignGrantExpiresAtInput"),
  campaignMaxClaims: document.getElementById("campaignMaxClaimsInput"),
  createCampaign: document.getElementById("createCampaignButton"),
  campaignList: document.getElementById("campaignList")
};

function setText(element, value) {
  if (element) element.textContent = String(value ?? "");
}

function writeOutput(text) {
  setText(els.output, text || "");
}

function setNotice(text) {
  setText(els.notice, text);
}

function setBusy(busy) {
  [els.save, els.test, els.refreshUsage, els.lookupUser, els.createCampaign].forEach((button) => {
    if (button) button.disabled = Boolean(busy);
  });
  document.querySelectorAll("[data-campaign-action]").forEach((button) => {
    button.disabled = Boolean(busy);
  });
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function pointValue(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(number);
}

function formatPoints(value) {
  return `${pointValue(value)} 积分`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function selectedPresetModel() {
  return els.provider.selectedOptions[0]?.dataset?.model || "";
}

function applyProviderPreset() {
  const model = selectedPresetModel();
  if (model) setUpstreamRawValue(model);
}

function setFieldValue(element, value) {
  if (!element) return;
  element.value = value === undefined || value === null ? "" : String(value);
}

function setFieldVisible(name, visible) {
  document.querySelectorAll(`[data-admin-field="${name}"]`).forEach((node) => {
    node.hidden = !visible;
  });
}

function setUpstreamRawValue(value) {
  setFieldValue(els.upstream, value);
}

function upstreamModelLabel(option = {}) {
  const id = String(option.id || "").trim();
  const label = String(option.label || id).trim() || id;
  const notes = [];
  if (option.source === "deepseek") notes.push("API");
  if (option.deprecated) notes.push("旧别名");
  return notes.length ? `${label} (${notes.join(" · ")})` : label;
}

function setDeepSeekPickerVisible(visible, customVisible = false) {
  if (els.upstreamSelect) els.upstreamSelect.parentElement.hidden = !visible;
  if (els.upstreamCustomWrap) els.upstreamCustomWrap.hidden = visible ? !customVisible : false;
  setText(els.upstreamCustomLabel, visible ? "自定义模型 ID" : "真实模型");
}

function selectedUpstreamModel() {
  const pickerVisible = els.upstreamSelect && !els.upstreamSelect.parentElement.hidden;
  const value = pickerVisible && els.upstreamSelect.value !== CUSTOM_UPSTREAM_MODEL_VALUE
    ? els.upstreamSelect.value
    : els.upstream.value;
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error("请选择真实模型。");
  return normalized;
}

function activeRateCardForModel(upstreamModel) {
  const id = String(upstreamModel || "").trim();
  const cards = Array.isArray(state.status?.rateCards) ? state.status.rateCards : [];
  const found = cards.find((card) => card?.provider === "deepseek" && card?.upstreamModel === id);
  if (found) return found;
  const selected = state.status?.rateCard || state.status?.settings?.rateCard;
  return selected?.upstreamModel === id ? selected : null;
}

function renderRateCard(rateCard = null) {
  setFieldValue(els.cacheHitCost, rateCard?.cacheHitCnyPerMillion ?? "");
  setFieldValue(els.cacheMissCost, rateCard?.cacheMissCnyPerMillion ?? "");
  setFieldValue(els.outputCost, rateCard?.outputCnyPerMillion ?? "");
  setFieldValue(els.pointsPerCnyCost, rateCard?.pointsPerCnyCost ?? 50);
}

function syncRateCardForSelectedModel() {
  if (state.status?.gateway?.mode !== "deepseek") return;
  try {
    renderRateCard(activeRateCardForModel(selectedUpstreamModel()));
  } catch {
    // The custom model field is incomplete while the admin is typing.
  }
}

function syncUpstreamCustomVisibility() {
  const custom = els.upstreamSelect?.value === CUSTOM_UPSTREAM_MODEL_VALUE;
  setDeepSeekPickerVisible(true, custom);
  if (!custom) setUpstreamRawValue(els.upstreamSelect?.value || "");
  syncRateCardForSelectedModel();
}

function renderUpstreamModelOptions(modelOptions, selectedValue) {
  const selected = String(selectedValue || "").trim();
  const options = Array.isArray(modelOptions) ? modelOptions.filter((item) => String(item?.id || "").trim()) : [];
  const rows = options.length ? options : [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-chat", label: "deepseek-chat", deprecated: true },
    { id: "deepseek-reasoner", label: "deepseek-reasoner", deprecated: true }
  ];
  const known = new Set(rows.map((item) => String(item.id).trim()));
  els.upstreamSelect.innerHTML = [
    ...rows.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(upstreamModelLabel(item))}</option>`),
    `<option value="${CUSTOM_UPSTREAM_MODEL_VALUE}" data-custom-value="${CUSTOM_UPSTREAM_MODEL_VALUE}">自定义模型 ID</option>`
  ].join("");
  if (selected && known.has(selected)) {
    els.upstreamSelect.value = selected;
    setUpstreamRawValue(selected);
    setDeepSeekPickerVisible(true, false);
    return;
  }
  if (selected) {
    els.upstreamSelect.value = CUSTOM_UPSTREAM_MODEL_VALUE;
    setUpstreamRawValue(selected);
    setDeepSeekPickerVisible(true, true);
    return;
  }
  els.upstreamSelect.value = rows[0]?.id || CUSTOM_UPSTREAM_MODEL_VALUE;
  syncUpstreamCustomVisibility();
}

function setActivePage(page) {
  const nextPage = PAGE_META[page] ? page : "overview";
  state.activePage = nextPage;
  els.navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.adminNav === nextPage);
  });
  els.pageNodes.forEach((node) => {
    node.classList.toggle("active", node.dataset.adminPage === nextPage);
  });
  setText(els.consoleEyebrow, PAGE_META[nextPage].eyebrow);
  setText(els.consoleTitle, PAGE_META[nextPage].title);
  if (window.location.hash !== `#${nextPage}`) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${nextPage}`);
  }
  if (nextPage === "activities" && !state.campaigns) loadCampaigns({ quiet: true });
}

function renderNotice() {
  const gateway = state.status?.gateway || {};
  const totals = state.usage?.totals || {};
  if (!state.status) {
    setNotice("正在读取模型网关配置...");
    return;
  }
  if (gateway.mode === "deepseek" && !gateway.configured) {
    setNotice("DeepSeek API Key 未配置，用户暂时不能调用平台模型。");
    return;
  }
  if (!state.usage) {
    setNotice("模型网关已读取，正在统计用户用量...");
    return;
  }
  setNotice(
    `网关 ${gateway.mode || "unknown"} 已接入，累计 ${formatNumber(totals.requestCount)} 次请求，` +
    `活跃 ${formatNumber(totals.activeUserCount)} 个用户，已消耗 ${formatPoints(totals.chargePoints)}。`
  );
}

function renderDeepSeekStatus(data) {
  const model = data.models?.[0] || {};
  const settings = data.settings || {};
  const configured = Boolean(data.gateway?.configured);
  const publicModel = settings.modelId || model.id || data.modelName || "mia-auto";
  const upstreamModel = settings.upstreamModel || model.upstreamModel || "deepseek-chat";
  els.badge.textContent = configured ? "已设置" : "缺 Key";
  els.summary.textContent = configured
    ? `DeepSeek · ${publicModel} -> ${upstreamModel}`
    : "请保存 DeepSeek API Key 后再开放用户调用。";
  setText(els.metricGateway, "DeepSeek");
  setText(els.metricGatewayDetail, configured ? `${publicModel} -> ${upstreamModel}` : "缺 API Key");
  els.provider.value = "deepseek";
  setFieldVisible("provider", false);
  setFieldVisible("apiVersion", false);
  setFieldVisible("pointRate", true);
  renderUpstreamModelOptions(data.modelOptions, upstreamModel);
  setFieldValue(els.publicModel, publicModel);
  setFieldValue(els.apiBase, settings.apiBase || data.gateway?.baseUrl || "https://api.deepseek.com/v1");
  renderRateCard(activeRateCardForModel(upstreamModel) || data.rateCard);
  els.apiKey.required = !configured;
  els.apiKey.placeholder = configured ? "留空则保留已保存 key" : "填写 DeepSeek API Key";
  els.apiVersion.disabled = true;
}

function renderLiteLLMStatus(data) {
  setFieldVisible("provider", true);
  setFieldVisible("apiVersion", true);
  setFieldVisible("pointRate", false);
  setDeepSeekPickerVisible(false);
  els.apiKey.required = true;
  els.apiKey.placeholder = "保存时必须填写";
  els.apiVersion.disabled = false;
  setText(els.metricGateway, "LiteLLM");
  const model = data.models?.[0];
  if (!data.gateway?.adminConfigured) {
    els.badge.textContent = "未配置";
    els.summary.textContent = "服务器还没有配置 LiteLLM 管理 key。";
    setText(els.metricGatewayDetail, "缺管理 key");
    return;
  }
  if (!data.gateway?.serviceKeyConfigured) {
    els.badge.textContent = "缺服务 Key";
    els.summary.textContent = "Mia 服务还没有注入内部 LiteLLM key。";
    setText(els.metricGatewayDetail, "缺服务 key");
    return;
  }
  if (!model) {
    els.badge.textContent = "未设置";
    els.summary.textContent = "还没有配置平台模型。";
    setText(els.metricGatewayDetail, "无模型");
    return;
  }
  els.badge.textContent = "已设置";
  const models = Array.isArray(data.models) ? data.models : [];
  els.summary.textContent = `${models.length} 个模型：${models.map((item) => item.model_name).join("、")}`;
  setText(els.metricGatewayDetail, model.model_name || "mia-auto");
  if (!els.publicModel.value && model.model_name) els.publicModel.value = model.model_name;
  if (!els.upstream.value && model.litellm_params?.model) setUpstreamRawValue(model.litellm_params.model);
  if (model.litellm_params?.api_base) els.apiBase.value = model.litellm_params.api_base;
  if (model.litellm_params?.api_version) els.apiVersion.value = model.litellm_params.api_version;
}

function renderStatus(data) {
  state.status = data;
  if (data.gateway?.mode === "deepseek") renderDeepSeekStatus(data);
  else renderLiteLLMStatus(data);
  renderNotice();
}

async function loadStatus({ quiet = false } = {}) {
  try {
    const data = await requestJson("/api/admin/model-gateway");
    renderStatus(data);
    if (!quiet) writeOutput(JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    els.badge.textContent = "异常";
    els.summary.textContent = error.message;
    setText(els.metricGateway, "异常");
    setText(els.metricGatewayDetail, error.message);
    setNotice(`模型网关读取失败：${error.message}`);
    if (!quiet) writeOutput(error.message);
    return null;
  }
}

function userName(user = {}) {
  return user.displayName || user.username || user.account || user.id || "-";
}

function userMeta(user = {}) {
  return user.id ? `UID ${user.id}` : (user.username || user.email || "-");
}

function userSearchText(user = {}) {
  return [user.id, user.displayName, user.username, user.account, user.email].filter(Boolean).join(" ");
}

function userLookupParam(query) {
  const value = String(query || "").trim();
  const key = /^\d+$/.test(value) ? "userId" : "account";
  return `${key}=${encodeURIComponent(value)}`;
}

function balanceCell(user = {}, balance = {}) {
  const userId = String(user.id || "").trim();
  const balanceText = formatPoints(balance.balancePoints);
  if (!userId) return balanceText;
  const active = state.inlinePointUserId === userId;
  return `
    <div class="balance-cell">
      <span>${balanceText}</span>
      <button class="row-point-button" type="button" data-point-open="${escapeHtml(userId)}" aria-label="给 ${escapeHtml(userName(user))} 发放积分">+</button>
    </div>
    ${active ? `
      <form class="row-point-form" data-point-form="${escapeHtml(userId)}">
        <input data-point-amount="${escapeHtml(userId)}" type="number" min="0.001" step="0.001" inputmode="decimal" placeholder="20 积分" autocomplete="off">
        <button class="row-point-confirm" type="submit">确认</button>
        <button class="row-point-cancel" type="button" data-point-cancel="${escapeHtml(userId)}">取消</button>
      </form>
    ` : ""}
  `;
}

function usersTableRows(users, compact = false) {
  if (!users.length) return `<tr><td colspan="${compact ? 4 : 6}">暂无用户用量。</td></tr>`;
  return users.map((entry) => {
    const user = entry.user || {};
    const usage = entry.usage || {};
    const balance = entry.balance || {};
    if (compact) {
      return `
        <tr>
          <td><strong>${escapeHtml(userName(user))}</strong><div class="muted">${escapeHtml(userMeta(user))}</div></td>
          <td>${balanceCell(user, balance)}</td>
          <td>${formatNumber(usage.requestCount)}</td>
          <td>${formatPoints(usage.chargePoints)}</td>
        </tr>
      `;
    }
    return `
      <tr>
        <td><strong>${escapeHtml(userName(user))}</strong><div class="muted">${escapeHtml(userMeta(user))}</div></td>
        <td>${balanceCell(user, balance)}</td>
        <td>${formatNumber(usage.requestCount)}<div class="muted">失败 ${formatNumber(usage.failedCount)}</div></td>
        <td>${formatNumber(usage.totalTokens)}<div class="muted">${formatNumber(usage.promptTokens)} / ${formatNumber(usage.completionTokens)}</div></td>
        <td>${formatPoints(usage.chargePoints)}</td>
        <td>${formatTime(usage.lastUsedAt)}</td>
      </tr>
    `;
  }).join("");
}

function userForUsage(log = {}) {
  if (log.user) return log.user;
  const users = Array.isArray(state.usage?.users) ? state.usage.users : [];
  return users.find((entry) => entry.user?.id === log.userId)?.user || { id: log.userId };
}

function filteredLogs() {
  const logs = Array.isArray(state.usage?.recentUsage) ? state.usage.recentUsage : [];
  const needle = String(els.logSearch?.value || "").trim().toLowerCase();
  const status = String(els.logStatus?.value || "").trim();
  return logs.filter((log) => {
    if (status && log.status !== status) return false;
    if (!needle) return true;
    const user = userForUsage(log);
    return [log.modelId, log.upstreamModel, log.provider, log.status, log.error, userSearchText(user)]
      .join(" ").toLowerCase().includes(needle);
  });
}

function statusPill(status) {
  const ok = status === "succeeded";
  return `<span class="status-pill ${ok ? "ok" : "fail"}">${ok ? "成功" : "失败"}</span>`;
}

function renderLogs() {
  const logs = filteredLogs();
  if (!logs.length) {
    els.usageLogsBody.innerHTML = '<tr><td colspan="8">暂无匹配的调用日志。</td></tr>';
    return;
  }
  els.usageLogsBody.innerHTML = logs.map((log) => {
    const user = userForUsage(log);
    const error = log.error ? escapeHtml(log.error) : "-";
    return `
      <tr>
        <td>${formatTime(log.createdAt)}</td>
        <td><strong>${escapeHtml(userName(user))}</strong><div class="muted">${escapeHtml(userMeta(user))}</div></td>
        <td>${escapeHtml(log.modelId || "-")}<div class="muted">${escapeHtml(log.upstreamModel || log.provider || "-")}</div></td>
        <td>${statusPill(log.status)}</td>
        <td>${formatNumber(log.promptTokens)}</td>
        <td>${formatNumber(log.completionTokens)}</td>
        <td>${formatPoints(log.chargePoints)}</td>
        <td class="error-cell">${error}</td>
      </tr>
    `;
  }).join("");
}

function renderRecentUsageList(logs) {
  if (!logs.length) {
    els.recentUsageList.innerHTML = '<div class="event-row">暂无模型调用。</div>';
    return;
  }
  els.recentUsageList.innerHTML = logs.slice(0, 8).map((log) => {
    const user = userForUsage(log);
    return `
      <div class="event-row">
        <strong>${escapeHtml(userName(user))} · ${escapeHtml(log.modelId || "-")}</strong>
        <span>${statusPill(log.status)} ${formatNumber(log.totalTokens)} tokens · ${formatPoints(log.chargePoints)} · ${formatTime(log.createdAt)}</span>
        ${log.error ? `<span>${escapeHtml(log.error)}</span>` : ""}
      </div>
    `;
  }).join("");
}

function renderUsageSummary(data) {
  state.usage = data;
  const totals = data.totals || {};
  const users = Array.isArray(data.users) ? data.users : [];
  const logs = Array.isArray(data.recentUsage) ? data.recentUsage : [];
  setText(els.metricUsers, `${formatNumber(totals.userCount)} / ${formatNumber(totals.activeUserCount)}`);
  setText(els.metricRequests, formatNumber(totals.requestCount));
  setText(els.metricSuccessText, `成功 ${formatNumber(totals.succeededCount)} / 失败 ${formatNumber(totals.failedCount)}`);
  setText(els.metricTokens, formatNumber(totals.totalTokens));
  setText(els.metricCharge, formatPoints(totals.chargePoints));
  setText(els.metricBalance, formatPoints(totals.balancePoints));
  setText(
    els.usageSummary,
    `总用户 ${formatNumber(totals.userCount)}，活跃 ${formatNumber(totals.activeUserCount)}，成功 ${formatNumber(totals.succeededCount)} 次，失败 ${formatNumber(totals.failedCount)} 次`
  );
  els.overviewUsersBody.innerHTML = usersTableRows(users.slice(0, 8), true);
  els.usageUsersBody.innerHTML = usersTableRows(users, false);
  renderRecentUsageList(logs);
  renderLogs();
  renderNotice();
}

async function loadUsageSummary({ quiet = false } = {}) {
  try {
    const data = await requestJson("/api/admin/model-usage-summary");
    renderUsageSummary(data);
    if (!quiet) writeOutput(JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    setText(els.usageSummary, error.message);
    els.overviewUsersBody.innerHTML = '<tr><td colspan="4">统计读取失败。</td></tr>';
    els.usageUsersBody.innerHTML = '<tr><td colspan="6">统计读取失败。</td></tr>';
    els.usageLogsBody.innerHTML = '<tr><td colspan="8">统计读取失败。</td></tr>';
    els.recentUsageList.innerHTML = `<div class="event-row">${escapeHtml(error.message)}</div>`;
    setNotice(`模型用量读取失败：${error.message}`);
    if (!quiet) writeOutput(error.message);
    return null;
  }
}

function campaignStatusText(campaign = {}) {
  if (campaign.status === "active" && campaign.isLive) return "进行中";
  if (campaign.status === "active" && Date.parse(campaign.startsAt || "") > Date.now()) return "待开始";
  if (campaign.status === "active") return "已结束";
  if (campaign.status === "paused") return "已暂停";
  if (campaign.status === "ended") return "已结束";
  return "草稿";
}

function campaignWindowText(campaign = {}) {
  const startsAt = formatTime(campaign.startsAt);
  const endsAt = campaign.endsAt ? formatTime(campaign.endsAt) : "长期有效";
  return `${startsAt} 至 ${endsAt}`;
}

function campaignGrantExpiryText(campaign = {}) {
  return campaign.grantExpiresAt ? `积分至 ${formatTime(campaign.grantExpiresAt)} 失效` : "积分长期有效";
}

function campaignLimitText(campaign = {}) {
  const claimed = formatNumber(campaign.claimedCount);
  if (!Number(campaign.maxClaims)) return `已发放 ${claimed} 人`;
  return `已发放 ${claimed} / ${formatNumber(campaign.maxClaims)} 人`;
}

function campaignActions(campaign = {}) {
  const id = escapeHtml(campaign.id);
  if (campaign.status === "active") {
    return `<button class="admin-secondary campaign-action" type="button" data-campaign-action="pause" data-campaign-id="${id}">暂停</button>`;
  }
  if (campaign.status === "draft" || campaign.status === "paused") {
    return `<button class="admin-primary campaign-action" type="button" data-campaign-action="activate" data-campaign-id="${id}">启用</button>`;
  }
  return "";
}

function renderCampaigns(data = {}) {
  const campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
  state.campaigns = campaigns;
  if (!els.campaignList) return;
  if (!campaigns.length) {
    els.campaignList.innerHTML = '<div class="event-row">还没有活动。先创建一份草稿。</div>';
    return;
  }
  els.campaignList.innerHTML = campaigns.map((campaign) => `
    <article class="campaign-row">
      <div class="campaign-main">
        <div class="campaign-title-row">
          <strong>${escapeHtml(campaign.name)}</strong>
          <span class="campaign-status ${escapeHtml(campaign.status || "draft")}">${escapeHtml(campaignStatusText(campaign))}</span>
        </div>
        <div class="campaign-meta">
          <span>每人 ${formatPoints(campaign.grantPoints)}</span>
          <span>${escapeHtml(campaignLimitText(campaign))}</span>
          <span>${escapeHtml(campaignWindowText(campaign))}</span>
          <span>${escapeHtml(campaignGrantExpiryText(campaign))}</span>
        </div>
      </div>
      <div class="campaign-actions">${campaignActions(campaign)}</div>
    </article>
  `).join("");
}

async function loadCampaigns({ quiet = false } = {}) {
  if (!els.campaignList) return null;
  try {
    const data = await requestJson("/api/admin/model-point-campaigns");
    renderCampaigns(data);
    if (!quiet) writeOutput(JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    state.campaigns = [];
    els.campaignList.innerHTML = `<div class="event-row">${escapeHtml(error.message)}</div>`;
    if (!quiet) writeOutput(error.message);
    return null;
  }
}

function dateTimeInputValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function isoFromDateTimeInput(value, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error(`${label}无效。`);
  return new Date(timestamp).toISOString();
}

async function createCampaign(event) {
  event.preventDefault();
  setBusy(true);
  try {
    const name = els.campaignName?.value.trim();
    const points = Number(els.campaignPoints?.value);
    const startsAt = isoFromDateTimeInput(els.campaignStartsAt?.value, "活动开始时间");
    const endsAt = isoFromDateTimeInput(els.campaignEndsAt?.value, "活动结束时间");
    const grantExpiresAt = isoFromDateTimeInput(els.campaignGrantExpiresAt?.value, "积分有效期");
    const maxClaimsText = String(els.campaignMaxClaims?.value || "").trim();
    if (!name) throw new Error("请填写活动名称。");
    if (!Number.isFinite(points) || points <= 0) throw new Error("请填写正数赠送积分。");
    if (!startsAt) throw new Error("请填写活动开始时间。");
    const payload = { name, points, startsAt, ...(endsAt ? { endsAt } : {}), ...(grantExpiresAt ? { grantExpiresAt } : {}) };
    if (maxClaimsText) {
      const maxClaims = Number(maxClaimsText);
      if (!Number.isSafeInteger(maxClaims) || maxClaims <= 0) throw new Error("总名额必须是正整数。");
      payload.maxClaims = maxClaims;
    }
    const data = await requestJson("/api/admin/model-point-campaigns", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    els.campaignForm.reset();
    if (els.campaignStartsAt) els.campaignStartsAt.value = dateTimeInputValue();
    writeOutput(JSON.stringify(data, null, 2));
    await loadCampaigns({ quiet: true });
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
}

async function updateCampaignStatus(event) {
  const button = event.target.closest("[data-campaign-action]");
  if (!button) return;
  const id = String(button.dataset.campaignId || "").trim();
  const action = String(button.dataset.campaignAction || "").trim();
  if (!id || !action) return;
  setBusy(true);
  try {
    const status = action === "activate" ? "active" : "paused";
    const data = await requestJson(`/api/admin/model-point-campaigns/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    writeOutput(JSON.stringify(data, null, 2));
    await loadCampaigns({ quiet: true });
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
}

function renderUserDetail(data) {
  const user = data.user || {};
  const balance = data.balance || {};
  const usage = Array.isArray(data.recentUsage) ? data.recentUsage : [];
  state.selectedUser = user;
  const recent = usage.slice(0, 6).map((item) => (
    `<div>${escapeHtml(item.modelId || "-")} · ${statusPill(item.status)} · ${formatNumber(item.totalTokens)} tokens · ${formatPoints(item.chargePoints)} · ${formatTime(item.createdAt)}</div>`
  )).join("") || "<div>暂无调用记录。</div>";
  els.selectedUserUsage.hidden = false;
  els.selectedUserUsage.innerHTML = `
    <div><strong>${escapeHtml(userName(user))}</strong> · 积分 ${formatPoints(balance.balancePoints)}</div>
    ${recent}
  `;
}

async function lookupUser({ quiet = false } = {}) {
  const account = els.userAccount.value.trim();
  if (!account) throw new Error("请填写 UID 或用户账号。");
  const data = await requestJson(`/api/admin/model-points?${userLookupParam(account)}`);
  renderUserDetail(data);
  if (!quiet) writeOutput(JSON.stringify(data, null, 2));
  return data;
}

function numericInputValue(element, label, { min = 0, strictPositive = false } = {}) {
  const raw = String(element?.value || "").trim();
  if (!raw) throw new Error(`请填写${label}。`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (strictPositive && value <= 0)) {
    throw new Error(`${label}格式不对。`);
  }
  return value;
}

function pointRateCardInput() {
  return {
    cacheHitCnyPerMillion: numericInputValue(els.cacheHitCost, "缓存命中输入成本"),
    cacheMissCnyPerMillion: numericInputValue(els.cacheMissCost, "缓存未命中输入成本"),
    outputCnyPerMillion: numericInputValue(els.outputCost, "输出成本"),
    pointsPerCnyCost: numericInputValue(els.pointsPerCnyCost, "每元成本折算积分", { strictPositive: true })
  };
}

async function saveGateway(event) {
  event.preventDefault();
  setBusy(true);
  writeOutput("正在保存...");
  try {
    const payload = {
      modelName: els.publicModel.value,
      provider: els.provider.value,
      upstreamModel: selectedUpstreamModel(),
      apiKey: els.apiKey.value,
      apiBase: els.apiBase.value,
      apiVersion: els.apiVersion.value
    };
    if (state.status?.gateway?.mode === "deepseek") payload.rateCard = pointRateCardInput();
    const data = await requestJson("/api/admin/model-gateway", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    els.apiKey.value = "";
    writeOutput(JSON.stringify(data, null, 2));
    await loadStatus({ quiet: true });
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
}

async function testGateway() {
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
}

async function refreshAll() {
  setBusy(true);
  writeOutput("正在刷新...");
  try {
    await Promise.all([loadStatus({ quiet: true }), loadUsageSummary({ quiet: true }), loadCampaigns({ quiet: true })]);
    writeOutput("已刷新。");
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
}

function focusInlinePointInput(userId) {
  const input = Array.from(document.querySelectorAll("[data-point-amount]"))
    .find((node) => node.dataset.pointAmount === userId);
  if (input) input.focus();
}

function rerenderUsageTables() {
  if (state.usage) renderUsageSummary(state.usage);
}

async function grantInlinePoints(userId, points) {
  if (!userId) throw new Error("缺少用户 UID。");
  if (!Number.isFinite(points) || points <= 0) throw new Error("请填写正数积分。");
  setBusy(true);
  try {
    const data = await requestJson("/api/admin/model-points/grant", {
      method: "POST",
      body: JSON.stringify({ userId, points, reason: "admin_panel" })
    });
    state.inlinePointUserId = "";
    writeOutput(JSON.stringify(data, null, 2));
    await loadUsageSummary({ quiet: true });
  } finally {
    setBusy(false);
  }
}

function handlePointTableClick(event) {
  const open = event.target.closest("[data-point-open]");
  if (open) {
    state.inlinePointUserId = String(open.dataset.pointOpen || "");
    rerenderUsageTables();
    focusInlinePointInput(state.inlinePointUserId);
    return;
  }
  const cancel = event.target.closest("[data-point-cancel]");
  if (cancel) {
    state.inlinePointUserId = "";
    rerenderUsageTables();
  }
}

async function handlePointTableSubmit(event) {
  const form = event.target.closest("[data-point-form]");
  if (!form) return;
  event.preventDefault();
  const userId = String(form.dataset.pointForm || "");
  const input = form.querySelector("[data-point-amount]");
  try {
    await grantInlinePoints(userId, Number(input?.value));
  } catch (error) {
    writeOutput(error.message);
  }
}

function initialPage() {
  return window.location.hash.replace(/^#/, "") || "overview";
}

els.navButtons.forEach((button) => {
  button.addEventListener("click", () => setActivePage(button.dataset.adminNav));
});

els.jumpButtons.forEach((button) => {
  button.addEventListener("click", () => setActivePage(button.dataset.adminNavJump));
});

window.addEventListener("hashchange", () => setActivePage(initialPage()));
els.provider.addEventListener("change", applyProviderPreset);
els.upstreamSelect.addEventListener("change", syncUpstreamCustomVisibility);
els.form.addEventListener("submit", saveGateway);
els.test.addEventListener("click", testGateway);
els.refreshUsage.addEventListener("click", refreshAll);
els.clearOutput.addEventListener("click", () => writeOutput("等待操作。"));
els.logSearch.addEventListener("input", renderLogs);
els.logStatus.addEventListener("change", renderLogs);
els.overviewUsersBody.addEventListener("click", handlePointTableClick);
els.usageUsersBody.addEventListener("click", handlePointTableClick);
els.overviewUsersBody.addEventListener("submit", handlePointTableSubmit);
els.usageUsersBody.addEventListener("submit", handlePointTableSubmit);
els.campaignForm?.addEventListener("submit", createCampaign);
els.campaignList?.addEventListener("click", updateCampaignStatus);
els.userPointForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  try {
    await lookupUser();
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
});

if (els.campaignStartsAt && !els.campaignStartsAt.value) {
  els.campaignStartsAt.value = dateTimeInputValue();
}
applyProviderPreset();
setActivePage(initialPage());
loadStatus({ quiet: true });
loadUsageSummary({ quiet: true });
loadCampaigns({ quiet: true });
