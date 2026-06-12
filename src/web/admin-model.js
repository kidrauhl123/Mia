/*
 * Console behavior adapted from the MIT-licensed One API admin frontend:
 * https://github.com/songquanpeng/one-api
 * Copyright (c) 2023 JustSong
 */
const MICRO_USD = 1_000_000;

const PAGE_META = {
  overview: { eyebrow: "Dashboard", title: "总览" },
  users: { eyebrow: "Users", title: "用户用量" },
  logs: { eyebrow: "Logs", title: "调用日志" },
  gateway: { eyebrow: "Gateway", title: "模型网关" }
};

const state = {
  activePage: "overview",
  status: null,
  usage: null,
  selectedUser: null,
  inlineCreditUserId: ""
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
  upstream: document.getElementById("upstreamModelInput"),
  apiKey: document.getElementById("apiKeyInput"),
  apiBase: document.getElementById("apiBaseInput"),
  apiVersion: document.getElementById("apiVersionInput"),
  inputPrice: document.getElementById("inputPriceInput"),
  outputPrice: document.getElementById("outputPriceInput"),
  markup: document.getElementById("markupInput"),
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
  userCreditForm: document.getElementById("userCreditForm"),
  userAccount: document.getElementById("userAccountInput"),
  creditAmount: document.getElementById("creditAmountInput"),
  lookupUser: document.getElementById("lookupUserButton"),
  grantCredit: document.getElementById("grantCreditButton"),
  selectedUserUsage: document.getElementById("selectedUserUsage"),
  usageUsersBody: document.getElementById("usageUsersBody")
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
  [els.save, els.test, els.refreshUsage, els.lookupUser, els.grantCredit].forEach((button) => {
    if (button) button.disabled = Boolean(busy);
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

function formatUsdFromMicro(value) {
  const usd = Number(value || 0) / MICRO_USD;
  if (!usd) return "$0";
  return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
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
  if (model) els.upstream.value = model;
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
    `活跃 ${formatNumber(totals.activeUserCount)} 个用户，已扣费 ${formatUsdFromMicro(totals.chargeMicrousd)}。`
  );
}

function renderDeepSeekStatus(data) {
  const model = data.models?.[0] || {};
  const settings = data.settings || {};
  const configured = Boolean(data.gateway?.configured);
  const publicModel = settings.modelId || model.id || data.modelName || "mia-default";
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
  setFieldValue(els.publicModel, publicModel);
  setFieldValue(els.upstream, upstreamModel);
  setFieldValue(els.apiBase, settings.apiBase || data.gateway?.baseUrl || "https://api.deepseek.com/v1");
  setFieldValue(els.inputPrice, settings.inputMicrousdPerMillion ?? data.pricing?.inputMicrousdPerMillion ?? 140000);
  setFieldValue(els.outputPrice, settings.outputMicrousdPerMillion ?? data.pricing?.outputMicrousdPerMillion ?? 280000);
  setFieldValue(els.markup, settings.markup ?? data.pricing?.markup ?? 1);
  els.apiKey.required = !configured;
  els.apiKey.placeholder = configured ? "留空则保留已保存 key" : "填写 DeepSeek API Key";
  els.apiVersion.disabled = true;
}

function renderLiteLLMStatus(data) {
  setFieldVisible("provider", true);
  setFieldVisible("apiVersion", true);
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
  setText(els.metricGatewayDetail, model.model_name || "mia-default");
  if (!els.publicModel.value && model.model_name) els.publicModel.value = model.model_name;
  if (!els.upstream.value && model.litellm_params?.model) els.upstream.value = model.litellm_params.model;
  if (model.litellm_params?.api_base) els.apiBase.value = model.litellm_params.api_base;
  if (model.litellm_params?.api_version) els.apiVersion.value = model.litellm_params.api_version;
}

function renderStatus(data) {
  state.status = data;
  if (data.gateway?.mode === "deepseek") {
    renderDeepSeekStatus(data);
  } else {
    renderLiteLLMStatus(data);
  }
  renderNotice();
}

async function loadStatus({ quiet = false } = {}) {
  try {
    const data = await requestJson("/api/admin/model-gateway");
    renderStatus(data);
    if (!quiet) writeOutput(JSON.stringify(data, null, 2));
  } catch (error) {
    els.badge.textContent = "异常";
    els.summary.textContent = error.message;
    setText(els.metricGateway, "异常");
    setText(els.metricGatewayDetail, error.message);
    setNotice(`模型网关读取失败：${error.message}`);
    if (!quiet) writeOutput(error.message);
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

function userCreditPayload(query, amountUsd) {
  const value = String(query || "").trim();
  return /^\d+$/.test(value)
    ? { userId: value, amountUsd, reason: "admin_panel" }
    : { account: value, amountUsd, reason: "admin_panel" };
}

function balanceCell(user = {}, balance = {}) {
  const userId = String(user.id || "").trim();
  const balanceText = formatUsdFromMicro(balance.balanceMicrousd);
  if (!userId) return balanceText;
  const active = state.inlineCreditUserId === userId;
  return `
    <div class="balance-cell">
      <span>${balanceText}</span>
      <button class="row-credit-button" type="button" data-credit-open="${escapeHtml(userId)}" aria-label="给 ${escapeHtml(userName(user))} 发放余额">+</button>
    </div>
    ${active ? `
      <form class="row-credit-form" data-credit-form="${escapeHtml(userId)}">
        <input data-credit-amount="${escapeHtml(userId)}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="USD" autocomplete="off">
        <button class="row-credit-confirm" type="submit">确认</button>
        <button class="row-credit-cancel" type="button" data-credit-cancel="${escapeHtml(userId)}">取消</button>
      </form>
    ` : ""}
  `;
}

function usersTableRows(users, compact = false) {
  if (!users.length) {
    return `<tr><td colspan="${compact ? 4 : 6}">暂无用户用量。</td></tr>`;
  }
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
          <td>${formatUsdFromMicro(usage.chargeMicrousd)}</td>
        </tr>
      `;
    }
    return `
      <tr>
        <td><strong>${escapeHtml(userName(user))}</strong><div class="muted">${escapeHtml(userMeta(user))}</div></td>
        <td>${balanceCell(user, balance)}</td>
        <td>${formatNumber(usage.requestCount)}<div class="muted">失败 ${formatNumber(usage.failedCount)}</div></td>
        <td>${formatNumber(usage.totalTokens)}<div class="muted">${formatNumber(usage.promptTokens)} / ${formatNumber(usage.completionTokens)}</div></td>
        <td>${formatUsdFromMicro(usage.chargeMicrousd)}</td>
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
    const haystack = [
      log.modelId,
      log.upstreamModel,
      log.provider,
      log.status,
      log.error,
      userSearchText(user)
    ].join(" ").toLowerCase();
    return haystack.includes(needle);
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
        <td>${formatUsdFromMicro(log.chargeMicrousd)}</td>
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
        <span>${statusPill(log.status)} ${formatNumber(log.totalTokens)} tokens · ${formatUsdFromMicro(log.chargeMicrousd)} · ${formatTime(log.createdAt)}</span>
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
  setText(els.metricCharge, formatUsdFromMicro(totals.chargeMicrousd));
  setText(els.metricBalance, formatUsdFromMicro(totals.balanceMicrousd));
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
  } catch (error) {
    setText(els.usageSummary, error.message);
    els.overviewUsersBody.innerHTML = '<tr><td colspan="4">统计读取失败。</td></tr>';
    els.usageUsersBody.innerHTML = '<tr><td colspan="6">统计读取失败。</td></tr>';
    els.usageLogsBody.innerHTML = '<tr><td colspan="8">统计读取失败。</td></tr>';
    els.recentUsageList.innerHTML = `<div class="event-row">${escapeHtml(error.message)}</div>`;
    setNotice(`模型用量读取失败：${error.message}`);
    if (!quiet) writeOutput(error.message);
  }
}

function renderUserDetail(data) {
  const user = data.user || {};
  const balance = data.balance || {};
  const usage = Array.isArray(data.recentUsage) ? data.recentUsage : [];
  state.selectedUser = user;
  const recent = usage.slice(0, 6).map((item) => (
    `<div>${escapeHtml(item.modelId || "-")} · ${statusPill(item.status)} · ${formatNumber(item.totalTokens)} tokens · ${formatUsdFromMicro(item.chargeMicrousd)} · ${formatTime(item.createdAt)}</div>`
  )).join("") || "<div>暂无调用记录。</div>";
  els.selectedUserUsage.hidden = false;
  els.selectedUserUsage.innerHTML = `
    <div><strong>${escapeHtml(userName(user))}</strong> · 余额 ${formatUsdFromMicro(balance.balanceMicrousd)}</div>
    ${recent}
  `;
}

async function lookupUser({ quiet = false } = {}) {
  const account = els.userAccount.value.trim();
  if (!account) throw new Error("请填写 UID 或用户账号。");
  const data = await requestJson(`/api/admin/model-credits?${userLookupParam(account)}`);
  renderUserDetail(data);
  if (!quiet) writeOutput(JSON.stringify(data, null, 2));
  return data;
}

async function saveGateway(event) {
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
    await Promise.all([loadStatus({ quiet: true }), loadUsageSummary({ quiet: true })]);
    writeOutput("已刷新。");
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
}

async function grantCredit() {
  setBusy(true);
  try {
    const account = els.userAccount.value.trim();
    const amountUsd = Number(els.creditAmount.value);
    if (!account) throw new Error("请填写 UID 或用户账号。");
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("请填写正数充值金额。");
    const data = await requestJson("/api/admin/model-credits/grant", {
      method: "POST",
      body: JSON.stringify(userCreditPayload(account, amountUsd))
    });
    writeOutput(JSON.stringify(data, null, 2));
    await lookupUser({ quiet: true });
    await loadUsageSummary({ quiet: true });
  } catch (error) {
    writeOutput(error.message);
  } finally {
    setBusy(false);
  }
}

function focusInlineCreditInput(userId) {
  const input = Array.from(document.querySelectorAll("[data-credit-amount]"))
    .find((node) => node.dataset.creditAmount === userId);
  if (input) input.focus();
}

function rerenderUsageTables() {
  if (state.usage) renderUsageSummary(state.usage);
}

async function grantInlineCredit(userId, amountUsd) {
  if (!userId) throw new Error("缺少用户 UID。");
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("请填写正数充值金额。");
  setBusy(true);
  try {
    const data = await requestJson("/api/admin/model-credits/grant", {
      method: "POST",
      body: JSON.stringify({ userId, amountUsd, reason: "admin_panel" })
    });
    state.inlineCreditUserId = "";
    writeOutput(JSON.stringify(data, null, 2));
    await loadUsageSummary({ quiet: true });
  } finally {
    setBusy(false);
  }
}

function handleCreditTableClick(event) {
  const open = event.target.closest("[data-credit-open]");
  if (open) {
    state.inlineCreditUserId = String(open.dataset.creditOpen || "");
    rerenderUsageTables();
    focusInlineCreditInput(state.inlineCreditUserId);
    return;
  }
  const cancel = event.target.closest("[data-credit-cancel]");
  if (cancel) {
    state.inlineCreditUserId = "";
    rerenderUsageTables();
  }
}

async function handleCreditTableSubmit(event) {
  const form = event.target.closest("[data-credit-form]");
  if (!form) return;
  event.preventDefault();
  const userId = String(form.dataset.creditForm || "");
  const input = form.querySelector("[data-credit-amount]");
  try {
    await grantInlineCredit(userId, Number(input?.value));
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
els.form.addEventListener("submit", saveGateway);
els.test.addEventListener("click", testGateway);
els.refreshUsage.addEventListener("click", refreshAll);
els.clearOutput.addEventListener("click", () => writeOutput("等待操作。"));
els.logSearch.addEventListener("input", renderLogs);
els.logStatus.addEventListener("change", renderLogs);
els.overviewUsersBody.addEventListener("click", handleCreditTableClick);
els.usageUsersBody.addEventListener("click", handleCreditTableClick);
els.overviewUsersBody.addEventListener("submit", handleCreditTableSubmit);
els.usageUsersBody.addEventListener("submit", handleCreditTableSubmit);
els.userCreditForm.addEventListener("submit", async (event) => {
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
els.grantCredit?.addEventListener("click", grantCredit);

applyProviderPreset();
setActivePage(initialPage());
loadStatus({ quiet: true });
loadUsageSummary({ quiet: true });
