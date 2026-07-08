# Rust Native ACP Session Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace desktop-local Codex and Claude Code bot execution with a Rust-native ACP session runtime modeled on AIONCore, with no fallback to `codex exec --json` or Claude stream-json prompt execution.

**Architecture:** Mia Core keeps `RuntimeBuilder` as the turn-planning boundary, but each plan now declares a runtime protocol. Codex and Claude Code use `NativeAcp`; stateless utility commands keep `Process`; mock plans keep `Mock`. `RuntimeSessionManager` dispatches `NativeAcp` plans to a long-lived native ACP task manager, not to `RuntimeExecutor`. The native manager is ported from AION's `AcpProtocol`, `AcpAgentManager`, task manager, and event translation shape, then adapted to Mia's `RuntimeEventSink` and conversation persistence.

**Tech Stack:** Rust 2024, Tokio, Axum, existing Mia Core crates, Rust `agent-client-protocol` SDK, AIONCore Rust source under `/Users/jung/GitHub/mia-reference/AionCore`, existing Node test runner only for renderer/main regression checks.

## Global Constraints

- Desktop-local Codex bot sends must not assemble or execute `codex exec --json`.
- Desktop-local Claude Code bot sends must not assemble or execute `claude -p --output-format stream-json`.
- Runtime failures must fail closed through the runtime event path; no final-output-only fallback.
- Port AION Rust ACP/session code shape instead of routing through Mia's JavaScript AgentSession runtime.
- Keep `RuntimeExecutor` available only for mock, utility, and explicitly process-backed runtime plans.
- Write failing tests before production code for each behavior change.
- Commit after each completed task with a Chinese summary in the commit title.

---

## File Structure

- Modify: `crates/mia-core-runtime/src/lib.rs`
  - Add `RuntimeProtocol`.
  - Add native ACP command specs for Codex and Claude Code.
  - Route `RuntimeSessionManager` by protocol instead of always using `RuntimeExecutor`.
- Create: `crates/mia-core-runtime/src/native_acp.rs`
  - Mia-native ACP task manager, protocol wrapper, event translation, and test backend seam.
- Modify: `crates/mia-core-runtime/Cargo.toml`
  - Add `agent-client-protocol`, `tokio-util`, `async-trait`, `dashmap`, `thiserror`, and `tracing` for the AION protocol/task-manager port.
- Modify: `crates/mia-core-app/src/services.rs`
  - Construct one shared runtime session manager for app lifetime.
- Modify: `crates/mia-core-app/src/router/state.rs`
  - Expose the shared runtime session manager to routes.
- Modify: `crates/mia-core-app/src/cloud_bridge.rs`
  - Remove desktop-local Codex/Claude command mutation that forces exec/stream-json.
  - Map native ACP events to `cloud_agent_run_event` and conversation runtime events.
- Modify: `crates/mia-core-app/src/router/conversation.rs`
  - Use the shared runtime session manager for runtime turns.
- Modify: `crates/mia-core-app/src/router/routes.rs`
  - Update Rust structure checks so `RuntimeSessionManager` is the only runtime execution entry for conversations and bridge sends.
- Test: `crates/mia-core-runtime/src/lib.rs`
  - Unit tests for no-fallback planning, protocol dispatch, task serialization, cancellation, and event translation.
- Test: `crates/mia-core-app/src/router/routes.rs`
  - Integration tests for cloud bridge no-fallback behavior and event flow.

---

### Task 1: Add No-Fallback Runtime Guardrail Tests

**Files:**
- Modify: `crates/mia-core-runtime/src/lib.rs`
- Modify: `crates/mia-core-app/src/router/routes.rs`

**Interfaces:**
- Consumes: existing `RuntimeBuilder`, `RuntimeSessionManager`, `RuntimeTurnPlan`, `RuntimeCommand`.
- Produces: failing tests that describe the target no-fallback behavior.

