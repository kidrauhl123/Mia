# Mia Cloud Deployment

This document is the production checklist for the official Mia Cloud/Web host.

## Runtime Layout

- API service: `/opt/mia-cloud/server.js`
- Cloud data: `/var/lib/mia-cloud`
- Web root: `/var/www/mia-web`
- Desktop update root: `/var/www/mia-updates`
- Public origin: `https://mia.gifgif.cn`
- Local API listener: `127.0.0.1:4175`

## Required Environment

```ini
MIA_CLOUD_HOST=127.0.0.1
MIA_CLOUD_PORT=4175
MIA_CLOUD_DATA=/var/lib/mia-cloud
MIA_CLOUD_PUBLIC_URL=https://mia.gifgif.cn
MIA_CLOUD_ALLOWED_ORIGINS=https://mia.gifgif.cn
MIA_BRIDGE_RUN_TIMEOUT_MS=300000
MIA_CLOUD_VERSION=2026-05-20
MIA_CLOUD_AGENT_MODE=docker
MIA_CLOUD_AGENT_ROOT=/var/lib/mia-cloud-agent-users
MIA_CLOUD_HERMES_IMAGE=mia/hermes-cloud:2026.5.29
MIA_CLOUD_HERMES_CONTAINER_PORT=8765
MIA_CLOUD_AGENT_DOCKER_NETWORK=mia-cloud
MIA_CLOUD_AGENT_MODEL_PROVIDER=mia
MIA_CLOUD_AGENT_MODEL=mia-default
MIA_CLOUD_ADMIN_USERNAME=<admin username>
MIA_CLOUD_ADMIN_PASSWORD=<admin password>
MIA_WECHAT_MP_APP_ID=<WeChat Official Account AppID>
MIA_WECHAT_MP_APP_SECRET=<WeChat Official Account AppSecret>
MIA_WECHAT_MP_TOKEN=<message push token configured in WeChat>
MIA_MODEL_GATEWAY=deepseek
MIA_CLOUD_INTERNAL_MODEL_PROXY_KEY=<random internal proxy secret>
MIA_MODEL_INPUT_MICROUSD_PER_1M=140000
MIA_MODEL_OUTPUT_MICROUSD_PER_1M=280000
MIA_MODEL_MARKUP=1
# Optional bootstrap fallback; the normal entry is /admin/model.
# MIA_DEEPSEEK_API_KEY=<DeepSeek API key>
```

`MIA_CLOUD_ALLOWED_ORIGINS` is required in production. Without it, WebSocket upgrades are limited to same-host/local origins only.
`MIA_CLOUD_PORT` takes precedence over the generic `PORT`; if `MIA_CLOUD_PORT` is unset, the server honors `PORT` for platform-style deployments.
`MIA_CLOUD_AGENT_MODE=docker` enables the Cloud-hosted Hermes runtime for Bot runs. The release includes `hermes-image/`, and the installer builds `MIA_CLOUD_HERMES_IMAGE` locally on the VPS so the runtime does not depend on pulling a private image. The service creates one worker container per user, mounts only `/var/lib/mia-cloud-agent-users/<userId>` at `/data`, binds the Hermes API to `127.0.0.1` on a random host port, and passes `HERMES_HOME=/data/hermes-home`, `HOME=/data/home`, `TERMINAL_CWD=/data/workspace`, and `HERMES_WRITE_SAFE_ROOT=/data/workspace` into the container. The worker container must not mount `/var/lib/mia-cloud`, global uploads, other users' agent directories, or `/var/run/docker.sock`.
On China-hosted VPS networks, Debian apt metadata or PyPI downloads can hang when they use upstream defaults. Set `MIA_DEBIAN_APT_MIRROR=https://mirrors.tencent.com/debian` and `MIA_PIP_INDEX_URL=https://mirrors.tencent.com/pypi/simple` before running `install-cloud-release-local.sh` or `cloud:deploy`.
If `MIA_CLOUD_HERMES_IMAGE` is already present on the VPS and the Hermes version did not change, `MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD=1` or `MIA_DEPLOY_SKIP_HERMES_IMAGE_BUILD=1` skips rebuilding the worker image after first verifying that image exists.
`MIA_MODEL_GATEWAY=deepseek` makes Mia Cloud the paid model gateway: users spend Mia model credits, Mia calls DeepSeek with the server-side key, records usage in SQLite, and deducts the user's balance. Save the DeepSeek API Key, base URL, public Mia model name, and token pricing at `/admin/model`; `MIA_DEEPSEEK_API_KEY` is only a bootstrap fallback if the database setting has not been saved yet. Cloud Hermes workers receive a per-user internal proxy token generated from `MIA_CLOUD_INTERNAL_MODEL_PROXY_KEY`; they do not receive the raw DeepSeek key. Put `MIA_CLOUD_INTERNAL_MODEL_PROXY_KEY`, optional fallback `MIA_DEEPSEEK_API_KEY`, and admin credentials in `/etc/mia-cloud/admin.env`, not in the repository.

