# Mia Deployment

这份文档是 Mia 的部署总入口，覆盖桌面端打包、Cloud/Web 发布、生产验证、回滚和排障。桌面与 Cloud 的操作命令以这里为准，不再分散到其他 checklist。Cloud 服务器的 systemd、nginx、LiteLLM、云端 Claude Code 运行时细节见 [cloud-deployment.md](cloud-deployment.md)。

## 部署面

Mia 当前有三个需要区分的部署面：

- Desktop：Electron 桌面端，产物在 `release/`，macOS Apple Silicon 和 Intel 分开打包；Windows 脚本已存在，按实际验证结果发布。
- Cloud/Web：Cloud API、Web 静态资源、Cloud release bundle 和部署脚本，产物在 `dist/`。
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
- `npm`、`rsync`、`systemctl`、`tar`。
- Claude Code sandbox 依赖 `bubblewrap`（提供 `bwrap`）和 `socat`；部署脚本会在 `MIA_CLOUD_CLAUDE_CODE_SANDBOX_REQUIRED=1` 时通过 `apt-get`、`dnf` 或 `yum` 自动补齐。
- Cloud Claude Code 会使用共享只读 Python 工具环境，默认路径是 `/opt/mia-agent-runtime/python`；部署脚本会用 Python 3.12 创建 venv，并预装 `python-pptx`、`python-docx`、Excel/PDF/图片/图表/HTML 处理等常用库。可用 `MIA_CLOUD_AGENT_PYTHON_VENV`、`MIA_CLOUD_AGENT_PYTHON_BIN`、`MIA_CLOUD_AGENT_PYTHON_PACKAGES` 和 `MIA_PIP_INDEX_URL` 覆盖。
- nginx 和有效 TLS 证书。
- 非 root 的 `mia-cloud` 服务用户。
- Mia 内部模型代理 secret，用于 Cloud 付费模型网关和云端 Agent 运行时；DeepSeek API Key 通过 `/admin/model` 保存，`MIA_DEEPSEEK_API_KEY` 仅作可选兜底；LiteLLM 仅在多供应商网关模式下可选。

默认生产布局：

```text
API service:      /opt/mia-cloud/server.js
Cloud data:       /var/lib/mia-cloud
Agent user roots: /var/lib/mia-cloud-agent-users
Web root:         /var/www/mia-web
Public origin:    https://mia.gifgif.cn
Apex alias:       https://gifgif.cn
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

如果你是发布 automation 或 AI，只走这一段，不要再去拼接历史 checklist。

桌面端只有两类命令：

- 本地出包但不发布更新源：`npm run dist:mac` / `npm run dist:mac:intel` / `npm run dist:win`
- 生成并发布桌面更新源：`npm run release:mac` / `npm run release:win`

建议顺序：

```bash
npm run check
npm run dist:mac
```

或 Intel：

```bash
npm run check
npm run dist:mac:intel
```

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

桌面包携带 Claude Code、Codex 的固定 ACP bridge，但不携带用户 CLI、登录态或 Hermes Python runtime。ACP bridge 由 Rust Core 在启动时自动校验和准备；用户点击“启用 Mia 稳定版”时，客户端才从 Mia 备份源下载缺失的主 CLI 兜底资源，校验固定版本和 SHA-256 后写入 Mia 私有目录。

三引擎备份与桌面包分开构建、分开发布。备份归档仍需在对应目标平台先准备 Hermes runtime 和 managed ACP 资源，再运行：

```bash
npm run engine-backups:build -- win32-x64
npm run engine-backups:build -- darwin-arm64
npm run engine-backups:build -- darwin-x64
```

产物位于 `dist/engine-backups/v1/`，包含每个引擎的 zip 和 `manifest.json`。把整个目录同步到 `/var/www/mia-web/downloads/engine-backups/v1/`，对外地址必须是 `https://mia.gifgif.cn/downloads/engine-backups/v1/manifest.json`。发布时先上传 zip，最后原子替换 manifest，避免客户端读到尚未上传完整的资源。不要把该目录加入 electron-builder 的 `extraResources`。

`dist:mac`、`dist:mac:intel` 和 Windows release 现在内置了 packaged-Core gate：打包前会运行 `scripts/prepare-mia-core-rs.js`，把 release Rust Core 和目标平台的 ACP bridge 放进 `resources/bundled-mia-core/<platform>-<arch>/`；打包后会自动运行 `scripts/verify-packaged-mia-core.js`，直接启动产物里的 Rust Core 并等待 `/health` 成功响应。这个 gate 的目的不是“看文件在不在”，而是阻断这类真实故障：

