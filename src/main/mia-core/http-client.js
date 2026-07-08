"use strict";

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function errorMessageFromBody(body) {
  if (!body || typeof body !== "object") return "";
  const value = body.error || body.message || body.code;
  return value == null ? "" : String(value);
}

function createMiaCoreHttpClient(deps = {}) {
  const baseUrl = normalizeBaseUrl(deps.baseUrl);
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (!baseUrl) throw new Error("baseUrl dependency is required.");
  if (typeof fetchImpl !== "function") throw new Error("fetch dependency is required.");

  async function request(method, pathname, body) {
    const path = String(pathname || "/");
    const headers = { accept: "application/json" };
    const options = { method, headers };
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

  return {
    request,
    get: (pathname) => request("GET", pathname),
    post: (pathname, body) => request("POST", pathname, body),
    patch: (pathname, body) => request("PATCH", pathname, body),
    delete: (pathname) => request("DELETE", pathname),
    health: () => request("GET", "/health")
  };
}

module.exports = { createMiaCoreHttpClient };
