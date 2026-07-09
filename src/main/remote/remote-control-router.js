"use strict";

const CORE_TURN_CANCEL_PATTERN = /^\/api\/conversations\/([^/]+)\/turns\/([^/]+)\/cancel$/;

function normalizeRoute(method, requestPath) {
  const verb = String(method || "GET").toUpperCase();
  const url = new URL(String(requestPath || "/"), "http://127.0.0.1");
  return {
    method: verb,
    pathname: url.pathname
  };
}

function cancelTurnRoute(routeInfo = {}) {
  if (routeInfo.method !== "POST") return null;
  const match = String(routeInfo.pathname || "").match(CORE_TURN_CANCEL_PATTERN);
  if (!match) return null;
  return {
    conversationId: decodeURIComponent(match[1]),
    turnId: decodeURIComponent(match[2])
  };
}

function createRemoteControlRouter({
  cancelConversationTurn
} = {}) {
  function matches({ method = "GET", path = "/" } = {}) {
    const routeInfo = normalizeRoute(method, path);
    return Boolean(cancelTurnRoute(routeInfo));
  }

  async function route({ method = "GET", path = "/", body = {} } = {}) {
    const routeInfo = normalizeRoute(method, path);
    const cancelTurn = cancelTurnRoute(routeInfo);
    if (!cancelTurn) return { handled: false };
    if (typeof cancelConversationTurn !== "function") {
      return { handled: true, data: { ok: false, error: "Core turn cancellation is unavailable." } };
    }
    return {
      handled: true,
      data: await cancelConversationTurn({
        ...cancelTurn,
        body: body || {}
      })
    };
  }

  return {
    matches,
    route
  };
}

module.exports = {
  createRemoteControlRouter
};
