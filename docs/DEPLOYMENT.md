# Mia Deployment

这份文档是 Mia 的部署总入口，覆盖桌面端打包、Cloud/Web 发布、生产验证、回滚和排障。Cloud 服务器的 systemd、nginx、LiteLLM、Docker worker 细节见 [cloud-deployment.md](cloud-deployment.md)。

## 部署面

Mia 当前有三个需要区分的部署面：

- Desktop：Electron 桌面端，产物在 `release/`，macOS Apple Silicon 和 Intel 分开打包；Windows 脚本已存在，按实际验证结果发布。
- Cloud/Web：Cloud API、Web 静态资源、Hermes worker 镜像上下文和部署脚本，产物在 `dist/`。
- Bridge：桌面端或独立 `npm run bridge` 连接 Cloud，让同账号 Web/移动端调用在线桌面 Agent。

不要把这三类混在同一次验证里。Desktop 包能启动，不代表 Cloud 已部署；Cloud `/api/health` 正常，也不代表线上是当前 release。

## 环境要求

开发机：

- Node.js 和 npm。
- Electron builder 依赖的系统工具。
- macOS 打 macOS 包；Windows 包建议在 Windows 或已验证的 CI 环境中构建。
- 需要 SSH 部署 Cloud 时，开发机必须能非交互登录目标服务器。

Cloud 生产服务器：

- Node.js 25+，因为 Cloud SQLite 路径依赖 `node:sqlite`。
- `npm`、`rsync`、`systemctl`、`tar`、`docker`。
- nginx 和有效 TLS 证书。
- 非 root 的 `mia-cloud` 服务用户。
- Mia 内部模型代理 secret，用于 Cloud Hermes worker 的付费平台模型网关；DeepSeek API Key 通过 `/admin/model` 保存，`MIA_DEEPSEEK_API_KEY` 仅作可选兜底；LiteLLM 仅在多供应商网关模式下可选。

默认生产布局：

```text
API service:      /opt/mia-cloud/server.js
Cloud data:       /var/lib/mia-cloud
Agent user roots: /var/lib/mia-cloud-agent-users
Web root:         /var/www/mia-web
Public origin:    https://mia.gifgif.cn
Local API:        127.0.0.1:4175
systemd service:  mia-cloud
```

## 部署前检查

先确认源码和本地结构：

```bash
npm install
npm run check
```

改动较大时跑全量测试：

```bash
npm test
```

注意：`cloud-productization-audit` / release audit 类测试会检查当前 release handoff、生产部署和公网版本。如果生产还没部署到最新包，它们可能失败。遇到这种失败先跑 doctor、handoff、blocker 脚本确认真实发布状态，不要直接改断言。

Cloud 发布前建议先跑：

```bash
npm run cloud:doctor -- https://mia.gifgif.cn
npm run cloud:deploy:dry-run
```

`cloud:deploy:dry-run` 会跑本地结构检查、测试、Cloud release 构建、归档 checksum、install verify-only、handoff 和 transfer bundle 验证，但不会 SSH、上传或修改服务器。

## Desktop 打包

macOS 包：

```bash
npm run dist:mac
```

macOS Intel 包：

```bash
npm run dist:mac:intel
```

Windows 包：

```bash
npm run dist:win
```

产物目录：

```text
release/
```

轻量包不会打包 Claude Code、Codex CLI，也不打包 Hermes runtime。

桌面包验证至少包括：

- 安装或打开产物。
- 首次启动能创建 runtime。
- 已安装的 `claude` / `codex` / `openclaw` 可以被探测；缺失时本机引擎区的安装按钮会调用官方包索引安装。
- 用户自行安装的官方 Hermes（在 PATH 上）能被探测并复用；"安装官方 Hermes" 按钮能从 PyPI（国内走清华镜像、回退官方）装上并被检测到。
- 登录 Cloud 后，桌面 Bridge 在 Web 端显示在线。

