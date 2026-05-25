#!/usr/bin/env node

const fs = require("node:fs");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readSha256(shaPath) {
  return readText(shaPath).trim().split(/\s+/)[0] || "";
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sshPublicKeyFingerprint(publicKey) {
  const blob = String(publicKey || "").trim().split(/\s+/)[1] || "";
  if (!blob) return "";
  try {
    return `SHA256:${crypto.createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
  } catch {
    return "";
  }
}

function readDeploymentPublicKey(publicKeyPath = process.env.MIA_DEPLOY_PUBLIC_KEY || path.join(os.homedir(), ".ssh", "id_ed25519.pub")) {
  if (!publicKeyPath || !fs.existsSync(publicKeyPath)) return null;
  const publicKey = readText(publicKeyPath).trim();
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)\s+\S+/.test(publicKey)) return null;
  return {
    path: publicKeyPath,
    publicKey,
    fingerprint: sshPublicKeyFingerprint(publicKey)
  };
}

function readSshAgentStatus(execFileSync = childProcess.execFileSync) {
  try {
    const output = execFileSync("ssh-add", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!output) return "ssh-agent identities: none reported";
    const identities = output.split(/\r?\n/).filter((line) => line.trim()).length;
    return `ssh-agent identities: ${identities} loaded`;
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    if (/has no identities|no identities/i.test(output)) {
      return "ssh-agent identities: none loaded";
    }
    return "ssh-agent identities: unavailable";
  }
}

function authorizedKeysInstallCommand(publicKey, user = "root") {
  const homeExpr = user === "root" ? "/root" : `~${user}`;
  return [
    `install -d -m 700 ${homeExpr}/.ssh`,
    `touch ${homeExpr}/.ssh/authorized_keys`,
    `grep -qxF ${shellQuote(publicKey)} ${homeExpr}/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ${homeExpr}/.ssh/authorized_keys`,
    `chmod 600 ${homeExpr}/.ssh/authorized_keys`
  ].join("\n");
}

function sshServerDiagnosticsCommand(publicKey, user = "root") {
  const homeExpr = user === "root" ? "/root" : `~${user}`;
  return [
    `ls -ld ${homeExpr} ${homeExpr}/.ssh ${homeExpr}/.ssh/authorized_keys 2>/dev/null || true`,
    `grep -qxF ${shellQuote(publicKey)} ${homeExpr}/.ssh/authorized_keys && echo "authorized_keys contains Mia deploy key" || echo "MISSING Mia deploy key"`,
    "sshd -T 2>/dev/null | grep -E '^(pubkeyauthentication|permitrootlogin|authorizedkeysfile|passwordauthentication) ' || true"
  ].join("\n");
}

function parseDeployRemote(remote = process.env.MIA_DEPLOY_REMOTE || "root@aiweb.buytb01.com") {
  const value = String(remote || "").trim() || "root@aiweb.buytb01.com";
  const at = value.lastIndexOf("@");
  if (at === -1) {
    return { remote: value, user: "root", host: value };
  }
  return {
    remote: value,
    user: value.slice(0, at) || "root",
    host: value.slice(at + 1) || value
  };
}

function buildSshAuthorizationHelp({
  remote = process.env.MIA_DEPLOY_REMOTE || "root@aiweb.buytb01.com",
  sshPublicKeyPath = process.env.MIA_DEPLOY_PUBLIC_KEY || path.join(os.homedir(), ".ssh", "id_ed25519.pub"),
  sshAgentStatus = readSshAgentStatus()
} = {}) {
  const deployRemote = parseDeployRemote(remote);
  const deploymentPublicKey = readDeploymentPublicKey(sshPublicKeyPath);
  if (!deploymentPublicKey) {
    throw new Error(`Missing or invalid deployment public key: ${sshPublicKeyPath}`);
  }
  return [
    "Mia Cloud SSH authorization help",
    "",
    `Remote target: ${deployRemote.remote}`,
    `Remote user: ${deployRemote.user}`,
    `Public key path: ${deploymentPublicKey.path}`,
    `Public key fingerprint: ${deploymentPublicKey.fingerprint || "unavailable"}`,
    `Local ${sshAgentStatus}`,
    "",
    "Public key:",
    "```text",
    deploymentPublicKey.publicKey,
    "```",
    "",
    deployRemote.user === "root"
      ? "Run this on the VPS as root to authorize this workstation:"
      : `Run this on the VPS as ${deployRemote.user}, or as root if that account's home directory is available, to authorize this workstation:`,
    "```bash",
    authorizedKeysInstallCommand(deploymentPublicKey.publicKey, deployRemote.user),
    "```",
    "",
    "If SSH is still denied after authorizing, run this on the VPS to inspect the server-side key and SSHD policy:",
    "```bash",
    sshServerDiagnosticsCommand(deploymentPublicKey.publicKey, deployRemote.user),
    "```",
    "",
    "If the private key has a passphrase or the local ssh-agent has no identities, load the matching private key before the BatchMode check:",
    "```bash",
    `ssh-add ${shellQuote(path.join(path.dirname(deploymentPublicKey.path), path.basename(deploymentPublicKey.path, ".pub")))}`,
    "```",
    "",
    "Then verify from this Mac:",
    "```bash",
    `ssh -o BatchMode=yes -o ConnectTimeout=10 ${shellQuote(deployRemote.remote)} true`,
    "npm run cloud:deploy",
    "```",
    "",
    "This output contains only the public key. Do not paste or transfer a private key."
  ].join("\n");
}

function checksumVerifyCommand(checksumFile) {
  const quotedChecksumFile = shellQuote(checksumFile);
  return [
    "if command -v sha256sum >/dev/null 2>&1; then",
    `  sha256sum -c ${quotedChecksumFile}`,
    "else",
    `  shasum -a 256 -c ${quotedChecksumFile}`,
    "fi"
  ].join("\n");
}

function buildHandoff({
  distDir = path.join(root, "dist"),
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://aiweb.buytb01.com",
  sshPublicKeyPath = process.env.MIA_DEPLOY_PUBLIC_KEY || path.join(os.homedir(), ".ssh", "id_ed25519.pub")
} = {}) {
  const releaseDir = path.join(distDir, "mia-cloud-release");
  const archive = path.join(distDir, "mia-cloud-release.tgz");
  const shaFile = `${archive}.sha256`;
  const handoffFile = path.join(distDir, "mia-cloud-release-handoff.txt");
  const transferBundle = path.join(distDir, "mia-cloud-release-transfer.tgz");
  const manifestPath = path.join(releaseDir, "manifest.json");
  const readmePath = path.join(releaseDir, "README.md");
  const installerPath = path.join(releaseDir, "install-cloud-release-local.sh");

  for (const filePath of [archive, shaFile, manifestPath, readmePath, installerPath]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing release artifact: ${filePath}`);
    }
  }

  const manifest = JSON.parse(readText(manifestPath));
  const archiveSha = readSha256(shaFile);
  if (!archiveSha) throw new Error(`Release checksum file is empty: ${shaFile}`);
  const actualArchiveSha = sha256File(archive);
  if (archiveSha !== actualArchiveSha) {
    throw new Error(`Release archive checksum mismatch: ${archiveSha} in ${shaFile}, ${actualArchiveSha} for ${archive}`);
  }
  if (!manifest.files?.["README.md"]) throw new Error("Release manifest is missing README.md hash.");
  if (!manifest.files?.["install-cloud-release-local.sh"]) {
    throw new Error("Release manifest is missing installer hash.");
  }
  const expectedCommit = String(manifest.source?.gitCommit || "");
  const expectedBuiltAt = String(manifest.builtAt || "");
  const deploymentPublicKey = readDeploymentPublicKey(sshPublicKeyPath);
  const sshAccessSection = deploymentPublicKey ? [
    "",
    "If SSH deploy access is denied, authorize this workstation public key on the VPS before running `npm run cloud:deploy`:",
    "To print only this SSH authorization block from the workstation, run `npm run cloud:deploy:authorize-help`.",
    `Public key path: ${deploymentPublicKey.path}`,
    `Public key fingerprint: ${deploymentPublicKey.fingerprint || "unavailable"}`,
    "```text",
    deploymentPublicKey.publicKey,
    "```",
    "Run this on the VPS as root to authorize that key:",
    "```bash",
    authorizedKeysInstallCommand(deploymentPublicKey.publicKey, "root"),
    "```",
    "If SSH is still denied after authorizing, run this on the VPS to inspect the server-side key and SSHD policy:",
    "```bash",
    sshServerDiagnosticsCommand(deploymentPublicKey.publicKey, "root"),
    "```",
    "From the development Mac, collect the matching filtered authentication trace with:",
    "```bash",
    "npm run cloud:deploy:ssh-diagnose",
    "```"
  ] : [];

  return [
    "Mia Cloud release handoff",
    "",
    `Public URL: ${publicUrl}`,
    `Archive: ${archive}`,
    `Archive SHA-256: ${archiveSha}`,
    `Source commit: ${manifest.source?.gitCommit || ""}${manifest.source?.gitDirty ? "+dirty" : ""}`,
    `Built at: ${manifest.builtAt || ""}`,
    "",
    "Send these files to the VPS operator:",
    `- ${archive}`,
    `- ${shaFile}`,
    `- ${handoffFile}`,
    "",
    "Optional single-file transfer bundle:",
    `- ${transferBundle}`,
    `- ${transferBundle}.sha256`,
    ...sshAccessSection,
    "",
    "If you send the transfer bundle instead of the three files above, place it on the VPS as /tmp/mia-cloud-release-transfer.tgz and place its checksum sidecar as /tmp/mia-cloud-release-transfer.tgz.sha256, then run:",
    "```bash",
    "cd /tmp",
    checksumVerifyCommand("mia-cloud-release-transfer.tgz.sha256"),
    "tar -xzf mia-cloud-release-transfer.tgz -C /tmp --strip-components=1",
    "MIA_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle.sh",
    "bash install-transfer-bundle.sh",
    "```",
    "",
    "Place them on the VPS as:",
    "- /tmp/mia-cloud-release.tgz",
    "- /tmp/mia-cloud-release.tgz.sha256",
    "- /tmp/mia-cloud-release-handoff.txt",
    "",
    "On the VPS:",
    "```bash",
    "cd /tmp",
    "tar -xOf mia-cloud-release.tgz mia-cloud-release/install-cloud-release-local.sh > install-cloud-release-local.sh",
    "chmod +x install-cloud-release-local.sh",
    "MIA_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local.sh /tmp/mia-cloud-release.tgz",
    "./install-cloud-release-local.sh /tmp/mia-cloud-release.tgz",
    "```",
    "",
    "After install:",
    "```bash",
    "cd /tmp",
    "tar -xzf mia-cloud-release.tgz mia-cloud-release/doctor-cloud.js mia-cloud-release/smoke-cloud.js",
    `MIA_DOCTOR_EXPECT_RELEASE_COMMIT=${shellQuote(expectedCommit)} \\`,
    `MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT=${shellQuote(expectedBuiltAt)} \\`,
    `node mia-cloud-release/doctor-cloud.js ${shellQuote(publicUrl)}`,
    `MIA_SMOKE_EXPECT_RELEASE_COMMIT=${shellQuote(expectedCommit)} \\`,
    `MIA_SMOKE_EXPECT_RELEASE_BUILT_AT=${shellQuote(expectedBuiltAt)} \\`,
    `node mia-cloud-release/smoke-cloud.js ${shellQuote(publicUrl)}`,
    "```",
    "",
    "After a desktop bridge is logged into the same dedicated smoke account, run the end-to-end bridge smoke:",
    "```bash",
    "cd /tmp",
    "tar -xzf mia-cloud-release.tgz mia-cloud-release/prepare-cloud-smoke-account.js mia-cloud-release/smoke-cloud.js",
    "MIA_SMOKE_USERNAME='<smoke-account>' \\",
    "MIA_SMOKE_PASSWORD='<smoke-password>' \\",
    `node mia-cloud-release/prepare-cloud-smoke-account.js ${shellQuote(publicUrl)}`,
    "MIA_SMOKE_USERNAME='<smoke-account>' \\",
    "MIA_SMOKE_PASSWORD='<smoke-password>' \\",
    "MIA_SMOKE_REQUIRE_BRIDGE=1 \\",
    `MIA_SMOKE_EXPECT_RELEASE_COMMIT=${shellQuote(expectedCommit)} \\`,
    `MIA_SMOKE_EXPECT_RELEASE_BUILT_AT=${shellQuote(expectedBuiltAt)} \\`,
    `node mia-cloud-release/smoke-cloud.js ${shellQuote(publicUrl)}`,
    "```",
    "",
    "Desktop bridge same-account control:",
    "- A desktop bridge logged into the same Mia Cloud account can be called directly from Web or mobile.",
    "- This does not require a separate local approval click for the remote connection.",
    "- Agent permission mode remains the normal per-Agent execution setting; it is not device authentication.",
    "",
    "If the operator is using the standalone local Agent bridge instead of the desktop app, start it from a full Mia project checkout on the bridge machine with the same smoke account first. This command is not run from the extracted Cloud release directory:",
    "```bash",
    "cd /path/to/mia",
    `MIA_CLOUD_URL=${shellQuote(publicUrl)} \\`,
    "MIA_CLOUD_USERNAME='<smoke-account>' \\",
    "MIA_CLOUD_PASSWORD='<smoke-password>' \\",
    "npm run bridge",
    "```",
    "",
    "Do not mark production complete until doctor and smoke both pass against the public URL."
  ].join("\n");
}

function writeHandoffFile({
  distDir = path.join(root, "dist"),
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://aiweb.buytb01.com",
  sshPublicKeyPath = process.env.MIA_DEPLOY_PUBLIC_KEY || path.join(os.homedir(), ".ssh", "id_ed25519.pub"),
  outputPath = path.join(distDir, "mia-cloud-release-handoff.txt")
} = {}) {
  const handoff = `${buildHandoff({ distDir, publicUrl, sshPublicKeyPath })}\n`;
  fs.writeFileSync(outputPath, handoff);
  return outputPath;
}

function verifyHandoffFile({
  distDir = path.join(root, "dist"),
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://aiweb.buytb01.com",
  sshPublicKeyPath = process.env.MIA_DEPLOY_PUBLIC_KEY || path.join(os.homedir(), ".ssh", "id_ed25519.pub"),
  outputPath = path.join(distDir, "mia-cloud-release-handoff.txt")
} = {}) {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Missing release handoff file: ${outputPath}`);
  }
  const expected = `${buildHandoff({ distDir, publicUrl, sshPublicKeyPath })}\n`;
  const actual = readText(outputPath);
  if (actual !== expected) {
    throw new Error(`Release handoff file is stale or does not match current artifacts: ${outputPath}`);
  }
  return outputPath;
}

function buildTransferInstallScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ARCHIVE="$SCRIPT_DIR/mia-cloud-release.tgz"',
    'INSTALLER="$SCRIPT_DIR/install-cloud-release-local.sh"',
    'cd "$SCRIPT_DIR"',
    "",
    'if command -v sha256sum >/dev/null 2>&1; then',
    "  sha256sum -c TRANSFER-SHA256.txt",
    "else",
    "  shasum -a 256 -c TRANSFER-SHA256.txt",
    "fi",
    "",
    'tar -xOf "$ARCHIVE" mia-cloud-release/install-cloud-release-local.sh > "$INSTALLER"',
    'chmod +x "$INSTALLER"',
    'MIA_INSTALL_VERIFY_ONLY=1 bash "$INSTALLER" "$ARCHIVE"',
    "",
    'if [ "${MIA_TRANSFER_VERIFY_ONLY:-}" = "1" ]; then',
    '  echo "Mia Cloud transfer bundle verify-only completed: $ARCHIVE"',
    "  exit 0",
    "fi",
    "",
    'bash "$INSTALLER" "$ARCHIVE"',
    ""
  ].join("\n");
}

function buildTransferReadme({ publicUrl, expectedCommit, expectedBuiltAt }) {
  return [
    "# Mia Cloud transfer bundle",
    "",
    "This directory was extracted from `mia-cloud-release-transfer.tgz`.",
    "",
    "Verify the transfer and installer without changing system files:",
    "",
    "```bash",
    "cd /tmp",
    "MIA_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle.sh",
    "```",
    "",
    "Install after the verify-only command passes:",
    "",
    "```bash",
    "cd /tmp",
    "bash install-transfer-bundle.sh",
    "```",
    "",
    "Expected public verification after install:",
    "",
    "```bash",
    "cd /tmp",
    "tar -xzf mia-cloud-release.tgz mia-cloud-release/doctor-cloud.js mia-cloud-release/smoke-cloud.js",
    `MIA_DOCTOR_EXPECT_RELEASE_COMMIT=${shellQuote(expectedCommit)} \\`,
    `MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT=${shellQuote(expectedBuiltAt)} \\`,
    `node mia-cloud-release/doctor-cloud.js ${shellQuote(publicUrl)}`,
    `MIA_SMOKE_EXPECT_RELEASE_COMMIT=${shellQuote(expectedCommit)} \\`,
    `MIA_SMOKE_EXPECT_RELEASE_BUILT_AT=${shellQuote(expectedBuiltAt)} \\`,
    `node mia-cloud-release/smoke-cloud.js ${shellQuote(publicUrl)}`,
    "```",
    "",
    "Prepare or validate the fixed smoke account before bridge-required e2e:",
    "",
    "```bash",
    "cd /tmp",
    "tar -xzf mia-cloud-release.tgz mia-cloud-release/prepare-cloud-smoke-account.js mia-cloud-release/smoke-cloud.js",
    "MIA_SMOKE_USERNAME='<smoke-account>' \\",
    "MIA_SMOKE_PASSWORD='<smoke-password>' \\",
    `node mia-cloud-release/prepare-cloud-smoke-account.js ${shellQuote(publicUrl)}`,
    "MIA_SMOKE_USERNAME='<smoke-account>' \\",
    "MIA_SMOKE_PASSWORD='<smoke-password>' \\",
    "MIA_SMOKE_REQUIRE_BRIDGE=1 \\",
    `MIA_SMOKE_EXPECT_RELEASE_COMMIT=${shellQuote(expectedCommit)} \\`,
    `MIA_SMOKE_EXPECT_RELEASE_BUILT_AT=${shellQuote(expectedBuiltAt)} \\`,
    `node mia-cloud-release/smoke-cloud.js ${shellQuote(publicUrl)}`,
    "```",
    "",
    "Log the desktop app or standalone bridge into the same smoke account before running the bridge-required e2e command.",
    "",
    "Desktop bridge same-account control from a full Mia checkout:",
    "",
    "```bash",
    "cd /path/to/mia",
    "npm run cloud:prod:verify:e2e -- https://aiweb.buytb01.com",
    "```",
    "",
    "A desktop bridge logged into the same Mia Cloud account can be called directly from Web or mobile. It does not require a separate local approval click for the remote connection. Agent permission mode remains the normal per-Agent execution setting and is not used as device authentication.",
    "",
    "Do not mark production complete until doctor and smoke both pass against the public URL.",
    ""
  ].join("\n");
}

