# Mia

Mia 是一个桌面优先的多 Agent 聊天平台。

它把 Bot 身份统一存到 Cloud，再把 Hermes、Claude Code、Codex、OpenClaw 这类桌面 Agent 运行目标和 `cloud-claude-code` 这类云端运行目标，放进同一套聊天、联系人、群聊、权限、同步和发布体系里。用户不需要记每个 CLI 的命令，也不需要在一堆工具窗口之间来回切换。打开 Mia，像找同事一样找一个 AI Bot，说清楚要做什么，然后让它在受控权限下执行。

一句话：**聊天是入口，Bot 是 AI 同事，桌面端是执行现场，Cloud/Web/移动端是同步和远程入口。**

## 当前状态

- 桌面端是主产品形态，基于 Electron。
- macOS 优先面向 Apple Silicon；Intel 保留独立兼容包，Windows 脚本按实际验证结果发布。
- Web/Cloud 已有账号、好友、群聊、Bot、文件、实时同步和桌面 Bridge 能力。
- `apps/mobile-rn/` 下有 React Native 移动端工程，但当前 README 以桌面端和 Cloud/Web 为主。
- 版本号以 `package.json` 为准。

公开入口：

- macOS Apple Silicon DMG：<https://mia.gifgif.cn/downloads/mia-macos-arm64-latest.dmg>
- macOS Intel DMG：<https://mia.gifgif.cn/downloads/mia-macos-intel-latest.dmg>
- Web：<https://mia.gifgif.cn>

线上是否已经部署到最新提交，以 `npm run cloud:doctor -- https://mia.gifgif.cn` 和 `npm run cloud:prod:verify -- https://mia.gifgif.cn` 的结果为准。

## Mia 解决什么问题

传统 AI 客户端通常是“一个模型，一个窗口，一段上下文”。Mia 的目标不同：

- **把 AI 当联系人管理**：Bot 有名字、头像、人设、技能、运行时和权限配置。
- **把任务放回聊天上下文**：私聊、群聊、@ 提及、回复、附件、历史消息都是一等对象。
- **把本地执行纳入权限系统**：读文件、跑命令、写代码、使用工具都要经过明确的 Agent 权限模式。
- **把多端当作同一个产品**：Cloud 负责账号、Bot 身份、同步和远程触发；桌面端和云端运行目标负责具体 Agent run。
- **把多引擎接进同一个界面**：Hermes、Claude Code、Codex、OpenClaw 走各自 adapter，但用户看到的是统一聊天体验。

## 主要能力

### 聊天与社交

- 账号注册、登录、会话同步。
- 好友请求、好友列表、DM、群聊。
- Bot 私聊和群聊 @ 提及。
- 消息增量同步、删除/隐藏、附件、流式回复。
- 桌面端有本地消息缓存，Cloud 仍是同步源。

### Bot 与 Agent

- Bot 身份统一由 Cloud 持久化：名字、头像、简介、人设、颜色、技能能力等都是同一个账号级对象。
- 运行目标通过 runtime binding 记录：`desktop-local`、`cloud-claude-code` 等只是执行位置/引擎目标，不是两套 Bot 身份。
- Agent 引擎：Hermes、Claude Code、Codex、OpenClaw。
- Claude Code / Codex 优先复用用户本机 CLI；桌面包自带固定版本的 ACP bridge，Core 启动时自动校验和准备，不要求用户手动配置 ACP。缺少本机 CLI 时仍可启用 Mia 私有稳定版。OpenClaw 仍只使用用户本机 CLI 或 ACP 后端兼容入口。
- Hermes 同样优先复用 PATH 上的用户安装；缺失时可从 Mia 备份源按需下载固定 Python + Hermes runtime。
- Bot 可以挂载技能，技能来源包括内置 skill、官方库和本地 skill 目录。
- Bot 可绑定 `cloud-claude-code` 运行目标，在云端隔离沙箱中运行，由平台统一提供 Claude Code 兼容运行时。

### 本地执行与权限

