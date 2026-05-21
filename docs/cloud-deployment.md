# Aimashi Cloud Deployment

This document is the production checklist for the official Aimashi Cloud/Web host.

## Runtime Layout

- API service: `/opt/aimashi-cloud/server.js`
- Cloud data: `/var/lib/aimashi-cloud`
- Web root: `/var/www/aimashi-web`
- Public origin: `https://aiweb.buytb01.com`
- Local API listener: `127.0.0.1:4175`

## Required Environment

```ini
AIMASHI_CLOUD_HOST=127.0.0.1
AIMASHI_CLOUD_PORT=4175
AIMASHI_CLOUD_DATA=/var/lib/aimashi-cloud
AIMASHI_CLOUD_ALLOWED_ORIGINS=https://aiweb.buytb01.com
AIMASHI_BRIDGE_RUN_TIMEOUT_MS=300000
AIMASHI_CLOUD_VERSION=2026-05-20
```

`AIMASHI_CLOUD_ALLOWED_ORIGINS` is required in production. Without it, WebSocket upgrades are limited to same-host/local origins only.
`AIMASHI_CLOUD_PORT` takes precedence over the generic `PORT`; if `AIMASHI_CLOUD_PORT` is unset, the server honors `PORT` for platform-style deployments.

## systemd Unit

```ini
[Unit]
Description=Aimashi Cloud API
After=network.target

[Service]
Type=simple
User=aimashi-cloud
Group=aimashi-cloud
WorkingDirectory=/opt/aimashi-cloud
ExecStart=/usr/bin/node /opt/aimashi-cloud/server.js
Restart=always
RestartSec=3
Environment=AIMASHI_CLOUD_HOST=127.0.0.1
Environment=AIMASHI_CLOUD_PORT=4175
Environment=AIMASHI_CLOUD_DATA=/var/lib/aimashi-cloud
Environment=AIMASHI_CLOUD_ALLOWED_ORIGINS=https://aiweb.buytb01.com
Environment=AIMASHI_BRIDGE_RUN_TIMEOUT_MS=300000
Environment=AIMASHI_CLOUD_VERSION=2026-05-20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/aimashi-cloud

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

    location = /favicon.ico {
        try_files /favicon.svg =404;
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

The `map` block belongs in nginx's `http` context, not inside `server`. If the server uses a `sites-enabled` layout, put the `map` in `/etc/nginx/conf.d/aimashi-websocket-map.conf` or the main `nginx.conf` `http` block, then put the `server` block in the site file. Always run `nginx -t` before reload. The nginx config must preserve `Sec-WebSocket-Protocol`; this header carries the Cloud bearer token subprotocol for `/api/events` and `/api/bridge`.

Do not pass Cloud bearer tokens in WebSocket URLs. Current Web/Desktop/bridge clients authenticate `/api/events` and `/api/bridge` with the `Sec-WebSocket-Protocol` value `aimashi-token.<token>`, which keeps tokens out of normal URL logs. Query-string token auth is disabled by default; set `AIMASHI_CLOUD_ALLOW_QUERY_TOKEN=1` only for a short, explicit legacy-client migration window.

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
It also runs the bundled `install-cloud-release-local.sh` in `AIMASHI_INSTALL_VERIFY_ONLY=1` mode against the just-built tarball, which checks the archive checksum, unpacks the release, validates required files, and verifies every SHA-256 hash in `manifest.json` without touching systemd or install directories.

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
npm run cloud:doctor -- https://aiweb.buytb01.com
AIMASHI_DOCTOR_REMOTE=root@aiweb.buytb01.com npm run cloud:doctor -- https://aiweb.buytb01.com
```

The doctor checks DNS, `/api/health`, required product features, release provenance, same-origin CORS, security headers, HTTPS HSTS, optional non-interactive SSH access, remote Node.js 25+ with `node:sqlite`, deploy-critical commands, the configured service user or `useradd`, and `nginx -t`. It is intentionally stricter than a curl health check and should fail while production still runs an older Cloud build or SSH credentials are unavailable.
The same `doctor-cloud.js` is bundled into `dist/aimashi-cloud-release.tgz`, so an operator with only the release archive can also extract the package and run `node doctor-cloud.js https://aiweb.buytb01.com` from the unpacked release directory.

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
#   dist/aimashi-cloud-release.tgz
#   dist/aimashi-cloud-release.tgz.sha256
#   dist/aimashi-cloud-release-handoff.txt
# Or copy this single bundle to /tmp and extract it there:
#   dist/aimashi-cloud-release-transfer.tgz
#   dist/aimashi-cloud-release-transfer.tgz.sha256

