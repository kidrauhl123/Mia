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

为什么 Hermes 自带、其它 CLI 不自带：Hermes 是**上游开源 Agent runtime**（上游代码在 `~/github/Alkaka-reference/hermes-agent/`，**不是 aimashi 写的**），aimashi 走 **vendor pin、不 fork**，自带是为了让普通用户开箱即用、不装 Python；Claude Code / Codex 是用户已经在自己电脑上用的工具，aimashi 复用它们，不重复安装也不锁版本。

判断"Hermes 当前真实行为"以 `vendor/hermes-runtime/<target>/site-packages/` 里的 pinned 副本为准；查 upstream 当前设计 / API 演进看 `~/github/Alkaka-reference/hermes-agent/`。两者必然 drift，正常。

### 硬规则

- **永远不要把 claude / codex 二进制加进 `extraResources` 或当成可分发依赖打包**——复用用户已装好的 CLI 是产品定位的核心，曾把 DMG 从 379MB 砍到 207MB 就是靠这条。如果改动让你想"顺手"打包它们,先确认是不是误解了产品意图。
- 动 Python 侧之前先读 `scripts/build-hermes-runtime.sh`:包含 strip + ad-hoc 重签名(macOS arm64 不重签会让 dlopen 在严格签名场景下挂掉)、stdlib 裁剪、缓存命中策略。
- 合并或拉完代码记得 `npm run dist:mac`(或对应平台脚本)重建,否则你跑的还是旧二进制。

## 运行 / 验证 / 故障边界

常用入口按目标选，不要盲目跑最重命令：

- **快速测试**：`npm test`
- **项目自检**：`npm run check`
- **桌面端开发**：`npm start` / `npm run open`
- **Web 端本地预览**：`npm run web`
- **Cloud / relay 调试**：优先看 `package.json` 里的 `cloud:*`、`bridge`、`relay` 脚本，按当前链路只启动必要服务。
- **Hermes runtime**：改 `vendor/hermes-runtime`、`scripts/build-hermes-runtime.sh` 或 Python 打包逻辑后跑对应 `npm run hermes:runtime:*`；发布/打包前跑 `npm run dist:mac`。

遇到这些情况先停下来确认，不要用重试或"顺手修"掩盖问题：

- Electron app 正在运行导致打包、覆盖、签名、删除失败：先让用户关闭正在运行的 app / 相关进程。
- 端口被 `web` / `cloud` / `bridge` / `relay` 占用：先确认是不是已有 aimashi 服务，不要直接 kill 不明进程。
- Hermes 行为和源码不一致：先确认运行的是不是旧的打包 runtime；必要时重建 `vendor/hermes-runtime/<target>/` 或重新打包。
- macOS arm64 出现 Python 扩展 `dlopen`、签名、quarantine 类问题：先读 `scripts/build-hermes-runtime.sh`，不要绕开 strip / ad-hoc codesign 流程。
- 测试或脚本需要用户数据目录时，必须使用临时目录或显式测试 fixture；不要让自动化测试写真实 `~/Library/Application Support/Aimashi`。

## 代码组织

**核心原则：新功能 = 新文件 / 新目录，不要往已有大文件继续堆。**

`src/main.js`（~7800 行）和 `src/renderer/app.js`（~8000 行）已经过大——AI 并行改容易撞车、人审阅看不完、bug 难定位。继续往里加东西是反向工作。

### 硬规则

- **单文件目标 100–500 行**；超过 800 行就该切分。对比基准：Cherry Studio `src/main/index.ts` 319 行、AionUi `src/index.ts` 862 行，Lobster 主进程根本不存在单一大入口（拆成 `agentManager.ts` / `mcpStore.ts` / `coworkStore.ts` 等十几个小文件）。
- **新功能优先建新文件**，按特性命名（`src/renderer/<feature>.js`、`src/main/<feature>/` 或 `src/main/<feature>-xxx.js`）。**禁止**起 `utils.js` / `helpers.js` / `common.js` 这种语义无关的"桶"文件——它们最后必然变成下一个大杂烩。
- **不要为单次使用提前抽象**——最小可解决问题的代码，不写"将来可能用得上"的参数 / 配置项 / 抽象层（参考 Karpathy 守则 "Simplicity First"）。
- **改动外科手术化**：只动本次任务必要的行；不要"顺手"重命名、重排、改注释、改格式。每一行改动都要能直接追溯到用户的请求。
- 删自己改动产生的孤立 import / 变量；**不要**删既有死代码（除非被明确要求）——它可能是别人 in-progress 的工作。

