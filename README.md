# Mia

Mia 是一个桌面优先的多 Agent 聊天平台。

它把 Hermes、Claude Code、Codex 这类本地 Agent，以及云端 Bot，放进同一套聊天、联系人、群聊、权限、同步和发布体系里。用户不需要记每个 CLI 的命令，也不需要在一堆工具窗口之间来回切换。打开 Mia，像找同事一样找一个 AI Bot，说清楚要做什么，然后让它在受控权限下执行。

一句话：**聊天是入口，Bot 是 AI 同事，桌面端是执行现场，Cloud/Web/移动端是同步和远程入口。**

## 当前状态

- 桌面端是主产品形态，基于 Electron。
- macOS Apple Silicon 是当前主要打包目标；Windows 打包脚本已存在但仍按实际验证结果发布。
- Web/Cloud 已有账号、好友、群聊、Bot、文件、实时同步和桌面 Bridge 能力。
- `apps/mobile-rn/` 下有 React Native 移动端工程，但当前 README 以桌面端和 Cloud/Web 为主。
- 版本号见 `package.json`，当前为 `0.1.1`。

公开入口：

- macOS Apple Silicon DMG：<https://mia.gifgif.cn/downloads/mia-macos-arm64-latest.dmg>
- Web：<https://mia.gifgif.cn>

线上是否已经部署到最新提交，以 `npm run cloud:doctor -- https://mia.gifgif.cn` 和 `npm run cloud:prod:verify -- https://mia.gifgif.cn` 的结果为准。

## Mia 解决什么问题

传统 AI 客户端通常是“一个模型，一个窗口，一段上下文”。Mia 的目标不同：

- **把 AI 当联系人管理**：Bot 有名字、头像、人设、技能、运行时和权限配置。
- **把任务放回聊天上下文**：私聊、群聊、@ 提及、回复、附件、历史消息都是一等对象。
- **把本地执行纳入权限系统**：读文件、跑命令、写代码、使用工具都要经过明确的 Agent 权限模式。
- **把多端当作同一个产品**：桌面端负责本地执行，Cloud/Web 负责账号、同步、远程触发和云端 Bot。
- **把多引擎接进同一个界面**：Hermes、Claude Code、Codex 走各自 adapter，但用户看到的是统一聊天体验。

## 主要能力

### 聊天与社交

- 账号注册、登录、会话同步。
- 好友请求、好友列表、DM、群聊。
- Bot 私聊和群聊 @ 提及。
- 消息增量同步、删除/隐藏、附件、流式回复。
- 桌面端有本地消息缓存，Cloud 仍是同步源。

### Bot 与 Agent

- Bot 身份：名字、头像、简介、人设、颜色、置顶、技能能力。
- Agent 引擎：Hermes、Claude Code、Codex。
- Claude Code / Codex 使用用户本机已安装的 CLI，不随 Mia 打包。
- Hermes 是上游开源 runtime，和 claude/codex 一样复用用户自己装的（从 PATH 探测），不随安装包打包；也可跑在云端 Docker。
- Bot 可以挂载技能，技能来源包括内置 skill、官方库和本地 skill 目录。
- Cloud Bot 可在云端 Docker worker 中运行，使用平台配置的 LiteLLM 模型网关。

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
- Cloud Hermes worker 使用 Docker 隔离，每个用户独立 root、home、workspace 和 Hermes home。
- 部署总说明在 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，Cloud 服务器细节在 [docs/cloud-deployment.md](docs/cloud-deployment.md)。

### 打包与发布

- 默认桌面包是轻量包，不把 Claude Code / Codex CLI 打进去。
- `dist:mac` / `dist:win` 不打包 Hermes runtime。
- release 输出目录是 `release/`，构建前后会通过 `scripts/clean-release.js` 做清理和归档整理。
- 桌面自动更新：`npm run release:mac` 把 feed + 产物发到 GitHub release（发版要先 bump `package.json` 版本）。**注意：GitHub 在大陆不稳定，国内用户无法可靠收到更新**——正式面向国内前需把更新源换成国内可达的自有服务器，细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 的"桌面自动更新"。
- Cloud release 输出在 `dist/`，由 `scripts/build-cloud-release.js`、handoff、doctor、smoke、deploy 脚本串起来。

## 快速开始

### 开发环境

建议使用较新的 Node.js。Cloud 生产和相关 doctor 明确要求 Node.js 25+，因为当前 Cloud SQLite 路径依赖 `node:sqlite`。

```bash
npm install
npm start
```

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

### 本地 Agent 前提

Mia 不会替用户安装或分发 Claude Code / Codex CLI。要使用对应 Bot，需要本机已能找到命令：

```bash
claude --version
codex --version
```

Hermes 是 Mia 支持的上游开源 Agent runtime，用户按官方方式自行安装，Mia 从 PATH 探测复用（不干预安装路径），或跑在云端 Docker，不随安装包打包。

### 打包桌面端

macOS 包：

```bash
npm run dist:mac
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

SSH、systemd、nginx、LiteLLM、Docker worker 和回滚细节见 [docs/cloud-deployment.md](docs/cloud-deployment.md)。

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

Cloud 负责账号、社交关系、Cloud conversation、文件、Bot identity、运行记录和事件同步。桌面端可以有本地缓存，但不能把本地缓存当作跨设备真源。

### Runtime packaging

Claude Code / Codex 是用户机器上的外部 CLI。Mia 只探测和调用，不分发。

Hermes 也是上游 runtime：用户按官方方式自行安装，Mia 从 PATH 探测复用（`src/main/system-hermes-service.js`），不打包、不指定安装路径；或在云端 Docker 跑（`cloud/hermes-image/`）。

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

### 为什么不把 Claude Code / Codex 一起打包？

这两个工具是用户本机已有的外部 CLI，版本和登录态都属于用户环境。Mia 复用它们，不锁版本，也不把它们变成 Mia 的分发依赖。

### 开发时 release 目录很乱怎么办？

先看 `npm run clean:release` 和 `npm run tidy:release`。不要手动删除正在被打包进程或运行中的 app 使用的文件。

## 许可证

当前仓库未在 README 中声明开源许可证。对外分发、引用或复用前，请先确认仓库所有者的授权边界。
