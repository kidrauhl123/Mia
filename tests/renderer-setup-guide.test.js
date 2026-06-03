const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadSetupGuide(state) {
  const source = fs.readFileSync(path.join(root, "src/renderer/onboarding/setup-guide.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "src/renderer/onboarding/setup-guide.js" });
  sandbox.window.miaSetupGuide.initSetupGuide({ state, escapeHtml });
  return sandbox.window.miaSetupGuide;
}

function inventory(agents, summary = {}) {
  return {
    agents,
    summary: {
      installedCount: agents.filter((agent) => agent.installed).length,
      usableCount: agents.filter((agent) => agent.usableInMia).length,
      missingCount: agents.filter((agent) => !agent.installed).length,
      hasUsableAgent: agents.some((agent) => agent.usableInMia),
      recommendedAction: agents.some((agent) => agent.usableInMia) ? "continue" : "install-hermes",
      ...summary
    }
  };
}

test("setup guide renders no-agent inventory with Hermes install and skip actions", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: false, usableInMia: false, installable: false, health: "missing", source: "missing" },
        { id: "codex", label: "Codex", installed: false, usableInMia: false, installable: false, health: "missing", source: "missing" },
        { id: "openclaw", label: "OpenClaw", installed: false, usableInMia: false, installable: false, detectionOnly: true, health: "missing", source: "missing" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.equal(guide.shouldShowSetupGuide({ messages: [] }), true);
  assert.match(html, /本机 Agent/);
  assert.match(html, /data-setup-action="install-hermes"/);
  assert.match(html, /data-setup-action="continue-no-agent"/);
  assert.match(html, /data-action="cloud-login"/);
  assert.match(html, /OpenClaw/);
  assert.doesNotMatch(html, /使用 OpenClaw/);
});

test("setup guide allows installed Claude Code and Codex while keeping OpenClaw detection-only", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: true, usableInMia: true, installable: false, path: "/bin/claude", version: "claude 1.2.3", health: "ready", source: "system" },
        { id: "codex", label: "Codex", installed: true, usableInMia: true, installable: false, path: "/bin/codex", version: "codex 2.3.4", health: "ready", source: "system" },
        { id: "openclaw", label: "OpenClaw", installed: true, usableInMia: false, installable: false, detectionOnly: true, path: "/bin/openclaw", version: "openclaw 0.1.0", health: "detected", source: "system" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /使用 Claude Code/);
  assert.match(html, /使用 Codex/);
  assert.match(html, /已检测到，暂未接入 Mia 聊天/);
  assert.doesNotMatch(html, /使用 OpenClaw/);
});

test("setup guide stays hidden after user skips agent setup", () => {
  const state = {
    runtime: { fellows: [], agentInventory: inventory([]) },
    onboardingStep: "done",
    agentSetupSkipped: true,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);

  assert.equal(guide.shouldShowSetupGuide({ messages: [] }), false);
});
