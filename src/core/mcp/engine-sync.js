"use strict";

function enabled(records = []) {
  return (Array.isArray(records) ? records : []).filter((record) => record?.enabled !== false && !record?.deletedAt);
}

function mcpNativeName(record = {}) {
  return String(record?.nativeName || record?.native_name || record?.name || "").trim();
}

function unsupportedStatus(record = {}, engine, reason, detail = {}) {
  return {
    engine,
    name: String(record?.name || ""),
    transportType: String(record?.transport?.type || ""),
    status: "unsupported",
    reason,
    ...detail
  };
}

function reportUnsupported(options = {}, entry) {
  if (!entry) return;
  if (typeof options.onUnsupported === "function") {
    options.onUnsupported(entry);
  }
  if (Array.isArray(options.statusCollector)) {
    options.statusCollector.push(entry);
    return;
  }
  if (typeof options.statusCollector === "function") {
    options.statusCollector(entry);
  }
}

function bridgeMcpSpec({ command, scriptPath, bridgeUrl, secret }) {
  return {
    type: "stdio",
    command,
    args: [scriptPath],
    env: {
      MIA_MCP_BRIDGE_URL: bridgeUrl,
      MIA_MCP_BRIDGE_SECRET: secret
    },
    alwaysLoad: true
  };
}

function toNativeSpec(record = {}) {
  const transport = record.transport || {};
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      args: Array.isArray(transport.args) ? transport.args.slice() : [],
      env: { ...(transport.env || {}) }
    };
  }
  return {
    type: transport.type === "streamable_http" ? "http" : transport.type,
    url: transport.url,
    headers: { ...(transport.headers || {}) },
    ...(transport.bearerTokenEnvVar ? { bearer_token_env_var: transport.bearerTokenEnvVar } : {})
  };
}

function mcpSpecsForClaudeSdk(records = []) {
  return Object.fromEntries(enabled(records).map((record) => [mcpNativeName(record), toNativeSpec(record)]));
}

function hasArbitraryHeaders(record = {}) {
  const transport = record.transport || {};
  return Object.keys(transport.headers || {}).length > 0;
}

function codexRequiresBridge(record = {}) {
  const transport = record.transport || {};
  if (transport.type === "sse") return true;
  if (transport.type === "http" || transport.type === "streamable_http") {
    return hasArbitraryHeaders(record);
  }
  return false;
}

function codexBridgeReason(record = {}) {
  const transport = record.transport || {};
  if (transport.type === "sse") return "bridge_required_for_sse";
  if ((transport.type === "http" || transport.type === "streamable_http") && hasArbitraryHeaders(record)) {
    return "bridge_required_for_http_headers";
  }
  return "";
}

function codexNativeSpec(record = {}) {
  const transport = record.transport || {};
  if (transport.type === "stdio") return toNativeSpec(record);
  return {
    type: transport.type === "streamable_http" ? "http" : transport.type,
    url: transport.url,
    ...(transport.bearerTokenEnvVar ? { bearer_token_env_var: transport.bearerTokenEnvVar } : {})
  };
}

function mcpSpecsForCodex(records = [], options = {}) {
  const { bridge = null } = options;
  const specs = {};
  let needsBridge = false;
  for (const record of enabled(records)) {
    if (codexRequiresBridge(record)) {
      needsBridge = true;
      if (!bridge) {
        reportUnsupported(options, unsupportedStatus(record, "codex", codexBridgeReason(record), {
          bridgeRequired: true
        }));
      }
      continue;
    }
    specs[mcpNativeName(record)] = codexNativeSpec(record);
  }
  if (needsBridge && bridge) specs["mia-mcp-bridge"] = bridge;
  return specs;
}

