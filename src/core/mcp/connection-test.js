"use strict";

const { normalizeCoreMcpRecord, sanitizeSecretText } = require("./records.js");

async function defaultLoadSdk() {
  const [{ Client }, { StdioClientTransport }, { SSEClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  ]);
  return { Client, StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport };
}

function hasAuthorizationHeader(headers = {}) {
  return Object.keys(headers || {}).some((key) => String(key || "").trim().toLowerCase() === "authorization");
}

function mergeOAuthHeaders(headers, oauthHeaders = {}) {
  const hasExplicitAuthorization = hasAuthorizationHeader(headers);
  for (const [key, value] of Object.entries(oauthHeaders || {})) {
    if (hasExplicitAuthorization && String(key || "").trim().toLowerCase() === "authorization") continue;
    headers[key] = value;
  }
  return headers;
}

function headersFromError(error = {}) {
  return error?.headers || error?.response?.headers || {};
}

function headerValue(headers = {}, name) {
  const normalized = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key || "").toLowerCase() === normalized) return String(value || "");
  }
  return "";
}

function requestInitForHeaders(headers = {}) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return undefined;
  return { headers: Object.fromEntries(entries) };
}

function sanitizeAuthenticateHeader(value) {
  return String(value || "")
    .replace(/\bBearer\s+([A-Za-z0-9._~+/=-]+)(?=\s|$|,)/gi, "Bearer [redacted]")
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|token|password|secret)\s*=\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1[redacted]");
}

function redactDiagnosticValue(key, value) {
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue("", item));
  if (typeof value === "string") {
    if (String(key || "").toLowerCase() === "wwwauthenticate") {
      return sanitizeAuthenticateHeader(value);
    }
    if (/token|secret|password|passwd|api[_-]?key|authorization|cookie|session/i.test(String(key || ""))) {
      return value ? "[redacted]" : "";
    }
    return sanitizeSecretText(value);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redactDiagnosticValue(childKey, childValue)
  ]));
}

function httpStatusFromMessage(message = "") {
  const match = String(message || "").match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) return 0;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : 0;
}

function toolManifestFor(serverName, tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => ({
      server: serverName,
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || ""),
      inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
    }))
    .filter((tool) => tool.name);
}

function diagnostic(fields = {}) {
  const ok = fields.ok === true;
  const message = sanitizeSecretText(fields.message || "");
  return {
    ok,
    success: ok,
    status: String(fields.status || (ok ? "connected" : "disconnected")),
    code: String(fields.code || (ok ? "ok" : "connection_failed")),
    message,
    error: sanitizeSecretText(fields.error || message),
    details: redactDiagnosticValue("", fields.details || {}),
    tools: Array.isArray(fields.tools) ? fields.tools : [],
    auth: redactDiagnosticValue("", fields.auth || { needsAuth: false, method: "", serverUrl: "" })
  };
}

function classifyMcpConnectionError(error, context = {}) {
  const message = sanitizeSecretText(error?.message || error || "MCP connection failed.");
  const durationMs = Number(context.durationMs || 0);
  const httpStatus = Number(error?.status || error?.statusCode || error?.response?.status || httpStatusFromMessage(message) || 0);
  const headers = headersFromError(error);
  const wwwAuthenticate = headerValue(headers, "www-authenticate");
  const command = String(context.command || "");
  const url = String(context.url || "");
  const looksLikeCommandNotFound = error?.code === "ENOENT" ||
    /\bENOENT\b|command not found/i.test(message) ||
    (Boolean(command) && /\bnot found\b/i.test(message));

  if (httpStatus === 401 || /\bHTTP\s*401\b|401 Unauthorized/i.test(message)) {
    return diagnostic({
      ok: false,
      status: "auth_required",
      code: "auth_required",
      message: "MCP server requires authentication.",
      details: { httpStatus: 401, wwwAuthenticate, durationMs },
      auth: { needsAuth: true, method: "oauth", serverUrl: url }
    });
  }
  if (httpStatus) {
    return diagnostic({
      ok: false,
      code: "http_error",
      message,
      details: { httpStatus, durationMs }
    });
  }
  if (looksLikeCommandNotFound) {
    return diagnostic({
      ok: false,
      code: "command_not_found",
      message,
      details: { command, durationMs }
    });
  }
  if (error?.code === "EACCES" || /permission denied|\bEACCES\b/i.test(message)) {
    return diagnostic({
      ok: false,
      code: "permission_denied",
      message,
      details: { command, durationMs }
    });
  }
  if (error?.name === "AbortError" || error?.code === "ETIMEDOUT" || /timeout|timed out/i.test(message)) {
    return diagnostic({
      ok: false,
      code: "timeout",
      message,
      details: { durationMs }
    });
  }
  if (/initialize|tools\/list|JSON-RPC|protocol/i.test(message)) {
    return diagnostic({
      ok: false,
      code: "protocol_error",
      message,
      details: { durationMs }
    });
  }
  return diagnostic({
    ok: false,
    code: "connection_failed",
    message,
    details: { durationMs }
  });
}