- [ ] **Step 1: Replace the old command-mapping assertion with native ACP expectations**

In `crates/mia-core-runtime/src/lib.rs`, replace the current
`runtime_builder_maps_known_external_engines_to_commands` test with:

```rust
#[test]
fn runtime_builder_maps_codex_and_claude_to_native_acp_specs() {
    let builder = RuntimeBuilder::new("/tmp/mia-workspace");
    let codex_plan = builder.build_turn_plan(RuntimeTurnInput {
        conversation_id: "conv_1".into(),
        message_id: "msg_1".into(),
        bot_id: None,
        engine: Some("codex".into()),
        previous_session_key: None,
        workspace_dir: "/tmp/custom".into(),
        provider: json!({}),
        mcp_servers: json!({}),
        attachments: json!([]),
        selected_skill_ids: vec![],
        body: "hello".into(),
    });

    assert_eq!(codex_plan.protocol, RuntimeProtocol::NativeAcp);
    let codex_command = codex_plan.command.as_ref().expect("codex ACP command");
    assert_eq!(codex_command.program, "npx");
    assert_eq!(codex_command.args, vec!["-y", "@agentclientprotocol/codex-acp@1.1.0"]);
    assert!(!codex_command.args.iter().any(|arg| arg == "exec" || arg == "--json"));
    assert_eq!(codex_plan.workspace_dir, "/tmp/custom");
    assert_eq!(codex_plan.mock_response, None);

    let claude_plan = builder.build_turn_plan(RuntimeTurnInput {
        conversation_id: "conv_2".into(),
        message_id: "msg_2".into(),
        bot_id: None,
        engine: Some("claude-code".into()),
        previous_session_key: None,
        workspace_dir: "".into(),
        provider: json!({}),
        mcp_servers: json!({}),
        attachments: json!([]),
        selected_skill_ids: vec![],
        body: "hello".into(),
    });
    assert_eq!(claude_plan.protocol, RuntimeProtocol::NativeAcp);
    let claude_command = claude_plan.command.as_ref().expect("claude ACP command");
    assert_eq!(claude_command.program, "npx");
    assert_eq!(claude_command.args, vec!["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"]);
    assert!(!claude_command.args.iter().any(|arg| arg == "-p" || arg == "--output-format" || arg == "stream-json"));

    let hermes_plan = builder.build_turn_plan(RuntimeTurnInput {
        conversation_id: "conv_3".into(),
        message_id: "msg_3".into(),
        bot_id: None,
        engine: Some("hermes".into()),
        previous_session_key: None,
        workspace_dir: "".into(),
        provider: json!({}),
        mcp_servers: json!({}),
        attachments: json!([]),
        selected_skill_ids: vec![],
        body: "hello".into(),
    });
    assert_eq!(hermes_plan.protocol, RuntimeProtocol::Process);
    let hermes_command = hermes_plan.command.unwrap();
    assert_eq!(hermes_command.program, "hermes");
}
```

- [ ] **Step 2: Add a dispatch test proving NativeAcp does not enter `RuntimeExecutor`**

Add this test near `runtime_session_manager_sends_runtime_plan_via_send_message_boundary`:

```rust
#[tokio::test]
async fn runtime_session_manager_rejects_native_acp_without_backend_instead_of_executor_fallback() {
    let mut plan = test_plan(shell_command("printf 'executor fallback used\\n'"));
    plan.engine = "codex".into();
    plan.protocol = RuntimeProtocol::NativeAcp;
    plan.send_message.content = "hello native acp".into();

    let result = RuntimeSessionManager::new_without_native_acp_for_tests()
        .send_message(plan, RuntimeEventSink::default(), None)
        .await
        .unwrap_err();

    assert!(result.to_string().contains("native ACP runtime is unavailable"));
}
```

- [ ] **Step 3: Update structure checks for forbidden command shaping**

