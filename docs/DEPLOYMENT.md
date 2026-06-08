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
- LiteLLM Proxy，用于 Cloud Hermes worker 的平台模型网关。

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
- 已安装的 `claude` / `codex` 可以被探测。
- 用户自行安装的官方 Hermes（在 PATH 上）能被探测并复用；"安装官方 Hermes" 按钮能从 PyPI（国内走清华镜像、回退官方）装上并被检测到。
- 登录 Cloud 后，桌面 Bridge 在 Web 端显示在线。

如果正在运行 Mia，打包、覆盖、签名或删除 release 文件可能失败。先退出 app，再重新构建。

### 桌面自动更新（in-app update）

- 发布命令：`npm run release:mac`（= `dist:mac` + `scripts/publish-mac-update.js`）——把 `latest-mac.yml` + dmg/zip/blockmap 暂存到 `dist/mia-updates/`；设置 `MIA_UPDATE_DEPLOY=1` 时同步到 VPS 的 `/var/www/mia-updates/`，由 `https://mia.gifgif.cn/updates/` 提供。
- 发版必须先 **bump `package.json` 的 `version`**，否则旧客户端版本号不变、不会触发更新。
- 当前更新通道 = **generic HTTPS**（`build.publish` = `generic`, `url` = `https://mia.gifgif.cn/updates/`）；客户端用 electron-updater 拉 `latest-mac.yml` + 下载 zip/blockmap。
- 产物**签名但默认未公证（notarize）**：本机可用，分发给其他 Mac 首开会被 Gatekeeper 拦——正式分发需配公证凭证重出。

> **旧包迁移限制**：已经安装的 GitHub-provider 旧包只会去 GitHub release 检查更新。第一次迁移要发一个桥接版本：同一个新版本同时发布到 GitHub release 和 `mia.gifgif.cn/updates/`。旧包从 GitHub 升到桥接版本后，桥接版本内置的 generic provider 会让之后更新完全走 `mia.gifgif.cn/updates/`。

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

端到端 Bridge smoke 需要一个固定 smoke 账号，并且桌面端已经用同账号登录、Bridge 在线：

```bash
MIA_SMOKE_USERNAME=<account> \
MIA_SMOKE_PASSWORD=<password> \
npm run cloud:smoke:account -- https://mia.gifgif.cn

MIA_SMOKE_USERNAME=<account> \
MIA_SMOKE_PASSWORD=<password> \
npm run cloud:prod:verify:e2e -- https://mia.gifgif.cn
```

`cloud:prod:verify` 会读取 `dist/mia-cloud-release/manifest.json`，把当前包的 `gitCommit` 和 `builtAt` 注入 doctor/smoke。通过这个检查才说明公网服务部署到了刚构建的 release。

## 回滚

Cloud 自动部署脚本和本地 installer 会在安装前备份：

- Cloud 数据目录。
- API 目录。
- Web 目录。
- systemd unit。
- nginx map/site 配置。

如果安装、重启、doctor 或 smoke 失败，脚本会尝试停止新服务、恢复备份并启动旧服务。失败后先看脚本输出里的 backup 路径，再决定是否手动恢复。

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
