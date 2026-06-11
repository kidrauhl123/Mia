const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  authorizedKeysInstallCommand,
  buildHandoff,
  buildSshAuthorizationHelp,
  checksumVerifyCommand,
  parseDeployRemote,
  readDeploymentPublicKey,
  readSshAgentStatus,
  readSha256,
  sha256File,
  sshServerDiagnosticsCommand,
  sshPublicKeyFingerprint,
  verifyTransferBundle,
  verifyHandoffFile,
  writeTransferBundle,
  writeHandoffFile
} = require("../scripts/print-cloud-release-handoff.js");

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function sha256Text(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function createReleaseFixture({ badSidecar = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-handoff-"));
  const distDir = path.join(tempDir, "dist");
  const releaseDir = path.join(distDir, "mia-cloud-release");
  const archiveContents = "archive";
  const archiveSha = sha256Text(archiveContents);
  writeFile(path.join(distDir, "mia-cloud-release.tgz"), archiveContents);
  writeFile(
    path.join(distDir, "mia-cloud-release.tgz.sha256"),
    `${badSidecar ? "0".repeat(64) : archiveSha}  mia-cloud-release.tgz\n`
  );
  writeFile(path.join(releaseDir, "README.md"), "# readme\n");
  writeFile(path.join(releaseDir, "install-cloud-release-local.sh"), "#!/usr/bin/env bash\n");
  writeFile(path.join(releaseDir, "manifest.json"), `${JSON.stringify({
    product: "Mia Cloud",
    builtAt: "2026-05-21T01:02:03.000Z",
    source: { gitCommit: "abcdef123456", gitDirty: true },
    files: {
      "README.md": "readmehash",
      "install-cloud-release-local.sh": "installerhash"
    }
  }, null, 2)}\n`);
  return { tempDir, distDir };
}

test("readSha256 parses the first checksum field and sha256File hashes file contents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-sha-"));
  try {
    const shaFile = path.join(tempDir, "release.tgz.sha256");
    const archive = path.join(tempDir, "release.tgz");
    fs.writeFileSync(archive, "archive");
    fs.writeFileSync(shaFile, "abc123  release.tgz\n");
    assert.equal(readSha256(shaFile), "abc123");
    assert.equal(sha256File(archive), sha256Text("archive"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("deployment public key helpers expose public key fingerprints without private key material", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-pubkey-"));
  try {
    const publicKeyPath = path.join(tempDir, "id_ed25519.pub");
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1+gbPn4J mia-test";
    fs.writeFileSync(publicKeyPath, `${publicKey}\n`);
    const expectedFingerprint = sshPublicKeyFingerprint(publicKey);
    assert.match(expectedFingerprint, /^SHA256:/);
    assert.deepEqual(readDeploymentPublicKey(publicKeyPath), {
      path: publicKeyPath,
      publicKey,
      fingerprint: expectedFingerprint
    });
    assert.equal(readDeploymentPublicKey(path.join(tempDir, "missing.pub")), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("authorizedKeysInstallCommand appends the deployment public key idempotently", () => {
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1+gbPn4J mia-test";
  const command = authorizedKeysInstallCommand(publicKey, "root");
  assert.match(command, /install -d -m 700 \/root\/\.ssh/);
  assert.match(command, /grep -qxF 'ssh-ed25519/);
  assert.match(command, /authorized_keys \|\| printf '%s\\n'/);
  assert.match(command, /chmod 600 \/root\/\.ssh\/authorized_keys/);
  assert.doesNotMatch(command, /PRIVATE KEY/);
});

test("sshServerDiagnosticsCommand checks key presence, permissions, and sshd policy", () => {
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1+gbPn4J mia-test";
  const command = sshServerDiagnosticsCommand(publicKey, "root");
  assert.match(command, /ls -ld \/root \/root\/\.ssh \/root\/\.ssh\/authorized_keys/);
  assert.match(command, /grep -qxF 'ssh-ed25519/);
  assert.match(command, /authorized_keys contains Mia deploy key/);
  assert.match(command, /MISSING Mia deploy key/);
  assert.match(command, /sshd -T/);
  assert.match(command, /permitrootlogin/);
  assert.doesNotMatch(command, /PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/);
});

test("parseDeployRemote extracts a deploy user from MIA_DEPLOY_REMOTE-style targets", () => {
  assert.deepEqual(parseDeployRemote("root@mia.gifgif.cn"), {
    remote: "root@mia.gifgif.cn",
    user: "root",
    host: "mia.gifgif.cn"
  });
  assert.deepEqual(parseDeployRemote("deploy@example.com"), {
    remote: "deploy@example.com",
    user: "deploy",
    host: "example.com"
  });
  assert.deepEqual(parseDeployRemote("mia.gifgif.cn"), {
    remote: "mia.gifgif.cn",
    user: "root",
    host: "mia.gifgif.cn"
  });
});

test("buildSshAuthorizationHelp prints a focused SSH unblock command without release artifacts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-ssh-help-"));
  try {
    const publicKeyPath = path.join(tempDir, "id_ed25519.pub");
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1+gbPn4J mia-test";
    fs.writeFileSync(publicKeyPath, `${publicKey}\n`);
    const help = buildSshAuthorizationHelp({
      remote: "deploy@mia.gifgif.cn",
      sshPublicKeyPath: publicKeyPath,
      sshAgentStatus: "ssh-agent identities: none loaded"
    });
    assert.match(help, /Mia Cloud SSH authorization help/);
    assert.match(help, /Remote target: deploy@mia\.gifgif\.cn/);
    assert.match(help, /Remote user: deploy/);
    assert.match(help, new RegExp(`Public key path: ${publicKeyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(help, /Public key fingerprint: SHA256:/);
    assert.match(help, /Local ssh-agent identities: none loaded/);
    assert.match(help, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1\+gbPn4J mia-test/);
    assert.match(help, /install -d -m 700 ~deploy\/\.ssh/);
    assert.match(help, /grep -qxF 'ssh-ed25519/);
    assert.match(help, /If SSH is still denied after authorizing/);
    assert.match(help, /sshd -T/);
    assert.match(help, /MISSING Mia deploy key/);
    assert.match(help, new RegExp(`ssh-add '${path.join(tempDir, "id_ed25519").replace(/'/g, "'\\\\''")}'`));
    assert.match(help, /ssh -o BatchMode=yes -o ConnectTimeout=10 'deploy@mia\.gifgif\.cn' true/);
    assert.match(help, /npm run cloud:deploy/);
    assert.doesNotMatch(help, /PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("readSshAgentStatus summarizes loaded, empty, and unavailable agents without key material", () => {
  assert.equal(
    readSshAgentStatus(() => "256 SHA256:abc test-key (ED25519)\n256 SHA256:def other-key (ED25519)\n"),
    "ssh-agent identities: 2 loaded"
  );
  assert.equal(
    readSshAgentStatus(() => {
      const error = new Error("no identities");
      error.stderr = "The agent has no identities.";
      throw error;
    }),
    "ssh-agent identities: none loaded"
  );
  assert.equal(
    readSshAgentStatus(() => {
      throw new Error("missing ssh-add");
    }),
    "ssh-agent identities: unavailable"
  );
});

test("checksumVerifyCommand supports Linux sha256sum and macOS shasum", () => {
  const command = checksumVerifyCommand("mia-cloud-release-transfer.tgz.sha256");
  assert.match(command, /if command -v sha256sum >\/dev\/null 2>&1; then/);
  assert.match(command, /sha256sum -c 'mia-cloud-release-transfer\.tgz\.sha256'/);
  assert.match(command, /shasum -a 256 -c 'mia-cloud-release-transfer\.tgz\.sha256'/);
});

test("buildHandoff prints operator commands from release artifacts", () => {
  const { tempDir, distDir } = createReleaseFixture();
  try {
    const publicKeyPath = path.join(tempDir, "id_ed25519.pub");
    fs.writeFileSync(publicKeyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1+gbPn4J mia-test\n");
    const handoff = buildHandoff({ distDir, publicUrl: "https://mia.gifgif.cn", sshPublicKeyPath: publicKeyPath });
    assert.match(handoff, new RegExp(`Archive SHA-256: ${sha256Text("archive")}`));
    assert.match(handoff, /Source commit: abcdef123456\+dirty/);
    assert.match(handoff, /Built at: 2026-05-21T01:02:03\.000Z/);
    assert.match(handoff, /Send these files to the VPS operator:/);
    assert.match(handoff, /mia-cloud-release-handoff\.txt/);
    assert.match(handoff, /Optional single-file transfer bundle:/);
    assert.match(handoff, /mia-cloud-release-transfer\.tgz/);
    assert.match(handoff, /mia-cloud-release-transfer\.tgz\.sha256/);
    assert.match(handoff, /If SSH deploy access is denied/);
    assert.match(handoff, /npm run cloud:deploy:authorize-help/);
    assert.match(handoff, new RegExp(`Public key path: ${publicKeyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(handoff, /Public key fingerprint: SHA256:/);
    assert.match(handoff, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1I4LfHcHFs9N1NZWSKlYhvthAl8S3zKLer1\+gbPn4J mia-test/);
    assert.match(handoff, /Run this on the VPS as root to authorize that key:/);
    assert.match(handoff, /install -d -m 700 \/root\/\.ssh/);
    assert.match(handoff, /grep -qxF 'ssh-ed25519/);
    assert.match(handoff, /If SSH is still denied after authorizing/);
    assert.match(handoff, /sshd -T/);
    assert.match(handoff, /MISSING Mia deploy key/);
    assert.match(handoff, /npm run cloud:deploy:ssh-diagnose/);
    assert.match(
      handoff,
      /sha256sum -c 'mia-cloud-release-transfer\.tgz\.sha256'[\s\S]*shasum -a 256 -c 'mia-cloud-release-transfer\.tgz\.sha256'[\s\S]*tar -xzf mia-cloud-release-transfer\.tgz -C \/tmp --strip-components=1/
    );
    assert.match(handoff, /tar -xzf mia-cloud-release-transfer\.tgz -C \/tmp --strip-components=1/);
    assert.match(handoff, /MIA_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle\.sh/);
    assert.match(handoff, /bash install-transfer-bundle\.sh/);
    assert.match(handoff, /Place them on the VPS as:/);
    assert.match(handoff, /\/tmp\/mia-cloud-release\.tgz\.sha256/);
    assert.match(handoff, /\/tmp\/mia-cloud-release-handoff\.txt/);
    assert.match(handoff, /MIA_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local\.sh \/tmp\/mia-cloud-release\.tgz/);
    assert.match(handoff, /\.\/install-cloud-release-local\.sh \/tmp\/mia-cloud-release\.tgz/);
    assert.match(handoff, /MIA_DOCTOR_EXPECT_RELEASE_COMMIT='abcdef123456'/);
    assert.match(handoff, /MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT='2026-05-21T01:02:03\.000Z'/);
    assert.match(handoff, /node mia-cloud-release\/doctor-cloud\.js 'https:\/\/mia\.gifgif\.cn'/);
    assert.match(handoff, /MIA_SMOKE_EXPECT_RELEASE_COMMIT='abcdef123456'/);
    assert.match(handoff, /MIA_SMOKE_EXPECT_RELEASE_BUILT_AT='2026-05-21T01:02:03\.000Z'/);
    assert.match(handoff, /node mia-cloud-release\/smoke-cloud\.js 'https:\/\/mia\.gifgif\.cn'/);
    assert.match(handoff, /curl -fsS 'https:\/\/mia\.gifgif\.cn\/5a371047c22c89872f93f00c7d8af123\.txt' \| grep -qxF '24dd5141e8f881adf83372da5cd9d6f1f60f2b32'/);
    assert.match(handoff, /After the desktop bridge is logged into the same dedicated WeChat smoke account/);
    assert.match(handoff, /mia-cloud-release\/prepare-cloud-smoke-account\.js mia-cloud-release\/smoke-cloud\.js/);
    assert.match(handoff, /node mia-cloud-release\/prepare-cloud-smoke-account\.js 'https:\/\/mia\.gifgif\.cn'/);
    assert.match(handoff, /MIA_CLOUD_TOKEN='<smoke-account-token>'/);
    assert.match(handoff, /MIA_SMOKE_REQUIRE_BRIDGE=1/);
    assert.match(handoff, /Desktop bridge same-account control:/);
    assert.match(handoff, /same Mia Cloud account/);
    assert.match(handoff, /directly from Web or mobile/);
    assert.match(handoff, /does not require a separate local approval click/);
    assert.match(handoff, /Agent permission mode remains/);
    assert.doesNotMatch(handoff, /gate\.native-permission-click/);
    assert.match(handoff, /standalone local Agent bridge/);
    assert.match(handoff, /full Mia project checkout/);
    assert.match(handoff, /not run from the extracted Cloud release directory/);
    assert.match(handoff, /cd \/path\/to\/mia/);
    assert.match(handoff, /MIA_CLOUD_URL='https:\/\/mia\.gifgif\.cn'/);
    assert.match(handoff, /MIA_CLOUD_TOKEN='<smoke-account-token>'/);
    assert.match(handoff, /npm run bridge/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildHandoff rejects sidecar checksum mismatches", () => {
  const { tempDir, distDir } = createReleaseFixture({ badSidecar: true });
  try {
    assert.throws(
      () => buildHandoff({ distDir, publicUrl: "https://mia.gifgif.cn" }),
      /Release archive checksum mismatch:/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeHandoffFile writes a transfer note beside release artifacts", () => {
  const { tempDir, distDir } = createReleaseFixture();
  try {
    const outputPath = writeHandoffFile({ distDir, publicUrl: "https://mia.gifgif.cn" });
    assert.equal(outputPath, path.join(distDir, "mia-cloud-release-handoff.txt"));
    const written = fs.readFileSync(outputPath, "utf8");
    assert.match(written, /Mia Cloud release handoff/);
    assert.match(written, new RegExp(`Archive SHA-256: ${sha256Text("archive")}`));
    assert.match(written, /mia-cloud-release-handoff\.txt/);
    assert.match(written, /MIA_DOCTOR_EXPECT_RELEASE_COMMIT='abcdef123456'/);
    assert.match(written, /MIA_SMOKE_EXPECT_RELEASE_COMMIT='abcdef123456'/);
    assert.match(written, /node mia-cloud-release\/smoke-cloud\.js 'https:\/\/mia\.gifgif\.cn'/);
    assert.match(written, /\n$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeTransferBundle packages release, checksum, and handoff into one tarball", () => {
  const { tempDir, distDir } = createReleaseFixture();
  try {
    const outputPath = writeTransferBundle({ distDir, publicUrl: "https://mia.gifgif.cn" });
    assert.equal(outputPath, path.join(distDir, "mia-cloud-release-transfer.tgz"));
    assert.ok(fs.existsSync(outputPath));
    const sidecarPath = `${outputPath}.sha256`;
    assert.ok(fs.existsSync(sidecarPath));
    assert.match(fs.readFileSync(sidecarPath, "utf8"), new RegExp(`^${sha256File(outputPath)}  mia-cloud-release-transfer\\.tgz\\n$`));
    const listing = require("node:child_process")
      .execFileSync("tar", ["-tzf", outputPath], { encoding: "utf8" });
    assert.match(listing, /mia-cloud-transfer\/mia-cloud-release\.tgz/);
    assert.match(listing, /mia-cloud-transfer\/mia-cloud-release\.tgz\.sha256/);
    assert.match(listing, /mia-cloud-transfer\/mia-cloud-release-handoff\.txt/);
    assert.match(listing, /mia-cloud-transfer\/install-transfer-bundle\.sh/);
    assert.match(listing, /mia-cloud-transfer\/TRANSFER-README\.md/);
    assert.match(listing, /mia-cloud-transfer\/TRANSFER-SHA256\.txt/);
    const manifest = require("node:child_process")
      .execFileSync("tar", ["-xOf", outputPath, "mia-cloud-transfer/TRANSFER-SHA256.txt"], { encoding: "utf8" });
    assert.match(manifest, new RegExp(`${sha256Text("archive")}  mia-cloud-release\\.tgz`));
    assert.match(manifest, /mia-cloud-release-handoff\.txt/);
    assert.match(manifest, /install-transfer-bundle\.sh/);
    assert.match(manifest, /TRANSFER-README\.md/);
    const readme = require("node:child_process")
      .execFileSync("tar", ["-xOf", outputPath, "mia-cloud-transfer/TRANSFER-README.md"], { encoding: "utf8" });
    assert.match(readme, /MIA_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle\.sh/);
    assert.match(readme, /bash install-transfer-bundle\.sh/);
    assert.match(readme, /MIA_DOCTOR_EXPECT_RELEASE_COMMIT='abcdef123456'/);
    assert.match(readme, /curl -fsS 'https:\/\/mia\.gifgif\.cn\/5a371047c22c89872f93f00c7d8af123\.txt' \| grep -qxF '24dd5141e8f881adf83372da5cd9d6f1f60f2b32'/);
    assert.match(readme, /prepare-cloud-smoke-account\.js mia-cloud-release\/smoke-cloud\.js/);
    assert.match(readme, /node mia-cloud-release\/prepare-cloud-smoke-account\.js 'https:\/\/mia\.gifgif\.cn'/);
    assert.match(readme, /MIA_SMOKE_REQUIRE_BRIDGE=1/);
    assert.match(readme, /Log the desktop app or standalone bridge into the same smoke account/);
    assert.match(readme, /Desktop bridge same-account control from a full Mia checkout/);
    assert.match(readme, /same Mia Cloud account/);
    assert.match(readme, /does not require a separate local approval click/);
    assert.match(readme, /Agent permission mode remains/);
    assert.doesNotMatch(readme, /gate\.native-permission-click/);
    const installer = require("node:child_process")
      .execFileSync("tar", ["-xOf", outputPath, "mia-cloud-transfer/install-transfer-bundle.sh"], { encoding: "utf8" });
    assert.match(installer, /MIA_TRANSFER_VERIFY_ONLY/);
    assert.match(installer, /MIA_INSTALL_VERIFY_ONLY=1 bash "\$INSTALLER" "\$ARCHIVE"/);
    assert.match(installer, /bash "\$INSTALLER" "\$ARCHIVE"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyTransferBundle accepts current bundle and rejects checksum mismatches", () => {
  const { tempDir, distDir } = createReleaseFixture();
  try {
    const outputPath = writeTransferBundle({ distDir, publicUrl: "https://mia.gifgif.cn" });
    assert.equal(verifyTransferBundle({ outputPath }), outputPath);

    fs.rmSync(`${outputPath}.sha256`, { force: true });
    assert.throws(
      () => verifyTransferBundle({ outputPath }),
      /Missing release transfer bundle checksum/
    );
    fs.writeFileSync(`${outputPath}.sha256`, `${sha256File(outputPath)}  mia-cloud-release-transfer.tgz\n`);

    fs.writeFileSync(`${outputPath}.sha256`, `${"f".repeat(64)}  mia-cloud-release-transfer.tgz\n`);
    assert.throws(
      () => verifyTransferBundle({ outputPath }),
      /Transfer bundle archive checksum mismatch/
    );
    fs.writeFileSync(`${outputPath}.sha256`, `${sha256File(outputPath)}  mia-cloud-release-transfer.tgz\n`);

    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bad-transfer-"));
    const bundleDir = path.join(badRoot, "mia-cloud-transfer");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "mia-cloud-release.tgz"), "tampered");
    fs.writeFileSync(path.join(bundleDir, "mia-cloud-release.tgz.sha256"), "sha  mia-cloud-release.tgz\n");
    fs.writeFileSync(path.join(bundleDir, "mia-cloud-release-handoff.txt"), "handoff\n");
    fs.writeFileSync(path.join(bundleDir, "install-transfer-bundle.sh"), "#!/usr/bin/env bash\n");
    fs.writeFileSync(path.join(bundleDir, "TRANSFER-README.md"), "# transfer\n");
    fs.writeFileSync(path.join(bundleDir, "TRANSFER-SHA256.txt"), `${"0".repeat(64)}  mia-cloud-release.tgz\n`);
    require("node:child_process").execFileSync("tar", ["-czf", outputPath, "-C", badRoot, "mia-cloud-transfer"]);
    fs.writeFileSync(`${outputPath}.sha256`, `${sha256File(outputPath)}  mia-cloud-release-transfer.tgz\n`);
    fs.rmSync(badRoot, { recursive: true, force: true });

    assert.throws(
      () => verifyTransferBundle({ outputPath }),
      /Transfer bundle checksum mismatch/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyHandoffFile accepts current handoff and rejects stale content", () => {
  const { tempDir, distDir } = createReleaseFixture();
  try {
    const outputPath = writeHandoffFile({ distDir, publicUrl: "https://mia.gifgif.cn" });
    assert.equal(
      verifyHandoffFile({ distDir, publicUrl: "https://mia.gifgif.cn" }),
      outputPath
    );
    fs.appendFileSync(outputPath, "\nstale\n");
    assert.throws(
      () => verifyHandoffFile({ distDir, publicUrl: "https://mia.gifgif.cn" }),
      /Release handoff file is stale/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildHandoff rejects incomplete release artifacts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-handoff-missing-"));
  try {
    assert.throws(
      () => buildHandoff({ distDir: path.join(tempDir, "dist") }),
      /Missing release artifact:/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
