const fs = require("node:fs");
const childProcess = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const required = [
  "src/main.js",
  "src/main/chat-engine-adapters.js",
  "src/main/chat-engine-registry.js",
  "src/main/chat-events.js",
  "src/main/chat-response.js",
  "src/main/claude-code-chat-adapter.js",
  "src/main/codex-chat-adapter.js",
  "src/main/fellow-registry.js",
  "src/main/hermes-chat-adapter.js",
  "src/main/chat-store.js",
  "src/main/fellow-manifest.js",
  "src/main/runtime-paths.js",
  "src/main/settings-store.js",
  "src/main/skills-loader.js",
  "src/cloud/sqlite-store.js",
  "src/cloud/desktop-sync.js",
  "src/cloud/desktop-bridge-permission.js",
  "src/permission-modes.js",
  "src/runtime-resource-paths.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/app.js",
  "src/renderer/styles.css",
  "src/mobile/index.html",
  "src/mobile/app.js",
  "src/mobile/styles.css",
  "src/web/index.html",
  "src/web/app.js",
  "src/web/styles.css",
  "src/web/favicon.svg",
  "src/web/apple-touch-icon.png",
  "src/web/icon-192.png",
  "src/web/icon-512.png",
  "src/web/manifest.webmanifest",
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
  "scripts/local-agent-bridge.js",
  "docs/cloud-deployment.md",
  "src/relay/server.js",
  "scripts/create-mac-dmg.js",
  "skills/pet-generator/SKILL.md",
  "skills/pet-generator/scripts/prepare_pet_run.py",
  "skills/pet-generator/scripts/derive_running_left_from_running_right.py",
  "resources/pet-generator/alkaka-friend-pet/SKILL.md",
  "resources/pet-generator/alkaka-friend-pet/assets/alkaka-style-reference.jpg",
  "resources/pet-generator/alkaka-friend-pet/scripts/prepare_pet_run.py",
  "resources/pet-generator/alkaka-friend-pet/scripts/finalize_pet_run.py",
  "resources/pet-generator/alkaka-friend-pet/scripts/package_custom_pet.py",
  "resources/pet-generator/alkaka-friend-pet/scripts/record_imagegen_result.py",
  "resources/pet-generator/hatch_generate.py",
  "resources/pet-generator/petctl.py",
  "src/main/group-store.js",
  "src/main/group-adapters.js",
  "src/renderer/group/group-prompts.js",
  "src/renderer/group/conductor.js",
  "src/renderer/group/group.js",
  "src/renderer/tasks/tasks-panel.js",
  "src/renderer/fellow/pet-dialog.js",
  "src/renderer/fellow/fellow-dialog.js",
  "src/renderer/fellow/fellow-manager.js",
  "src/renderer/chat/trace-blocks.js",
  "src/renderer/chat/message-helpers.js",
  "src/renderer/chat/composer.js",
  "src/renderer/chat/message-menu.js",
  "src/renderer/settings/settings-appearance.js",
  "src/renderer/settings/settings-remote.js",
  "src/renderer/settings/model-helpers.js",
  "src/renderer/settings/engine-options.js",
  "src/renderer/settings/model-settings.js",
  "src/renderer/loaders.js",
  "src/renderer/sessions/session-read-state.js",
  "src/renderer/skills/skill-helpers.js",
  "src/renderer/skills/skill-library.js",
  "src/renderer/onboarding/setup-guide.js",
  "src/renderer/helpers/avatar-helpers.js",
  "src/renderer/helpers/markdown-helpers.js",
  "src/renderer/helpers/format-helpers.js",
  "src/renderer/helpers/scrollbar-overlay.js",
  "resources/conductor/default-prompts/dispatch.md",
  "resources/conductor/default-prompts/summarize.md",
  "resources/conductor/default-prompts/nudge.md",
  "resources/conductor/default-prompts/relay.md"
];

