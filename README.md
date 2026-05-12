# Aimashi

Aimashi 是一个基于 Electron 的桌面应用，内置独立的 Hermes 运行时（"app-owned Hermes runtime"）。

为避免污染用户系统中已有的 Hermes 安装，Aimashi **不会**读取、修改或复用任何外部 Hermes 目录。首次启动时，它会在应用数据目录下创建自己的运行时空间：

```text
~/Library/Application Support/Aimashi/runtime/
  hermes-engine/
    README.md
    .venv/
      ...
  engine-home/
    config.yaml
    SOUL.md
    api-server.key
    fellows/
      manifest.json
      aimashi.fellow.json
      aimashi.md
    souls/
      aimashi.md
```

- `fellows/`：面向产品的目录结构。每个 Fellow（伙伴）由一份 `<id>.fellow.json` 元数据 + 一份 `<id>.md` 人格 seed 组成。
- `souls/`：为兼容旧版 Hermes/Aimashi 布局保留的镜像目录。

## 运行

macOS 上可直接在 Finder 中双击：

```text
open-aimashi.command
```

或者在终端中：

```bash
npm install
npm start
```

## 功能概览

- 从零开始创建一个隔离的 Aimashi 运行时目录。
- 自动生成默认的 Fellow manifest、元数据与人格 seed。
- 将官方 NousResearch Hermes 源码包安装进 Aimashi 自己的私有运行时。
- 在本地回环端口上启停私有 Hermes API 服务。
- 通过 Hermes `POST /v1/runs` + `GET /v1/runs/{run_id}/events` SSE 通道进行对话，请求中携带 `fellow_key`、`account_id`、`route_profile` 与 `X-Aimashi-Fellow`。
- 桌面 UI 提供：模型预设、API Key 存储、OpenAI Codex OAuth、聊天、Fellow 增删改。
- 模型凭据仅保存在 Aimashi 私有运行时内，不读取用户已有的 Hermes 配置。

### 近期新增

- **Fellow 右键菜单**：在 Fellow 列表上右键可触发编辑、生成宠物等操作。
- **桌面宠物 Overlay**：独立的 `pet.html` / `pet.css` / `pet.js` 渲染器窗口；主进程通过 IPC 管理生成、位置和状态。
- **头像系统**：图片按 `avatar-thumbs/`（缩略图）与 `avatars/`（原图）双套组织；支持基于 hash 的默认头像选择，以及裁剪编辑器（normalizeCrop / 缩放范围）。
- **权限切换器**：每个权限选项带中文 Tooltip；YOLO 模式标签使用亮紫色高亮。
- **Composer 优化**：输入为空时禁用发送按钮；按钮背景透明化，焦点环已抑制。

## 安装来源

默认情况下，Aimashi 从 NousResearch 官方仓库的归档包安装 Hermes，不依赖本地 `hermes-team-dev` 检出目录：

```bash
python3.11 -m venv ~/Library/Application\ Support/Aimashi/runtime/hermes-engine/.venv
~/Library/Application\ Support/Aimashi/runtime/hermes-engine/.venv/bin/python -m pip install --upgrade \
  "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz"
```

Aimashi 需要 Python 3.11 或更高版本。它会依次尝试 `python3.13`、`python3.12`、`python3.11`、`python3`。可通过环境变量覆盖：

```bash
AIMASHI_PYTHON=/path/to/python3.11 npm start
```

指定 Hermes 分支、tag 或 commit：

```bash
AIMASHI_ENGINE_REF=<tag-or-commit-sha> npm start
```

默认安装 `web` extra（桌面应用需要本地 Hermes API 服务）。可在需要更完整 Hermes 包时覆盖：

```bash
AIMASHI_ENGINE_EXTRAS=all npm start
```

仅在本地 Hermes 开发时，可用源码 checkout 覆盖官方包安装：

```bash
AIMASHI_ENGINE_SOURCE=/path/to/hermes-agent npm start
```

## 使用流程

1. 运行 `npm start` 启动应用。
2. 等待 Runtime 状态显示本地 Hermes API 已就绪。
3. 在 Model 中选择一个预设：xAI、Anthropic、OpenRouter、OpenAI Codex OAuth、DeepSeek、Gemini 或 LM Studio。
4. 对 API Key 类型的服务，粘贴 Key 并保存；对 OpenAI Codex，使用面板中的 OAuth 登录按钮，通过浏览器以 ChatGPT/Codex 订阅账号登录。
5. 与当前 Fellow 聊天，或在右侧编辑器中新建 Fellow。

## 工作原理

Aimashi 通过 `python -m aimashi_plugins gateway run` 启动 Hermes。插件层会根据请求头 `X-Aimashi-Fellow` 读取 `engine-home/fellows/<id>.md`，并将其注入原版 Hermes，**不修改 Hermes core**。

聊天会话在内部使用 Hermes 的 run ID 与结构化 SSE 事件；为兼容现有渲染器，仍以 `choices[0].message.content` 的形式回传。

OpenAI Codex OAuth 走 Hermes 的 `openai-codex` provider，token 保存在 Aimashi 私有目录的 `engine-home/auth.json` 中，**不写入**用户已有的 Hermes home。

## 项目结构

```text
src/
  main.js          # Electron 主进程（运行时管理、Hermes 进程、IPC、宠物窗口）
  preload.js       # 安全桥接
  check.js         # npm run check
  renderer/
    index.html     # 主界面
    app.js         # 渲染层逻辑
    styles.css
    pet.html       # 宠物 overlay 窗口
    pet.js
    pet.css
    assets/
      avatar-thumbs/  # 头像缩略图（16 张）
      avatars/        # 头像原图（16 张）
```

## 打包注意事项

正式发布产物应锁定官方 Hermes 包版本，或自带签名后的官方构建产物，而不是依赖开发机上的源码路径。