function mcpSpecsForHermes(records = [], options = {}) {
  const { hermesSupportsUrl = false, bridge = null } = options;
  const specs = {};
  let needsBridge = false;
  for (const record of enabled(records)) {
    const transport = record.transport || {};
    if (transport.type === "stdio") {
      specs[mcpNativeName(record)] = toNativeSpec(record);
      continue;
    }
    if (hermesSupportsUrl) {
      specs[mcpNativeName(record)] = toNativeSpec(record);
      continue;
    }
    needsBridge = true;
    if (!bridge) {
      reportUnsupported(options, unsupportedStatus(record, "hermes", "bridge_required_for_non_stdio_transport", {
        bridgeRequired: true
      }));
    }
  }
  if (needsBridge && bridge) specs["mia-mcp-bridge"] = bridge;
  return specs;
}

function planCodexCliSync(records = []) {
  return enabled(records).map((record) => {
    const transport = record.transport || {};
    const name = mcpNativeName(record);
    if (transport.type === "stdio") {
      const args = ["mcp", "add", name];
      for (const [key, value] of Object.entries(transport.env || {})) {
        args.push("--env", `${key}=${String(value)}`);
      }
      args.push("--", transport.command, ...(transport.args || []).map(String));
      return { engine: "codex", name, args };
    }
    const args = ["mcp", "add", name, "--url", transport.url];
    if (transport.bearerTokenEnvVar) args.push("--bearer-token-env-var", transport.bearerTokenEnvVar);
    return { engine: "codex", name, args };
  });
}

function planClaudeCliSync(records = []) {
  return enabled(records).map((record) => {
    const transport = record.transport || {};
    const name = mcpNativeName(record);
    if (transport.type === "stdio") {
      return {
        engine: "claude-code",
        name,
        args: ["mcp", "add-json", "-s", "user", name, JSON.stringify(toNativeSpec(record))]
      };
    }
    const args = [
      "mcp",
      "add",
      "-s",
      "user",
      "--transport",
      transport.type === "streamable_http" ? "http" : transport.type,
      name,
      transport.url
    ];
    for (const [key, value] of Object.entries(transport.headers || {})) {
      args.push("--header", `${key}: ${String(value)}`);
    }
    return { engine: "claude-code", name, args };
  });
}

function planCodexCliRemove(records = []) {
  return (Array.isArray(records) ? records : []).map((record) => ({
    engine: "codex",
    name: mcpNativeName(record),
    args: ["mcp", "remove", mcpNativeName(record)]
  }));
}

function planClaudeCliRemove(records = []) {
  return (Array.isArray(records) ? records : []).map((record) => ({
    engine: "claude-code",
    name: mcpNativeName(record),
    args: ["mcp", "remove", "-s", "user", mcpNativeName(record)]
  }));
}

function recordSignature(record = {}) {
  return JSON.stringify({
    enabled: record?.enabled !== false,
    nativeName: mcpNativeName(record),
    transport: record?.transport || {}
  });
}

function diffRecords(previousRecords = [], currentRecords = []) {
  const previousByName = new Map((Array.isArray(previousRecords) ? previousRecords : []).map((record) => [mcpNativeName(record), record]));
  const currentByName = new Map((Array.isArray(currentRecords) ? currentRecords : []).map((record) => [mcpNativeName(record), record]));

  const toRemove = [];
  const toAdd = [];

  for (const [name, previousRecord] of previousByName.entries()) {
    const currentRecord = currentByName.get(name);
    const previousEnabled = previousRecord?.enabled !== false;
    const currentEnabled = currentRecord?.enabled !== false;
    const changed = currentRecord && recordSignature(previousRecord) !== recordSignature(currentRecord);
    if (previousEnabled && (!currentRecord || !currentEnabled || changed)) {
      toRemove.push(previousRecord);
    }
  }

  for (const [name, currentRecord] of currentByName.entries()) {
    if (currentRecord?.enabled === false) continue;
    toAdd.push(currentRecord);
  }

  return { toRemove, toAdd };
}

function defaultStatus() {
  return { status: "noop", error: "", commands: [] };
}

