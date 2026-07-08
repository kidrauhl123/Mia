# Rust Native ACP Session Runtime Design

Status: ready for user review.

## Context

The node-to-rust branch currently routes desktop-local bot turns through Rust
Core, but the local runtime path still behaves like a subprocess executor. In
practice `RuntimeSessionManager::send_message` delegates to
`RuntimeExecutor`, and Codex is prepared as `codex exec --json`. That shape can
only emit whatever the process writes to stdout/stderr. It does not own a
native agent session, cannot reliably preserve ACP session state, and cannot
produce AION-style token/tool/thinking/permission events as first-class runtime
events.

AION already solved this in Rust. Its ACP stack is not a command-output parser:

- `aionui-ai-agent/src/protocol/acp.rs` owns the ACP SDK connection.
- `aionui-ai-agent/src/manager/acp/*` owns session lifecycle.
- `aionui-ai-agent/src/task_manager.rs` serializes one task per conversation.
- `aionui-ai-agent/src/protocol/events/*` translates ACP updates into typed
  stream events.
- `aionui-conversation/src/stream_relay.rs` persists and broadcasts streamed
  runtime output.

The goal of Mia's Rust migration is to make this kind of reuse easier. The
target is therefore to reuse AION's Rust ACP/session implementation shape,
with a narrow Mia adapter layer, instead of re-creating the old Node prompt
adapter behavior in Rust.

## Decision

Mia will replace the desktop-local bot runtime path for Codex and Claude Code
with a Rust-native ACP session runtime modeled on AIONCore.

The runtime must be strict:

- no `codex exec --json` fallback for desktop-local bot conversations;
- no Claude stream-json prompt fallback for desktop-local bot conversations;
- no final-output-only fallback when ACP startup, session creation, or prompt
  dispatch fails;
- if the native ACP runtime is unavailable, the turn fails visibly and the
  failure is emitted through the normal runtime event path.

The first implementation should focus on Codex and Claude Code because those
are the engines involved in the current regression. Hermes and OpenClaw should
join the same Rust ACP manager after the first slice is stable, not through a
separate executor path.

## Reuse Source

Use the local AION references as the implementation source:

- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/protocol/acp.rs`
- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/protocol/events/`
- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/agent_task.rs`
- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/task_manager.rs`
- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/manager/acp/`
- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/factory/acp.rs`
- `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-conversation/src/stream_relay.rs`

Reuse means porting the mature Rust modules and preserving their state model,
not only copying launch command facts. Mia-specific changes should be adapter
code around identifiers, settings, persistence, event naming, and product
metadata.

AIONCore and AIONUi include Apache-2.0 license files in the checked-out
references, while AIONCore's Cargo workspace metadata currently says MIT.
Mia should keep an explicit attribution note for imported or adapted AION code
and avoid mixing copied source into unrelated commits.

## Architecture

### Runtime Crate Boundary

Add a Rust-native agent session module under Mia Core runtime. The module owns:

- ACP process launch;
- ACP initialize handshake;
- `session/new`, `session/load`, or `session/resume`;
- `session/prompt`;
- cancellation through the active ACP session;
- one task per `(conversationId, engine, workspaceDir, session fingerprint)`;
- broadcast of typed stream events.

`RuntimeExecutor` remains only for explicitly stateless utility commands or
mock tests. It must not be reachable from desktop-local Codex or Claude Code
bot turns.

### Task Manager

Port AION's task-manager pattern:

- a small `AgentTask` trait exposes `subscribe`, `send_message`, `cancel`,
  `kill`, status, workspace, and conversation id;
- a task manager gates construction per conversation so two quick sends cannot
  spawn two ACP processes;
- session ids live outside the prompt payload and are persisted through Core
  metadata.

This directly addresses the duplicate-response and lost-message class of bugs:
the runtime has one owner for the active turn and one native session for the
conversation.

### ACP Protocol

Port the AION ACP protocol layer around the Rust `agent-client-protocol` SDK.
The implementation should keep AION's concurrency rule: prompt requests await
their response while cancel can still be sent through the same shared
connection.

Engine launch specs should align with Mia's existing AION-derived specs:

- Claude Code: `npx -y @agentclientprotocol/claude-agent-acp@0.39.0`
- Codex: `npx -y @agentclientprotocol/codex-acp@1.1.0`

