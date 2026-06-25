"use strict";

const { spawn } = require("node:child_process");
const fsDefault = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const { normalizeTransport, sanitizeSecretText } = require("./records.js");

const SOURCE_ORDER = ["claude-code", "codex", "openclaw", "hermes"];

function detected(source, name, transport, importable = true, importSkipReason = "") {
  return {
    source,
    name: String(name || "").trim(),
    transport,
    importable: importable === true,
    importSkipReason: sanitizeSecretText(importSkipReason || "")
  };
}

function normalizeDetected(source, name, transportInput, importable = true, importSkipReason = "") {
  const cleanName = String(name || "").trim();
  const transport = normalizeTransport(transportInput);
  if (!cleanName || !transport) return null;
  return detected(source, cleanName, transport, importable, importSkipReason);
}

function splitCommandLine(commandLine = "") {
  const text = String(commandLine || "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function parseClaudeMcpList(output = "") {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const splitAt = line.lastIndexOf(" - ");
      if (splitAt < 0) return null;
      const left = line.slice(0, splitAt);
      const rawStatus = line.slice(splitAt + 3).trim();
      const status = rawStatus.replace(/^[✓✗!:\s-]+/, "").trim();
      const nameSep = left.indexOf(": ");
      if (nameSep < 0) return null;
      const name = left.slice(0, nameSep).trim();
      const commandOrUrl = left.slice(nameSep + 2).replace(/\s+\((HTTP|SSE)\)$/i, "").trim();
      const isUrl = /^https?:\/\//i.test(commandOrUrl);
      const commandParts = isUrl ? [] : splitCommandLine(commandOrUrl);
      const transport = isUrl
        ? { type: /\/sse\/?$/i.test(commandOrUrl) ? "sse" : "http", url: commandOrUrl }
        : { type: "stdio", command: commandParts[0], args: commandParts.slice(1), env: {} };
      const pluginManaged = name.startsWith("plugin:");
      const connected = /^connected$/i.test(status);
      return normalizeDetected(
        "claude-code",
        name,
        transport,
        connected && !pluginManaged,
        pluginManaged ? "Plugin-managed MCP" : connected ? "" : status || rawStatus
      );
    })
    .filter(Boolean);
}

function objectFromNameValueArray(entries) {
  if (!Array.isArray(entries)) return {};
  return Object.fromEntries(entries
    .map((entry) => [String(entry?.name || "").trim(), entry?.value])
    .filter(([name]) => name));
}

function codexEnv(transport = {}) {
  if (transport.env && typeof transport.env === "object" && !Array.isArray(transport.env)) return transport.env;
  if (Array.isArray(transport.env_vars)) return objectFromNameValueArray(transport.env_vars);
  return {};
}

function headersFromInput(headers) {
  if (headers && typeof headers === "object" && !Array.isArray(headers)) return headers;
  return objectFromNameValueArray(headers);
}

function transportFromJsonEntry(entry = {}) {
  const transport = entry.transport && typeof entry.transport === "object" ? entry.transport : entry;
  const type = String(transport.type || (transport.url ? "http" : "stdio")).trim().toLowerCase();
  if (type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      args: Array.isArray(transport.args) ? transport.args : [],
      env: codexEnv(transport)
    };
  }
  return {
    type,
    url: transport.url,
    headers: headersFromInput(transport.headers),
    bearerTokenEnvVar: transport.bearerTokenEnvVar || transport.bearer_token_env_var
  };
}

function parseCodexMcpListJson(output = "") {
  const parsed = String(output || "").trim() ? JSON.parse(output) : [];
  const entries = Array.isArray(parsed) ? parsed : Object.entries(parsed.mcpServers || parsed.mcp_servers || parsed.servers || {})
    .map(([name, spec]) => ({ name, transport: spec }));
  return entries
    .map((entry) => {
      const enabled = entry.enabled !== false;
      return normalizeDetected("codex", entry.name, transportFromJsonEntry(entry), enabled, enabled ? "" : "Disabled");
    })
    .filter(Boolean);
}

function parseOpenClawMcpListJson(output = "") {
  const parsed = String(output || "").trim() ? JSON.parse(output) : [];
  const entries = Array.isArray(parsed) ? parsed : Object.entries(parsed.mcpServers || parsed.mcp_servers || parsed.servers || {})
    .map(([name, spec]) => ({ name, ...spec }));
  return entries
    .map((entry) => {
      const enabled = entry.enabled !== false;
      return normalizeDetected("openclaw", entry.name, transportFromJsonEntry(entry), enabled, enabled ? "" : "Disabled");
    })
    .filter(Boolean);
}