function codexNativeUnsupported(record = {}) {
  const transport = record.transport || {};
  return codexRequiresBridge(record);
}

async function executePlans({ engine, commandPath, plans, runCommand, statuses, commands, appendLog }) {
  if (!commandPath || !plans.length) return;
  for (const plan of plans) {
    statuses[engine].commands.push({ command: commandPath, args: plan.args.slice() });
    commands.push({ engine, command: commandPath, args: plan.args.slice() });
    appendLog(`[MCP sync] ${engine} ${plan.args[1]} ${plan.name}`);
    const result = await runCommand(commandPath, plan.args.slice(), { engine, name: plan.name });
    if (result?.ok === false) {
      throw new Error(String(result?.stderr || result?.stdout || `${engine} MCP sync failed for ${plan.name}`));
    }
  }
}

async function runNativeMcpCliSync({
  currentRecords = [],
  previousRecords = [],
  runCommand,
  cliPaths = {},
  appendLog = () => {}
} = {}) {
  if (typeof runCommand !== "function") {
    throw new Error("runCommand is required");
  }

  const commands = [];
  const statuses = {
    codex: defaultStatus(),
    "claude-code": defaultStatus()
  };
  const { toRemove, toAdd } = diffRecords(previousRecords, currentRecords);

  const codexUnsupported = toAdd.filter(codexNativeUnsupported);
  const codexAddable = toAdd.filter((record) => !codexNativeUnsupported(record));

  try {
    await executePlans({
      engine: "codex",
      commandPath: cliPaths.codex,
      plans: planCodexCliRemove(toRemove),
      runCommand,
      statuses,
      commands,
      appendLog
    });
  } catch (error) {
    statuses.codex.status = "error";
    statuses.codex.error = String(error?.message || error);
  }

  try {
    await executePlans({
      engine: "claude-code",
      commandPath: cliPaths.claude,
      plans: planClaudeCliRemove(toRemove),
      runCommand,
      statuses,
      commands,
      appendLog
    });
  } catch (error) {
    statuses["claude-code"].status = "error";
    statuses["claude-code"].error = String(error?.message || error);
  }

  try {
    if (codexUnsupported.length) {
      const names = codexUnsupported.map((record) => record.name).join(", ");
      statuses.codex.status = "error";
      statuses.codex.error = `Codex native MCP sync has unsupported arbitrary HTTP headers without bearerTokenEnvVar: ${names}`;
      appendLog(`[MCP sync] codex unsupported ${names}`);
    }

    await executePlans({
      engine: "codex",
      commandPath: cliPaths.codex,
      plans: planCodexCliSync(codexAddable),
      runCommand,
      statuses,
      commands,
      appendLog
    });

    if (statuses.codex.status !== "error") {
      statuses.codex.status = statuses.codex.commands.length ? "synced" : "noop";
    }
  } catch (error) {
    statuses.codex.status = "error";
    statuses.codex.error = String(error?.message || error);
  }

  try {
    await executePlans({
      engine: "claude-code",
      commandPath: cliPaths.claude,
      plans: planClaudeCliSync(toAdd),
      runCommand,
      statuses,
      commands,
      appendLog
    });
    if (statuses["claude-code"].status !== "error") {
      statuses["claude-code"].status = statuses["claude-code"].commands.length ? "synced" : "noop";
    }
  } catch (error) {
    statuses["claude-code"].status = "error";
    statuses["claude-code"].error = String(error?.message || error);
  }

  return {
    success: statuses.codex.status !== "error" && statuses["claude-code"].status !== "error",
    statuses,
    commands
  };
}

module.exports = {
  bridgeMcpSpec,
  mcpSpecsForClaudeSdk,
  mcpSpecsForCodex,
  mcpSpecsForHermes,
  planClaudeCliRemove,
  planClaudeCliSync,
  planCodexCliRemove,
  planCodexCliSync,
  runNativeMcpCliSync,
  toNativeSpec
};
