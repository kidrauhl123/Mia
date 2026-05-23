#!/usr/bin/env node

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "aimashi-cloud-release");
const apiDir = path.join(distDir, "api");
const webDir = path.join(distDir, "web");
const rootPackage = require("../package.json");

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, source), target);
}

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, source), target, { recursive: true });
}

function writeIcoFromPng(sourcePng, targetIco) {
  const png = fs.readFileSync(sourcePng);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(192, 6);
  header.writeUInt8(192, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  fs.writeFileSync(targetIco, Buffer.concat([header, png]));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertFile(relativePath) {
  const fullPath = path.join(distDir, relativePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Release is missing ${relativePath}`);
  return fullPath;
}

function commandOutput(command, args) {
  try {
    return childProcess.execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function listFiles(dir, prefix = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function writeReleaseManifest() {
  const files = {};
  for (const file of listFiles(distDir)) {
    if (file === "manifest.json") continue;
    files[file] = sha256File(path.join(distDir, file));
  }
  const gitCommit = commandOutput("git", ["rev-parse", "--short=12", "HEAD"]);
  const gitStatus = commandOutput("git", ["status", "--porcelain"]);
  writeJson(path.join(distDir, "manifest.json"), {
    product: "Aimashi Cloud",
    version: rootPackage.version || "",
    builtAt: new Date().toISOString(),
    source: {
      gitCommit,
      gitDirty: Boolean(gitStatus),
      gitStatusLines: gitStatus ? gitStatus.split("\n").length : 0
    },
    api: {
      entry: "api/server.js",
      install: "cd /opt/aimashi-cloud && npm install --omit=dev"
    },
    web: {
      root: "web"
    },
    smoke: "node smoke-cloud.js https://aiweb.buytb01.com",
    files
  });
}

function writeReleaseReadme() {
  fs.writeFileSync(path.join(distDir, "README.md"), `# Aimashi Cloud Release

This archive contains the deployable Aimashi Cloud API, Web assets, installer, smoke test, smoke-account preparation helper, doctor, and release manifest.

## Verify Before Install

\`\`\`bash
AIMASHI_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local.sh /tmp/aimashi-cloud-release.tgz
node doctor-cloud.js https://aiweb.buytb01.com
\`\`\`

If SSH deploy access is denied from the development Mac, run this from a full Aimashi project checkout to collect a filtered public-key authentication trace:

\`\`\`bash
npm run cloud:deploy:ssh-diagnose
\`\`\`

The release archive also includes \`diagnose-deploy-ssh.js\` for operators who copy the helper back into a full checkout or run it with Node on the development machine. The diagnostic prints ssh-agent identity status and filtered \`ssh -vvv\` authentication lines; it does not print private-key material.

If this archive has already been extracted and the original tarball is not in the current directory, run the verify command from the directory that contains \`aimashi-cloud-release.tgz\`, or pass the absolute path to the tarball.

## Install On The VPS

\`\`\`bash
cd /tmp
tar -xOf aimashi-cloud-release.tgz aimashi-cloud-release/install-cloud-release-local.sh > install-cloud-release-local.sh
chmod +x install-cloud-release-local.sh
./install-cloud-release-local.sh /tmp/aimashi-cloud-release.tgz
\`\`\`

The installer verifies the archive checksum and manifest hashes, creates or reuses the dedicated service user, backs up data/API/Web/systemd files, installs the new API and Web assets, restarts systemd, runs smoke, and rolls back on install or smoke failure.

## Verify After Install

\`\`\`bash
AIMASHI_DOCTOR_EXPECT_RELEASE_COMMIT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")" \\
AIMASHI_DOCTOR_EXPECT_RELEASE_BUILT_AT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.builtAt || ''))")" \\
node doctor-cloud.js https://aiweb.buytb01.com
AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")" \\
AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.builtAt || ''))")" \\
node smoke-cloud.js https://aiweb.buytb01.com
\`\`\`

## Verify Desktop Bridge E2E

Prepare or validate a dedicated smoke account, log the desktop app into that same account, then run:

\`\`\`bash
AIMASHI_SMOKE_USERNAME="<smoke-account>" \\
AIMASHI_SMOKE_PASSWORD="<smoke-password>" \\
node prepare-cloud-smoke-account.js https://aiweb.buytb01.com
\`\`\`

\`\`\`bash
AIMASHI_SMOKE_USERNAME="<smoke-account>" \\
AIMASHI_SMOKE_PASSWORD="<smoke-password>" \\
AIMASHI_SMOKE_REQUIRE_BRIDGE=1 \\
AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")" \\
AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.builtAt || ''))")" \\
node smoke-cloud.js https://aiweb.buytb01.com
\`\`\`

The bridge smoke fails unless the public Cloud has an online desktop bridge for the same account and the assistant reply contains \`aimashi-cloud-bridge-smoke-ok\`. A desktop bridge logged into the same Aimashi Cloud account can be called directly from Web or mobile; it does not require a separate local approval click for the remote connection. Agent permission mode remains the normal per-Agent execution setting (Ask/YOLO/Deny or external-engine defaults) and is not used as device authentication.

If the operator is using the standalone local Agent bridge instead of the desktop app, start it from a full Aimashi project checkout on the bridge machine with the same smoke account before running the bridge smoke. This command is not run from the extracted Cloud release directory:

\`\`\`bash
cd /path/to/aimashi
AIMASHI_CLOUD_URL=https://aiweb.buytb01.com \\
AIMASHI_CLOUD_USERNAME="<smoke-account>" \\
AIMASHI_CLOUD_PASSWORD="<smoke-password>" \\
npm run bridge
\`\`\`

See \`cloud-deployment.md\` for nginx, systemd, rollback, and end-to-end desktop bridge smoke details.
`);
}

function writeNginxConfigs() {
  const nginxDir = path.join(distDir, "nginx");
  fs.mkdirSync(nginxDir, { recursive: true });
  fs.writeFileSync(path.join(nginxDir, "aimashi-websocket-map.conf"), `map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
`);
  fs.writeFileSync(path.join(nginxDir, "aimashi-cloud-site.conf"), `server {
    listen 80;
    server_name aiweb.buytb01.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name aiweb.buytb01.com;

    ssl_certificate /etc/letsencrypt/live/aiweb.buytb01.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aiweb.buytb01.com/privkey.pem;

    root /var/www/aimashi-web;
    index index.html;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    client_max_body_size 18m;

    location = /favicon.ico {
        try_files $uri =404;
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    location = /manifest.webmanifest {
        types { application/manifest+json webmanifest; }
        try_files $uri =404;
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4175;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Sec-WebSocket-Protocol $http_sec_websocket_protocol;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`);
}

function verifyRelease() {
  const requiredFiles = [
    "README.md",
    "api/server.js",
    "api/package.json",
    "api/src/cloud/sqlite-store.js",
    "api/src/cloud/social-store.js",
    "api/src/cloud/messages-store.js",
    "api/src/cloud/dm-room.js",
    "api/src/cloud/desktop-sync.js",
    "api/src/cloud/desktop-bridge-permission.js",
    "api/src/permission-modes.js",
    "web/index.html",
    "web/app.js",
    "web/appearance.js",
    "web/styles.css",
    "web/favicon.svg",
    "web/favicon.ico",
    "web/apple-touch-icon.png",
    "web/icon-192.png",
    "web/icon-512.png",
    "web/manifest.webmanifest",
    "smoke-cloud.js",
    "prepare-cloud-smoke-account.js",
    "doctor-cloud.js",
    "diagnose-deploy-ssh.js",
    "install-cloud-release-local.sh",
    "cloud-deployment.md",
    "nginx/aimashi-websocket-map.conf",
    "nginx/aimashi-cloud-site.conf",
    "manifest.json"
  ];
  for (const file of requiredFiles) assertFile(file);

  for (const file of [
    "api/server.js",
    "api/src/cloud/sqlite-store.js",
    "api/src/cloud/social-store.js",
    "api/src/cloud/messages-store.js",
    "api/src/cloud/dm-room.js",
    "api/src/cloud/desktop-sync.js",
    "api/src/cloud/desktop-bridge-permission.js",
    "api/src/permission-modes.js",
    "web/app.js",
    "web/appearance.js",
    "smoke-cloud.js",
    "prepare-cloud-smoke-account.js",
    "doctor-cloud.js",
    "diagnose-deploy-ssh.js"
  ]) {
    childProcess.execFileSync(process.execPath, ["--check", assertFile(file)], {
      stdio: "inherit"
    });
  }
  childProcess.execFileSync("bash", ["-n", assertFile("install-cloud-release-local.sh")], {
    stdio: "inherit"
  });

  const smokeSource = fs.readFileSync(assertFile("smoke-cloud.js"), "utf8");
  if (/require\(["']ws["']\)/.test(smokeSource)) {
    throw new Error("Release smoke script must not depend on repository-local ws.");
  }
  const deploymentDoc = fs.readFileSync(assertFile("cloud-deployment.md"), "utf8");
  if (!/map\s+\$http_upgrade\s+\$connection_upgrade/.test(deploymentDoc)) {
    throw new Error("Deployment doc must define nginx $connection_upgrade map for WebSockets.");
  }
  if (!/proxy_set_header\s+Sec-WebSocket-Protocol\s+\$http_sec_websocket_protocol/.test(deploymentDoc)) {
    throw new Error("Deployment doc must preserve the WebSocket Sec-WebSocket-Protocol header.");
  }
  if (!/nginx -t/.test(deploymentDoc)) {
    throw new Error("Deployment doc must require nginx -t before reload.");
  }
  const nginxMap = fs.readFileSync(assertFile("nginx/aimashi-websocket-map.conf"), "utf8");
  if (!/map\s+\$http_upgrade\s+\$connection_upgrade/.test(nginxMap)) {
    throw new Error("Release nginx map must define $connection_upgrade for WebSockets.");
  }
  const nginxSite = fs.readFileSync(assertFile("nginx/aimashi-cloud-site.conf"), "utf8");
  if (!/proxy_set_header\s+Sec-WebSocket-Protocol\s+\$http_sec_websocket_protocol/.test(nginxSite)) {
    throw new Error("Release nginx site must preserve the WebSocket Sec-WebSocket-Protocol header.");
  }
  if (!/add_header\s+Strict-Transport-Security/.test(nginxSite)) {
    throw new Error("Release nginx site must send HTTPS HSTS.");
  }
  if (!/location\s+=\s+\/favicon\.ico\s+\{[\s\S]*try_files\s+\$uri\s+=404;/.test(nginxSite)) {
    throw new Error("Release nginx site must serve /favicon.ico as a real static icon.");
  }
  if (!/location\s+=\s+\/manifest\.webmanifest\s+\{[\s\S]*application\/manifest\+json\s+webmanifest/.test(nginxSite)) {
    throw new Error("Release nginx site must serve /manifest.webmanifest with application/manifest+json.");
  }
  if (
    !/ssl_certificate\s+\/etc\/letsencrypt\/live\/aiweb\.buytb01\.com\/fullchain\.pem/.test(nginxSite) ||
    !/ssl_certificate_key\s+\/etc\/letsencrypt\/live\/aiweb\.buytb01\.com\/privkey\.pem/.test(nginxSite)
  ) {
    throw new Error("Release nginx site must include TLS certificate paths.");
  }
  if (!/return\s+301\s+https:\/\/\$host\$request_uri/.test(nginxSite)) {
    throw new Error("Release nginx site must redirect HTTP to HTTPS.");
  }
  const releaseReadme = fs.readFileSync(assertFile("README.md"), "utf8");
  if (!/AIMASHI_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local\.sh \/tmp\/aimashi-cloud-release\.tgz/.test(releaseReadme)) {
    throw new Error("Release README must document verify-only local install.");
  }
  if (
    !/AIMASHI_DOCTOR_EXPECT_RELEASE_COMMIT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.source\?\.gitCommit \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/AIMASHI_DOCTOR_EXPECT_RELEASE_BUILT_AT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.builtAt \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/node doctor-cloud\.js https:\/\/aiweb\.buytb01\.com/.test(releaseReadme) ||
    !/AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.source\?\.gitCommit \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.builtAt \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/node smoke-cloud\.js https:\/\/aiweb\.buytb01\.com/.test(releaseReadme)
  ) {
    throw new Error("Release README must document expected-release public doctor and smoke verification.");
  }
  if (
    !/node prepare-cloud-smoke-account\.js https:\/\/aiweb\.buytb01\.com/.test(releaseReadme) ||
    !/full Aimashi project checkout/.test(releaseReadme) ||
    !/not run from the extracted Cloud release directory/.test(releaseReadme) ||
    !/cd \/path\/to\/aimashi/.test(releaseReadme) ||
    !/AIMASHI_CLOUD_URL=https:\/\/aiweb\.buytb01\.com/.test(releaseReadme) ||
    !/AIMASHI_CLOUD_USERNAME="<smoke-account>"/.test(releaseReadme) ||
    !/AIMASHI_CLOUD_PASSWORD="<smoke-password>"/.test(releaseReadme) ||
    !/npm run bridge/.test(releaseReadme)
  ) {
    throw new Error("Release README must document standalone bridge same-account startup from a full project checkout.");
  }
  if (
    !/same Aimashi Cloud account/.test(releaseReadme) ||
    !/does not require a separate local approval click/.test(releaseReadme) ||
    !/Agent permission mode remains/.test(releaseReadme) ||
    !/device authentication/.test(releaseReadme)
  ) {
    throw new Error("Release README must document same-account desktop bridge control without a separate remote approval gate.");
  }

  childProcess.execFileSync(process.execPath, ["-e", `
    require(${JSON.stringify(assertFile("api/src/cloud/sqlite-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/social-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/messages-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/dm-room.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/desktop-sync.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/desktop-bridge-permission.js"))});
    require(${JSON.stringify(assertFile("api/src/permission-modes.js"))});
    require(${JSON.stringify(assertFile("api/server.js"))});
  `], {
    stdio: "inherit"
  });

  const manifest = JSON.parse(fs.readFileSync(assertFile("manifest.json"), "utf8"));
  if (manifest.product !== "Aimashi Cloud") throw new Error("Release manifest has the wrong product.");
  if (!manifest.builtAt || !manifest.files || typeof manifest.files !== "object") {
    throw new Error("Release manifest is missing build metadata or file hashes.");
  }
  for (const file of requiredFiles) {
    if (file === "manifest.json") continue;
    if (!manifest.files[file]) throw new Error(`Release manifest is missing a hash for ${file}`);
  }
  for (const [file, expectedHash] of Object.entries(manifest.files)) {
    const fullPath = assertFile(file);
    const actualHash = sha256File(fullPath);
    if (actualHash !== expectedHash) {
      throw new Error(`Release manifest hash mismatch for ${file}`);
    }
  }
}

function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(apiDir, { recursive: true });
  fs.mkdirSync(webDir, { recursive: true });

  copyFile("scripts/serve-cloud.js", path.join(apiDir, "server.js"));
  copyDir("src/cloud", path.join(apiDir, "src", "cloud"));
  copyFile("src/permission-modes.js", path.join(apiDir, "src", "permission-modes.js"));
  copyDir("src/web", webDir);
  copyFile("src/shared/time-format.js", path.join(webDir, "shared", "time-format.js"));
  copyFile("src/shared/message-spec.js", path.join(webDir, "shared", "message-spec.js"));
  copyFile("src/shared/contact.js", path.join(webDir, "shared", "contact.js"));
  copyFile("src/renderer/message-sources/cloud-room-source.js", path.join(webDir, "message-sources", "cloud-room-source.js"));
  writeIcoFromPng(path.join(webDir, "icon-192.png"), path.join(webDir, "favicon.ico"));
  copyFile("scripts/smoke-cloud.js", path.join(distDir, "smoke-cloud.js"));
  copyFile("scripts/prepare-cloud-smoke-account.js", path.join(distDir, "prepare-cloud-smoke-account.js"));
  copyFile("scripts/doctor-cloud.js", path.join(distDir, "doctor-cloud.js"));
  copyFile("scripts/diagnose-deploy-ssh.js", path.join(distDir, "diagnose-deploy-ssh.js"));
  copyFile("scripts/install-cloud-release-local.sh", path.join(distDir, "install-cloud-release-local.sh"));
  copyFile("docs/cloud-deployment.md", path.join(distDir, "cloud-deployment.md"));
  writeReleaseReadme();
  writeNginxConfigs();

  writeJson(path.join(apiDir, "package.json"), {
    name: "aimashi-cloud-api",
    version: rootPackage.version || "0.0.0",
    private: true,
    type: "commonjs",
    scripts: {
      start: "node server.js"
    },
    dependencies: {
      ws: rootPackage.dependencies?.ws || "^8.20.1"
    }
  });

  writeReleaseManifest();

  verifyRelease();

  const archive = path.join(root, "dist", "aimashi-cloud-release.tgz");
  const archiveSha = `${archive}.sha256`;
  fs.rmSync(archive, { force: true });
  fs.rmSync(archiveSha, { force: true });
  childProcess.execFileSync("tar", ["-czf", archive, "-C", path.join(root, "dist"), "aimashi-cloud-release"], {
    stdio: "inherit"
  });
  fs.writeFileSync(archiveSha, `${sha256File(archive)}  ${path.basename(archive)}\n`);

  console.log(`Aimashi Cloud release directory: ${distDir}`);
  console.log(`Aimashi Cloud release archive: ${archive}`);
  console.log(`Aimashi Cloud release SHA-256: ${archiveSha}`);
}

main();
