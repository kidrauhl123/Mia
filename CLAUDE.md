# aimashi — Claude 阅读须知

## 这个项目是什么

**Agent 时代的聊天平台 / 多 Agent 协作管理平台**。

用 GUI 给用户一个统一、好用的入口，去聊、去管、去协调一堆 AI Agent：openclaw、Hermes、Codex、Claude Code…… 用户不用记每个 CLI 怎么用、各自跑在哪、状态怎样——aimashi 把它们都接进同一个聊天界面，让它们能像同事一样被叫出来、被指挥、被组合。

简单说：**对话是入口，Agent 是肉，GUI 是壳**。

## 技术实现

桌面端是 Electron 应用。运行时分三层：

- **主进程**（Electron，`src/main.js`）—— UI + IPC + Agent 编排
- **Hermes 运行时**（密封 Python，位于 `vendor/hermes-runtime/<target>/`，由 `scripts/build-hermes-runtime.sh` 在 `prepack` 阶段构建）—— **打包进安装包**，自带不依赖用户环境
- **Claude Code / Codex 等外部 CLI** —— **不打包**，通过 `shellCommandPath()`（`src/main.js`）从用户系统 `PATH` 里查找

为什么 Hermes 自带、其它 CLI 不自带：Hermes 是 aimashi 的"嫡系"运行时（用户不装也能开箱用）；Claude Code / Codex 是用户已经在自己电脑上用的工具，aimashi 复用它们，不重复安装也不锁版本。

### 硬规则

- **永远不要把 claude / codex 二进制加进 `extraResources` 或当成可分发依赖打包**——复用用户已装好的 CLI 是产品定位的核心，曾把 DMG 从 379MB 砍到 207MB 就是靠这条。如果改动让你想"顺手"打包它们,先确认是不是误解了产品意图。
- 动 Python 侧之前先读 `scripts/build-hermes-runtime.sh`:包含 strip + ad-hoc 重签名(macOS arm64 不重签会让 dlopen 在严格签名场景下挂掉)、stdlib 裁剪、缓存命中策略。
- 合并或拉完代码记得 `npm run dist:mac`(或对应平台脚本)重建,否则你跑的还是旧二进制。

## 参考项目

设计聊天 UX、流式输出、tool-use 渲染、多引擎适配时，**先去读这些项目**。每个都从不同角度切入，按当前任务挑读，不要照抄。

### 开源代码参考

**AionUi**（iOfficeAI/AionUi，Apache-2.0）—— Electron 多引擎 AI 客户端，**和 aimashi 同一品类**，强相关。
本地路径：`Alkaka-reference/AionUi`
值得读的角度：
- `src/process/agent/AgentRegistry.ts` —— 多引擎统一注册表（ACP CLIs、Gemini、OpenClaw、Nanobot、Remote、Custom ACP），覆盖 aimashi 未来要做的方向
- `src/process/agent/acp/AcpDetector.ts` —— PATH 探测 CLI 可用性，和 `shellCommandPath()` 同套思路，参考它的探测时机 / 缓存策略 / 失败回退
- `src/process/channels/` —— Telegram / Lark / 钉钉 / 微信 / 企微 接入实现
- `src/process/webserver/` —— 手机远程访问 WebUI（WebSocket + 配对协议）
- `src/process/pet/` —— 桌宠状态机 / 事件桥（仅参考思路；aimashi 的桌宠按 ADR-0002 放在独立 repo）
- `src/process/task/` —— Cron 调度
- 三进程隔离约定（main / renderer / worker，禁止跨进程 API 混用）见根目录 `AGENTS.md`

**LobsterAI**（网易有道，MIT）—— Electron + React 个人助理 Agent 客户端，主打 24/7 自动化任务，**和 aimashi 的"复用外部 CLI + 自带 Python 运行时"路线高度重合**。
本地路径：`Alkaka-reference/lobsterai`
值得读的角度：
- `src/main/libs/openclawEngineManager.ts` —— Engine 状态机 / 自动重启 / runtime 探测的首选样板（Hermes runtime 管理可直接对照）
- `src/main/libs/pythonRuntime.ts` —— 密封 Python 运行时怎么寻路、起进程、健康检查，aimashi 的 `vendor/hermes-runtime` 落地时最该参考
- `src/scheduledTask/` —— Cron 调度（`cronJobService.ts`、模型映射、迁移），需要做定时 Agent 时直接看这里
- `src/main/libs/mcpServerManager.ts` + `mcpBridgeServer.ts` —— MCP server 生命周期管理
- `src/main/libs/coworkOpenAICompatProxy.ts` —— 给 Agent 暴露 OpenAI 兼容接口的代理写法
- `src/common/coworkErrorClassify.ts` —— Agent 错误分类，统一错误展示参考