function writeTransferBundle({
  distDir = path.join(root, "dist"),
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://aiweb.buytb01.com",
  sshPublicKeyPath = process.env.MIA_DEPLOY_PUBLIC_KEY || path.join(os.homedir(), ".ssh", "id_ed25519.pub"),
  outputPath = path.join(distDir, "mia-cloud-release-transfer.tgz")
} = {}) {
  const archive = path.join(distDir, "mia-cloud-release.tgz");
  const shaFile = `${archive}.sha256`;
  const handoffFile = writeHandoffFile({ distDir, publicUrl, sshPublicKeyPath });
  verifyHandoffFile({ distDir, publicUrl, sshPublicKeyPath, outputPath: handoffFile });
  const manifest = JSON.parse(readText(path.join(distDir, "mia-cloud-release", "manifest.json")));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-transfer-"));
  const bundleRoot = path.join(tempDir, "mia-cloud-transfer");
  try {
    fs.mkdirSync(bundleRoot, { recursive: true });
    const copiedFiles = [
      { source: archive, name: "mia-cloud-release.tgz" },
      { source: shaFile, name: "mia-cloud-release.tgz.sha256" },
      { source: handoffFile, name: "mia-cloud-release-handoff.txt" }
    ];
    const fileNames = copiedFiles.map((file) => file.name);
    for (const file of copiedFiles) {
      const target = path.join(bundleRoot, file.name);
      fs.copyFileSync(file.source, target);
    }
    const transferInstallerName = "install-transfer-bundle.sh";
    fs.writeFileSync(path.join(bundleRoot, transferInstallerName), buildTransferInstallScript());
    fs.chmodSync(path.join(bundleRoot, transferInstallerName), 0o755);
    fileNames.push(transferInstallerName);
    const transferReadmeName = "TRANSFER-README.md";
    fs.writeFileSync(path.join(bundleRoot, transferReadmeName), buildTransferReadme({
      publicUrl,
      expectedCommit: String(manifest.source?.gitCommit || ""),
      expectedBuiltAt: String(manifest.builtAt || "")
    }));
    fileNames.push(transferReadmeName);
    const transferHashes = fileNames.map((name) => `${sha256File(path.join(bundleRoot, name))}  ${name}`);
    fs.writeFileSync(path.join(bundleRoot, "TRANSFER-SHA256.txt"), `${transferHashes.join("\n")}\n`);
    fs.rmSync(outputPath, { force: true });
    childProcess.execFileSync("tar", ["-czf", outputPath, "-C", tempDir, "mia-cloud-transfer"], {
      stdio: "ignore"
    });
    fs.writeFileSync(`${outputPath}.sha256`, `${sha256File(outputPath)}  ${path.basename(outputPath)}\n`);
    return outputPath;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyTransferBundle({
  outputPath = path.join(root, "dist", "mia-cloud-release-transfer.tgz")
} = {}) {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Missing release transfer bundle: ${outputPath}`);
  }
  const sidecarPath = `${outputPath}.sha256`;
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`Missing release transfer bundle checksum: ${sidecarPath}`);
  }
  const expectedArchiveSha = readSha256(sidecarPath).toLowerCase();
  const actualArchiveSha = sha256File(outputPath);
  if (expectedArchiveSha !== actualArchiveSha) {
    throw new Error(
      `Transfer bundle archive checksum mismatch: ${expectedArchiveSha} in ${sidecarPath}, ${actualArchiveSha} for ${outputPath}`
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-transfer-verify-"));
  const requiredFiles = new Set([
    "mia-cloud-release.tgz",
    "mia-cloud-release.tgz.sha256",
    "mia-cloud-release-handoff.txt",
    "install-transfer-bundle.sh",
    "TRANSFER-README.md"
  ]);

  try {
    childProcess.execFileSync("tar", ["-xzf", outputPath, "-C", tempDir], { stdio: "ignore" });
    const bundleRoot = path.join(tempDir, "mia-cloud-transfer");
    const checksumPath = path.join(bundleRoot, "TRANSFER-SHA256.txt");
    if (!fs.existsSync(checksumPath)) {
      throw new Error(`Transfer bundle is missing TRANSFER-SHA256.txt: ${outputPath}`);
    }

    const seen = new Set();
    const lines = readText(checksumPath).split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      const match = line.match(/^([a-fA-F0-9]{64})\s+(.+)$/);
      if (!match) {
        throw new Error(`Transfer bundle checksum line is invalid: ${line}`);
      }
      const expectedSha = match[1].toLowerCase();
      const name = match[2].trim();
      if (!requiredFiles.has(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error(`Transfer bundle checksum references unexpected file: ${name}`);
      }
      const filePath = path.join(bundleRoot, name);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Transfer bundle is missing listed file: ${name}`);
      }
      const actualSha = sha256File(filePath);
      if (actualSha !== expectedSha) {
        throw new Error(`Transfer bundle checksum mismatch for ${name}: expected ${expectedSha}, got ${actualSha}`);
      }
      seen.add(name);
    }

    for (const name of requiredFiles) {
      if (!seen.has(name)) {
        throw new Error(`Transfer bundle checksum manifest is missing required file: ${name}`);
      }
    }
    return outputPath;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes("--write")) {
    const outputPath = writeHandoffFile();
    console.log(`Mia Cloud release handoff written: ${outputPath}`);
    return;
  }
  if (process.argv.includes("--bundle")) {
    const outputPath = writeTransferBundle();
    console.log(`Mia Cloud release transfer bundle written: ${outputPath}`);
    return;
  }
  if (process.argv.includes("--verify-bundle")) {
    const outputPath = verifyTransferBundle();
    console.log(`Mia Cloud release transfer bundle verified: ${outputPath}`);
    return;
  }
  if (process.argv.includes("--verify-file")) {
    const outputPath = verifyHandoffFile();
    console.log(`Mia Cloud release handoff verified: ${outputPath}`);
    return;
  }
  if (process.argv.includes("--ssh-authorize")) {
    console.log(buildSshAuthorizationHelp());
    return;
  }
  console.log(buildHandoff());
}

if (require.main === module) {
  main();
}

module.exports = {
  buildHandoff,
  buildSshAuthorizationHelp,
  authorizedKeysInstallCommand,
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
};
