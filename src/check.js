const fs = require("node:fs");
const childProcess = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const required = [
  "src/main.js",
  "src/permission-modes.js",
  "src/runtime-resource-paths.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/app.js",
  "src/renderer/styles.css",
  "src/mobile/index.html",
  "src/mobile/app.js",
  "src/mobile/styles.css",
  "src/relay/server.js",
  "scripts/create-mac-dmg.js",
  "resources/pet-generator/hatch_generate.py",
  "resources/pet-generator/petctl.py",
  "resources/pet-generator/skills/alkaka-friend-pet/SKILL.md",
  "resources/pet-generator/skills/alkaka-friend-pet/assets/alkaka-style-reference.jpg",
  "resources/pet-generator/skills/alkaka-friend-pet/scripts/prepare_pet_run.py",
  "resources/pet-generator/skills/alkaka-friend-pet/scripts/finalize_pet_run.py",
  "resources/pet-generator/skills/alkaka-friend-pet/scripts/package_custom_pet.py",
  "resources/pet-generator/skills/alkaka-friend-pet/scripts/record_imagegen_result.py",
  "src/main/group-store.js",
  "src/main/group-adapters.js",
  "src/renderer/group-prompts.js",
  "src/renderer/conductor.js",
  "src/renderer/group.js",
  "resources/conductor/default-prompts/dispatch.md",
  "resources/conductor/default-prompts/summarize.md",
  "resources/conductor/default-prompts/nudge.md"
];

for (const file of required) {
  const full = path.join(__dirname, "..", file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${file}`);
  }
}

for (const file of ["src/main.js", "src/permission-modes.js", "src/runtime-resource-paths.js", "src/preload.js", "src/renderer/app.js", "src/mobile/app.js", "src/relay/server.js"]) {
  childProcess.execFileSync(process.execPath, ["--check", path.join(__dirname, "..", file)], {
    stdio: "inherit"
  });
}

const { normalizePermissionMode, permissionModeLabel } = require("./permission-modes");

assert.equal(normalizePermissionMode("ask"), "ask");
assert.equal(normalizePermissionMode("deny"), "deny");
assert.equal(normalizePermissionMode("yolo"), "yolo");
assert.equal(normalizePermissionMode("manual"), "ask");
assert.equal(normalizePermissionMode("off"), "yolo");
assert.equal(permissionModeLabel("ask"), "Ask");
assert.equal(permissionModeLabel("yolo"), "YOLO");
assert.equal(permissionModeLabel("deny"), "Deny");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const defaultModelBody = mainSource.match(/function defaultModelSettings\(\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(defaultModelBody, /provider: "xai"[\s\S]*model: "grok-4\.1-fast"/);
assert.doesNotMatch(defaultModelBody, /provider: "openai-codex"[\s\S]*model: "gpt-5\.3-codex"/);
assert.match(defaultModelBody, /provider: ""[\s\S]*model: ""/);
assert.match(mainSource, /requestSingleInstanceLock/);

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
