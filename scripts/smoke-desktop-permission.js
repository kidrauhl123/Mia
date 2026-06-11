#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMiaCloudServer } = require("./serve-cloud.js");

const root = path.resolve(__dirname, "..");
const promptText = process.env.MIA_PERMISSION_SMOKE_PROMPT || "permission-dialog-audit-smoke-do-not-run-codex";

function usage() {
  return [
    "Usage: node scripts/smoke-desktop-permission.js",
    "",
    "Starts a temporary Mia Cloud and isolated Electron desktop, triggers one",
    "Cloud bridge run in Ask mode, verifies the permission dialog audit record,",
    "then cancels the run and cleans up.",
    "",
    "Environment:",
    "  ELECTRON=<path>                         Optional Electron binary override.",
    "  MIA_PERMISSION_SMOKE_MANUAL=1      Wait for a real manual Reject click instead of auto-cancelling.",
    "  MIA_PERMISSION_SMOKE_PROOF_FILE=<path>",
    "  MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS=1500",
    "  MIA_PERMISSION_SMOKE_TIMEOUT_MS=30000 (auto) / 240000 (manual)",
    "  MIA_ALLOW_MULTIPLE_INSTANCES=1      Set automatically for isolated desktop smoke."
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function jsonRequest(baseUrl, pathSegment, { token = "", method = "GET", body = null, signal = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathSegment}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: signal || undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathSegment} failed: ${response.status} ${data.error || ""}`.trim());
  return data;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function permissionProofSourceHashes(rootDir = root) {
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

function permissionSmokeProofFile(env = process.env, rootDir = root) {
  return env.MIA_PERMISSION_SMOKE_PROOF_FILE || path.join(rootDir, "dist", "mia-desktop-permission-manual-proof.json");
}

function electronBinary() {
  if (process.env.ELECTRON) return process.env.ELECTRON;
  const resolved = require("electron");
  if (typeof resolved !== "string") throw new Error("Could not resolve Electron binary.");
  return resolved;
}

function electronAppBundlePath(binaryPath = electronBinary()) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const index = String(binaryPath || "").indexOf(marker);
  if (index < 0) return "";
  const bundlePath = binaryPath.slice(0, index);
  return bundlePath.endsWith(".app") ? bundlePath : "";
}

function activateManualSmokeApp({
  manualMode = false,
  platform = process.platform,
  binaryPath = electronBinary(),
  execFileSync = childProcess.execFileSync
} = {}) {
  if (!manualMode || platform !== "darwin") return false;
  const bundlePath = electronAppBundlePath(binaryPath);
  if (!bundlePath) return false;
  try {
    execFileSync("open", ["-a", bundlePath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(child, tmpRoot) {
  if (!child || !child.pid) return;
  try {
    if (child.kill) child.kill("SIGTERM");
  } catch {
    // continue cleanup below
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // process group may not exist on every platform
  }
  if (tmpRoot && process.platform === "darwin") {
    try {
      childProcess.execFileSync("pkill", ["-f", tmpRoot], { stdio: "ignore" });
    } catch {
      // no matching processes
    }
  }
}

function parseAudit(filePath) {
  const lines = fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const show = lines.find((line) => line.event === "show");
  if (!show) throw new Error("Permission audit did not contain a show event.");
  const options = show.options || {};
  if (options.title !== "允许远程运行本机 Agent？") throw new Error(`Unexpected dialog title: ${options.title || "missing"}`);
  if (JSON.stringify(options.buttons || []) !== JSON.stringify(["允许本次运行", "拒绝"])) {
    throw new Error(`Unexpected dialog buttons: ${JSON.stringify(options.buttons || [])}`);
  }
  if (options.defaultId !== 1 || options.cancelId !== 1) {
    throw new Error(`Unexpected dialog default/cancel ids: ${options.defaultId}/${options.cancelId}`);
  }
  const detail = String(options.detail || "");
  if (!detail.includes("来源：Mia Cloud")) throw new Error("Permission audit is missing source detail.");
  if (!detail.includes("附件：1 个")) throw new Error("Permission audit is missing attachment count.");
  if (!detail.includes(promptText)) throw new Error("Permission audit is missing the smoke prompt.");
  const result = [...lines].reverse().find((line) => line.event === "result") || null;
  return { lines, show, result };
}

async function pollForDevice(baseUrl, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await jsonRequest(baseUrl, "/api/bridge/devices", { token });
    const device = Array.isArray(data.devices) ? data.devices[0] : null;
    if (device?.id) return device;
    await sleep(250);
  }
  throw new Error("Timed out waiting for desktop bridge device.");
}

async function pollForAudit(auditFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(auditFile) && fs.statSync(auditFile).size > 0) return parseAudit(auditFile);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for permission audit: ${auditFile}`);
}

