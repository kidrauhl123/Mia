const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  agentEnginePolicy,
  nativeHomePathForEngine
} = require("../shared/agent-engine-policy");

function createAgentRuntimeProfileService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();

  function ensureCodexProfile() {
    // Mia runs Codex against the user's native Codex home. Keeping one
    // source of truth avoids config/session drift between Mia and Codex CLI.
    const home = nativeHomePathForEngine("codex", homeDir()) || path.join(homeDir(), ".codex");
    fsImpl.mkdirSync(home, { recursive: true });
    return { home, userHome: home, env: { CODEX_HOME: home } };
  }

  function ensureHermesProfile() {
    const p = runtimePaths();
    const home = p.hermesHome || path.join(homeDir(), ".hermes");
    fsImpl.mkdirSync(home, { recursive: true });
    fsImpl.mkdirSync(p.home, { recursive: true });
    return { home, env: { HERMES_HOME: home, MIA_HOME: p.home } };
  }

  function claudeRunProfile() {
    const policy = agentEnginePolicy("claude-code");
    return { home: "", env: {}, homeStrategy: policy.homeStrategy };
  }

  return {
    claudeRunProfile,
    ensureCodexProfile,
    ensureHermesProfile
  };
}

module.exports = {
  createAgentRuntimeProfileService
};