### 已经在跑的拆分样板（照抄即可）

- `src/renderer/group.js`（974 行）—— IIFE + `window.aimashiGroup.initGroupModule({...deps})` 接回 `app.js`；`index.html` 末尾 `<script src="./group.js"></script>` 引入。**这是当前 renderer 端推荐的样板。**
- `src/main/codex-chat-adapter.js` / `claude-code-chat-adapter.js` / `hermes-chat-adapter.js` —— 三个引擎适配器各一文件，统一在 `chatEngineRegistry` 注册。
- `src/main/scheduler*.js` + `tasks-*.js` —— 任务调度子系统，按职责分多文件。
- `src/cloud/` / `src/relay/` / `src/mobile/` / `src/web/` —— 跨设备 / 多端能力独立子目录。

新功能直接照这些接口形状写新文件，不要发明新抽象层。

### 目标布局（按特性切，参考 AionUi `src/process/` 和 Cherry `src/main/`）

```
src/
├── main.js              ← 启动 + 装配，目标 < 500 行
├── main/<feature>/      ← 主进程按业务领域分子目录（chat / ipc / hermes / cloud / permissions / window 等）
├── renderer/
│   ├── app.js           ← 装配 + 路由，目标 < 800 行
│   ├── <feature>.js     ← 单特性独立文件（同 group.js 形状）
│   └── <feature>/       ← 复杂特性给独立目录
├── preload.js
└── cloud/  relay/  mobile/  web/  ← 已有独立子系统保持隔离
```

### 改动前必答的三问

1. 这段代码能放到新文件里吗，让 `main.js` / `app.js` 不再变长？
2. 我引入的参数 / 抽象，是这次任务必须的，还是"将来可能用得上"？
3. 我对相邻代码的"顺手改"，能不能不做、或者拆成独立 commit？

任一答不上：停下来问用户。

## 工程约束

### 进程边界 / IPC

aimashi 是 Electron app，主进程、渲染进程、preload、cloud / relay / mobile 子系统的边界要清楚：

- renderer 不直接使用 Node / Electron 能力；需要系统能力时走 preload 暴露的窄接口。
- main 不写 DOM 逻辑；窗口、文件、进程、runtime、IPC 编排留在 main 或 `src/main/<feature>/`。
- 跨进程通信必须走明确 IPC channel；新增 channel 要集中登记或收敛到所属 feature 的常量文件，不要在调用点散落裸字符串。
- 同一个聊天 / 任务 / agent runtime 的主状态只能有一个 canonical owner。Web、mobile、desktop 可以是壳或辅助视图，不要各自重写一套会话状态机。

### 常量 / 状态 / schema

- 多处比较或 switch 的字符串必须集中为模块级常量：engine id、session status、permission kind、task status、IPC channel、cloud event type 等都算。
- 测试也要引用同一份常量，避免"实现改了、测试还在复制旧字符串"。
- 持久化数据要向后兼容：SQLite 表、cloud state、本地会话、任务、Hermes runtime cache、用户配置都不能随意改字段语义。
- 新字段要有默认值；重命名 / 删除 / 结构调整必须有迁移策略，并能重复运行而不破坏已有数据。
- secret 只进系统钥匙串、用户私有配置或 `.env` 类机制；非 secret 的开关、路径、阈值不要藏在环境变量里当长期配置。

### 日志

- 日志要能服务诊断，不要制造噪音。轮询、heartbeat、streaming token 这类高频路径不要打 info 级日志。
- 日志消息用英文自然句，带稳定模块 tag，例如 `[HermesRuntime] started runtime process`。
- `warn` 用于可恢复异常和降级；`error` 用于需要调查的失败，并把 caught error object 作为最后一个参数传入。
- 不写纯变量 dump、函数入口日志、每 tick 日志；需要调试细节时用 `debug` 或临时 instrumentation，结束后清理。

### 扩展方式

- 新 engine / channel / skill / runtime 能力优先走 adapter / registry / plugin 形状；缺 hook 就扩 hook，不要把某个 provider 或平台特例硬塞进核心大文件。
- UI 尺寸、颜色、spacing 优先落在 CSS / design token / class，不要在 JS 里散落 magic number。

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
