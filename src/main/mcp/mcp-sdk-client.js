"use strict";

const { maskMcpRecord, normalizeMcpRecord, sanitizeSecretText } = require("./mcp-records.js");
const { MCP_TRANSPORTS } = require("../../shared/mcp-contracts.js");

const CLIENT_INFO = Object.freeze({ name: "mia-mcp-client", version: "1.0.0" });
const TEST_CLIENT_INFO = Object.freeze({ name: "mia-mcp-test", version: "1.0.0" });

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

function requestInitForHeaders(headers = {}) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return undefined;
  return { headers: Object.fromEntries(entries) };
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

function toolError(text) {
  return { content: [{ type: "text", text: String(text || "Tool execution failed") }], isError: true };
}

function closeResource(resource) {
  if (!resource || typeof resource.close !== "function") return Promise.resolve();
  return Promise.resolve().then(() => resource.close()).catch(() => {});
}

function createMcpSdkClientManager(deps = {}) {
  const loadSdk = typeof deps.loadSdk === "function" ? deps.loadSdk : defaultLoadSdk;
  const processEnvStrings = typeof deps.processEnvStrings === "function" ? deps.processEnvStrings : () => process.env;
  const appendLog = typeof deps.appendLog === "function" ? deps.appendLog : () => {};
  const authorizeToolCall = typeof deps.authorizeToolCall === "function" ? deps.authorizeToolCall : null;

  const clients = new Map();
  let manifest = [];

  function logMasked(message, record, error) {
    const masked = record ? JSON.stringify(maskMcpRecord(record)) : "";
    const suffix = error ? `: ${sanitizeSecretText(error?.message || error)}` : "";
    appendLog(`[MCP] ${message}${masked ? ` ${masked}` : ""}${suffix}`);
  }

  function normalizeRecord(input) {
    const normalized = normalizeMcpRecord(input);
    if (!normalized) {
      throw new Error("Invalid MCP server record");
    }
    if (!MCP_TRANSPORTS.includes(normalized.transport.type)) {
      throw new Error(`Unsupported MCP transport: ${normalized.transport.type}`);
    }
    return normalized;
  }

  async function transportFor(record) {
    const sdk = await loadSdk();
    const transport = record.transport || {};
    const env = processEnvStrings() || {};
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

    const url = new URL(transport.url);
    const headers = { ...(transport.headers || {}) };
    const bearerTokenEnvVar = String(transport.bearerTokenEnvVar || "").trim();
    const bearerToken = bearerTokenEnvVar ? String(env[bearerTokenEnvVar] || "").trim() : "";
    if (bearerToken && !hasAuthorizationHeader(headers)) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    const requestInit = requestInitForHeaders(headers);
    const options = requestInit ? { requestInit } : undefined;

    if (transport.type === "sse") {
      return new sdk.SSEClientTransport(url, options);
    }
    if (transport.type === "http" || transport.type === "streamable_http") {
      return new sdk.StreamableHTTPClientTransport(url, options);
    }
    throw new Error(`Unsupported MCP transport: ${transport.type}`);
  }

  async function connectRecord(record, clientInfo) {
    const sdk = await loadSdk();
    const transport = await transportFor(record);
    const client = new sdk.Client(clientInfo, { capabilities: {} });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = toolManifestFor(record.name, listed?.tools || []);
      return { client, transport, tools };
    } catch (error) {
      await Promise.allSettled([closeResource(client), closeResource(transport)]);
      throw error;
    }
  }

  async function testServer(input) {
    let record = null;
    try {
      record = normalizeRecord(input);
      const { client, transport, tools } = await connectRecord(record, TEST_CLIENT_INFO);
      await Promise.allSettled([closeResource(client), closeResource(transport)]);
      return { success: true, status: "connected", tools, error: "" };
    } catch (error) {
      logMasked("test failed for server", record || input, error);
      return {
        success: false,
        status: "disconnected",
        tools: [],
        error: sanitizeSecretText(error?.message || error)
      };
    }
  }

  async function stopAll() {
    const entries = [...clients.values()];
    clients.clear();
    manifest = [];
    await Promise.allSettled(entries.flatMap((entry) => [closeResource(entry.client), closeResource(entry.transport)]));
  }

  async function refresh(records = []) {
    await stopAll();

    const tools = [];
    const errors = [];
    for (const input of Array.isArray(records) ? records : []) {
      let record = null;
      try {
        record = normalizeRecord(input);
        if (record.enabled === false) continue;
        const connection = await connectRecord(record, CLIENT_INFO);
        clients.set(record.name, { ...connection, record });
        tools.push(...connection.tools);
      } catch (error) {
        logMasked("refresh failed for server", record || input, error);
        errors.push({
          server: String((record || input)?.name || "").trim() || "server",
          error: sanitizeSecretText(error?.message || error)
        });
      }
    }

    manifest = tools;
    return { success: errors.length === 0, tools: manifest.slice(), errors };
  }

  async function callTool(serverName, toolName, args = {}, options = {}) {
    const normalizedServerName = String(serverName || "").trim();
    const normalizedToolName = String(toolName || "").trim();
    const entry = clients.get(normalizedServerName);

    if (!entry) return toolError(`MCP server "${normalizedServerName || "server"}" is not running`);
    if (!normalizedToolName) return toolError("MCP tool name is required");
    if (options?.signal?.aborted) return toolError("Tool execution aborted");

    if (authorizeToolCall) {
      try {
        const toolLabel = `${normalizedServerName}.${normalizedToolName}`;
        const decision = await authorizeToolCall({
          serverName: normalizedServerName,
          toolName: normalizedToolName,
          args: args && typeof args === "object" ? args : {},
          record: entry.record,
          options: { ...options, toolLabel }
        });
        if (!decision || decision.allowed !== true) {
          return toolError(decision?.reason || `Tool call blocked by permission policy for ${toolLabel}`);
        }
      } catch (error) {
        return toolError(`Tool call authorization failed: ${error?.message || error}`);
      }
    }

    try {
      const result = await entry.client.callTool({
        name: normalizedToolName,
        arguments: args && typeof args === "object" ? args : {}
      });
      return {
        content: Array.isArray(result?.content) ? result.content : [{ type: "text", text: String(result?.content || "") }],
        isError: result?.isError === true
      };
    } catch (error) {
      return toolError(`Tool execution error: ${error?.message || error}`);
    }
  }

  function toolManifest() {
    return manifest.slice();
  }

  return {
    callTool,
    refresh,
    stopAll,
    testServer,
    toolManifest
  };
}

module.exports = {
  createMcpSdkClientManager,
  defaultLoadSdk,
  toolManifestFor
};
