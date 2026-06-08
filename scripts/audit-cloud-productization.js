#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const AdmZip = require("adm-zip");
const asar = require("@electron/asar");
const {
  evaluateHealth,
  normalizeBaseUrl
} = require("./doctor-cloud.js");
const {
  readExpectedRelease
} = require("./verify-cloud-production.js");
const {
  readSha256,
  sha256File,
  verifyHandoffFile,
  verifyTransferBundle
} = require("./print-cloud-release-handoff.js");

const root = path.resolve(__dirname, "..");

const objective = "实现前 7 个 Mia Cloud 产品化目标：统一账号同步、SQLite 持久化、安全基线、增强 Bridge、附件/图片流、实时同步、桌面端云同步，并且只用真实证据判定完成。";

function readText(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function exists(rootDir, relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function checkFile(rootDir, relativePath) {
  return {
    ok: exists(rootDir, relativePath),
    label: relativePath,
    evidence: relativePath
  };
}

function checkSource(rootDir, relativePath, pattern, label) {
  const filePath = path.join(rootDir, relativePath);
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  return {
    ok: pattern.test(source),
    label,
    evidence: `${relativePath} :: ${label}`
  };
}

function checkSourceAbsent(rootDir, relativePath, pattern, label) {
  const filePath = path.join(rootDir, relativePath);
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  return {
    ok: !pattern.test(source),
    label,
    evidence: `${relativePath} :: ${label}`
  };
}

function checkPackageScript(rootDir, name, expected) {
  const pkg = JSON.parse(readText(rootDir, "package.json"));
  const actual = pkg.scripts?.[name] || "";
  return {
    ok: expected ? actual === expected : Boolean(actual),
    label: `npm script ${name}`,
    evidence: `package.json scripts.${name}=${JSON.stringify(actual)}`
  };
}

function checkReleaseManifest(rootDir) {
  const manifestPath = path.join(rootDir, "dist", "mia-cloud-release", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, label: "release manifest", evidence: "dist/mia-cloud-release/manifest.json missing" };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    ok: Boolean(manifest.builtAt && manifest.source?.gitCommit && manifest.files?.["api/server.js"]),
    label: "release manifest",
    evidence: `dist/mia-cloud-release/manifest.json builtAt=${manifest.builtAt || "missing"} commit=${manifest.source?.gitCommit || "missing"}`
  };
}

function checkReleaseArchiveChecksum(rootDir) {
  const archivePath = path.join(rootDir, "dist", "mia-cloud-release.tgz");
  const sidecarPath = `${archivePath}.sha256`;
  if (!fs.existsSync(archivePath)) {
    return { ok: false, label: "release archive checksum", evidence: "dist/mia-cloud-release.tgz missing" };
  }
  if (!fs.existsSync(sidecarPath)) {
    return { ok: false, label: "release archive checksum", evidence: "dist/mia-cloud-release.tgz.sha256 missing" };
  }
  const expected = readSha256(sidecarPath).toLowerCase();
  const actual = sha256File(archivePath);
  return {
    ok: expected === actual,
    label: "release archive checksum",
    evidence: expected === actual
      ? `dist/mia-cloud-release.tgz sha256=${actual}`
      : `dist/mia-cloud-release.tgz.sha256=${expected}; actual=${actual}`
  };
}

function checkReleaseHandoffFresh(rootDir) {
  try {
    verifyHandoffFile({ distDir: path.join(rootDir, "dist") });
    return {
      ok: true,
      label: "release handoff freshness",
      evidence: "dist/mia-cloud-release-handoff.txt matches current release artifacts"
    };
  } catch (error) {
    return {
      ok: false,
      label: "release handoff freshness",
      evidence: error?.message || String(error)
    };
  }
}

function checkTransferBundleFresh(rootDir) {
  try {
    verifyTransferBundle({ outputPath: path.join(rootDir, "dist", "mia-cloud-release-transfer.tgz") });
    return {
      ok: true,
      label: "release transfer bundle freshness",
      evidence: "dist/mia-cloud-release-transfer.tgz and internal checksums verified"
    };
  } catch (error) {
    return {
      ok: false,
      label: "release transfer bundle freshness",
      evidence: error?.message || String(error)
    };
  }
}

function runCloudBridgeRequestSource(source) {
  return source.match(/async function runCloudBridgeRequest\(ws, message = \{\}\) \{[\s\S]*?\n\}/)?.[0] || "";
}

function extractAsarText(archivePath, filePath) {
  try {
    return String(asar.extractFile(archivePath, filePath));
  } catch {
    return "";
  }
}

function resolvePackagedAppAsar(rootDir) {
  const unpackedPath = path.join(rootDir, "release", "mac-arm64", "Mia.app", "Contents", "Resources", "app.asar");
  if (fs.existsSync(unpackedPath)) {
    return {
      archivePath: unpackedPath,
      label: "release/mac-arm64/Mia.app/Contents/Resources/app.asar",
      cleanup: () => {}
    };
  }

  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  const productName = pkg.productName || "Mia";
  const version = pkg.version || "0.0.0";
  const zipName = `${productName}-${version}-arm64-mac.zip`;
  const zipPath = path.join(rootDir, "release", zipName);
  if (!fs.existsSync(zipPath)) return null;

  try {
    const zip = new AdmZip(zipPath);
    const entryName = `${productName}.app/Contents/Resources/app.asar`;
    const entry = zip.getEntry(entryName);
    if (!entry) return null;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-asar-"));
    const archivePath = path.join(tempDir, "app.asar");
    fs.writeFileSync(archivePath, entry.getData());
    return {
      archivePath,
      label: `release/${zipName}::${entryName}`,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true })
    };
  } catch {
    return null;
  }
}

