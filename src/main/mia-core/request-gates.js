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

function coreRequestShouldWaitForStreamingEvents(payload = {}) {
  if (coreRequestMethod(payload) !== "POST") return false;
  const route = coreRequestRoute(payload);
  return route === "/api/cloud/bridge/run";
}

function coreRequestRequiresStreamingEvents(payload = {}) {
  return coreRequestShouldWaitForStreamingEvents(payload);
}

module.exports = {
  coreRequestMethod,
  coreRequestRequiresStreamingEvents,
  coreRequestShouldWaitForStreamingEvents,
  coreRequestRoute
};
