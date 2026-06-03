const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_BLOCKED_STATE = new Set([
  "sessions",
  "history.jsonl",
  "session_index.jsonl",
  "memory",
  "memories"
]);

function createAgentRuntimeProfileService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();

  function linkSafeUserState(userHome, miaHome) {
    if (!fsImpl.existsSync(userHome)) return;
    fsImpl.mkdirSync(miaHome, { recursive: true });
    let entries = [];
    try {
      entries = fsImpl.readdirSync(userHome);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "config.toml") continue;
      if (CODEX_BLOCKED_STATE.has(name)) continue;
      const target = path.join(userHome, name);
      const link = path.join(miaHome, name);
      let stat = null;
      try {
        stat = fsImpl.statSync(target);
      } catch {
        continue;
      }
      try {
        fsImpl.rmSync(link, { recursive: true, force: true });
      } catch {
        // Missing or stale links are fine.
      }
      try {
        fsImpl.symlinkSync(target, link, stat.isDirectory() ? "dir" : "file");
      } catch {
        // Partial auth reuse is acceptable; native session isolation is not.
      }
    }
  }

  function ensureCodexProfile() {
    const home = path.join(runtimePaths().runtime, "codex-home");
    const userHome = path.join(homeDir(), ".codex");
    fsImpl.mkdirSync(home, { recursive: true });
    linkSafeUserState(userHome, home);
    return { home, userHome, env: { CODEX_HOME: home } };
  }

  function ensureHermesProfile() {
    const p = runtimePaths();
    fsImpl.mkdirSync(p.home, { recursive: true });
    return { home: p.home, env: { HERMES_HOME: p.home, MIA_HOME: p.home } };
  }

  function claudeRunProfile() {
    const home = path.join(runtimePaths().runtime, "claude-code-home");
    fsImpl.mkdirSync(home, { recursive: true });
    return { home, env: { MIA_CLAUDE_HOME: home } };
  }

  return {
    claudeRunProfile,
    ensureCodexProfile,
    ensureHermesProfile
  };
}

module.exports = {
  CODEX_BLOCKED_STATE,
  createAgentRuntimeProfileService
};
