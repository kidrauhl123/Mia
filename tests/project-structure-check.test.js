const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const LEGACY_CORE_ENTRY = path.join("src", "core", "mia-core.js");
const RETIRED_NODE_UTILITY_RUNTIME_FILES = [
  "src/main/chat-engine-adapters.js",
  "src/main/claude-code-stateless-adapter.js",
  "src/main/codex-stateless-adapter.js",
  "src/main/codex-app-server-runner.js",
  "src/main/codex-mia-proxy.js",
  "tests/chat-engine-adapters.test.js",
  "tests/claude-code-stateless-adapter.test.js",
  "tests/codex-stateless-adapter.test.js",
  "tests/codex-app-server-runner.test.js",
  "tests/codex-mia-proxy.test.js"
];

function assertRetiredFilesDeleted(files, message) {
  for (const relativePath of files) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} ${message}`);
  }
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".expo") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

test("project structure check covers cloud release helpers and rejects root source duplicates", () => {
  const source = fs.readFileSync(path.join(root, "src/check.js"), "utf8");
  assert.match(source, /scripts\/diagnose-deploy-ssh\.js/);
  assert.match(source, /scripts\/print-cloud-blockers\.js/);
  assert.match(source, /scripts\/verify-packaged-mia-core\.js/);
  assert.match(source, /forbiddenRootDuplicates/);
  assert.match(source, /main\.js/);
  assert.match(source, /desktop-bridge-permission\.js/);
  assert.match(source, /Unexpected root-level duplicate source file/);
  assert.match(source, /src\/main\/bot-registry\.js/);
  assert.match(source, /src\/main\/bot-manifest\.js/);
  assert.match(source, /packages\/shared\/bot-identity\.js/);
  assert.match(source, /src\/shared\/bot-identity\.js/);
  assert.doesNotMatch(source, /src\/main\/fellow-registry\.js/);
  assert.doesNotMatch(source, /src\/main\/fellow-manifest\.js/);
  assert.doesNotMatch(source, /packages\/shared\/fellow-identity\.js/);
  assert.doesNotMatch(source, /src\/shared\/fellow-identity\.js/);
});

test("React Native shared logic stays behind package adapters instead of duplicated ports", () => {
  const adapters = {
    "src/logic/avatar.ts": "@mia/shared/avatar",
    "src/logic/contact.ts": "@mia/shared/contact",
    "src/logic/groupTiles.ts": "@mia/shared/group-tiles",
    "src/logic/sessionHistory.ts": "@mia/shared/session-history",
    "src/logic/sendPipeline.ts": "@mia/shared/send-pipeline",
    "src/logic/approvalQueue.ts": "@mia/shared/approval-queue",
    "src/logic/optimisticSend.ts": "@mia/shared/optimistic-send",
    "src/api/client.ts": "@mia/shared/cloud-client",
    "src/api/events.ts": "@mia/shared/cloud-client"
  };
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(rootPackageJson.workspaces, ["apps/mobile-rn", "packages/shared"]);
  assert.equal(fs.existsSync(path.join(root, "apps/mobile-rn", "package-lock.json")), false);

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "apps/mobile-rn", "package.json"), "utf8"));
  assert.equal(packageJson.dependencies?.["@mia/shared"], "file:../../packages/shared");

  for (const [relativePath, packagePath] of Object.entries(adapters)) {
    const source = fs.readFileSync(path.join(root, "apps/mobile-rn", relativePath), "utf8");
    assert.match(source, new RegExp(packagePath.replace("/", "\\/")), `${relativePath} should import ${packagePath}`);
    assert.doesNotMatch(source, /\b(function|class|const|let|var)\b|=>/, `${relativePath} must stay a thin re-export adapter`);
  }

  for (const file of walkFiles(path.join(root, "apps/mobile-rn", "src"))) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /src\/shared|\.\.\/\.\.\/\.\.\/\.\.\/src\/shared|\.\.\/\.\.\/\.\.\/\.\.\/packages\/shared/,
      `${path.relative(root, file)} must not import legacy shared Modules or package directories directly`
    );
  }
});

test("legacy Capacitor mobile web entry is retired in favor of apps/mobile-rn", () => {
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const scripts = rootPackageJson.scripts || {};
  assert.equal(fs.existsSync(path.join(root, "apps/mobile-rn")), true, "React Native app should be the only mobile app entry");

  for (const scriptName of ["mobile", "mobile:build", "mobile:add:ios", "mobile:add:android", "mobile:sync"]) {
    assert.equal(scripts[scriptName], undefined, `${scriptName} must not keep the retired Capacitor app alive`);
  }

  for (const depName of ["@capacitor/cli", "@capacitor/core", "@capacitor/android", "@capacitor/ios"]) {
    assert.equal(rootPackageJson.dependencies?.[depName], undefined, `${depName} must not remain as a runtime dependency`);
    assert.equal(rootPackageJson.devDependencies?.[depName], undefined, `${depName} must not remain as a dev dependency`);
  }

  for (const relativePath of [
    "src/mobile",
    "dist/mobile-www",
    "scripts/build-mobile-www.js",
    "scripts/serve-mobile.js",
    "capacitor.config.json",
    "android"
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should be removed`);
  }
});

