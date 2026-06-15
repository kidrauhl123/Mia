# Agent 参考项目

这份文档只放参考项目和 UX 研究指针，不作为强制规则。真正约束写在根目录和各子目录 `AGENTS.md`。

## 开源代码参考

### AionUi

本地路径：`~/github/Alkaka-reference/AionUi`

同类 Electron 多引擎 AI 客户端。适合参考：

- `src/process/agent/AgentRegistry.ts`：多引擎注册表。
- `src/process/agent/acp/AcpDetector.ts`：PATH 探测 CLI 可用性。
- `src/process/channels/`：Telegram、Lark、钉钉、微信、企微接入。
- `src/process/webserver/`：手机远程访问 WebUI。
- `src/process/task/`：Cron 调度。

### LobsterAI

本地路径：`~/github/Alkaka-reference/lobsterai`

Electron + React 个人助理 Agent 客户端。适合参考：

- `src/main/libs/openclawEngineManager.ts`：engine 状态机、自动重启、runtime 探测。
- `src/main/libs/pythonRuntime.ts`：运行时寻路、进程启动、健康检查。
- `src/scheduledTask/`：Cron 调度和迁移。
- `src/main/libs/mcpServerManager.ts`：MCP 生命周期管理。
- `src/common/coworkErrorClassify.ts`：Agent 错误分类。

### Cherry Studio

本地路径：`~/github/Alkaka-reference/cherry-studio`

适合参考多 provider 流式架构、统一 chunk schema、thinking/reasoning UI、MCP tool 渲染、Electron IPC abort 流程。

### ClaudeCodeUI

本地路径：`~/github/Alkaka-reference/claudecodeui`

适合参考 one-file-per-CLI provider 布局、`normalizeMessage` 适配器、agent 状态栏和 tool renderer 路由。

### Telegram 开源端

本地路径：

- `~/github/tdesktop`
- `~/github/telegram-android`
- `~/github/telegram-ios`

适合参考聊天 UX：typing/recording 状态、消息列表虚拟化、reply/quote/forward、动态贴纸、窄窗导航和长列表细节。

特别注意 `tdesktop/AGENTS.md` 的写法：它把环境、构建、失败边界、持久化兼容、项目内 DSL/API 模式写成具体操作说明。Mia 的 AGENTS 应该学习这种形状，而不是堆泛泛原则。

## 闭源体验参考

### WorkBuddy

腾讯云 CodeBuddy 团队桌面 AI Agent。适合观察：

- 自然语言到多步桌面任务的执行链路。
- 微信扫码配对和手机远程控制 PC 端 Agent。
- skill 模板入口和呈现。
- 多模型切换 UX。
- 开箱即用初始化路径。

### 微信

适合观察中国市场聊天界面惯例：会话列表密度、窄窗返回导航、avatar + 名字 + 预览行、群聊/私聊信息层级。

### Codex 桌面端

适合观察 agent 长任务、tool 密集消息、todo/plan 渲染、avatar overlay、多步任务状态反馈。

### Claude 桌面端

适合观察流式 token、tool-use 卡片、project/files 面板、代码块 UX。
