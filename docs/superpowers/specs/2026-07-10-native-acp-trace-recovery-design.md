# Native ACP Trace 恢复设计

日期：2026-07-10
状态：等待用户审阅书面设计

## 背景

本地 Bot 已切换到 Rust Native ACP 会话，但 Trace 的事件契约没有随运行时一起收口：

- Rust 当前发送 `thinking.delta`、`tool_call.started`、`tool_call.updated`；
- Renderer 与现有 Trace 收集器消费的是 `reasoning_delta`、`tool.started`、
  `tool.delta`、`tool.completed` 等规范事件；
- Cloud Bridge 在回复完成时又从纯文本 `stdout` 重建 Trace，没有复用实时收到的
  结构化 ACP 事件。

因此正文 `message.delta` 仍可正常显示，但 thinking 和 tool 事件会被忽略；回复
完成后持久化结果成为 `trace: {}`、`contentBlocks: []`。Trace 渲染组件本身没有
被删除。

## 目标

Hermes、Claude Code、Codex 的本地 Bot 都必须满足：

1. 运行中的 thinking、tool call、tool output 和 tool completion 实时显示；
2. 回复完成并重新打开会话后，同一份 Trace 仍然存在；
3. 正文与 Trace 不重复、不乱序；
4. 不改变模型、effort、permission、会话恢复或 Mia Logo 行为；
5. 不伪造模型没有提供的 reasoning 或工具过程。

## 方案比较

### 方案一：在 Rust ACP 边界统一事件，并复用同一收集器（采用）

Native ACP 通知进入 Mia 时立即转换成现有规范事件。Cloud Bridge 把实时转发的
同一批规范事件送入一个运行级收集器，完成后直接由该收集器生成持久化 Trace
和有序内容块。

优点是只有一份事件契约，实时和持久化天然一致，三种引擎共享实现。缺点是需要
补齐 Rust 侧真实 ACP fixture 测试。

### 方案二：让每个下游兼容所有旧、新事件别名

Renderer、Cloud Bridge 和内容块收集器分别接受
`tool_call.started`/`tool_call_started`/`tool.started` 等别名。

改动看似更快，但会把协议差异扩散到多个 owner，未来仍可能出现实时能显示、
持久化丢失的问题，因此不采用。

### 方案三：恢复旧 JavaScript ACP normalizer

在 Rust Core 与 Renderer 之间重新插入被迁移掉的 JS 转换层。

它可以恢复旧行为，但会重新产生两个会话 owner，违背 Rust Core 单一 owner 的
迁移方向，因此不采用。

## 设计

### 1. 规范 Trace 事件

Rust Native ACP 边界只向下游发送 Mia 已有的规范事件：

- `AgentMessageChunk` → `message.delta`
- `AgentThoughtChunk` → `reasoning_delta`
- `ToolCall` → `tool.started`
- 运行中的 `ToolCallUpdate` → `tool.delta`
- 已完成或失败的 `ToolCallUpdate` → `tool.completed`

事件保留真实 session id、tool call id、工具名称、输入/输出预览、状态和错误信息。
不从最终正文反推或生成 Trace。

### 2. 单一运行级收集器

Cloud Bridge 为每次运行创建一个 `CloudRunCollector`，并把 Runtime event sink 中
实际转发给 Renderer 的规范事件同步送入该收集器。

完成时：

- 正文来自收集器中的真实 `message.delta`；仅在没有结构化正文时回退现有 stdout
  解析；
- `trace` 来自收集器记录的 reasoning 与 tools；
- `contentBlocks` 来自同一收集器记录的 thinking/text/tool 顺序；
- 实时事件和最终持久化不再走两套解析路径。

Hermes 不再被 `normalize_runtime_output` 的非 Codex/Claude 分支强制清空 Trace；
只要 Hermes ACP 真实发出工具或 thinking 事件，就保存并显示。没有真实事件时仍
保持为空。

### 3. Renderer 保持现有契约

Renderer 不新增引擎特判，也不维护 Rust 事件别名。它继续消费现有规范事件，
使用现有 `trace-blocks.js` 和 `assistant-content-blocks.js` 渲染。

这样修复不会影响模型选择器、权限横幅、聊天正文样式或已有 Cloud Agent Trace。

### 4. 错误与取消

- 工具失败以真实错误状态进入 `tool.completed`；
- 运行取消时保留取消前已经收到的 Trace；
- 无法解析的 ACP 更新忽略并保持运行，不生成假工具；
- Trace 收集失败不能吞掉正常助手正文，但会通过现有稳定日志边界暴露错误。

## 测试

按红—绿循环增加以下回归覆盖：

1. Rust Native ACP 真实 notification fixture 生成规范 reasoning/tool 事件；
2. `ToolCallUpdate` 的 running、completed、failed 分别映射正确；
3. Cloud Bridge 使用结构化事件生成非空 `trace` 与有序 `contentBlocks`；
4. Hermes 的真实结构化事件不会再被完成阶段清空；
5. Renderer 接收 Rust 规范事件后实时显示，并在最终消息缺字段时保留临时 Trace；
6. 运行现有 Trace、Renderer、Rust workspace 与项目结构检查；
7. 在真实 Mia 应用中分别让 Hermes、Claude Code、Codex 执行一个可观察工具调用，
   验证实时显示、完成后显示、重开会话仍显示。

## 非目标

- 不展示模型未提供的隐藏思维链；
- 不修改 Trace 的视觉样式；
- 不改模型、effort、permission 或引擎保存逻辑；
- 不恢复 JavaScript 会话 owner；
- 未完成三引擎实测前不推送实现提交。