test("packages/shared owns avatar implementation instead of wrapping src/shared", () => {
  const packageSource = fs.readFileSync(path.join(root, "packages/shared/avatar.js"), "utf8");
  const legacyEntries = [
    "src/shared/avatar-resolve.js",
    "src/shared/avatar-media.js",
    "src/shared/member-color.js"
  ].map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8"));

  assert.doesNotMatch(
    packageSource,
    /src\/shared|require\(["']\.\.\/\.\.\/src\/shared\/(avatar-resolve|avatar-media|member-color)\.js["']\)/,
    "packages/shared/avatar.js must not depend on legacy src/shared avatar entries"
  );
  assert.match(packageSource, /miaAvatarResolve/, "package avatar must expose the avatar resolver browser global contract");
  assert.match(packageSource, /miaAvatarMedia/, "package avatar must expose the avatar media browser global contract");
  assert.match(packageSource, /miaMemberColor/, "package avatar must expose the member color browser global contract");

  for (const source of legacyEntries) {
    assert.match(source, /packages\/shared\/avatar\.js/, "src/shared avatar entries should be compatibility entries");
  }
});

test("packages/shared owns session history implementation instead of wrapping src/shared", () => {
  const packageSource = fs.readFileSync(path.join(root, "packages/shared/session-history.js"), "utf8");
  const legacySource = fs.readFileSync(path.join(root, "src/shared/session-history.js"), "utf8");

  assert.doesNotMatch(
    packageSource,
    /src\/shared|require\(["']\.\.\/\.\.\/src\/shared\/session-history\.js["']\)/,
    "packages/shared/session-history.js must not depend on the legacy src/shared entry"
  );
  assert.match(packageSource, /miaSessionHistory/, "package session-history must still expose the browser global contract");
  assert.match(legacySource, /packages\/shared\/session-history\.js/, "src/shared/session-history.js should be a compatibility entry");
});

test("packages/shared owns contact implementation instead of wrapping src/shared", () => {
  const packageSource = fs.readFileSync(path.join(root, "packages/shared/contact.js"), "utf8");
  const legacySource = fs.readFileSync(path.join(root, "src/shared/contact.js"), "utf8");

  assert.doesNotMatch(
    packageSource,
    /src\/shared|require\(["']\.\.\/\.\.\/src\/shared\/contact\.js["']\)/,
    "packages/shared/contact.js must not depend on the legacy src/shared entry"
  );
  assert.match(packageSource, /miaContact/, "package contact must still expose the browser global contract");
  assert.match(legacySource, /packages\/shared\/contact\.js/, "src/shared/contact.js should be a compatibility entry");
});

test("packages/shared owns group tile implementation instead of wrapping src/shared", () => {
  const packageSource = fs.readFileSync(path.join(root, "packages/shared/group-tiles.js"), "utf8");
  const legacySource = fs.readFileSync(path.join(root, "src/shared/group-tiles.js"), "utf8");

  assert.doesNotMatch(
    packageSource,
    /src\/shared|require\(["']\.\.\/\.\.\/src\/shared\/group-tiles\.js["']\)/,
    "packages/shared/group-tiles.js must not depend on the legacy src/shared entry"
  );
  assert.match(packageSource, /miaGroupTiles/, "package group-tiles must still expose the browser global contract");
  assert.match(legacySource, /packages\/shared\/group-tiles\.js/, "src/shared/group-tiles.js should be a compatibility entry");
});

test("packages/shared owns send pipeline, cloud client, and unread implementations", () => {
  const entries = [
    { name: "send-pipeline", global: "miaSendPipeline", legacy: true },
    { name: "cloud-client", global: "miaCloudClient", legacy: true },
    { name: "unread", global: "miaUnread", legacy: true },
    { name: "approval-queue", global: "miaApprovalQueue", legacy: false },
    { name: "optimistic-send", global: "miaOptimisticSend", legacy: false }
  ];
  for (const { name, global, legacy } of entries) {
    const packageSource = fs.readFileSync(path.join(root, "packages/shared", `${name}.js`), "utf8");
    assert.doesNotMatch(
      packageSource,
      new RegExp(`src\\/shared|require\\(["']\\.\\.\\/\\.\\.\\/src\\/shared\\/${name}\\.js["']\\)`),
      `packages/shared/${name}.js must not depend on the legacy src/shared entry`
    );
    assert.match(packageSource, new RegExp(global), `packages/shared/${name}.js must expose ${global}`);
    if (legacy) {
      const legacySource = fs.readFileSync(path.join(root, "src/shared", `${name}.js`), "utf8");
      assert.match(legacySource, new RegExp(`packages\\/shared\\/${name}\\.js`), `src/shared/${name}.js should be a compatibility entry`);
    }
  }
});

test("bot conversation keys are resolved through the shared session helper", () => {
  for (const relativePath of [
    "src/renderer/app.js",
    "src/renderer/social/social.js",
    "src/web/app.js",
    "apps/mobile-rn/src"
  ]) {
    const full = path.join(root, relativePath);
    const files = fs.statSync(full).isDirectory()
      ? walkFiles(full).filter((file) => /\.(js|ts|tsx)$/.test(file))
      : [full];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /\.split\((["'])\:\1\)\s*\[\s*2\s*\]/,
        `${path.relative(root, file)} must use sessionHistory.botId() instead of truncating bot ids from conversation ids`
      );
    }
  }
});

test("runtime code composes bot conversation ids through shared bot identity helpers", () => {
  for (const relativePath of [
    "src",
    "scripts",
    "packages/shared",
    "apps/mobile-rn/src"
  ]) {
    const full = path.join(root, relativePath);
    const files = fs.statSync(full).isDirectory()
      ? walkFiles(full).filter((file) => /\.(js|ts|tsx)$/.test(file))
      : [full];
    for (const file of files) {
      const projectPath = path.relative(root, file);
      if (projectPath === "src/shared/session-history.js") continue;
      if (projectPath === "packages/shared/session-history.js") continue;
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /`bot:\$\{[^}]+\}:\$\{[^}]+\}`/,
        `${projectPath} must use botIdentity.botConversationId() instead of hand-composing bot conversation ids`
      );
    }
  }
});

test("cloud bridge remote run delegates backend execution decisions to Rust Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const bridgeSource = fs.readFileSync(path.join(root, "src/main/cloud/cloud-bridge-client.js"), "utf8");
  const cloudRouterSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/cloud.rs"), "utf8");
  const cloudCrateSource = fs.readFileSync(path.join(root, "crates/mia-core-cloud/src/bridge.rs"), "utf8");
  const cloudEventsCoreSource = fs.readFileSync(path.join(root, "crates/mia-core-cloud/src/events.rs"), "utf8");
  assert.match(bridgeSource, /startCloudBridgeRequest/, "cloud bridge JS should only request Core lifecycle start");
  assert.match(bridgeSource, /stopCloudBridgeRequest/, "cloud bridge JS should only request Core lifecycle stop");
  assert.match(mainSource, /route:\s*"\/api\/cloud\/bridge\/start"/, "main should start bridge lifecycle through Rust Core");
  assert.match(mainSource, /route:\s*"\/api\/cloud\/bridge\/stop"/, "main should stop bridge lifecycle through Rust Core");
  assert.match(cloudRouterSource, /start_cloud_bridge/, "Rust Core should expose the cloud bridge lifecycle route");
  assert.match(cloudCrateSource, /CloudBridgeManager/, "Rust Core cloud crate should own the bridge lifecycle manager");
  assert.match(cloudCrateSource, /TungsteniteCloudBridgeTransport/, "Rust Core cloud crate should own the remote bridge WebSocket transport");
  assert.match(cloudCrateSource, /\"run_result\"/, "Rust Core cloud crate should write cloud run result envelopes");
  assert.doesNotMatch(bridgeSource, /confirmCloudBridgeRun\(|等待本机权限确认/, "cloud account auth should remain the gate; JS must not add a local approval gate");
  assert.doesNotMatch(bridgeSource, /normalizeTurnRuntimeConfig|runtimeConfigFromMessage|botEngineConfigFromRuntime|normalizeAgentEngine|resolveBotCapabilities|botSnapshot|runBridgeBotTurn/, "cloud bridge must not own runtime config or bot snapshot assembly");
  assert.doesNotMatch(bridgeSource, /createActiveBridgeChatAdapter|adapter\.sendChat|AbortController|abortControllers/, "cloud bridge must not execute or cancel local agent runs in JS");
  assert.doesNotMatch(bridgeSource, /WebSocketImpl|new WebSocket|handleMessage|heartbeat|reconnect|ping\(|run_result|device_identity_conflict/, "cloud bridge JS must not own remote socket lifecycle or cloud frame handling");
  assert.doesNotMatch(mainSource, /runBridgeBotTurn:|resolveBotCapabilities:/, "main must not inject a direct JS bridge bot turn sender");
  assert.doesNotMatch(mainSource, /cloudBridgeUrl\(|route:\s*"\/api\/cloud\/bridge\/run"[\s\S]*createCloudBridgeClient/, "main must not build the remote bridge socket URL or inject run-frame handlers into JS");
  assert.equal(fs.existsSync(path.join(root, "src/main/mia-core/runtime-service.js")), false, "old Node Core runtime service should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/mia-core-runtime-service.test.js")), false, "old Node Core runtime service tests should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/bot-turn-helpers.js")), false, "old JS bot turn runtime injection helper should stay deleted");
  assert.doesNotMatch(mainSource, /createBotTurnHelpers/, "main should not use a foreground bot turn runtime injection helper");
  assert.doesNotMatch(mainSource, /createMiaCoreRuntimeService|miaCoreRuntime|runtime-service/, "main must not reintroduce the old Node Core runtime service");
  assert.match(mainSource, /createCloudBridgeClient/, "main must instantiate the cloud bridge Module");
  assert.doesNotMatch(mainSource, /async function runCloudBridgeRequest/, "main must not own bridge run implementation");
  assert.doesNotMatch(mainSource, /function handleCloudBridgeMessage/, "main must not own bridge message routing");
  assert.doesNotMatch(mainSource, /cloudBridgeAbortControllers/, "main must not own bridge run abort controllers");

  const cloudEventsSource = fs.readFileSync(path.join(root, "src/main/cloud/cloud-events-client.js"), "utf8");
  assert.equal(fs.existsSync(path.join(root, "src/main/cloud/cloud-events-url.js")), false, "cloud events URL/protocol helper should move into Rust Core");
  assert.match(mainSource, /route:\s*"\/api\/cloud\/events\/start"/, "main should start cloud events lifecycle through Rust Core");
  assert.match(mainSource, /route:\s*"\/api\/cloud\/events\/stop"/, "main should stop cloud events lifecycle through Rust Core");
  assert.match(cloudRouterSource, /start_cloud_events/, "Rust Core should expose the cloud events lifecycle route");
  assert.match(cloudEventsCoreSource, /CloudEventsManager/, "Rust Core cloud crate should own the cloud events lifecycle manager");
  assert.match(cloudEventsCoreSource, /\/api\/events\?since_seq=/, "Rust Core should construct the remote events websocket URL with the cursor");
  assert.doesNotMatch(cloudEventsSource, /WebSocketImpl|new WebSocket|handleMessage|heartbeat|reconnect|ping\(|persistCursor|writeCloudSettings|lastEventSeq.*write|botRuntimeDispatcher|memorySync|messageCache/, "cloud events JS must not own remote socket lifecycle, cursor writes, or cloud frame side effects");
  assert.doesNotMatch(mainSource, /cloudEventsUrl|cloudWebSocketProtocols|cloud-events-url|persistCursor|botRuntimeDispatcher:|memorySync:\s*\(\)\s*=>\s*cloudDesktopSync\(\)\.syncMemories/, "main must not inject cloud events socket or frame handlers into JS");
  assert.doesNotMatch(mainSource, /cloudBridgeReconnectTimer/, "main must not own bridge reconnect timer");
});

test("Electron main no longer owns provider runtime resolution", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const engineRuntimeSource = fs.readFileSync(path.join(root, "src/main/engine-runtime-config-service.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/mia-core/model-runtime-resolver.js")), false, "old JS model-runtime resolver should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/mia-core-model-runtime-resolver.test.js")), false, "old JS model-runtime resolver tests should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/claude-code-mia-proxy.js")), false, "old JS Claude managed-model proxy should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/claude-code-mia-proxy.test.js")), false, "old JS Claude managed-model proxy tests should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/agent-session-runtime-preparer.js")), false, "old JS AgentSession runtime preparer should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/agent-session-runtime-preparer.test.js")), false, "old JS AgentSession runtime preparer tests should stay deleted");
  assert.doesNotMatch(mainSource, /model-runtime-resolver|createMiaCoreModelRuntimeResolver|isMiaManagedRuntime/, "main must not import or instantiate the deleted JS model-runtime resolver");
  assert.doesNotMatch(mainSource, /createClaudeCodeMiaProxy|claudeCodeMiaProxy/, "main must not instantiate the deleted JS Claude managed-model proxy");
  assert.doesNotMatch(mainSource, /agent-session-runtime-preparer|createAgentSessionRuntimePreparer|prepareAgentSessionRuntime/, "main must not instantiate the deleted JS AgentSession runtime preparer");
  assert.doesNotMatch(mainSource, /resolveModelRuntime:\s*\(/, "main must not inject a JS provider runtime resolver into Hermes config generation");
  assert.match(engineRuntimeSource, /\/api\/engines\/hermes\/runtime-config/, "engine runtime config adapter should delegate Hermes config preparation to Rust Core");
  assert.doesNotMatch(engineRuntimeSource, /apiKeyEnv|api_key_env|apiKey|api_key|baseUrl|base_url|apiMode|api_mode|resolveModelRuntime|writeRuntimeConfig|modelSettings/, "engine runtime config adapter must not assemble provider runtime transport");
});

test("old Node Core skill runtime owner path is retired", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/mia-core/skill-runtime-owner.js")), false, "old Node Core skill runtime owner should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/skill-runtime-owner.test.js")), false, "old Node Core skill runtime owner tests should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/agent-session-skill-runtime.js")), false, "old JS AgentSession skill runtime adapter should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/agent-session-skill-runtime.test.js")), false, "old JS AgentSession skill runtime adapter tests should stay deleted");
  assert.doesNotMatch(mainSource, /agent-session-skill-runtime|createAgentSessionSkillRuntimeAdapter/, "main must not instantiate the deleted JS AgentSession skill runtime adapter");
  assert.doesNotMatch(mainSource, /createSkillRuntimeOwner|skillRuntimeOwner|mia-core\/skill-runtime-owner/, "old skill runtime owner naming/path must not return");
});

test("cloud Claude Code legacy runs client files are removed", () => {
  assert.equal(
    fs.existsSync(path.join(root, "src/cloud-agent/hermes-runs-client.js")),
    false,
    "legacy cloud Claude Code runs client source should be removed"
  );
  assert.equal(
    fs.existsSync(path.join(root, "tests/cloud-agent-hermes-runs-client.test.js")),
    false,
    "legacy cloud Claude Code runs client test should be removed"
  );
});

test("cloud Claude Code DeepSeek transport stays Anthropic-only", () => {
  const serverSource = fs.readFileSync(path.join(root, "scripts/serve-cloud.js"), "utf8");
  const runtimeSource = fs.readFileSync(path.join(root, "src/cloud-agent/runtime-assembly.js"), "utf8");
  const mcpSource = fs.readFileSync(path.join(root, "src/cloud-agent/mia-cloud-mcp-server.js"), "utf8");
  assert.equal(
    fs.existsSync(path.join(root, "src/cloud/model-proxy-anthropic.js")),
    false,
    "the Anthropic-to-OpenAI compatibility adapter should stay deleted"
  );
  assert.match(serverSource, /fetchDeepSeekAnthropicMessages/);
  assert.match(serverSource, /不会回退到 OpenAI 协议/);
  assert.doesNotMatch(serverSource, /anthropicToOpenAiChatBody|convertOpenAiMessageToAnthropic|openAiStreamPayloadToAnthropicSse/);
  assert.equal(
    fs.existsSync(path.join(root, "src/cloud-agent/public-web-tools.js")),
    false,
    "cloud should not ship a homemade web-search transport"
  );
  assert.doesNotMatch(runtimeSource, /WebSearch|WebFetch|web_search|web_fetch/, "cloud runtime prompt must not steer native web tools");
  assert.doesNotMatch(mcpSource, /public-web-tools|web_search|web_fetch/, "Mia MCP must not shadow provider-native web tools");
});

test("cloud release builder ships only cloud Claude Code agent files and excludes legacy cloud agent files", () => {
  const source = fs.readFileSync(path.join(root, "scripts/build-cloud-release.js"), "utf8");
  assert.match(source, /api\/src\/cloud-agent\/cloud-claude-code-model\.js/);
  assert.match(source, /api\/src\/cloud-agent\/claude-code-sandbox-manager\.js/);
  assert.match(source, /api\/src\/cloud-agent\/claude-code-sandbox-client\.js/);
  assert.match(source, /api\/src\/cloud-agent\/runtime-assembly\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/public-web-tools\.js/);
  assert.match(source, /api\/src\/cloud-agent\/mia-cloud-mcp-server\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/cloud-hermes-model\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/cloud-hermes-sessions-store\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/hermes-worker-manager\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/hermes-gateway-client\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/hermes-gateway-events\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/hermes-im-attachments\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/hermes-im-client\.js/);
  assert.doesNotMatch(source, /api\/src\/cloud-agent\/hermes-runs-client\.js/);
});

test("cloud desktop sync lives behind a main/cloud Module instead of main.js", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const syncSource = fs.readFileSync(path.join(root, "src/main/cloud/desktop-sync-client.js"), "utf8");
  assert.match(syncSource, /function createCloudDesktopSyncClient/, "cloud desktop sync Module should exist");
  assert.match(syncSource, /syncCloudMemory/, "cloud memory sync should be delegated to Rust Core");
  assert.match(mainSource, /createCloudDesktopSyncClient/, "main should instantiate the cloud desktop sync Module");
  assert.match(mainSource, /route:\s*"\/api\/cloud\/memory\/sync"/, "main should bridge cloud memory sync through Mia Core HTTP");
  assert.doesNotMatch(mainSource, /async function cloudApi/, "main must not own low-level cloud HTTP requests");
  assert.doesNotMatch(mainSource, /memoryService:\s*miaMemoryService/, "main must not inject the JS memory service into cloud sync");
  assert.doesNotMatch(syncSource, /\bmemoryService\b|listSyncMemories|applySyncedMemories|\/api\/me\/memory\/push/, "cloud desktop sync must not own memory CRUD or direct memory push");
  assert.doesNotMatch(mainSource, /function\s+\w*Workspace\w*\([^)]*\)\s*\{[\s\S]{0,200}\.syncWorkspace\(/, "main must not wrap workspace sync orchestration");
  assert.doesNotMatch(mainSource, /async function pushAllFellowSessionsToCloudConversations/, "main must not own fellow conversation backfill");
  assert.doesNotMatch(mainSource, /async function mirrorFellowSessionToCloudConversation/, "main must not own fellow-conversation message mirroring");
});

