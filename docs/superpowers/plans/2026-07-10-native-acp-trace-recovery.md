# Native ACP Trace 恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 Hermes、Claude Code、Codex 本地 Native ACP 会话的真实实时 Trace 与完成后持久化 Trace。

**Architecture:** 在 Rust Native ACP 边界把 agent notification 统一成 Mia 既有规范事件；Cloud Bridge 对实际转发给 Renderer 的同一批规范事件做运行级收集，并用该收集结果完成持久化。Renderer 保持现有单一事件契约，不增加引擎别名分支。

**Tech Stack:** Rust、agent-client-protocol 0.12 schema、Axum/Core realtime、Electron renderer、Cargo test、Node test runner。

## Global Constraints

- 只保存引擎真实提供的 thinking、tool call、tool output 和 completion；不从最终正文生成 Trace。
- 不修改模型、effort、permission、会话恢复或 Mia Logo 行为。
- 实时 Trace 与持久化 Trace 必须来自同一批规范事件。
- Hermes 没有真实 Trace 事件时保持隐藏，有真实事件时不得被完成阶段清空。
- 未完成 Hermes、Claude Code、Codex 三引擎实测前不推送实现提交。

---

### Task 1: Native ACP 输出 Mia 规范 Trace 事件

**Files:**
- Modify: `crates/mia-core-runtime/src/native_acp.rs:8-23`
- Modify: `crates/mia-core-runtime/src/native_acp.rs:89-154`
- Test: `crates/mia-core-runtime/src/native_acp.rs:2180-2260`

**Interfaces:**
- Consumes: `SessionNotification`, `SessionUpdate`, `ToolCallStatus` from `agent_client_protocol::schema`.
- Produces: `runtime_events_from_session_notification(...) -> Vec<RuntimeProcessEvent>` with `message.delta`, `reasoning_delta`, `tool.started`, `tool.delta`, and `tool.completed` payloads.

- [ ] **Step 1: Write failing notification mapping tests**

Add tests using real ACP schema values:

```rust
#[test]
fn native_acp_translates_thought_chunk_to_reasoning_delta() {
    let notification = SessionNotification::new(
        "acp-session-1",
        SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
            TextContent::new("检查内存"),
        ))),
    );

    let events = runtime_events_from_session_notification(
        "turn_1", "conv_1", "codex", &notification,
    );

    assert_eq!(events[0].data["event"]["type"], "reasoning_delta");
    assert_eq!(events[0].data["event"]["text"], "检查内存");
}

#[test]
fn native_acp_translates_tool_lifecycle_to_canonical_trace_events() {
    let started = SessionNotification::new(
        "acp-session-1",
        SessionUpdate::ToolCall(
            ToolCall::new("tool_1", "读取内存")
                .status(ToolCallStatus::InProgress)
                .raw_input(json!({ "command": "vm_stat" })),
        ),
    );
    let completed = SessionNotification::new(
        "acp-session-1",
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "tool_1",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .raw_output(json!({ "stdout": "Pages free: 4050" })),
        )),
    );

    let start_events = runtime_events_from_session_notification(
        "turn_1", "conv_1", "codex", &started,
    );
    let completed_events = runtime_events_from_session_notification(
        "turn_1", "conv_1", "codex", &completed,
    );

    assert_eq!(start_events[0].data["event"]["type"], "tool.started");
    assert_eq!(start_events[0].data["event"]["id"], "tool_1");
    assert_eq!(start_events[0].data["event"]["name"], "读取内存");
    assert!(start_events[0].data["event"]["preview"].as_str().unwrap().contains("vm_stat"));
    assert_eq!(completed_events[0].data["event"]["type"], "tool.completed");
    assert_eq!(completed_events[0].data["event"]["status"], "completed");
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test -p mia-core-runtime native_acp_translates_
```

Expected: FAIL because current payloads are `thinking.delta`, `tool_call.started`, and `tool_call.updated`, and do not expose canonical top-level tool fields.

