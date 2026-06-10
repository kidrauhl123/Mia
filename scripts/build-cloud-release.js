#!/usr/bin/env node

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "mia-cloud-release");
const apiDir = path.join(distDir, "api");
const webDir = path.join(distDir, "web");
const hermesImageDir = path.join(distDir, "hermes-image");
const rootPackage = require("../package.json");
const { pluginFiles } = require("../src/main/engine-plugins-service.js");
const releaseAssetStamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 14);

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, source), target);
}

function shouldCopyReleaseEntry(sourcePath) {
  return path.basename(sourcePath) !== ".DS_Store";
}

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, source), target, { recursive: true, filter: shouldCopyReleaseEntry });
}

function newestDesktopDmg(sourcePatterns) {
  const releaseDir = path.join(root, "release");
  if (!fs.existsSync(releaseDir)) return "";
  return fs.readdirSync(releaseDir)
    .map((file) => {
      const sourcePattern = sourcePatterns.find((pattern) => pattern.test(file));
      if (!sourcePattern) return null;
      const fullPath = path.join(releaseDir, file);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs, sourcePattern: sourcePattern.label };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.fullPath || "";
}

function copyDesktopDownloadArtifacts() {
  const downloadsDir = path.join(webDir, "downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });
  const targets = [
    {
      aliases: ["mia-macos-apple-silicon-latest.dmg", "mia-macos-arm64-latest.dmg"],
      patterns: [
        {
          label: "Mia-*-Apple-Silicon.dmg",
          test: (file) => /^Mia-.*-Apple-Silicon\.dmg$/.test(file)
        },
        {
          label: "Mia-*-arm64-unsigned.dmg",
          test: (file) => /^Mia-.*-arm64-unsigned\.dmg$/.test(file)
        }
      ]
    },
    {
      aliases: ["mia-macos-intel-latest.dmg", "mia-macos-x64-latest.dmg"],
      patterns: [
        {
          label: "Mia-*-Intel.dmg",
          test: (file) => /^Mia-.*-Intel\.dmg$/.test(file)
        },
        {
          label: "Mia-*-x64-unsigned.dmg",
          test: (file) => /^Mia-.*-x64-unsigned\.dmg$/.test(file)
        }
      ]
    }
  ];
  for (const target of targets) {
    const dmg = newestDesktopDmg(target.patterns);
    if (!dmg) continue;
    for (const alias of target.aliases) {
      fs.copyFileSync(dmg, path.join(downloadsDir, alias));
    }
  }
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

function assetVersionForRelease() {
  const gitCommit = commandOutput("git", ["rev-parse", "--short=12", "HEAD"]);
  return `${gitCommit || rootPackage.version || "dev"}-${releaseAssetStamp}`.replace(/[^A-Za-z0-9._-]/g, "");
}

function rewriteWebAssetVersions() {
  const indexPath = path.join(webDir, "app", "index.html");
  const assetVersion = assetVersionForRelease();
  const source = fs.readFileSync(indexPath, "utf8");
  fs.writeFileSync(indexPath, source.replace(/\?v=[^"'\s<>]+/g, `?v=${assetVersion}`));
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
    if (entry.name === ".DS_Store") continue;
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
    product: "Mia Cloud",
    version: rootPackage.version || "",
    builtAt: new Date().toISOString(),
    source: {
      gitCommit,
      gitDirty: Boolean(gitStatus),
      gitStatusLines: gitStatus ? gitStatus.split("\n").length : 0
    },
    api: {
      entry: "api/server.js",
      install: "cd /opt/mia-cloud && npm install --omit=dev"
    },
    web: {
      root: "web"
    },
    smoke: "node smoke-cloud.js https://mia.gifgif.cn",
    files
  });
}

function writeHermesImageContext() {
  copyFile("cloud/hermes-image/Dockerfile", path.join(hermesImageDir, "Dockerfile"));
  copyFile("cloud/hermes-image/entrypoint.sh", path.join(hermesImageDir, "entrypoint.sh"));

  const pluginDir = path.join(hermesImageDir, "mia_plugins");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [fileName, content] of Object.entries(pluginFiles())) {
    fs.writeFileSync(path.join(pluginDir, fileName), content);
  }

  const dockerfile = path.join(hermesImageDir, "Dockerfile");
  const source = fs.readFileSync(dockerfile, "utf8");
  fs.writeFileSync(
    dockerfile,
    source.replace(/ARG HERMES_VERSION=.*/, `ARG HERMES_VERSION=${rootPackage.hermes?.version || "2026.5.7"}`)
  );
}

function writeReleaseReadme() {
  fs.writeFileSync(path.join(distDir, "README.md"), `# Mia Cloud Release

This archive contains the deployable Mia Cloud API, Web assets, installer, smoke test, smoke-account preparation helper, doctor, and release manifest.

## Verify Before Install

\`\`\`bash
MIA_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local.sh /tmp/mia-cloud-release.tgz
node doctor-cloud.js https://mia.gifgif.cn
\`\`\`

If SSH deploy access is denied from the development Mac, run this from a full Mia project checkout to collect a filtered public-key authentication trace:

\`\`\`bash
npm run cloud:deploy:ssh-diagnose
\`\`\`

The release archive also includes \`diagnose-deploy-ssh.js\` for operators who copy the helper back into a full checkout or run it with Node on the development machine. The diagnostic prints ssh-agent identity status and filtered \`ssh -vvv\` authentication lines; it does not print private-key material.

If this archive has already been extracted and the original tarball is not in the current directory, run the verify command from the directory that contains \`mia-cloud-release.tgz\`, or pass the absolute path to the tarball.

## Platform Model Gateway

Cloud Hermes workers use the platform model supplied through LiteLLM Proxy. Configure provider keys from the Mia admin page at \`/admin/model\`; it writes the \`mia-default\` model alias into LiteLLM over the private admin API. The release includes a \`hermes-image/\` Docker build context and the installer builds \`MIA_CLOUD_HERMES_IMAGE\` on the VPS, so worker startup does not depend on pulling a private external image. On China-hosted VPS networks, set \`MIA_DEBIAN_APT_MIRROR=https://mirrors.tencent.com/debian\` and \`MIA_PIP_INDEX_URL=https://mirrors.tencent.com/pypi/simple\` before running the installer if upstream Debian/PyPI downloads hang. If \`MIA_CLOUD_HERMES_IMAGE\` is already present on the VPS and the Hermes version did not change, set \`MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD=1\` to skip rebuilding after first verifying that image exists. The service still needs \`MIA_CLOUD_AGENT_MODEL_BASE_URL=http://litellm:4000/v1\`, \`MIA_CLOUD_AGENT_MODEL=mia-default\`, \`MIA_CLOUD_AGENT_MODEL_API_KEY=<LiteLLM virtual key>\`, \`LITELLM_MASTER_KEY=<LiteLLM admin key>\`, and \`MIA_CLOUD_ADMIN_USERNAME/PASSWORD\` in systemd or \`/etc/mia-cloud/admin.env\`. Do not expose the LiteLLM UI directly on the public internet.

## Install On The VPS

\`\`\`bash
cd /tmp
tar -xOf mia-cloud-release.tgz mia-cloud-release/install-cloud-release-local.sh > install-cloud-release-local.sh
chmod +x install-cloud-release-local.sh
./install-cloud-release-local.sh /tmp/mia-cloud-release.tgz
\`\`\`

The installer verifies the archive checksum and manifest hashes, creates or reuses the dedicated service user, backs up data/API/Web/systemd files, installs the new API and Web assets, restarts systemd, runs smoke, and rolls back on install or smoke failure.

## Verify After Install

\`\`\`bash
MIA_DOCTOR_EXPECT_RELEASE_COMMIT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")" \\
MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.builtAt || ''))")" \\
node doctor-cloud.js https://mia.gifgif.cn
MIA_SMOKE_EXPECT_RELEASE_COMMIT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")" \\
MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.builtAt || ''))")" \\
node smoke-cloud.js https://mia.gifgif.cn
node verify-site-verification.js https://mia.gifgif.cn
\`\`\`

## Verify Desktop Bridge E2E

Prepare or validate a dedicated smoke account, log the desktop app into that same account, then run:

\`\`\`bash
MIA_SMOKE_USERNAME="<smoke-account>" \\
MIA_SMOKE_PASSWORD="<smoke-password>" \\
node prepare-cloud-smoke-account.js https://mia.gifgif.cn
\`\`\`

\`\`\`bash
MIA_SMOKE_USERNAME="<smoke-account>" \\
MIA_SMOKE_PASSWORD="<smoke-password>" \\
MIA_SMOKE_REQUIRE_BRIDGE=1 \\
MIA_SMOKE_EXPECT_RELEASE_COMMIT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.source?.gitCommit || ''))")" \\
MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="$(node -e "const m=require('./manifest.json'); process.stdout.write(String(m.builtAt || ''))")" \\
node smoke-cloud.js https://mia.gifgif.cn
\`\`\`

The bridge smoke fails unless the public Cloud has an online desktop bridge for the same account and the assistant reply contains \`mia-cloud-bridge-smoke-ok\`. A desktop bridge logged into the same Mia Cloud account can be called directly from Web or mobile; it does not require a separate local approval click for the remote connection. Agent permission mode remains the normal per-Agent execution setting (Ask/YOLO/Deny or external-engine defaults) and is not used as device authentication.

If the operator is using the standalone local Agent bridge instead of the desktop app, start it from a full Mia project checkout on the bridge machine with the same smoke account before running the bridge smoke. This command is not run from the extracted Cloud release directory:

\`\`\`bash
cd /path/to/mia
MIA_CLOUD_URL=https://mia.gifgif.cn \\
MIA_CLOUD_USERNAME="<smoke-account>" \\
MIA_CLOUD_PASSWORD="<smoke-password>" \\
npm run bridge
\`\`\`

See \`cloud-deployment.md\` for nginx, systemd, rollback, and end-to-end desktop bridge smoke details.
`);
}

function writeNginxConfigs() {
  const nginxDir = path.join(distDir, "nginx");
  fs.mkdirSync(nginxDir, { recursive: true });
  fs.writeFileSync(path.join(nginxDir, "mia-websocket-map.conf"), `map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
`);
  fs.writeFileSync(path.join(nginxDir, "mia-cloud-site.conf"), `server {
    listen 80;
    server_name mia.gifgif.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mia.gifgif.cn;

    ssl_certificate /etc/letsencrypt/live/mia.gifgif.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mia.gifgif.cn/privkey.pem;

    root /var/www/mia-web;
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

    location = / {
        try_files /index.html =404;
        add_header Cache-Control "no-cache";
    }

    location = /index.html {
        try_files /index.html =404;
        add_header Cache-Control "no-cache";
    }

    location = /app/ {
        try_files /app/index.html =404;
        add_header Cache-Control "no-cache";
    }

    location = /app/index.html {
        try_files /app/index.html =404;
        add_header Cache-Control "no-cache";
    }

    location = /updates/latest-mac.yml {
        alias /var/www/mia-updates/latest-mac.yml;
        default_type application/x-yaml;
        add_header Cache-Control "no-cache" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    }

    location = /updates/latest.yml {
        alias /var/www/mia-updates/latest.yml;
        default_type application/x-yaml;
        add_header Cache-Control "no-cache" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    }

    location /updates/ {
        alias /var/www/mia-updates/;
        autoindex off;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    }

    location = /admin {
        proxy_pass http://127.0.0.1:4175;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }

    location /admin/ {
        proxy_pass http://127.0.0.1:4175;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
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
    "api/src/cloud/dm-conversation.js",
    "api/src/cloud/desktop-bridge-permission.js",
    "api/src/cloud/hermes-skills-source.js",
    "api/src/cloud-agent/runtime-bindings-store.js",
    "api/src/cloud-agent/cloud-agent-runs-store.js",
    "api/src/cloud-agent/attachment-materializer.js",
    "api/src/cloud-agent/group-orchestrator.js",
    "api/src/cloud-agent/hermes-worker-manager.js",
    "api/src/cloud-agent/hermes-runs-client.js",
    "api/src/cloud-agent/dispatcher.js",
    "api/src/shared/conversation-kinds.js",
    "api/src/shared/cloud-events.js",
    "api/src/shared/engine-contracts.js",
    "api/src/shared/ids.js",
    "api/src/shared/member-color.js",
    "api/src/shared/avatar-media.js",
    "api/src/shared/avatar-resolve.js",
    "api/packages/shared/avatar.js",
    "api/src/shared/bot-identity.js",
    "api/src/shared/identity.js",
    "api/packages/shared/bot-identity.js",
    "api/packages/shared/identity.js",
    "api/src/shared/session-history.js",
    "api/packages/shared/session-history.js",
    "api/src/shared/skill-safety.js",
    "api/src/shared/agent-permissions.js",
    "api/src/permission-modes.js",
    "api/skills/pdf/SKILL.md",
    "web/index.html",
    "web/admin-model.html",
    "web/admin-model.js",
    "web/app.js",
    "web/appearance.js",
    "web/styles.css",
    "web/assets/mia.css",
    "web/assets/mia.js",
    "web/assets/mia-gradient.css",
    "web/assets/mia-scroll.css",
    "web/assets/mia-scroll.js",
    "web/assets/mia-logo.png",
    "web/favicon.svg",
    "web/favicon.ico",
    "web/5a371047c22c89872f93f00c7d8af123.txt",
    "web/apple-touch-icon.png",
    "web/icon-192.png",
    "web/icon-512.png",
    "web/manifest.webmanifest",
    "web/shared/avatar-resolve.js",
    "web/shared/avatar-media.js",
    "web/shared/contact.js",
    "web/shared/ids.js",
    "web/shared/group-tiles.js",
    "web/shared/member-color.js",
    "web/shared/unread.js",
    "web/shared/send-pipeline.js",
    "web/shared/cloud-client.js",
    "web/shared/bot-runtime-control.js",
    "web/shared/agent-permissions.js",
    "smoke-cloud.js",
    "prepare-cloud-smoke-account.js",
    "doctor-cloud.js",
    "verify-site-verification.js",
    "diagnose-deploy-ssh.js",
    "install-cloud-release-local.sh",
    "cloud-deployment.md",
    "hermes-image/Dockerfile",
    "hermes-image/entrypoint.sh",
    "hermes-image/mia_plugins/__init__.py",
    "hermes-image/mia_plugins/__main__.py",
    "hermes-image/mia_plugins/bot_overlay.py",
    "nginx/mia-websocket-map.conf",
    "nginx/mia-cloud-site.conf",
    "manifest.json"
  ];
  for (const file of requiredFiles) assertFile(file);

  for (const file of [
    "api/server.js",
    "api/src/cloud/sqlite-store.js",
    "api/src/cloud/social-store.js",
    "api/src/cloud/messages-store.js",
    "api/src/cloud/dm-conversation.js",
    "api/src/cloud/desktop-bridge-permission.js",
    "api/src/cloud/hermes-skills-source.js",
    "api/src/cloud-agent/runtime-bindings-store.js",
    "api/src/cloud-agent/cloud-agent-runs-store.js",
    "api/src/cloud-agent/attachment-materializer.js",
    "api/src/cloud-agent/group-orchestrator.js",
    "api/src/cloud-agent/hermes-worker-manager.js",
    "api/src/cloud-agent/hermes-runs-client.js",
    "api/src/cloud-agent/dispatcher.js",
    "api/src/shared/conversation-kinds.js",
    "api/src/shared/cloud-events.js",
    "api/src/shared/engine-contracts.js",
    "api/src/shared/member-color.js",
    "api/src/shared/avatar-media.js",
    "api/src/shared/avatar-resolve.js",
    "api/packages/shared/avatar.js",
    "api/src/shared/bot-identity.js",
    "api/src/shared/identity.js",
    "api/packages/shared/bot-identity.js",
    "api/packages/shared/identity.js",
    "api/src/shared/session-history.js",
    "api/packages/shared/session-history.js",
    "api/src/shared/skill-safety.js",
    "api/src/shared/agent-permissions.js",
    "api/src/permission-modes.js",
    "web/app.js",
    "web/admin-model.js",
    "web/appearance.js",
    "smoke-cloud.js",
    "prepare-cloud-smoke-account.js",
    "doctor-cloud.js",
    "verify-site-verification.js",
    "diagnose-deploy-ssh.js"
  ]) {
    childProcess.execFileSync(process.execPath, ["--check", assertFile(file)], {
      stdio: "inherit"
    });
  }
  childProcess.execFileSync("bash", ["-n", assertFile("install-cloud-release-local.sh")], {
    stdio: "inherit"
  });
  childProcess.execFileSync("bash", ["-n", assertFile("hermes-image/entrypoint.sh")], {
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
  const nginxMap = fs.readFileSync(assertFile("nginx/mia-websocket-map.conf"), "utf8");
  if (!/map\s+\$http_upgrade\s+\$connection_upgrade/.test(nginxMap)) {
    throw new Error("Release nginx map must define $connection_upgrade for WebSockets.");
  }
  const nginxSite = fs.readFileSync(assertFile("nginx/mia-cloud-site.conf"), "utf8");
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
    !/location\s+=\s+\/updates\/latest-mac\.yml\s+\{[\s\S]*alias\s+\/var\/www\/mia-updates\/latest-mac\.yml/.test(nginxSite) ||
    !/location\s+\/updates\/\s+\{[\s\S]*alias\s+\/var\/www\/mia-updates\//.test(nginxSite)
  ) {
    throw new Error("Release nginx site must serve desktop update feed from /var/www/mia-updates.");
  }
  if (!/location\s+=\s+\/app\/\s+\{[\s\S]*add_header\s+Cache-Control\s+"no-cache";/.test(nginxSite)) {
    throw new Error("Release nginx site must revalidate the /app/ HTML shell.");
  }
  const webAppHtml = fs.readFileSync(assertFile("web/app/index.html"), "utf8");
  if (!webAppHtml.includes(`../app.js?v=${assetVersionForRelease()}`)) {
    throw new Error("Release web app shell must use the release asset version for app.js.");
  }
  if (/20260601-avatar-root/.test(webAppHtml)) {
    throw new Error("Release web app shell must not ship stale hard-coded avatar asset versions.");
  }
  if (!/location\s+\/admin\/\s+\{[\s\S]*proxy_pass\s+http:\/\/127\.0\.0\.1:4175/.test(nginxSite)) {
    throw new Error("Release nginx site must proxy /admin/ to the Mia Cloud API.");
  }
  if (
    !/ssl_certificate\s+\/etc\/letsencrypt\/live\/mia\.gifgif\.cn\/fullchain\.pem/.test(nginxSite) ||
    !/ssl_certificate_key\s+\/etc\/letsencrypt\/live\/mia\.gifgif\.cn\/privkey\.pem/.test(nginxSite)
  ) {
    throw new Error("Release nginx site must include TLS certificate paths.");
  }
  if (!/return\s+301\s+https:\/\/\$host\$request_uri/.test(nginxSite)) {
    throw new Error("Release nginx site must redirect HTTP to HTTPS.");
  }
  const releaseReadme = fs.readFileSync(assertFile("README.md"), "utf8");
  const siteVerificationText = fs.readFileSync(assertFile("web/5a371047c22c89872f93f00c7d8af123.txt"), "utf8").trim();
  if (siteVerificationText !== "24dd5141e8f881adf83372da5cd9d6f1f60f2b32") {
    throw new Error("Release web root must include the site verification txt file with the expected content.");
  }
  if (!/MIA_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local\.sh \/tmp\/mia-cloud-release\.tgz/.test(releaseReadme)) {
    throw new Error("Release README must document verify-only local install.");
  }
  if (
    !/MIA_DOCTOR_EXPECT_RELEASE_COMMIT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.source\?\.gitCommit \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.builtAt \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/node doctor-cloud\.js https:\/\/mia\.gifgif\.cn/.test(releaseReadme) ||
    !/MIA_SMOKE_EXPECT_RELEASE_COMMIT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.source\?\.gitCommit \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.builtAt \|\| ''\)\)"\)"/.test(releaseReadme) ||
    !/node smoke-cloud\.js https:\/\/mia\.gifgif\.cn/.test(releaseReadme) ||
    !/node verify-site-verification\.js https:\/\/mia\.gifgif\.cn/.test(releaseReadme)
  ) {
    throw new Error("Release README must document expected-release public doctor, smoke, and site verification.");
  }
  if (
    !/node prepare-cloud-smoke-account\.js https:\/\/mia\.gifgif\.cn/.test(releaseReadme) ||
    !/full Mia project checkout/.test(releaseReadme) ||
    !/not run from the extracted Cloud release directory/.test(releaseReadme) ||
    !/cd \/path\/to\/mia/.test(releaseReadme) ||
    !/MIA_CLOUD_URL=https:\/\/mia\.gifgif\.cn/.test(releaseReadme) ||
    !/MIA_CLOUD_USERNAME="<smoke-account>"/.test(releaseReadme) ||
    !/MIA_CLOUD_PASSWORD="<smoke-password>"/.test(releaseReadme) ||
    !/npm run bridge/.test(releaseReadme)
  ) {
    throw new Error("Release README must document standalone bridge same-account startup from a full project checkout.");
  }
  if (
    !/same Mia Cloud account/.test(releaseReadme) ||
    !/does not require a separate local approval click/.test(releaseReadme) ||
    !/Agent permission mode remains/.test(releaseReadme) ||
    !/device authentication/.test(releaseReadme)
  ) {
    throw new Error("Release README must document same-account desktop bridge control without a separate remote approval gate.");
  }
  if (
    !/LiteLLM Proxy/.test(releaseReadme) ||
    !/MIA_CLOUD_AGENT_MODEL_BASE_URL=http:\/\/litellm:4000\/v1/.test(releaseReadme) ||
    !/MIA_CLOUD_AGENT_MODEL_API_KEY=<LiteLLM virtual key>/.test(releaseReadme) ||
    !/hermes-image\/` Docker build context/.test(releaseReadme) ||
    !/\/admin\/model/.test(releaseReadme) ||
    !/Do not expose the LiteLLM UI directly/.test(releaseReadme)
  ) {
    throw new Error("Release README must document the LiteLLM platform model gateway.");
  }

  childProcess.execFileSync(process.execPath, ["-e", `
    require(${JSON.stringify(assertFile("api/src/cloud/sqlite-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/social-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/messages-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/dm-conversation.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud/desktop-bridge-permission.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/runtime-bindings-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/cloud-agent-runs-store.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/attachment-materializer.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/group-orchestrator.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/hermes-worker-manager.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/hermes-runs-client.js"))});
    require(${JSON.stringify(assertFile("api/src/cloud-agent/dispatcher.js"))});
    require(${JSON.stringify(assertFile("api/src/permission-modes.js"))});
    require(${JSON.stringify(assertFile("api/server.js"))});
  `], {
    stdio: "inherit"
  });

  const manifest = JSON.parse(fs.readFileSync(assertFile("manifest.json"), "utf8"));
  if (manifest.product !== "Mia Cloud") throw new Error("Release manifest has the wrong product.");
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
  copyDir("src/cloud-agent", path.join(apiDir, "src", "cloud-agent"));
  copyFile("src/shared/conversation-kinds.js", path.join(apiDir, "src", "shared", "conversation-kinds.js"));
  copyFile("src/shared/cloud-events.js", path.join(apiDir, "src", "shared", "cloud-events.js"));
  copyFile("src/shared/engine-contracts.js", path.join(apiDir, "src", "shared", "engine-contracts.js"));
  copyFile("src/shared/ids.js", path.join(apiDir, "src", "shared", "ids.js"));
  copyFile("src/shared/member-color.js", path.join(apiDir, "src", "shared", "member-color.js"));
  copyFile("src/shared/avatar-media.js", path.join(apiDir, "src", "shared", "avatar-media.js"));
  copyFile("src/shared/avatar-resolve.js", path.join(apiDir, "src", "shared", "avatar-resolve.js"));
  copyFile("packages/shared/avatar.js", path.join(apiDir, "packages", "shared", "avatar.js"));
  copyFile("src/shared/bot-identity.js", path.join(apiDir, "src", "shared", "bot-identity.js"));
  copyFile("src/shared/identity.js", path.join(apiDir, "src", "shared", "identity.js"));
  copyFile("packages/shared/bot-identity.js", path.join(apiDir, "packages", "shared", "bot-identity.js"));
  copyFile("packages/shared/identity.js", path.join(apiDir, "packages", "shared", "identity.js"));
  copyFile("src/shared/session-history.js", path.join(apiDir, "src", "shared", "session-history.js"));
  copyFile("packages/shared/session-history.js", path.join(apiDir, "packages", "shared", "session-history.js"));
  copyFile("src/shared/skill-safety.js", path.join(apiDir, "src", "shared", "skill-safety.js"));
  copyFile("src/shared/agent-permissions.js", path.join(apiDir, "src", "shared", "agent-permissions.js"));
  copyFile("src/permission-modes.js", path.join(apiDir, "src", "permission-modes.js"));
  copyDir("skills", path.join(apiDir, "skills"));
  copyDir("src/web", webDir);
  copyDesktopDownloadArtifacts();
  copyDir("src/renderer/assets/model-icons", path.join(webDir, "assets", "model-icons"));
  copyDir("src/renderer/assets/provider-icons", path.join(webDir, "assets", "provider-icons"));
  copyDir("src/renderer/assets/engine-icons", path.join(webDir, "assets", "engine-icons"));
  copyFile("src/shared/time-format.js", path.join(webDir, "shared", "time-format.js"));
  copyFile("src/shared/message-spec.js", path.join(webDir, "shared", "message-spec.js"));
  copyFile("packages/shared/contact.js", path.join(webDir, "shared", "contact.js"));
  copyFile("src/shared/engine-contracts.js", path.join(webDir, "shared", "engine-contracts.js"));
  copyFile("src/shared/ids.js", path.join(webDir, "shared", "ids.js"));
  copyFile("src/shared/conversation-kinds.js", path.join(webDir, "shared", "conversation-kinds.js"));
  copyFile("packages/shared/avatar.js", path.join(webDir, "shared", "member-color.js"));
  copyFile("packages/shared/avatar.js", path.join(webDir, "shared", "avatar-media.js"));
  copyFile("packages/shared/avatar.js", path.join(webDir, "shared", "avatar-resolve.js"));
  copyFile("packages/shared/session-history.js", path.join(webDir, "shared", "session-history.js"));
  copyFile("packages/shared/unread.js", path.join(webDir, "shared", "unread.js"));
  copyFile("packages/shared/group-tiles.js", path.join(webDir, "shared", "group-tiles.js"));
  copyFile("packages/shared/send-pipeline.js", path.join(webDir, "shared", "send-pipeline.js"));
  copyFile("packages/shared/cloud-client.js", path.join(webDir, "shared", "cloud-client.js"));
  copyFile("src/shared/bot-runtime-control.js", path.join(webDir, "shared", "bot-runtime-control.js"));
  copyFile("src/shared/agent-permissions.js", path.join(webDir, "shared", "agent-permissions.js"));
  copyFile("src/shared/trace-blocks.js", path.join(webDir, "shared", "trace-blocks.js"));
  copyFile("src/shared/mention-render.js", path.join(webDir, "shared", "mention-render.js"));
  copyFile("src/renderer/helpers/markdown-helpers.js", path.join(webDir, "helpers", "markdown-helpers.js"));
  copyFile("src/renderer/message-sources/cloud-conversation-source.js", path.join(webDir, "message-sources", "cloud-conversation-source.js"));
  rewriteWebAssetVersions();
  writeIcoFromPng(path.join(webDir, "icon-192.png"), path.join(webDir, "favicon.ico"));
  copyFile("scripts/smoke-cloud.js", path.join(distDir, "smoke-cloud.js"));
  copyFile("scripts/prepare-cloud-smoke-account.js", path.join(distDir, "prepare-cloud-smoke-account.js"));
  copyFile("scripts/doctor-cloud.js", path.join(distDir, "doctor-cloud.js"));
  copyFile("scripts/verify-site-verification.js", path.join(distDir, "verify-site-verification.js"));
  copyFile("scripts/diagnose-deploy-ssh.js", path.join(distDir, "diagnose-deploy-ssh.js"));
  copyFile("scripts/install-cloud-release-local.sh", path.join(distDir, "install-cloud-release-local.sh"));
  copyFile("docs/cloud-deployment.md", path.join(distDir, "cloud-deployment.md"));
  writeHermesImageContext();
  writeReleaseReadme();
  writeNginxConfigs();

  writeJson(path.join(apiDir, "package.json"), {
    name: "mia-cloud-api",
    version: rootPackage.version || "0.0.0",
    private: true,
    type: "commonjs",
    scripts: {
      start: "node server.js"
    },
    dependencies: {
      "adm-zip": rootPackage.dependencies?.["adm-zip"] || "^0.5.17",
      ws: rootPackage.dependencies?.ws || "^8.20.1"
    }
  });

  writeReleaseManifest();

  verifyRelease();

  const archive = path.join(root, "dist", "mia-cloud-release.tgz");
  const archiveSha = `${archive}.sha256`;
  fs.rmSync(archive, { force: true });
  fs.rmSync(archiveSha, { force: true });
  childProcess.execFileSync("tar", ["-czf", archive, "-C", path.join(root, "dist"), "mia-cloud-release"], {
    stdio: "inherit"
  });
  fs.writeFileSync(archiveSha, `${sha256File(archive)}  ${path.basename(archive)}\n`);

  console.log(`Mia Cloud release directory: ${distDir}`);
  console.log(`Mia Cloud release archive: ${archive}`);
  console.log(`Mia Cloud release SHA-256: ${archiveSha}`);
}

main();
