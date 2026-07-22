const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  assertNotHtmlDownload,
  bundledRustCorePath,
  canPrepareManagedResourcesForTarget,
  miaCoreAssetName,
  miaCoreDownloadUrl,
  prepareManagedAgentResources,
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
        env: { MIA_CORE_RS_BIN: source, MIA_CORE_VERSION: "v1.2.3", MIA_MANAGED_RESOURCES_PREPARE: "0" },
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
    if (process.platform !== "win32") {
      assert.equal((fs.statSync(result.dest).mode & 0o111) !== 0, true);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("prepareMiaCoreRs downloads a prebuilt Mia Core release when no override is supplied", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-rs-download-"));
  try {
    const calls = [];

    const result = await prepareMiaCoreRs(
      { arch: 1, electronPlatformName: "darwin" },
      {
        rootDir,
        env: {
          MIA_CORE_VERSION: "v9.8.7",
          MIA_CORE_RELEASE_BASE_URL: "https://cdn.example/mia-core",
          MIA_MANAGED_RESOURCES_PREPARE: "0"
        },
        execFileSync: (command, args) => {
          calls.push({ command, args });
          if (command === "curl") {
            const outputPath = args[args.indexOf("-o") + 1];
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, "fake archive\n");
            return "";
          }
          if (command === "tar") {
            const outputDir = args[args.indexOf("-C") + 1];
            const binary = path.join(outputDir, "nested", "mia-core");
            fs.mkdirSync(path.dirname(binary), { recursive: true });
            fs.writeFileSync(binary, "downloaded rust core\n", { mode: 0o755 });
            return "";
          }
          throw new Error(`unexpected command: ${command}`);
        }
      }
    );

    assert.equal(calls.some((call) => call.command === "cargo"), false);
    assert.equal(calls[0].command, "curl");
    assert.equal(calls[0].args.at(-1), "https://cdn.example/mia-core/v9.8.7/mia-core-v9.8.7-x86_64-apple-darwin.tar.gz");
    assert.equal(result.dest, path.join(rootDir, "resources", "bundled-mia-core", "darwin-x64", "mia-core"));
    assert.equal(fs.readFileSync(result.dest, "utf8"), "downloaded rust core\n");
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(result.dest), "manifest.json"), "utf8"));
    assert.equal(manifest.sourceType, "download");
    assert.equal(manifest.version, "v9.8.7");
    assert.equal(manifest.source.url, "https://cdn.example/mia-core/v9.8.7/mia-core-v9.8.7-x86_64-apple-darwin.tar.gz");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("prepareMiaCoreRs prepares and bundles managed ACP resources with Rust Core", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-rs-managed-"));
  try {
    const source = path.join(rootDir, "target", "release", process.platform === "win32" ? "mia-core.exe" : "mia-core");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "fake rust core\n", { mode: 0o755 });
    const calls = [];
    const runtimeKey = `${process.platform}-${os.arch()}`;

    const result = await prepareMiaCoreRs(
      { arch: os.arch() === "arm64" ? 3 : 1, electronPlatformName: process.platform },
      {
        rootDir,
        env: {
          MIA_CORE_RS_BIN: source,
          MIA_CORE_VERSION: "v1.2.3",
          MIA_MANAGED_RESOURCES_CORE_BIN: "/tmp/host-mia-core"
        },
        hostPlatform: process.platform,
        hostArch: os.arch(),
        execFileSync: (command, args, options) => {
          calls.push({ command, args, options });
          if (args[0] !== "prepare-managed-resources") return;
          const resourceDir = args[args.indexOf("--resource-dir") + 1];
          for (const [toolId, version] of [["claude-agent-acp", "0.59.0"], ["codex-acp", "1.1.4"]]) {
            const manifestDir = path.join(resourceDir, "acp", toolId, version, runtimeKey);
            fs.mkdirSync(manifestDir, { recursive: true });
            fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify({ version }));
          }
        }
      }
    );

    assert.equal(calls.some((call) => call.args?.[0] === "prepare-managed-resources"), true);
    assert.equal(calls[0].command, "/tmp/host-mia-core");
    assert.equal(calls[0].options.env.MIA_MANAGED_AGENT_RESOURCES_ONLY, "1");
    assert.equal(result.managedResources.skipped, false);
    assert.equal(
      result.managedResources.resourceDir,
      path.join(rootDir, "resources", "bundled-mia-core", runtimeKey, "managed-resources")
    );
    assert.equal(fs.existsSync(path.join(rootDir, "resources", "managed-resources")), false);
    assert.equal(
      fs.existsSync(path.join(
        rootDir,
        "resources",
        "bundled-mia-core",
        runtimeKey,
        "managed-resources",
        "acp",
        "claude-agent-acp",
        "0.59.0",
        runtimeKey,
        "manifest.json"
      )),
      true
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(result.dest), "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files, [path.basename(result.dest), "managed-resources/"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("prepareMiaCoreRs rejects website HTML fallback downloads before archive extraction", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-rs-html-"));
  try {
    const downloadPath = path.join(rootDir, "mia-core.tar.gz");
    fs.writeFileSync(downloadPath, "<!doctype html><html><body>Mia</body></html>");
    assert.throws(
      () => assertNotHtmlDownload(downloadPath, "https://mia.gifgif.cn/downloads/mia-core/v0.1.0/missing.tar.gz"),
      /returned an HTML page instead of an archive/
    );
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
  assert.equal(canPrepareManagedResourcesForTarget({
    platform: process.platform,
    arch: os.arch(),
    hostPlatform: process.platform,
    hostArch: os.arch()
  }), true);
  assert.equal(prepareManagedAgentResources({
    rootDir: "/tmp/mia",
    corePath: "/tmp/mia-core",
    platform: "win32",
    arch: "x64",
    env: { MIA_MANAGED_RESOURCES_PREPARE: "0" },
    execFileSync: () => {
      throw new Error("should not run");
    }
  }).skipped, true);
  assert.equal(miaCoreAssetName("darwin", "arm64", "0.1.0"), "mia-core-v0.1.0-aarch64-apple-darwin.tar.gz");
  assert.equal(
    miaCoreDownloadUrl({
      rootDir: "/tmp/mia",
      platform: "win32",
      arch: "x64",
      tag: "v0.1.0",
      env: { MIA_CORE_RELEASE_URL_TEMPLATE: "https://cdn.example/{tag}/{target}/{asset}" }
    }),
    "https://cdn.example/v0.1.0/x86_64-pc-windows-msvc/mia-core-v0.1.0-x86_64-pc-windows-msvc.zip"
  );
});
