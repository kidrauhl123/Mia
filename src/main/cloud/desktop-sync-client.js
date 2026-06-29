"use strict";

const {
  DEFAULT_SKILL_MARKET_CACHE_TTL_MS,
  normalizeSkillMarketParams
} = require("../skills/skill-market-cache.js");

function createCloudDesktopSyncClient({
  getCloudSettings,
  writeCloudSettings,
  normalizeCloudUrl,
  cloudStatus,
  appendLog,
  fetchImpl = fetch,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  writeUserProfile,
  writeAppearanceSettings,
  runtimePaths,
  readJson,
  startCloudEvents,
  startCloudBridge,
  stopCloudEvents,
  stopCloudBridge,
  skillMarketCache = null,
  skillMarketCacheTtlMs = DEFAULT_SKILL_MARKET_CACHE_TTL_MS,
  now = () => Date.now(),
  waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  function settings() {
    return typeof getCloudSettings === "function" ? getCloudSettings() : {};
  }

  function status(includeToken = false) {
    return typeof cloudStatus === "function" ? cloudStatus(includeToken) : {};
  }

  function log(line) {
    if (typeof appendLog === "function") appendLog(line);
  }

  async function cloudApi(pathSegment, { method = "GET", body = null, token = "" } = {}) {
    const current = settings();
    const baseUrl = normalizeCloudUrl(current.url);
    const headers = { "Content-Type": "application/json" };
    const bearer = token || current.token;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetchImpl(`${baseUrl}${pathSegment}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutSignal(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Mia Cloud ${response.status}`);
    return data;
  }

  function profileSyncBody(profile = {}) {
    const body = {
      displayName: String(profile.displayName || ""),
      avatarImage: String(profile.avatarImage || ""),
      avatarCrop: profile.avatarCrop || null,
      avatarColor: String(profile.avatarColor || "")
    };
    if (Object.prototype.hasOwnProperty.call(profile, "statusBadge")) {
      body.statusBadge = profile.statusBadge || null;
    }
    return body;
  }

  async function pushUserProfile(profileOverride = null) {
    const current = settings();
    if (!current.enabled || !current.token) return;
    const profile = profileOverride || readJson(runtimePaths().userProfile, null);
    if (!profile) return;
    const body = profileSyncBody(profile);
    try {
      const data = await cloudApi("/api/me/profile", { method: "PATCH", body });
      if (data && data.user) {
        await writeCloudSettings({ user: data.user });
      }
    } catch (error) {
      log(`Mia Cloud profile sync failed: ${error?.message || error}`);
    }
  }

  async function saveUserProfile(profile = {}) {
    const saved = typeof writeUserProfile === "function"
      ? writeUserProfile(profile)
      : profile;
    await pushUserProfile(saved);
    return status(false);
  }

  async function saveAppearanceSettings(settingsInput = {}) {
    if (typeof writeAppearanceSettings === "function") {
      writeAppearanceSettings(settingsInput);
    }
    return status(false);
  }

  async function syncWorkspace() {
    const current = settings();
    if (!current.enabled || !current.token) return status(false);
    try {
      const data = await cloudApi("/api/me");
      await writeCloudSettings({ user: data?.user || current.user });
    } catch (error) {
      log(`Mia Cloud /api/me refresh failed: ${error?.message || error}`);
    }
    return status(false);
  }

  async function getUserSettings() {
    const data = await cloudApi("/api/me/settings", { method: "GET" });
    return data && data.settings ? data.settings : {
      pins: [],
      readMarks: {},
      appearance: {},
      tags: { items: [], assignments: {} },
      starterEngineBots: {}
    };
  }

  async function putUserSettings(nextSettings) {
    const data = await cloudApi("/api/me/settings", { method: "PUT", body: nextSettings || {} });
    return data && data.settings ? data.settings : null;
  }

  function skillMarketCacheUserId(current = settings()) {
    return String(current?.user?.id || current?.user?.username || "").trim();
  }

  async function fetchMarketSkillsFromCloud(params) {
    const query = new URLSearchParams();
    if (params.category) query.set("category", params.category);
    if (params.q) query.set("q", params.q);
    if (params.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    const data = await cloudApi(`/api/skills${qs ? `?${qs}` : ""}`, { method: "GET" });
    return {
      skills: Array.isArray(data.skills) ? data.skills : [],
      categories: Array.isArray(data.categories) ? data.categories : []
    };
  }

  async function listMarketSkills(params = {}) {
    const normalized = normalizeSkillMarketParams(params);
    const current = settings();
    const userId = skillMarketCacheUserId(current);
    if (!params?.forceRefresh && skillMarketCache && userId) {
      const cached = skillMarketCache.getMarketPage(userId, normalized, {
        nowMs: now(),
        ttlMs: skillMarketCacheTtlMs
      });
      if (cached) {
        return {
          skills: cached.skills,
          categories: cached.categories,
          cached: true,
          stale: cached.stale,
          updatedAt: cached.updatedAt
        };
      }
    }
    const page = await fetchMarketSkillsFromCloud(normalized);
    if (skillMarketCache && userId) {
      skillMarketCache.upsertMarketPage(userId, normalized, page, now());
    }
    return {
      ...page,
      cached: false,
      stale: false,
      updatedAt: new Date(now()).toISOString()
    };
  }

  async function installMarketSkill(skillId) {
    const data = await cloudApi(`/api/skills/${encodeURIComponent(String(skillId))}/install`, {
      method: "POST",
      body: {}
    });
    return { skill: data && data.skill ? data.skill : null, download: data && data.download ? data.download : null };
  }

  async function getMarketSkill(skillId) {
    const data = await cloudApi(`/api/skills/${encodeURIComponent(String(skillId))}`, { method: "GET" });
    return { skill: data && data.skill ? data.skill : null, download: data && data.download ? data.download : null };
  }

  async function publishSkill(payload) {
    const data = await cloudApi("/api/skills", { method: "POST", body: payload || {} });
    return data && data.skill ? data.skill : null;
  }

  async function reportSkill(skillId, reason = "") {
    const data = await cloudApi(`/api/skills/${encodeURIComponent(String(skillId))}/report`, {
      method: "POST",
      body: { reason }
    });
    return data && data.reportId ? data.reportId : null;
  }

  async function downloadSkillPackage(pathSegment) {
    const current = settings();
    const baseUrl = normalizeCloudUrl(current.url);
    const headers = {};
    if (current.token) headers.Authorization = `Bearer ${current.token}`;
    const response = await fetchImpl(`${baseUrl}${pathSegment}`, { headers, signal: timeoutSignal(30000) });
    if (!response.ok) throw new Error(`Mia Cloud ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async function fetchQrCodeDataUrl(qrCodeUrl = "") {
    const url = String(qrCodeUrl || "").trim();
    if (!url) throw new Error("微信登录二维码缺失。");
    if (url.startsWith("data:image/")) return url;
    const response = await fetchImpl(url, {
      method: "GET",
      signal: timeoutSignal(15000)
    });
    if (!response.ok) throw new Error(`微信登录二维码图片加载失败：HTTP ${response.status}`);
    const contentType = String(response.headers?.get?.("content-type") || "image/png").split(";")[0].trim() || "image/png";
    if (!contentType.startsWith("image/")) throw new Error("微信登录二维码图片格式无效。");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("微信登录二维码图片为空。");
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }

  async function startWechatLogin({ url = "" } = {}) {
    const nextUrl = normalizeCloudUrl(url || settings().url);
    await writeCloudSettings({ url: nextUrl, enabled: false, token: "", user: null });
    const started = await cloudApi("/api/auth/wechat/start", {
      method: "POST",
      body: { client: "desktop" },
      token: ""
    });
    if (!started.state || !started.qrCodeUrl) throw new Error("微信登录启动失败。");
    const qrCodeDataUrl = await fetchQrCodeDataUrl(started.qrCodeUrl);
    return {
      kind: "wechat-login-start",
      mode: started.mode || "wechat_mp_oauth_userinfo",
      state: started.state,
      qrCodeUrl: qrCodeDataUrl,
      authorizationUrl: started.authorizationUrl || "",
      expiresAt: started.expiresAt || ""
    };
  }

  async function completeWechatLogin({ state = "" } = {}) {
    const loginState = String(state || "").trim();
    if (!loginState) throw new Error("微信登录状态缺失，请重新扫码。");
    const result = await cloudApi("/api/auth/wechat/complete", {
      method: "POST",
      body: { state: loginState },
      token: ""
    });
    if (result.status === "pending") {
      return {
        kind: "wechat-login-pending",
        status: "pending",
        expiresAt: result.expiresAt || ""
      };
    }
    if (result.status === "failed" || result.ok === false) throw new Error(result.error || "微信登录失败。");
    if (!result?.token) throw new Error("微信登录结果缺少 token，请重新扫码。");
    await writeCloudSettings({ url: normalizeCloudUrl(settings().url), enabled: true, token: result.token, user: result.user || null });
    startCloudEvents();
    startCloudBridge();
    return { kind: "wechat-login-complete", status: "complete" };
  }

  async function loginWithWechat(options = {}) {
    const started = await startWechatLogin(options);
    const startedAt = now();
    let data = null;
    while (now() - startedAt < 1000 * 60 * 5) {
      await waitMs(1500);
      const result = await completeWechatLogin({ state: started.state });
      if (result.status === "pending") continue;
      data = result;
      break;
    }
    if (data?.status !== "complete") throw new Error("微信登录超时，请重新扫码。");
    return status(false);
  }

  async function login(options = {}) {
    if (options?.action === "start") return startWechatLogin(options);
    if (options?.action === "complete") return completeWechatLogin(options);
    return loginWithWechat(options);
  }

  async function logout() {
    try {
      if (settings().token) await cloudApi("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // Local logout should still clear the desktop token.
    }
    await writeCloudSettings({ enabled: false, token: "", user: null });
    stopCloudEvents();
    stopCloudBridge();
    return status(false);
  }

  return {
    getUserSettings,
    installMarketSkill,
    getMarketSkill,
    downloadSkillPackage,
    publishSkill,
    reportSkill,
    listMarketSkills,
    login,
    logout,
    putUserSettings,
    pushUserProfile,
    saveAppearanceSettings,
    saveUserProfile,
    syncWorkspace
  };
}

module.exports = {
  createCloudDesktopSyncClient
};
