# Mia

Mia 是一个面向 Agent 时代的聊天和协作客户端：用户在同一个界面里管理多个 AI Fellow，选择本地 Agent 引擎，和真人好友私聊或拉群，并让自己的 Fellow 在群聊里参与协作。

简单说：**对话是入口，Agent 是肉，GUI 是壳**。

## 当前形态

Mia 现在不是单纯的桌面 demo，而是由几条链路组成：

- **桌面端**：Electron 应用，负责本地聊天 UI、Fellow 管理、本地 Agent 调用、群聊协调、桌宠窗口和本地 bridge。
- **本地引擎**：Hermes runtime 随桌面包构建；Claude Code / Codex 复用用户本机已安装并登录的 CLI。
- **Cloud API**：提供账号、好友、DM、群房间、消息同步、WebSocket 事件和桌面 bridge 入口。
- **Web 端**：浏览器页面可注册、登录、加好友、收发 DM、进入群聊并 @ 在线桌面端拥有的 Fellow。
- **移动端页面**：保留在 `src/mobile/`，不是当前主开发路径。

## 核心功能

### Fellow 与本地 Agent

- 每个 Fellow 有独立名字、头像、人设、颜色、置顶状态和引擎选择。
- 支持的本地引擎：
  - `hermes`
  - `claude-code`
  - `codex`
- Hermes 模式通过 `X-Mia-Fellow` 等上下文注入 Fellow 人设。
- Claude Code / Codex 模式通过本地 SDK 调用，在新会话或 stateless 调用前注入 Fellow 人设。
- 外部 CLI 不随安装包分发；Mia 只从用户系统 `PATH` 探测和复用它们。

### 私聊、好友和群聊

- 用户通过 username 加好友，不再使用邀请码路径。
- 好友接受后由 cloud 创建 DM 房间，消息用 cloud 权威 `seq` 同步。
- 桌面端侧边栏混排 Fellow、真人 DM、群房间。
- 桌面端可以创建群聊，把真人好友和自己的 Fellow 加进同一个房间。
- 群聊支持两种 AI 回复模式：
  - **协调者模式**：没有明确 @ 时，也让本地 conductor 判断哪些 Fellow 应该回应。
  - **仅 @ 模式**：只有显式 @ 到 Fellow 时才触发回应。
- 跨用户群聊里，别人 @ 你的 Fellow 时，cloud 会把调用事件推给你的在线桌面端，由你的本地引擎执行后再回写群消息。

### Web / Cloud

- Web 端位于 `src/web/`，生产入口目前是 `https://aiweb.buytb01.com`。
- Cloud API 位于 `src/cloud/`，使用 SQLite 存账号、好友、房间、成员和消息。
- 桌面 bridge 通过 WebSocket 登录同一个 cloud 账号，供 cloud 路由远程 Agent 调用。
- WebSocket token 走 `Sec-WebSocket-Protocol`，避免把 bearer token 放进 URL。

### 桌宠

- 每个 Fellow 可以生成和播放桌宠。
- 播放窗口由 Electron 透明窗口实现，读取 `pet.json` 和 spritesheet。
- 生成器资源在 `resources/pet-generator/`。
- 生成结果默认写入 Mia 的应用数据目录，也兼容读取旧的 Alkaka/Codex pet 目录。

## 本地运行

```bash
npm install
npm start
```

常用命令：

```bash
npm test              # 全量 Node 测试
npm run check         # 基础结构和语法检查
npm run open          # 打开 Electron 桌面端
npm run web           # 本地 Web 预览
npm run cloud         # 本地 Cloud API
npm run bridge        # 本地 agent bridge
npm run relay         # relay server
```

Cloud 相关测试和部署脚本依赖较新的 Node.js，生产侧要求 Node.js 25+，因为当前 cloud store 使用 `node:sqlite`。

## 运行时和数据目录

桌面端的用户数据在 macOS 下默认位于：

```text
~/Library/Application Support/Mia/
```

关键子目录：

```text
runtime/
  engine-home/
    config.yaml
    auth.json
    mia-model.json
    mia-providers.json
    mia-permissions.json
    mia-sessions.json
    mia-agent-sessions.json
    fellows/
    pets/
    pet-jobs/
    attachments/
    logs/
```

Hermes runtime 本体不是在首次启动时现场下载，而是在打包前构建到：

```text
vendor/hermes-runtime/<target>/
```

打包时会把对应平台的 runtime 放进安装包资源。改动 Hermes runtime 构建逻辑前先看 `scripts/build-hermes-runtime.sh`。

## 打包和发布

桌面端当前优先支持 macOS unsigned 包：

```bash
npm run dist:mac
```

这会先构建 `vendor/hermes-runtime/mac-arm64`，再走 Electron Builder，并生成 macOS app/DMG 相关产物。当前还没有接入正式签名、公证和自动更新。

Cloud 发布脚本在 `scripts/`，常用入口：

```bash
npm run cloud:release
npm run cloud:deploy:dry-run
npm run cloud:deploy
npm run cloud:prod:verify -- https://aiweb.buytb01.com
```

更完整的生产部署说明见 `docs/cloud-deployment.md`。

## 项目结构

```text
src/
  main.js                     Electron 主进程装配入口
  main/                       主进程 feature 模块、IPC、引擎适配、群成员模型、任务调度
  renderer/                   桌面端渲染层
    app.js                    渲染层装配入口
    group/                    本地群聊 UI 和 AI 回复模式
    social/                   cloud 好友、DM、群房间 UI
    styles/                   按界面职责拆分的 CSS
  cloud/                      Cloud API、SQLite store、消息和社交模型
  relay/                      relay server
  mobile/                     移动端页面
  web/                        浏览器端页面
  shared/                     main / preload / renderer / tests 共用 contract
resources/
  pet-generator/              桌宠生成器资源
skills/                       Mia 附带 skills
scripts/                      runtime 构建、cloud 发布、诊断和 smoke 脚本
tests/                        Node test 测试
vendor/
  hermes-runtime/             随包 Hermes runtime
```

## 重要边界

- Hermes 是 Mia 随包的开源 runtime 副本；Claude Code / Codex 是用户机器上的外部 CLI，不能打进安装包。
- renderer 不直接使用 Node/Electron 能力，需要系统能力时走 preload 暴露的窄接口。
- main、renderer、cloud、web、mobile 的状态边界要清楚；同一类会话状态只应有一个权威 owner。
- 新功能优先放进按领域命名的模块，不要继续扩大 `src/main.js`、`src/renderer/app.js`、`src/renderer/styles.css` 这类历史大文件。

## 已知限制

- Cloud 侧还没有真正的 server-side Fellow registry；群成员里的 Fellow 仍主要由 owner 桌面端声明。
- Web 端不能自己运行本地 Fellow；跨用户 Fellow 回复要求 owner 的桌面端在线。
- DM/群消息的未读、分页、typing、已读回执等体验还不完整。
- 云端群聊目前主要靠显式 @ 触发远端 Fellow；本地群聊已有 conductor 模式，完整 cloud conductor 化仍是后续工作。
- 桌宠生成仍依赖用户本机可用的 Codex image generation 能力和相关运行环境。
- macOS 签名、公证、自动更新还未接入。
