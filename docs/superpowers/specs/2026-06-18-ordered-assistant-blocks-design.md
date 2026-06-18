# 有序助手回复块设计

日期：2026-06-18

状态：proposed

## 目标

Mia 应该保留并展示一次 Agent 回复里的真实顺序：先说了什么、调用了什么工具、工具返回后又说了什么，都应该按发生顺序出现在同一条助手回复里。

用户看到的仍然是一条助手回复，不把一次 Agent turn 拆成多条聊天消息。区别是这条回复内部可以有多个有序块：

```text
助手回复
  思考：正在分析部署来源。
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

渲染时，前端把工具 trace 放在消息气泡上方，把所有文字合并成一个气泡。reasoning 即使被收集到，也只在非常有限的条件下显示。相关路径包括：

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

## 成熟方案参考

这个设计应该跟随成熟 Agent transcript 的共同原则：按事件发生顺序渲染，而不是按类型分区。

AionUi desktop 的测试明确覆盖了这个行为：

- `text -> acp_tool_call -> text` 必须保持为三段，而不是合并成一段 text 后再把 tool 放到上面。
- `thinking -> acp_tool_call -> thinking` 也必须保持分段，工具打断 thinking 后，后续 thinking 不能合并回工具前面的 thinking。

本地参考：

- `/Users/jung/GitHub/Alkaka-reference/AionUi/tests/unit/renderer/messageMerging.dom.test.tsx`
- `/Users/jung/GitHub/Alkaka-reference/AionUi/packages/desktop/src/renderer/pages/conversation/Messages/hooks.ts`
- `/Users/jung/GitHub/Alkaka-reference/AionUi/packages/desktop/src/renderer/pages/conversation/Messages/components/MessageThinking.tsx`

Claude Code 的流式事件天然是 content block 结构：`text`、`thinking`、`tool_use`、`tool_result` 按顺序出现。Mia 的 `src/main/claude-code-chat-adapter.js` 已经能识别 `content_block_start` 中的 `text`、`thinking`、`tool_use`，并 emit `text_delta`、`reasoning_delta`、`tool_call_started`。

Codex 的 app-server 事件也是顺序流：`item/agentMessage/delta`、`item/reasoning/*Delta`、`item/started`、`item/completed` 按发生顺序到达。Mia 的 `src/main/codex-app-server-runner.js` 已经把这些事件 emit 成 `text_delta`、`reasoning_delta`、`tool_call_*`。

结论：Mia 应该保留这个顺序。`thinking` 和 `tool` 用同一类小字 trace UI，`text` 不区分“过程回复”和“最终回复”，统一用气泡 UI。

## 设计决策

新增“有序助手回复块”作为 message 级别的展示和持久化 contract。

不要把一次 Agent turn 拆成多条 conversation message。一条助手回复仍然只有一个 message id、一个时间戳、一个右键菜单目标、一个删除动作、一个搜索结果和一个通知 payload。只是这条 message 内部可以按顺序渲染多个 block。

第一版 block 类型需要三个：

```js
[
  {
    type: "thinking",
    id: "thinking_1",
    text: "正在分析部署来源。",
    status: "completed",
    duration: 1.25
  },
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

`thinking` 和 `tool` 都属于 trace 系列 UI：小字、紧凑、可折叠或可弱化显示。`text` 属于聊天气泡 UI。过程回复和最终回复技术上都是 `text`，不需要两套 UI；最后一个 text block 自然承担最终回复角色。

Reasoning 不是完整推理链的承诺。很多引擎只提供状态、摘要、空 summary 或加密内容。Mia 只能展示可展示的 reasoning summary 或“思考中/已思考”状态，不能假装拿到了完整推理过程。

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
  "content_blocks_json": "[{\"type\":\"thinking\",\"id\":\"thinking_1\",\"text\":\"正在分析部署来源。\"},{\"type\":\"text\",\"id\":\"text_msg_1\",\"text\":\"我先检查部署目录。\"}]"
}
```

字段职责：

- `body_md`：完整可读文本，给搜索、复制、通知、历史上下文和旧客户端用。
- `content_blocks_json`：有序展示 contract，给新前端按顺序渲染 thinking、tool 和 text。
- `trace_json`：兼容旧前端，同时继续保存 reasoning 和工具元数据。

写入前要 normalize blocks：

- 总 block 数设置上限，例如 200。
- 丢弃非法 block 对象。
- 丢弃空 text block。
- thinking block 可以只有状态和 duration；如果有可展示 summary，再保存 `text`。
- tool block 必须有 `name`。
- tool preview 要截断，沿用现有 trace preview 的长度策略。
- thinking/tool status 统一成 `running`、`completed`、`error`。
- normalize 后仍然保留原始顺序。

## 事件收集

在现有 trace collector 旁边增加 ordered block collector。collector 的核心职责是保留事件顺序，不按类型重新排序。

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

- `reasoning_delta` 到达时，在当前位置创建或追加 `thinking` block。
- 如果同一个 thinking id 连续到达，就合并到当前 thinking block。
- 如果 tool block 打断了 thinking，后续同 id 的内容型 thinking delta 也创建新的 thinking block，不能合并回工具前面。
- 如果 thinking 完成或耗时这类状态更新晚于 tool 到达，可以回填最近的匹配 thinking block，不需要创建新的空 thinking block。
- 如果 engine 只提供“开始思考/结束思考”状态，没有可展示文字，也可以创建 status-only thinking block。
- 如果 engine 只提供加密 reasoning 或空 summary，不要伪造 reasoning 文本；最多显示通用状态，例如“思考中”或“已思考 4.2s”。
- reasoning 同时继续收集到 `trace_json`，服务旧前端和兼容路径。

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
      <details class="trace-row thinking">...</details>
      <div class="bubble assistant-text-block">...</div>
      <details class="trace-row tool">...</details>
      <div class="bubble assistant-text-block">...</div>
    </div>
    <time class="message-time">...</time>
  </div>
</article>
```

文字 block 使用现有 markdown renderer 和助手气泡样式。thinking block 和 tool block 复用同一套 trace row 视觉语言，包括状态图标、可折叠内容、preview 文本、duration、展开状态记忆。

渲染规则：

- 如果只有一个 text block 且没有 thinking/tool block，就渲染成今天的普通气泡。
- 如果存在 ordered blocks，就不要再把旧的 top-level tool trace 列表渲染到气泡上方。
- 如果存在 ordered blocks，就按 block 顺序渲染 thinking、tool、text，不按类型分区。
- 如果 message 只有旧 `trace_json.reasoning`、没有 ordered thinking block，才走旧 trace fallback。
- 右键菜单、复制、删除、回复、翻译、时间戳仍然挂在整条 assistant message 上。
- “复制整条消息”使用 `body_md`，不要复制 tool preview。
- 单个文字 block 内的文本选择继续走现有 `.bubble` text-hit 行为。
- thinking/tool block 默认紧凑显示，不抢正文视觉重心。

流式预览规则：

- blocks 到达时按顺序实时渲染。
- thinking block 可以先显示“思考中”，后续 reasoning summary 到达时更新文本。
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
- 如果收到 thinking done 但没有匹配的 running thinking block，就更新最近的 thinking block；没有最近 block 时追加一个 status-only thinking block。
- 如果某个 engine 只返回最终文本、不提供流式事件，就不生成 blocks，继续走现有路径。

## 测试

实现前先补聚焦测试。

Shared block collector：

- 保留 thinking、text、tool、text 顺序。
- 同一个 text id 会合并到同一个 block。
- 工具后出现新的 text id 会创建新的 text block。
- 同一个 thinking id 连续到达会合并到同一个 block。
- 工具打断后，同一个 thinking id 的内容 delta 再出现会创建新的 thinking block。
- 工具打断后，同一个 thinking id 的完成或耗时状态更新会回填最近的匹配 thinking block。
- tool delta 和 completed 会更新匹配 block。
- 非法和空 block 会被丢弃。

Cloud messages store：

- `appendMessage` 能 round-trip `content_blocks_json`。
- 非法 blocks 会被省略，但 `body_md` 仍然持久化。
- 没有 blocks 的旧消息仍然能正常 list。

Local bot responder：

- `reasoning_delta -> text_delta -> tool_call_started -> tool_call_completed -> text_delta` 会保存 ordered `contentBlocks`。
- 现有 `trace_json` 行为不变。

Renderer：

- 带 blocks 的云端助手消息按 thinking/text/tool/text 顺序渲染。
- 带 blocks 的消息不会在第一个气泡上方重复渲染 top-level tool trace。
- fallback 路径仍然渲染旧的 `trace_json + body_md`。
- streaming run 能在两段文字之间渲染 running thinking 和 running tool。

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
- 一旦 blocks 存在，就从 blocks 渲染 thinking 和工具，不再从 `trace_json` 顶部重渲染 thinking/tools。

第二个风险是视觉噪音。thinking/tool block 默认应该保持紧凑，复用可折叠 trace row，不自动展开长输出。

第三个风险是搜索和复制。`body_md` 必须继续作为搜索、预览、通知、历史上下文和整条消息复制的纯文本来源。thinking 文本和 tool preview 只有以后做显式“复制 trace 内容”入口时才单独复制。

## 当前默认决策

实现前不需要再做产品决策，第一版使用保守默认：

- reasoning 作为 `thinking` ordered block 进入 trace UI，但只展示可展示 summary 或状态，不展示不可获取的完整推理链。
- `body_md` 仍然是完整文本来源。
- 桌面和 Web 先支持 ordered rendering。
- Mobile 先 fallback 到 `body_md`。

如果后续用户确实需要更强的过程可见性，第二阶段再加设置项，例如 thinking 默认展开策略、是否显示 duration，或单个 trace block 复制。