- `beforePack` 没有生成对应平台/架构的 Rust Core
- Core 二进制缺失、不可执行或启动即崩
- 前台 `Mia.app` 能打开，但 `127.0.0.1:27861` 永远起不来

需要单独重跑这个 gate 时，用：

```bash
npm run desktop:package:verify
npm run desktop:package:verify -- --arch arm64
npm run desktop:package:verify -- --arch x64
```

也可以显式指定产物：

```bash
npm run desktop:package:verify -- --app /path/to/Mia.app
```

桌面包验证至少包括：

- 安装或打开产物。
- 首次启动能创建 runtime。
- 已安装的 `claude` / `codex` 可以被优先探测并复用；缺失时“启用 Mia 稳定版”只下载所选引擎的 Mia 固定备份，不得调用全局 npm 或第三方远程安装脚本。
- 用户自行安装的官方 Hermes（在 PATH 上）能被优先探测并复用；缺失时“启用 Mia 稳定版”按需下载固定 Python runtime，不写用户 Python 环境。
- 登录 Cloud 后，桌面 Bridge 在 Web 端显示在线。

如果正在运行 Mia，打包、覆盖、签名或删除 release 文件可能失败。先退出 app，再重新构建。`desktop:package:verify` 只验证后台 Core 能不能从产物里起来，不替代安装后的人机 smoke。

### macOS DMG 安装窗口样式

`scripts/dist:mac` 末尾用 `scripts/create-mac-dmg.js` 生成带样式的安装窗口，规格是固定的（改动需同步更新这里）：

- 自定义背景图 `build/dmg-background.png`（600×420），窗口大小 600×420、隐藏工具栏/侧边栏/状态栏。
- 图标尺寸 96、文字 14、不自动排列；**`Mia.app` 在左 `(180,238)`、`Applications` 软链在右 `(420,238)`**——左拖右、符合 macOS 拖拽安装直觉。
- 布局写进 `.DS_Store`：`create-mac-dmg.js` 先用 `write-dmg-ds-store.py`（无头写，CI 可用）写一遍，再用 Finder/osascript 复刷一遍兜底。

**构建机必须保持干净——这是踩过的坑：** Finder 同名卷会自动改名（`/Volumes/Mia` 被占 → 新卷挂成 `/Volumes/Mia 1`）。`write-dmg-ds-store.py` 的背景图书签是**含卷名的绝对路径**，一旦暂存卷不是规范的 `Mia`，固化进 `.DS_Store` 的就是 `/Volumes/Mia 1`，用户机器上卷名对不上 → **背景失效、白底默认窗口**。`create-mac-dmg.js` 现在打包前会 `detachStaleVolumes()` 卸掉所有 `/Volumes/Mia*`；**别在挂着 Mia 卷（旧 dmg / 正在运行的安装盘）时打包**。验证产物：挂载 dmg，读 `.DS_Store` 的 `icvp.backgroundImageAlias`，里面的卷路径必须是 `/Volumes/Mia`。

### 桌面自动更新（in-app update）

- 发布命令：`npm run release:mac`（= `dist:mac` + `scripts/publish-mac-update.js`）暂存 `latest-mac.yml` + dmg/zip/blockmap；`npm run release:win`（= `dist:win` + `scripts/publish-win-update.js`）暂存 `latest.yml` + NSIS setup/blockmap。设置 `MIA_UPDATE_DEPLOY=1` 时同步到 VPS 的 `/var/www/mia-updates/`，由 `https://mia.gifgif.cn/updates/` 提供。
- 发版必须先 **bump `package.json` 的 `version`**，并新增 `docs/releases/<version>.md`。发布脚本会把这份说明写进 `latest-mac.yml` / `latest.yml` 的 `releaseNotes`，桌面更新弹窗会展示摘要；缺失时发布会直接失败，避免旧客户端版本号不变或变更说明遗漏。
- `docs/releases/<version>.md` 面向普通用户，不是内部变更日志。只写用户能感知的体验变化和问题修复，避免服务器、脚本、临时文件名、内部架构名、发包流程等实现细节；也不要写“发布了新安装包”“更新到某版本”这类用户已经知道的空话。
- 当前更新通道 = **generic HTTPS**（`build.publish` = `generic`, `url` = `https://mia.gifgif.cn/updates/`）；客户端用 electron-updater 在 macOS 拉 `latest-mac.yml`，在 Windows 拉 `latest.yml`。
- 客户端检查到新版本后是强制更新：主界面会被更新遮罩锁定，下载进度来自 `download-progress`，下载完成后自动进入安装并重启。进入安装态时只能锁页面交互，不能继续用 native `setClosable(false)` 锁窗口；macOS 的 Squirrel quit/install 路径需要窗口可关闭，否则可能出现进度到 100% 但 App 不退出，用户强制退出后才完成更新。
- macOS 正式分发前应尽量公证并装订票据。一次性保存凭据：`xcrun notarytool store-credentials mia --apple-id <apple-id> --team-id S4NWU843M5`；然后执行 `npm run notarize:mac` 或 `npm run notarize:mac:intel`。若 Apple 返回 `403 Invalid or inaccessible developer team ID`，说明该 Apple ID 没有 `S4NWU843M5` 团队的公证权限，需要换有权限的账号或 App Store Connect API Key。
- 临时例外：如果构建机缺少 notarytool profile、Apple 团队权限或 App Store Connect API Key，允许继续把已签名但未公证的 DMG/ZIP 正常推送到官网更新源和 GitHub Release，并继续部署 Cloud/Web。该状态属于分发凭据暂时不可用，不应阻断正常发布；发布记录和交接说明里必须保留“未公证/无法公证”的事实，后续补齐凭据后再重新公证并覆盖同版本资产。