如果正在运行 Mia，打包、覆盖、签名或删除 release 文件可能失败。先退出 app，再重新构建。

### macOS DMG 安装窗口样式

`scripts/dist:mac` 末尾用 `scripts/create-mac-dmg.js` 生成带样式的安装窗口，规格是固定的（改动需同步更新这里）：

- 自定义背景图 `build/dmg-background.png`（600×420），窗口大小 600×420、隐藏工具栏/侧边栏/状态栏。
- 图标尺寸 96、文字 14、不自动排列；**`Mia.app` 在左 `(180,238)`、`Applications` 软链在右 `(420,238)`**——左拖右、符合 macOS 拖拽安装直觉。
- 布局写进 `.DS_Store`：`create-mac-dmg.js` 先用 `write-dmg-ds-store.py`（无头写，CI 可用）写一遍，再用 Finder/osascript 复刷一遍兜底。

**构建机必须保持干净——这是踩过的坑：** Finder 同名卷会自动改名（`/Volumes/Mia` 被占 → 新卷挂成 `/Volumes/Mia 1`）。`write-dmg-ds-store.py` 的背景图书签是**含卷名的绝对路径**，一旦暂存卷不是规范的 `Mia`，固化进 `.DS_Store` 的就是 `/Volumes/Mia 1`，用户机器上卷名对不上 → **背景失效、白底默认窗口**。`create-mac-dmg.js` 现在打包前会 `detachStaleVolumes()` 卸掉所有 `/Volumes/Mia*`；**别在挂着 Mia 卷（旧 dmg / 正在运行的安装盘）时打包**。验证产物：挂载 dmg，读 `.DS_Store` 的 `icvp.backgroundImageAlias`，里面的卷路径必须是 `/Volumes/Mia`。

### 桌面自动更新（in-app update）

- 发布命令：`npm run release:mac`（= `dist:mac` + `scripts/publish-mac-update.js`）暂存 `latest-mac.yml` + dmg/zip/blockmap；`npm run release:win`（= `dist:win` + `scripts/publish-win-update.js`）暂存 `latest.yml` + NSIS setup/blockmap。设置 `MIA_UPDATE_DEPLOY=1` 时同步到 VPS 的 `/var/www/mia-updates/`，由 `https://mia.gifgif.cn/updates/` 提供。
- 发版必须先 **bump `package.json` 的 `version`**，并新增 `docs/releases/<version>.md`。发布脚本会把这份说明写进 `latest-mac.yml` / `latest.yml` 的 `releaseNotes`，桌面更新弹窗会展示摘要；缺失时发布会直接失败，避免旧客户端版本号不变或变更说明遗漏。
- 当前更新通道 = **generic HTTPS**（`build.publish` = `generic`, `url` = `https://mia.gifgif.cn/updates/`）；客户端用 electron-updater 在 macOS 拉 `latest-mac.yml`，在 Windows 拉 `latest.yml`。
- 客户端检查到新版本后是强制更新：主界面会被更新遮罩锁定，下载进度来自 `download-progress`，下载完成后自动进入安装并重启。进入安装态时只能锁页面交互，不能继续用 native `setClosable(false)` 锁窗口；macOS 的 Squirrel quit/install 路径需要窗口可关闭，否则可能出现进度到 100% 但 App 不退出，用户强制退出后才完成更新。
- macOS 正式分发前应尽量公证并装订票据。一次性保存凭据：`xcrun notarytool store-credentials mia --apple-id <apple-id> --team-id S4NWU843M5`；然后执行 `npm run notarize:mac` 或 `npm run notarize:mac:intel`。若 Apple 返回 `403 Invalid or inaccessible developer team ID`，说明该 Apple ID 没有 `S4NWU843M5` 团队的公证权限，需要换有权限的账号或 App Store Connect API Key。
- 临时例外：如果构建机缺少 notarytool profile、Apple 团队权限或 App Store Connect API Key，允许继续把已签名但未公证的 DMG/ZIP 正常推送到官网更新源和 GitHub Release，并继续部署 Cloud/Web。该状态属于分发凭据暂时不可用，不应阻断正常发布；发布记录和交接说明里必须保留“未公证/无法公证”的事实，后续补齐凭据后再重新公证并覆盖同版本资产。

