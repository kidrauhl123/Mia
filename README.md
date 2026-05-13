# Aimashi

Aimashi 是专为 Agent 打造的聊天软件、一个可以管理多个 Agent 伙伴、运行本地/远程 Agent 引擎、并和桌面宠物及移动端联动的客户端。


##### （一）兼容的 Agent 引擎

###### 1. 运行在 PC 本地

1. 私有 Hermes runtime
	- Aimashi **不会**读取、修改或复用用户系统里已有的 Hermes 安装。
	- 首次启动时会在应用数据目录下创建自己的运行时空间。
	- 当前开发版会把官方 Hermes 安装进 `runtime/hermes-engine/.venv`。
	- 这还不是 LobsterAI 那种“安装包内置完整 runtime”的形态；正式发布前需要把 Hermes runtime 做成随包资源，避免用户机器缺 Python、pip 或网络时卡住。

2. 本地 Claude Code
	- 如果用户本机能执行 `claude --version`，Aimashi 会把 Claude Code 作为可选 Agent 引擎。
	- 会复用 Claude Code CLI 和 `@anthropic-ai/claude-agent-sdk`。
	- Aimashi 会把 Fellow 人设追加到 Claude Code 的 system prompt。
	- Aimashi Skill 会通过本地 Claude bridge plugin 暴露给 Claude Code。

3. 本地 Codex
	- 如果用户本机能执行 `codex --version`，Aimashi 会把 Codex 作为可选 Agent 引擎。
	- 会复用 Codex CLI 和 `@openai/codex-sdk`。
	- 新会话会注入 Fellow 人设；后续通过 Codex thread 继续会话。

###### 2. 运行在云端

- Hermes
	- 产品上保留云端 Hermes 的方向。
	- 当前主路径仍是本地私有 Hermes API。

##### （二）私有运行时目录

```text
~/Library/Application Support/Aimashi/runtime/
  hermes-engine/
    README.md
    .venv/
      ...
    aimashi_plugins/
      __main__.py
      fellow_overlay.py
  engine-home/
    config.yaml
    SOUL.md
    api-server.key
    auth.json
    aimashi-model.json
    aimashi-providers.json
    aimashi-permissions.json
    aimashi-effort.json
    aimashi-sessions.json
    aimashi-agent-sessions.json
    aimashi-daemon.json
    aimashi-daemon.key
    aimashi-relay.json
    fellows/
      manifest.json
      aimashi.fellow.json
      aimashi.md
    pets/
    pet-jobs/
    attachments/
    logs/
```

- `hermes-engine/`：Hermes 引擎目录。开发版通过 Python venv 安装官方 Hermes。
- `engine-home/`：Aimashi 自己的 Hermes Home，模型配置、认证、会话、伙伴、人设、移动端配置都放这里。
- `fellows/`：面向产品的伙伴目录。每个 Fellow 由一份 `<id>.fellow.json` 元数据和一份 `<id>.md` 人设 seed 组成。
- `api-server.key`：Aimashi 调本地 Hermes API 的私有 token。

##### （三）多个 Agent 伙伴

- 每个 Fellow 可以有自己的名字、头像、人设、颜色、置顶状态。
- 每个 Fellow 可以选择 Agent 引擎：
	- `hermes`
	- `claude-code`
	- `codex`
- Hermes 模式下，Aimashi 会通过请求头 `X-Aimashi-Fellow` 告诉本地 Hermes 当前 Fellow。
- `aimashi_plugins/fellow_overlay.py` 会读取 `fellows/<id>.md`，并注入到 Hermes 的临时 system prompt。
- Claude Code / Codex 模式下，Aimashi 在本地 SDK 调用前注入 Fellow 人设。

##### （四）模型和认证

- Hermes 模式支持模型 preset 和 API key 保存。
- 默认模型配置写在 `aimashi-model.json`。
- 多 provider 连接写在 `aimashi-providers.json`。
- OpenAI Codex OAuth 走 Hermes 的 `openai-codex` provider，token 写入 Aimashi 私有 `engine-home/auth.json`，不写用户的 `~/.codex`。
- Claude Code 和 Codex 引擎依赖用户本机已有 CLI 登录状态。

##### （五）Skill 和插件

- Aimashi 会加载 Hermes / Aimashi / Claude / Codex 相关 Skill 来源。
- Hermes runtime 没启动时，Skill 面板会回退读取本地文件系统。
- Claude Code 会通过 Aimashi 生成的 bridge plugin 看到 Aimashi/Hermes Skill。
- Composer 里支持 `/skill-name` 这种前缀展开。

##### （六）桌宠功能

- 基于多伙伴设定，每个 Fellow 都可以生成一个桌宠。
- 桌宠播放窗口在 Aimashi 内部实现，使用透明 Electron 窗口播放 `pet.json` + `spritesheet.webp/png`。
- 桌宠生成器已经内置在：
	- `resources/pet-generator`
- 生成结果默认写入：
	- `runtime/engine-home/pets`
- 兼容读取：
	- `~/.alkaka/pets`
	- `~/.codex/pets`
- 生成仍依赖用户本机可用的 Codex CLI imagegen 能力。
- 生成脚本依赖 Python 和 Pillow；正式发布最好复用随包 Python runtime，避免新用户缺依赖。

##### （七）多端互通

- 桌面端是主入口。
- 移动端页面在 `src/mobile/`。
- 本地局域网访问由 Aimashi daemon 提供。
- 远程访问通过 relay：
	- 默认 relay 地址：`wss://agi.buytb01.com/relay`
	- 配置写在 `aimashi-relay.json`
- daemon 的 LaunchAgent label：
	- `ai.aimashi.daemon`
- Hermes gateway 的 LaunchAgent label：
	- `ai.aimashi.hermes.gateway`

##### （八）开发运行

```bash
npm install
npm start
```

检查基础文件和 JS 语法：

```bash
npm run check
```

如果需要指定 Hermes 安装来源：

```bash
AIMASHI_ENGINE_REF=<tag-or-commit-sha> npm start
AIMASHI_ENGINE_SOURCE=/path/to/hermes-agent npm start
AIMASHI_PYTHON=/path/to/python3.11 npm start
```

##### （九）当前发布缺口

1. Electron 打包配置已接入，当前先做 macOS unsigned dmg。
2. 还没有把 Hermes runtime 作为安装包资源内置。
3. 首次安装 Hermes 依赖用户机器有 Python 3.11+、pip 和可访问 GitHub 的网络。
4. 桌宠生成器已内置，但仍依赖 Codex CLI imagegen、Python 和 Pillow。
5. macOS 签名、公证、自动更新还没有接入。

发布前最重要的是先补 runtime 封装：构建阶段固定 Hermes 版本，生成 `vendor/hermes-runtime/current`，打包进 App；首次启动只初始化 `engine-home`，不要现场下载 Hermes。