function checkPackagedDesktopPermissionGate(rootDir) {
  const packagedAsar = resolvePackagedAppAsar(rootDir);
  if (!packagedAsar) {
    return {
      ok: false,
      label: "packaged same-account bridge policy",
      evidence: "packaged app.asar missing from release/mac-arm64 or current mac zip"
    };
  }
  try {
    const mainSource = extractAsarText(packagedAsar.archivePath, "src/main.js");
    const bridgeClientSource = extractAsarText(packagedAsar.archivePath, "src/main/cloud/cloud-bridge-client.js");
    const bridgeSource = runCloudBridgeRequestSource(bridgeClientSource || mainSource);
    const hasBridgeEntrypoint = /startCloudBridge/.test(mainSource)
      && (/createCloudBridgeClient/.test(mainSource) || /async function runCloudBridgeRequest/.test(mainSource));
    const required = [
      /MIA_ALLOW_MULTIPLE_INSTANCES/.test(mainSource),
      /cloudWebSocketProtocols/.test(mainSource),
      hasBridgeEntrypoint,
      /permissionMode: "default"/.test(bridgeSource),
      !/confirmCloudBridgeRun\(/.test(bridgeSource),
      !/等待本机权限确认/.test(bridgeSource)
    ];
    return {
      ok: required.every(Boolean),
      label: "packaged same-account bridge policy",
      evidence: required.every(Boolean)
        ? `packaged Mia.app (${packagedAsar.label}) connects Cloud bridge with account-authenticated WebSocket and starts the local Agent without a separate remote-connection approval gate`
        : `packaged Mia.app (${packagedAsar.label}) is missing current same-account bridge auth/startup policy or still contains a local remote-connection approval gate`
    };
  } catch (error) {
    return {
      ok: false,
      label: "packaged same-account bridge policy",
      evidence: error?.message || String(error)
    };
  } finally {
    packagedAsar.cleanup();
  }
}

function expectedNativePermissionProofSourceHashes(rootDir) {
  const files = [
    "scripts/smoke-desktop-permission.js",
    "src/cloud/desktop-bridge-permission.js",
    "src/main.js"
  ];
  return Object.fromEntries(files.map((relativePath) => [
    relativePath,
    sha256File(path.join(rootDir, relativePath))
  ]));
}

function checkNativePermissionProof(rootDir) {
  const relativePath = "dist/mia-desktop-permission-manual-proof.json";
  const proofPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(proofPath)) {
    return {
      ok: false,
      label: "manual native permission proof",
      evidence: `${relativePath} missing`
    };
  }
  try {
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    const expectedHashes = expectedNativePermissionProofSourceHashes(rootDir);
    const hashMismatches = Object.entries(expectedHashes)
      .filter(([relative, expected]) => proof.sourceHashes?.[relative] !== expected)
      .map(([relative]) => relative);
    const checks = [
      proof.proofVersion === 1,
      proof.ok === true,
      proof.manual === true,
      proof.resultResponse === 1,
      proof.statusBeforeReject === "running",
      proof.statusAfterReject === "failed",
      proof.bridgeRunRejected === true,
      proof.title === "允许远程运行本机 Agent？",
      JSON.stringify(proof.buttons || []) === JSON.stringify(["允许本次运行", "拒绝"]),
      proof.defaultId === 1,
      proof.cancelId === 1,
      typeof proof.auditSha256 === "string" && /^[a-f0-9]{64}$/.test(proof.auditSha256),
      hashMismatches.length === 0
    ];
    return {
      ok: checks.every(Boolean),
      label: "manual native permission proof",
      evidence: checks.every(Boolean)
        ? `${relativePath} resultResponse=1 statusAfterReject=failed`
        : `${relativePath} invalid${hashMismatches.length ? `; stale source hashes: ${hashMismatches.join(", ")}` : ""}`
    };
  } catch (error) {
    return {
      ok: false,
      label: "manual native permission proof",
      evidence: error?.message || String(error)
    };
  }
}