- 桌面端负责真正接触用户电脑的 Agent run。
- Agent 权限模式集中处理，敏感工具调用可走 approval UI。
- 同账号 Web/手机端可以通过 Cloud Bridge 调用桌面 Agent。
- Bridge 鉴权使用账号 token，不复用 Agent 工具权限；工具权限仍由具体 Agent run 判断。
- Claude Code 会话会保存 native session id；如果旧 session 失效，adapter 会清理并重建。

### Cloud/Web

- Cloud API 使用 SQLite 持久化用户、会话、文件、设备、Bot、运行记录和事件。
- Web 端消费 Cloud API 和实时事件，用于远程聊天和同步。
- `/api/events` 和 `/api/bridge` 使用 WebSocket，token 走 `Sec-WebSocket-Protocol`，避免落入 URL 日志。
- Cloud Claude Code 运行时按用户隔离 root、home、workspace、tmp 和共享工具环境。
- 部署总说明在 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，Cloud 服务器细节在 [docs/cloud-deployment.md](docs/cloud-deployment.md)。

### 打包与发布

- 桌面包携带 Claude/Codex 的固定 ACP bridge 资源，但不携带用户 CLI、登录态或 Hermes。Core 启动时自动校验/准备托管资源；Hermes 和缺失的本机主 CLI 仍按现有流程按需启用固定稳定备份；OpenClaw 不提供备份分发。
- release 输出目录是 `release/`，构建前后会通过 `scripts/clean-release.js` 做清理和归档整理。
- 桌面自动更新：`npm run release:mac` / `npm run release:win` 把 feed + 产物暂存/发布到 `https://mia.gifgif.cn/updates/`（发版要先 bump `package.json` 版本）。客户端检查到新版本后会锁定界面、显示下载进度并强制安装。历史 GitHub feed 只用于把旧包迁到新更新源，细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 的"桌面自动更新"。
- Cloud release 输出在 `dist/`，由 `scripts/build-cloud-release.js`、handoff、doctor、smoke、deploy 脚本串起来。

## 快速开始

### 开发环境

建议使用较新的 Node.js。Cloud 生产和相关 doctor 明确要求 Node.js 25+，因为当前 Cloud SQLite 路径依赖 `node:sqlite`。

```bash
npm install
npm start
```

开发态与已安装 Mia 并行测试时，使用隔离入口。它会自动使用独立的 `Mia-Dev` 数据目录、允许多实例，并为 Rust Core 选择独立端口：

```bash
npm run dev          # 日常开发态
npm run dev:multi    # 再开一个隔离开发态
```

这两个入口不会读取或覆盖已安装版 Mia 的用户数据；如果需要指定临时目录或端口，可以继续传入 `MIA_USER_DATA_DIR`、`MIA_CORE_PORT`。

常用命令：

```bash
npm run check       # 项目结构和关键语法自检
npm test            # 全量 node:test
npm run web         # 本地 Web 预览
npm run cloud       # 本地 Cloud API
npm run bridge      # 本地 Agent bridge
```

桌面端启动入口：

```bash
npm start
# 等价于
npm run open
```

开发态也会由 Rust Core 自动准备 Claude/Codex ACP 资源，写入当前 `Mia-Dev` 数据目录的 `managed-resources`，不会污染已安装版的用户数据。首次启动可能需要等待一次 npm 下载；之后直接复用已准备的资源。

### 本地 Agent 前提

Mia 会先扫描系统中的 Claude Code / Codex。系统版本可用时直接复用；Claude/Codex 的 ACP bridge 已随桌面包携带，并由 Core 在启动时自动校验/准备。若本机主 CLI 缺失，本机引擎区仍会提供“启用 Mia 稳定版”，从 `https://mia.gifgif.cn/downloads/engine-backups/v1/manifest.json` 按需下载所选引擎，校验固定版本和 SHA-256 后放进 Mia 私有目录；不会执行全局 npm 安装，也不修改 PATH：

```bash
claude --version
codex --version
openclaw --version
```

Hermes 也遵循同一规则：优先复用用户按官方方式安装的 PATH 版本；缺失时可按需下载固定的 Hermes + Python runtime。

