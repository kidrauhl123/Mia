# Ordered Assistant Blocks Design

Date: 2026-06-18

Status: proposed

## Goal

Mia should preserve and display the order of an Agent turn: text, tool calls, tool results, and follow-up text should appear in the same sequence the Agent produced them.

The user-facing shape remains one assistant reply. Internally, that reply can contain multiple ordered blocks. This keeps chat semantics simple while making Agent work understandable:

```text
assistant message
  text: 我先检查部署目录。
  tool: shell
  text: 现在确认 Caddy 指向 tgbot-web。
  tool: github
  text: 结论是线上跑的是服务器上的修改版。
```

## Current Behavior

Mia currently flattens a running Agent turn into two buckets:

- assistant text deltas are appended to `run.text`
- reasoning and tool events are collected into `run.reasoning` and `run.tools`

Rendering then puts trace blocks above the message bubble and renders all text as one bubble. This happens in the desktop social renderer and local bot session renderer:

- `src/renderer/social/social.js` appends all text deltas to `run.text`.
- `src/renderer/social/social.js` renders trace before the bubble in cloud conversation messages and streaming previews.
- `src/renderer/app.js` renders local bot session trace before the bubble.
- `src/cloud/messages-store.js` persists `body_md` plus `trace_json`.

This loses a real part of the Agent experience. A Codex run can naturally produce:

```text
agent_message
tool_call
tool_output
agent_message
tool_call
tool_output
agent_message
```

Mia stores the final text and tool list, but not the interleaving.

## Decision

Add ordered assistant blocks as a message-level presentation and persistence contract.

Do not split one Agent turn into multiple conversation messages. A single assistant reply should still have one message id, one timestamp, one context-menu target, one delete action, one search row, and one notification payload. The internal content of that message can be rendered as a sequence of blocks.

The recommended first block types are:

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

Reasoning remains available as trace metadata, not a default visible block. It can continue to render through the existing trace component when there are tools, but it should not force all tools to the top of the reply once ordered blocks are present.

## Non-Goals

- Do not rebuild Mia's entire chat timeline model in this change.
- Do not split one assistant turn into several cloud messages.
- Do not remove `body_md`; it remains the canonical plain markdown text for search, previews, notifications, history prompts, and old clients.
- Do not require old messages to be migrated.
- Do not expose raw tool outputs inline by default if they are long, noisy, or sensitive.
- Do not change model adapter behavior more than needed to collect ordered events.

## Data Model

Add an optional message field:

```text
content_blocks_json
```

For cloud storage, add it to the `messages` table as nullable text. For desktop local cache, no schema change is required if the existing `payload` JSON already stores unknown message fields, but the cache should preserve this field when present.

Message shape:

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

`body_md` remains the readable full text. `content_blocks_json` is an ordered rendering contract. `trace_json` remains a fallback and carries reasoning/tool metadata for older renderers and non-block displays.

Normalize blocks before writing:

- Limit total blocks to a practical cap, for example 200.
- Drop invalid block objects.
- Drop empty text blocks.
- Require tool block `name`.
- Clamp long tool previews, following the existing trace preview behavior.
- Normalize tool statuses to `running`, `completed`, or `error`.
- Preserve block order exactly after normalization.

## Event Collection

Introduce an ordered block collector next to the existing trace collector.

The collector should process the same events already emitted by engine adapters:

- `text_delta`
- `tool_call_started`
- `tool_call_delta`
- `tool_call_completed`
- `reasoning_delta`
- `complete`
- `error`

Text handling:

- Append a text delta to the current open text block when the event id matches the current text block id.
- Start a new text block when the text event id changes after a tool block, or when there is no current text block.
- Continue updating `body_md` from all text blocks joined in order, so existing surfaces keep working.

Tool handling:

- On `tool_call_started`, append a tool block at the current position.
- On `tool_call_delta`, update the matching tool block preview.
- On `tool_call_completed`, update status, preview, duration, and error on the matching tool block.
- Matching should use id first, then fall back to the existing name queue behavior for engines that omit stable ids.

Reasoning handling:

- Continue collecting reasoning into `trace_json`.
- Do not add reasoning as a visible ordered block in the first version.
- The renderer may show compact reasoning above or near the first tool only if the current trace policy already would show it.

The collector should live in a shared or main-side module rather than being duplicated in renderer and daemon code. A candidate is a focused shared module such as:

```text
src/shared/assistant-content-blocks.js
```

Local bot responder and renderer transient state can both use the same normalization rules.

## Persistence And API

Cloud:

- Add a migration in `src/cloud/sqlite-store.js` for nullable `messages.content_blocks_json`.
- Extend `src/cloud/messages-store.js` with `normalizeContentBlocks`.
- `appendMessage` accepts `contentBlocks`.
- `listMessagesSince`, search results, and message append events include `content_blocks_json` when present.
- `POST /messages/as-bot` accepts `contentBlocks` from trusted bot-owner paths.

Desktop local cache:

