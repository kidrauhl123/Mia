"use strict";

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function errorMessageFromBody(body) {
  if (!body || typeof body !== "object") return "";
  const value = body.error || body.message || body.code;
  return value == null ? "" : String(value);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function createMiaCoreHttpClient(deps = {}) {
  const baseUrl = normalizeBaseUrl(deps.baseUrl);
  const fetchImpl = deps.fetch || globalThis.fetch;
  const requestTimeoutMs = Number.isFinite(Number(deps.requestTimeoutMs))
    ? Math.max(0, Number(deps.requestTimeoutMs))
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutSignal = typeof deps.timeoutSignal === "function"
    ? deps.timeoutSignal
    : (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? (timeoutMs) => AbortSignal.timeout(timeoutMs)
      : null);
  const pendingGets = new Map();
  if (!baseUrl) throw new Error("baseUrl dependency is required.");
  if (typeof fetchImpl !== "function") throw new Error("fetch dependency is required.");

  async function performRequest(method, pathname, body) {
    const path = String(pathname || "/");
    const headers = { accept: "application/json" };
    const options = { method, headers };
    if (requestTimeoutMs > 0 && timeoutSignal) {
      options.signal = timeoutSignal(requestTimeoutMs);
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetchImpl(`${baseUrl}${path}`, options);
    let parsed = null;
    const contentType = response.headers && typeof response.headers.get === "function"
      ? String(response.headers.get("content-type") || "")
      : "";
    if (contentType.includes("application/json") && typeof response.json === "function") {
      parsed = await response.json();
    } else if (typeof response.text === "function") {
      const text = await response.text();
      parsed = text ? { error: text } : null;
    }

    if (!response.ok) {
      const detail = errorMessageFromBody(parsed) || response.statusText || "request failed";
      throw new Error(`Mia Core HTTP ${method} ${path} failed ${response.status}: ${detail}`);
    }
    return parsed;
  }

  async function request(method, pathname, body) {
    const upperMethod = String(method || "GET").toUpperCase();
    const path = String(pathname || "/");
    // Read-only status calls often arrive from multiple startup/UI paths at
    // once. Share only the in-flight request; this does not cache stale data
    // and writes keep their existing independent semantics.
    const canShare = (upperMethod === "GET" || upperMethod === "HEAD") && body === undefined;
    const key = `${upperMethod} ${path}`;
    if (canShare && pendingGets.has(key)) return pendingGets.get(key);
    const current = performRequest(upperMethod, path, body);
    if (!canShare) return current;
    pendingGets.set(key, current);
    try {
      return await current;
    } finally {
      if (pendingGets.get(key) === current) pendingGets.delete(key);
    }
  }

  return {
    request,
    get: (pathname) => request("GET", pathname),
    post: (pathname, body) => request("POST", pathname, body),
    patch: (pathname, body) => request("PATCH", pathname, body),
    delete: (pathname) => request("DELETE", pathname),
    health: () => request("GET", "/health")
  };
}

function createMiaCoreHttpClientCache(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  let currentBaseUrl = "";
  let currentClient = null;

  function get(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) throw new Error("baseUrl dependency is required.");
    if (!currentClient || currentBaseUrl !== normalized) {
      currentBaseUrl = normalized;
      currentClient = createMiaCoreHttpClient({ baseUrl: normalized, fetch: fetchImpl });
    }
    return currentClient;
  }

  return { get };
}

module.exports = { createMiaCoreHttpClient, createMiaCoreHttpClientCache };