function item(id, title, checks, options = {}) {
  const ok = checks.every((check) => check.ok);
  return {
    id,
    title,
    status: options.status || (ok ? "pass" : "fail"),
    checks,
    note: options.note || ""
  };
}

function runCommand(command, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal || "",
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    });
  });
}

async function livePublicProductionChecks({
  rootDir = root,
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn",
  timeoutMs = Number(process.env.MIA_AUDIT_TIMEOUT_MS || 10000),
  fetchImpl = fetch
} = {}) {
  const baseUrl = normalizeBaseUrl(publicUrl);
  const expected = readExpectedRelease({
    manifestPath: path.join(rootDir, "dist", "mia-cloud-release", "manifest.json")
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: { Origin: baseUrl },
      signal: controller.signal
    });
    const health = await response.json().catch(() => ({}));
    const checks = [
      {
        ok: response.ok,
        label: "live public health HTTP",
        evidence: `${baseUrl}/api/health HTTP ${response.status}`
      },
      ...evaluateHealth({
        health,
        responseHeaders: response.headers,
        baseUrl,
        expectedReleaseCommit: expected.gitCommit,
        expectedReleaseBuiltAt: expected.builtAt
      }).map((check) => ({
        ok: check.ok,
        label: `live public ${check.name}`,
        evidence: check.detail || check.name
      }))
    ];
    return checks;
  } catch (error) {
    return [{
      ok: false,
      label: "live public production check",
      evidence: error?.message || String(error)
    }];
  } finally {
    clearTimeout(timer);
  }
}

async function liveSshDeployChecks({
  deployRemote = process.env.MIA_DEPLOY_REMOTE || "root@mia.gifgif.cn",
  timeoutMs = Number(process.env.MIA_AUDIT_TIMEOUT_MS || 10000),
  runCommandImpl = runCommand
} = {}) {
  if (!deployRemote) {
    return [{
      ok: false,
      label: "live ssh deploy access",
      evidence: "MIA_DEPLOY_REMOTE is empty"
    }];
  }
  const result = await runCommandImpl("ssh", [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    deployRemote,
    "true"
  ], { timeoutMs });
  return [{
    ok: Boolean(result.ok),
    label: "live ssh deploy access",
    evidence: result.ok
      ? deployRemote
      : (result.stderr || result.stdout || `exit ${result.code}${result.signal ? ` signal ${result.signal}` : ""}`)
  }];
}

