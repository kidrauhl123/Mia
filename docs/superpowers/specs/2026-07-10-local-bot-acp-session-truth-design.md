# 本地 Bot ACP 会话真值设计

日期：2026-07-10
状态：已获用户确认
范围：Hermes、Claude Code、Codex 本地 Bot 对话

## 目标

本地 Bot 的核心验收必须同时覆盖三套引擎：

1. 用户发送消息后，实际引擎收到请求并返回真实回复。
2. 模型、推理强度、权限只展示引擎当前会话真实公布和确认的值。
3. 不再显示“CLI 默认”、`medium`、`default` 等推测值或占位选项。
4. 引擎没有公布某项能力时隐藏该控件。当前 Hermes 0.16 没有公布 effort，因此隐藏 Hermes effort。
5. Bot 保存、重启和会话恢复不得把 Claude Code 或 Codex 回退成 Hermes。
6. 三套引擎未显式选择模型时都使用 Mia 平台的 `mia-auto`（界面名称 `Auto`，当前上游为 DeepSeek），并复用现有 Mia 模型身份和 Logo。

## 已确认的根因

- `NativeAcpTask::ensure_session` 只保留 `session_id`，丢弃 `session/new` 返回的 `models`、`modes` 和 `config_options`。
- Runtime plan 虽然带有 provider/model 信息，但 native ACP 在 prompt 前没有执行 `session/set_model`、`session/set_mode` 或 `session/set_config_option`。
- Rust ACP 客户端把所有 `session/request_permission` 统一回复为 `Cancelled`。
- Bot 控制项由静态模型目录和硬编码默认值拼装，而不是由活跃 ACP 会话提供。
- 缺少 runtime binding 时，`agent`/`desktop-local` 的默认引擎是 Hermes；读取错误的 runtime kind 会把真实 Bot 身份覆盖成 Hermes。
- 引擎健康探针只有 2 秒，却包含 initialize、session/new 和一次真实 prompt，三套引擎当前均超时。

## 参考实现与许可证

设计参考本机 AionCore v0.1.37 的 ACP 会话聚合模型：会话同时保存 desired、observed、advertised 三层状态，并在 session/new、session/load 和 session/update 后进行 reconcile。

本机 AionCore/AionUi 实际许可证是 Apache-2.0。Mia 借鉴状态边界和协议流程；如移植具体实现，保留 SPDX/版权标识和所需归属说明。

## 选定方案

采用“Rust 会话真值”方案，不采用静态能力目录，也不整体嵌入 AionCore。

### 单一 owner

`NativeAcpSessionManager` 是 `(engine, conversation_id, workspace)` ACP 会话的唯一 owner。Renderer、Preload、BotService 只消费 Core 暴露的快照，不能自己合成控制项。

### 三层状态

每个 ACP 会话保存：

- desired：Bot 绑定中用户明确选择的模型和 effort，以及引擎级 permission。
- advertised：引擎通过 session/new、session/load、session/update 公布的真实模型、模式和 config options。
- observed：引擎确认的当前值。

界面只能展示 advertised 中的选项，只能把 observed 当作当前值。desired 不等于 observed 时显示设置中或错误，不能提前乐观改值。

### 统一控制项快照

Core 对 Renderer 返回按会话生成的控制项快照：

- `engine`
- `sessionId`
- `state`: `starting | ready | error`
- `controls[]`
  - `id`
  - `category`: `model | thought_level | permission`
  - `currentValue`
  - `options[]`
  - `source`: `mia_provider | config_option | legacy_model | legacy_mode`
- `error`

转换规则：

1. 优先使用真实 `config_options`。
2. 只有引擎未提供对应 config option 时，才把 ACP legacy `models`/`modes` 转成 model/permission 控制项。
3. 不从静态目录合成 effort 或 permission。
4. 没有真实 option/current value 的控件不渲染。
5. Mia 平台模型是明确的运行路由，不是 CLI 占位：Core 启动本地协议代理，把 `mia-auto` 注入当前会话，并以 `mia_provider` 返回唯一真实选项 `Auto`。

