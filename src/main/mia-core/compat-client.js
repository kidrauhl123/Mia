"use strict";

const { createMiaCoreHttpClientCache } = require("./http-client.js");

function parseBody(body) {
  if (body == null || body === "") return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

function retiredLegacyTaskRoute() {
  return {
    immediate: {
      ok: false,
      error: "Legacy task routes are retired. Use Rust Core /api/tasks/jobs."
    }
  };
}

function mapLegacyRequest(pathSegment, method, body) {
  const fullPath = String(pathSegment || "/");
  const queryStart = fullPath.indexOf("?");
  const path = queryStart >= 0 ? fullPath.slice(0, queryStart) : fullPath;
  const upper = String(method || "GET").toUpperCase();
  if (path === "/api/tasks" || path.startsWith("/api/tasks/")) return retiredLegacyTaskRoute();
  if (path === "/api/chat/stop" && upper === "POST") {
    return { immediate: { ok: false, error: "Legacy chat stop is retired. Use Core turn cancellation." } };
  }
  if (path === "/api/chat/send" && upper === "POST") {
    return {
      immediate: {
        ok: false,
        error: "Legacy chat send is retired. Use Rust Core /api/conversations/{id}/messages."
      }
    };
  }
  return { method: upper, path, body, adapt: (value) => value };
}

function createMiaCoreCompatibilityClient({
  getCoreSettings,
  getCoreStatus,
  fetchImpl = fetch
}) {
  const clients = createMiaCoreHttpClientCache({ fetch: fetchImpl });

  function baseUrl() {
    const settings = getCoreSettings();
    const status = getCoreStatus();
    return String(status.baseUrl || `http://${settings.host}:${settings.port}`).replace(/\/+$/, "");
  }

  async function call(pathSegment, opts = {}) {
    const body = parseBody(opts.body);
    const mapped = mapLegacyRequest(pathSegment, opts.method || "GET", body);
    if (mapped.immediate) return mapped.immediate;
    const client = clients.get(baseUrl());
    const response = await client.request(mapped.method, mapped.path, mapped.body);
    return mapped.adapt(response || {});
  }

  return { call };
}

module.exports = {
  createMiaCoreCompatibilityClient
};
