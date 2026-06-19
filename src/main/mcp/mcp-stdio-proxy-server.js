#!/usr/bin/env node
"use strict";

const BRIDGE_URL = String(process.env.MIA_MCP_BRIDGE_URL || "").replace(/\/+$/, "");
const BRIDGE_SECRET = String(process.env.MIA_MCP_BRIDGE_SECRET || "");

async function postJson(path, body) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mia-mcp-bridge-secret": BRIDGE_SECRET
    },
    body: JSON.stringify(body || {})
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Bridge returned invalid JSON for ${path}`);
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error ? `Bridge HTTP ${response.status}: ${payload.error}` : `Bridge HTTP ${response.status}`);
  }
  return payload;
}

function sanitizeNamePart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function proxyToolName(tool) {
  return `${sanitizeNamePart(tool?.server)}__${sanitizeNamePart(tool?.name)}`;
}

async function main() {
  if (!BRIDGE_URL || !BRIDGE_SECRET) {
    throw new Error("MIA_MCP_BRIDGE_URL and MIA_MCP_BRIDGE_SECRET are required.");
  }

  const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js")
  ]);

  const server = new Server(
    { name: "mia-mcp-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  let cachedTools = [];

  server.setRequestHandler(types.ListToolsRequestSchema, async () => {
    const manifest = await postJson("/mcp/manifest", {});
    cachedTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    return {
      tools: cachedTools.map((tool) => ({
        name: proxyToolName(tool),
        description: `[${tool.server}] ${tool.description || tool.name}`,
        inputSchema: tool.inputSchema || { type: "object" }
      }))
    };
  });

  server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
    if (!cachedTools.length) {
      const manifest = await postJson("/mcp/manifest", {});
      cachedTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    }
    const tool = cachedTools.find((entry) => proxyToolName(entry) === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown Mia MCP bridge tool: ${request.params.name}` }],
        isError: true
      };
    }
    return postJson("/mcp/execute", {
      server: tool.server,
      tool: tool.name,
      args: request.params.arguments || {}
    });
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`mia-mcp-stdio-proxy fatal: ${error?.message || error}\n`);
  process.exit(1);
});