for (const file of required) {
  const full = path.join(__dirname, "..", file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${file}`);
  }
}

const forbiddenRootDuplicates = [
  "main.js",
  "desktop-bridge-permission.js"
];

for (const file of forbiddenRootDuplicates) {
  const full = path.join(__dirname, "..", file);
  if (fs.existsSync(full)) {
    throw new Error(`Unexpected root-level duplicate source file: ${file}`);
  }
}

for (const file of ["src/main.js", "src/main/chat-engine-adapters.js", "src/main/chat-engine-registry.js", "src/main/chat-events.js", "src/main/chat-response.js", "src/main/claude-code-chat-adapter.js", "src/main/codex-chat-adapter.js", "src/main/fellow-registry.js", "src/main/hermes-chat-adapter.js", "src/cloud/sqlite-store.js", "src/cloud/desktop-sync.js", "src/cloud/desktop-bridge-permission.js", "src/permission-modes.js", "src/runtime-resource-paths.js", "src/preload.js", "src/renderer/app.js", "src/mobile/app.js", "src/web/app.js", "scripts/serve-web.js", "scripts/serve-cloud.js", "scripts/build-cloud-release.js", "scripts/print-cloud-release-handoff.js", "scripts/verify-cloud-production.js", "scripts/audit-cloud-productization.js", "scripts/diagnose-deploy-ssh.js", "scripts/print-cloud-blockers.js", "scripts/doctor-cloud.js", "scripts/smoke-cloud.js", "scripts/local-agent-bridge.js", "src/relay/server.js"]) {
  childProcess.execFileSync(process.execPath, ["--check", path.join(__dirname, "..", file)], {
    stdio: "inherit"
  });
}

childProcess.execFileSync("bash", ["-n", path.join(__dirname, "..", "scripts/deploy-cloud-release.sh")], {
  stdio: "inherit"
});
childProcess.execFileSync("bash", ["-n", path.join(__dirname, "..", "scripts/install-cloud-release-local.sh")], {
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
// defaultModelSettings was moved to src/main/settings-store.js; assert against the extracted module.
const settingsStoreSource = fs.readFileSync(path.join(__dirname, "main", "settings-store.js"), "utf8");
const defaultModelBody = settingsStoreSource.match(/function defaultModelSettings\(\) \{[\s\S]*?\n {2}\}/)?.[0] || "";
assert.doesNotMatch(defaultModelBody, /provider: "xai"[\s\S]*model: "grok-4\.1-fast"/);
assert.doesNotMatch(defaultModelBody, /provider: "openai-codex"[\s\S]*model: "gpt-5\.3-codex"/);
assert.match(defaultModelBody, /provider: ""[\s\S]*model: ""/);
assert.match(mainSource, /requestSingleInstanceLock/);

const cloudServerSource = fs.readFileSync(path.join(__dirname, "..", "scripts/serve-cloud.js"), "utf8");
assert.match(cloudServerSource, /createCloudStore/);
assert.doesNotMatch(cloudServerSource, /\b(readDb|writeDb|emptyDb|authenticatedToken|passwordHash|createSession|serveFile)\b/);
assert.doesNotMatch(cloudServerSource, /\bdb\.users\b|\bdb\.sessions\b|\bdb\.workspaces\b|\bdb\.files\b/);
assert.match(cloudServerSource, /allowQueryTokenAuth/);
assert.doesNotMatch(cloudServerSource, /authenticateToken\([^)]*url\.searchParams\.get\("token"\)/);

const {
  runtimeTargetId,
  bundledHermesRuntimeDir
} = require("./runtime-resource-paths");

assert.equal(runtimeTargetId({ platform: "darwin", arch: "arm64" }), "mac-arm64");
assert.equal(runtimeTargetId({ platform: "darwin", arch: "x64" }), "mac-x64");
assert.equal(runtimeTargetId({ platform: "linux", arch: "x64" }), "linux-x64");
assert.equal(runtimeTargetId({ platform: "win32", arch: "x64" }), "win-x64");

{
  const existing = new Set([
    "/repo/vendor/hermes-runtime/mac-arm64",
    "/packaged/Resources/hermes-runtime"
  ]);
  const existsSync = (filePath) => existing.has(filePath);
  assert.equal(
    bundledHermesRuntimeDir({
      resourcesPath: "/packaged/Resources",
      appPath: "/repo",
      cwd: "/repo",
      platform: "darwin",
      arch: "arm64",
      existsSync
    }),
    "/packaged/Resources/hermes-runtime"
  );
}

{
  const existing = new Set(["/repo/vendor/hermes-runtime/mac-arm64"]);
  const existsSync = (filePath) => existing.has(filePath);
  assert.equal(
    bundledHermesRuntimeDir({
      resourcesPath: "/electron/Resources",
      appPath: "/repo",
      cwd: "/other",
      platform: "darwin",
      arch: "arm64",
      existsSync
    }),
    "/repo/vendor/hermes-runtime/mac-arm64"
  );
}

console.log("Aimashi project structure OK");