function runAudit({ rootDir = root } = {}) {
  const requirements = [
    item("cloud.unified-account-data", "统一账号数据按 userId 隔离", [
      checkFile(rootDir, "src/cloud/sqlite-store.js"),
      checkSource(rootDir, "src/cloud/sqlite-store.js", /users[\s\S]*sessions[\s\S]*files[\s\S]*bridge_devices[\s\S]*bridge_runs[\s\S]*conversations[\s\S]*messages[\s\S]*bots[\s\S]*user_settings/, "SQLite tables cover users/sessions/files/devices/runs/conversations/messages/bots/user_settings"),
      checkSource(rootDir, "src/cloud/sqlite-store.js", /WHERE user_id = \?/g, "queries scope data by user_id"),
      checkFile(rootDir, "tests/cloud-sqlite-store.test.js"),
      checkSource(rootDir, "tests/bots-store.test.js", /listBots scopes to owner/, "cross-account bot scoping regression")
    ]),
    item("cloud.durable-sqlite", "SQLite 持久化、迁移和 legacy JSON bootstrap", [
      checkSource(rootDir, "src/cloud/sqlite-store.js", /DatabaseSync.*node:sqlite|node:sqlite[\s\S]*DatabaseSync/, "uses node:sqlite DatabaseSync"),
      checkSource(rootDir, "src/cloud/sqlite-store.js", /schema_migrations/, "schema migrations table"),
      checkSource(rootDir, "src/cloud/sqlite-store.js", /importLegacyJsonIfNeeded/, "legacy JSON bootstrap"),
      checkSource(rootDir, "tests/event-log-store.test.js", /event_seq cache stays in lock-step/, "event log monotonic seq persistence")
    ]),
    item("cloud.security-baseline", "安全基线：scrypt、会话哈希、所有权、限流、Origin/CORS/security headers", [
      checkSource(rootDir, "src/cloud/sqlite-store.js", /scryptSync/, "scrypt password hashing"),
      checkSource(rootDir, "src/cloud/sqlite-store.js", /token_hash/, "hashed session tokens"),
      checkSource(rootDir, "src/cloud/sqlite-store.js", /loginFailures|rateLimitKey/, "login failure rate limiting"),
      checkSource(rootDir, "scripts/serve-cloud.js", /authenticated-files|applySecurityHeaders|MIA_CLOUD_ALLOWED_ORIGINS|isOriginAllowed/, "auth files and browser-origin controls"),
      checkSource(rootDir, "tests/serve-cloud-bridge.test.js", /cloud files require owner authentication/, "file ownership API test"),
      checkSource(rootDir, "tests/serve-cloud-bridge.test.js", /websocket auth rejects query token auth by default/, "query-token rejection test")
    ]),
    item("cloud.bridge-product", "Bridge 产品行为：能力、设备选择、生命周期、进度、取消、附件", [
      checkSource(rootDir, "scripts/serve-cloud.js", /bridge-run-lifecycle[\s\S]*bridge-run-cancel[\s\S]*bridge-run-progress/, "health features advertise bridge lifecycle/cancel/progress"),
      checkSource(rootDir, "scripts/serve-cloud.js", /createBridgeRun[\s\S]*startBridgeRun[\s\S]*completeBridgeRun/, "server persists run lifecycle"),
      checkSource(rootDir, "tests/serve-cloud-bridge.test.js", /explicitly selected online device|auto-selects the only online device|requires explicit device selection/, "multi-device dispatch tests"),
      checkSource(rootDir, "tests/serve-cloud-bridge.test.js", /can cancel a pending bridge run|timed_out/, "cancel and timeout tests"),
      checkSource(rootDir, "scripts/local-agent-bridge.js", /generatedImages|materializeAttachments|run_result/, "standalone bridge handles attachments and generated images")
    ]),
    item("cloud.attachments", "附件/生成图片作为 Cloud 文件处理且不泄漏本地路径", [
      checkSource(rootDir, "scripts/serve-cloud.js", /saveImageDataUrl|persistCloudAttachments/, "server persists and sanitizes attachment metadata"),
      checkSource(rootDir, "tests/serve-cloud-bridge.test.js", /accepts image uploads at the documented eighteen megabyte limit|active-content image uploads/, "image upload + SVG rejection regressions")
    ]),
    item("cloud.realtime-sync", "按用户隔离的实时同步", [
      checkSource(rootDir, "scripts/serve-cloud.js", /\/api\/events|broadcastPersistedEvent|broadcastTransientEvent|conversation.message_appended|user_settings.updated/, "event websocket + persisted event types"),
      checkSource(rootDir, "src/web/app.js", /startCloudEvents[\s\S]*conversation\.message_appended/, "web consumes realtime events"),
      checkSource(rootDir, "src/main.js", /startCloudEvents/, "desktop consumes cloud events"),
      checkSource(rootDir, "tests/sync-replay.test.js", /reconnect with since_seq replays/, "since_seq replay test guards offline drop")
    ]),
    item("cloud.desktop-sync", "桌面端同账号云同步和 Bridge 自动接入", [
      checkSource(rootDir, "src/main.js", /cloudLogin|syncMiaCloudWorkspace|startCloudBridge/, "desktop login/sync/bridge IPC path"),
      checkSource(rootDir, "src/main/cloud/desktop-sync-client.js", /pushAllBots[\s\S]*ensureBotConversation/, "desktop sync ensures stable bot cloud conversations"),
      checkSource(rootDir, "tests/main-cloud-desktop-sync-client.test.js", /syncWorkspace syncs bot identity and stable conversations without reading local sessions/, "desktop sync no longer backfills local sessions on login"),
      checkSource(rootDir, "src/preload.js", /cloudStatus[\s\S]*cloudLogin[\s\S]*cloudSync|cloudLogin[\s\S]*cloudSync[\s\S]*cloudLogout/, "preload exposes cloud account actions"),
      checkSource(rootDir, "src/renderer/app.js", /sendInActiveConversation\(conversationText\b[\s\S]*?return;/, "renderer sends active cloud conversations through the unified social path"),
      checkSourceAbsent(rootDir, "src/renderer/app.js", /pushCloudMessageQuietly|cloudPushMessage/, "renderer does not mirror local sends through legacy cloud push"),
      checkSourceAbsent(rootDir, "src/preload.js", /cloudPushMessage/, "preload omits legacy cloud push bridge"),
      checkSourceAbsent(rootDir, "src/shared/ipc-channels.js", /CloudPushMessage/, "shared IPC omits legacy cloud push channel"),
      checkSource(rootDir, "tests/bot-conversations.test.js", /Bot-conversation messages POST works through the unified/, "bot chat conversation integration test")
    ]),
    item("gate.same-account-bridge-control", "同账号 Web/手机端可直接调用桌面 Agent，设备鉴权不复用 Agent permission", [
      checkSource(rootDir, "src/main/cloud/cloud-bridge-client.js", /async function runCloudBridgeRequest[\s\S]*permissionMode: "default"/, "desktop bridge keeps Agent permissionMode on the Agent run"),
      checkSource(rootDir, "src/main/cloud/cloud-bridge-client.js", /async function runCloudBridgeRequest(?![\s\S]*?confirmCloudBridgeRun\()/, "desktop bridge run source does not call local approval gate"),
      checkSource(rootDir, "src/main.js", /cloudWebSocketProtocols[\s\S]*mia-token\./, "desktop bridge authenticates to Cloud with account token subprotocol"),
      checkSource(rootDir, "scripts/serve-cloud.js", /devicesByUser[\s\S]*hub\.devicesByUser\.get\(userId\)/, "cloud bridge devices are scoped by authenticated userId"),
      checkSource(rootDir, "tests/project-structure-check.test.js", /does not add a separate local approval gate/, "regression test forbids remote-connection approval gate in bridge run"),
      checkSource(rootDir, "tests/serve-cloud-bridge.test.js", /auto-selects the only online device|runs on the explicitly selected online device|requires explicit device selection/, "same-account bridge dispatch tests")
    ]),
    item("cloud.release-package", "可部署 release 包、doctor/smoke/handoff/transfer bundle", [
      checkPackageScript(rootDir, "cloud:release", "node scripts/build-cloud-release.js"),
      checkPackageScript(rootDir, "cloud:deploy:dry-run", "MIA_DEPLOY_DRY_RUN=1 bash scripts/deploy-cloud-release.sh"),
      checkPackageScript(rootDir, "cloud:deploy:ssh-diagnose", "node scripts/diagnose-deploy-ssh.js"),
      checkPackageScript(rootDir, "cloud:blockers", "node scripts/print-cloud-blockers.js"),
      checkPackageScript(rootDir, "cloud:audit", "node scripts/audit-cloud-productization.js --live"),
      checkPackageScript(rootDir, "cloud:prod:verify", "node scripts/verify-cloud-production.js"),
      checkPackageScript(rootDir, "cloud:prod:verify:e2e", "MIA_SMOKE_REQUIRE_BRIDGE=1 node scripts/verify-cloud-production.js"),
      checkReleaseManifest(rootDir),
      checkReleaseArchiveChecksum(rootDir),
      checkReleaseHandoffFresh(rootDir),
      checkTransferBundleFresh(rootDir),
      checkPackagedDesktopPermissionGate(rootDir),
      checkSource(rootDir, "scripts/build-cloud-release.js", /README\.md[\s\S]*install-cloud-release-local\.sh[\s\S]*doctor-cloud\.js[\s\S]*smoke-cloud\.js[\s\S]*diagnose-deploy-ssh\.js/, "release package includes operator assets"),
      checkSource(rootDir, "dist/mia-cloud-release/README.md", /same Mia Cloud account[\s\S]*does not require a separate local approval click[\s\S]*Agent permission mode remains/, "release README documents same-account bridge without remote approval gate"),
      checkSource(rootDir, "scripts/print-cloud-release-handoff.js", /same Mia Cloud account[\s\S]*does not require a separate local approval click[\s\S]*Agent permission mode remains/, "transfer bundle documents same-account bridge without remote approval gate"),
      checkSource(rootDir, "scripts/print-cloud-release-handoff.js", /readSshAgentStatus[\s\S]*ssh-add/, "handoff reports ssh-agent status and ssh-add recovery"),
      checkSource(rootDir, "scripts/print-cloud-release-handoff.js", /sshServerDiagnosticsCommand[\s\S]*authorized_keys[\s\S]*sshd -T/, "handoff includes VPS-side SSH diagnostics")
    ]),
    item("gate.production-deploy", "生产部署和公网 smoke", [
      checkPackageScript(rootDir, "cloud:deploy", "bash scripts/deploy-cloud-release.sh"),
      checkPackageScript(rootDir, "cloud:prod:verify", "node scripts/verify-cloud-production.js"),
      checkSource(rootDir, "docs/DEPLOYMENT.md", /npm run cloud:prod:verify -- https:\/\/mia\.gifgif\.cn/, "deployment docs record the production verification gate")
    ], {
      status: "blocked",
      note: "需要 SSH 授权并让 `npm run cloud:prod:verify -- https://mia.gifgif.cn` 真实通过；失败原因以 doctor/verify 输出为准。"
    }),
  ];

  const counts = requirements.reduce((acc, requirement) => {
    acc[requirement.status] = (acc[requirement.status] || 0) + 1;
    return acc;
  }, {});
  return {
    objective,
    requirements,
    counts,
    complete: !requirements.some((requirement) => requirement.status !== "pass")
  };
}

function recomputeAudit(audit) {
  audit.counts = audit.requirements.reduce((acc, requirement) => {
    acc[requirement.status] = (acc[requirement.status] || 0) + 1;
    return acc;
  }, {});
  audit.complete = !audit.requirements.some((requirement) => requirement.status !== "pass");
  return audit;
}

async function runAuditLive(options = {}) {
  const audit = runAudit(options);
  const production = audit.requirements.find((requirement) => requirement.id === "gate.production-deploy");
  if (production) {
    const liveChecks = [
      ...(await livePublicProductionChecks(options)),
      ...(await liveSshDeployChecks(options))
    ];
    production.checks = [
      ...production.checks.filter((check) => !/latest plan records production blocker evidence/.test(check.label)),
      ...liveChecks
    ];
    const liveOk = liveChecks.length > 0 && liveChecks.every((check) => check.ok);
    production.status = liveOk ? "pass" : "blocked";
    production.note = liveOk
      ? "公网 Cloud 已匹配当前 release，且这台机器具备 SSH 部署通道；bridge-required e2e 可按需用固定烟测账号复核。"
      : "公网 Cloud 或 SSH 部署通道仍未通过当前 release 的 live production audit。运行 `npm run cloud:prod:verify -- https://mia.gifgif.cn` 和 `npm run cloud:deploy` 查看完整失败。";
  }
  return recomputeAudit(audit);
}

function renderAudit(audit) {
  const lines = [
    "Mia Cloud productization audit",
    "",
    `Objective: ${audit.objective}`,
    ""
  ];
  for (const requirement of audit.requirements) {
    lines.push(`[${requirement.status.toUpperCase()}] ${requirement.id} - ${requirement.title}`);
    if (requirement.note) lines.push(`  note: ${requirement.note}`);
    for (const check of requirement.checks) {
      lines.push(`  ${check.ok ? "OK" : "FAIL"} ${check.label} (${check.evidence})`);
    }
    lines.push("");
  }
  lines.push(`Summary: pass=${audit.counts.pass || 0} blocked=${audit.counts.blocked || 0} fail=${audit.counts.fail || 0}`);
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const allowBlocked = argv.includes("--allow-blocked");
  const json = argv.includes("--json");
  const live = argv.includes("--live");
  const audit = live ? await runAuditLive({ rootDir: root }) : runAudit({ rootDir: root });
  if (json) console.log(JSON.stringify(audit, null, 2));
  else console.log(renderAudit(audit));
  if (!audit.complete && !allowBlocked) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  checkNativePermissionProof,
  checkReleaseArchiveChecksum,
  checkPackagedDesktopPermissionGate,
  livePublicProductionChecks,
  liveSshDeployChecks,
  renderAudit,
  runAudit,
  runAuditLive
};
