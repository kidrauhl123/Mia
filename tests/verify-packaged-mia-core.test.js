const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  canRunTargetArch,
  collectRequiredPaths,
  resolvePackagedAppPath,
  verifyPackagedMiaCore
} = require("../scripts/verify-packaged-mia-core.js");

const LEGACY_NODE_RESOURCE = `mia-${"node"}`;
const MANAGED_ACP_RESOURCES = [
  ["claude-agent-acp", "0.59.0"],
  ["codex-acp", "1.1.4"]
];

function makeFakePackagedApp(rootDir, coreSource, { arch = "arm64", platform = "darwin", includeLegacyNode = false } = {}) {
  const appPath = platform === "win32"
    ? path.join(rootDir, "release", "win-unpacked")
    : path.join(rootDir, "release", arch === "arm64" ? "mac-arm64" : "mac", "Mia.app");
  const resourcesPath = platform === "win32"
    ? path.join(appPath, "resources")
    : path.join(appPath, "Contents", "Resources");
  const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");
  const coreDir = path.join(resourcesPath, "bundled-mia-core", `${platform}-${arch}`);
  const corePath = path.join(coreDir, platform === "win32" ? "mia-core.exe" : "mia-core");
  const managedResourcesDir = path.join(coreDir, "managed-resources");

  fs.mkdirSync(coreDir, { recursive: true });
  fs.mkdirSync(unpackedPath, { recursive: true });
  fs.writeFileSync(path.join(unpackedPath, "package.json"), JSON.stringify({
    name: "mia",
    version: "9.9.9",
    hermes: {
      version: "2026.7.7.2",
      packageVersion: "0.18.2",
      wheelSha256: "8f02155cfc84b28bd98551cd18dffec0efa9ec070dd08f90f1a850f1c779492f"
    }
  }));
  // Use Node itself as the fake executable. A symlink is important on macOS:
  // copying the Node binary loses the runtime-relative resources it expects.
  if (platform === "win32") fs.copyFileSync(process.execPath, corePath);
  else fs.symlinkSync(process.execPath, corePath);
  fs.writeFileSync(path.join(coreDir, "serve"), coreSource);
  if (includeLegacyNode) {
    fs.writeFileSync(path.join(resourcesPath, LEGACY_NODE_RESOURCE), "legacy node core must not be used");
  }
  for (const [toolId, version] of MANAGED_ACP_RESOURCES) {
    const manifestDir = path.join(managedResourcesDir, "acp", toolId, version, `${platform}-${arch}`);
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify({ toolId, version }));
  }

  return appPath;
}