### 会话准备与发送

打开本地 Bot 对话时，Renderer 请求 Core 准备 runtime。Core 启动或复用 ACP 进程，完成 initialize 与 session/new/load，保存并返回快照，但不发送用户 prompt。

发送消息时使用同一个会话：

1. 按 advertised 能力校验 desired。
2. 使用 `session/set_config_option`，或 legacy `session/set_model`/`session/set_mode`，把 desired reconcile 到会话。
3. 只有设置成功后才调用 session/prompt。
4. 收集真实 agent message chunk；空回复是显式错误。
5. 断线或失效 session 只重建同一 engine 的会话，不得改写 Bot engine。

### 修改控制项

用户选择控制项后调用 Core 会话接口：

- config option 使用 `session/set_config_option`，并用响应或 update 中的 current value 确认。
- legacy model 使用 `session/set_model`。
- legacy permission/mode 使用 `session/set_mode`。
- 未公布的值直接拒绝，不保存。
- model、effort 在引擎确认后保存到当前 Bot binding。
- permission 按仓库既有规则是引擎级设置；确认后保存到引擎权限 store，并同步当前活跃会话。需要用户级原生配置的引擎只在用户修改时 apply 一次。

### 权限请求

Rust ACP 客户端不再统一 Cancel：

- 自动允许类真实 permission mode 选择 ACP 请求中可用的 allow option。
- 拒绝类 mode 选择 reject/cancel option。
- 需要询问时进入 `NativeAcpPermissionBroker`，发布带 session、工具名和命令预览的 pending request，等待 `/api/agent-permissions/respond` 的真实决定，再把引擎原始 option id 回复 ACP。
- prompt 取消时，所有对应 pending request 都以 ACP `Cancelled` 结束。

### Bot engine 身份

Bot identity 和 runtime binding 必须使用相同的规范化 engine id。读取 binding 时：

1. 先读取 Bot 实际 runtime kind。
2. 已存在 binding 是运行真值。
3. 缺少 binding 时从 Bot identity 的 `agentEngine` 建立默认 binding。
4. 不允许用通用 Hermes 默认值覆盖已有 Claude Code/Codex identity。

## Renderer 行为

- 会话准备完成前禁用发送并显示明确的连接状态。
- 只渲染快照中存在的控件。
- 不显示“CLI 默认”、假 `medium` 或假 permission。
- `mia_provider` 模型选项使用既有 Mia provider/model profile 身份，因此沿用既有 Mia Logo，不新建或替换 Logo 资源。
- 设置失败时保留原 observed 值并显示错误。
- session/update 到达后立即刷新相应控件。

## 测试与验收

### 自动化

- Rust 协议测试：session/new 快照、config update 合并、legacy fallback、unsupported 隐藏。
- Rust reconcile 测试：model/effort/permission 调用正确 ACP 方法，未公布值被拒绝。
- 权限测试：allow、deny、manual response、remembered rule。
- BotService 测试：缺少 binding 时按 identity 建立正确 engine，不回退 Hermes。
- Router contract 测试：准备、读取、修改控制项。
- Renderer 测试：只显示真实控件、无占位、设置确认后更新。

### 三引擎实测矩阵

每个引擎必须独立完成：

1. 打开对应本地 Bot。
2. 确认 engine 未串台。
3. 记录 session 公布的真实控制项；Hermes 当前 effort 应隐藏。
4. 在实际可选项中切换至少一项，再确认 UI 与会话 current value 一致。
5. 发送唯一测试消息。
6. 收到该引擎真实回复，消息持久化为 complete。
7. 重开对话，确认 engine 与已确认控制项没有回退。

只有 Hermes、Claude Code、Codex 三行全部通过，任务才算完成。
