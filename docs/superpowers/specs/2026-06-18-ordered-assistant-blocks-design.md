# 有序助手回复块设计

日期：2026-06-18

状态：proposed

## 目标

Mia 应该保留并展示一次 Agent 回复里的真实顺序：先说了什么、调用了什么工具、工具返回后又说了什么，都应该按发生顺序出现在同一条助手回复里。

用户看到的仍然是一条助手回复，不把一次 Agent turn 拆成多条聊天消息。区别是这条回复内部可以有多个有序块：

```text
助手回复
  文字：我先检查部署目录。
  工具：shell
  文字：现在确认 Caddy 指向 tgbot-web。
  工具：github
  文字：结论是线上跑的是服务器上的修改版。
```

这样既保留聊天语义，也让用户看懂 Agent 的工作过程。

## 当前问题

Mia 现在会把一次正在运行的 Agent 回复压扁成两个桶：

- 所有助手文字增量都追加到 `run.text`
- 推理和工具事件收集到 `run.reasoning`、`run.tools`

渲染时，前端把工具 trace 放在消息气泡上方，把所有文字合并成一个气泡。相关路径包括：

- `src/renderer/social/social.js` 把所有 `text_delta` 追加到 `run.text`
- `src/renderer/social/social.js` 在云会话消息和流式预览里把 trace 渲染在气泡前面
- `src/renderer/app.js` 在本地 bot session 里把 trace 渲染在气泡前面
- `src/cloud/messages-store.js` 持久化 `body_md` 和 `trace_json`

这会丢掉 Agent 回复的节奏。真实的 Codex 事件可能是：

```text
assistant message
tool call
tool output
assistant message
tool call
tool output
assistant message
```

但 Mia 最后只保存成“最终文本 + 工具列表”，无法还原文字和工具的交错顺序。

## 设计决策

新增“有序助手回复块”作为 message 级别的展示和持久化 contract。

不要把一次 Agent turn 拆成多条 conversation message。一条助手回复仍然只有一个 message id、一个时间戳、一个右键菜单目标、一个删除动作、一个搜索结果和一个通知 payload。只是这条 message 内部可以按顺序渲染多个 block。

第一版 block 类型只需要两个：

```js
[
  {
    type: "text",
    id: "text_msg_1",
    text: "我先检查部署目录。"
  },
  {
    type: "tool",
    id: "tool_1",
    name: "shell",
    preview: "ssh azureuser@20.2.140.104 ...",
    status: "completed",
    duration: 1.25,
    error: false
  },
  {
    type: "text",
    id: "text_msg_2",
    text: "现在确认 Caddy 指向 tgbot-web。"
  }
]
```

Reasoning 继续作为 trace 元数据保存，不默认作为可见 block 展示。它可以沿用现有 trace 组件的展示规则，但一旦存在 ordered blocks，工具就不应该再统一堆到回复顶部。

## 非目标

- 不重建 Mia 的整个聊天 timeline 模型。
- 不把一条助手回复拆成多条云端消息。
- 不移除 `body_md`。它仍然是搜索、预览、通知、历史上下文和旧客户端使用的纯 markdown 文本。
- 不迁移旧消息。
- 不默认展开长工具输出，避免噪音和敏感信息暴露。
- 不大改各个模型 adapter，只做收集有序事件所需的最小改动。

## 数据模型

给 message 新增一个可选字段：

```text
content_blocks_json
```

云端 SQLite 的 `messages` 表增加 nullable text 列。桌面本地 conversation cache 如果已经通过 `payload` JSON 保存完整 message，可以不加列，但必须保留这个字段。

消息示例：

```json
{
  "id": "m_abc",
  "sender_kind": "bot",
  "sender_ref": "codex",
  "body_md": "我先检查部署目录。\n\n现在确认 Caddy 指向 tgbot-web。\n\n结论是...",
  "trace_json": "{\"tools\":[...]}",
  "content_blocks_json": "[{\"type\":\"text\",\"id\":\"text_msg_1\",\"text\":\"我先检查部署目录。\"}]"
}
```

字段职责：

- `body_md`：完整可读文本，给搜索、复制、通知、历史上下文和旧客户端用。
- `content_blocks_json`：有序展示 contract，给新前端按顺序渲染文字和工具。
- `trace_json`：兼容旧前端，同时继续保存 reasoning 和工具元数据。