当前桌面稳定资源固定为：Hermes `2026.7.7.2` / PyPI `0.18.2`（Python `3.11.13`）、Claude Code CLI `2.1.211` + ACP `0.59.0`、Codex CLI `0.144.5` + ACP `1.1.4`。Claude/Codex ACP 资源在打包前进入对应 Rust Core bundle；升级时需同步更新 Core pin、打包资源校验和 `npm run engine-backups:build -- <platform>-<arch>` 的独立备份清单。

Mia 复用用户本机 Agent 时，优先保证稳定可用并遵循上游成熟配置路径。Codex 使用用户原生 `~/.codex`，Hermes 使用用户原生 `~/.hermes`，Claude Code / OpenClaw 使用各自原生默认用户环境。每个伙伴的模型、推理强度由 Mia 按本次运行显式传入；权限按引擎级保存，同一引擎下所有伙伴共享。用户在 Mia 中修改权限时，Mia 只对需要用户级配置的引擎做一次 apply，例如 Codex 会更新 `~/.codex/config.toml`，Hermes 会合并更新 `~/.hermes/config.yaml`；不会在每次发消息前做配置 sync。

### 打包桌面端

macOS 包：

```bash
npm run dist:mac
```

macOS Intel 包：

```bash
npm run dist:mac:intel
```

macOS 公证需要先把 notarytool 凭据保存到登录钥匙串，profile 默认名为 `mia`：

```bash
xcrun notarytool store-credentials mia --apple-id <apple-id> --team-id S4NWU843M5
npm run notarize:mac
npm run notarize:mac:intel
```

Windows 包：

```bash
npm run dist:win
```

如果 Electron app 正在运行，打包、覆盖、签名或删除可能失败。先关闭正在运行的 Mia，再重新构建。

### Cloud 发布

生成 Cloud release：

```bash
npm run cloud:release
```

本地验证 release 包：

```bash
npm run cloud:install:verify
npm run cloud:release:handoff:bundle:verify
```

部署前检查：

```bash
npm run cloud:doctor -- https://mia.gifgif.cn
npm run cloud:deploy:dry-run
```

真实部署：

```bash
npm run cloud:deploy
```

SSH、systemd、nginx、LiteLLM、云端 Claude Code 运行时和回滚细节见 [docs/cloud-deployment.md](docs/cloud-deployment.md)。

完整部署流程，包括桌面端打包、Cloud/Web 发布、生产验证、回滚和排障，见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 项目结构

```text
src/
  main.js                 Electron 主进程装配入口
  main/                   主进程领域模块：Agent adapter、IPC、Cloud、daemon、remote、skills
  renderer/               桌面端渲染层：聊天、Bot、设置、技能、任务、社交 UI
  cloud/                  Cloud 数据层和共享服务
  web/                    Web 客户端
  shared/                 main / preload / renderer / web 共用 contract 和纯函数
packages/shared/          可跨应用复用的共享包
apps/mobile-rn/           React Native 移动端工程
scripts/                  本地开发、打包、Cloud 发布、诊断脚本
skills/                   内置和本地 skill
resources/                官方库、conductor prompt、pet generator 资源
docs/                     部署文档、ADR 和设计规格
```

关键文件：

- [CLAUDE.md](CLAUDE.md)：给 Claude/Codex 这类 coding agent 的项目规则。
- [src/check.js](src/check.js)：项目结构和关键约束自检。
- [package.json](package.json)：开发、打包、发布脚本。
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)：部署总入口，覆盖桌面端、Cloud/Web、验证、回滚和排障。
- [docs/cloud-deployment.md](docs/cloud-deployment.md)：生产 Cloud/Web 服务器细节。

## 架构边界

### Desktop

Electron 主进程负责窗口、IPC、runtime、Agent 编排、本地文件和本地 CLI。Renderer 只负责 UI，不直接使用 Node/Electron 能力。需要系统能力时走 preload 暴露的窄接口。

### Agent adapter

每个引擎都有自己的 adapter：

