"use strict";

function cleanString(value = "") {
  return String(value || "").trim();
}

function pairArray(value = {}) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        const name = cleanString(entry?.name);
        if (!name) return null;
        return { name, value: String(entry?.value ?? "") };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .map(([name, pairValue]) => ({ name: cleanString(name), value: String(pairValue ?? "") }))
    .filter((entry) => entry.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeAcpMcpServer(name, spec = {}) {
  if (!spec || typeof spec !== "object") return null;
  const serverName = cleanString(spec.name || name);
  if (!serverName) return null;
  const type = cleanString(spec.type).toLowerCase();
  const command = cleanString(spec.command);
  const url = cleanString(spec.url);

  if (command) {
    return {
      name: serverName,
      command,
      args: Array.isArray(spec.args) ? spec.args.map((arg) => String(arg)) : [],
      env: pairArray(spec.env)
    };
  }

  if ((type === "http" || type === "sse" || url) && url) {
    return {
      type: type === "sse" ? "sse" : "http",
      name: serverName,
      url,
      headers: pairArray(spec.headers)
    };
  }

  return null;
}

function normalizeAcpMcpServers(input = {}) {
  if (Array.isArray(input)) {
    return input.map((spec) => normalizeAcpMcpServer(spec?.name, spec)).filter(Boolean);
  }
  if (!input || typeof input !== "object") return [];
  return Object.entries(input)
    .map(([name, spec]) => normalizeAcpMcpServer(name, spec))
    .filter(Boolean);
}

module.exports = {
  normalizeAcpMcpServer,
  normalizeAcpMcpServers,
  pairArray
};