# On the VPS:
cd /tmp
# If using the single bundle:
# if command -v sha256sum >/dev/null 2>&1; then
#   sha256sum -c aimashi-cloud-release-transfer.tgz.sha256
# else
#   shasum -a 256 -c aimashi-cloud-release-transfer.tgz.sha256
# fi
# tar -xzf aimashi-cloud-release-transfer.tgz -C /tmp --strip-components=1
# AIMASHI_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle.sh
# bash install-transfer-bundle.sh
# If using the three separate files:
tar -xOf aimashi-cloud-release.tgz aimashi-cloud-release/install-cloud-release-local.sh > install-cloud-release-local.sh
chmod +x install-cloud-release-local.sh
./install-cloud-release-local.sh /tmp/aimashi-cloud-release.tgz
```

`npm run cloud:release:handoff` prints the exact archive path, archive SHA-256, source commit, `builtAt`, VPS install commands, and post-install doctor/smoke commands from the current release manifest, so those values do not need to be copied manually from multiple files. `npm run cloud:release:handoff:file` writes the same text to `dist/aimashi-cloud-release-handoff.txt` so it can be sent alongside the archive and checksum. `npm run cloud:release:handoff:verify` confirms the handoff file still matches the current archive checksum and release manifest. `npm run cloud:release:handoff:bundle` writes `dist/aimashi-cloud-release-transfer.tgz` and `dist/aimashi-cloud-release-transfer.tgz.sha256`, a single transfer bundle plus external checksum sidecar. The bundle contains the release archive, checksum sidecar, handoff file, `install-transfer-bundle.sh`, `TRANSFER-README.md`, and `TRANSFER-SHA256.txt` for operator-side verification before install. `npm run cloud:release:handoff:bundle:verify` requires the external bundle sidecar, checks it, extracts the transfer bundle locally, and verifies each listed file hash before it is sent. On the VPS, `AIMASHI_TRANSFER_VERIFY_ONLY=1 bash install-transfer-bundle.sh` verifies the transfer hashes, extracts the release installer, and runs installer verify-only mode without changing system files; `bash install-transfer-bundle.sh` repeats those checks and then performs the install.
The handoff doctor and smoke commands include `AIMASHI_DOCTOR_EXPECT_RELEASE_COMMIT`, `AIMASHI_DOCTOR_EXPECT_RELEASE_BUILT_AT`, `AIMASHI_SMOKE_EXPECT_RELEASE_COMMIT`, and `AIMASHI_SMOKE_EXPECT_RELEASE_BUILT_AT` from the package manifest. Keep those values in the commands; otherwise a passing doctor or smoke can prove the public service works, but not that it is the exact package you just handed off.

After an SSH deploy or server-local install, the development machine can run the same public release gate without manually copying manifest values:

```bash
npm run cloud:prod:verify -- https://aiweb.buytb01.com
AIMASHI_DOCTOR_REMOTE=root@aiweb.buytb01.com npm run cloud:prod:verify -- https://aiweb.buytb01.com
AIMASHI_SMOKE_USERNAME=<account> \
AIMASHI_SMOKE_PASSWORD=<password> \
npm run cloud:prod:verify:e2e -- https://aiweb.buytb01.com
```

`cloud:prod:verify` reads `dist/aimashi-cloud-release/manifest.json`, injects the expected `gitCommit` and `builtAt` into `doctor-cloud.js` and `smoke-cloud.js`, and fails unless the public service is the exact release that was just built.
`cloud:prod:verify:e2e` adds `AIMASHI_SMOKE_REQUIRE_BRIDGE=1`, so it also requires `AIMASHI_SMOKE_USERNAME`/`AIMASHI_SMOKE_PASSWORD`, an online desktop bridge logged into that same account, and one `/api/bridge/run` response that contains `aimashi-cloud-bridge-smoke-ok`.

Before running bridge-required production smoke, prepare or validate the fixed smoke account:

```bash
AIMASHI_SMOKE_USERNAME="<smoke-account>" \
AIMASHI_SMOKE_PASSWORD="<smoke-password>" \
npm run cloud:smoke:account -- https://aiweb.buytb01.com
```

The account command logs in if the account already exists, registers it if it does not exist, checks current online bridge devices for that account, and does not print the password or bearer token. If the account exists with a different password, it fails instead of changing credentials.

The local installer verifies Node.js 25+ with `node:sqlite`, checks the release archive checksum when the `.sha256` sidecar is present, unpacks the release, validates required API/Web/smoke/doctor files, creates or reuses the dedicated `aimashi-cloud` system user, backs up current data/API/Web/systemd unit paths, verifies each tar backup with `tar -tzf`, installs API and Web files, writes `/opt/aimashi-cloud/release-manifest.json`, grants the data directory to the service user, restarts `aimashi-cloud` as that non-root user, runs `doctor-cloud.js` with expected `gitCommit`/`builtAt`, then runs `smoke-cloud.js` with the same expected release. If install, doctor, or smoke fails, it stops the service, restores the previous data/API/Web/unit backups, and restarts the old service so SQLite data is not left on a newer schema after a code rollback. Set `AIMASHI_INSTALL_SKIP_SMOKE=1` only for emergency installs where public DNS/nginx is known to be temporarily unavailable; despite the legacy variable name, this skips both post-install doctor and smoke gates.
Set `AIMASHI_INSTALL_VERIFY_ONLY=1` to verify the tarball and manifest hashes without installing files or requiring `systemctl`, `npm`, or `rsync`.

The deploy script first verifies SSH access to `root@aiweb.buytb01.com` and checks remote runtime prerequisites (`Node.js 25+` with `node:sqlite`, `npm`, `rsync`, `systemctl`, `tar`, `id`, `chown`, the configured service user or `useradd`, and `sha256sum` or `shasum`). It then runs local checks, builds `dist/aimashi-cloud-release.tgz`, verifies `dist/aimashi-cloud-release.tgz.sha256`, uploads both files, verifies the archive checksum on the server before unpacking, creates or reuses the dedicated service user, backs up `/var/lib/aimashi-cloud`, backs up the current API directory, Web directory, and systemd unit, verifies each tar backup with `tar -tzf`, installs API/Web files, writes and enables the `aimashi-cloud` systemd unit, grants the data directory to the service user, restarts the service as that non-root user, runs `npm run cloud:doctor -- https://aiweb.buytb01.com` with expected `gitCommit` and `builtAt`, then runs `npm run cloud:smoke -- https://aiweb.buytb01.com` with the same expected release. If checksum, install, `npm install`, systemd restart, public doctor, or public smoke fails, the script stops the service, attempts to restore the previous data/API/Web/unit backups, and restarts the old service before exiting with failure. Public doctor and smoke both fail if `/api/health.release` does not match the package that was just deployed.