test("scheduled task replies no longer bypass Rust Core conversation ownership through the social API", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  assert.equal(fs.existsSync(path.join(root, "src/main/task-reply-delivery.js")), false, "task reply cloud delivery helper should be retired");
  assert.equal(fs.existsSync(path.join(root, "tests/task-reply-delivery.test.js")), false, "old social API task reply tests should be retired");
  assert.doesNotMatch(mainSource, /deliverTaskReplyToConversation/);
  assert.doesNotMatch(mainSource, /async function runRemoteChatRequest|normalizeRemoteUserMessage|resolveRemoteChatBot|collectChatTraceEnvelope/, "main must not keep the old remote chat execution path");
});

test("legacy mobile pairing and relay web control path are retired", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const daemonSource = fs.readFileSync(path.join(root, "src/main/mia-core/control-server.js"), "utf8");
  const rendererHtml = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const rendererApp = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const remoteSettings = fs.readFileSync(path.join(root, "src/renderer/settings/settings-remote.js"), "utf8");

  assert.equal(packageJson.scripts?.relay, undefined, "root relay script should be removed with the old mobile web control path");
  for (const relativePath of ["src/relay/server.js", "src/main/relay/relay-client.js"]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should be removed`);
  }
  for (const source of [mainSource, preloadSource, ipcSource, daemonSource, rendererHtml, rendererApp, remoteSettings]) {
    assert.doesNotMatch(source, /RelayStatus|RelayStart|RelayStop|RelaySettingsSave|DaemonPairing/);
    assert.doesNotMatch(source, /relayStatus|startRelay|stopRelay|saveRelaySettings|daemonPairing|pairingInfo|relaySettings/);
    assert.doesNotMatch(source, /\/mobile\/|\/mobile\b|mobilePairing|mobileRelay|mobileLan/);
  }
});

test("remote control API routes are shared by the daemon HTTP adapter", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const routerSource = fs.readFileSync(path.join(root, "src/main/remote/remote-control-router.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const remoteRouterStart = mainSource.indexOf("remoteControlRouter = createRemoteControlRouter");
  const remoteRouterEnd = mainSource.indexOf("\n});", remoteRouterStart);
  const remoteRouterWiring = remoteRouterStart >= 0 && remoteRouterEnd > remoteRouterStart
    ? mainSource.slice(remoteRouterStart, remoteRouterEnd)
    : "";
  assert.match(routerSource, /function createRemoteControlRouter/, "remote control router Module should exist");
  assert.match(mainSource, /createRemoteControlRouter/, "main should instantiate the shared remote router");
  assert.equal(fs.existsSync(path.join(root, "src/main/model-settings-service.js")), false, "Node model settings save service must be deleted");
  assert.match(preloadSource, /function saveCoreModelSelection/, "preload should keep only a Core model-selection UI adapter");
  assert.match(preloadSource, /\/api\/settings\/model-selection/, "model selection should use the typed Core route");
  assert.doesNotMatch(preloadSource, /IpcChannel\.ModelSave/, "preload must not route model selection through main IPC");
  assert.doesNotMatch(channelSource, /ModelSave/, "shared IPC channels must not expose the obsolete raw model settings writer");
  assert.doesNotMatch(mainSource, /IpcChannel\.ModelSave/, "main must not handle the obsolete raw model settings writer");
  assert.doesNotMatch(preloadSource, /\/api\/providers/, "model selection adapter must not split provider writes into low-level JS requests");
  assert.doesNotMatch(preloadSource, /saveEffort/, "preload must not expose the obsolete raw effort settings writer");
  assert.doesNotMatch(channelSource, /EffortSave/, "shared IPC channels must not expose the obsolete raw effort settings writer");
  assert.doesNotMatch(mainSource, /IpcChannel\.EffortSave/, "main must not handle the obsolete raw effort settings writer");
  assert.doesNotMatch(preloadSource, /savePermissions/, "preload must not expose the obsolete raw permission settings writer");
  assert.doesNotMatch(channelSource, /PermissionsSave/, "shared IPC channels must not expose the obsolete raw permission settings writer");
  assert.doesNotMatch(mainSource, /IpcChannel\.PermissionsSave/, "main must not handle the obsolete raw permission settings writer");
  assert.doesNotMatch(mainSource, /createModelSettingsService/, "main must not instantiate a Node model settings save service");
  assert.match(routerSource, /CORE_TURN_CANCEL_PATTERN/, "remote router should only keep typed Core turn cancellation");
  assert.ok(remoteRouterWiring, "remote router wiring should be extractable");
  assert.doesNotMatch(routerSource, /\/health|\/api\/runtime\/status|\/api\/model\/catalog|\/api\/codex\/models|\/api\/engine\/capabilities|\/api\/commands\/slash|\/api\/commands\/agent-list|\/api\/chat\/attachment|\/api\/file\/fetch|\/api\/commands\/agent-execute/, "remote router must not expose legacy remote-control aggregate routes");
  assert.doesNotMatch(routerSource, /getRuntimeStatus|loadHermesModelCatalog|loadCodexModels|loadEngineCapabilities|loadHermesSlashCommands|loadExternalAgentCommands|saveChatAttachment|readLocalFileAttachment|executeExternalAgentCommand/, "remote router must not own legacy remote-control callbacks");
  assert.doesNotMatch(remoteRouterWiring, /getRuntimeStatus|loadHermesModelCatalog|loadCodexModels|loadEngineCapabilities|loadHermesSlashCommands|loadExternalAgentCommands|saveChatAttachment|readLocalFileAttachment|executeExternalAgentCommand/, "main must not inject legacy remote-control callbacks into the remote router");
  assert.doesNotMatch(routerSource, /\/api\/model\/save|\/api\/effort\/save|\/api\/permissions\/save/, "remote router must not expose raw backend setting mutations");
  assert.doesNotMatch(routerSource, /saveModelSelection|writeEffortSettings|writePermissionSettings/, "remote router must not own setting mutation callbacks");
  assert.doesNotMatch(remoteRouterWiring, /saveModelSelection:\s*\(settings\)|writeEffortSettings:\s*\(body\)|writePermissionSettings:\s*writePermissionSettingsAndApply/, "main must not inject raw setting mutations into the remote router");
  assert.doesNotMatch(routerSource, /modelSettings\(\)/, "remote router must not duplicate model settings normalization");
  assert.doesNotMatch(routerSource, /providerConnection\(/, "remote router must not duplicate provider lookup");
  assert.doesNotMatch(routerSource, /writeModelSettings\(next\)/, "remote router must not write model settings directly");
  assert.doesNotMatch(mainSource, /url\.pathname === "\/api\/chat\/send"/, "main must not duplicate remote chat route matching");
  assert.doesNotMatch(mainSource, /url\.pathname === "\/api\/chat\/stream"/, "main must not duplicate remote chat stream route matching");
  assert.doesNotMatch(routerSource, /\/api\/chat\/stream|runRemoteChatRequest|emitStream/, "remote router must not expose old Node chat stream compatibility");
  assert.doesNotMatch(mainSource, /url\.pathname === "\/api\/model\/save"/, "main must not duplicate remote model route matching");
});

test("cloud-only conversation path has no local chat-session persistence service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const titleSource = fs.readFileSync(path.join(root, "src/main/conversation-title-service.js"), "utf8");
  const routerSource = fs.readFileSync(path.join(root, "src/main/remote/remote-control-router.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  assert.match(titleSource, /function createConversationTitleService/, "conversation title service should exist");
  assert.match(mainSource, /createConversationTitleService/, "main should instantiate the conversation title service");
  assert.doesNotMatch(mainSource, /createChatSessionService|createChatStore|loadChatStore|saveChatStore|routeChatWrite/);
  assert.doesNotMatch(routerSource, /api\/chat\/sessions|api\/chat\/session|read-state\/save/);
  assert.doesNotMatch(ipcSource, /ChatSessionsLoad|ChatSessionSave|ChatReadStateSave|ChatSessionCreate|ChatSessionRename/);
});

test("chat attachment normalization stays in UI helpers while local attachment IO routes through Rust Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const attachmentSource = fs.readFileSync(path.join(root, "src/main/chat-attachments.js"), "utf8");
  const adapterSource = fs.readFileSync(path.join(root, "src/main/chat-attachment-core-adapter.js"), "utf8");
  const coreRoutesSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/routes.rs"), "utf8");
  const coreAttachmentSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/attachment.rs"), "utf8");
  assert.match(attachmentSource, /function createChatAttachments/, "chat attachments module should exist");
  assert.match(mainSource, /createChatAttachments/, "main should instantiate chat attachments");
  assert.match(adapterSource, /\/api\/attachments\/save/, "attachment adapter should call Core save route");
  assert.match(adapterSource, /\/api\/attachments\/file/, "attachment adapter should call Core file route");
  assert.match(mainSource, /createChatAttachmentCoreAdapter/, "main should instantiate the Core attachment adapter");
  assert.match(coreRoutesSource, /\/api\/attachments\/save/, "Rust Core should expose attachment save route");
  assert.match(coreRoutesSource, /\/api\/attachments\/file/, "Rust Core should expose local file attachment route");
  assert.match(coreAttachmentSource, /pub async fn save_attachment/, "Rust Core should own attachment save IO");
  assert.match(coreAttachmentSource, /pub async fn fetch_file_attachment/, "Rust Core should own local attachment read IO");
  assert.doesNotMatch(attachmentSource, /saveChatAttachment,|safeFetchFileAttachment,|safeReadLocalFileAttachment,/, "chat attachment helper must not export local Node IO compatibility APIs");
  assert.doesNotMatch(attachmentSource, /function saveChatAttachment|function safeFetchFileAttachment|function safeReadLocalFileAttachment/, "chat attachment helper must not keep obsolete local Node IO entrypoints");
  assert.doesNotMatch(mainSource, /saveChatAttachment\(payload\)/, "main IPC must not call Node attachment writes");
  assert.doesNotMatch(mainSource, /safeFetchFileAttachment\(payload\)/, "main IPC must not call Node local file reads");
  assert.doesNotMatch(mainSource, /function normalizeAttachment\(/, "main must not own attachment normalization");
  assert.doesNotMatch(mainSource, /function saveChatAttachment/, "main must not own attachment writes");
  assert.doesNotMatch(mainSource, /function readLocalFileAttachment/, "main must not own local attachment reads");
  assert.doesNotMatch(mainSource, /async function fetchCloudFileAttachment/, "main must not own cloud attachment fetch");
  assert.doesNotMatch(mainSource, /function attachmentContext/, "main must not own attachment prompt context");
});

test("bot identity writes are cloud-only; retired local bot service stays removed", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const manifestSource = fs.readFileSync(path.join(root, "src/main/bot-manifest.js"), "utf8");
  const routerSource = fs.readFileSync(path.join(root, "src/main/remote/remote-control-router.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const mcpSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/builtin_mcp.rs"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/bot-service.js")), false, "local bot write service should stay retired");
  assert.doesNotMatch(mainSource, /createBotService|pushBotToCloud|deleteBotFromCloud/, "main must not instantiate local bot identity services");
  assert.doesNotMatch(routerSource, /api\/bots|api\/bot\/engine/, "remote router must not expose local bot identity routes");
  assert.doesNotMatch(preloadSource, /loadBotDetails|saveBotEngine|setBotPinned|setBotMuted|savePersona|IpcChannel\.Bot(Delete|Save|Details|EngineSave|Pin|Mute)/, "preload must not expose local bot identity IPC");
  assert.doesNotMatch(ipcSource, /BotDetails|BotSave|BotDelete|BotEngineSave|BotPin|BotMute|PersonaSave/, "IPC channels must not keep retired local bot identity channels");
  assert.doesNotMatch(mcpSource, /bot_list|api\/bots/, "MCP tools must not proxy retired local bot identity routes");
  assert.match(manifestSource, /Product Bot identity is cloud-owned/, "bot manifest docs should mark identity as cloud-owned");
});

test("RuntimeStatus model and provider display are overlaid from Rust Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const snapshotSource = fs.readFileSync(path.join(root, "src/main/runtime-status-core-snapshot.js"), "utf8");
  const engineRuntimeSource = fs.readFileSync(path.join(root, "src/main/engine-runtime-config-service.js"), "utf8");
  const enginePluginsSource = fs.readFileSync(path.join(root, "src/main/engine-plugins-service.js"), "utf8");
  const runtimePathsSource = fs.readFileSync(path.join(root, "src/main/runtime-paths.js"), "utf8");
  const getRuntimeStatusBlock = mainSource.match(/function getRuntimeStatus\([\s\S]*?\n}\n\nasync function runtimeStatusWithCoreModelProviders/)?.[0] || "";

  assert.equal(fs.existsSync(path.join(root, "src/main/provider-connections.js")), false, "old provider JSON mirror module should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/provider-connections.test.js")), false, "old provider JSON mirror tests should stay deleted");
  assert.match(snapshotSource, /function createRuntimeStatusCoreSnapshot/, "Core runtime snapshot adapter should exist");
  assert.match(snapshotSource, /\/api\/settings\/client/, "RuntimeStatus overlay should read Core client settings");
  assert.match(snapshotSource, /\/api\/providers/, "RuntimeStatus overlay should read Core provider summaries");
  assert.doesNotMatch(snapshotSource, /apiKeyEnv|baseUrl|apiMode/, "RuntimeStatus Core overlay must not expose provider transport config");
  assert.match(mainSource, /const runtimeStatusCoreSnapshot = createRuntimeStatusCoreSnapshot/, "main should instantiate the Core snapshot adapter");
  assert.match(mainSource, /IpcChannel\.RuntimeInitialize[\s\S]{0,260}runtimeStatusWithCoreModelProviders/, "runtime initialize should return the Core-overlaid status");
  assert.match(mainSource, /IpcChannel\.RuntimeStatus[\s\S]{0,220}runtimeStatusWithCoreModelProviders/, "runtime status should return the Core-overlaid status");
  assert.doesNotMatch(getRuntimeStatusBlock, /apiKeyEnv:|baseUrl:|apiMode:/, "fallback RuntimeStatus model must not expose provider transport config");
  assert.doesNotMatch(mainSource, /resolveHermesModelSettingsFromCore|route:\s*"\/api\/providers\/resolve"|const settings = await resolveHermesModelSettingsFromCore\(\)/, "Hermes startup must not pull resolved provider transport back into Electron main");
  assert.match(mainSource, /prepareRuntimeConfig\(port\)/, "Hermes startup should ask Rust Core to prepare the runtime config for the selected port");
  assert.match(engineRuntimeSource, /route:\s*"\/api\/engines\/hermes\/runtime-config"/, "Hermes config preparation should use the Rust Core runtime-config endpoint");
  assert.match(mainSource, /async function saveProviderConnection/, "provider OAuth completion should use a Core-backed save adapter");
  assert.match(mainSource, /route:\s*"\/api\/settings\/model-selection"/, "provider OAuth completion should persist through Core model-selection");
  assert.doesNotMatch(mainSource, /createProviderConnections|providerConnections\.|providerConnectionStore|connectedProviderSummaries/, "main must not import, write, read, or summarize the old provider JSON mirror");
  assert.doesNotMatch(runtimePathsSource, /providerConnections|mia-providers\.json/, "runtime paths must not expose the old provider JSON mirror path");
  assert.doesNotMatch(runtimePathsSource, /modelSettings|mia-model\.json/, "runtime paths must not expose the old model settings JSON path");
  assert.doesNotMatch(enginePluginsSource, /mia-providers\.json/, "Hermes plugin wrapper must not read old provider JSON mirror env");
  assert.doesNotMatch(mainSource, /function writeModelSettings|fs\.writeFileSync\(p\.modelSettings/, "main must not write the old model settings JSON");
  assert.doesNotMatch(mainSource, /function defaultProviderStore/, "main must not own provider connection defaults");
  assert.doesNotMatch(mainSource, /function normalizeProviderConnection/, "main must not own provider connection normalization");
  assert.doesNotMatch(mainSource, /function providerConnectionStore/, "main must not own provider connection persistence");
});

test("profile and appearance preferences live behind the main settings store", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const settingsSource = fs.readFileSync(path.join(root, "src/main/settings-store.js"), "utf8");

  assert.match(settingsSource, /function appearanceSettings/, "settings store should own appearance reads");
  assert.match(settingsSource, /function writeAppearanceSettings/, "settings store should own appearance writes");
  assert.match(settingsSource, /function userProfile/, "settings store should own profile reads");
  assert.match(settingsSource, /function writeUserProfile/, "settings store should own profile writes");
  assert.doesNotMatch(mainSource, /function appearanceSettings/, "main must not own appearance reads");
  assert.doesNotMatch(mainSource, /validHex/, "main must not own appearance validation");
  assert.doesNotMatch(mainSource, /fs\.writeFileSync\(p\.appearanceSettings/, "main must not write appearance settings directly");
  assert.doesNotMatch(mainSource, /fs\.writeFileSync\(p\.userProfile/, "main must not write user profile directly");
  assert.doesNotMatch(mainSource, /avatarText: String\(profile\.avatarText/, "main must not own profile normalization");
});

test("auth and provider OAuth lifecycle live behind a main auth service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const authSource = fs.readFileSync(path.join(root, "src/main/auth-service.js"), "utf8");

  assert.match(authSource, /function createAuthService/, "auth service Module should exist");
  assert.match(mainSource, /createAuthService/, "main should instantiate the auth service");
  assert.doesNotMatch(mainSource, /let authProcess/, "main must not own OAuth child-process state");
  assert.doesNotMatch(mainSource, /let codexOAuthCancelled/, "main must not own Codex OAuth cancellation state");
  assert.doesNotMatch(mainSource, /let authState/, "main must not own auth mutable state");
  assert.doesNotMatch(mainSource, /function appendAuthLog/, "main must not own auth log parsing");
  assert.doesNotMatch(mainSource, /async function requestCodexDeviceCode/, "main must not own Codex device auth HTTP calls");
  assert.doesNotMatch(mainSource, /async function pollCodexAuthorization/, "main must not own Codex device auth polling");
  assert.doesNotMatch(mainSource, /function startProviderOAuth/, "main must not own provider OAuth lifecycle");
});

test("engine catalog, capabilities, and slash command discovery live behind Rust Core routes", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const adapterSource = fs.readFileSync(path.join(root, "src/main/engine-catalog-core-adapter.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const rendererHtml = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const webHtml = fs.readFileSync(path.join(root, "src/web/app/index.html"), "utf8");
  const routesSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/routes.rs"), "utf8");
  const engineSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/engine.rs"), "utf8");

  assert.match(adapterSource, /function createEngineCatalogCoreAdapter/, "main should use a thin Core adapter");
  assert.match(mainSource, /createEngineCatalogCoreAdapter/, "main should instantiate Core-backed engine catalog discovery");
  assert.match(routesSource, /\/api\/engines\/model-catalog/, "Rust Core should own model catalog HTTP route");
  assert.match(routesSource, /\/api\/engines\/codex\/models/, "Rust Core should own Codex model list route");
  assert.match(routesSource, /\/api\/engines\/capabilities/, "Rust Core should own engine capability route");
  assert.match(routesSource, /\/api\/engines\/slash-commands/, "Rust Core should own slash command route");
  assert.match(engineSource, /fallback_model_catalog/, "Rust Core should own model catalog fallbacks");
  assert.equal(fs.existsSync(path.join(root, "src/main/engine-catalog-service.js")), false, "old Node engine catalog service should be deleted");
  assert.doesNotMatch(mainSource, /createEngineCatalogService/, "main must not instantiate Node engine catalog discovery");
  assert.doesNotMatch(mainSource, /engineCatalogService/, "main must not call the Node engine catalog service");
  assert.doesNotMatch(mainSource, /function fallbackModelCatalog/, "main must not own model catalog fallbacks");
  assert.doesNotMatch(mainSource, /async function loadHermesModelCatalogInner/, "main must not own Hermes model discovery scripts");
  assert.doesNotMatch(mainSource, /function loadCodexModels/, "main must not own Codex model cache parsing");
  assert.doesNotMatch(mainSource, /async function loadEngineCapabilities/, "main must not own engine capability discovery");
  assert.doesNotMatch(mainSource, /function fallbackSlashCommands/, "main must not own slash command fallbacks");
  assert.doesNotMatch(mainSource, /async function loadHermesSlashCommandsInner/, "main must not own Hermes slash command discovery scripts");
  assert.doesNotMatch(engineSource, /gpt-5\.3-codex/, "Rust model catalog fallback must not hard-code stale Codex model slugs");
  assert.doesNotMatch(rendererSource, /gpt-5\.3-codex|GPT-5\.3 Codex/, "renderer must not hard-code stale Codex model defaults");
  assert.doesNotMatch(rendererHtml, /gpt-5\.3-codex|GPT-5\.3 Codex/, "static renderer shell must not hard-code stale Codex model defaults");
  assert.doesNotMatch(webHtml, /gpt-5\.3-codex|GPT-5\.3 Codex/, "web shell must not hard-code stale Codex model defaults");
});

test("external Agent command execution and session binding live behind Rust Core routes", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const adapterSource = fs.readFileSync(path.join(root, "src/main/external-agent-command-core-adapter.js"), "utf8");
  const routesSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/routes.rs"), "utf8");
  const commandSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/agent_command.rs"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/external-agent-command-service.js")), false, "old Node external Agent command service should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/agent-command-provider.js")), false, "old Node Agent command provider should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/agent-session-index.js")), false, "old Node external Agent session index should be deleted");
  assert.match(adapterSource, /function createExternalAgentCommandCoreAdapter/, "main should use a thin Core command adapter");
  assert.match(mainSource, /createExternalAgentCommandCoreAdapter/, "main should instantiate Core-backed external Agent command execution");
  assert.match(routesSource, /\/api\/agents\/commands\/list/, "Rust Core should own external Agent command list route");
  assert.match(routesSource, /\/api\/agents\/commands\/execute/, "Rust Core should own external Agent command execute route");
  assert.match(commandSource, /mia-agent-sessions\.json/, "Rust Core should own external Agent session binding persistence");
  assert.doesNotMatch(mainSource, /createExternalAgentCommandService/, "main must not instantiate Node external Agent command execution");
  assert.doesNotMatch(mainSource, /createAgentCommandProvider/, "main must not instantiate Node Agent command discovery");
  assert.doesNotMatch(mainSource, /const externalAgentBuiltInCommands/, "main must not own external Agent built-in command definitions");
  assert.doesNotMatch(mainSource, /function splitCommandInvocation/, "main must not keep unused Agent command parsing helpers");
  assert.doesNotMatch(mainSource, /function executeExternalAgentCommand/, "main must not own external Agent command execution");
  assert.doesNotMatch(mainSource, /function externalAgentStatus/, "main must not own external Agent status rendering");
  assert.doesNotMatch(mainSource, /function listBoundExternalAgentSessions/, "main must not own external session binding list shaping");
  assert.doesNotMatch(mainSource, /function usefulExternalSessionRow/, "main must not own external session history filtering");
  assert.doesNotMatch(mainSource, /function runExternalSlashCommand/, "main must not own external slash command execution");
  assert.doesNotMatch(mainSource, /function skillRoots/, "main must not keep dead skill root helpers");
});

test("legacy Claude bridge plugin generation is deleted", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/claude-bridge-plugin-service.js")), false, "Claude bridge plugin service should be deleted");
  assert.doesNotMatch(mainSource, /createClaudeBridgePluginService/, "main should not instantiate Claude bridge plugin setup");
  assert.doesNotMatch(mainSource, /function ensureClaudeBridgePlugin/, "main must not own Claude bridge plugin generation");
  assert.doesNotMatch(mainSource, /\.claude-plugin/, "main must not own Claude plugin manifest paths");
  assert.doesNotMatch(mainSource, /mia-skills/, "main must not own Claude plugin manifest content");
  assert.doesNotMatch(mainSource, /fs\.symlinkSync\(skillPath/, "main must not own bridge skill symlink creation");
});

test("bot pet assets, generation jobs, and pet windows live behind a main bot-pet service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const petSource = fs.readFileSync(path.join(root, "src/main/bot-pet-service.js"), "utf8");

  assert.match(petSource, /function createBotPetService/, "bot pet service should exist");
  assert.match(mainSource, /createBotPetService/, "main should instantiate the bot pet service");
  assert.doesNotMatch(mainSource, /const petWindows = new Map/, "main must not own pet window state");
  assert.doesNotMatch(mainSource, /const petJobs = new Map/, "main must not own pet generation job state");
  assert.doesNotMatch(mainSource, /function botPetId/, "main must not own pet id normalization");
  assert.doesNotMatch(mainSource, /function findBotPetPackage/, "main must not own pet asset discovery");
  assert.doesNotMatch(mainSource, /function petStatusForBot/, "main must not own pet status shaping");
  assert.doesNotMatch(mainSource, /function startBotPetGeneration/, "main must not own pet generation orchestration");
  assert.doesNotMatch(mainSource, /function notifyBotPetMessage/, "main must not own pet window notifications");
  assert.doesNotMatch(mainSource, /function placeBotPet/, "main must not own pet window placement");
  assert.doesNotMatch(mainSource, /function recallBotPet/, "main must not own pet window teardown");
  assert.doesNotMatch(mainSource, /function officialLibraryManifestPath/, "main must not own packaged library resource lookup");
  assert.doesNotMatch(mainSource, /function resolveOfficialLibraryRoot/, "main must not own packaged library root resolution");
});

test("legacy Node Core entry is deleted after Rust Core cutover", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const resolverSource = fs.readFileSync(path.join(root, "src/main/mia-core/process-resolver.js"), "utf8");
  const launcherSource = fs.readFileSync(path.join(root, "src/main/mia-core/process-launcher.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, LEGACY_CORE_ENTRY)), false, "old Node Core entry must stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/daemon/executable-resolver.js")), false, "old daemon resolver path must stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/daemon/process-launcher.js")), false, "old daemon process launcher path must stay deleted");
  assert.match(resolverSource, /bundled-mia-core|MIA_CORE_BIN/, "Core resolver should target the Rust Core binary");
  assert.doesNotMatch(`${resolverSource}\n${launcherSource}`, /daemonEnvOverlay|createDaemonProcessLauncher|daemonEnvironment|daemonProgramArguments|daemonWorkingDirectory/, "Core resolver and launcher must not expose old daemon aliases");
  assert.doesNotMatch(mainSource, /src\/core\/mia-core|require\(["']\.\/core\/mia-core\.js["']\)|createMiaCore\(/, "Electron main must not import or instantiate the old Node Core");
});

test("legacy Hermes HTTP bot execution path is retired from main", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const checkSource = fs.readFileSync(path.join(root, "src/check.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/hermes-chat-adapter.js")), false, "legacy Hermes HTTP chat adapter should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/hermes-run-service.js")), false, "legacy Hermes HTTP run service should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/chat-engine-adapters.js")), false, "legacy stateless chat adapter graph should be deleted");
  assert.doesNotMatch(mainSource, /hermes-chat-adapter|hermes-run-service|createActiveHermesChatAdapter|sendHermesChat|sendHermesStateless/, "main must not import or wire legacy Hermes HTTP chat execution");
  assert.doesNotMatch(checkSource, /hermes-chat-adapter|hermes-run-service/, "project structure inventory must not require deleted Hermes HTTP files");
  assert.doesNotMatch(mainSource, /function normalizeRunMessages|function buildRunPayload|function parseSseFrame|async function readRunEventStream|function normalizeHermesError/, "main must not inline deleted Hermes HTTP helper logic");
});

test("Hermes slash-command execution lives behind a main hermes-slash-command service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const slashSource = fs.readFileSync(path.join(root, "src/main/hermes-slash-command-service.js"), "utf8");

  assert.match(slashSource, /function createHermesSlashCommandService/, "Hermes slash-command service should exist");
  assert.match(mainSource, /createHermesSlashCommandService/, "main should instantiate Hermes slash-command execution");
  assert.doesNotMatch(mainSource, /function runHermesSlashCommand/, "main must not own Hermes slash-command execution");
  assert.doesNotMatch(mainSource, /_MIA_ZH_I18N/, "main must not embed Hermes slash-command i18n dictionaries");
  assert.doesNotMatch(mainSource, /GatewayRunner/, "main must not embed Hermes gateway Python scripts");
  assert.doesNotMatch(mainSource, /gateway\.help\.header/, "main must not own localized Hermes command copy");
});

test("macOS launchd plist and launchctl operations live behind a main launchd service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const launchdSource = fs.readFileSync(path.join(root, "src/main/launchd-service.js"), "utf8");

  assert.match(launchdSource, /function createLaunchdService/, "launchd service should exist");
  assert.match(mainSource, /createLaunchdService/, "main should instantiate launchd orchestration");
  assert.doesNotMatch(mainSource, /function xmlEscape/, "main must not own launchd XML escaping");
  assert.doesNotMatch(mainSource, /function launchdDomain/, "main must not own launchd domain selection");
  assert.doesNotMatch(mainSource, /function runLaunchctl/, "main must not own launchctl invocation");
  assert.doesNotMatch(mainSource, /function launchAgentPlist/, "main must not own gateway LaunchAgent plist rendering");
  assert.doesNotMatch(mainSource, /function writeLaunchAgentPlist/, "main must not own gateway LaunchAgent writes");
  assert.doesNotMatch(mainSource, /function stopLaunchAgent/, "main must not own gateway launchd stop");
  assert.doesNotMatch(mainSource, /function startLaunchAgent/, "main must not own gateway launchd start");
  assert.doesNotMatch(mainSource, /function daemonLaunchAgentPlist/, "main must not own daemon LaunchAgent plist rendering");
  assert.doesNotMatch(mainSource, /function writeDaemonLaunchAgentPlist/, "main must not own daemon LaunchAgent writes");
  assert.doesNotMatch(mainSource, /function stopDaemonLaunchAgent/, "main must not own daemon launchd stop");
  assert.doesNotMatch(mainSource, /function startDaemonLaunchAgent/, "main must not own daemon launchd start");
});

test("Mia Hermes plugin files and install cleanup live behind a main engine-plugins service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const pluginSource = fs.readFileSync(path.join(root, "src/main/engine-plugins-service.js"), "utf8");

  assert.match(pluginSource, /function createEnginePluginsService/, "engine plugins service should exist");
  assert.match(mainSource, /createEnginePluginsService/, "main should instantiate engine plugin installation");
  assert.doesNotMatch(pluginSource, /mia-model\.json|apiKeyEnv|apiKey/, "Hermes plugin wrapper must not read legacy provider secret files");
  assert.doesNotMatch(mainSource, /function miaPluginFiles/, "main must not own embedded Python plugin source");
  assert.doesNotMatch(mainSource, /function ensureEnginePlugins/, "main must not own engine plugin install cleanup");
  assert.doesNotMatch(mainSource, /X-Mia-Fellow/, "main must not embed Hermes overlay Python code");
});

test("local Agent CLI discovery and version caching live behind a main local-agent-engine service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const localAgentSource = fs.readFileSync(path.join(root, "src/main/local-agent-engine-service.js"), "utf8");

  assert.match(localAgentSource, /function createLocalAgentEngineService/, "local Agent engine service should exist");
  assert.match(localAgentSource, /function agentInventory/, "local Agent engine service should own normalized inventory");
  assert.match(mainSource, /createLocalAgentEngineService/, "main should instantiate local Agent engine discovery");
  assert.doesNotMatch(mainSource, /function agentInventory/, "main must not own normalized local Agent inventory");
  assert.doesNotMatch(mainSource, /const CLI_PATH_SEGMENTS/, "main must not own CLI PATH candidates");
  assert.doesNotMatch(mainSource, /function cliPathEnv/, "main must not own CLI PATH expansion");
  assert.doesNotMatch(mainSource, /function shellCommandPath/, "main must not own shell command discovery");
  assert.doesNotMatch(mainSource, /function commandVersion/, "main must not own CLI version probing");
  assert.doesNotMatch(mainSource, /function localAgentEngines/, "main must not own local Agent status caching");
  assert.doesNotMatch(mainSource, /let agentEngineCache/, "main must not own local Agent engine cache state");
});

test("external Agent session binding persistence lives behind a main agent-session store", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const storeSource = fs.readFileSync(path.join(root, "src/main/agent-session-store.js"), "utf8");

  assert.match(storeSource, /function createAgentSessionStore/, "agent session store should exist");
  assert.match(mainSource, /createAgentSessionStore/, "main should instantiate agent session persistence");
  assert.doesNotMatch(mainSource, /function loadAgentSessionMap/, "main must not own external Agent session reads");
  assert.doesNotMatch(mainSource, /function saveAgentSessionMap/, "main must not own external Agent session writes");
  assert.doesNotMatch(mainSource, /function agentSessionKey/, "main must not own external Agent session key normalization");
  assert.doesNotMatch(mainSource, /function getAgentSessionId/, "main must not own external Agent session lookup");
  assert.doesNotMatch(mainSource, /function setAgentSessionId/, "main must not own external Agent session binding writes");
  assert.doesNotMatch(mainSource, /function getAgentSessionEntry/, "main must not own external Agent session entry lookup");
  assert.doesNotMatch(mainSource, /function setAgentSessionEntry/, "main must not own external Agent session entry writes");
});

test("Mia memory desktop UI keeps only the mode setting bridge", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const channelSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const runtimePathsSource = fs.readFileSync(path.join(root, "src/main/runtime-paths.js"), "utf8");
  const runtimeContextSource = fs.readFileSync(path.join(root, "src/main/mia-runtime-context.js"), "utf8");

  assert.match(runtimePathsSource, /mia-memory\.json/, "runtime paths should retain the legacy Mia memory migration path");
  assert.match(runtimePathsSource, /mia-memory\.sqlite/, "runtime paths should own the scoped Mia memory database path");
  assert.match(mainSource, /IpcChannel\.MemorySettingsSave/);
  assert.match(preloadSource, /saveMemorySettings/);
  assert.match(channelSource, /MemorySettingsSave/);
  assert.doesNotMatch(`${mainSource}\n${preloadSource}\n${channelSource}`, /Memory(?:List|ListAll|Remember|Update|Forget|Delete)/);
  assert.doesNotMatch(mainSource, /miaMemoryService|syncNativeMemoryFiles|scheduleCloudMemorySync/);
  for (const fileName of [
    "mia-memory-service.js",
    "mia-memory-store.js",
    "mia-memory-provider.js",
    "mia-native-memory-bridge.js"
  ]) {
    assert.equal(fs.existsSync(path.join(root, "src/main", fileName)), false, `${fileName} must stay deleted`);
  }
  assert.match(runtimeContextSource, /sanitizeMiaMemorySpoof/, "Mia runtime context should expose user-spoofed memory header neutralization");
  assert.equal(fs.existsSync(path.join(root, "src/main/native-memory-context.js")), false, "old prompt-rendered native memory helper must stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/openclaw-chat-adapter.js")), false, "removed OpenClaw adapter must stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/chat-engine-adapters.js")), false, "deleted prompt adapter graph must not regain memory prompt injection hooks");
});

test("Mia app MCP is per-turn Rust stdio and old global-context bridges stay deleted", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/builtin_mcp.rs"), "utf8");
  const conversationSource = fs.readFileSync(path.join(root, "crates/mia-core-conversation/src/lib.rs"), "utf8");

  assert.match(serverSource, /pub async fn run_builtin_mcp_stdio/, "Rust Core should own the built-in MCP stdio server");
  assert.match(serverSource, /fn tool_definitions/, "Rust Core should own built-in tool schemas");
  assert.match(conversationSource, /MIA_CONVERSATION_ID/, "each turn should carry exact MCP scope");
  assert.equal(fs.existsSync(path.join(root, "src/main/mia-app-mcp-bridge.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/main/mia-app-mcp-server.js")), false);
  assert.doesNotMatch(mainSource, /createMiaAppMcpBridge|miaAppMcpBridge\.getSpec/);
  assert.doesNotMatch(mainSource, /function toolDefinitions/, "main must not own MCP tool schemas");
  assert.doesNotMatch(mainSource, /conversation_create_group/, "main must not inline Mia app MCP tool definitions");
});

test("scheduler uses the Aion text protocol and has no MCP bridge", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const profileSource = fs.readFileSync(path.join(root, "src/main/agent-runtime-profile-service.js"), "utf8");
  const cronSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/cron_turn.rs"), "utf8");

  assert.match(profileSource, /function createAgentRuntimeProfileService/, "agent runtime profile service should exist");
  assert.match(cronSource, /MAX_CRON_CONTINUATIONS/, "Rust Core should own cron continuations");
  assert.equal(fs.existsSync(path.join(root, "src/main/scheduler-mcp-bridge.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/main/scheduler-mcp-server.js")), false);
  assert.doesNotMatch(profileSource, /CODEX_BLOCKED_STATE/, "Codex should use the user's native home without private state filtering");
  assert.doesNotMatch(mainSource, /createSchedulerMcpBridge/, "main must not instantiate scheduler MCP");
  assert.doesNotMatch(mainSource, /ensureCodexHome:\s*schedulerMcpBridge\.ensureCodexHome|ensureCodexHome:\s*\(options\)\s*=>\s*schedulerMcpBridge\.ensureCodexHome\(options\)/, "main should not forward Codex home setup into retired JS utility runtimes");
  assert.doesNotMatch(mainSource, /function resolveNodePath/, "main must not own node CLI discovery for scheduler MCP");
  assert.doesNotMatch(mainSource, /function schedulerMcpContextPath/, "main must not own scheduler MCP context path");
  assert.doesNotMatch(mainSource, /function schedulerMcpServerScriptPath/, "main must not own scheduler MCP script path");
  assert.doesNotMatch(mainSource, /function writeSchedulerMcpContext/, "main must not own scheduler MCP context writes");
  assert.doesNotMatch(mainSource, /function resolveDaemonBaseUrl/, "main must not own scheduler MCP daemon URL selection");
  assert.doesNotMatch(mainSource, /function getSchedulerMcpSpec/, "main must not own scheduler MCP SDK config");
  assert.doesNotMatch(mainSource, /function ensureCodexHome/, "main must not own Codex home MCP config merging");
});

test("system Hermes probing lives behind a main system-hermes service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const systemSource = fs.readFileSync(path.join(root, "src/main/system-hermes-service.js"), "utf8");

  assert.match(systemSource, /function createSystemHermesService/, "system Hermes service should exist");
  assert.match(mainSource, /createSystemHermesService/, "main should instantiate system Hermes policy");
  assert.match(systemSource, /function readShebangPython/, "system Hermes service should own shebang probing");
  assert.doesNotMatch(mainSource, /function readShebangPython/, "main must not keep system Hermes shebang probing");
  assert.doesNotMatch(mainSource, /function systemHermesCachePath/, "main must not own system Hermes cache paths");
  assert.doesNotMatch(mainSource, /function loadSystemHermesCache/, "main must not own system Hermes cache reads");
  assert.doesNotMatch(mainSource, /function persistSystemHermesCache/, "main must not own system Hermes cache writes");
  assert.doesNotMatch(mainSource, /SYSTEM_HERMES_PROBE/, "main must not embed system Hermes probe scripts");
  assert.doesNotMatch(mainSource, /systemHermesRefreshing/, "main must not keep disabled system Hermes refresh state");
  assert.doesNotMatch(mainSource, /function refreshSystemHermesAsync/, "main must not own system Hermes refresh policy");
  assert.doesNotMatch(mainSource, /function userHermesHomePath/, "main must not own user Hermes home lookup");
  assert.doesNotMatch(mainSource, /function importFromSystemHermes/, "main must not keep unreachable system Hermes import logic");
  assert.doesNotMatch(mainSource, /function stripAnsi/, "main must not keep dotenv parsing helpers for disabled system Hermes");
  assert.doesNotMatch(mainSource, /function loadHermesDotenv/, "main must not own system Hermes dotenv imports");
});

test("engine runtime config files and Hermes config rendering live behind a main engine-runtime-config service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const configSource = fs.readFileSync(path.join(root, "src/main/engine-runtime-config-service.js"), "utf8");

  assert.match(configSource, /function createEngineRuntimeConfigService/, "engine runtime config service should exist");
  assert.match(mainSource, /createEngineRuntimeConfigService/, "main should instantiate engine runtime config");
  assert.doesNotMatch(mainSource, /require\("js-yaml"\)/, "main must not own Hermes YAML parsing");
  assert.doesNotMatch(mainSource, /function apiKey/, "main must not own API server key persistence");
  assert.doesNotMatch(mainSource, /function modelSettings/, "main must not own model settings reads");
  assert.doesNotMatch(mainSource, /function externalSkillDirs/, "main must not own external skill directory filtering");
  assert.doesNotMatch(mainSource, /function atomicWriteFile/, "main must not own atomic config writes");
  assert.doesNotMatch(mainSource, /function writeRuntimeConfig/, "main must not own Hermes config rendering");
  assert.doesNotMatch(mainSource, /function effectiveHermesHome/, "main must not own effective Hermes home policy");
  assert.doesNotMatch(mainSource, /function readConfiguredPort/, "main must not own Hermes config port parsing");
  assert.doesNotMatch(configSource, /apiKeyEnv|api_key_env|apiKey|api_key|baseUrl|base_url|apiMode|api_mode|writeRuntimeConfig|modelSettings/, "engine runtime config service should be a Core adapter, not provider/runtime config owner");
});

test("engine port selection and health probing live behind a main engine-health service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const healthSource = fs.readFileSync(path.join(root, "src/main/engine-health-service.js"), "utf8");

  assert.match(healthSource, /function createEngineHealthService/, "engine health service should exist");
  assert.match(mainSource, /createEngineHealthService/, "main should instantiate engine health probing");
  assert.doesNotMatch(mainSource, /require\("node:net"\)/, "main must not own TCP port probing");
  assert.doesNotMatch(mainSource, /function choosePort/, "main must not own local port selection");
  assert.doesNotMatch(mainSource, /async function isEngineHealthy/, "main must not own authenticated engine health probing");
  assert.doesNotMatch(mainSource, /async function adoptRunningEngine/, "main must not own running engine adoption");
  assert.doesNotMatch(mainSource, /async function waitForHealth/, "main must not own engine health polling");
});

test("Hermes startup and chat recovery stay owned by Mia Core", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const nativeTurnHelpersSource = fs.readFileSync(path.join(root, "src/main/native-turn-helpers.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const ipcChannelsSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const runtimeLifecycleSource = fs.readFileSync(path.join(root, "src/main/runtime-lifecycle-service.js"), "utf8");
  const startIndex = mainSource.indexOf("async function startEngine()");
  const stopIndex = mainSource.indexOf("async function stopEngine()", startIndex);
  assert.notEqual(startIndex, -1, "main should define startEngine");
  assert.notEqual(stopIndex, -1, "main should define stopEngine after startEngine");
  const startEngineSource = mainSource.slice(startIndex, stopIndex);

  assert.doesNotMatch(
    startEngineSource,
    /adoptRunningEngine\(\)/,
    "Core-owned Hermes startup must spawn its own API process instead of adopting orphan gateways"
  );
  assert.match(startEngineSource, /prepareRuntimeConfig\(port\)/, "Core-owned Hermes startup must ask Rust Core to prepare Hermes runtime config for the port it owns");
  assert.doesNotMatch(startEngineSource, /writeRuntimeConfig|resolveHermesModelSettingsFromCore|modelRuntimeEnv/, "Hermes startup must not assemble provider transport in Electron main");
  assert.doesNotMatch(
    mainSource,
    /recoverHermesAfterFailure:\s*recoverHermesChatEngineAfterFailure/,
    "retired Hermes HTTP adapters must not keep a direct-retry recovery hook in main"
  );
  assert.doesNotMatch(nativeTurnHelpersSource, /会话前文（按时间顺序）/, "native prompt helpers must not serialize prior visible turns");
  assert.match(nativeTurnHelpersSource, /function currentUserPrompt/, "native prompt helpers should expose current-turn-only prompt extraction");
  assert.match(
    mainSource,
    /createHermesSlashCommandService/,
    "Hermes slash commands should stay behind the dedicated service"
  );
  assert.doesNotMatch(mainSource, /ensureHermesChatEngineReady|createActiveChatEngineAdapters/, "main must not keep a local bot chat runtime owner for Hermes readiness");
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(IpcChannel\.EngineStart/, "foreground must not expose direct Hermes start IPC");
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(IpcChannel\.EngineStop/, "foreground must not expose direct Hermes stop IPC");
  assert.doesNotMatch(preloadSource, /startEngine:\s*\(\)\s*=>/, "preload must not expose direct Hermes start");
  assert.doesNotMatch(preloadSource, /stopEngine:\s*\(\)\s*=>/, "preload must not expose direct Hermes stop");
  assert.doesNotMatch(rendererSource, /window\.mia\.startEngine|window\.mia\.stopEngine/, "renderer must not call direct Hermes start/stop");
  assert.doesNotMatch(ipcChannelsSource, /EngineStart|EngineStop/, "shared IPC channels must not include direct Hermes start/stop");
  assert.doesNotMatch(runtimeLifecycleSource, /startEngine|engine:auto-start-begin|engine:auto-start-done/, "foreground runtime lifecycle must not auto-start Hermes");
});

test("launchd service keeps Hermes gateway cleanup but has no gateway start path", () => {
  const launchdSource = fs.readFileSync(path.join(root, "src/main/launchd-service.js"), "utf8");

  assert.match(launchdSource, /function stopGateway\(\)/, "old Hermes gateway cleanup should remain available");
  assert.match(launchdSource, /function gatewayProgramArguments\(\)/, "Core-owned Hermes spawn still reuses gateway args");
  assert.doesNotMatch(launchdSource, /function startGateway\(\)/, "launchd service must not start Hermes as an independent LaunchAgent");
  assert.doesNotMatch(launchdSource, /function writeGatewayLaunchAgentPlist\(\)/, "launchd service must not write Hermes gateway LaunchAgent plists");
  assert.doesNotMatch(launchdSource, /function gatewayLaunchAgentPlist\(\)/, "launchd service must not render Hermes gateway LaunchAgent plists");
});

test("engine installation lifecycle lives behind a main engine-install service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const installSource = fs.readFileSync(path.join(root, "src/main/engine-install-service.js"), "utf8");
  const runtimePathsSource = fs.readFileSync(path.join(root, "src/main/runtime-paths.js"), "utf8");

  assert.match(installSource, /function createEngineInstallService/, "engine install service should exist");
  assert.match(mainSource, /createEngineInstallService/, "main should instantiate engine installation");
  assert.doesNotMatch(mainSource, /function officialEngineUrl/, "main must not own official engine archive URL policy");
  assert.doesNotMatch(mainSource, /function officialEngineRequirement/, "main must not own pip package requirement formatting");
  assert.doesNotMatch(mainSource, /function pythonVersion/, "main must not own Python version probing");
  assert.doesNotMatch(mainSource, /function selectOfficialEnginePython/, "main must not own Python candidate selection");
  assert.doesNotMatch(mainSource, /function isEngineInstalled/, "main must not own installed-runtime detection");
  assert.doesNotMatch(mainSource, /function runEngineInstallCommand/, "main must not own installation command execution");
  assert.doesNotMatch(mainSource, /function installEngineFromDevSource/, "main must not own local-source installation");
  assert.doesNotMatch(mainSource, /function installEngineFromOfficialPackage/, "main must not own official package installation");
  assert.doesNotMatch(mainSource, /function installEngine/, "main must not own install source routing");
  assert.doesNotMatch(mainSource, /function enginePython/, "main must not own engine Python executable selection");
  assert.doesNotMatch(mainSource, /function engineSource/, "main must not own engine source classification");
  assert.doesNotMatch(runtimePathsSource, /installation helpers .*stay in main\.js/s, "runtime paths docs must not claim installation stays in main");
});

test("Hermes install source selection lives behind a main service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const sourceService = fs.readFileSync(path.join(root, "src/main/hermes-install-source-service.js"), "utf8");

  assert.match(sourceService, /function createHermesInstallSourceService/);
  assert.doesNotMatch(mainSource, /function resolveInstallSource/);
  assert.doesNotMatch(mainSource, /MIA_ENGINE_MIRROR_URL/);
});

test("runtime directory initialization lives behind a main runtime-initializer service", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const initializerSource = fs.readFileSync(path.join(root, "src/main/runtime-initializer-service.js"), "utf8");

  assert.match(initializerSource, /function createRuntimeInitializerService/, "runtime initializer service should exist");
  assert.match(mainSource, /createRuntimeInitializerService/, "main should instantiate runtime initialization");
  assert.doesNotMatch(mainSource, /function writeFileIfMissing/, "main must not own default runtime file writes");
  assert.doesNotMatch(mainSource, /function migrateLegacyPersonas/, "main must not own legacy persona migration");
  assert.doesNotMatch(mainSource, /function initializeRuntimeCore/, "main must not own runtime directory bootstrapping");
  assert.doesNotMatch(mainSource, /Mia Shared Soul/, "main must not embed default SOUL content");
  assert.doesNotMatch(mainSource, /runtime\/engine-home\/mia-model\.json/, "main must not own default settings creation bookkeeping");
});

test("runtime initializer no longer creates the provider JSON mirror", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const initializerSource = fs.readFileSync(path.join(root, "src/main/runtime-initializer-service.js"), "utf8");
  const initializerBlock = mainSource.match(/const runtimeInitializerService = createRuntimeInitializerService\(\{[\s\S]*?\n\}\);/)?.[0] || "";

  assert.ok(initializerBlock, "runtime initializer construction should exist");
  assert.doesNotMatch(initializerSource, /defaultProviderStore|providerConnections|mia-providers\.json/, "runtime initializer must not create old provider mirror defaults");
  assert.doesNotMatch(initializerBlock, /defaultProviderStore/, "main must not inject old provider mirror defaults into runtime initialization");
});

test("foreground window stays hidden until the renderer is ready to avoid startup blanking", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const createWindowSource = mainSource.match(/function createWindow\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(createWindowSource, /show:\s*false/, "BrowserWindow should not show before renderer first paint");
  // Startup background matches the content that will paint: white for the
  // lightweight onboarding page (no flash), the app chrome color otherwise.
  assert.match(createWindowSource, /backgroundColor:\s*onboarding[\s\S]*\?\s*"#ffffff"[\s\S]*initialWindowsTitleBarOverlay\.color/, "window startup background should match the page it loads");
  assert.match(createWindowSource, /const showWhenReady = \(\) => \{[\s\S]*?win\.show\(\)/, "window should show through a single guarded helper");
  assert.match(createWindowSource, /win\.miaShowWhenReady = showWhenReady/, "window IPC should be able to reveal the window on renderer first paint");
  assert.match(createWindowSource, /win\.once\("ready-to-show", showWhenReady\)/, "window should show when Electron reports a first paint");

  const windowIpcSource = fs.readFileSync(path.join(root, "src/main/ipc/window-ipc.js"), "utf8");
  assert.match(windowIpcSource, /IpcChannel\.UiFirstPaint[\s\S]*?miaShowWhenReady\(\)/, "renderer first paint IPC should reveal the real window immediately");
});

test("foreground window routes target blank browser links through external opener", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const createWindowSource = mainSource.match(/function createWindow\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(createWindowSource, /win\.webContents\.setWindowOpenHandler/);
  assert.match(createWindowSource, /openExternalUrl\(url\)/);
  assert.match(createWindowSource, /action:\s*"deny"/);
});

test("Core control server uses the daemon compatibility Module behind a Mia Core wrapper", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(root, "src/main/mia-core/control-server.js"), "utf8");
  assert.equal(fs.existsSync(path.join(root, "src/main/daemon/control-server.js")), false, "old daemon control-server path should stay deleted");
  assert.match(controlSource, /function createMiaCoreControlServer/, "Mia Core control server Module should exist");
  assert.equal(fs.existsSync(path.join(root, "src/main/mia-core/local-process-control.js")), false, "old Mia Core process wrapper should stay deleted");
  assert.match(mainSource, /createMiaCoreControlServer/, "main should instantiate the Mia Core control server directly");
  assert.doesNotMatch(controlSource, /getMiaContextSnapshot|getMiaCurrentSkills|miaMemoryService|isMemoryEnabled|onMemoryChanged/, "compat control server must not own Mia MCP context, skills, or memory routes");
  assert.doesNotMatch(mainSource, /getMiaContextSnapshot:|getMiaCurrentSkills:|onMemoryChanged:\s*scheduleCloudMemorySync/, "main must not inject Mia MCP route handlers into the compatibility server");
  assert.doesNotMatch(mainSource, /let controlServer\b/, "main must not own the daemon HTTP server instance");
  assert.doesNotMatch(mainSource, /let controlServerState\b/, "main must not own daemon control mutable state");
  assert.doesNotMatch(mainSource, /function requestAuthToken/, "main must not own daemon auth parsing");
  assert.doesNotMatch(mainSource, /function isControlRequestAuthorized/, "main must not own daemon request auth");
  assert.doesNotMatch(mainSource, /function readControlBody/, "main must not own daemon request body parsing");
  assert.doesNotMatch(mainSource, /async function handleControlRequest/, "main must not own daemon HTTP routing");
  assert.doesNotMatch(mainSource, /async function startControlServer/, "main must not own daemon HTTP lifecycle");
  assert.doesNotMatch(mainSource, /function stopControlServer/, "main must not own daemon HTTP lifecycle");
});

test("Core task HTTP compatibility is retired from Node while task events use the Core event client", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(root, "src/main/mia-core/control-server.js"), "utf8");
  const compatClientSource = fs.readFileSync(path.join(root, "src/main/mia-core/compat-client.js"), "utf8");
  const eventClientSource = fs.readFileSync(path.join(root, "src/main/mia-core/event-client.js"), "utf8");
  const chatSendSource = fs.readFileSync(path.join(root, "src/main/chat-send-delegation.js"), "utf8");
  const retiredTaskBackendFiles = [
    "src/main/tasks-store.js",
    "src/main/tasks-routes.js",
    "src/main/tasks-events.js",
    "src/main/scheduler.js",
    "src/main/scheduler-fire.js",
    "src/main/task-conversation.js",
    "tests/tasks-store.test.js",
    "tests/tasks-routes.test.js",
    "tests/scheduler.test.js",
    "tests/scheduler-fire.test.js",
    "tests/task-conversation.test.js"
  ];

  assert.match(compatClientSource, /function createMiaCoreCompatibilityClient/, "Mia Core compatibility client Module should exist");
  assert.match(compatClientSource, /Legacy task routes are retired/, "compat client should fail closed for legacy task routes");
  assert.doesNotMatch(compatClientSource, /coreScheduleFromLegacyTask|legacyTaskFromCoreJob|buildCoreTaskJobRequest|buildCoreTaskJobUpdate/, "compat client must not own legacy task shape conversion");
  assert.match(mainSource, /createMiaCoreCompatibilityClient/, "main should instantiate the Core compatibility client for non-task compatibility calls");
  assert.doesNotMatch(mainSource, /createMiaCoreCompatibilityClient:\s*createMiaCoreTasksClient|miaCoreTasksClient/, "main should not name the generic compatibility client as a task client");
  assert.doesNotMatch(mainSource, /function createAppScheduledTask|miaCoreTasksClient\.call\(["']\/api\/tasks["']/, "main must not keep unused legacy task creation helpers");
  assert.doesNotMatch(mainSource, /daemonClient:\s*\{[\s\S]{0,120}\/api\/chat\/send/, "foreground chat send should call typed Core conversation routes");
  assert.doesNotMatch(chatSendSource, /daemonClient|daemonChatPayload|Mia Core daemon client/, "chat send delegator should expose a Core conversation client, not daemon-named transport");
  assert.doesNotMatch(mainSource, /miaCoreTasksClient\.startEvents/, "task events should share the Rust Core local event websocket client");
  assert.doesNotMatch(compatClientSource, /startEvents|WebSocketImpl|sendTaskEvent/, "compat client should not own a duplicate task websocket");
  assert.match(compatClientSource, /Legacy chat send is retired/, "compat client should fail closed for legacy chat send");
  assert.match(controlSource, /Legacy chat send is retired/, "control server should fail closed for legacy chat send");
  assert.doesNotMatch(controlSource, /handleChatSend|sendChat = null|createChatEventEmitter|text\/event-stream|emitStream/, "control server should not own legacy chat execution or SSE streaming");
  assert.match(eventClientSource, /rendererTaskEnvelope/, "Core event client should adapt task events for the renderer task panel");
  assert.doesNotMatch(controlSource, /tasksClient|forwardCoreTaskRequest|coreTasksClient/, "control server should not forward legacy task HTTP through Node");
  assert.match(controlSource, /Rust Core \/ws/, "control server should point local task event clients to Core websocket events");
  for (const relativePath of retiredTaskBackendFiles) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should stay deleted`);
  }
  assert.doesNotMatch(mainSource, /tasks-store|tasks-routes|tasks-events|scheduler-fire|createScheduler\(|sweepMissedCronTasks|initSchedulerSubsystem|tasksRoutes/, "main must not reintroduce the old Node task backend");
  assert.doesNotMatch(controlSource, /initSchedulerSubsystem|tasksRoutes\(\)|handleEventsStream|createTasksRoutes/, "control server must not call old Node task routes");
  assert.doesNotMatch(mainSource, /async function callDaemonTasks/, "main must not own daemon task HTTP calls");
  assert.doesNotMatch(mainSource, /function subscribeDaemonTaskEvents/, "main must not own daemon task SSE subscription");
  assert.doesNotMatch(mainSource, /\/api\/tasks\/events/, "main must not own the daemon task event stream route");
});