## WeChat Official Account Login

Mia Cloud uses the Official Account identity as the only cloud account login. The login flow is the Official Account web authorization QR flow:

- Required env: `MIA_WECHAT_MP_APP_ID`, `MIA_WECHAT_MP_APP_SECRET`.
- Required Official Account setting: `网页授权域名` must be `mia.gifgif.cn`.
- OAuth callback URL: `https://mia.gifgif.cn/api/auth/wechat/mp/oauth-callback`.
- Optional message push URL: `https://mia.gifgif.cn/api/auth/wechat/mp/events`.
- Optional message push token: `MIA_WECHAT_MP_TOKEN`.

`JS接口安全域名` is not required for this login path. `生成带参数二维码` / `qrcode/create` is not used.

Mia creates a QR code that points to a Mia-hosted WeChat login explanation page. After the user scans it in WeChat and taps the authorization button, Mia opens WeChat Official Account OAuth with `scope=snsapi_userinfo`. WeChat then calls the OAuth callback; Mia exchanges the code for an OAuth token, reads `nickname` and `headimgurl` from `sns/userinfo`, and completes the desktop/web polling login. If WeChat returns a snapshot anonymous user or does not return both nickname and avatar, Mia fails the login instead of creating a fallback `微信用户` profile.

To grant first-version manual credits before a payment provider is wired:

```bash
curl -u "$MIA_CLOUD_ADMIN_USERNAME:$MIA_CLOUD_ADMIN_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"account":"user@example.com","amountUsd":5,"reason":"manual_topup"}' \
  https://mia.gifgif.cn/api/admin/model-credits/grant
```

## Optional LiteLLM Model Gateway

LiteLLM remains useful if Mia later needs a multi-provider OpenAI-compatible gateway, provider failover, or LiteLLM virtual-key budgets. Set `MIA_MODEL_GATEWAY=litellm` and configure LiteLLM if you want that mode. A common production layout is a dedicated Docker network:

```bash
docker network create mia-cloud || true
docker run -d --name litellm --restart unless-stopped \
  --network mia-cloud \
  -p 127.0.0.1:4000:4000 \
  -v /opt/litellm/config.yaml:/app/config.yaml:ro \
  -e LITELLM_MASTER_KEY=<admin key> \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml --host 0.0.0.0 --port 4000
```

Use the Mia admin page at `/admin/model` to save the provider API key and the `mia-default` model alias into LiteLLM. Keep the LiteLLM UI private or disabled on the public internet. The Mia systemd unit should use a LiteLLM virtual key in `MIA_CLOUD_AGENT_MODEL_API_KEY`; Bot runs that target Cloud Hermes use this managed model gateway, and end users do not configure model providers inside the worker.

## systemd Unit

```ini
[Unit]
Description=Mia Cloud API
After=network.target

[Service]
Type=simple
User=mia-cloud
Group=mia-cloud
WorkingDirectory=/opt/mia-cloud
ExecStart=/usr/bin/node /opt/mia-cloud/server.js
Restart=always
RestartSec=3
Environment=MIA_CLOUD_HOST=127.0.0.1
Environment=MIA_CLOUD_PORT=4175
Environment=MIA_CLOUD_DATA=/var/lib/mia-cloud
Environment=MIA_WEB_ROOT=/var/www/mia-web
Environment=MIA_CLOUD_PUBLIC_URL=https://mia.gifgif.cn
Environment=MIA_CLOUD_ALLOWED_ORIGINS=https://mia.gifgif.cn
Environment=MIA_BRIDGE_RUN_TIMEOUT_MS=300000
Environment=MIA_CLOUD_VERSION=2026-05-20
Environment=MIA_CLOUD_AGENT_MODE=docker
Environment=MIA_CLOUD_AGENT_ROOT=/var/lib/mia-cloud-agent-users
Environment=MIA_CLOUD_HERMES_IMAGE=mia/hermes-cloud:2026.5.29
Environment=MIA_CLOUD_HERMES_CONTAINER_PORT=8765
Environment=MIA_CLOUD_AGENT_DOCKER_NETWORK=mia-cloud
Environment=MIA_CLOUD_AGENT_MODEL_PROVIDER=mia
Environment=MIA_CLOUD_AGENT_MODEL=mia-default
EnvironmentFile=-/etc/mia-cloud/admin.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/mia-cloud /var/lib/mia-cloud-agent-users

[Install]
WantedBy=multi-user.target
```