写入前要 normalize blocks：

- 总 block 数设置上限，例如 200。
- 丢弃非法 block 对象。
- 丢弃空 text block。
- tool block 必须有 `name`。
- tool preview 要截断，沿用现有 trace preview 的长度策略。
- tool status 统一成 `running`、`completed`、`error`。
- normalize 后仍然保留原始顺序。

## 事件收集

在现有 trace collector 旁边增加 ordered block collector。

collector 处理现有 engine adapter 已经 emit 的事件：

- `text_delta`
- `tool_call_started`
- `tool_call_delta`
- `tool_call_completed`
- `reasoning_delta`
- `complete`
- `error`

文字事件规则：

- 如果当前打开的 text block id 和事件 id 一致，就追加到当前 text block。
- 如果工具 block 后面来了新的 text id，就创建新的 text block。
- 如果当前没有 text block，也创建新的 text block。
- `body_md` 继续由所有 text block 按顺序拼接得到，保证现有功能可用。

工具事件规则：

- `tool_call_started`：在当前位置追加一个 tool block。
- `tool_call_delta`：更新匹配 tool block 的 preview。
- `tool_call_completed`：更新匹配 tool block 的 status、preview、duration、error。
- 匹配优先用 id；如果 engine 没有稳定 id，再沿用现有的 name queue fallback。

reasoning 事件规则：

- 继续收集到 `trace_json`。
- 第一版不把 reasoning 加入可见 ordered blocks。
- renderer 只有在现有 trace 策略允许时，才可以在第一个工具附近显示简洁 reasoning。

collector 应该放在共享或 main 侧模块，避免 daemon 和 renderer 各写一套规则。候选文件：

```text
src/shared/assistant-content-blocks.js
```

local bot responder 和 renderer transient run state 都应该复用同一套 normalize 规则。

## 持久化和 API

Cloud 侧：

- `src/cloud/sqlite-store.js` 增加 `messages.content_blocks_json` migration。
- `src/cloud/messages-store.js` 增加 `normalizeContentBlocks`。
- `appendMessage` 接收 `contentBlocks`。
- `listMessagesSince`、搜索结果、message append event 都带上 `content_blocks_json`。
- `POST /messages/as-bot` 允许可信 bot owner 路径传入 `contentBlocks`。

桌面本地 cache：

- 在 cached payload 里保留 `content_blocks_json`。
- 如果 cached row 顶层有 `content_blocks_json`，读取 recent messages 时要返回。
- 旧 cache row 没有该字段也必须正常工作。

Local bot responder：

- 流式运行时同时收集 trace 和 content blocks。
- 最终发 bot 回复时保存：
  - `bodyMd`：完整文本
  - `trace`：现有 trace payload
  - `contentBlocks`：normalize 后的有序 blocks

Engine adapters：

- 优先使用现有事件 id。Codex 已经有 agent message item id 和 command/tool id；Claude Code、OpenClaw adapter 也已经会 emit text/tool id。
- 不在 adapter 里写前端展示逻辑。adapter 只把事件 normalize 到统一 collector contract。

## 渲染

当助手消息有合法 ordered content blocks 时，在现有 message stack 内按顺序渲染：

```html
<article class="message assistant">
  <div class="avatar"></div>
  <div class="message-stack">
    <div class="assistant-blocks">
      <div class="bubble assistant-text-block">...</div>
      <details class="trace-row tool">...</details>
      <div class="bubble assistant-text-block">...</div>
    </div>
    <time class="message-time">...</time>
  </div>
</article>
```

文字 block 使用现有 markdown renderer 和助手气泡样式。工具 block 复用现有 trace row 视觉语言，包括状态图标、可折叠内容、preview 文本、展开状态记忆。

渲染规则：

- 如果只有一个 text block 且没有 tool block，就渲染成今天的普通气泡。
- 如果存在 ordered blocks，就不要再把旧的 top-level tool trace 列表渲染到气泡上方。
- 如果 message 有 `trace_json.reasoning`，只有在现有 duplicate-reasoning 规则允许时，才在第一个工具前或工具附近紧凑显示。
- 右键菜单、复制、删除、回复、翻译、时间戳仍然挂在整条 assistant message 上。
- “复制整条消息”使用 `body_md`，不要复制 tool preview。
- 单个文字 block 内的文本选择继续走现有 `.bubble` text-hit 行为。