> **旧包迁移限制**：已经安装的 GitHub-provider 旧包只会去 GitHub release 检查更新。第一次迁移要发一个桥接版本：同一个新版本同时发布到 GitHub release 和 `mia.gifgif.cn/updates/`。旧包从 GitHub 升到桥接版本后，桥接版本内置的 generic provider 会让之后更新完全走 `mia.gifgif.cn/updates/`。

#### release → VPS 自动部署链路（`.github/workflows/company-deploy.yml`）

- `release: published` 触发自托管 runner（`mia-deploy`）跑 `publish-release-assets`：`gh release download` 拉资产 → `MIA_UPDATE_DEPLOY=1 publish-mac-update.js` 经公司 JumpServer 推到 VPS 更新源。**不需要手动 SSH 到服务器**。
- **弯路提示（慢的回拉）：** runner 在国内，从 GitHub 下载 ~240MB 资产极慢（一次跑过 ~1 小时），mac 包又只能在 macOS + 签名证书的机器上构建，所以二进制会「本地构建 → 传 GitHub → 国内 runner 再从 GitHub 拉回」绕一圈。要根治就别让二进制过 GitHub：让构建机直接 rsync 到 VPS，或让 runner 自己构建后直推。runner 装到 VPS（上海，Linux）解决不了这条——它仍要从 GitHub 拉、且无法构建签名 mac 包。

## Cloud/Web 发布

生成 Cloud release：

```bash
npm run cloud:release
```

主要产物：

```text
dist/mia-cloud-release/
dist/mia-cloud-release.tgz
dist/mia-cloud-release.tgz.sha256
dist/mia-cloud-release-handoff.txt
dist/mia-cloud-release-transfer.tgz
dist/mia-cloud-release-transfer.tgz.sha256
```

本地验证 release 包：

```bash
npm run cloud:install:verify
npm run cloud:release:handoff:file
npm run cloud:release:handoff:verify
npm run cloud:release:handoff:bundle
npm run cloud:release:handoff:bundle:verify
```

SSH 可用时，真实部署：

```bash
npm run cloud:deploy
```

默认目标是 `root@mia.gifgif.cn` 和 `https://mia.gifgif.cn`。覆盖目标：

```bash
MIA_DEPLOY_REMOTE=deploy@example.com \
MIA_DEPLOY_SUDO="sudo -n" \
MIA_CLOUD_PUBLIC_URL=https://example.com \
npm run cloud:deploy
```

### 公司 JumpServer 部署通道

当前生产资产不是普通 `ProxyJump jump.ixiaochuan.cn -> root@mia.gifgif.cn:22`。JumpServer 要用它自己的“资产直连”用户名格式，否则常见现象是跳板密码通过后，第二跳直接报 `kex_exchange_identification: Connection closed by remote host`。

正确资产：

```text
JumpServer: jump.ixiaochuan.cn:2222
JumpServer 用户: zhangguiyu
资产: shtx-mia-test-miaAI
资产地址: 10.8.8.10
资产账号: root
```

本机 `~/.ssh/config` 需要一个不含密码的部署别名（已配好，列在此处供新机器复刻）：

```sshconfig
Host mia-jms-deploy
  HostName jump.ixiaochuan.cn
  Port 2222
  User zhangguiyu@root@10.8.8.10
  HostKeyAlgorithms +ssh-rsa
  PubkeyAcceptedAlgorithms +ssh-rsa
  StrictHostKeyChecking accept-new
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h-%p
  ControlPersist 1800
```

#### 一条命令部署（无需手动输密码）

