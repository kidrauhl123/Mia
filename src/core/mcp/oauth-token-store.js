"use strict";

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const path = require("node:path");

function tokenKey(serverUrl) {
  return crypto.createHash("sha256").update(String(serverUrl || "").trim()).digest("hex");
}

function createCoreMcpOAuthTokenStore(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  const fs = deps.fs || fsDefault;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  function filePath() {
    const paths = runtimePaths() || {};
    return path.join(paths.runtime || paths.home, "mcp-oauth-tokens.json");
  }

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(value) {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  async function saveToken(serverUrl, token = {}) {
    const normalizedUrl = String(serverUrl || "").trim();
    if (!normalizedUrl) throw new Error("serverUrl is required.");
    const all = readAll();
    const key = tokenKey(normalizedUrl);
    all[key] = {
      serverUrl: normalizedUrl,
      ...token,
      updatedAt: now()
    };
    writeAll(all);
    return all[key];
  }

  async function getToken(serverUrl) {
    const normalizedUrl = String(serverUrl || "").trim();
    if (!normalizedUrl) return null;
    return readAll()[tokenKey(normalizedUrl)] || null;
  }

  async function deleteToken(serverUrl) {
    const normalizedUrl = String(serverUrl || "").trim();
    if (!normalizedUrl) return;
    const all = readAll();
    delete all[tokenKey(normalizedUrl)];
    writeAll(all);
  }

  async function publicStatus(serverUrl) {
    const token = await getToken(serverUrl);
    return {
      authenticated: Boolean(token?.accessToken && (!token.expiresAt || token.expiresAt > now())),
      expiresAt: token?.expiresAt || null,
      tokenType: token?.tokenType || token?.token_type || ""
    };
  }

  return {
    deleteToken,
    getToken,
    publicStatus,
    saveToken
  };
}

module.exports = {
  createCoreMcpOAuthTokenStore,
  tokenKey
};