test("foreground local event subscription uses Rust Core websocket, not daemon SSE", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const eventClientSource = fs.readFileSync(path.join(root, "src/main/mia-core/event-client.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(root, "src/main/mia-core/control-server.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/daemon/local-events-client.js")), false, "daemon SSE local event client should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/daemon/local-event-renderer-router.js")), false, "daemon local event renderer router should stay deleted");
  assert.equal(fs.existsSync(path.join(root, "tests/daemon-local-events.test.js")), false, "old daemon local-events client tests should stay deleted");
  assert.match(eventClientSource, /coreWsUrl\(baseUrl\(\)\)/, "local event client should subscribe to Rust Core /ws");
  assert.match(eventClientSource, /type\.startsWith\("task\."\)/, "local event client should avoid duplicating Core task events");
  assert.match(mainSource, /createMiaCoreLocalEventsClient/, "main should import the Core event client directly");
  assert.doesNotMatch(mainSource, /rendererChannelForLocalEvent|\/api\/local-events/, "main must not subscribe to the daemon local-events SSE path");
  assert.doesNotMatch(controlSource, /\/api\/local-events|text\/event-stream;\s*charset=utf-8"[\s\S]*localEvent/, "daemon compatibility server must not expose the obsolete local-events SSE path");
});

test("cloud settings writes sync to Rust Core without the old daemon write route", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const writerSource = fs.readFileSync(path.join(root, "src/main/cloud/cloud-settings-writer.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(root, "src/main/mia-core/control-server.js"), "utf8");

  assert.match(writerSource, /syncCore/, "cloud settings writer should sync through Rust Core");
  assert.match(mainSource, /syncCore:\s*\(settings\)\s*=>\s*syncCloudSettingsToCore\(settings\)/, "main should wire cloud settings writes to Core sync");
  assert.doesNotMatch(writerSource, /daemonBaseUrl|daemonToken|\/api\/cloud-settings/, "writer must not call the old daemon cloud-settings route");
  assert.doesNotMatch(controlSource, /\/api\/cloud-settings|writeCloudSettings/, "daemon control server must not own cloud settings writes");
});

test("composer bot runtime controls ask Rust Core for option selection instead of parsing provider references in UI", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const modelSettingsSource = fs.readFileSync(path.join(root, "src/renderer/settings/model-settings.js"), "utf8");
  const modelHelpersSource = fs.readFileSync(path.join(root, "src/renderer/settings/model-helpers.js"), "utf8");

  assert.match(appSource, /getBotRuntimeControlOptions/, "renderer should call the Core runtime-control options endpoint");
  assert.doesNotMatch(appSource, /function runtimeControlModelProvider/, "UI must not derive provider ids from modelProfileId");
  assert.doesNotMatch(appSource, /function runtimeControlModelName/, "UI must not derive model ids from profile strings");
  assert.doesNotMatch(appSource, /function savedRuntimeModelEntryForControl/, "UI must not own saved model entry matching");
  assert.doesNotMatch(appSource, /profileId\.split\(":"\)/, "model profile parsing belongs in Rust Core");
  assert.doesNotMatch(htmlSource, /modelKeyEnv|modelBaseUrl|modelApiMode|modelProvider|modelName|modelPreset|authMethod/, "model settings form must not keep hidden backend transport fields");
  assert.doesNotMatch(appSource, /apiKeyEnv:\s*els\.modelKeyEnv\.value|baseUrl:\s*els\.modelBaseUrl\.value|apiMode:\s*els\.modelApiMode\.value/, "renderer must not submit provider runtime fields to Core");
  assert.doesNotMatch(appSource, /apiKeyEnv|api_key_env|apiMode|api_mode/, "renderer app must not read provider runtime transport fields");
  assert.doesNotMatch(modelSettingsSource, /apiKeyEnv|api_key_env|apiMode|api_mode|baseUrl|base_url/, "model settings UI must use UI labels, not provider transport fields");
  assert.doesNotMatch(modelHelpersSource, /apiKeyEnv|api_key_env|apiMode|api_mode|baseUrl|base_url/, "model helpers must not expose provider transport fields to renderer");
});

test("foreground permission IPC routes through the Core-control permission proxy", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const proxySource = fs.readFileSync(path.join(root, "src/main/agent-permission-proxy.js"), "utf8");
  const controlSource = fs.readFileSync(path.join(root, "src/main/mia-core/control-server.js"), "utf8");
  const coreRoutesSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/routes.rs"), "utf8");
  const coreSystemSource = fs.readFileSync(path.join(root, "crates/mia-core-system/src/lib.rs"), "utf8");
  const respondHandler = mainSource.match(/ipcMain\.handle\(IpcChannel\.ChatPermissionRespond[\s\S]*?\);/)?.[0] || "";
  const listHandler = mainSource.match(/ipcMain\.handle\(IpcChannel\.ChatPermissionList[\s\S]*?\);/)?.[0] || "";

  assert.equal(fs.existsSync(path.join(root, "src/main/agent-permission-coordinator.js")), false, "JS permission coordinator should be deleted after Rust Core owns permission state");
  assert.match(proxySource, /createAgentPermissionProxy/, "permission proxy Module should exist");
  assert.match(mainSource, /createAgentPermissionProxy/, "main should instantiate the permission proxy");
  assert.match(proxySource, /\/api\/agent-permissions\/respond/, "permission responses should use the Core-control permission endpoint");
  assert.match(proxySource, /\/api\/agent-permissions/, "permission lists should use the Core-control permission endpoint");
  assert.doesNotMatch(proxySource, /\/api\/chat\/permissions/, "permission proxy must not call retired chat permission routes");
  assert.doesNotMatch(proxySource, /isDaemonProcess|coordinator/, "permission proxy must not keep a local JS coordinator branch");
  assert.doesNotMatch(mainSource, /createAgentPermissionCoordinator|agentPermissionCoordinator/, "main must not construct a JS permission coordinator");
  assert.doesNotMatch(mainSource, /daemonClient:\s*\{[\s\S]{0,120}agentPermissionProxy/, "main must not inject a daemon-named permission client");
  assert.match(controlSource, /Agent permission routes are owned by Rust Core/, "compatibility server permission routes should fail closed");
  assert.doesNotMatch(controlSource, /agentPermissionCoordinator|resolvePermission|listPending/, "compatibility server must not own permission state");
  assert.match(coreRoutesSource, /\/api\/agent-permissions/, "Rust Core router should expose agent permission routes");
  assert.match(coreRoutesSource, /\/api\/agent-permissions\/respond/, "Rust Core router should expose agent permission response route");
  assert.match(coreSystemSource, /pub struct AgentPermissionService/, "Rust Core system service should own permission state");
  assert.match(respondHandler, /agentPermissionProxy\.respond/, "permission response IPC should route through the Core-control proxy");
  assert.match(listHandler, /agentPermissionProxy\.list/, "permission list IPC should route through the Core-control proxy");
  assert.doesNotMatch(respondHandler, /agentPermissionCoordinator/, "foreground permission response IPC must not resolve local coordinator state");
  assert.doesNotMatch(listHandler, /agentPermissionCoordinator/, "foreground permission list IPC must not read local coordinator state");
});

test("retired JS bot runtime owners stay deleted after Rust Core cutover", () => {
  const loaderSource = fs.readFileSync(path.join(root, "src/main/skills-loader.js"), "utf8");
  const schedulerDefaults = fs.readFileSync(path.join(root, "src/main/scheduler-skill-defaults.js"), "utf8");

  assert.equal(fs.existsSync(path.join(root, "src/main/bot-execution-core.js")), false, "retired JS bot execution core should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/social/local-bot-responder.js")), false, "retired JS local bot responder should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/social/bot-runtime-dispatcher.js")), false, "retired JS cloud bot dispatcher should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/social/bot-invocation.js")), false, "retired JS bot invocation materializer should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/chat-engine-adapters.js")), false, "retired JS stateless adapter graph should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/mia-native-context-bridge.js")), false, "legacy native context bridge should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/openclaw-chat-adapter.js")), false, "removed OpenClaw adapter must stay deleted");
  assert.doesNotMatch(loaderSource, /function buildEnabledSkillsContext/, "skills loader must not expose full enabled-skill prompt injection");
  assert.match(schedulerDefaults, /return dedupeSkillIds\(activeSkillIds\)/, "scheduler defaults should preserve explicit skill chips only");
});