In `crates/mia-core-app/src/router/routes.rs`, add a structure test that reads
`src/cloud_bridge.rs` and asserts it no longer calls:

```rust
assert!(
    !source.contains("ensure_codex_exec_json_args"),
    "cloud bridge must not force Codex exec/json fallback for desktop-local bot sends"
);
assert!(
    !source.contains("ensure_claude_print_stream_args"),
    "cloud bridge must not force Claude print stream-json fallback for desktop-local bot sends"
);
```

- [ ] **Step 4: Run the focused failing tests**

Run:

```bash
cargo test -p mia-core-runtime runtime_builder_maps_codex_and_claude_to_native_acp_specs runtime_session_manager_rejects_native_acp_without_backend_instead_of_executor_fallback
cargo test -p mia-core-app cloud_bridge
```

Expected: fail because `RuntimeProtocol` and `new_without_native_acp_for_tests` do not exist yet, and cloud bridge still contains exec/stream-json helpers.

---

### Task 2: Add Runtime Protocol Planning

**Files:**
- Modify: `crates/mia-core-runtime/src/lib.rs`

**Interfaces:**
- Produces: `RuntimeProtocol`, `RuntimeTurnPlan.protocol`, native ACP command specs.
- Consumes: tests from Task 1.

- [ ] **Step 1: Add the protocol enum**

Add near `RuntimeCommand`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeProtocol {
    Mock,
    Process,
    NativeAcp,
}
```

- [ ] **Step 2: Add the field to `RuntimeTurnPlan`**

Add this field before `command`:

```rust
pub protocol: RuntimeProtocol,
```

- [ ] **Step 3: Set protocol in `RuntimeBuilder::build_turn_plan`**

Replace the current command/protocol calculation with:

```rust
let protocol = protocol_for_engine(&engine);
let command = self
    .command_overrides
    .get(&engine)
    .cloned()
    .or_else(|| command_for_engine(&engine));
let protocol = if command.is_none() { RuntimeProtocol::Mock } else { protocol };
```

Set `protocol` in the `RuntimeTurnPlan` initializer.

- [ ] **Step 4: Add protocol helpers**

Replace the Codex and Claude arms in `command_for_engine` with ACP specs:

```rust
fn protocol_for_engine(engine: &str) -> RuntimeProtocol {
    match engine {
        "codex" | "claude-code" => RuntimeProtocol::NativeAcp,
        "mock" | "mock-agent" | "mia-mock" => RuntimeProtocol::Mock,
        _ => RuntimeProtocol::Process,
    }
}

fn command_for_engine(engine: &str) -> Option<RuntimeCommand> {
    match engine {
        "mock" | "mock-agent" | "mia-mock" => None,
        "codex" => Some(RuntimeCommand {
            program: "npx".into(),
            args: vec!["-y".into(), "@agentclientprotocol/codex-acp@1.1.0".into()],
        }),
        "claude-code" => Some(RuntimeCommand {
            program: "npx".into(),
            args: vec!["-y".into(), "@agentclientprotocol/claude-agent-acp@0.39.0".into()],
        }),
        "hermes" => Some(RuntimeCommand {
            program: "hermes".into(),
            args: vec![],
        }),
        other => Some(RuntimeCommand {
            program: other.to_string(),
            args: vec![],
        }),
    }
}
```

- [ ] **Step 5: Keep process-only prompt mutation out of native ACP**

Update `prepare_command_input`:

```rust
fn prepare_command_input(plan: &RuntimeTurnPlan, command: &mut RuntimeCommand) -> String {
    let input = plan.send_message.content.clone();
    if plan.protocol == RuntimeProtocol::NativeAcp {
        input
    } else if plan.engine == "hermes" && !input.is_empty() {
        prepare_hermes_oneshot_command(plan, command, &input);
        String::new()
    } else {
        input
    }
}
```

Delete `prepare_codex_exec_command` and `model_arg_for_codex` after no callsites remain.

- [ ] **Step 6: Update test helper initializers**

Every `RuntimeTurnPlan` literal in tests must include:

```rust
protocol: RuntimeProtocol::Process,
```

Use `RuntimeProtocol::Mock` only for mock plans.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cargo test -p mia-core-runtime runtime_builder_maps_codex_and_claude_to_native_acp_specs
```

