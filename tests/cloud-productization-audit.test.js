const assert = require("node:assert/strict");
const AdmZip = require("adm-zip");
const asar = require("@electron/asar");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  checkNativePermissionProof,
  checkPackagedDesktopPermissionGate,
  checkProductionDeployProof,
  checkReleaseArchiveChecksum,
  livePublicProductionChecks,
  liveSshDeployChecks,
  renderAudit,
  runAudit,
  runAuditLive
} = require("../scripts/audit-cloud-productization.js");

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("cloud productization audit maps the seven local goals and remaining gates", () => {
  const audit = runAudit();
  const byId = new Map(audit.requirements.map((item) => [item.id, item]));
  for (const id of [
    "cloud.unified-account-data",
    "cloud.durable-sqlite",
    "cloud.security-baseline",
    "cloud.bridge-product",
    "cloud.attachments",
    "cloud.realtime-sync",
    "cloud.desktop-sync",
    "gate.same-account-bridge-control",
    "cloud.release-package"
  ]) {
    assert.equal(byId.get(id)?.status, "pass", id);
    assert.ok(byId.get(id).checks.every((check) => check.ok), id);
  }
  assert.equal(byId.get("gate.production-deploy")?.status, "blocked");
  assert.equal(byId.has("gate.native-permission-click"), false);
  assert.equal(audit.complete, false);
});

test("cloud productization audit verifies current release artifact freshness", () => {
  const release = runAudit().requirements.find((item) => item.id === "cloud.release-package");
  assert.equal(release.status, "pass");
  for (const label of [
    "npm script cloud:audit",
    "npm script cloud:site-verify",
    "release archive checksum",
    "release handoff freshness",
    "release transfer bundle freshness",
    "packaged same-account bridge policy",
    "release README documents same-account bridge without remote approval gate",
    "transfer bundle documents same-account bridge without remote approval gate",
    "handoff reports ssh-agent status and ssh-add recovery",
    "handoff includes VPS-side SSH diagnostics"
  ]) {
    const check = release.checks.find((candidate) => candidate.label === label);
    assert.equal(check?.ok, true, `${label}: ${check?.evidence || "missing"}`);
  }
});

test("packaged desktop audit verifies the current same-account bridge policy is bundled", () => {
  const check = checkPackagedDesktopPermissionGate(path.join(__dirname, ".."));
  assert.equal(check.ok, true, check.evidence);
  assert.equal(check.label, "packaged same-account bridge policy");
  assert.match(check.evidence, /without a separate remote-connection approval gate/);
});