test("OpenClaw bot chat adapter and wiring stay removed", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.doesNotMatch(mainSource, /sendOpenClawChat/, "main must not wire a direct OpenClaw bot chat dependency");
  assert.doesNotMatch(mainSource, /createOpenClaw/, "main must not instantiate removed OpenClaw adapters");
  assert.equal(fs.existsSync(path.join(root, "src/main/openclaw-chat-adapter.js")), false, "OpenClaw adapter file should be deleted");
});

test("Node stateless runtime utility adapters stay deleted after Core utility-turn cutover", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const checkSource = fs.readFileSync(path.join(root, "src/check.js"), "utf8");
  const mainAgentsGuide = fs.readFileSync(path.join(root, "src/main/AGENTS.md"), "utf8");
  const skillsLoaderSource = fs.readFileSync(path.join(root, "src/main/skills-loader.js"), "utf8");

  assertRetiredFilesDeleted(RETIRED_NODE_UTILITY_RUNTIME_FILES, "should be deleted after utility turns moved to Rust Core");
  assert.doesNotMatch(mainSource, /createActiveClaudeCodeChatAdapter|createActiveCodexChatAdapter/, "main must not construct Claude/Codex direct bot chat adapters");
  assert.doesNotMatch(mainSource, /createClaudeCodeStatelessAdapter|createCodexStatelessAdapter|runCodexAppServerTurn|createCodexMiaProxy/, "main must not construct Node utility runtime adapters");
  assert.doesNotMatch(checkSource, /chat-engine-adapters|claude-code-stateless-adapter|codex-stateless-adapter|codex-app-server-runner|codex-mia-proxy/, "project structure inventory must not require retired utility runtime files");
  assert.doesNotMatch(mainAgentsGuide, /stateless-adapter|codex-stateless-adapter|codex-app-server-runner/, "main guide must not send agents back to deleted utility runtime files");
  assert.doesNotMatch(skillsLoaderSource, /codex-stateless-adapter/, "skills loader comments must not cite deleted utility runtime files as module examples");
});