Expected: pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add crates/mia-core-runtime/src/lib.rs
git commit -m "runtime: 标记本地 Codex Claude 为原生 ACP"
```

---

### Task 3: Add Fail-Closed Native ACP Dispatch Boundary

**Files:**
- Create: `crates/mia-core-runtime/src/native_acp.rs`
- Modify: `crates/mia-core-runtime/src/lib.rs`

**Interfaces:**
- Produces: `NativeAcpSessionManager`, `NativeAcpBackend`, `RuntimeSessionManager::new_without_native_acp_for_tests`.
- Consumes: `RuntimeTurnPlan`, `RuntimeEventSink`, `RuntimeCancellation`, `RuntimeExecutionResult`.

- [ ] **Step 1: Create the native ACP module**

Create `crates/mia-core-runtime/src/native_acp.rs`:

```rust
use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::json;

use crate::{
    RuntimeCancellation, RuntimeEventSink, RuntimeExecutionResult, RuntimeTurnPlan,
    EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STARTED,
};

#[async_trait]
pub trait NativeAcpBackend: Send + Sync {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult>;
}

#[derive(Clone)]
pub struct NativeAcpSessionManager {
    backend: Arc<dyn NativeAcpBackend>,
}

impl std::fmt::Debug for NativeAcpSessionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("NativeAcpSessionManager").finish_non_exhaustive()
    }
}

impl NativeAcpSessionManager {
    pub fn unavailable() -> Self {
        Self {
            backend: Arc::new(UnavailableNativeAcpBackend),
        }
    }

    pub fn with_backend_for_tests(backend: Arc<dyn NativeAcpBackend>) -> Self {
        Self { backend }
    }

    pub async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        self.backend.send_message(plan, sink, cancellation).await
    }
}

struct UnavailableNativeAcpBackend;

#[async_trait]
impl NativeAcpBackend for UnavailableNativeAcpBackend {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        _cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        sink.emit(
            EVENT_RUNTIME_STARTED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "protocol": "nativeAcp",
            }),
        );
        sink.emit(
            EVENT_RUNTIME_FINISHED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "exitCode": null,
                "cancelled": false,
                "ok": false,
                "error": "native ACP runtime is unavailable",
            }),
        );
        Err(anyhow!("native ACP runtime is unavailable"))
    }
}
```

- [ ] **Step 2: Wire `RuntimeSessionManager` dispatch**

In `crates/mia-core-runtime/src/lib.rs`, add:

```rust
mod native_acp;

pub use native_acp::{NativeAcpBackend, NativeAcpSessionManager};
```

Change `RuntimeSessionManager`:

```rust
#[derive(Debug, Clone)]
pub struct RuntimeSessionManager {
    executor: RuntimeExecutor,
    native_acp: NativeAcpSessionManager,
}

impl Default for RuntimeSessionManager {
    fn default() -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp: NativeAcpSessionManager::unavailable(),
        }
    }
}

