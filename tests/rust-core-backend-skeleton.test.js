"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..");

function waitForListening(child, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for MIA_CORE_LISTENING; output:\n${output}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    function onData(chunk) {
      output += chunk.toString("utf8");
      const line = output
        .split(/\r?\n/)
        .find((entry) => entry.startsWith("MIA_CORE_LISTENING "));
      if (!line) return;
      cleanup();
      resolve({ line, output });
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`mia-core exited before listening; code=${code} signal=${signal}; output:\n${output}`));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopProcessTree(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs, "timeout"));
  const result = await Promise.race([exited, timeout]);
  if (result !== "timeout") return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

test("Rust Core workspace exposes a dynamic-port health server", async () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "Cargo.toml")), true);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-test-"));
  const workspaceDir = path.join(dataDir, "workspace");
  const child = spawn(
    "cargo",
    [
      "run",
      "-p",
      "mia-core-app",
      "--",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      dataDir,
      "--workspace-dir",
      workspaceDir
    ],
    {
      cwd: REPO_ROOT,
      detached: process.platform !== "win32",
      env: { ...process.env, MIA_CORE_APP_VERSION: "test-app-version" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  try {
    const { line } = await waitForListening(child);
    const payload = JSON.parse(line.slice("MIA_CORE_LISTENING ".length));
    assert.equal(payload.host, "127.0.0.1");
    assert.equal(Number.isInteger(payload.port), true);
    assert.equal(payload.port > 0, true);

    const response = await fetch(`http://${payload.host}:${payload.port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "test-app-version");
    assert.equal(body.dataDir, dataDir);
    assert.equal(body.runtimeHome, dataDir);
    assert.equal(body.mode, "daemon");
    assert.equal(body.daemonTarget.kind, "rust-core");
    assert.equal(body.daemonTarget.usesGuiAppIdentity, false);
  } finally {
    await stopProcessTree(child);
  }
});