The default assumes direct root SSH. For a normal SSH account with passwordless sudo, use `AIMASHI_DEPLOY_SUDO="sudo -n"` and, if needed, change the backup directory to a location that sudo can write:

```bash
AIMASHI_DEPLOY_REMOTE=deploy@aiweb.buytb01.com \
AIMASHI_DEPLOY_SUDO="sudo -n" \
AIMASHI_DEPLOY_BACKUP_DIR=/var/backups \
npm run cloud:deploy
```

`AIMASHI_DEPLOY_SUDO` must be a simple command such as `sudo -n` or `/usr/bin/sudo -n`; shell snippets, redirects, pipes, variable expansions, and quoted subcommands are rejected by the deploy scripts.

Override targets with environment variables:

```bash
AIMASHI_DEPLOY_REMOTE=root@example.com \
AIMASHI_CLOUD_PUBLIC_URL=https://aiweb.buytb01.com \
npm run cloud:deploy
```

Supported deployment overrides:

- `AIMASHI_DEPLOY_REMOTE`: SSH target, default `root@aiweb.buytb01.com`.
- `AIMASHI_DEPLOY_SUDO`: optional simple privilege command, for example `sudo -n`; shell snippets are rejected.
- `AIMASHI_DEPLOY_BACKUP_DIR`: remote backup directory, default `/root`.
- `AIMASHI_DEPLOY_ID`: optional deploy identifier used in backup filenames, default `<timestamp>-<pid>`.
- `AIMASHI_DEPLOY_API_DIR`: remote API install directory, default `/opt/aimashi-cloud`.
- `AIMASHI_DEPLOY_WEB_DIR`: remote Web install directory, default `/var/www/aimashi-web`.
- `AIMASHI_DEPLOY_DATA_DIR`: remote persistent data directory, default `/var/lib/aimashi-cloud`.
- `AIMASHI_DEPLOY_SERVICE`: systemd service name, default `aimashi-cloud`.
- `AIMASHI_DEPLOY_SERVICE_USER`: non-root system user for the API service, default `aimashi-cloud`.
- `AIMASHI_DEPLOY_DRY_RUN`: set to `1` to stop after local verification and release metadata output.
- `AIMASHI_CLOUD_ALLOW_QUERY_TOKEN`: optional legacy WebSocket auth fallback. Leave unset in production; set to `1` only if an old client that cannot send `Sec-WebSocket-Protocol` must be temporarily supported.

