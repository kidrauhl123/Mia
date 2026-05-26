"use strict";

const REMOTE_ROUTES = new Set([
  "GET /health",
  "GET /api/runtime/status",
  "GET /api/fellows",
  "GET /api/chat/sessions",
  "GET /api/model/catalog",
  "GET /api/codex/models",
  "GET /api/engine/capabilities",
  "GET /api/commands/slash",
  "GET /api/commands/agent-list",
  "POST /api/chat/session",
  "POST /api/chat/session/save",
  "POST /api/chat/session/rename",
  "POST /api/chat/read-state/save",
  "POST /api/chat/attachment",
  "POST /api/file/fetch",
  "POST /api/commands/agent-execute",
  "POST /api/fellow/engine",
  "POST /api/model/save",
  "POST /api/effort/save",
  "POST /api/permissions/save",
  "POST /api/chat/stop",
  "POST /api/chat/send",
  "POST /api/chat/stream"
]);

function normalizeRoute(method, requestPath) {
  const verb = String(method || "GET").toUpperCase();
  const url = new URL(String(requestPath || "/"), "http://127.0.0.1");
  return {
    method: verb,
    pathname: url.pathname,
    searchParams: url.searchParams,
    key: `${verb} ${url.pathname}`
  };
}

function createRemoteControlRouter({
  isDaemonProcess = false,
  getRuntimeStatus,
  loadFellowManifest,
  loadChatSessions,
  loadHermesModelCatalog,
  loadCodexModels,
  loadEngineCapabilities,
  loadHermesSlashCommands,
  loadExternalAgentCommands,
  newChatSession,
  saveChatSession,
  saveChatReadState,
  renameChatSession,
  saveChatAttachment,
  readLocalFileAttachment,
  executeExternalAgentCommand,
  saveFellowEngineConfig,
  saveModelSelection,
  writeEffortSettings,
  writePermissionSettings,
  stopChat,
  runRemoteChatRequest
}) {
  function matches({ method = "GET", path = "/" } = {}) {
    return REMOTE_ROUTES.has(normalizeRoute(method, path).key);
  }

  async function route({ method = "GET", path = "/", body = {}, emitStream = null, isStreamDestroyed = null } = {}) {
    const routeInfo = normalizeRoute(method, path);
    if (!REMOTE_ROUTES.has(routeInfo.key)) return { handled: false };

    if (routeInfo.method === "GET" && routeInfo.pathname === "/health") {
      return {
        handled: true,
        data: {
          status: "ok",
          service: "mia-daemon",
          mode: isDaemonProcess ? "daemon" : "desktop"
        }
      };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/runtime/status") {
      return { handled: true, data: getRuntimeStatus() };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/fellows") {
      const manifest = loadFellowManifest();
      return { handled: true, data: { fellows: manifest.fellows || [], defaultFellow: manifest.default_fellow || "mia" } };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/chat/sessions") {
      return { handled: true, data: loadChatSessions() };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/model/catalog") {
      return { handled: true, data: { models: await loadHermesModelCatalog() } };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/codex/models") {
      return { handled: true, data: { models: loadCodexModels() } };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/engine/capabilities") {
      return { handled: true, data: await loadEngineCapabilities() };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/commands/slash") {
      return { handled: true, data: { rows: await loadHermesSlashCommands() } };
    }
    if (routeInfo.method === "GET" && routeInfo.pathname === "/api/commands/agent-list") {
      return {
        handled: true,
        data: await loadExternalAgentCommands({ engine: routeInfo.searchParams.get("engine") || "" })
      };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/session") {
      return { handled: true, data: newChatSession(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/session/save") {
      return { handled: true, data: saveChatSession(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/session/rename") {
      return { handled: true, data: renameChatSession(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/read-state/save") {
      return { handled: true, data: saveChatReadState(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/attachment") {
      return { handled: true, data: saveChatAttachment(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/file/fetch") {
      return { handled: true, data: readLocalFileAttachment(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/commands/agent-execute") {
      return { handled: true, data: executeExternalAgentCommand(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/fellow/engine") {
      return { handled: true, data: saveFellowEngineConfig(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/model/save") {
      return { handled: true, data: await saveModelSelection(body) };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/effort/save") {
      writeEffortSettings(body);
      return { handled: true, data: getRuntimeStatus() };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/permissions/save") {
      writePermissionSettings(body);
      return { handled: true, data: getRuntimeStatus() };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/stop") {
      return { handled: true, data: stopChat() };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/send") {
      const result = await runRemoteChatRequest(body);
      return {
        handled: true,
        data: {
          fellow: result.fellow,
          session: result.session,
          response: result.response
        }
      };
    }
    if (routeInfo.method === "POST" && routeInfo.pathname === "/api/chat/stream") {
      const eventSink = {
        isDestroyed: () => Boolean(isStreamDestroyed?.()),
        send: (_channel, envelope) => {
          if (typeof emitStream === "function") emitStream("chat", envelope);
        }
      };
      const result = await runRemoteChatRequest(body, eventSink);
      if (typeof emitStream === "function") {
        emitStream("result", {
          fellow: result.fellow,
          session: result.session,
          response: result.response
        });
      }
      return { handled: true, data: { done: true } };
    }
    return { handled: false };
  }

  return {
    matches,
    route
  };
}

module.exports = {
  createRemoteControlRouter
};