流式预览规则：

- blocks 到达时按顺序实时渲染。
- running tool block 原地更新。
- 工具后面出现的新文字，显示为同一条助手回复内的新文字气泡。
- 最终云端 message 到达后，用持久化 message 替换 transient streaming article，并保持视觉顺序一致。

Web 和移动端：

- 桌面 renderer 是第一目标。
- Web 应跟随同一个 contract，因为 `src/web/app.js` 已经在复用桌面 bubble 和 trace 行为。
- Mobile 第一版可以忽略 `content_blocks_json`，继续渲染 `body_md`，等移动端聊天渲染支持 ordered blocks 再升级。

## 向后兼容

旧消息：

- 如果没有 `content_blocks_json`，或字段非法，继续走今天的 `trace_json + body_md` 渲染路径。

旧客户端：

- 继续读取 `body_md` 和 `trace_json`。
- 不显示有序 blocks，但仍然能看到最终答案和工具列表。

异常情况：

- 如果 block normalize 失败，就丢弃 `content_blocks_json`，保留 `body_md`。
- 如果收到 tool completed 但没有匹配的 started event，就在当前位置追加一个 synthetic tool block。
- 如果某个 engine 只返回最终文本、不提供流式事件，就不生成 blocks，继续走现有路径。

## 测试

实现前先补聚焦测试。

Shared block collector：

- 保留 text、tool、text 顺序。
- 同一个 text id 会合并到同一个 block。
- 工具后出现新的 text id 会创建新的 text block。
- tool delta 和 completed 会更新匹配 block。
- 非法和空 block 会被丢弃。

Cloud messages store：

- `appendMessage` 能 round-trip `content_blocks_json`。
- 非法 blocks 会被省略，但 `body_md` 仍然持久化。
- 没有 blocks 的旧消息仍然能正常 list。

Local bot responder：

- `text_delta -> tool_call_started -> tool_call_completed -> text_delta` 会保存 ordered `contentBlocks`。
- 现有 `trace_json` 行为不变。

Renderer：

- 带 blocks 的云端助手消息按 text/tool/text 顺序渲染。
- 带 blocks 的消息不会在第一个气泡上方重复渲染 top-level tool trace。
- fallback 路径仍然渲染旧的 `trace_json + body_md`。
- streaming run 能在两段文字之间渲染 running tool。

Web parity：

- Web renderer 能读取 `content_blocks_json`，文字 block 使用 markdown。
- fallback 仍然使用现有气泡渲染。

## 实现边界

第一版保持窄范围：

1. 新增共享 normalize 和 collector 模块。
2. 增加持久化字段和 API round trip。
3. local responder 收集 blocks 并在最终回复里保存。
4. 桌面 renderer 支持持久化消息和 streaming blocks。
5. 如果桌面实现已经抽出共享渲染 helper，Web 同步支持。

避免顺手清理 `src/renderer/app.js` 和 `src/renderer/social/social.js`。这两个文件已经很大，新渲染 helper 应放进聚焦的 renderer chat 模块，再由现有渲染路径调用。

## 风险

主要风险是 `trace_json.tools` 和 `content_blocks_json` 里的 tool block 重复。规则是：

- `content_blocks_json` 是有序渲染来源。
- `trace_json` 继续作为兼容元数据和 reasoning 存储。
- 一旦 blocks 存在，就从 blocks 渲染工具，不再从 `trace_json.tools` 渲染工具。

第二个风险是视觉噪音。工具 block 默认应该保持紧凑，复用可折叠 trace row，不自动展开长输出。

第三个风险是搜索和复制。`body_md` 必须继续作为搜索、预览、通知、历史上下文和整条消息复制的纯文本来源。tool preview 只有以后做显式“复制工具输出”入口时才单独复制。

## 当前默认决策

实现前不需要再做产品决策，第一版使用保守默认：

- reasoning 不进入可见 ordered blocks。
- `body_md` 仍然是完整文本来源。
- 桌面和 Web 先支持 ordered rendering。
- Mobile 先 fallback 到 `body_md`。

如果后续用户确实需要更强的过程可见性，第二阶段再加设置项，例如 reasoning 的展示位置，或单个工具输出复制。