function closeResource(resource) {
  if (!resource || typeof resource.close !== "function") return Promise.resolve();
  return Promise.resolve().then(() => resource.close()).catch(() => {});
}

function createTimeoutPromise(timeoutMs) {
  let timeoutId = null;
  const promise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(Object.assign(new Error(`Timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  return {
    promise,
    clear: () => {
      if (timeoutId != null) clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

function createCoreMcpConnectionTester(deps = {}) {
  const loadSdk = typeof deps.loadSdk === "function" ? deps.loadSdk : defaultLoadSdk;
  const processEnvStrings = typeof deps.processEnvStrings === "function" ? deps.processEnvStrings : () => process.env;
  const oauthService = deps.oauthService || null;
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) && Number(deps.timeoutMs) > 0
    ? Number(deps.timeoutMs)
    : 15000;

  async function transportFor(sdk, record) {
    const env = processEnvStrings() || {};
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      return new sdk.StdioClientTransport({
        command: transport.command,
        args: Array.isArray(transport.args) ? transport.args.slice() : [],
        env: {
          ...env,
          ...(transport.env || {})
        }
      });
    }

    const headers = { ...(transport.headers || {}) };
    if (oauthService && typeof oauthService.authorizationHeadersForServer === "function") {
      mergeOAuthHeaders(headers, await oauthService.authorizationHeadersForServer(record));
    }
    const bearerTokenEnvVar = String(transport.bearerTokenEnvVar || "").trim();
    const bearerToken = bearerTokenEnvVar ? String(env[bearerTokenEnvVar] || "").trim() : "";
    if (bearerToken && !hasAuthorizationHeader(headers)) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }

    const url = new URL(transport.url);
    const requestInit = requestInitForHeaders(headers);
    const options = requestInit ? { requestInit } : undefined;
    if (transport.type === "sse") return new sdk.SSEClientTransport(url, options);
    if (transport.type === "http" || transport.type === "streamable_http") {
      return new sdk.StreamableHTTPClientTransport(url, options);
    }
    throw new Error(`Unsupported MCP transport: ${transport.type}`);
  }

  async function testConnection(input) {
    const started = Date.now();
    let record = null;
    let client = null;
    let transport = null;
    try {
      record = normalizeCoreMcpRecord(input);
      if (!record) throw new Error("Invalid MCP server record");
      const sdk = await loadSdk();
      transport = await transportFor(sdk, record);
      client = new sdk.Client({ name: "mia-mcp-test", version: "1.0.0" }, { capabilities: {} });
      const timeout = createTimeoutPromise(timeoutMs);
      let listed = null;
      try {
        listed = await Promise.race([
          (async () => {
            await client.connect(transport);
            return client.listTools();
          })(),
          timeout.promise
        ]);
      } finally {
        timeout.clear();
      }
      return diagnostic({
        ok: true,
        status: "connected",
        code: "ok",
        tools: toolManifestFor(record.name, listed?.tools || []),
        details: { durationMs: Date.now() - started }
      });
    } catch (error) {
      return classifyMcpConnectionError(error, {
        command: record?.transport?.command || input?.transport?.command || input?.command || "",
        url: record?.transport?.url || input?.transport?.url || input?.url || "",
        durationMs: Date.now() - started
      });
    } finally {
      await Promise.allSettled([closeResource(client), closeResource(transport)]);
    }
  }

  return { testConnection };
}

module.exports = {
  classifyMcpConnectionError,
  createCoreMcpConnectionTester,
  diagnostic
};