Manual path:

1. Run local verification:

   ```bash
   node src/check.js
   npm test
   npm run cloud:release
   cd dist && shasum -a 256 -c aimashi-cloud-release.tgz.sha256
   ```

2. Copy API files:

   ```bash
   mkdir -p /opt/aimashi-cloud/src/cloud
   rsync -av --delete dist/aimashi-cloud-release/api/ /opt/aimashi-cloud/
   cd /opt/aimashi-cloud && npm install --omit=dev
   ```

3. Copy Web assets:

   ```bash
   rsync -av --delete dist/aimashi-cloud-release/web/ /var/www/aimashi-web/
   ```

4. Restart and verify:

   ```bash
   systemctl daemon-reload
   systemctl restart aimashi-cloud
   systemctl is-active aimashi-cloud
   curl -fsS https://aiweb.buytb01.com/api/health
   curl -fsS https://aiweb.buytb01.com/api/health | grep bridge-websocket-subprotocol-token
   curl -fsS https://aiweb.buytb01.com/api/health | grep gitCommit
   npm run cloud:smoke -- https://aiweb.buytb01.com
   ```

5. Record the deployed release:

   ```bash
   cat dist/aimashi-cloud-release/manifest.json
   cat dist/aimashi-cloud-release.tgz.sha256
   ```

The release manifest records `builtAt`, source git commit, dirty state, and SHA-256 hashes for every file in the API/Web/smoke bundle. The deploy script installs this manifest as `/opt/aimashi-cloud/release-manifest.json`, and `/api/health` returns a compact `release` object from it. Keep the manifest and archive checksum with deployment notes so a later `/api/health` smoke can be matched to the exact package that was installed.

6. Browser smoke test:

   - Register or log in.
   - Confirm `/api/events` connects without `token=` in the WebSocket URL.
   - Upload an image and open the image preview.
   - Confirm a logged-in desktop appears in the Bridge device list.
   - Send one request through the selected desktop device and verify streamed output plus final assistant message.

For a deploy-time end-to-end bridge smoke, log the desktop app into a dedicated smoke account, then run:

```bash
AIMASHI_SMOKE_USERNAME=<account> \
AIMASHI_SMOKE_PASSWORD=<password> \
npm run cloud:prod:verify:e2e -- https://aiweb.buytb01.com
```

This verifies health features, release identity, auth, authenticated files, `/api/events`, bridge device presence, and one `/api/bridge/run` request through the online desktop bridge with the expected smoke reply marker.

When the smoke uses the desktop app bridge, remote control is authorized by the same Aimashi Cloud account:

- Log the desktop app into the same account used by Web or mobile.
- Web/mobile can call that online desktop bridge directly; there is no separate local approval click for the remote connection.
- Agent permission mode remains the normal per-Agent execution setting (Ask/YOLO/Deny or external-engine defaults). It is not device authentication.

For an operator-side standalone local Agent bridge, the bridge can now log in with the same Aimashi Cloud account instead of copying a bearer token. Run this from a full Aimashi project checkout on the bridge machine, not from the extracted Cloud release directory:

```bash
cd /path/to/aimashi
AIMASHI_CLOUD_URL=https://aiweb.buytb01.com \
AIMASHI_CLOUD_USERNAME=<account> \
AIMASHI_CLOUD_PASSWORD=<password> \
npm run bridge
```

`AIMASHI_CLOUD_TOKEN` still works for automation and takes precedence when set, but the account/password path is the preferred production smoke path because it matches the Web/Desktop account model.

## Data Safety

Back up `/var/lib/aimashi-cloud/cloud.sqlite` and `/var/lib/aimashi-cloud/uploads/` before replacing the service.

```bash
systemctl stop aimashi-cloud
tar -C /var/lib -czf /root/aimashi-cloud-backup-$(date +%Y%m%d-%H%M%S).tgz aimashi-cloud
systemctl start aimashi-cloud
```
