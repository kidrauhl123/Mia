#!/usr/bin/env node
"use strict";

const BRIDGE_URL = String(process.env.MIA_MCP_BRIDGE_URL || "").replace(/\/+$/, "");
const BRIDGE_SECRET = String(process.env.MIA_MCP_BRIDGE_SECRET || "");

function encodeNamePart(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function proxyToolName(tool) {
  return `mia__${encodeNamePart(tool?.server)}__${encodeNamePart(tool?.name)}`;
}

function buildProxyToolEntries(tools) {
  const entries = [];
  const seenNames = new Set();

  for (const tool of Array.isArray(tools) ? tools : []) {
    const proxyName = proxyToolName(tool);
    if (seenNames.has(proxyName)) {
      throw new Error(`Duplicate Mia MCP proxy tool name generated: ${proxyName}`);
    }
    seenNames.add(proxyName);
    entries.push({
      proxyName,
      server: String(tool?.server || ""),
      tool: String(tool?.name || ""),
      description: `[${tool?.server}] ${tool?.description || tool?.name}`,
      inputSchema: tool?.inputSchema || { type: "object" }
    });
  }

  return entries;
}

function indexProxyToolEntries(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (index.has(entry.proxyName)) {
      throw new Error(`Duplicate Mia MCP proxy tool name generated: ${entry.proxyName}`);
    }
    index.set(entry.proxyName, entry);
  }
  return index;
}

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

function createProxyHandlers({ postJson }) {
  if (typeof postJson !== "function") {
    throw new TypeError("createProxyHandlers requires a postJson function");
  }

  let cachedEntries = [];
  let cachedEntryIndex = new Map();

  async function loadManifest() {
    const manifest = await postJson("/mcp/manifest", {});
    cachedEntries = buildProxyToolEntries(manifest.tools);
    cachedEntryIndex = indexProxyToolEntries(cachedEntries);
    return cachedEntries;
  }

  return {
    async listTools() {
      const entries = await loadManifest();
      return {
        tools: entries.map((entry) => ({
          name: entry.proxyName,
          description: entry.description,
          inputSchema: entry.inputSchema
        }))
      };
    },
    async callTool(request) {
      if (!cachedEntries.length) {
        await loadManifest();
      }
      const entry = cachedEntryIndex.get(request?.params?.name);
      if (!entry) {
        return {
          content: [{ type: "text", text: `Unknown Mia MCP bridge tool: ${request?.params?.name}` }],
          isError: true
        };
      }
      return postJson("/mcp/execute", {
        server: entry.server,
        tool: entry.tool,
        args: request?.params?.arguments || {}
      });
    }
  };
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
  const handlers = createProxyHandlers({ postJson });

  server.setRequestHandler(types.ListToolsRequestSchema, handlers.listTools);
  server.setRequestHandler(types.CallToolRequestSchema, handlers.callTool);

  await server.connect(new StdioServerTransport());
}

module.exports = {
  buildProxyToolEntries,
  createProxyHandlers,
  indexProxyToolEntries,
  proxyToolName
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`mia-mcp-stdio-proxy fatal: ${error?.message || error}\n`);
    process.exit(1);
  });
}