impl RuntimeSessionManager {
    pub fn new(native_acp: NativeAcpSessionManager) -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp,
        }
    }

    pub fn new_without_native_acp_for_tests() -> Self {
        Self::default()
    }

    pub async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> anyhow::Result<RuntimeExecutionResult> {
        match plan.protocol {
            RuntimeProtocol::NativeAcp => self.native_acp.send_message(plan, sink, cancellation).await,
            RuntimeProtocol::Mock | RuntimeProtocol::Process => {
                self.executor.execute_plan(plan, sink, cancellation).await
            }
        }
    }
}
```

- [ ] **Step 3: Add a test backend success path**

Add a test in `crates/mia-core-runtime/src/lib.rs`:

```rust
#[tokio::test]
async fn runtime_session_manager_dispatches_native_acp_to_backend() {
    struct RecordingBackend;

    #[async_trait::async_trait]
    impl NativeAcpBackend for RecordingBackend {
        async fn send_message(
            &self,
            plan: RuntimeTurnPlan,
            sink: RuntimeEventSink,
            _cancellation: Option<RuntimeCancellation>,
        ) -> anyhow::Result<RuntimeExecutionResult> {
            sink.emit(EVENT_RUNTIME_STDOUT, json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "text": "native delta",
            }));
            Ok(RuntimeExecutionResult {
                exit_code: Some(0),
                cancelled: false,
                stdout: "native final".into(),
                stderr: String::new(),
            })
        }
    }

    let mut plan = test_plan(shell_command("printf 'executor fallback used\\n'"));
    plan.protocol = RuntimeProtocol::NativeAcp;
    plan.engine = "codex".into();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        RuntimeEventSink::new(move |event| events.lock().unwrap().push(event))
    };

    let result = RuntimeSessionManager::new(NativeAcpSessionManager::with_backend_for_tests(
        std::sync::Arc::new(RecordingBackend),
    ))
    .send_message(plan, sink, None)
    .await
    .unwrap();

    assert_eq!(result.stdout, "native final");
    assert!(events.lock().unwrap().iter().any(|event| {
        event.name == EVENT_RUNTIME_STDOUT && event.data["text"] == "native delta"
    }));
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
cargo test -p mia-core-runtime runtime_session_manager_rejects_native_acp_without_backend_instead_of_executor_fallback runtime_session_manager_dispatches_native_acp_to_backend
```

Expected: pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add crates/mia-core-runtime/src/lib.rs crates/mia-core-runtime/src/native_acp.rs crates/mia-core-runtime/Cargo.toml
git commit -m "runtime: 增加原生 ACP 运行时边界"
```

---

### Task 4: Remove Bridge Command Fallback Mutation

**Files:**
- Modify: `crates/mia-core-app/src/cloud_bridge.rs`
- Modify: `crates/mia-core-app/src/router/routes.rs`

**Interfaces:**
- Consumes: `RuntimeTurnPlan.protocol`.
- Produces: bridge preparation that configures provider environment without changing Codex/Claude into exec/stream-json commands.

- [ ] **Step 1: Write failing bridge structure test**

Use the Task 1 structure test in `routes.rs` to assert `cloud_bridge.rs` does
not contain `ensure_codex_exec_json_args` or `ensure_claude_print_stream_args`.

- [ ] **Step 2: Replace command mutation helpers with native ACP environment helpers**

In `prepare_claude_code_mia_runtime`, delete the call:

```rust
if let Some(command) = &mut plan.command {
    ensure_claude_print_stream_args(command, runtime_config);
}
```

In `prepare_codex_mia_runtime`, delete the call:

```rust
if let Some(command) = &mut plan.command {
    ensure_codex_exec_json_args(command, runtime_config, &model, &proxy.base_url);
}
```

Delete `ensure_claude_print_stream_args`, `ensure_codex_exec_json_args`, and
`append_codex_config_override` after no callsites remain.

- [ ] **Step 3: Preserve provider configuration through environment**

Keep `ANTHROPIC_*` environment for Claude Code and `CODEX_API_KEY` for Codex.
For Codex, add native ACP-compatible env entries instead of CLI `-c` flags:

```rust
plan.environment.insert("OPENAI_BASE_URL".into(), proxy.base_url.clone());
plan.environment.insert("CODEX_MODEL".into(), model.clone());
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
cargo test -p mia-core-app cloud_bridge
```

Expected: pass for no-fallback structure checks.

- [ ] **Step 5: Commit**

Run:

