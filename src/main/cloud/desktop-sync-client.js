"use strict";

function createCloudDesktopSyncClient({
  getCloudSettings,
  writeCloudSettings,
  normalizeCloudUrl,
  cloudStatus,
  appendLog,
  fetchImpl = fetch,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  loadFellowManifest,
  fellowPersonaPath,
  fileExists,
  readFellowPersona,
  runtimePaths,
  readJson,
  loadChatStore,
  startCloudEvents,
  startCloudBridge,
  stopCloudEvents,
  stopCloudBridge,
  now = Date.now
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
    if (!response.ok) throw new Error(data.error || `Aimashi Cloud ${response.status}`);
    return data;
  }

  async function pushFellow(fellow) {
    const current = settings();
    if (!current.enabled || !current.token || !fellow || !fellow.key) return;
    try {
      let personaText = "";
      try {
        if (typeof fellowPersonaPath === "function" && typeof fileExists === "function" && fileExists(fellowPersonaPath(fellow.key))) {
          personaText = readFellowPersona(fellow.key, fellow.name, fellow.bio);
        }
      } catch {
        // Persona text is best-effort; identity sync should still proceed.
      }
      await cloudApi(`/api/me/fellows/${encodeURIComponent(fellow.key)}`, {
        method: "PUT",
        body: {
          name: fellow.name,
          color: fellow.color || "",
          avatarImage: fellow.avatarImage || "",
          avatarCrop: fellow.avatarCrop || null,
          bio: fellow.bio || "",
          capabilities: Object.keys(fellow.capabilities || {}).filter((key) => fellow.capabilities[key]),
          personaText
        }
      });
    } catch (error) {
      log(`Cloud fellow push failed for ${fellow.key}: ${error?.message || error}`);
    }
  }

  async function ensureFellowRoom(fellow) {
    const current = settings();
    if (!current.enabled || !current.token || !fellow?.key) return;
    try {
      await cloudApi(`/api/me/fellows/${encodeURIComponent(fellow.key)}/room`, {
        method: "PUT",
        body: {
          title: fellow.name || fellow.key,
          runtimeKind: "desktop-local"
        }
      });
    } catch (error) {
      log(`Cloud fellow room ensure failed for ${fellow.key}: ${error?.message || error}`);
    }
  }

  async function deleteFellow(fellowKey) {
    const current = settings();
    if (!current.enabled || !current.token || !fellowKey) return;
    try {
      await cloudApi(`/api/me/fellows/${encodeURIComponent(fellowKey)}`, { method: "DELETE" });
    } catch (error) {
      log(`Cloud fellow delete failed for ${fellowKey}: ${error?.message || error}`);
    }
  }

  async function pushAllFellows() {
    const current = settings();
    if (!current.enabled || !current.token) return;
    const manifest = loadFellowManifest();
    for (const fellow of (manifest.fellows || [])) {
      await pushFellow(fellow);
      await ensureFellowRoom(fellow);
    }
  }

  async function pushUserProfile() {
    const current = settings();
    if (!current.enabled || !current.token) return;
    const paths = runtimePaths();
    const profile = readJson(paths.userProfile, null);
    if (!profile) return;
    const body = {
      avatarImage: String(profile.avatarImage || ""),
      avatarCrop: profile.avatarCrop || null,
      avatarColor: String(profile.avatarColor || "")
    };
    try {
      const data = await cloudApi("/api/me/profile", { method: "PATCH", body });
      if (data && data.user) {
        writeCloudSettings({ user: data.user });
      }
    } catch (error) {
      log(`Aimashi Cloud profile sync failed: ${error?.message || error}`);
    }
  }

  async function legacyBackfillFellowSessionsToCloudRooms() {
    const current = settings();
    if (!current.enabled || !current.token || !current.user?.id) return;
    let store;
    try {
      store = loadChatStore();
    } catch (error) {
      log(`Cloud fellow-room backfill: failed to read chat store (${error?.message || error})`);
      return;
    }
    const manifest = loadFellowManifest();
    const fellowByKey = new Map((manifest.fellows || []).map((fellow) => [fellow.key, fellow]));
    for (const [personaKey, sessions] of Object.entries(store.sessions || {})) {
      if (!Array.isArray(sessions)) continue;
      const fellow = fellowByKey.get(personaKey) || { key: personaKey, name: personaKey };
      for (const session of sessions) {
        await mirrorFellowSessionMessages(current, session, fellow);
      }
    }
  }

  async function mirrorFellowSessionMessages(current, session, fellow) {
    if (!session?.id || !fellow?.key) return;
    try {
      await cloudApi(`/api/me/fellow-rooms/${encodeURIComponent(session.id)}`, {
        method: "PUT",
        body: {
          fellowKey: fellow.key,
          title: session.title || fellow.name || "对话",
          clientOpId: `op_fellow_room_${current.user.id}_${session.id}`
        }
      });
    } catch (error) {
      log(`Cloud fellow-room upsert failed (${session.id}): ${error?.message || error}`);
      return;
    }
    const roomId = `fellow:${current.user.id}:${session.id}`;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (const message of messages) {
      const text = String(message?.content || message?.text || "").trim();
      if (!text) continue;
      const clientOpId = `op_fellow_msg_${session.id}_${message.id || message.createdAt || ""}`;
      try {
        await cloudApi(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
          method: "POST",
          body: { bodyMd: text, attachments: message.attachments || null, clientOpId }
        });
      } catch (error) {
        log(`Cloud fellow-room message backfill failed (${roomId}): ${error?.message || error}`);
        break;
      }
    }
  }

  async function mirrorFellowSessionToCloudRoom(session, fellow, message) {
    if (!session?.id || !fellow?.key) return;
    const current = settings();
    if (!current.enabled || !current.token || !current.user?.id) return;
    try {
      await cloudApi(`/api/me/fellow-rooms/${encodeURIComponent(session.id)}`, {
        method: "PUT",
        body: {
          fellowKey: fellow.key,
          title: session.title || fellow.name || "对话",
          clientOpId: `op_fellow_room_${current.user.id}_${session.id}`
        }
      });
    } catch (error) {
      log(`Cloud fellow-room upsert failed (${session.id}): ${error?.message || error}`);
      return;
    }
    const roomId = `fellow:${current.user.id}:${session.id}`;
    const text = String(message?.content || message?.text || "").trim();
    if (!text) return;
    const clientOpId = `op_fellow_msg_${session.id}_${message.id || message.createdAt || now()}`;
    try {
      await cloudApi(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: "POST",
        body: { bodyMd: text, attachments: message.attachments || null, clientOpId }
      });
    } catch (error) {
      log(`Cloud fellow-room message push failed (${roomId}): ${error?.message || error}`);
    }
  }

  async function syncWorkspace() {
    const current = settings();
    if (!current.enabled || !current.token) return status(false);
    await pushUserProfile();
    await pushAllFellows();
    try {
      const data = await cloudApi("/api/me");
      writeCloudSettings({ user: data?.user || current.user });
    } catch (error) {
      log(`Aimashi Cloud /api/me refresh failed: ${error?.message || error}`);
    }
    return status(false);
  }

  async function pushDesktopMessage({ session, message, fellowKey = "" } = {}) {
    const current = settings();
    if (!current.enabled || !current.token || !session?.id || !message) return status(false);
    const fellow = (loadFellowManifest().fellows || []).find((item) => item.key === fellowKey || item.id === fellowKey) || {};
    await mirrorFellowSessionToCloudRoom(session, fellow, message).catch((error) =>
      log(`Cloud fellow-room push failed: ${error?.message || error}`)
    );
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
    deleteFellow,
    getUserSettings,
    login,
    logout,
    putUserSettings,
    pushAllFellows,
    pushDesktopMessage,
    pushFellow,
    pushUserProfile,
    syncWorkspace
  };
}

module.exports = {
  createCloudDesktopSyncClient
};