test("foreground utility turns route through Rust Core instead of JS stateless IPC", () => {
  const channelsSource = fs.readFileSync(path.join(root, "src/shared/ipc-channels.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const coreRoutesSource = fs.readFileSync(path.join(root, "crates/mia-core-app/src/router/routes.rs"), "utf8");

  assert.match(coreRoutesSource, /\/api\/conversations\/utility-turns/, "Rust Core should expose a typed utility-turn route");
  assert.match(preloadSource, /function buildCoreConversationUtilityTurnRequest/, "preload should build a typed Core utility request");
  assert.match(preloadSource, /sendChatStateless:\s*\(payload\)\s*=>\s*runCoreConversationUtilityTurn\(payload\)/, "temporary renderer API should be a Core REST adapter");
  assert.doesNotMatch(channelsSource, /ChatSendStateless/, "stateless chat IPC channel should be deleted");
  assert.doesNotMatch(preloadSource, /IpcChannel\.ChatSendStateless/, "preload must not invoke the old stateless IPC");
  assert.doesNotMatch(mainSource, /ChatSendStateless|sendChatStateless|createBotTurnHelpers|normalizeTurnRuntimeConfig|botWithRuntimeConfig|cloudBotSnapshotForTurn/, "Electron main must not own utility turn runtime injection");
  assert.equal(fs.existsSync(path.join(root, "src/main/bot-turn-helpers.js")), false, "bot runtime injection helper should be deleted");
  assert.equal(fs.existsSync(path.join(root, "src/main/runtime-config-normalizer.js")), false, "turn runtime normalizer should be deleted");
});