```bash
git add crates/mia-core-app/src/cloud_bridge.rs crates/mia-core-app/src/router/routes.rs
git commit -m "bridge: 移除本地 ACP 的命令回退改写"
```

---

### Task 5: Port AION ACP Protocol And Event Translation

**Files:**
- Modify: `crates/mia-core-runtime/Cargo.toml`
- Modify: `crates/mia-core-runtime/src/native_acp.rs`

**Interfaces:**
- Consumes: AION `AcpProtocol` and event translation source files.
- Produces: real `NativeAcpBackend` that launches ACP command specs and emits Mia runtime events incrementally.

- [ ] **Step 1: Add Rust dependencies**

Add to `crates/mia-core-runtime/Cargo.toml`:

```toml
async-trait.workspace = true
dashmap.workspace = true
thiserror.workspace = true
tracing.workspace = true
agent-client-protocol = { version = "0.11.1", features = ["unstable_session_model", "unstable_session_close", "unstable_session_usage", "unstable_session_fork", "unstable_session_additional_directories", "unstable_session_resume"] }
tokio-util = { version = "0.7", features = ["compat"] }
```

Add missing workspace dependencies in the root `Cargo.toml` when Cargo reports
they are absent.

- [ ] **Step 2: Port protocol connection shape**

Port the connection structure from AION
`aionui-ai-agent/src/protocol/acp.rs` into `native_acp.rs` with Mia names:

```rust
struct AcpProtocol {
    connection: agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    alive: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
```

Keep AION's `connect`, `new_session`, `load_session`, `resume_session`,
`prompt`, and `cancel` method shape. Use `RuntimeEventSink` instead of AION's
broadcast channel for the first Mia slice.

- [ ] **Step 3: Port session notification translation**

Port the AION event mappings from
`aionui-ai-agent/src/protocol/events/translate.rs`:

```rust
SessionUpdate::AgentMessageChunk -> EVENT_RUNTIME_STDOUT with {"event":{"type":"message.delta","text":...}}
SessionUpdate::AgentThoughtChunk -> EVENT_RUNTIME_STDOUT with {"event":{"type":"thinking.delta","text":...}}
SessionUpdate::ToolCall -> EVENT_RUNTIME_STDOUT with {"event":{"type":"tool_call.started",...}}
SessionUpdate::ToolCallUpdate -> EVENT_RUNTIME_STDOUT with {"event":{"type":"tool_call.updated",...}}
SessionUpdate::Plan -> EVENT_RUNTIME_STDOUT with {"event":{"type":"plan.updated",...}}
```

Emit `EVENT_RUNTIME_STDOUT` data containing `turnId`, `conversationId`,
`engine`, and a JSON `event` object. Keep text chunks also mirrored as `text`
for existing cloud bridge mapping.

- [ ] **Step 4: Implement session manager backend**

Implement `RealNativeAcpBackend`:

```rust
#[derive(Debug, Default)]
pub struct RealNativeAcpBackend {
    tasks: dashmap::DashMap<String, std::sync::Arc<tokio::sync::Mutex<NativeAcpTask>>>,
}
```

Task key:

```rust
format!(
    "{}:{}:{}",
    plan.engine,
    plan.conversation_id,
    plan.workspace_dir
)
```

Each `NativeAcpTask` owns one spawned ACP process, one `AcpProtocol`, and the
current native session id. `send_message` must:

1. create or reuse the task;
2. open or resume the native session;
3. emit `EVENT_RUNTIME_STARTED`;
4. send `session/prompt`;
5. stream notifications through `RuntimeEventSink`;
6. emit `EVENT_RUNTIME_FINISHED`;
7. return `RuntimeExecutionResult` with accumulated assistant text.

- [ ] **Step 5: Cancellation**

Wire `RuntimeCancellation` so cancellation calls ACP `session/cancel` before
killing the process. If cancellation wins, return:

```rust
RuntimeExecutionResult {
    exit_code: None,
    cancelled: true,
    stdout: accumulated_text,
    stderr: String::new(),
}
```

