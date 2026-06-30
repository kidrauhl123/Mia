const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");

function readScript(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("server-local installer restores data backups during rollback", () => {
  const source = readScript("scripts/install-cloud-release-local.sh");
  assert.match(source, /validate_deploy_sudo\(\) \{[\s\S]*?MIA_DEPLOY_SUDO must be a simple command/);
  assert.match(source, /grep -q '\[\^A-Za-z0-9_\.\/ -\]'/);
  assert.match(source, /DATA_BACKUP="\$BACKUP_DIR\/mia-cloud-data-\$DEPLOY_ID\.tgz"/);
  assert.match(source, /NGINX_MAP_CONF="\$\{MIA_DEPLOY_NGINX_MAP_CONF:-\/etc\/nginx\/conf\.d\/mia-websocket-map\.conf\}"/);
  assert.match(source, /NGINX_SITE_CONF="\$\{MIA_DEPLOY_NGINX_SITE_CONF:-\/etc\/nginx\/sites-enabled\/mia-web\}"/);
  assert.match(source, /NGINX_MAP_BACKUP="\$BACKUP_DIR\/mia-cloud-nginx-map-\$DEPLOY_ID\.conf"/);
  assert.match(source, /NGINX_SITE_BACKUP="\$BACKUP_DIR\/mia-cloud-nginx-site-\$DEPLOY_ID\.conf"/);
  assert.match(source, /SERVICE_USER="\$\{MIA_DEPLOY_SERVICE_USER:-mia-cloud\}"/);
  assert.match(source, /ensure_service_user\(\) \{[\s\S]*?useradd_cmd=.*useradd[\s\S]*?--system --user-group --home-dir "\$DATA_DIR" --shell "\$login_shell" "\$SERVICE_USER"/);
  assert.match(source, /ensure_docker_access\(\) \{[\s\S]*?grep -q '\^docker:' \/etc\/group[\s\S]*?usermod_cmd=.*usermod[\s\S]*?run_as_root "\$usermod_cmd" -aG docker "\$SERVICE_USER"/);
  assert.match(source, /AGENT_DOCKER_NETWORK="\$\{MIA_CLOUD_AGENT_DOCKER_NETWORK:-mia-cloud\}"/);
  assert.match(source, /LITELLM_CONTAINER="\$\{MIA_LITELLM_CONTAINER:-litellm\}"/);
  assert.match(source, /SKIP_HERMES_IMAGE_BUILD="\$\{MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD:-\$\{MIA_SKIP_HERMES_IMAGE_BUILD:-\}\}"/);
  assert.match(source, /docker network inspect "\$AGENT_DOCKER_NETWORK"[\s\S]*?docker network create "\$AGENT_DOCKER_NETWORK"/);
  assert.match(source, /docker container inspect "\$LITELLM_CONTAINER"[\s\S]*?docker network connect "\$AGENT_DOCKER_NETWORK" "\$LITELLM_CONTAINER"/);
  assert.match(source, /MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD=1 but image is missing/);
  assert.match(source, /docker image inspect "\$HERMES_IMAGE"/);
  assert.match(source, /AGENT_MODEL_BASE_URL="\$\{MIA_CLOUD_AGENT_MODEL_BASE_URL:-http:\/\/litellm:4000\/v1\}"/);
  assert.match(source, /AGENT_MODEL_API_KEY="\$\{MIA_CLOUD_AGENT_MODEL_API_KEY:-\$\{MIA_LITELLM_API_KEY:-\}\}"/);
  assert.match(source, /Environment=MIA_CLOUD_AGENT_MODEL_BASE_URL=\$AGENT_MODEL_BASE_URL/);
  assert.match(source, /Environment=MIA_CLOUD_AGENT_MODEL_API_KEY=\$AGENT_MODEL_API_KEY/);
  assert.match(source, /Environment=MIA_CLOUD_PUBLIC_URL=\$PUBLIC_URL/);
  assert.match(source, /EXTRA_ALLOWED_ORIGINS="\$\{MIA_CLOUD_EXTRA_ALLOWED_ORIGINS:-https:\/\/gifgif\.cn\}"/);
  assert.match(source, /Environment=MIA_CLOUD_ALLOWED_ORIGINS=\$ALLOWED_ORIGINS/);
  assert.match(source, /require_command id/);
  assert.match(source, /require_command chown/);
  assert.match(source, /require_command docker/);
  assert.match(source, /require_command nginx/);
  assert.match(source, /run_as_root chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$DATA_DIR"/);
  assert.match(source, /sync_web_release\(\) \{[\s\S]*?\$INSTALL_TMP\/web\/downloads[\s\S]*?rsync -a --delete --exclude '\/downloads\/' "\$INSTALL_TMP\/web\/" "\$WEB_DIR\/"/);
  assert.match(source, /run_as_root cp "\$INSTALL_TMP\/nginx\/mia-websocket-map\.conf" "\$NGINX_MAP_CONF"/);
  assert.match(source, /run_as_root cp "\$INSTALL_TMP\/nginx\/mia-cloud-site\.conf" "\$NGINX_SITE_CONF"/);
  assert.match(source, /run_as_root nginx -t[\s\S]*?run_as_root systemctl reload nginx/);
  assert.match(source, /Restored nginx map from \$NGINX_MAP_BACKUP/);
  assert.match(source, /Restored nginx site from \$NGINX_SITE_BACKUP/);
  assert.match(source, /unit_value\(\) \{[\s\S]*?awk -F= -v key="\$key"/);
  assert.match(source, /rollback_data_owner\(\) \{[\s\S]*?restored_user="\$\(unit_value User "\$UNIT_BACKUP"\)"/);
  assert.match(source, /restored_group="\$\(unit_value Group "\$UNIT_BACKUP"\)"/);
  assert.match(source, /chown_data_for_rollback\(\) \{[\s\S]*?run_as_root chown -R "\$owner" "\$DATA_DIR"/);
  assert.match(source, /User=\$SERVICE_USER/);
  assert.match(source, /Group=\$SERVICE_USER/);
  assert.match(source, /rollback_install\(\) \{[\s\S]*?systemctl stop "\$SERVICE"[\s\S]*?tar -xzf "\$DATA_BACKUP" -C "\$\(dirname "\$DATA_DIR"\)"/);
  assert.match(source, /rollback_after_public_verification_failure\(\) \{[\s\S]*?systemctl stop "\$SERVICE"[\s\S]*?tar -xzf "\$DATA_BACKUP" -C "\$\(dirname "\$DATA_DIR"\)"/);
  assert.match(source, /Running doctor against \$SMOKE_URL/);
  assert.match(source, /MIA_DOCTOR_EXPECT_RELEASE_COMMIT="\$EXPECTED_RELEASE_COMMIT"[\s\S]*?MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="\$EXPECTED_RELEASE_BUILT_AT"[\s\S]*?node "\$INSTALL_TMP\/doctor-cloud\.js" "\$SMOKE_URL"/);
  assert.match(source, /rollback_after_public_verification_failure \|\| echo "Rollback after doctor failure failed; inspect this host manually\."/);
  assert.match(source, /Running smoke against \$SMOKE_URL/);
  assert.match(source, /MIA_SMOKE_EXPECT_RELEASE_COMMIT="\$EXPECTED_RELEASE_COMMIT"[\s\S]*?MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="\$EXPECTED_RELEASE_BUILT_AT"[\s\S]*?node "\$INSTALL_TMP\/smoke-cloud\.js" "\$SMOKE_URL"/);
  assert.match(source, /rollback_after_public_verification_failure \|\| echo "Rollback after smoke failure failed; inspect this host manually\."/);
  assert.match(source, /Running site verification against \$SMOKE_URL/);
  assert.match(source, /node "\$INSTALL_TMP\/verify-site-verification\.js" "\$SMOKE_URL"/);
  assert.match(source, /Rollback after site verification failure failed; inspect this host manually\./);
  assert.match(source, /tar -C "\$\(dirname "\$DATA_DIR"\)" -czf "\$DATA_BACKUP" "\$\(basename "\$DATA_DIR"\)"[\s\S]*?tar -tzf "\$DATA_BACKUP"/);
  assert.match(source, /tar -C "\$\(dirname "\$API_DIR"\)" -czf "\$API_BACKUP" "\$\(basename "\$API_DIR"\)"[\s\S]*?tar -tzf "\$API_BACKUP"/);
  assert.match(source, /tar -C "\$\(dirname "\$WEB_DIR"\)" -czf "\$WEB_BACKUP" "\$\(basename "\$WEB_DIR"\)"[\s\S]*?tar -tzf "\$WEB_BACKUP"/);
});

test("ssh deploy script restores data backups during install and public verification rollback", () => {
  const source = readScript("scripts/deploy-cloud-release.sh");
  assert.match(source, /validate_deploy_sudo\(\) \{[\s\S]*?MIA_DEPLOY_SUDO must be a simple command/);
  assert.match(source, /grep -q '\[\^A-Za-z0-9_\.\/ -\]'/);
  assert.match(source, /print_ssh_help\(\) \{[\s\S]*?cloud:deploy:authorize-help/);
  assert.match(source, /print_ssh_help\(\) \{[\s\S]*?ssh-add -l[\s\S]*?Local ssh-agent identities: none loaded[\s\S]*?ssh-add ~\/\.ssh\/id_ed25519/);
  assert.match(source, /print_ssh_help\(\) \{[\s\S]*?A key is loaded locally; if SSH is still denied, inspect VPS authorized_keys and sshd policy/);
  assert.match(source, /cloud:deploy:ssh-diagnose/);
  assert.match(source, /shell_quote\(\) \{[\s\S]*?sed "s\/'\/'\\\\\\\\''\/g"/);
  assert.doesNotMatch(source, /@[Qq]\}/);
  assert.match(source, /if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "\$REMOTE" "true"; then[\s\S]*?print_ssh_help[\s\S]*?exit 255/);
  assert.match(source, /DATA_BACKUP="\$BACKUP_DIR\/mia-cloud-data-\$DEPLOY_ID\.tgz"/);
  assert.match(source, /NGINX_MAP_CONF="\$\{MIA_DEPLOY_NGINX_MAP_CONF:-\/etc\/nginx\/conf\.d\/mia-websocket-map\.conf\}"/);
  assert.match(source, /NGINX_SITE_CONF="\$\{MIA_DEPLOY_NGINX_SITE_CONF:-\/etc\/nginx\/sites-enabled\/mia-web\}"/);
  assert.match(source, /NGINX_MAP_BACKUP="\$BACKUP_DIR\/mia-cloud-nginx-map-\$DEPLOY_ID\.conf"/);
  assert.match(source, /NGINX_SITE_BACKUP="\$BACKUP_DIR\/mia-cloud-nginx-site-\$DEPLOY_ID\.conf"/);
  assert.match(source, /SERVICE_USER="\$\{MIA_DEPLOY_SERVICE_USER:-mia-cloud\}"/);
  assert.match(source, /command -v id >\/dev\/null && command -v chown >\/dev\/null/);
  assert.match(source, /command -v docker >\/dev\/null && \(command -v usermod >\/dev\/null \|\| test -x \/usr\/sbin\/usermod\)/);
  assert.match(source, /id -u \$SERVICE_USER_QUOTED >\/dev\/null 2>&1 \|\| command -v useradd >\/dev\/null \|\| test -x \/usr\/sbin\/useradd/);
  assert.match(source, /ensure_service_user\(\) \{[\s\S]*?useradd_cmd=.*useradd[\s\S]*?--system --user-group --home-dir "\$DATA_DIR" --shell "\\\$login_shell" "\\\$SERVICE_USER"/);
  assert.match(source, /ensure_docker_access\(\) \{[\s\S]*?grep -q '\^docker:' \/etc\/group[\s\S]*?usermod_cmd=.*usermod[\s\S]*?run_as_root "\\\$usermod_cmd" -aG docker "\\\$SERVICE_USER"/);
  assert.match(source, /AGENT_DOCKER_NETWORK="\$\{MIA_CLOUD_AGENT_DOCKER_NETWORK:-mia-cloud\}"/);
  assert.match(source, /LITELLM_CONTAINER="\$\{MIA_LITELLM_CONTAINER:-litellm\}"/);
  assert.match(source, /SKIP_HERMES_IMAGE_BUILD="\$\{MIA_DEPLOY_SKIP_HERMES_IMAGE_BUILD:-\$\{MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD:-\$\{MIA_SKIP_HERMES_IMAGE_BUILD:-\}\}\}"/);
  assert.match(source, /docker network inspect "\$AGENT_DOCKER_NETWORK"[\s\S]*?docker network create "\$AGENT_DOCKER_NETWORK"/);
  assert.match(source, /docker container inspect "\$LITELLM_CONTAINER"[\s\S]*?docker network connect "\$AGENT_DOCKER_NETWORK" "\$LITELLM_CONTAINER"/);
  assert.match(source, /MIA_DEPLOY_SKIP_HERMES_IMAGE_BUILD=1 but image is missing/);
  assert.match(source, /docker image inspect "\$HERMES_IMAGE"/);
  assert.match(source, /AGENT_MODEL_BASE_URL="\$\{MIA_CLOUD_AGENT_MODEL_BASE_URL:-http:\/\/litellm:4000\/v1\}"/);
  assert.match(source, /AGENT_MODEL_API_KEY="\$\{MIA_CLOUD_AGENT_MODEL_API_KEY:-\$\{MIA_LITELLM_API_KEY:-\}\}"/);
  assert.match(source, /Environment=MIA_CLOUD_AGENT_DOCKER_NETWORK=\$AGENT_DOCKER_NETWORK/);
  assert.match(source, /Environment=MIA_CLOUD_AGENT_MODEL_BASE_URL=\$AGENT_MODEL_BASE_URL/);
  assert.match(source, /Environment=MIA_CLOUD_AGENT_MODEL_API_KEY=\$AGENT_MODEL_API_KEY/);
  assert.match(source, /Environment=MIA_CLOUD_PUBLIC_URL=\$PUBLIC_URL/);
  assert.match(source, /EXTRA_ALLOWED_ORIGINS="\$\{MIA_CLOUD_EXTRA_ALLOWED_ORIGINS:-https:\/\/gifgif\.cn\}"/);
  assert.match(source, /Environment=MIA_CLOUD_ALLOWED_ORIGINS=\$ALLOWED_ORIGINS/);
  assert.match(source, /run_as_root chown -R "\\\$SERVICE_USER:\\\$SERVICE_USER" "\$DATA_DIR"/);
  assert.match(source, /sync_web_release\(\) \{[\s\S]*?\$REMOTE_RELEASE_DIR\/web\/downloads[\s\S]*?rsync -a --delete --exclude '\/downloads\/' "\$REMOTE_RELEASE_DIR\/web\/" "\$WEB_DIR\/"/);
  assert.match(source, /run_as_root cp "\$REMOTE_RELEASE_DIR\/nginx\/mia-websocket-map\.conf" "\$NGINX_MAP_CONF"/);
  assert.match(source, /run_as_root cp "\$REMOTE_RELEASE_DIR\/nginx\/mia-cloud-site\.conf" "\$NGINX_SITE_CONF"/);
  assert.match(source, /run_as_root nginx -t[\s\S]*?run_as_root systemctl reload nginx/);
  assert.match(source, /Restored nginx map from \$NGINX_MAP_BACKUP/);
  assert.match(source, /Restored nginx site from \$NGINX_SITE_BACKUP/);
  assert.match(source, /unit_tmp="\$REMOTE_RELEASE_DIR\/\$SERVICE\.service"/);
  assert.doesNotMatch(source, /unit_tmp="\\\$REMOTE_RELEASE_DIR\//);
  assert.match(source, /unit_value\(\) \{[\s\S]*?awk -F= -v key="\\\$key"/);
  assert.match(source, /rollback_data_owner\(\) \{[\s\S]*?restored_user="\\\$\(unit_value User "\$UNIT_BACKUP"\)"/);
  assert.match(source, /restored_group="\\\$\(unit_value Group "\$UNIT_BACKUP"\)"/);
  assert.match(source, /chown_data_for_rollback\(\) \{[\s\S]*?run_as_root chown -R "\\\$owner" "\$DATA_DIR"/);
  assert.match(source, /User=\$SERVICE_USER/);
  assert.match(source, /Group=\$SERVICE_USER/);
  assert.doesNotMatch(source, /mia-cloud-backup-\\\$\(date/);
  assert.match(source, /run_as_root tar -C "\$\(dirname "\$DATA_DIR"\)" -czf "\$DATA_BACKUP" "\$\(basename "\$DATA_DIR"\)"/);
  assert.match(source, /rollback_install\(\) \{[\s\S]*?systemctl stop "\$SERVICE"[\s\S]*?tar -xzf "\$DATA_BACKUP" -C "\$\(dirname "\$DATA_DIR"\)"/);
  assert.match(source, /rollback_remote\(\) \{[\s\S]*?systemctl stop "\$SERVICE"[\s\S]*?tar -xzf "\$DATA_BACKUP" -C "\$\(dirname "\$DATA_DIR"\)"/);
  assert.match(source, /==> Running public doctor/);
  assert.match(source, /MIA_DOCTOR_EXPECT_RELEASE_COMMIT="\$EXPECTED_RELEASE_COMMIT"[\s\S]*?MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="\$EXPECTED_RELEASE_BUILT_AT"[\s\S]*?npm run cloud:doctor -- "\$PUBLIC_URL"/);
  assert.match(source, /Public doctor failed; attempting remote rollback/);
  assert.match(source, /==> Running public smoke/);
  assert.match(source, /MIA_DEPLOY_SKIP_SMOKE/);
  assert.match(source, /Skipping public smoke because MIA_DEPLOY_SKIP_SMOKE=1/);
  assert.match(source, /MIA_SMOKE_EXPECT_RELEASE_COMMIT="\$EXPECTED_RELEASE_COMMIT"[\s\S]*?MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="\$EXPECTED_RELEASE_BUILT_AT"[\s\S]*?npm run cloud:smoke -- "\$PUBLIC_URL"/);
  assert.match(source, /Public smoke failed; attempting remote rollback/);
  assert.match(source, /==> Running public site verification/);
  assert.match(source, /npm run cloud:site-verify -- "\$PUBLIC_URL"/);
  assert.match(source, /Public site verification failed; attempting remote rollback/);
  assert.match(source, /tar -C "\$\(dirname "\$DATA_DIR"\)" -czf "\$DATA_BACKUP" "\$\(basename "\$DATA_DIR"\)"[\s\S]*?tar -tzf "\$DATA_BACKUP"/);
  assert.match(source, /tar -C "\$\(dirname "\$API_DIR"\)" -czf "\$API_BACKUP" "\$\(basename "\$API_DIR"\)"[\s\S]*?tar -tzf "\$API_BACKUP"/);
  assert.match(source, /tar -C "\$\(dirname "\$WEB_DIR"\)" -czf "\$WEB_BACKUP" "\$\(basename "\$WEB_DIR"\)"[\s\S]*?tar -tzf "\$WEB_BACKUP"/);
});

test("ssh deploy dry run prints local release handoff", () => {
  const source = readScript("scripts/deploy-cloud-release.sh");
  assert.match(source, /if \[ "\$DEPLOY_DRY_RUN" = "1" \]; then[\s\S]*?Mia Cloud deploy dry run completed\./);
  assert.match(source, /npm run cloud:release:handoff:file[\s\S]*?npm run cloud:release:handoff:verify[\s\S]*?npm run cloud:release:handoff:bundle[\s\S]*?npm run cloud:release:handoff:bundle:verify[\s\S]*?npm run cloud:release:handoff[\s\S]*?exit 0/);
  assert.match(source, /npm run cloud:release:handoff[\s\S]*?exit 0/);
});

test("release builder includes operator README with safe install verification", () => {
  const source = readScript("scripts/build-cloud-release.js");
  assert.match(source, /function writeReleaseReadme\(\)/);
  assert.match(source, /function writeNginxConfigs\(\)/);
  assert.match(source, /copyDir\("src\/cloud-agent", path\.join\(apiDir, "src", "cloud-agent"\)\)/);
  assert.doesNotMatch(source, /"api\/src\/cloud-agent\/default-bot\.js"/);
  assert.doesNotMatch(source, /default-fellow\.js/);
  assert.match(source, /"api\/src\/cloud-agent\/attachment-materializer\.js"/);
  assert.match(source, /"api\/src\/cloud-agent\/group-orchestrator\.js"/);
  assert.match(source, /"api\/src\/cloud-agent\/dispatcher\.js"/);
  assert.match(source, /"README\.md"/);
  assert.match(source, /"nginx\/mia-websocket-map\.conf"/);
  assert.match(source, /"nginx\/mia-cloud-site\.conf"/);
  assert.match(source, /function writeIcoFromPng\(/);
  assert.match(source, /"web\/favicon\.ico"/);
  assert.match(source, /writeIcoFromPng\(path\.join\(webDir, "icon-192\.png"\), path\.join\(webDir, "favicon\.ico"\)\)/);
  assert.match(source, /location = \/updates\/latest-mac\.yml/);
  assert.match(source, /alias \/var\/www\/mia-updates\/latest-mac\.yml/);
  assert.match(source, /location \/updates\//);
  assert.match(source, /alias \/var\/www\/mia-updates\//);
  assert.match(source, /proxy_set_header Sec-WebSocket-Protocol \$http_sec_websocket_protocol/);
  assert.match(source, /location = \/favicon\.ico/);
  assert.match(source, /location = \/manifest\.webmanifest/);
  assert.match(source, /application\/manifest\+json webmanifest/);
  assert.match(source, /client_max_body_size 18m/);
  assert.match(source, /add_header Strict-Transport-Security/);
  assert.match(source, /server_name mia\.gifgif\.cn gifgif\.cn/);
  assert.match(source, /ssl_certificate \/etc\/letsencrypt\/live\/mia\.gifgif\.cn\/fullchain\.pem/);
  assert.match(source, /ssl_certificate_key \/etc\/letsencrypt\/live\/mia\.gifgif\.cn\/privkey\.pem/);
  assert.match(source, /return 301 https:\/\/\$host\$request_uri/);
  assert.match(source, /MIA_INSTALL_VERIFY_ONLY=1 bash install-cloud-release-local\.sh \/tmp\/mia-cloud-release\.tgz/);
  assert.match(source, /MIA_DOCTOR_EXPECT_RELEASE_COMMIT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.source\?\.\gitCommit \|\| ''\)\)"\)"/);
  assert.match(source, /MIA_DOCTOR_EXPECT_RELEASE_BUILT_AT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.builtAt \|\| ''\)\)"\)"/);
  assert.match(source, /node doctor-cloud\.js https:\/\/mia\.gifgif\.cn/);
  assert.match(source, /"diagnose-deploy-ssh\.js"/);
  assert.match(source, /npm run cloud:deploy:ssh-diagnose/);
  assert.match(source, /does not print private-key material/);
  assert.match(source, /MIA_SMOKE_EXPECT_RELEASE_COMMIT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.source\?\.\gitCommit \|\| ''\)\)"\)"/);
  assert.match(source, /MIA_SMOKE_EXPECT_RELEASE_BUILT_AT="\$\(node -e "const m=require\('\.\/manifest\.json'\); process\.stdout\.write\(String\(m\.builtAt \|\| ''\)\)"\)"/);
  assert.match(source, /node smoke-cloud\.js https:\/\/mia\.gifgif\.cn/);
  assert.match(source, /"web\/5a371047c22c89872f93f00c7d8af123\.txt"/);
  assert.match(source, /"verify-site-verification\.js"/);
  assert.match(source, /copyFile\("scripts\/verify-site-verification\.js", path\.join\(distDir, "verify-site-verification\.js"\)\)/);
  assert.match(source, /node verify-site-verification\.js https:\/\/mia\.gifgif\.cn/);
  assert.match(source, /Release web root must include the site verification txt file with the expected content/);
  assert.match(source, /"prepare-cloud-smoke-account\.js"/);
  assert.match(source, /node prepare-cloud-smoke-account\.js https:\/\/mia\.gifgif\.cn/);
  assert.match(source, /MIA_CLOUD_TOKEN="<smoke-account-token>"/);
  assert.match(source, /MIA_SMOKE_REQUIRE_BRIDGE=1/);
  assert.match(source, /MIA_MODEL_GATEWAY=deepseek/);
  assert.match(source, /\/admin\/model/);
  assert.match(source, /MIA_DEEPSEEK_API_KEY=<DeepSeek API key>` is an optional bootstrap fallback/);
  assert.match(source, /MIA_CLOUD_INTERNAL_MODEL_PROXY_KEY=<random internal proxy secret>/);
  assert.match(source, /\/api\/admin\/model-credits\/grant/);
  assert.match(source, /same Mia Cloud account/);
  assert.match(source, /does not require a separate local approval click/);
  assert.match(source, /Agent permission mode remains/);
  assert.match(source, /device authentication/);
  assert.match(source, /full Mia project checkout/);
  assert.match(source, /not run from the extracted Cloud release directory/);
  assert.match(source, /cd \/path\/to\/mia/);
  assert.match(source, /MIA_CLOUD_URL=https:\/\/mia\.gifgif\.cn/);
  assert.match(source, /MIA_CLOUD_TOKEN="<smoke-account-token>"/);
  assert.match(source, /npm run bridge/);
  assert.match(source, /mia-cloud-bridge-smoke-ok/);
  assert.match(source, /Release README must document verify-only local install/);
  assert.match(source, /Release README must document expected-release public doctor, smoke, and site verification/);
  assert.match(source, /Release README must document standalone bridge same-account startup from a full project checkout/);
  assert.match(source, /Release README must document same-account desktop bridge control without a separate remote approval gate/);
  assert.match(source, /Release nginx site must preserve the WebSocket Sec-WebSocket-Protocol header/);
  assert.match(source, /Release nginx site must send HTTPS HSTS/);
  assert.match(source, /Release nginx site must serve \/favicon\.ico as a real static icon/);
  assert.match(source, /Release nginx site must serve \/manifest\.webmanifest with application\/manifest\+json/);
  assert.match(source, /Release nginx site must include TLS certificate paths/);
  assert.match(source, /Release nginx site must serve both mia\.gifgif\.cn and gifgif\.cn/);
  assert.match(source, /Release nginx site must redirect HTTP to HTTPS/);
});

test("package exposes repeatable desktop permission smoke without enabling it in default tests", () => {
  const pkg = JSON.parse(readScript("package.json"));
  assert.equal(pkg.scripts["desktop:permission-smoke"], "node scripts/smoke-desktop-permission.js");
  assert.doesNotMatch(pkg.scripts.test, /desktop:permission-smoke|smoke-desktop-permission/);
  const source = readScript("scripts/smoke-desktop-permission.js");
  assert.match(source, /MIA_DISABLE_BACKGROUND_STARTUP/);
  assert.match(source, /MIA_PERMISSION_DIALOG_AUDIT_FILE/);
  assert.match(source, /status !== "running"/);
  assert.match(source, /MIA_PERMISSION_SMOKE_MANUAL/);
  assert.match(source, /MIA_PERMISSION_SMOKE_WINDOW_SETTLE_MS/);
  assert.match(source, /MIA_ALLOW_MULTIPLE_INSTANCES/);
  assert.match(source, /statusAfterReject/);
  assert.match(source, /允许远程运行本机 Agent？/);
  assert.match(source, /defaultId/);
  assert.match(source, /cancelId/);
  const main = readScript("src/main.js");
  assert.match(main, /MIA_ALLOW_MULTIPLE_INSTANCES/);
  assert.match(main, /!IS_DAEMON_PROCESS && !ALLOW_MULTIPLE_INSTANCES/);
});

test("desktop update publisher injects versioned release notes into mac feed", () => {
  const pkg = JSON.parse(readScript("package.json"));
  const version = pkg.version;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-update-publish-"));
  const releaseDir = path.join(tempDir, "release");
  const stageDir = path.join(tempDir, "stage");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "latest-mac.yml"), yaml.dump({
    version,
    files: [{ url: `Mia-${version}-arm64-mac.zip`, sha512: "abc", size: 3 }],
    path: `Mia-${version}-arm64-mac.zip`,
    sha512: "abc",
    releaseDate: "2026-06-17T00:00:00.000Z",
  }));
  fs.writeFileSync(path.join(releaseDir, `Mia-${version}-arm64-mac.zip`), "zip");
  fs.writeFileSync(path.join(releaseDir, `Mia-${version}-arm64-mac.zip.blockmap`), "blockmap");
  fs.writeFileSync(path.join(releaseDir, `Mia-${version}-Apple-Silicon.dmg`), "dmg");

  childProcess.execFileSync(process.execPath, [path.join(root, "scripts", "publish-mac-update.js")], {
    cwd: root,
    env: {
      ...process.env,
      MIA_RELEASE_DIR: releaseDir,
      MIA_UPDATE_STAGING_DIR: stageDir,
    },
    stdio: "pipe",
  });

  const stagedFeed = yaml.load(fs.readFileSync(path.join(stageDir, "latest-mac.yml"), "utf8"));
  const expectedReleaseNotes = readScript(`docs/releases/${version}.md`).trim();
  assert.equal(stagedFeed.version, version);
  assert.match(stagedFeed.releaseNotes, new RegExp(`# Mia ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(stagedFeed.releaseNotes, expectedReleaseNotes);
  assert.match(readScript("scripts/publish-win-update.js"), /attachDesktopReleaseNotes/);
});

test("cloud blockers command prints exact remaining gate commands", () => {
  const pkg = JSON.parse(readScript("package.json"));
  assert.equal(pkg.scripts["cloud:blockers"], "node scripts/print-cloud-blockers.js");
  assert.equal(pkg.scripts["cloud:site-verify"], "node scripts/verify-site-verification.js");
  const source = readScript("scripts/print-cloud-blockers.js");
  assert.match(source, /cloud:prod:verify/);
  assert.match(source, /cloud:site-verify/);
  assert.match(source, /cloud:deploy:ssh-diagnose/);
  assert.match(source, /buildSshAuthorizationHelp/);
  assert.match(source, /function safeSshAuthorizationHelp/);
  assert.match(source, /ssh-keygen -t ed25519/);
  assert.match(source, /Public key is not ready/);
  assert.match(source, /npm run cloud:audit/);
  assert.match(source, /--json/);
  assert.match(source, /buildCloudBlockerSummary/);
  assert.match(source, /publicUrl/);
  assert.match(source, /requiredCommands/);
  assert.match(source, /gate\.production-deploy/);
  assert.doesNotMatch(source, /gate\.native-permission-click/);
});