- [ ] **Step 3: Implement the minimal canonical mapper**

Import `ToolCall`, `ToolCallStatus`, `ToolCallUpdate`, and `ToolCallUpdateFields` for production/tests as needed. Replace the three non-canonical event payloads with helpers equivalent to:

```rust
fn tool_value_preview(value: Option<&Value>) -> String {
    value
        .filter(|value| !value.is_null())
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn tool_update_event_type(status: Option<ToolCallStatus>) -> &'static str {
    match status {
        Some(ToolCallStatus::Completed | ToolCallStatus::Failed) => "tool.completed",
        _ => "tool.delta",
    }
}
```

The emitted event object must carry `id`, `name` when advertised, `preview`, `status`, `error`, `sessionId`, and the original `toolCall` object. `AgentThoughtChunk` must emit `reasoning_delta`.

- [ ] **Step 4: Run the focused runtime tests and verify GREEN**

Run:

```bash
cargo test -p mia-core-runtime native_acp_translates_
```

Expected: all notification mapping tests PASS.

- [ ] **Step 5: Commit the canonical event contract**

```bash
git add crates/mia-core-runtime/src/native_acp.rs
git commit -m "fix(runtime): 统一 Native ACP Trace 事件"
```

---

### Task 2: Cloud Bridge 用实时规范事件生成持久化 Trace

**Files:**
- Modify: `crates/mia-core-app/src/cloud_bridge.rs:1-20`
- Modify: `crates/mia-core-app/src/cloud_bridge.rs:152-226`
- Modify: `crates/mia-core-app/src/cloud_bridge.rs:1070-1260`
- Test: `crates/mia-core-app/src/cloud_bridge.rs:1510-1585`

**Interfaces:**
- Consumes: canonical run event `Value` objects from `RuntimeProcessEvent.data.event`.
- Produces: one `RuntimeDisplayOutput` snapshot whose `text`, `trace`, and `content_blocks` are used by the response, Core message metadata, and Cloud bot message.

- [ ] **Step 1: Write a failing structured-event persistence test**

Add a test around `CloudRunCollector`:

```rust
#[test]
fn native_acp_structured_events_build_persistable_trace_and_ordered_blocks() {
    let mut collector = CloudRunCollector::default();
    collector.apply_run_event(&json!({
        "type": "reasoning_delta",
        "text": "检查内存"
    }));
    collector.apply_run_event(&json!({
        "type": "tool.started",
        "id": "tool_1",
        "name": "读取内存",
        "preview": "vm_stat"
    }));
    collector.apply_run_event(&json!({
        "type": "tool.completed",
        "id": "tool_1",
        "status": "completed",
        "preview": "Pages free: 4050"
    }));
    collector.apply_run_event(&json!({
        "type": "message.delta",
        "text": "内存正常。"
    }));

    let output = collector.display_output();

    assert_eq!(output.text, "内存正常。");
    assert_eq!(output.trace["reasoning"], "检查内存");
    assert_eq!(output.trace["tools"][0]["name"], "读取内存");
    assert_eq!(output.trace["tools"][0]["status"], "completed");
    assert_eq!(output.content_blocks[0]["type"], "thinking");
    assert_eq!(output.content_blocks[1]["type"], "tool");
    assert_eq!(output.content_blocks[2]["type"], "text");
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test -p mia-core-app native_acp_structured_events_build_persistable_trace_and_ordered_blocks
```

Expected: FAIL because `CloudRunCollector::display_output` does not exist and completion currently reconstructs output from stdout only.

- [ ] **Step 3: Add a collector snapshot method**

Implement:

```rust
impl CloudRunCollector {
    fn display_output(&self) -> RuntimeDisplayOutput {
        RuntimeDisplayOutput {
            text: self.text.trim().to_string(),
            trace: self.trace(),
            content_blocks: self.content_blocks(),
        }
    }
}
```