- [ ] **Step 6: Run focused runtime tests**

Run:

```bash
cargo test -p mia-core-runtime native_acp
cargo test -p mia-core-runtime runtime_session_manager
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add Cargo.toml Cargo.lock crates/mia-core-runtime/Cargo.toml crates/mia-core-runtime/src/native_acp.rs crates/mia-core-runtime/src/lib.rs
git commit -m "runtime: 移植 AION 原生 ACP 会话事件流"
```

---

### Task 6: Use Shared Native Session Manager In App Runtime Calls

**Files:**
- Modify: `crates/mia-core-app/src/services.rs`
- Modify: `crates/mia-core-app/src/router/state.rs`
- Modify: `crates/mia-core-app/src/cloud_bridge.rs`
- Modify: `crates/mia-core-app/src/router/conversation.rs`

**Interfaces:**
- Consumes: `RuntimeSessionManager::new(NativeAcpSessionManager::real())`.
- Produces: app-lifetime native ACP sessions instead of per-call default managers.

- [ ] **Step 1: Add shared manager to services**

Add `runtime_sessions: RuntimeSessionManager` to `AppServices` and
`ModuleStates`. Construct it once in `AppServices::from_database`:

```rust
let runtime_sessions = RuntimeSessionManager::native_acp();
```

- [ ] **Step 2: Use the shared manager in cloud bridge**

Add `runtime_sessions: RuntimeSessionManager` to `AppCloudBridgeRunner` and use
that field instead of `RuntimeSessionManager::default()`.

- [ ] **Step 3: Use the shared manager in conversation runtime turns**

Replace `RuntimeSessionManager::default()` in `router/conversation.rs` with
`states.runtime_sessions.clone()`.

- [ ] **Step 4: Run app tests**

Run:

```bash
cargo test -p mia-core-app cloud_bridge conversation_runtime
```

Expected: pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add crates/mia-core-app/src/services.rs crates/mia-core-app/src/router/state.rs crates/mia-core-app/src/cloud_bridge.rs crates/mia-core-app/src/router/conversation.rs
git commit -m "app: 复用原生 ACP 会话管理器"
```

---

### Task 7: Verify Renderer Streaming Contract

**Files:**
- Modify: `tests/renderer-social.test.js` only if event shape needs a compatibility assertion.
- Modify: `src/renderer/social/social.js` only if the Rust ACP event shape requires a small adapter update.

**Interfaces:**
- Consumes: `cloud_agent_run_event` with `message.delta`, `thinking.delta`, tool events, and `run.completed`.
- Produces: renderer-visible typing and streaming for native ACP events.

- [ ] **Step 1: Add renderer regression if missing**

Add a test that feeds:

```js
{ type: "cloud_agent_run_event", event: { type: "message.delta", text: "你" } }
{ type: "cloud_agent_run_event", event: { type: "message.delta", text: "好" } }
```

and asserts the active streaming row shows `你好` before final completion.

- [ ] **Step 2: Run renderer tests**

Run:

```bash
node --test tests/renderer-social.test.js
```

Expected: pass.

- [ ] **Step 3: Commit**

Run:

```bash
git add src/renderer/social/social.js tests/renderer-social.test.js
git commit -m "renderer: 验证原生 ACP 流式事件显示"
```

---

### Task 8: Final Verification And Push

**Files:**
- No new files unless verification reveals a regression.

**Interfaces:**
- Consumes: completed tasks.
- Produces: pushed branch.

- [ ] **Step 1: Run focused verification**

Run:

```bash
cargo test -p mia-core-runtime
cargo test -p mia-core-app cloud_bridge
node --test tests/renderer-social.test.js
npm run check
```

- [ ] **Step 2: Run full JS test suite if focused checks pass**

Run:

```bash
npm test
```

- [ ] **Step 3: Push current branch**

Run:

```bash
git push
```
