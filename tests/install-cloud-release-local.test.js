const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const installer = path.join(root, "scripts", "install-cloud-release-local.sh");
const packageJson = require(path.join(root, "package.json"));

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createFixtureRelease({ badHash = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-install-verify-"));
  const releaseRoot = path.join(tempDir, "mia-cloud-release");
  const files = {
    "api/server.js": "module.exports = {};\n",
    "api/package.json": "{\"name\":\"mia-cloud-api\"}\n",
    "web/index.html": "<!doctype html><title>Mia Web</title>\n",
    "web/app.js": "console.log('app');\n",
    "web/styles.css": "body {}\n",
    "nginx/mia-websocket-map.conf": "map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n",
    "nginx/mia-cloud-site.conf": "server { listen 80; server_name _; }\n",
    "smoke-cloud.js": "console.log('smoke');\n",
    "doctor-cloud.js": "console.log('doctor');\n"
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(path.join(releaseRoot, relativePath), contents);
  }
  const manifestHashes = {};
  for (const relativePath of Object.keys(files)) {
    manifestHashes[relativePath] = sha256File(path.join(releaseRoot, relativePath));
  }
  if (badHash) manifestHashes["web/app.js"] = "0".repeat(64);
  writeFile(path.join(releaseRoot, "manifest.json"), `${JSON.stringify({
    product: "Mia Cloud",
    version: "0.1.0",
    builtAt: "2026-05-21T00:00:00.000Z",
    source: { gitCommit: "fixture", gitDirty: false },
    files: manifestHashes
  }, null, 2)}\n`);

  const archive = path.join(tempDir, "mia-cloud-release.tgz");
  childProcess.execFileSync("tar", ["-czf", archive, "-C", tempDir, "mia-cloud-release"]);
  fs.writeFileSync(`${archive}.sha256`, `${sha256File(archive)}  mia-cloud-release.tgz\n`);
  return { tempDir, archive };
}

test("local installer verify-only accepts a release archive with matching manifest hashes", () => {
  const { tempDir, archive } = createFixtureRelease();
  try {
    const result = childProcess.spawnSync("bash", [installer, archive], {
      cwd: root,
      env: { ...process.env, MIA_INSTALL_VERIFY_ONLY: "1" },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Release archive checksum OK:/);
    assert.match(result.stdout, /Mia Cloud local installer verify-only completed:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local installer verify-only rejects a release archive with mismatched manifest hashes", () => {
  const { tempDir, archive } = createFixtureRelease({ badHash: true });
  try {
    const result = childProcess.spawnSync("bash", [installer, archive], {
      cwd: root,
      env: { ...process.env, MIA_INSTALL_VERIFY_ONLY: "1" },
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Release manifest hash mismatch for web\/app\.js/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("package exposes a safe verify-only install command", () => {
  assert.equal(
    packageJson.scripts["cloud:install:verify"],
    "MIA_INSTALL_VERIFY_ONLY=1 bash scripts/install-cloud-release-local.sh dist/mia-cloud-release.tgz"
  );
});