async function pollForAuditResult(auditFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(auditFile) && fs.statSync(auditFile).size > 0) {
      const audit = parseAudit(auditFile);
      if (audit.result) return audit;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for permission dialog result: ${auditFile}`);
}

function isManualPermissionSmoke(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.MIA_PERMISSION_SMOKE_MANUAL || "").trim());
}

function manualSmokeWindowSettleMs(env = process.env) {
  const raw = env.MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS;
  if (raw == null || raw === "") return 1500;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1500;
}

function permissionSmokeTimeoutMs(env = process.env) {
  const manualMode = isManualPermissionSmoke(env);
  const fallback = manualMode ? 240000 : 30000;
  const raw = env.MIA_PERMISSION_SMOKE_TIMEOUT_MS;
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const manualMode = isManualPermissionSmoke(process.env);
  const timeoutMs = permissionSmokeTimeoutMs(process.env);
  const settleMs = manualSmokeWindowSettleMs(process.env);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-desktop-permission-"));
  const dataDir = path.join(tmpRoot, "cloud-data");
  const desktopRoot = path.join(tmpRoot, "desktop");
  const auditFile = path.join(tmpRoot, "dialog-audit.jsonl");
  const electronLog = path.join(tmpRoot, "electron.log");
  const server = createMiaCloudServer({ dataDir });
  let electron = null;
  let runController = null;

  async function cleanup() {
    if (runController) runController.abort();
    killProcessTree(electron, tmpRoot);
    await closeServer(server).catch(() => {});
  }

  process.once("SIGINT", () => {
    cleanup().finally(() => process.exit(130));
  });

  try {
    const baseUrl = await listen(server);
    const account = server.mia.cloudStore.loginWithWechat({
      openid: `desktop-permission-smoke-${Date.now()}`,
      nickname: "Desktop Permission Smoke"
    });
    const home = path.join(desktopRoot, "runtime", "engine-home");
    writeJson(path.join(home, "mia-cloud.json"), {
      enabled: true,
      url: baseUrl,
      token: account.token,
      user: account.user
    });
    writeJson(path.join(home, "mia-permissions.json"), { mode: "ask" });
    writeJson(path.join(home, "mia-daemon.json"), { enabled: false, host: "127.0.0.1", port: 27861 });

    const logFd = fs.openSync(electronLog, "w");
    electron = childProcess.spawn(electronBinary(), [root], {
      cwd: root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        MIA_USER_DATA_DIR: desktopRoot,
        MIA_CLOUD_URL: baseUrl,
        MIA_ALLOW_MULTIPLE_INSTANCES: "1",
        MIA_DISABLE_BACKGROUND_STARTUP: "1",
        MIA_PERMISSION_DIALOG_AUDIT_FILE: auditFile
      }
    });
    electron.unref();

    const device = await pollForDevice(baseUrl, account.token, timeoutMs);
    const preRunActivated = activateManualSmokeApp({ manualMode });
    if (manualMode && settleMs > 0) await sleep(settleMs);
    runController = new AbortController();
    const runPromise = jsonRequest(baseUrl, "/api/bridge/run", {
      token: account.token,
      method: "POST",
      signal: runController.signal,
      body: {
        deviceId: device.id,
        conversationId: "conv_mia",
        text: promptText,
        attachments: [{
          id: "smoke_attachment",
          type: "image",
          name: "smoke.png",
          url: "https://example.com/smoke.png"
        }]
      }
    })
      .then((data) => ({ ok: true, data }))
      .catch((error) => ({
        ok: false,
        aborted: runController.signal.aborted,
        error
      }));

    const audit = await pollForAudit(auditFile, timeoutMs);
    const runs = await jsonRequest(baseUrl, "/api/bridge/runs", { token: account.token });
    const run = Array.isArray(runs.runs) ? runs.runs[0] : null;
    if (!run?.id) throw new Error("Cloud did not persist the bridge run.");
    if (run.status !== "running") throw new Error(`Bridge run was not waiting at the permission gate: ${run.status}`);

    if (manualMode) {
      const activated = activateManualSmokeApp({ manualMode });
      console.error([
        "Manual permission smoke is waiting for the native dialog.",
        "Click `拒绝` to verify the safe default without running Codex.",
        `Cloud: ${baseUrl}`,
        `Audit: ${auditFile}`,
        `Run: ${run.id}`,
        `Pre-run Electron activation: ${preRunActivated ? "yes" : "no"}`,
        `Pre-run settle: ${settleMs}ms`,
        `Brought Electron to front: ${activated ? "yes" : "no"}`
      ].join("\n"));
      const finalAudit = await pollForAuditResult(auditFile, timeoutMs);
      if (finalAudit.result.response !== 1) {
        throw new Error(`Manual permission smoke expected the Reject button response 1, got ${finalAudit.result.response}.`);
      }
      const finalResult = await runPromise;
      if (finalResult.ok) {
        throw new Error("Manual permission smoke expected the bridge run to be rejected, but it completed successfully.");
      }
      const finalRuns = await jsonRequest(baseUrl, "/api/bridge/runs", { token: account.token });
      const finalRun = (Array.isArray(finalRuns.runs) ? finalRuns.runs : []).find((candidate) => candidate.id === run.id);
      if (finalRun?.status !== "failed") {
        throw new Error(`Manual permission smoke expected the Cloud run to be failed after Reject, got ${finalRun?.status || "missing"}.`);
      }
      const proofFile = permissionSmokeProofFile(process.env, root);
      const proof = {
        proofVersion: 1,
        ok: true,
        manual: true,
        createdAt: new Date().toISOString(),
        baseUrl,
        auditFile,
        auditSha256: sha256File(auditFile),
        electronBinary: electronBinary(),
        deviceId: device.id,
        runId: run.id,
        statusBeforeReject: run.status,
        statusAfterReject: finalRun.status,
        title: finalAudit.show.options.title,
        buttons: finalAudit.show.options.buttons,
        defaultId: finalAudit.show.options.defaultId,
        cancelId: finalAudit.show.options.cancelId,
        resultResponse: finalAudit.result.response,
        bridgeRunRejected: !finalResult.ok,
        bridgeRunError: finalResult.ok ? "" : (finalResult.error?.message || String(finalResult.error || "")),
        sourceHashes: permissionProofSourceHashes(root),
        detail: finalAudit.show.options.detail
      };
      writeJson(proofFile, proof);
      console.log(JSON.stringify({ ...proof, proofFile }, null, 2));
      return;
    }

    await jsonRequest(baseUrl, `/api/bridge/runs/${run.id}/cancel`, {
      token: account.token,
      method: "POST",
      body: {}
    });
    runController.abort();
    const runResult = await runPromise;
    if (!runResult.ok && !runResult.aborted) throw runResult.error;

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      auditFile,
      deviceId: device.id,
      runId: run.id,
      statusBeforeCancel: run.status,
      title: audit.show.options.title,
      buttons: audit.show.options.buttons,
      defaultId: audit.show.options.defaultId,
      cancelId: audit.show.options.cancelId,
      detail: audit.show.options.detail
    }, null, 2));
  } finally {
    await cleanup();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  activateManualSmokeApp,
  electronAppBundlePath,
  isManualPermissionSmoke,
  manualSmokeWindowSettleMs,
  permissionProofSourceHashes,
  permissionSmokeProofFile,
  permissionSmokeTimeoutMs,
  parseAudit,
  pollForAudit,
  pollForAuditResult
};