test("resolvePackagedAppPath prefers the arch-specific built Mia.app", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-app-path-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, "process.exit(0);\n");
    const resolved = resolvePackagedAppPath({ rootDir: tempDir, arch: "arm64", platform: "darwin" });
    assert.equal(resolved, appPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolvePackagedAppPath finds the unpacked Windows application", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-win-path-"));
  try {
    const appPath = path.join(tempDir, "release", "win-unpacked");
    fs.mkdirSync(appPath, { recursive: true });
    const resolved = resolvePackagedAppPath({ rootDir: tempDir, arch: "x64", platform: "win32" });
    assert.equal(resolved, appPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("collectRequiredPaths points at bundled Rust Core, never the legacy Node resource", () => {
  const appPath = "/Applications/Mia.app";
  const paths = collectRequiredPaths(appPath, { platform: "darwin", arch: "arm64" });

  assert.equal(
    paths.corePath,
    path.join(appPath, "Contents", "Resources", "bundled-mia-core", "darwin-arm64", "mia-core")
  );
  assert.equal(Object.values(paths).some((value) => String(value).includes(LEGACY_NODE_RESOURCE)), false);
  assert.equal(
    paths.managedResourcesPath,
    path.join(appPath, "Contents", "Resources", "bundled-mia-core", "darwin-arm64", "managed-resources")
  );
  assert.equal(paths.requiredManagedResourcePaths.length, 2);
  assert.deepEqual(paths.forbiddenEnginePaths, [
    path.join(appPath, "Contents", "Resources", "hermes-runtime"),
    path.join(appPath, "Contents", "Resources", "managed-resources")
  ]);
});

test("collectRequiredPaths resolves the Windows Rust Core executable", () => {
  const appPath = path.join("C:", "Mia", "win-unpacked");
  const paths = collectRequiredPaths(appPath, { platform: "win32", arch: "x64" });

  assert.equal(
    paths.corePath,
    path.join(appPath, "resources", "bundled-mia-core", "win32-x64", "mia-core.exe")
  );
  assert.equal(paths.packageJsonPath, path.join(appPath, "resources", "app.asar.unpacked", "package.json"));
});

test("verifyPackagedMiaCore launches the packaged Rust Core and waits for /health", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-rust-core-ok-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, `
const http = require("node:http");
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const host = readArg("--host", "127.0.0.1");
const port = Number(readArg("--port", "0"));
const dataDir = readArg("--data-dir", "");
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "9.9.9", dataDir }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(port, host, () => {
  const actual = server.address().port;
  process.stdout.write("MIA_CORE_LISTENING " + JSON.stringify({ host, port: actual, pid: process.pid, version: "9.9.9" }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`, { arch: "x64", platform: "darwin", includeLegacyNode: true });

    const result = await verifyPackagedMiaCore({
      appPath,
      arch: "x64",
      platform: "darwin",
      hostArch: "x64",
      hostPlatform: "darwin",
      timeoutMs: 10000
    });
    assert.equal(result.ok, true, result.error || result.stderr || "expected packaged Core verification to pass");
    assert.match(result.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(result.health.ok, true);
    assert.match(result.stdout, /MIA_CORE_LISTENING/);
    assert.doesNotMatch(result.corePath, new RegExp(LEGACY_NODE_RESOURCE));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyPackagedMiaCore rejects a package that only contains the old JavaScript Core layout", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-old-js-core-"));
  try {
    const appPath = path.join(tempDir, "release", "mac-arm64", "Mia.app");
    const resourcesPath = path.join(appPath, "Contents", "Resources");
    fs.mkdirSync(path.join(resourcesPath, "app.asar.unpacked", "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, LEGACY_NODE_RESOURCE), "legacy");
    fs.writeFileSync(path.join(resourcesPath, "app.asar.unpacked", "src", "core", "mia-core.js"), "process.exit(0)");

    const result = await verifyPackagedMiaCore({ appPath, arch: "arm64", timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /bundled Rust Core/);
    assert.doesNotMatch(result.error || "", /mia-core\.js/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyPackagedMiaCore rejects a package that accidentally embeds legacy top-level engine backups", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-engine-embedded-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, "process.exit(0);\n");
    const paths = collectRequiredPaths(appPath, { platform: "darwin", arch: "arm64" });
    fs.mkdirSync(paths.forbiddenEnginePaths[1], { recursive: true });

    const result = await verifyPackagedMiaCore({ appPath, arch: "arm64", platform: "darwin", timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /must not embed legacy top-level engine backups/);
    assert.match(result.error || "", /managed-resources/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyPackagedMiaCore rejects a package without bundled ACP manifests", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-managed-missing-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, "process.exit(0);\n", { arch: "arm64", platform: "darwin" });
    const paths = collectRequiredPaths(appPath, { platform: "darwin", arch: "arm64" });
    fs.rmSync(paths.requiredManagedResourcePaths[0]);

    const result = await verifyPackagedMiaCore({ appPath, arch: "arm64", platform: "darwin", timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /bundled managed ACP resources/);
    assert.match(result.error || "", /claude-agent-acp/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyPackagedMiaCore skips the runtime probe for a macOS arch the host cannot execute", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-core-cross-arch-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, "process.exit(42);\n", { arch: "arm64" });
    const result = await verifyPackagedMiaCore({
      appPath,
      arch: "arm64",
      hostArch: "x64",
      platform: "darwin",
      timeoutMs: 100
    });
    assert.equal(result.ok, true, result.error || "expected cross-arch verification to pass structural checks");
    assert.equal(result.skippedRuntimeProbe, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("canRunTargetArch only blocks known macOS cross-arch runtime probes", () => {
  assert.equal(canRunTargetArch({ arch: "arm64", hostArch: "x64", platform: "darwin", hostPlatform: "darwin" }), false);
  assert.equal(canRunTargetArch({ arch: "x64", hostArch: "x64", platform: "darwin", hostPlatform: "darwin" }), true);
  assert.equal(canRunTargetArch({
    arch: "arm64",
    hostArch: "x64",
    platform: "linux",
    hostPlatform: "linux"
  }), true);
  assert.equal(canRunTargetArch({
    arch: "x64",
    hostArch: "x64",
    platform: "win32",
    hostPlatform: "darwin"
  }), false);
});

test("verifyPackagedMiaCore fails closed when the packaged Rust Core crashes on startup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-rust-core-fail-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, `
require("missing-packaged-rust-core-dependency");
`, { arch: "x64", platform: "win32" });

    const result = await verifyPackagedMiaCore({
      appPath,
      arch: "x64",
      platform: "win32",
      hostArch: "x64",
      hostPlatform: "win32",
      timeoutMs: 2500
    });
    assert.equal(result.ok, false);
    assert.match(`${result.error || ""}\n${result.stderr || ""}`, /missing-packaged-rust-core-dependency|exited before|fetch failed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
