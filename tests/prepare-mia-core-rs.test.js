const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  bundledRustCorePath,
  prepareMiaCoreRs,
  targetArchFromContext,
  targetPlatformFromContext
} = require("../scripts/prepare-mia-core-rs.js");

test("prepareMiaCoreRs copies an explicit Rust Core binary into bundled resources", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-rs-explicit-"));
  try {
    const source = path.join(rootDir, "target", "release", "mia-core");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "fake rust core\n", { mode: 0o755 });
    let built = false;

    const result = await prepareMiaCoreRs(
      { arch: 3, electronPlatformName: "darwin" },
      {
        rootDir,
        env: { MIA_CORE_RS_BIN: source },
        execFileSync: () => {
          built = true;
        }
      }
    );

    assert.equal(built, false);
    assert.equal(result.platform, "darwin");
    assert.equal(result.arch, "arm64");
    assert.equal(result.dest, path.join(rootDir, "resources", "bundled-mia-core", "darwin-arm64", "mia-core"));
    assert.equal(fs.readFileSync(result.dest, "utf8"), "fake rust core\n");
    assert.equal((fs.statSync(result.dest).mode & 0o111) !== 0, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("prepareMiaCoreRs builds mia-core release binary when no override is supplied", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-rs-build-"));
  try {
    const builtBinary = path.join(rootDir, "target", "release", process.platform === "win32" ? "mia-core.exe" : "mia-core");
    const calls = [];

    const result = await prepareMiaCoreRs(
      { arch: 1, electronPlatformName: "darwin" },
      {
        rootDir,
        env: {},
        execFileSync: (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
          fs.mkdirSync(path.dirname(builtBinary), { recursive: true });
          fs.writeFileSync(builtBinary, "built rust core\n", { mode: 0o755 });
        }
      }
    );

    assert.deepEqual(calls, [
      {
        command: "cargo",
        args: ["build", "--release", "-p", "mia-core-app", "--bin", "mia-core"],
        cwd: rootDir,
        stdio: "inherit"
      }
    ]);
    assert.equal(result.dest, path.join(rootDir, "resources", "bundled-mia-core", "darwin-x64", "mia-core"));
    assert.equal(fs.readFileSync(result.dest, "utf8"), "built rust core\n");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("prepareMiaCoreRs derives electron-builder platform and arch names", () => {
  assert.equal(targetArchFromContext({ arch: 3 }, {}), "arm64");
  assert.equal(targetArchFromContext({ arch: 1 }, {}), "x64");
  assert.equal(targetArchFromContext({}, { MIA_CORE_TARGET_ARCH: "amd64" }), "x64");
  assert.equal(targetPlatformFromContext({ electronPlatformName: "mac" }, {}), "darwin");
  assert.equal(targetPlatformFromContext({}, { MIA_CORE_TARGET_PLATFORM: "windows" }), "win32");
  assert.equal(
    bundledRustCorePath("/tmp/mia", "win32", "x64"),
    path.join("/tmp/mia", "resources", "bundled-mia-core", "win32-x64", "mia-core.exe")
  );
});