test("packaged desktop audit can read the final mac zip without requiring unpacked dir output", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-zip-audit-"));
  try {
    const sourceDir = path.join(tempDir, "asar-source");
    const asarPath = path.join(tempDir, "app.asar");
    fs.mkdirSync(path.join(sourceDir, "src/main/cloud"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ productName: "Mia", version: "9.9.9" }));
    fs.writeFileSync(path.join(sourceDir, "src/main.js"), [
      "const MIA_ALLOW_MULTIPLE_INSTANCES = true;",
      "const cloudBridgeRuntime = createCloudBridgeClient({",
      "  startCloudBridgeRequest: (payload = {}) => forwardMiaCoreHttpRequest({ route: \"/api/cloud/bridge/start\", body: payload }),",
      "  stopCloudBridgeRequest: () => forwardMiaCoreHttpRequest({ route: \"/api/cloud/bridge/stop\" })",
      "});",
      "function startCloudBridge() { return cloudBridgeRuntime.start(); }",
      "function createCloudBridgeClient() { return {}; }",
    ].join("\n"));
    fs.writeFileSync(path.join(sourceDir, "src/main/cloud/cloud-bridge-client.js"), [
      "function createCloudBridgeClient({ startCloudBridgeRequest, stopCloudBridgeRequest }) {",
      "  function start() { return startCloudBridgeRequest({}); }",
      "  function stop() { return stopCloudBridgeRequest({}); }",
      "  return { start, stop };",
      "}",
    ].join("\n"));
    await asar.createPackage(sourceDir, asarPath);

    const releaseDir = path.join(tempDir, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    const zip = new AdmZip();
    zip.addLocalFile(asarPath, "Mia.app/Contents/Resources");
    zip.writeZip(path.join(releaseDir, "Mia-9.9.9-arm64-mac.zip"));

    const check = checkPackagedDesktopPermissionGate(tempDir);
    assert.equal(check.ok, true, check.evidence);
    assert.match(check.evidence, /Mia-9\.9\.9-arm64-mac\.zip/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("release archive checksum audit rejects stale sidecars", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-audit-release-"));
  try {
    const distDir = path.join(tempDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "mia-cloud-release.tgz"), "archive");
    fs.writeFileSync(path.join(distDir, "mia-cloud-release.tgz.sha256"), `${"0".repeat(64)}  mia-cloud-release.tgz\n`);
    const check = checkReleaseArchiveChecksum(tempDir);
    assert.equal(check.ok, false);
    assert.equal(check.label, "release archive checksum");
    assert.match(check.evidence, /actual=/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production deploy proof must match the current release archive and public URL", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-deploy-proof-"));
  try {
    const distDir = path.join(tempDir, "dist");
    const releaseDir = path.join(distDir, "mia-cloud-release");
    fs.mkdirSync(releaseDir, { recursive: true });
    const archivePath = path.join(distDir, "mia-cloud-release.tgz");
    const archiveContents = "archive";
    fs.writeFileSync(archivePath, archiveContents);
    fs.writeFileSync(path.join(releaseDir, "manifest.json"), JSON.stringify({
      builtAt: "2026-06-10T00:00:00.000Z",
      source: {
        gitCommit: "abc123",
        dirty: true
      }
    }));
    const proofPath = path.join(distDir, "mia-cloud-production-deploy-proof.json");
    fs.writeFileSync(proofPath, JSON.stringify({
      proofVersion: 1,
      ok: true,
      deployMethod: "jumpserver-root-shell",
      publicUrl: "https://mia.gifgif.cn",
      completedAt: "2026-06-10T03:05:01Z",
      release: {
        gitCommit: "abc123",
        builtAt: "2026-06-10T00:00:00.000Z"
      },
      archiveSha256: sha256Text(archiveContents),
      installerExitCode: 0,
      verified: {
        doctor: true,
        smoke: true,
        siteVerification: true
      }
    }, null, 2));

    const valid = checkProductionDeployProof({
      rootDir: tempDir,
      publicUrl: "https://mia.gifgif.cn"
    });
    assert.equal(valid.ok, true, valid.evidence);

    const stale = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    stale.release.gitCommit = "stale";
    fs.writeFileSync(proofPath, JSON.stringify(stale, null, 2));
    const invalid = checkProductionDeployProof({
      rootDir: tempDir,
      publicUrl: "https://mia.gifgif.cn"
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.evidence, /release\.gitCommit/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cloud productization audit rendering is explicit about blockers", () => {
  const output = renderAudit(runAudit());
  assert.match(output, /Objective:/);
  assert.match(output, /\[PASS\] cloud\.unified-account-data/);
  assert.match(output, /\[PASS\] gate\.same-account-bridge-control/);
  assert.match(output, /\[BLOCKED\] gate\.production-deploy/);
  assert.doesNotMatch(output, /gate\.native-permission-click/);
  assert.match(output, /cloud:prod:verify/);
  assert.match(output, /same-account bridge/);
  assert.match(output, /does not call local approval gate/);
});

test("native permission proof audit requires a real reject result and current source hashes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-proof-"));
  try {
    const sourceFiles = {
      "scripts/smoke-desktop-permission.js": "smoke",
      "src/cloud/desktop-bridge-permission.js": "permission",
      "src/main.js": "main"
    };
    for (const [relativePath, contents] of Object.entries(sourceFiles)) {
      const filePath = path.join(tempDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    }

    const missing = checkNativePermissionProof(tempDir);
    assert.equal(missing.ok, false);
    assert.match(missing.evidence, /missing/);

    const proofPath = path.join(tempDir, "dist", "mia-desktop-permission-manual-proof.json");
    fs.mkdirSync(path.dirname(proofPath), { recursive: true });
    fs.writeFileSync(proofPath, JSON.stringify({
      proofVersion: 1,
      ok: true,
      manual: true,
      resultResponse: 1,
      statusBeforeReject: "running",
      statusAfterReject: "failed",
      bridgeRunRejected: true,
      title: "允许远程运行本机 Agent？",
      buttons: ["允许本次运行", "拒绝"],
      defaultId: 1,
      cancelId: 1,
      auditSha256: "a".repeat(64),
      sourceHashes: Object.fromEntries(Object.entries(sourceFiles).map(([relativePath, contents]) => [
        relativePath,
        sha256Text(contents)
      ]))
    }, null, 2));
    const valid = checkNativePermissionProof(tempDir);
    assert.equal(valid.ok, true, valid.evidence);
    assert.match(valid.evidence, /resultResponse=1 statusAfterReject=failed/);

    fs.writeFileSync(path.join(tempDir, "src/main.js"), "changed");
    const stale = checkNativePermissionProof(tempDir);
    assert.equal(stale.ok, false);
    assert.match(stale.evidence, /stale source hashes: src\/main\.js/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cloud productization audit CLI fails closed unless blocked gates are explicitly allowed", () => {
  const script = path.join(__dirname, "..", "scripts", "audit-cloud-productization.js");
  const blocked = childProcess.spawnSync(process.execPath, [script], {
    encoding: "utf8"
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /Summary: pass=9 blocked=1 fail=0/);

  const allowed = childProcess.spawnSync(process.execPath, [script, "--allow-blocked"], {
    encoding: "utf8"
  });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /Summary: pass=9 blocked=1 fail=0/);
});

test("live cloud productization audit uses public health instead of plan text", async () => {
  const audit = await runAuditLive({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ features: ["authenticated-files"] })
    }),
    runCommandImpl: async () => ({
      ok: false,
      code: 255,
      stderr: "Permission denied (publickey,password)."
    })
  });
  const production = audit.requirements.find((item) => item.id === "gate.production-deploy");
  assert.equal(production.status, "blocked");
  assert.ok(production.checks.some((check) => check.label === "live public health features" && !check.ok));
  assert.ok(production.checks.some((check) => check.label === "live public release provenance" && !check.ok));
  assert.ok(production.checks.some((check) => check.label === "live deploy proof"));
  assert.equal(audit.complete, false);
});