Mia may later switch to managed local artifacts, but that is an installation
choice. It does not change the runtime contract: bot turns use ACP sessions.

### Event Flow

ACP notifications become typed runtime events immediately:

- assistant text chunks;
- thinking chunks;
- tool call starts and updates;
- permission requests;
- plan and command updates;
- finish and error events;
- session assigned/session resumed events.

Core then maps those events to Mia's existing WebSocket surface:

- `cloud_agent_run_started`;
- `cloud_agent_run_event`;
- `conversation.runtimeStarted`;
- `conversation.runtimeStdout` or a successor typed runtime event;
- `conversation.runtimeFinished`;
- `conversation.messageCreated` only when persisted assistant content is
  finalized.

The renderer should see a busy/typing state as soon as the runtime accepts the
turn, and text/tool deltas as soon as ACP emits them. The UI must not need to
wait for the HTTP bridge call to return before showing progress.

### Persistence

The first slice can keep Mia's current conversation tables, but the ACP runtime
must persist enough metadata to resume safely:

- native ACP session id;
- engine id;
- workspace dir;
- session fingerprint;
- last known runtime status;
- terminal error summary when startup or prompt dispatch fails.

Assistant message persistence should be driven by the stream relay, not by
parsing final stdout after the child process exits.

### Error Handling

Native ACP failures are product-visible runtime failures:

- missing `npx`, ACP package, `codex`, or `claude` command;
- ACP initialize failure;
- `session/new` or resume failure;
- prompt failure;
- process exit before handshake or during prompt;
- cancellation.

None of these failures may call the legacy executor path. Tests should assert
that no Codex/Claude desktop-local bot run can assemble `codex exec --json` or
Claude `--output-format stream-json`.

## Migration Plan

### Slice 1: Guardrails

Add tests proving desktop-local Codex and Claude Code bot runtime plans do not
use `RuntimeExecutor`, `codex exec --json`, or Claude stream-json. These tests
should fail against the current code.

### Slice 2: ACP Protocol And Event Translation

Port the AION ACP protocol wrapper and event translation into Mia Rust Core.
Keep the port focused on the SDK connection, session methods, notification
translation, and permission request plumbing needed for Codex and Claude Code.

### Slice 3: Task Manager And Session Runtime

Port the AION task-manager shape and implement a Mia `NativeAcpSessionManager`.
This manager becomes the implementation behind `RuntimeSessionManager` for
desktop-local ACP engines.

### Slice 4: Cloud Bridge / Local Bot Integration

Replace the command-backed branch in `cloud_bridge.rs` for desktop-local ACP
engines with the native session manager. Runtime events should flow through
the same realtime bus before the HTTP response resolves.

### Slice 5: Renderer Verification

Verify that a sent message:

- stays in the selected visible conversation;
- does not create a blank conversation;
- shows typing/progress immediately;
- streams assistant text/tool/thinking updates;
- persists one user message and one assistant turn;
- survives restart with the persisted messages and session metadata.

### Slice 6: Extend To Hermes/OpenClaw

After Codex and Claude Code pass the native ACP path, fold Hermes and OpenClaw
into the same manager instead of keeping separate local executor or adapter
paths.

## Non-Goals

- Redesign the renderer chat UI.
- Replace all command execution in Mia Core.
- Implement a brand-new ACP protocol instead of using the Rust SDK.
- Keep compatibility with the old desktop-local prompt adapter behavior.
- Use the existing JavaScript AgentSession as the new runtime owner.

The JavaScript AgentSession implementation remains useful as behavior
reference and test history, but the runtime owner for this migration is Rust.

## Acceptance Criteria

- Desktop-local Codex and Claude Code bot sends use native Rust ACP sessions.
- `codex exec --json` is unreachable from desktop-local bot conversation sends.
- Claude stream-json prompt execution is unreachable from desktop-local bot
  conversation sends.
- If ACP startup or session creation fails, the user sees a runtime error
  event and the turn is not silently retried through another path.
- The renderer shows a streaming/busy state before the final assistant message.
- ACP text chunks appear incrementally when the backend emits them.
- One user send cannot create two active native sessions for the same
  conversation.
- Restart does not drop already persisted user messages.
- The implementation includes tests for no-fallback behavior, task build
  serialization, event translation, cancellation, and bridge integration.