function parseHermesConfigYaml(content = "") {
  const parsed = yaml.load(String(content || "")) || {};
  const servers = parsed.mcp_servers && typeof parsed.mcp_servers === "object" ? parsed.mcp_servers : {};
  return Object.entries(servers)
    .map(([name, spec]) => {
      const value = spec && typeof spec === "object" ? spec : {};
      const transportInput = value.command
        ? { type: "stdio", command: value.command, args: value.args || [], env: value.env || {} }
        : {
            type: value.type || (value.url ? "http" : ""),
            url: value.url,
            headers: value.headers || {},
            bearerTokenEnvVar: value.bearerTokenEnvVar || value.bearer_token_env_var
          };
      return normalizeDetected("hermes", name, transportInput, true, "");
    })
    .filter(Boolean);
}

function defaultRunner(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, stdout, stderr: `${stderr}\nTimed out` });
    }, options.timeoutMs || 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, stdout, stderr, code }));
  });
}

function sourceResult(source, installed, servers = [], error = "") {
  return {
    source,
    installed: installed === true,
    servers: Array.isArray(servers) ? servers : [],
    error: sanitizeSecretText(error || "")
  };
}

function createCoreMcpAgentConfigService(deps = {}) {
  const fsImpl = deps.fs || fsDefault;
  const runtimePaths = typeof deps.runtimePaths === "function" ? deps.runtimePaths : () => ({});
  const runner = typeof deps.runner === "function" ? deps.runner : defaultRunner;
  const processEnvStrings = typeof deps.processEnvStrings === "function" ? deps.processEnvStrings : () => process.env;

  async function runCliSource(source, command, args, parser) {
    try {
      const result = await runner(command, args, {
        env: processEnvStrings() || process.env,
        timeoutMs: 30000
      });
      if (!result?.ok) {
        return sourceResult(source, false, [], result?.stderr || result?.stdout || `${command} probe failed.`);
      }
      return sourceResult(source, true, parser(result.stdout || ""), "");
    } catch (error) {
      return sourceResult(source, false, [], error?.message || error || `${command} probe failed.`);
    }
  }

  async function claudeConfigs() {
    return runCliSource("claude-code", "claude", ["mcp", "list"], parseClaudeMcpList);
  }

  async function codexConfigs() {
    return runCliSource("codex", "codex", ["mcp", "list", "--json"], parseCodexMcpListJson);
  }

  async function openclawConfigs() {
    return runCliSource("openclaw", "openclaw", ["mcp", "list", "--json"], parseOpenClawMcpListJson);
  }

  async function hermesConfigs() {
    try {
      const paths = runtimePaths() || {};
      const hermesHome = String(paths.hermesHome || "").trim();
      if (!hermesHome) return sourceResult("hermes", false, [], "");
      const configPath = path.join(hermesHome, "config.yaml");
      const content = fsImpl.readFileSync(configPath, "utf8");
      return sourceResult("hermes", true, parseHermesConfigYaml(content), "");
    } catch (error) {
      if (error && error.code === "ENOENT") return sourceResult("hermes", false, [], "");
      return sourceResult("hermes", false, [], error?.message || error || "Hermes config probe failed.");
    }
  }

  async function getAgentConfigs() {
    const sources = await Promise.all([
      claudeConfigs(),
      codexConfigs(),
      openclawConfigs(),
      hermesConfigs()
    ]);
    const bySource = new Map(sources.map((source) => [source.source, source]));
    return SOURCE_ORDER.map((source) => bySource.get(source) || sourceResult(source, false, [], ""));
  }

  async function importAgentConfig(input = {}) {
    const sourceAgent = String(input.sourceAgent || "").trim();
    const serverName = String(input.serverName || "").trim();
    const sources = await getAgentConfigs();
    const source = sources.find((item) => item.source === sourceAgent);
    const server = source?.servers?.find((item) => item.name === serverName);
    if (!server) throw new Error("Discovered MCP server not found.");
    if (server.importable !== true) {
      throw new Error(server.importSkipReason || "Discovered MCP server is not importable.");
    }
    return { imported: 1, server };
  }

  return { getAgentConfigs, importAgentConfig };
}

module.exports = {
  createCoreMcpAgentConfigService,
  parseClaudeMcpList,
  parseCodexMcpListJson,
  parseHermesConfigYaml,
  parseOpenClawMcpListJson
};
