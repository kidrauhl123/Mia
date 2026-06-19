const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createAgentRuntimeProfileService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();

  function resolveCodexProfile() {
    const home = path.join(homeDir(), ".codex");
    return { home, userHome: home, env: { CODEX_HOME: home } };
  }

  function resolveCodexProbeProfile() {
    const home = path.join(runtimePaths().runtime, "codex-probe-home");
    return { home, env: { CODEX_HOME: home } };
  }

  function ensureCodexProfile() {
    // Mia runs Codex against the user's native Codex home. Keeping one
    // source of truth avoids config/session drift between Mia and Codex CLI.
    const profile = resolveCodexProfile();
    const home = profile.home;
    fsImpl.mkdirSync(home, { recursive: true });
    return profile;
  }

  function ensureCodexProbeProfile() {
    const profile = resolveCodexProbeProfile();
    fsImpl.mkdirSync(profile.home, { recursive: true });
    return profile;
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
    ensureCodexProbeProfile,
    ensureCodexProfile,
    ensureHermesProfile,
    resolveCodexProbeProfile,
    resolveCodexProfile
  };
}

module.exports = {
  createAgentRuntimeProfileService
};