- `src/main/hermes-chat-adapter.js`
- `src/main/claude-code-chat-adapter.js`
- `src/main/codex-chat-adapter.js`

adapter 在 `chat-engine-registry` 中统一注册。新增引擎应沿用这个形状，不要把 provider 特例硬塞进 `main.js`。

### Cloud source of truth

Cloud 负责账号、社交关系、Cloud conversation、文件、Bot identity、Bot runtime binding、运行记录和事件同步。桌面端可以有本地缓存和本机执行能力，但不能把本地缓存当作跨设备真源；`desktop-local` 只表示运行目标，不表示本地 Bot 身份。

### Runtime packaging

Claude Code / Codex 使用“系统 CLI 优先、随包 ACP bridge、Mia 固定私有主 CLI 兜底”。OpenClaw 按最新 AionUi 的方向作为 ACP backend（`agent_type: acp`, `backend: openclaw`）对待；Mia 通过用户安装的 OpenClaw CLI 启动 `openclaw acp`，并用稳定 sessionKey 续接 OpenClaw Gateway 会话。OpenClaw Gateway 需要已配置且可连接；Mia 只探测和调用，不分发。

Hermes 也是上游 runtime：Mia 先从 PATH 探测复用（`src/main/system-hermes-service.js`）；用户点击后才从 Mia 备份源下载并启用固定 runtime。两种来源都继续使用用户原生 `~/.hermes`。云端托管 runtime 现在只保留 `cloud-claude-code`。

## 测试与质量门

提交前至少跑：

```bash
npm run check
```

改到具体模块时跑对应测试，例如：

```bash
node --test tests/claude-code-chat-adapter.test.js
node --test tests/local-bot-responder.test.js
node --test tests/serve-cloud-bridge.test.js
```

全量测试：

```bash
npm test
```

注意：Cloud productization / release audit 类测试可能会因为 release handoff、生产部署或公网版本滞后而失败。遇到这类失败不要直接改断言，先跑对应 doctor / handoff / blocker 脚本确认真实发布状态。

## 开发规则

- 不要继续扩大 `src/main.js`、`src/renderer/app.js`、`src/renderer/styles.css` 这类入口大文件。
- 新能力优先按领域放到 `src/main/<feature>/`、`src/renderer/<feature>/`、`src/renderer/styles/<feature>.css`。
- IPC channel、engine id、permission kind、task status、cloud event type 等字符串要集中管理。
- 持久化字段必须兼容旧数据；重命名、删除或结构调整要有迁移策略。
- 不要把 secret 写进仓库、日志或 URL。
- 日志要服务诊断，避免高频轮询和 streaming token 路径刷屏。
- commit 标题写中文摘要，允许保留 `fix(scope):` / `feat(scope):` 前缀。

更多规则见 [CLAUDE.md](CLAUDE.md)。

## 常见问题

### Mia 和普通聊天机器人客户端有什么不同？

Mia 不是单模型聊天壳。它把 Bot、Agent runtime、权限、社交同步和多端入口统一起来。目标是让 AI 像同事一样被叫出来做事，而不是每次从一个空白模型对话开始。

### 我的本地文件会自动上传到 Cloud 吗？

不会因为聊天同步就自动上传本地文件。本地 Agent 读文件、跑命令、写代码都发生在桌面端。附件和生成文件进入 Cloud 文件体系时，会走明确的上传和权限边界。

### 为什么还要优先使用本机 Claude Code / Codex？

这样可以保留用户自己的版本和更新节奏。ACP bridge 固定随 Mia 分发，但主 CLI 仍优先使用用户自己的版本；系统版本缺失时，用户可以按需下载 Mia 提供的固定稳定版。它只作为私有兜底，不覆盖全局 CLI，登录态和原生用户目录仍然复用。

### 开发时 release 目录很乱怎么办？

先看 `npm run clean:release` 和 `npm run tidy:release`。不要手动删除正在被打包进程或运行中的 app 使用的文件。

## 许可证

当前仓库未在 README 中声明开源许可证。对外分发、引用或复用前，请先确认仓库所有者的授权边界。