> **旧包迁移限制**：已经安装的 GitHub-provider 旧包只会去 GitHub release 检查更新。第一次迁移要发一个桥接版本：同一个新版本同时发布到 GitHub release 和 `mia.gifgif.cn/updates/`。旧包从 GitHub 升到桥接版本后，桥接版本内置的 generic provider 会让之后更新完全走 `mia.gifgif.cn/updates/`。

#### 本地构建机 → VPS 直推更新源

不要通过 GitHub runner/worker 回拉 release 资产再部署。VPS 和公司网络在国内，依赖 GitHub 下载会慢且不稳定；macOS 包也必须在有签名证书的 macOS 构建机上生成。正确流程是：构建机本地打包、暂存 feed，然后直接经公司 JumpServer rsync 到 VPS 的 `/var/www/mia-updates/`。

同时发布 Apple Silicon 和 Intel 时，按这个顺序执行，避免第二次打包清理掉第一套架构资产：

```bash
npm run dist:mac
node scripts/publish-mac-update.js
npm run dist:mac:intel
MIA_UPDATE_DEPLOY=1 MIA_UPDATE_REMOTE=mia-jms-deploy node scripts/publish-mac-update.js
```

最后一步会把 `dist/mia-updates/` 中合并后的 `latest-mac.yml`、两套 zip/blockmap 和 DMG 同步到 `https://mia.gifgif.cn/updates/`。发布后必须确认线上 feed 已更新：

```bash
curl -fsSL https://mia.gifgif.cn/updates/latest-mac.yml | sed -n '1,40p'
```

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

默认目标是 `root@mia.gifgif.cn` 和 `https://mia.gifgif.cn`，并把 `https://gifgif.cn` 作为同站点别名加入 nginx `server_name` 和 Cloud allowed origins。覆盖目标：

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

`MIA_CLOUD_TOKEN` 是固定 smoke 账号通过微信登录后拿到的 Cloud bearer session token，只给部署验证脚本使用；它不是模型 API Key、服务器 admin token，也不是用户需要手动管理的产品概念。没有这个 token 的构建机也可以直接部署；部署脚本会自动跳过 authenticated smoke，保留 doctor 和站点验证：

```bash
bash scripts/deploy-cloud-jms.sh
```

端到端 Bridge smoke 需要这个固定 smoke 账号，并且桌面端已经用同账号登录、Bridge 在线：

```bash
MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run cloud:smoke:account -- https://mia.gifgif.cn

MIA_CLOUD_TOKEN=<smoke-account-token> \
npm run cloud:prod:verify:e2e -- https://mia.gifgif.cn
```

`cloud:prod:verify` 会读取 `dist/mia-cloud-release/manifest.json`，把当前包的 `gitCommit` 和 `builtAt` 注入 public checks，并验证官网根目录的 `5a371047c22c89872f93f00c7d8af123.txt` 内容。没有 `MIA_CLOUD_TOKEN` 时，它会自动跳过 authenticated smoke；用有 smoke token 且同账号桌面 Bridge 在线的机器再跑完整 e2e。

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

LiteLLM / optional Docker:

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
- Cloud Claude Code 运行失败：先看 `journalctl -u mia-cloud`，确认 `bwrap` / `socat` / 共享 Python venv 安装完成，并检查 `/etc/mia-cloud/admin.env` 里的模型与 API Key 配置。

## 什么时候更新这份文档

以下情况必须同步更新部署说明：

- 新增或删除部署脚本。
- 改动 release 产物路径。
- 改动 systemd/nginx/LiteLLM/云端 Agent 运行时要求。
- 改动生产验证、smoke、doctor、handoff 语义。
- 改动 Desktop 打包目标或 release 发布方式。