**Cherry Studio** —— Electron + React 多供应商聊天客户端。
本地路径：`Alkaka-reference/cherry-studio`
值得读的角度：跨多 provider 的流式架构（Vercel AI SDK `fullStream` 适配器）、统一 chunk schema、thinking / reasoning UI、MCP tool 渲染、Electron IPC 上的 abort 流程。

**ClaudeCodeUI**（siteboon/claudecodeui）—— React + Node.js Web UI，包了 Claude Code / Cursor CLI / Codex / Gemini CLI。
本地路径：`Alkaka-reference/claudecodeui`
值得读的角度：one-file-per-CLI 的 provider 布局、`normalizeMessage` 适配器模式、带轮转动词的 agent 状态栏、tool renderer 路由。

**Telegram 开源端** —— 聊天 UX 参考。
未本地克隆。主要候选：tdesktop（https://github.com/telegramdesktop/tdesktop ，C++/Qt）、telegram-web（https://github.com/Ajaxy/telegram-tt ，TS/React）。
值得读的角度：typing / recording / 状态指示动画、消息列表虚拟化、reply / quote / forward 交互、动态贴纸、打磨过的聊天细节。

### UX 参考（闭源，只观察行为）

**WorkBuddy**（腾讯云 CodeBuddy 团队，2026.3 上线）—— **OpenClaw 兼容**的桌面 AI Agent，**和 aimashi 同一赛道的直接竞品**。
官网 / 入口：腾讯云 WorkBuddy（macOS / Windows 都有）
值得观察：
- "自然语言 → 多步桌面任务"的指令到执行的 UX 链路（aimashi 正面对标这块）
- **微信扫码一键配对，手机远程控制 PC 端 Agent** 的交互流程（可对比 AionUi 的 webserver 方案）
- 20+ skill 模板（编码 / 文档 / 调研 / 数据分析 / 自动化）的入口和呈现
- 多模型切换（混元 / DeepSeek / GLM / Kimi / MiniMax）的选择 UX
- "no projects setup required"开箱即用的初始化路径
（参考报道：[TechNode](https://technode.com/2026/03/09/tencent-launches-openclaw-like-workplace-ai-agent-workbuddy/)、[AIBase](https://www.aibase.com/news/26048)）

**微信** —— alkaka-qt 的微信风格 UI 已经做了部分建模。
值得观察：会话列表密度、窄窗返回导航、avatar + 名字 + 预览行、中国市场聊天界面惯例。

**Codex 桌面端** —— OpenAI Codex.app（Electron，曾拆过 `app.asar` 看内部）。
值得观察：agent 风格聊天（长任务、tool 密集）、todo / plan 渲染、avatar overlay 系统、多步任务进行中的状态反馈。

**Claude 桌面端** —— Anthropic Claude.app。
值得观察：流式 token 渲染、tool-use 卡片（inline，可折叠）、project / files 面板、代码块 UX。

### 怎么用这份清单

把它当作出发点，不是规范。当前任务在哪个维度，就去对应项目里挖灵感：

- **多引擎检测 / 远程接入 / IM 接入 / 桌宠协议** → AionUi（最直接对位）
- **Engine 状态机 / Python 运行时管理 / Cron 调度 / MCP 生命周期** → LobsterAI（路线最重合）
- **流式 + tool 管道** → Cherry Studio、ClaudeCodeUI
- **UI 打磨与微交互** → Telegram、微信、Claude、Codex 桌面端
- **同赛道竞品体验（自然语言任务、扫码远控、skill 模板）** → WorkBuddy

发现值得跨 session 记住的点，就在这里加一行指针（文件路径 + 一句"用来干嘛"）。
