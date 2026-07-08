"use strict";

function coreRequestMethod(payload = {}) {
  return String(payload.method || "GET").toUpperCase();
}

function coreRequestRoute(payload = {}) {
  const raw = String(payload.route || payload.path || "").trim();
  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (pathOnly.length > 1) return pathOnly.replace(/\/+$/, "");
  return pathOnly;
}

function coreRequestRequiresStreamingEvents(payload = {}) {
  if (coreRequestMethod(payload) !== "POST") return false;
  const route = coreRequestRoute(payload);
  if (route === "/api/cloud/bridge/run") return true;
  return /^\/api\/conversations\/[^/]+\/messages$/.test(route);
}

module.exports = {
  coreRequestMethod,
  coreRequestRequiresStreamingEvents,
  coreRequestRoute
};