## nginx Site

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
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

    location = /favicon.ico {
        try_files /favicon.svg =404;
    }

    location = /admin {
        proxy_pass http://127.0.0.1:4175;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /admin/ {
        proxy_pass http://127.0.0.1:4175;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

The `map` block belongs in nginx's `http` context, not inside `server`. If the server uses a `sites-enabled` layout, put the `map` in `/etc/nginx/conf.d/mia-websocket-map.conf` or the main `nginx.conf` `http` block, then put the `server` block in the site file. Always run `nginx -t` before reload. The nginx config must preserve `Sec-WebSocket-Protocol`; this header carries the Cloud bearer token subprotocol for `/api/events` and `/api/bridge`.

Do not pass Cloud bearer tokens in WebSocket URLs. Current Web/Desktop/bridge clients authenticate `/api/events` and `/api/bridge` with the `Sec-WebSocket-Protocol` value `mia-token.<token>`, which keeps tokens out of normal URL logs. Query-string token auth is disabled by default; set `MIA_CLOUD_ALLOW_QUERY_TOKEN=1` only for a short, explicit legacy-client migration window.

## Deploy Steps

Automated path:

```bash
npm run cloud:deploy
```

Dry-run path, useful before SSH credentials are available:

```bash
npm run cloud:deploy:dry-run
```

The dry run performs local structure checks, the full test suite, release build, manifest verification, and archive checksum verification, then prints the remote target, expected release commit, expected `builtAt`, archive hash, and install paths. It does not connect to SSH, upload files, install anything, or run public smoke.
It also runs the bundled `install-cloud-release-local.sh` in `MIA_INSTALL_VERIFY_ONLY=1` mode against the just-built tarball, which checks the archive checksum, unpacks the release, validates required files, and verifies every SHA-256 hash in `manifest.json` without touching systemd or install directories.

If SSH deploy access is denied, print the exact public-key authorization block for the VPS operator:

```bash
npm run cloud:deploy:authorize-help
```

This command reads only the local public key, prints its SHA-256 fingerprint, reports whether the local `ssh-agent` has identities loaded, prints the idempotent `authorized_keys` command to run on the VPS, prints a VPS-side diagnostic block for `authorized_keys` presence, file permissions, and `sshd -T` root/pubkey policy, and prints the follow-up `ssh ... true` plus `npm run cloud:deploy` commands. It does not print or transfer a private key. If the private key has a passphrase or the local agent has no identities loaded, run the printed `ssh-add ~/.ssh/id_ed25519` command before the BatchMode verification.

If SSH is still denied after the local key is loaded, collect a filtered local authentication trace:

```bash
npm run cloud:deploy:ssh-diagnose
```

The diagnostic command prints `ssh-agent` identity status and a filtered `ssh -vvv` authentication trace showing which public key was offered and whether the server accepted it. It does not print private-key material.

Production doctor, useful to identify the exact blocker before deployment:

```bash
npm run cloud:doctor -- https://mia.gifgif.cn
MIA_DOCTOR_REMOTE=root@mia.gifgif.cn npm run cloud:doctor -- https://mia.gifgif.cn
```

The doctor checks DNS, `/api/health`, required product features, release provenance, same-origin CORS, security headers, HTTPS HSTS, optional non-interactive SSH access, remote Node.js 25+ with `node:sqlite`, deploy-critical commands, the configured service user or `useradd`, and `nginx -t`. It is intentionally stricter than a curl health check and should fail while production still runs an older Cloud build or SSH credentials are unavailable.
The same `doctor-cloud.js` is bundled into `dist/mia-cloud-release.tgz`, so an operator with only the release archive can also extract the package and run `node doctor-cloud.js https://mia.gifgif.cn` from the unpacked release directory.

Server-local install path, useful when the operator can open a shell on the VPS but this workstation does not have SSH key access:

```bash
# On the development machine:
npm run cloud:release
npm run cloud:install:verify
npm run cloud:release:handoff
npm run cloud:release:handoff:file
npm run cloud:release:handoff:verify
npm run cloud:release:handoff:bundle
npm run cloud:release:handoff:bundle:verify
# Copy these files to /tmp on the VPS with your available channel:
#   dist/mia-cloud-release.tgz
#   dist/mia-cloud-release.tgz.sha256
#   dist/mia-cloud-release-handoff.txt
# Or copy this single bundle to /tmp and extract it there:
#   dist/mia-cloud-release-transfer.tgz
#   dist/mia-cloud-release-transfer.tgz.sha256

# On the VPS:
cd /tmp
# If using the single bundle:
# if command -v sha256sum >/dev/null 2>&1; then
#   sha256sum -c mia-cloud-release-transfer.tgz.sha256
# else
#   shasum -a 256 -c mia-cloud-release-transfer.tgz.sha256
# fi
# tar -xzf mia-cloud-release-transfer.tgz -C /tmp --strip-components=1
# MIA_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle.sh
# bash install-transfer-bundle.sh
# If using the three separate files:
tar -xOf mia-cloud-release.tgz mia-cloud-release/install-cloud-release-local.sh > install-cloud-release-local.sh
chmod +x install-cloud-release-local.sh
./install-cloud-release-local.sh /tmp/mia-cloud-release.tgz
```

`npm run cloud:release:handoff` prints the exact archive path, archive SHA-256, source commit, `builtAt`, VPS install commands, and post-install doctor/smoke/site-verification commands from the current release manifest, so those values do not need to be copied manually from multiple files. `npm run cloud:release:handoff:file` writes the same text to `dist/mia-cloud-release-handoff.txt` so it can be sent alongside the archive and checksum. `npm run cloud:release:handoff:verify` confirms the handoff file still matches the current archive checksum and release manifest. `npm run cloud:release:handoff:bundle` writes `dist/mia-cloud-release-transfer.tgz` and `dist/mia-cloud-release-transfer.tgz.sha256`, a single transfer bundle plus external checksum sidecar. The bundle contains the release archive, checksum sidecar, handoff file, `install-transfer-bundle.sh`, `TRANSFER-README.md`, and `TRANSFER-SHA256.txt` for operator-side verification before install. `npm run cloud:release:handoff:bundle:verify` requires the external bundle sidecar, checks it, extracts the transfer bundle locally, and verifies each listed file hash before it is sent. On the VPS, `MIA_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle.sh` verifies the transfer hashes, extracts the release installer, and runs installer verify-only mode without changing system files; `bash install-transfer-bundle.sh` repeats those checks and then performs the install.
The handoff doctor and smoke commands include `MIA_DOCTOR_EXPECT_RELEASE_COMMIT`, `MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT`, `MIA_SMOKE_EXPECT_RELEASE_COMMIT`, and `MIA_SMOKE_EXPECT_RELEASE_BUILT_AT` from the package manifest. Keep those values in the commands; otherwise a passing doctor or smoke can prove the public service works, but not that it is the exact package you just handed off.

After an SSH deploy or server-local install, the development machine can run the same public release gate without manually copying manifest values:

```bash
npm run cloud:prod:verify -- https://mia.gifgif.cn
MIA_DOCTOR_REMOTE=root@mia.gifgif.cn npm run cloud:prod:verify -- https://mia.gifgif.cn
MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run cloud:prod:verify:e2e -- https://mia.gifgif.cn
```

`cloud:prod:verify` reads `dist/mia-cloud-release/manifest.json`, injects the expected `gitCommit` and `builtAt` into `doctor-cloud.js` and `smoke-cloud.js`, then verifies the root `5a371047c22c89872f93f00c7d8af123.txt` content. It fails unless the public service is the exact release that was just built and the site verification txt is live.
`cloud:prod:verify:e2e` adds `MIA_SMOKE_REQUIRE_BRIDGE=1`, so it also requires `MIA_CLOUD_TOKEN`, an online desktop bridge logged into that same WeChat account, and one `/api/bridge/run` response that contains `mia-cloud-bridge-smoke-ok`.

Before running bridge-required production smoke, validate the fixed smoke account token:

```bash
MIA_CLOUD_TOKEN="<smoke-account-token>" \
npm run cloud:smoke:account -- https://mia.gifgif.cn
```

The account command verifies `/api/me`, checks current online bridge devices for that account, and does not print the bearer token.

The local installer verifies Node.js 25+ with `node:sqlite`, checks the release archive checksum when the `.sha256` sidecar is present, unpacks the release, validates required API/Web/smoke/doctor/site-verification files, creates or reuses the dedicated `mia-cloud` system user, backs up current data/API/Web/systemd unit paths, verifies each tar backup with `tar -tzf`, installs API and Web files, writes `/opt/mia-cloud/release-manifest.json`, grants the data directory to the service user, restarts `mia-cloud` as that non-root user, runs `doctor-cloud.js` with expected `gitCommit`/`builtAt`, runs `smoke-cloud.js` with the same expected release, then verifies the root site-verification txt. If install, doctor, smoke, or site verification fails, it stops the service, restores the previous data/API/Web/unit backups, and restarts the old service so SQLite data is not left on a newer schema after a code rollback. Set `MIA_INSTALL_SKIP_SMOKE=1` only for emergency installs where public DNS/nginx is known to be temporarily unavailable; despite the legacy variable name, this skips all post-install public verification gates.
Set `MIA_INSTALL_VERIFY_ONLY=1` to verify the tarball and manifest hashes without installing files or requiring `systemctl`, `npm`, or `rsync`.

The deploy script first verifies SSH access to `root@mia.gifgif.cn` and checks remote runtime prerequisites (`Node.js 25+` with `node:sqlite`, `npm`, `rsync`, `systemctl`, `tar`, `id`, `chown`, the configured service user or `useradd`, and `sha256sum` or `shasum`). It then runs local checks, builds `dist/mia-cloud-release.tgz`, verifies `dist/mia-cloud-release.tgz.sha256`, uploads both files, verifies the archive checksum on the server before unpacking, creates or reuses the dedicated service user, backs up `/var/lib/mia-cloud`, backs up the current API directory, Web directory, and systemd unit, verifies each tar backup with `tar -tzf`, installs API/Web files, writes and enables the `mia-cloud` systemd unit, grants the data directory to the service user, restarts the service as that non-root user, runs `npm run cloud:doctor -- https://mia.gifgif.cn` with expected `gitCommit` and `builtAt`, runs `npm run cloud:smoke -- https://mia.gifgif.cn` with the same expected release, then runs `npm run cloud:site-verify -- https://mia.gifgif.cn`. If checksum, install, `npm install`, systemd restart, public doctor, public smoke, or site verification fails, the script stops the service, attempts to restore the previous data/API/Web/unit backups, and restarts the old service before exiting with failure. Public doctor and smoke both fail if `/api/health.release` does not match the package that was just deployed. Set `MIA_DEPLOY_SKIP_SMOKE=1` only when deploying from a machine without `MIA_CLOUD_TOKEN`; public doctor and site verification still run.

The default assumes direct root SSH. For a normal SSH account with passwordless sudo, use `MIA_DEPLOY_SUDO="sudo -n"` and, if needed, change the backup directory to a location that sudo can write:

```bash
MIA_DEPLOY_REMOTE=deploy@mia.gifgif.cn \
MIA_DEPLOY_SUDO="sudo -n" \
MIA_DEPLOY_BACKUP_DIR=/var/backups \
npm run cloud:deploy
```

`MIA_DEPLOY_SUDO` must be a simple command such as `sudo -n` or `/usr/bin/sudo -n`; shell snippets, redirects, pipes, variable expansions, and quoted subcommands are rejected by the deploy scripts.

Override targets with environment variables:

```bash
MIA_DEPLOY_REMOTE=root@example.com \
MIA_CLOUD_PUBLIC_URL=https://mia.gifgif.cn \
npm run cloud:deploy
```

Supported deployment overrides:

- `MIA_DEPLOY_REMOTE`: SSH target, default `root@mia.gifgif.cn`.
- `MIA_DEPLOY_SUDO`: optional simple privilege command, for example `sudo -n`; shell snippets are rejected.
- `MIA_DEPLOY_BACKUP_DIR`: remote backup directory, default `/root`.
- `MIA_DEPLOY_ID`: optional deploy identifier used in backup filenames, default `<timestamp>-<pid>`.
- `MIA_DEPLOY_API_DIR`: remote API install directory, default `/opt/mia-cloud`.
- `MIA_DEPLOY_WEB_DIR`: remote Web install directory, default `/var/www/mia-web`.
- `MIA_DEPLOY_DATA_DIR`: remote persistent data directory, default `/var/lib/mia-cloud`.
- `MIA_DEPLOY_SERVICE`: systemd service name, default `mia-cloud`.
- `MIA_DEPLOY_SERVICE_USER`: non-root system user for the API service, default `mia-cloud`.
- `MIA_DEPLOY_DRY_RUN`: set to `1` to stop after local verification and release metadata output.
- `MIA_CLOUD_ALLOW_QUERY_TOKEN`: optional legacy WebSocket auth fallback. Leave unset in production; set to `1` only if an old client that cannot send `Sec-WebSocket-Protocol` must be temporarily supported.

Manual path:

1. Run local verification:

   ```bash
   node src/check.js
   npm test
   npm run cloud:release
   cd dist && shasum -a 256 -c mia-cloud-release.tgz.sha256
   ```

2. Copy API files:

   ```bash
   mkdir -p /opt/mia-cloud/src/cloud
   rsync -av --delete dist/mia-cloud-release/api/ /opt/mia-cloud/
   cd /opt/mia-cloud && npm install --omit=dev
   ```

3. Copy Web assets:

   ```bash
   rsync -av --delete dist/mia-cloud-release/web/ /var/www/mia-web/
   ```

4. Restart and verify:

   ```bash
   systemctl daemon-reload
   systemctl restart mia-cloud
   systemctl is-active mia-cloud
   curl -fsS https://mia.gifgif.cn/api/health
   curl -fsS https://mia.gifgif.cn/api/health | grep bridge-websocket-subprotocol-token
   curl -fsS https://mia.gifgif.cn/api/health | grep gitCommit
   npm run cloud:smoke -- https://mia.gifgif.cn
   ```

5. Record the deployed release:

   ```bash
   cat dist/mia-cloud-release/manifest.json
   cat dist/mia-cloud-release.tgz.sha256
   ```

The release manifest records `builtAt`, source git commit, dirty state, and SHA-256 hashes for every file in the API/Web/smoke bundle. The deploy script installs this manifest as `/opt/mia-cloud/release-manifest.json`, and `/api/health` returns a compact `release` object from it. Keep the manifest and archive checksum with deployment notes so a later `/api/health` smoke can be matched to the exact package that was installed.

6. Browser smoke test:

   - Register or log in.
   - Confirm `/api/events` connects without `token=` in the WebSocket URL.
   - Upload an image and open the image preview.
   - Confirm a logged-in desktop appears in the Bridge device list.
   - Send one request through the selected desktop device and verify streamed output plus final assistant message.

For a deploy-time end-to-end bridge smoke, log the desktop app into a dedicated WeChat smoke account, then run:

```bash
MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run cloud:prod:verify:e2e -- https://mia.gifgif.cn
```

This verifies health features, release identity, auth, authenticated files, `/api/events`, bridge device presence, and one `/api/bridge/run` request through the online desktop bridge with the expected smoke reply marker.

When the smoke uses the desktop app bridge, remote control is authorized by the same Mia Cloud account:

- Log the desktop app into the same account used by Web or mobile.
- Web/mobile can call that online desktop bridge directly; there is no separate local approval click for the remote connection.
- Agent permission mode remains the normal per-Agent execution setting (Ask/YOLO/Deny or external-engine defaults). It is not device authentication.

For an operator-side standalone local Agent bridge, pass a bearer token for the same Mia Cloud account. Run this from a full Mia project checkout on the bridge machine, not from the extracted Cloud release directory:

```bash
cd /path/to/mia
MIA_CLOUD_URL=https://mia.gifgif.cn \
MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run bridge
```

The standalone bridge no longer accepts account/password credentials; WeChat login owns the user session, and the bridge receives only the cloud bearer token.

## Data Safety

Back up `/var/lib/mia-cloud/cloud.sqlite` and `/var/lib/mia-cloud/uploads/` before replacing the service.

```bash
systemctl stop mia-cloud
tar -C /var/lib -czf /root/mia-cloud-backup-$(date +%Y%m%d-%H%M%S).tgz mia-cloud
systemctl start mia-cloud
```
