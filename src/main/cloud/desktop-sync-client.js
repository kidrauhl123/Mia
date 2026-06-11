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
  now = () => Date.now()
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
    return {
      displayName: String(profile.displayName || ""),
      avatarImage: String(profile.avatarImage || ""),
      avatarCrop: profile.avatarCrop || null,
      avatarColor: String(profile.avatarColor || "")
    };
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
        writeCloudSettings({ user: data.user });
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
    const saved = typeof writeAppearanceSettings === "function"
      ? writeAppearanceSettings(settingsInput)
      : settingsInput;
    const current = settings();
    if (!current.enabled || !current.token) return status(false);
    try {
      const remote = await getUserSettings();
      await putUserSettings({
        pins: remote.pins || [],
        readMarks: remote.readMarks || {},
        appearance: saved || {},
        expectedVersion: remote.version
      });
    } catch (error) {
      log(`Mia Cloud appearance sync failed: ${error?.message || error}`);
    }
    return status(false);
  }

  async function syncWorkspace() {
    const current = settings();
    if (!current.enabled || !current.token) return status(false);
    try {
      const data = await cloudApi("/api/me");
      writeCloudSettings({ user: data?.user || current.user });
    } catch (error) {
      log(`Mia Cloud /api/me refresh failed: ${error?.message || error}`);
    }
    return status(false);
  }

  async function getUserSettings() {
    const data = await cloudApi("/api/me/settings", { method: "GET" });
    return data && data.settings ? data.settings : { pins: [], readMarks: {}, appearance: {} };
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

  async function login({ username, password, mode = "login", url = "" } = {}) {
    const nextUrl = normalizeCloudUrl(url || settings().url);
    writeCloudSettings({ url: nextUrl, enabled: false, token: "", user: null });
    const pathSegment = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await cloudApi(pathSegment, {
      method: "POST",
      body: { username: String(username || "").trim(), password: String(password || "") },
      token: ""
    });
    writeCloudSettings({ url: nextUrl, enabled: true, token: data.token, user: data.user || null });
    startCloudEvents();
    startCloudBridge();
    return status(false);
  }

  async function logout() {
    try {
      if (settings().token) await cloudApi("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // Local logout should still clear the desktop token.
    }
    writeCloudSettings({ enabled: false, token: "", user: null });
    stopCloudEvents();
    stopCloudBridge();
    return status(false);
  }

  return {
    getUserSettings,
    installMarketSkill,
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