test("live public production checks pass for current release health and headers", async () => {
  const release = require("../dist/mia-cloud-release/manifest.json");
  const features = [
    "sqlite-store",
    "authenticated-files",
    "events-websocket",
    "bridge-websocket-subprotocol-token",
    "bridge-run-lifecycle",
    "bridge-run-cancel",
    "bridge-run-progress",
    "desktop-sync"
  ];
  const checks = await livePublicProductionChecks({
    publicUrl: "https://mia.gifgif.cn",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "access-control-allow-origin": "https://mia.gifgif.cn",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "strict-transport-security": "max-age=31536000"
      }),
      json: async () => ({
        features,
        release: {
          gitCommit: release.source.gitCommit,
          builtAt: release.builtAt
        }
      })
    })
  });
  assert.ok(checks.every((check) => check.ok), checks.map((check) => `${check.label}:${check.evidence}`).join("\n"));
});

test("live ssh deploy check reports denied deploy access", async () => {
  const calls = [];
  const checks = await liveSshDeployChecks({
    deployRemote: "deploy@example.com",
    timeoutMs: 2500,
    runCommandImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        ok: false,
        code: 255,
        stderr: "Permission denied (publickey)."
      };
    }
  });
  assert.deepEqual(checks, [{
    ok: false,
    label: "live ssh deploy access",
    evidence: "Permission denied (publickey)."
  }]);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "deploy@example.com",
    "true"
  ]);
});

test("live audit passes production gate when public release and deploy evidence pass", async () => {
  const release = require("../dist/mia-cloud-release/manifest.json");
  const features = [
    "sqlite-store",
    "authenticated-files",
    "events-websocket",
    "bridge-websocket-subprotocol-token",
    "bridge-run-lifecycle",
    "bridge-run-cancel",
    "bridge-run-progress",
    "desktop-sync"
  ];
  const audit = await runAuditLive({
    publicUrl: "https://mia.gifgif.cn",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "access-control-allow-origin": "https://mia.gifgif.cn",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "strict-transport-security": "max-age=31536000"
      }),
      json: async () => ({
        features,
        release: {
          gitCommit: release.source.gitCommit,
          builtAt: release.builtAt
        }
      })
    }),
    runCommandImpl: async () => ({ ok: true })
  });
  const production = audit.requirements.find((item) => item.id === "gate.production-deploy");
  assert.equal(production.status, "pass");
  assert.ok(production.checks.some((check) => (
    (check.label === "live deploy proof" || check.label === "live ssh deploy access") && check.ok
  )));
  assert.equal(audit.complete, true);
});
