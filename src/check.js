const fs = require("node:fs");
const childProcess = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const rootDir = path.join(__dirname, "..");

function commandOnPath(command) {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  try {
    return childProcess.execFileSync(checker, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

function resolveBash() {
  const found = commandOnPath("bash");
  if (found) return found;
  if (process.platform !== "win32") return "bash";

  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "usr", "bin", "bash.exe")
  ];
  const bash = candidates.find((candidate) => fs.existsSync(candidate));
  if (bash) return bash;
  throw new Error("Missing bash. Install Git for Windows or add Git\\bin to PATH.");
}

const required = [
  "src/main.js",
  "src/main/chat-engine-registry.js",
  "src/main/chat-events.js",
  "src/main/chat-response.js",
  "src/main/bot-registry.js",
  "src/main/native-turn-helpers.js",
  "src/main/conversation-title-service.js",
  "src/main/bot-manifest.js",
  "src/main/runtime-paths.js",
  "src/main/settings-store.js",
  "src/main/skills-loader.js",
  "src/cloud/sqlite-store.js",
  "src/cloud/desktop-bridge-permission.js",
  "src/permission-modes.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/app.js",
  "src/renderer/styles.css",
  "src/web/index.html",
  "src/web/app.js",
  "src/web/styles.css",
  "src/web/favicon.svg",
  "src/web/apple-touch-icon.png",
  "src/web/icon-192.png",
  "src/web/icon-512.png",
  "src/web/assets/mia.css",
  "src/web/assets/mia.js",
  "src/web/assets/mia-gradient.css",
  "src/web/assets/mia-scroll.css",
  "src/web/assets/mia-scroll.js",
  "src/web/assets/mia-logo.png",
  "src/web/manifest.webmanifest",
  "scripts/clean-release.js",
  "scripts/build-win.js",
  "electron-builder.mac-intel.js",
  "scripts/serve-web.js",
  "scripts/serve-cloud.js",
  "scripts/build-cloud-release.js",
  "scripts/print-cloud-release-handoff.js",
  "scripts/verify-cloud-production.js",
  "scripts/audit-cloud-productization.js",
  "scripts/diagnose-deploy-ssh.js",
  "scripts/print-cloud-blockers.js",
  "scripts/deploy-cloud-release.sh",
  "scripts/install-cloud-release-local.sh",
	  "scripts/doctor-cloud.js",
	  "scripts/smoke-cloud.js",
	  "scripts/prepare-mia-core-rs.js",
	  "scripts/verify-packaged-mia-core.js",
	  "scripts/local-agent-bridge.js",
  "docs/cloud-deployment.md",
  "scripts/create-mac-dmg.js",
  "skills/_builtin/pet-generator/SKILL.md",
  "skills/_builtin/pet-generator/scripts/prepare_pet_run.py",
  "skills/_builtin/pet-generator/scripts/derive_running_left_from_running_right.py",
  "resources/pet-generator/alkaka-friend-pet/SKILL.md",
  "resources/pet-generator/alkaka-friend-pet/assets/alkaka-style-reference.jpg",
  "resources/pet-generator/alkaka-friend-pet/scripts/prepare_pet_run.py",
  "resources/pet-generator/alkaka-friend-pet/scripts/finalize_pet_run.py",
  "resources/pet-generator/alkaka-friend-pet/scripts/package_custom_pet.py",
  "resources/pet-generator/alkaka-friend-pet/scripts/record_imagegen_result.py",
  "resources/pet-generator/hatch_generate.py",
  "resources/pet-generator/petctl.py",
  "src/renderer/tasks/tasks-panel.js",
  "src/renderer/bot/pet-dialog.js",
  "src/renderer/bot/bot-directory.js",
  "src/renderer/bot/bot-dialog.js",
  "src/renderer/bot/bot-manager.js",
  "src/renderer/assets/lottie/label.json",
  "src/shared/trace-blocks.js",
  "src/shared/conversation-tags.js",
  "src/renderer/chat/message-helpers.js",
  "src/renderer/chat/composer.js",
  "src/renderer/chat/message-menu.js",
  "src/renderer/settings/settings-appearance.js",
  "src/renderer/settings/settings-remote.js",
  "src/renderer/settings/model-helpers.js",
  "src/renderer/settings/engine-options.js",
  "src/renderer/settings/model-settings.js",
  "src/renderer/loaders.js",
  "src/renderer/skills/skill-helpers.js",
  "src/renderer/skills/skill-library.js",
  "src/renderer/onboarding/setup-guide.js",
  "src/renderer/helpers/avatar-helpers.js",
  "src/renderer/helpers/markdown-helpers.js",
  "src/renderer/helpers/format-helpers.js",
  "src/renderer/helpers/scrollbar-overlay.js",
  "src/renderer/helpers/accordion.js",
  "packages/shared/package.json",
  "packages/shared/index.js",
  "packages/shared/index.d.ts",
  "packages/shared/avatar.js",
  "packages/shared/avatar.d.ts",
  "packages/shared/contact.js",
  "packages/shared/contact.d.ts",
  "packages/shared/group-tiles.js",
  "packages/shared/group-tiles.d.ts",
  "packages/shared/send-pipeline.js",
  "packages/shared/send-pipeline.d.ts",
  "packages/shared/self-identity.js",
  "packages/shared/session-history.js",
  "packages/shared/session-history.d.ts",
  "packages/shared/cloud-client.js",
  "packages/shared/cloud-client.d.ts",
  "packages/shared/bot-identity.js",
  "packages/shared/bot-identity.d.ts",
  "src/shared/avatar-resolve.js",
  "src/shared/bot-identity.js",
  "resources/conductor/default-prompts/dispatch.md",
  "resources/conductor/default-prompts/summarize.md",
  "resources/conductor/default-prompts/nudge.md",
  "resources/conductor/default-prompts/relay.md"
];

for (const file of required) {
  const full = path.join(rootDir, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${file}`);
  }
}

const forbiddenRootDuplicates = [
  "main.js",
  "desktop-bridge-permission.js"
];

for (const file of forbiddenRootDuplicates) {
  const full = path.join(rootDir, file);
  if (fs.existsSync(full)) {
    throw new Error(`Unexpected root-level duplicate source file: ${file}`);
  }
}

for (const file of ["electron-builder.mac-arm64.js", "electron-builder.mac-intel.js", "src/main.js", "src/main/chat-engine-registry.js", "src/main/chat-events.js", "src/main/chat-response.js", "src/main/bot-registry.js", "src/main/native-turn-helpers.js", "src/cloud/sqlite-store.js", "src/cloud/desktop-bridge-permission.js", "src/shared/conversation-tags.js", "src/shared/mia-core-http.js", "src/permission-modes.js", "src/preload.js", "src/renderer/bot/bot-directory.js", "src/renderer/app.js", "src/web/app.js", "packages/shared/index.js", "packages/shared/avatar.js", "packages/shared/contact.js", "packages/shared/group-tiles.js", "packages/shared/send-pipeline.js", "packages/shared/approval-queue.js", "packages/shared/optimistic-send.js", "packages/shared/session-history.js", "packages/shared/cloud-client.js", "packages/shared/bot-identity.js", "scripts/serve-web.js", "scripts/serve-cloud.js", "scripts/build-cloud-release.js", "scripts/build-win.js", "scripts/print-cloud-release-handoff.js", "scripts/verify-cloud-production.js", "scripts/audit-cloud-productization.js", "scripts/diagnose-deploy-ssh.js", "scripts/print-cloud-blockers.js", "scripts/doctor-cloud.js", "scripts/smoke-cloud.js", "scripts/prepare-mia-core-rs.js", "scripts/verify-packaged-mia-core.js", "scripts/local-agent-bridge.js", "scripts/notarize-mac-dmg.js"]) {
  childProcess.execFileSync(process.execPath, ["--check", path.join(rootDir, file)], {
    stdio: "inherit"
  });
}

const bash = resolveBash();
childProcess.execFileSync(bash, ["-n", path.join(rootDir, "scripts/deploy-cloud-release.sh")], {
  stdio: "inherit"
});
childProcess.execFileSync(bash, ["-n", path.join(rootDir, "scripts/install-cloud-release-local.sh")], {
  stdio: "inherit"
});

const { normalizePermissionMode, permissionModeLabel } = require("./permission-modes");
const {
  adapterForEngine,
  normalizeAgentEngine,
  resolveChatEngineAdapter
} = require("./main/chat-engine-registry.js");

assert.equal(normalizePermissionMode("ask"), "ask");
assert.equal(normalizePermissionMode("deny"), "deny");
assert.equal(normalizePermissionMode("yolo"), "yolo");
assert.equal(normalizePermissionMode("manual"), "ask");
assert.equal(normalizePermissionMode("off"), "yolo");
assert.equal(permissionModeLabel("ask"), "Ask");
assert.equal(permissionModeLabel("yolo"), "YOLO");
assert.equal(permissionModeLabel("deny"), "Deny");

assert.equal(normalizeAgentEngine("claude"), "claude-code");
assert.equal(normalizeAgentEngine("openai_codex"), "codex");
assert.equal(normalizeAgentEngine("unknown"), "hermes");
assert.equal(adapterForEngine("codex").responseModel, "codex-cli");
assert.equal(resolveChatEngineAdapter({ agent_engine: "claude-code" }).transport, "claude-agent-sdk");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
// Model/provider selection is owned by Rust Core settings; Electron settings-store
// must not keep a default Hermes model fallback.
const settingsStoreSource = fs.readFileSync(path.join(__dirname, "main", "settings-store.js"), "utf8");
assert.doesNotMatch(settingsStoreSource, /function defaultModelSettings|mia-model\.json|apiKeyEnv|apiMode/);
assert.match(mainSource, /requestSingleInstanceLock/);

const cloudServerSource = fs.readFileSync(path.join(__dirname, "..", "scripts/serve-cloud.js"), "utf8");
assert.match(cloudServerSource, /createCloudStore/);
assert.doesNotMatch(cloudServerSource, /\b(readDb|writeDb|emptyDb|authenticatedToken|createSession|serveFile)\b/);
assert.doesNotMatch(cloudServerSource, /\/api\/auth\/(?:login|register)/);
assert.doesNotMatch(cloudServerSource, /\bdb\.users\b|\bdb\.sessions\b|\bdb\.workspaces\b|\bdb\.files\b/);
assert.match(cloudServerSource, /allowQueryTokenAuth/);
assert.doesNotMatch(cloudServerSource, /authenticateToken\([^)]*url\.searchParams\.get\("token"\)/);

assert.doesNotMatch(packageJson.scripts.prepack || "", /hermes:runtime/);
assert.doesNotMatch(packageJson.scripts.pack || "", /hermes:runtime/);
assert.doesNotMatch(packageJson.scripts["dist:mac"], /hermes:runtime/);
assert.doesNotMatch(packageJson.scripts["dist:mac:intel"], /hermes:runtime/);
assert.doesNotMatch(packageJson.scripts["dist:mac:x64"], /hermes:runtime/);
assert.doesNotMatch(packageJson.scripts["dist:win"], /hermes:runtime/);
assert.doesNotMatch(JSON.stringify(packageJson.build.mac || {}), /vendor\/hermes-runtime/);
assert.doesNotMatch(JSON.stringify(packageJson.build.win || {}), /vendor\/hermes-runtime/);
assert.equal(packageJson.build.mac?.hardenedRuntime, true);
assert.match(packageJson.scripts["notarize:mac"] || "", /notarize-mac-dmg\.js/);
assert.match(packageJson.scripts["notarize:mac:intel"] || "", /notarize-mac-dmg\.js/);

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml"
]);
const textBasenames = new Set(["Dockerfile", "Makefile"]);
const legacyHost = "ai" + "web" + "." + ("buy" + "tb01") + ".com";
const legacyRoot = "buy" + "tb01";
const forbiddenLegacyProductionHosts = [legacyHost, legacyRoot + ".com", legacyRoot];

function trackedFiles() {
  try {
    return childProcess.execFileSync("git", ["ls-files", "-z"], {
      cwd: rootDir,
      encoding: "utf8"
    }).split("\0").filter(Boolean);
  } catch {
    return required;
  }
}

for (const relativePath of trackedFiles()) {
  const ext = path.extname(relativePath).toLowerCase();
  const basename = path.basename(relativePath);
  if (!textExtensions.has(ext) && !textBasenames.has(basename)) continue;
  const absolutePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(absolutePath)) continue;
  const source = fs.readFileSync(absolutePath, "utf8").toLowerCase();
  for (const forbidden of forbiddenLegacyProductionHosts) {
    if (source.includes(forbidden)) {
      throw new Error(`Legacy production host reference found in ${relativePath}`);
    }
  }
}

console.log("Mia project structure OK");
