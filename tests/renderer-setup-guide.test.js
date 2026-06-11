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
      recommendedAction: "continue",
      ...summary
    }
  };
}

test("setup guide renders scanning state before agent inventory is available", () => {
  const state = {
    runtime: null,
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.equal(guide.shouldShowSetupGuide({ messages: [] }), true);
  assert.match(html, /正在扫描本机 Agent/);
  assert.match(html, /data-lottie="chemistry"/);
  assert.match(html, /data-lottie-trigger="loop"/);
  assert.doesNotMatch(html, /setup-engine-list/);
});

test("setup guide keeps the scanning state while agent inventory is still checking", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, health: "checking", source: "checking" }
      ], { scanning: true }),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /正在扫描本机 Agent/);
  assert.match(html, /data-lottie="chemistry"/);
  assert.doesNotMatch(html, /扫描结果/);
});

test("setup guide offers official agent installs when no local agent is available", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: false, usableInMia: false, installable: true, installAction: "install-claude-code", health: "missing", source: "missing" },
        { id: "codex", label: "Codex", installed: false, usableInMia: false, installable: true, installAction: "install-codex", health: "missing", source: "missing" },
        { id: "openclaw", label: "OpenClaw", installed: false, usableInMia: false, installable: true, installAction: "install-openclaw", detectionOnly: false, health: "missing", source: "missing" }
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
  assert.match(html, /欢迎使用 Mia/);
  assert.match(html, /本机 Agent/);
  assert.match(html, /data-setup-action="finish-agent-scan"/);
  assert.match(html, /data-setup-action="install-hermes"/);
  assert.match(html, /data-setup-action="install-claude-code"/);
  assert.match(html, /data-setup-action="install-codex"/);
  assert.doesNotMatch(html, /data-setup-action="use-engine"/);
  assert.match(html, /data-action="cloud-login"/);
  assert.match(html, /OpenClaw/);
  assert.match(html, /安装官方 Hermes/);
  assert.match(html, /data-setup-action="install-openclaw"/);
  assert.match(html, /安装 OpenClaw/);
  assert.doesNotMatch(html, /私有目录|Mia 私有 Hermes|独立副本/);
  assert.doesNotMatch(html, /使用 OpenClaw/);
  assert.match(html, /setup-engine-icon hermes/);
  assert.match(html, /assets\/engine-icons\/hermesagent\.svg/);
  assert.doesNotMatch(html, /setup-engine-dot/);
});

test("setup guide disables entering Mia while an engine install is in flight", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: false, usableInMia: false, installable: true, installAction: "install-claude-code", health: "missing", source: "missing" },
        { id: "codex", label: "Codex", installed: false, usableInMia: false, installable: true, installAction: "install-codex", health: "missing", source: "missing" },
        { id: "openclaw", label: "OpenClaw", installed: false, usableInMia: false, installable: true, installAction: "install-openclaw", detectionOnly: false, health: "missing", source: "missing" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupInstallInFlight: true,
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /data-setup-action="finish-agent-scan"[^>]*disabled/);
  assert.match(html, /data-setup-action="install-hermes"[^>]*disabled/);
  assert.match(html, /data-setup-action="install-claude-code"[^>]*disabled/);
  assert.match(html, /data-setup-action="install-codex"[^>]*disabled/);
  assert.match(html, /data-setup-action="install-openclaw"[^>]*disabled/);
});

test("setup guide shows current engine install progress", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupInstallInFlight: true,
    agentSetupInstallEngine: "hermes",
    agentSetupInstallMessage: "Downloading Hermes runtime...",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /Downloading Hermes runtime/);
});

test("setup guide allows installed Claude Code, Codex, and OpenClaw as ready engines", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: false, usableInMia: false, installable: true, installAction: "install-hermes", health: "missing", source: "missing" },
        { id: "claude-code", label: "Claude Code", installed: true, usableInMia: true, installable: true, path: "/bin/claude", version: "claude 1.2.3", health: "ready", source: "system" },
        { id: "codex", label: "Codex", installed: true, usableInMia: true, installable: true, path: "/bin/codex", version: "codex 2.3.4", health: "ready", source: "system" },
        { id: "openclaw", label: "OpenClaw", installed: true, usableInMia: true, installable: true, detectionOnly: false, path: "/bin/openclaw", version: "openclaw 0.1.0", health: "ready", source: "system" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.doesNotMatch(html, /使用 Claude Code/);
  assert.doesNotMatch(html, /使用 Codex/);
  assert.match(html, /已就绪/);
  assert.doesNotMatch(html, /暂未接入 Mia 聊天|已检测到，暂未接入/);
  assert.match(html, /assets\/engine-icons\/claudecode\.svg/);
  assert.match(html, /assets\/engine-icons\/codex-color\.svg/);
  assert.match(html, /assets\/provider-icons\/openclaw-color\.svg/);
  // All engines are treated alike now: a missing Hermes still offers install
  // even when another engine is usable. Installed engines show no install
  // button.
  assert.match(html, /data-setup-action="install-hermes"/);
  assert.doesNotMatch(html, /data-setup-action="install-claude-code"/);
  assert.doesNotMatch(html, /data-setup-action="install-codex"/);
  assert.doesNotMatch(html, /data-setup-action="install-openclaw"/);
});

test("setup guide allows system Hermes without requiring Mia private install", () => {
  const state = {
    runtime: {
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: true, usableInMia: true, installable: true, path: "/bin/hermes", version: "Hermes Agent v0.11.0", health: "ready", source: "system" }
      ]),
      fellows: []
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /\/bin\/hermes · Hermes Agent/);
  assert.doesNotMatch(html, /仍需要独立副本/);
  assert.doesNotMatch(html, /data-setup-action="install-hermes"/);
  assert.doesNotMatch(html, /data-setup-action="use-engine"/);
});

test("setup guide renders broken Hermes with official repair action", () => {
  const state = {
    runtime: {
      fellows: [],
      agentInventory: inventory([
        { id: "hermes", label: "Hermes", installed: true, usableInMia: false, installable: true, installAction: "repair-hermes", health: "broken", source: "broken" }
      ])
    },
    onboardingStep: "engine",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);
  const html = guide.renderSetupGuide();

  assert.match(html, /Hermes/);
  assert.match(html, /data-setup-action="repair-hermes"/);
  assert.match(html, /修复官方 Hermes/);
  assert.match(html, /官方 Hermes 状态异常，可修复/);
  assert.doesNotMatch(html, /私有目录|Mia 私有 Hermes|独立副本/);
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

test("setup guide is not triggered only because there are no bots", () => {
  const state = {
    runtime: { fellows: [], agentInventory: inventory([]) },
    firstRun: false,
    onboardingStep: "",
    agentSetupSkipped: false,
    setupGuideDismissed: false
  };
  const guide = loadSetupGuide(state);

  assert.equal(guide.shouldShowSetupGuide({ messages: [] }), false);
});
