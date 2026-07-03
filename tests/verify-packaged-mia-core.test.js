const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  resolvePackagedAppPath,
  verifyPackagedMiaCore
} = require("../scripts/verify-packaged-mia-core.js");

function makeFakePackagedApp(rootDir, coreSource) {
  const appPath = path.join(rootDir, "release", "mac-arm64", "Mia.app");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");
  const nodePath = path.join(resourcesPath, "mia-node");

  fs.mkdirSync(path.join(unpackedPath, "src", "core"), { recursive: true });
  fs.writeFileSync(path.join(unpackedPath, "src", "core", "mia-core.js"), coreSource);
  fs.writeFileSync(path.join(unpackedPath, "package.json"), JSON.stringify({ name: "mia", version: "9.9.9" }));
  if (process.platform === "win32") {
    fs.copyFileSync(process.execPath, `${nodePath}.exe`);
  } else {
    fs.symlinkSync(process.execPath, nodePath);
  }

  return appPath;
}

test("resolvePackagedAppPath prefers the arch-specific built Mia.app", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-app-path-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, "process.exit(0);\n");
    const resolved = resolvePackagedAppPath({ rootDir: tempDir, arch: "arm64" });
    assert.equal(resolved, appPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyPackagedMiaCore launches the packaged Core and waits for /health", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-core-ok-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, `
const http = require("node:http");
const host = process.env.MIA_DAEMON_HOST || "127.0.0.1";
const port = Number(process.env.MIA_DAEMON_PORT || "0");
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "daemon" }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(port, host);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`);

    const result = await verifyPackagedMiaCore({ appPath, timeoutMs: 5000 });
    assert.equal(result.ok, true, result.error || result.stderr || "expected packaged core verification to pass");
    assert.match(result.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyPackagedMiaCore fails closed when the packaged Core crashes on startup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-packaged-core-fail-"));
  try {
    const appPath = makeFakePackagedApp(tempDir, `
require("missing-packaged-dependency");
`);

    const result = await verifyPackagedMiaCore({ appPath, timeoutMs: 2500 });
    assert.equal(result.ok, false);
    assert.match(`${result.error || ""}\n${result.stderr || ""}`, /missing-packaged-dependency/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