Update tool delta/completion lookup to match `id` before falling back to the latest tool, so interleaved tool calls update the correct row.

- [ ] **Step 4: Feed the realtime events into one run-level collector**

Create `Arc<StdMutex<CloudRunCollector>>` immediately before `RuntimeEventSink`. For every structured `run_event` that is emitted as `cloud_agent_run_event`, call:

```rust
if let Ok(mut collector) = trace_collector_for_sink.lock() {
    collector.apply_run_event(&run_event);
}
```

After `send_message` completes, snapshot the collector. Prefer its non-empty text, trace, and content blocks; only use `normalize_runtime_output(...)` as the existing fallback when the structured snapshot lacks that field.

- [ ] **Step 5: Run focused App tests and verify GREEN**

Run:

```bash
cargo test -p mia-core-app native_acp_structured_events_build_persistable_trace_and_ordered_blocks
cargo test -p mia-core-app cloud_run_collector
```

Expected: all collector and Cloud Bridge output tests PASS.

- [ ] **Step 6: Commit realtime/persistence unification**

```bash
git add crates/mia-core-app/src/cloud_bridge.rs
git commit -m "fix(agent): 持久化真实 Native ACP Trace"
```

---

### Task 3: Cross-boundary regression verification

**Files:**
- Modify: `tests/renderer-social.test.js:5700-5745`
- Verify: `src/renderer/social/social.js`
- Verify: `src/shared/assistant-content-blocks.js`
- Verify: `src/shared/trace-blocks.js`

**Interfaces:**
- Consumes: canonical events emitted by Rust Core.
- Produces: visible transient and persisted Trace rows without renderer engine aliases.

- [ ] **Step 1: Change the existing normalized Trace test to the exact Rust contract**

Change `renderConversationChat renders normalized cloud run trace blocks` so it feeds this exact
sequence through `handleCloudEvent`:

```js
[
  { type: "reasoning_delta", text: "检查内存" },
  { type: "tool.started", id: "tool_1", name: "读取内存", preview: "vm_stat" },
  { type: "tool.completed", id: "tool_1", status: "completed", preview: "Pages free: 4050" },
  { type: "message.delta", text: "内存正常。" }
]
```

Assert the active run contains reasoning plus the completed tool and that the rendered chat contains Trace rows. This replaces the test's `tool_call_started` and `tool_call_completed` aliases; it does not add a duplicate test.

- [ ] **Step 2: Run renderer Trace tests**

Run:

```bash
node --test tests/trace-blocks.test.js tests/renderer-social.test.js --test-name-pattern='trace|native ACP'
```

Expected: all selected tests PASS with no new engine-specific renderer branch.

- [ ] **Step 3: Run full source verification**

Run:

```bash
cargo fmt --all --check
cargo test --workspace
npm run check
npm test
git diff --check
```

Expected: every command exits 0; no failures.

- [ ] **Step 4: Rebuild and restart the development app**

Build the current Rust Core, gracefully stop only the Mia process started by this task, and run `npm start`. Do not kill unknown port owners or touch production/release artifacts.

- [ ] **Step 5: Perform the three-engine live matrix**

For Hermes, Claude Code, and Codex, send a prompt that requires a harmless observable local read-only tool call. Verify all of the following from the app and Core message endpoint:

```text
正文非空
运行中出现真实 Trace
完成后 Trace 仍显示
重新打开会话后 Trace 仍显示
Core message trace 非空
Core message contentBlocks 含 thinking/tool（仅限引擎真实提供）
模型仍为 Mia Auto
原有 effort/permission 控件状态不变
```

- [ ] **Step 6: Commit any test-only adjustment after live verification**

```bash
git add tests/renderer-social.test.js
git commit -m "test(agent): 覆盖 Native ACP Trace 显示"
```

Do not push any implementation commit until the user explicitly requests it after reviewing the verified result.