JumpServer 密码存在 macOS 登录钥匙串里，由 `scripts/jms-askpass.sh` 在连接时读取，**仓库和日志里都不出现明文**。配好后部署就是一条命令：

```bash
bash scripts/deploy-cloud-jms.sh
```

该 wrapper 会自动用钥匙串密码建立可复用的跳板连接（已存在则复用），再带上腾讯云镜像源调用底层部署脚本。可叠加常规开关，例如 `MIA_DEPLOY_DRY_RUN=1`、`MIA_DEPLOY_SKIP_LOCAL_TESTS=1`、`MIA_INSTALL_SKIP_HERMES_IMAGE_BUILD=1`。

新机器一次性初始化（密码只在这一步出现，存进钥匙串后即从命令行消失）：

```bash
security add-generic-password -U -s mia-jms-deploy -a zhangguiyu -w '<JumpServer 密码>' -T /usr/bin/ssh
```

轮换密码用同一条命令（`-U` 覆盖旧值）。**密码若曾出现在聊天/工单等不可控渠道，轮换后再重存。**

> **更安全的升级路径（推荐）**：在 JumpServer 用户资料里上传一个 ed25519 公钥，改用密钥认证，磁盘上就彻底没有静态密码了。届时删除钥匙串条目并把 wrapper 里的 askpass 逻辑去掉即可。

只有在全量本地测试被无关环境或旧线上 gate 卡住，并且 `npm run check`、相关 focused tests、release checksum 和 installer verify 都通过时，才临时加 `MIA_DEPLOY_SKIP_LOCAL_TESTS=1`。

常用部署环境变量：

```text
MIA_DEPLOY_REMOTE        SSH 目标，默认 root@mia.gifgif.cn
MIA_DEPLOY_SUDO          可选 sudo 命令，例如 sudo -n
MIA_DEPLOY_API_DIR       API 安装目录，默认 /opt/mia-cloud
MIA_DEPLOY_WEB_DIR       Web 根目录，默认 /var/www/mia-web
MIA_DEPLOY_DATA_DIR      Cloud 数据目录，默认 /var/lib/mia-cloud
MIA_DEPLOY_SERVICE       systemd 服务名，默认 mia-cloud
MIA_DEPLOY_SERVICE_USER  服务用户，默认 mia-cloud
MIA_CLOUD_PUBLIC_URL     公网地址，默认 https://mia.gifgif.cn
```

SSH 不可用时，先打印给 VPS 操作员的授权命令：

```bash
npm run cloud:deploy:authorize-help
```

如果授权后仍失败，收集过滤后的 SSH 诊断：

```bash
npm run cloud:deploy:ssh-diagnose
```

没有从开发机直连 SSH 的权限时，走 operator handoff：

```bash
npm run cloud:release
npm run cloud:install:verify
npm run cloud:release:handoff:file
npm run cloud:release:handoff:verify
npm run cloud:release:handoff:bundle
npm run cloud:release:handoff:bundle:verify
```

把 `dist/mia-cloud-release-transfer.tgz` 和 `.sha256` 交给服务器操作员。服务器上的安装命令和 verify-only 命令在 `dist/mia-cloud-release-handoff.txt` 里。

## 生产验证

部署完成后，从开发机验证公网服务是否就是当前 release：

```bash
npm run cloud:prod:verify -- https://mia.gifgif.cn
```

如果还要验证服务器侧依赖：

```bash
MIA_DOCTOR_REMOTE=root@mia.gifgif.cn \
npm run cloud:prod:verify -- https://mia.gifgif.cn
```

`MIA_CLOUD_TOKEN` 是固定 smoke 账号通过微信登录后拿到的 Cloud bearer session token，只给部署验证脚本使用；它不是模型 API Key、服务器 admin token，也不是用户需要手动管理的产品概念。没有这个 token 的构建机仍然可以部署，但要显式跳过 token smoke，保留 doctor 和站点验证：