- Preserve `content_blocks_json` inside the cached payload.
- If a cached row has a top-level `content_blocks_json`, return it with recent messages.
- Existing cache rows continue to work because the field is optional.

Local bot responder:

- Collect trace and content blocks while streaming.
- Save final reply with:
  - `bodyMd`: full text
  - `trace`: existing trace payload
  - `contentBlocks`: ordered normalized blocks

Engine adapters:

- Prefer using existing event ids. Codex already emits agent message item ids and command/tool ids. Claude Code and OpenClaw emit text/tool ids in their adapters.
- Avoid adding engine-specific rendering logic. Normalize events into the same block collector contract.

## Rendering

When an assistant message has valid ordered content blocks, render blocks in order inside the existing message stack:

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

Text blocks use the same markdown renderer and bubble styling as current assistant messages. Tool blocks reuse the existing trace row visual language, including status glyph, collapsible body, preview text, and remembered open state.

Important rendering rules:

- If there is exactly one text block and no tool blocks, render like today's normal bubble.
- If there are ordered blocks, do not also render the old top-level tool trace list above the bubble.
- If the message has `trace_json.reasoning`, render it compactly before the first tool or as a trace row at the start only when the existing duplicate-reasoning rules allow it.
- Message-level context menu, copy, delete, reply, translation, and timestamp should remain attached to the whole assistant message.
- Copying the whole message should use `body_md`, not tool previews.
- Selecting text inside one text block should continue to use the existing `.bubble` text-hit behavior.

Streaming preview:

- Render ordered blocks as they arrive.
- Running tool blocks should update in place.
- New text after a tool should appear as a new assistant text bubble within the same message stack.
- Once the final cloud message arrives, replace the transient streaming article with the persisted message, preserving visual order.

Mobile and web:

- Desktop renderer is the first target.
- Web should follow the same contract because `src/web/app.js` already mirrors desktop bubble and trace behavior.
- Mobile can initially ignore `content_blocks_json` and render `body_md` until its chat renderer supports ordered blocks.

## Backward Compatibility

Old messages:

- If `content_blocks_json` is missing or invalid, render using today's `trace_json + body_md` path.

Old clients:

- They continue to read `body_md` and `trace_json`.
- They will not show ordered blocks, but they will still show the final answer and tools.

Partial failures:

- If block normalization fails, drop `content_blocks_json` and keep `body_md`.
- If a tool event has no matching started event, append a synthetic tool block at the current position.
- If an engine only returns final text without events, produce no blocks and keep the current path.

## Testing

Add focused tests before implementation changes:

- Shared block collector:
  - text, tool, text order is preserved
  - same text id accumulates into one block
  - text id after a tool creates a new text block
  - tool delta and completion update the matching block
  - invalid and empty blocks are dropped

- Cloud messages store:
  - `appendMessage` round-trips `content_blocks_json`
  - invalid blocks are omitted while `body_md` persists
  - old messages without blocks still list normally

- Local bot responder:
  - streaming `text_delta -> tool_call_started -> tool_call_completed -> text_delta` saves ordered `contentBlocks`
  - existing `trace_json` behavior remains unchanged

- Renderer:
  - cloud assistant message with blocks renders text/tool/text in order
  - message with blocks does not render duplicate top-level tool trace above the first bubble
  - fallback path still renders old `trace_json + body_md`
  - streaming run renders a running tool between text blocks

- Web parity:
  - web renderer accepts `content_blocks_json` and uses markdown for text blocks
  - fallback still uses existing bubble rendering

## Implementation Boundaries

Keep the first implementation intentionally narrow:

1. Shared normalization and collector module.
2. Persistence field and API round trip.
3. Local responder collection and final save.
4. Desktop renderer support for persisted and streaming blocks.
5. Web renderer support if the desktop renderer already touches shared block rendering helpers.

Avoid unrelated cleanup in `src/renderer/app.js` and `src/renderer/social/social.js`. Both files are already large; any new rendering helper should live under a focused renderer chat module and be called from the existing render paths.

## Risks

The main risk is duplication between `trace_json.tools` and `content_blocks_json` tool blocks. The rule is:

- `content_blocks_json` is the ordered rendering source.
- `trace_json` remains compatibility metadata and reasoning storage.
- When blocks exist, render tools from blocks, not from `trace_json.tools`.

Another risk is visual clutter. Tool blocks should stay compact by default, reuse the existing collapsible trace row, and avoid expanding long outputs automatically.

The final risk is search and copy behavior. `body_md` must remain the plain text source for search, previews, notifications, history context, and full-message copy. Tool previews should be copied only through explicit tool row copy behavior if that is added later.

## Open Questions

No user decision is required before implementation. The first implementation should use conservative defaults:

- reasoning stays out of ordered visible blocks
- `body_md` remains the full text source
- desktop and web support ordered rendering first
- mobile falls back to `body_md`

If later product usage shows users want richer provenance, a second phase can add a user preference for visible reasoning placement or per-tool output copy.
