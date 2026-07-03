"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const DEFAULT_TIMEOUT_MS = Number(process.env.MIA_PACKAGED_CORE_VERIFY_TIMEOUT_MS || 10000);

function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function macAppCandidates(rootDir, arch = "") {
  const releaseDir = path.join(rootDir, "release");
  const candidates = [];
  if (arch === "arm64") {
    candidates.push(
      path.join(releaseDir, "mac-arm64", "Mia.app"),
      path.join(releaseDir, "mac", "Mia.app")
    );
  } else if (arch === "x64") {
    candidates.push(
      path.join(releaseDir, "mac", "Mia.app"),
      path.join(releaseDir, "mac-x64", "Mia.app"),
      path.join(releaseDir, "mac-intel", "Mia.app")
    );
  } else {
    candidates.push(
      path.join(releaseDir, "mac-arm64", "Mia.app"),
      path.join(releaseDir, "mac", "Mia.app"),
      path.join(releaseDir, "mac-x64", "Mia.app"),
      path.join(releaseDir, "mac-intel", "Mia.app")
    );
  }
  return candidates;
}

function resolvePackagedAppPath({ rootDir = root, appPath = "", arch = "" } = {}) {
  if (appPath) return path.resolve(appPath);
  for (const candidate of macAppCandidates(rootDir, arch)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const releaseDir = path.join(rootDir, "release");
  if (!fs.existsSync(releaseDir)) return "";
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(releaseDir, entry.name, "Mia.app");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function resourcesForApp(appPath) {
  return path.join(appPath, "Contents", "Resources");
}

function collectRequiredPaths(appPath) {
  const resourcesPath = resourcesForApp(appPath);
  const unpackedRoot = path.join(resourcesPath, "app.asar.unpacked");
  return {
    resourcesPath,
    unpackedRoot,
    nodePath: path.join(resourcesPath, process.platform === "win32" ? "mia-node.exe" : "mia-node"),
    coreEntry: path.join(unpackedRoot, "src", "core", "mia-core.js"),
    packageJsonPath: path.join(unpackedRoot, "package.json")
  };
}

async function stopChild(child, timeoutMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHealth(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, child = null } = {}) {
  const startedAt = Date.now();
  let lastError = "";
  while ((Date.now() - startedAt) < timeoutMs) {
    if (child && child.exitCode !== null) {
      return {
        ok: false,
        error: `packaged Mia Core exited before /health responded (code ${child.exitCode})`
      };
    }
    try {
      const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        return { ok: true, body };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    ok: false,
    error: lastError || `timed out waiting for ${baseUrl}/health`
  };
}

async function verifyPackagedMiaCore({
  rootDir = root,
  appPath = "",
  arch = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  const resolvedAppPath = resolvePackagedAppPath({ rootDir, appPath, arch });
  if (!resolvedAppPath) {
    return {
      ok: false,
      error: `Unable to find packaged Mia.app under ${path.join(rootDir, "release")}`
    };
  }

  const { resourcesPath, unpackedRoot, nodePath, coreEntry, packageJsonPath } = collectRequiredPaths(resolvedAppPath);
  const missing = [resourcesPath, unpackedRoot, nodePath, coreEntry, packageJsonPath].filter((candidate) => !fs.existsSync(candidate));
  if (missing.length) {
    return {
      ok: false,
      appPath: resolvedAppPath,
      error: `Packaged Mia Core is incomplete: missing ${missing.join(", ")}`
    };
  }

  const verifyHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-core-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";

  const child = childProcess.spawn(nodePath, [coreEntry, "--daemon"], {
    cwd: path.dirname(nodePath),
    env: {
      ...process.env,
      MIA_HOME: verifyHome,
      MIA_DAEMON_HOST: "127.0.0.1",
      MIA_DAEMON_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    const health = await waitForHealth(baseUrl, { timeoutMs, fetchImpl, child });
    if (!health.ok) {
      await stopChild(child);
      return {
        ok: false,
        appPath: resolvedAppPath,
        baseUrl,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: health.error
      };
    }
    await stopChild(child);
    return {
      ok: true,
      appPath: resolvedAppPath,
      baseUrl,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      health: health.body
    };
  } finally {
    fs.rmSync(verifyHome, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  let appPath = "";
  let arch = "";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--app") {
      appPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--arch") {
      arch = argv[index + 1] || "";
      index += 1;
    }
  }

  const result = await verifyPackagedMiaCore({ appPath, arch });
  if (!result.ok) {
    const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    process.stderr.write(`packaged Mia Core verification failed: ${detail}\n`);
    process.exit(1);
  }
  process.stdout.write(`packaged Mia Core verified: ${result.appPath} -> ${result.baseUrl}\n`);
}

module.exports = {
  resolvePackagedAppPath,
  verifyPackagedMiaCore
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`packaged Mia Core verification failed: ${error?.message || error}\n`);
    process.exit(1);
  });
}