```bash
MIA_DEPLOY_SKIP_SMOKE=1 bash scripts/deploy-cloud-jms.sh
```

端到端 Bridge smoke 需要这个固定 smoke 账号，并且桌面端已经用同账号登录、Bridge 在线：

```bash
MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run cloud:smoke:account -- https://mia.gifgif.cn

MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run cloud:prod:verify:e2e -- https://mia.gifgif.cn
```

`cloud:prod:verify` 会读取 `dist/mia-cloud-release/manifest.json`，把当前包的 `gitCommit` 和 `builtAt` 注入 doctor/smoke，并验证官网根目录的 `5a371047c22c89872f93f00c7d8af123.txt` 内容。没有 `MIA_CLOUD_TOKEN` 时，`cloud:prod:verify` 的 doctor 会通过但 smoke 会失败；这种机器用 `cloud:doctor` + `cloud:site-verify` 验证部署落点，用有 smoke token 的机器再跑完整 e2e。

## 回滚

Cloud 自动部署脚本和本地 installer 会在安装前备份：

- Cloud 数据目录。
- API 目录。
- Web 目录。
- systemd unit。
- nginx map/site 配置。

如果安装、重启、doctor、smoke 或站点验证失败，脚本会尝试停止新服务、恢复备份并启动旧服务。失败后先看脚本输出里的 backup 路径，再决定是否手动恢复。

手动回滚原则：

1. 停止 `mia-cloud`。
2. 恢复 `/var/lib/mia-cloud`、`/opt/mia-cloud`、`/var/www/mia-web` 和 unit/nginx 备份。
3. `systemctl daemon-reload`。
4. `systemctl restart mia-cloud`。
5. `nginx -t && systemctl reload nginx`。
6. 重新跑 `npm run cloud:doctor -- https://mia.gifgif.cn`。

不要只回滚代码不回滚 SQLite 数据。新代码可能已经迁移了 schema，旧代码直接读取新 schema 可能失败。

Desktop 回滚通常是重新发布上一版安装包或 update artifact。Cloud release 构建会把最新可用的 macOS Apple Silicon / Intel DMG 复制到 Web downloads；回滚下载入口时要确认 `release/` 里对应 DMG、Cloud Web downloads、公开链接三者一致。

## 日志和排障

Cloud 服务日志：

```bash
journalctl -u mia-cloud -n 200 --no-pager
journalctl -u mia-cloud -f
```

nginx：

```bash
nginx -t
journalctl -u nginx -n 100 --no-pager
```

Docker / LiteLLM：

```bash
docker ps
docker logs litellm --tail 100
docker network inspect mia-cloud
```

常见问题：

- SSH denied：跑 `npm run cloud:deploy:authorize-help`，确认本机 `ssh-agent` 已加载正确 key，再跑 `cloud:deploy:ssh-diagnose`。
- `node:sqlite` 缺失：服务器 Node.js 版本低于 25，升级后重跑 doctor。
- WebSocket 连不上：确认 nginx 保留 `Sec-WebSocket-Protocol`，并且 `MIA_CLOUD_ALLOWED_ORIGINS` 包含公网 origin。
- release freshness 失败：重跑 `npm run cloud:release:handoff:file && npm run cloud:release:handoff:verify`，再跑 `cloud:prod:verify`。
- Bridge smoke 失败：确认桌面端登录同一个 smoke 账号，Cloud bridge device 在线，且 Agent 权限模式允许当前 smoke run。
- Cloud Hermes worker 起不来：确认 Docker 可用、`mia-cloud` 用户在 docker group、LiteLLM 容器和 Hermes worker 在同一 Docker network。

## 什么时候更新这份文档

以下情况必须同步更新部署说明：

- 新增或删除部署脚本。
- 改动 release 产物路径。
- 改动 systemd/nginx/LiteLLM/Docker worker 要求。
- 改动生产验证、smoke、doctor、handoff 语义。
- 改动 Desktop 打包目标或 release 发布方式。
