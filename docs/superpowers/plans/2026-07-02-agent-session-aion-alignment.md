# Agent Session AION Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mia's per-engine prompt adapters with an AION-aligned AgentSession runtime for Claude Code, Codex, Hermes, and OpenClaw, so bot conversations talk to native agent sessions instead of replaying visible chat history through prompt-shaped calls.

**Architecture:** One conversation-scoped AgentSession manager owns native engine sessions and exposes a single runtime contract: build or reuse a session, send user input, receive normalized events, cancel active work, and close idle sessions. External engines run through ACP where possible, matching AION's model: Hermes is an ACP agent (`hermes acp`), Claude Code is the Claude ACP wrapper, Codex is the Codex ACP wrapper, and OpenClaw uses its ACP path. Legacy direct prompt adapters are removed from bot conversation execution.

**Tech Stack:** Electron main process, Node.js, existing `@agentclientprotocol/sdk`, child process stdio transports, Vitest/Node test runner style used in `tests/*.test.js`, existing Mia renderer/social stores.

## Global Constraints

- Do not keep the legacy Hermes HTTP run/messages path as a bot conversation path.
- Do not replay Mia's visible conversation history into prompt payloads for AgentSession engines. Mia keeps visible history for UI/storage; the native agent session owns agent context.
- Do not route Claude Code bot conversations through `@anthropic-ai/claude-agent-sdk` `query({ prompt })`.
- Do not route Codex bot conversations through `runCodexAppServerTurn({ prompt })`.
- Do not block user input in the renderer just because a conversation is busy. Busy input must be accepted by Mia and queued or steered by the AgentSession runtime according to engine capability.
- Preserve one native engine session per `(conversationId, engineId, workspacePath)` unless the user explicitly starts a new conversation or the runtime closes an idle finished session.
- Use AION code as the alignment source, especially:
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-db/migrations/001_initial_schema.sql`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-db/migrations/008_builtin_acp_agents_use_npx.sql`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/session_context.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/factory/mod.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/factory/acp.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/agent_task.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/task_manager.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/protocol/acp.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/manager/acp/agent.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-ai-agent/src/manager/aionrs/agent.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-conversation/src/service.rs`
  - `/Users/jung/GitHub/mia-reference/AionCore/crates/aionui-conversation/src/turn_orchestrator.rs`
- Write failing tests before each implementation step that changes behavior.
- Delete tests that only prove the old prompt-replay behavior after replacement tests exist.

---

## AION Code Facts To Preserve

AION does not model Hermes as a special HTTP chat service. It seeds Hermes as a built-in ACP agent:

```sql
('55f3ed1c', '/api/assets/logos/brand/hermes.svg', 'Hermes',
 'hermes', 'acp', 'builtin', '{"binary_name":"hermes"}',
 1, 'hermes', '["acp"]', '[]',
 NULL,
 '{"supports_side_question":false}',
 'yolo', 3130, ...)
```

AION models Claude Code and Codex as ACP agents too. The later migration updates the command specs to:

```sql
UPDATE aiagent
SET launch_config_json = '{"command":"npx","args":["-y","@agentclientprotocol/claude-agent-acp@0.39.0"]}'
WHERE backend = 'claude' AND agent_type = 'acp';

UPDATE aiagent
SET launch_config_json = '{"command":"npx","args":["-y","@agentclientprotocol/codex-acp@1.1.0"]}'
WHERE backend = 'codex' AND agent_type = 'acp';
```

AION's session factory has two runtime kinds only:

```rust
pub enum AgentSessionKind {
    Acp(Box<AcpSessionBuildContext>),
    Aionrs(Box<AionrsSessionBuildContext>),
}
```

Mia should mirror that shape in JavaScript as one `AgentSession` contract plus ACP-backed engine definitions. Mia does not need a separate special case for Hermes, Claude prompt calls, or Codex prompt calls in the bot conversation path.

AION's common task contract is deliberately small:

```rust
pub trait IAgentTask {
    fn agent_type(&self) -> AgentType;
    fn conversation_id(&self) -> Option<String>;
    fn workspace(&self) -> Option<PathBuf>;
    fn status(&self) -> TaskStatus;
    fn last_activity_at(&self) -> Instant;
    fn subscribe(&self) -> broadcast::Receiver<AgentEvent>;
    async fn send_message(&self, message: AgentMessage) -> Result<()>;
    async fn cancel(&self) -> Result<()>;
    async fn kill(&self);
}
```

Mia's first contract must stay equivalently narrow. Engine-specific functions are allowed behind engine adapters, not on the social conversation flow.

AION also serializes task construction per conversation with an `OnceCell` build gate. Mia needs the same property so two fast user sends do not spawn two native ACP processes for the same conversation.

---

## Current Mia Paths To Replace

- `src/main/claude-code-chat-adapter.js`
  - Current bot path calls `query({ prompt })`.
  - Replacement: no bot conversation execution through this file.
- `src/main/codex-chat-adapter.js`
  - Current bot path calls `runCodexAppServerTurn({ prompt })`.
  - Replacement: no bot conversation execution through this file.
- `src/main/hermes-chat-adapter.js`
  - Current bot path builds `runMessages = [{ system }, ...sanitizedMessages]`.
  - Replacement: remove from bot conversation execution and delete the Hermes HTTP adapter after callsites are migrated.
- `src/main/hermes-run-service.js`
  - Current run/messages service for Hermes HTTP.
  - Replacement: delete after tests prove no callsites remain.
- `src/main/openclaw-chat-adapter.js`
  - Current path is already ACP-like but is shaped as a separate chat adapter.
  - Replacement: move the shared ACP mechanics into the AgentSession runtime and keep OpenClaw as an engine spec.
- `src/main/agent-prompt-messages.js`
  - Current native-session helper strips visible history for some engines but Hermes still bypasses that policy.
  - Replacement: AgentSession runtime owns history policy; this helper is removed from bot conversation execution.
- `src/main/bot-execution-core.js`
  - Current interactive run uses one abort controller and engine-specific chat adapters.
  - Replacement: interactive bot conversation calls `agentSessionManager.sendUserInput(...)`.
- `src/main/social/local-bot-responder.js`
  - Current queue is local to invocation flow and still eventually calls old `sendChat`.
  - Replacement: conversation queue/steer logic moves to AgentSession manager.
- `src/renderer/app.js`
  - Current submit path returns when `isActiveConversationBusy()` is true.
  - Replacement: submit always persists/sends user input; busy state controls UI affordances, not message acceptance.
- `src/renderer/social/social.js`
  - Current `sendInActiveConversation()` returns `409 CONVERSATION_RUN_IN_PROGRESS`.
  - Replacement: returns accepted status with queued/steer metadata.

---

## Target File Structure

Add:

- `src/main/agent-session/agent-session-contract.js`
- `src/main/agent-session/agent-session-manager.js`
- `src/main/agent-session/acp-engine-specs.js`
- `src/main/agent-session/acp-agent-session.js`
- `src/main/agent-session/acp-event-normalizer.js`
- `src/main/agent-session/native-input-policy.js`
- `src/main/agent-session/index.js`
- `tests/agent-session-contract.test.js`
- `tests/agent-session-manager.test.js`
- `tests/acp-engine-specs.test.js`
- `tests/acp-agent-session.test.js`
- `tests/native-input-policy.test.js`

Modify:

- `src/main/bot-execution-core.js`
- `src/main/social/local-bot-responder.js`
- `src/main/social/ipc-handlers.js`
- `src/renderer/app.js`
- `src/renderer/social/social.js`
- `src/main/engine-catalog-service.js`
- `src/main/local-agent-engine-service.js`
- `src/main/mia-core-engines.js`
- `src/main.js`
- `tests/bot-execution-core.test.js`
- `tests/local-bot-responder.test.js`
- `tests/renderer-social.test.js`
- `tests/mia-core-engines.test.js`
- `tests/project-structure-check.test.js`

Delete after all callsites are gone:

- `src/main/hermes-chat-adapter.js`
- `src/main/hermes-run-service.js`
- Bot-conversation exports from `src/main/claude-code-chat-adapter.js`
- Bot-conversation exports from `src/main/codex-chat-adapter.js`
- Bot-conversation exports from `src/main/openclaw-chat-adapter.js`
- Tests that only assert old prompt replay:
  - `tests/hermes-chat-adapter.test.js`
  - old bot-conversation sections in `tests/claude-code-chat-adapter.test.js`
  - old bot-conversation sections in `tests/codex-chat-adapter.test.js`
  - old bot-conversation sections in `tests/openclaw-chat-adapter.test.js`

---

## Implementation Tasks

### 1. Capture The New Engine Contract In Tests

- [ ] Add `tests/agent-session-contract.test.js`.
- [ ] Assert the only supported bot conversation engine contract is `AgentSession`.
- [ ] Assert the four engine IDs are present and normalized:
  - `claude`
  - `codex`
  - `hermes`
  - `openclaw`
- [ ] Assert each engine exposes:
  - `engineId`
  - `transport: "acp"`
  - `displayName`
  - `supportsNativeSession: true`
  - `supportsQueuedInput`
  - `supportsSteerInput`
- [ ] Assert the runtime event kinds are limited to:
  - `session-started`
  - `message-started`
  - `assistant-delta`
  - `tool-call-started`
  - `tool-call-delta`
  - `tool-call-completed`
  - `message-completed`
  - `message-cancelled`
  - `message-failed`
  - `permission-requested`
  - `session-closed`
- [ ] Assert `createAgentSessionKey({ conversationId, engineId, workspacePath })` returns a stable key and rejects missing values.
- [ ] Run the focused test and confirm it fails:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/agent-session-contract.test.js
```

### 2. Implement The Narrow AgentSession Contract

- [ ] Add `src/main/agent-session/agent-session-contract.js`.
- [ ] Export immutable `ENGINE_IDS`, `AGENT_SESSION_EVENT_KINDS`, `AGENT_SESSION_STATUS`, `createAgentSessionKey`, `assertKnownAgentEngine`, and `createAcceptedInputResult`.
- [ ] Use CommonJS exports to match existing main-process files.
- [ ] Do not import engine-specific adapter files from this contract module.
- [ ] Implement accepted input results with these shapes:

```js
{ ok: true, mode: 'started', conversationId, engineId, turnId }
{ ok: true, mode: 'queued', conversationId, engineId, turnId, queueDepth }
{ ok: true, mode: 'steered', conversationId, engineId, turnId, after: 'next-tool-call' }
```

- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/agent-session-contract.test.js
```

### 3. Port AION's Built-In Engine Specs Into Mia

- [ ] Add `tests/acp-engine-specs.test.js`.
- [ ] Assert Claude Code uses the AION ACP wrapper command:

```js
{
  engineId: 'claude',
  transport: 'acp',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/claude-agent-acp@0.39.0']
}
```

- [ ] Assert Codex uses the AION ACP wrapper command:

```js
{
  engineId: 'codex',
  transport: 'acp',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/codex-acp@1.1.0']
}
```

- [ ] Assert Hermes uses native ACP:

```js
{
  engineId: 'hermes',
  transport: 'acp',
  command: 'hermes',
  args: ['acp']
}
```

- [ ] Assert OpenClaw is represented as an ACP engine spec and uses the existing OpenClaw command resolution currently embedded in `src/main/openclaw-chat-adapter.js`.
- [ ] Assert `supportsSteerInput` is `false` until a concrete ACP event/cancel/prompt implementation proves per-engine steer behavior.
- [ ] Assert `supportsQueuedInput` is `true` for all four engines.
- [ ] Run the focused test and confirm it fails:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/acp-engine-specs.test.js
```

- [ ] Add `src/main/agent-session/acp-engine-specs.js`.
- [ ] Copy only the command facts from AION migrations; do not import AION code.
- [ ] Move OpenClaw command discovery logic out of `src/main/openclaw-chat-adapter.js` into this module.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/acp-engine-specs.test.js
```

### 4. Implement AION-Style Session Build Serialization

- [ ] Add `tests/agent-session-manager.test.js`.
- [ ] Use a fake session factory that records build calls and send calls.
- [ ] Assert concurrent calls to `getOrCreateSession` for the same session key result in exactly one build.
- [ ] Assert different `(conversationId, engineId, workspacePath)` values build distinct sessions.
- [ ] Assert `sendUserInput` starts immediately when the session is idle.
- [ ] Assert `sendUserInput` returns `{ mode: "queued" }` when the session is running and the engine has no proven steer support.
- [ ] Assert queued input is delivered after the active run emits `message-completed`.
- [ ] Assert `cancelActive` calls the active session cancel method and preserves queued user input.
- [ ] Assert `closeSession` kills the native process and removes the session key.
- [ ] Run the focused test and confirm it fails:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/agent-session-manager.test.js
```

- [ ] Add `src/main/agent-session/agent-session-manager.js`.
- [ ] Implement a `buildLocks` map equivalent to AION's `OnceCell` task build gate.
- [ ] Implement `sessionsByKey`, `runningByKey`, and `queuesByKey`.
- [ ] Subscribe to session events and drain one queued input after `message-completed`, `message-cancelled`, or `message-failed`.
- [ ] Emit normalized events through Node `EventEmitter`.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/agent-session-manager.test.js
```

### 5. Build The Generic ACP AgentSession Adapter

- [ ] Add `tests/acp-agent-session.test.js`.
- [ ] Use a fake ACP transport/client object instead of spawning real engine binaries.
- [ ] Assert `start()` initializes an ACP session once.
- [ ] Assert `sendUserInput({ text })` sends one ACP prompt request and does not include Mia visible history.
- [ ] Assert ACP streaming notifications are normalized through `acp-event-normalizer.js`.
- [ ] Assert `cancel()` sends ACP session cancel notification while a prompt is in flight.
- [ ] Assert `kill()` closes the transport process.
- [ ] Assert prompt errors emit `message-failed` with engine ID and session key.
- [ ] Run the focused test and confirm it fails:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/acp-agent-session.test.js
```

- [ ] Add `src/main/agent-session/acp-event-normalizer.js`.
- [ ] Add `src/main/agent-session/acp-agent-session.js`.
- [ ] Use the existing `@agentclientprotocol/sdk` package already present in Mia.
- [ ] Keep transport creation injectable so tests never spawn real binaries.
- [ ] Match AION's `protocol/acp.rs` concurrency rule: prompt awaits its response while cancel is allowed to send concurrently through the same connection actor/client.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/acp-agent-session.test.js
```

### 6. Enforce Native Input Policy

- [ ] Add `tests/native-input-policy.test.js`.
- [ ] Assert AgentSession prompt payloads contain only:
  - current user text
  - attachments or file references for the current user turn
  - workspace/cwd/session metadata required by the ACP engine
- [ ] Assert prior assistant text and prior user text from Mia's visible transcript are rejected by the policy module.
- [ ] Assert system/developer configuration is handled as session initialization metadata, not prepended as a visible transcript replay.
- [ ] Run the focused test and confirm it fails:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/native-input-policy.test.js
```

- [ ] Add `src/main/agent-session/native-input-policy.js`.
- [ ] Wire this policy into `acp-agent-session.js`.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/native-input-policy.test.js tests/acp-agent-session.test.js
```

### 7. Wire AgentSession Into Main Process Composition

- [ ] Add `src/main/agent-session/index.js`.
- [ ] Export:
  - `AgentSessionManager`
  - `createAcpAgentSession`
  - `getAcpEngineSpec`
  - `listAcpEngineSpecs`
  - contract constants
- [ ] Modify `src/main.js` or the existing main-process composition root to construct one `AgentSessionManager`.
- [ ] Pass the manager into `bot-execution-core.js` and `social/local-bot-responder.js`.
- [ ] Keep lifecycle cleanup on app quit: close all native sessions.
- [ ] Add tests to `tests/mia-core-engines.test.js` proving all four bot conversation engines resolve to AgentSession specs.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/mia-core-engines.test.js tests/agent-session-contract.test.js tests/acp-engine-specs.test.js
```

### 8. Replace Bot Conversation Execution

- [ ] Modify `tests/bot-execution-core.test.js`.
- [ ] Remove assertions that interactive runs call `sendChat` for Claude, Codex, Hermes, or OpenClaw.
- [ ] Add assertions that interactive bot runs call `agentSessionManager.sendUserInput`.
- [ ] Assert cancellation calls `agentSessionManager.cancelActive`.
- [ ] Assert the old abort-controller path is not responsible for starting a second engine call.
- [ ] Run the focused test and confirm it fails:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/bot-execution-core.test.js
```

- [ ] Modify `src/main/bot-execution-core.js` to call `agentSessionManager` for bot conversation engines.
- [ ] Remove the old engine adapter lookup from the interactive bot path.
- [ ] Keep non-conversation utility operations separate only when they are not bot chat turns.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/bot-execution-core.test.js tests/agent-session-manager.test.js
```

### 9. Replace Social Conversation Queueing And Busy Input Behavior

- [ ] Modify `tests/local-bot-responder.test.js`.
- [ ] Assert a user send during an active run is accepted and returns queued metadata.
- [ ] Assert the second send is persisted to the local conversation before the queued engine turn starts.
- [ ] Assert the queued send is delivered through `AgentSessionManager`, not through local `sendChat`.
- [ ] Modify `tests/renderer-social.test.js`.
- [ ] Replace the current busy-blocking tests:
  - `sendInActiveConversation blocks a second user message while the active bot run is running`
  - `sendInActiveConversation blocks a second user message while cancelling`
- [ ] Add tests asserting the renderer sends the message and renders queued/running state without dropping input.
- [ ] Run focused tests and confirm they fail:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/local-bot-responder.test.js tests/renderer-social.test.js
```

- [ ] Modify `src/main/social/local-bot-responder.js` to delegate queue ownership to `AgentSessionManager`.
- [ ] Modify `src/main/social/ipc-handlers.js` so active-conversation send returns accepted queue metadata instead of `409 CONVERSATION_RUN_IN_PROGRESS`.
- [ ] Modify `src/renderer/app.js` so submit does not return early for `isActiveConversationBusy()`.
- [ ] Modify `src/renderer/social/social.js` so `sendInActiveConversation()` accepts busy sends.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/local-bot-responder.test.js tests/renderer-social.test.js tests/agent-session-manager.test.js
```

### 10. Remove Legacy Hermes HTTP Execution

- [ ] Search callsites:

```bash
cd /Users/jung/GitHub/Mia
rg "hermes-chat-adapter|hermes-run-service|createHermes|sendHermes|runMessages|/runs|/messages" src tests
```

- [ ] Delete `src/main/hermes-chat-adapter.js`.
- [ ] Delete `src/main/hermes-run-service.js`.
- [ ] Delete `tests/hermes-chat-adapter.test.js`.
- [ ] Update any engine catalog or project structure tests that listed those files.
- [ ] Add a `tests/project-structure-check.test.js` assertion that Hermes bot chat execution is not imported from an HTTP adapter.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/project-structure-check.test.js tests/acp-engine-specs.test.js tests/mia-core-engines.test.js
```

### 11. Retire Claude/Codex Prompt Bot Paths

- [ ] Search callsites:

```bash
cd /Users/jung/GitHub/Mia
rg "claude-code-chat-adapter|codex-chat-adapter|query\\(\\{|runCodexAppServerTurn|promptWithGroup|fullPrompt|codexPrompt" src tests
```

- [ ] Remove bot conversation exports from `src/main/claude-code-chat-adapter.js`.
- [ ] Remove bot conversation exports from `src/main/codex-chat-adapter.js`.
- [ ] Remove bot-conversation tests that assert prompt construction for Claude/Codex.
- [ ] Keep or move unrelated non-chat utility behavior only when an explicit callsite still uses it outside bot conversations.
- [ ] Add tests proving Claude and Codex bot turns use ACP specs from `agent-session/acp-engine-specs.js`.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/acp-engine-specs.test.js tests/bot-execution-core.test.js
```

### 12. Fold OpenClaw Into The Shared ACP Runtime

- [ ] Search callsites:

```bash
cd /Users/jung/GitHub/Mia
rg "openclaw-chat-adapter|OpenClaw|openclaw" src tests
```

- [ ] Move reusable ACP command/session logic from `src/main/openclaw-chat-adapter.js` into:
  - `src/main/agent-session/acp-engine-specs.js`
  - `src/main/agent-session/acp-agent-session.js`
- [ ] Remove bot conversation exports from `src/main/openclaw-chat-adapter.js`.
- [ ] Replace old OpenClaw adapter tests with AgentSession ACP tests.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/openclaw-chat-adapter.test.js tests/acp-agent-session.test.js tests/acp-engine-specs.test.js
```

### 13. Update Engine Health And Install Checks

- [ ] Modify `tests/mia-core-engines.test.js`.
- [ ] Assert Hermes health checks verify `hermes acp` is available, not only that a local HTTP service answers.
- [ ] Assert Claude health checks verify the configured ACP wrapper command.
- [ ] Assert Codex health checks verify the configured ACP wrapper command.
- [ ] Assert OpenClaw health checks verify its ACP launch path.
- [ ] Run focused tests and confirm they fail:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/mia-core-engines.test.js
```

- [ ] Modify:
  - `src/main/engine-catalog-service.js`
  - `src/main/local-agent-engine-service.js`
  - `src/main/mia-core-engines.js`
- [ ] Remove any Hermes health assumption based on the old HTTP run service.
- [ ] Surface health messages that say which ACP command is missing.
- [ ] Run:

```bash
cd /Users/jung/GitHub/Mia
npm test -- tests/mia-core-engines.test.js tests/acp-engine-specs.test.js
```

### 14. Manual Runtime Verification

- [ ] Run the complete test suite:

```bash
cd /Users/jung/GitHub/Mia
npm test
```

- [ ] Start Mia Core locally:

```bash
cd /Users/jung/GitHub/Mia
npm run core
```

- [ ] In a second terminal, start the app:

```bash
cd /Users/jung/GitHub/Mia
npm run dev
```

- [ ] Verify the local service card no longer reports Mia Core as unavailable when the app is running.
- [ ] Create one conversation per engine:
  - Claude Code
  - Codex
  - Hermes
  - OpenClaw
- [ ] Send a first message and verify one native AgentSession process starts.
- [ ] Send a second message while the first answer is running and verify Mia accepts it.
- [ ] Verify the second message appears in the conversation immediately.
- [ ] Verify the second engine turn starts after the active turn completes when steer is not enabled.
- [ ] Verify no Hermes HTTP `/runs` or `/messages` call occurs.
- [ ] Verify no Claude `query({ prompt })` bot chat call occurs.
- [ ] Verify no Codex `runCodexAppServerTurn({ prompt })` bot chat call occurs.

### 15. Final Cleanup And Commit

- [ ] Run structural searches and ensure removed bot paths are gone:

```bash
cd /Users/jung/GitHub/Mia
rg "hermes-run-service|hermes-chat-adapter|runCodexAppServerTurn|query\\(\\{|promptWithGroup|codexPrompt|includedHistoryChars" src tests
```

- [ ] Inspect git status:

```bash
cd /Users/jung/GitHub/Mia
git status --short
```

- [ ] Review the diff:

```bash
cd /Users/jung/GitHub/Mia
git diff -- src tests package.json package-lock.json
```

- [ ] Commit with:

```bash
cd /Users/jung/GitHub/Mia
git add src tests package.json package-lock.json docs/superpowers/plans/2026-07-02-agent-session-aion-alignment.md
git commit -m "Align bot engines with AgentSession ACP runtime"
```

- [ ] Push the active branch:

```bash
cd /Users/jung/GitHub/Mia
git push
```

---

## Risk Checks

- The largest risk is ACP package API mismatch in JavaScript. The adapter must be written behind an injectable transport/client boundary so tests pin Mia behavior while the real SDK binding is adjusted.
- The second risk is lifecycle leakage from native ACP child processes. `AgentSessionManager.closeAll()` must run on app quit and tests must assert `kill()` is called.
- The third risk is UI behavior changing from busy-block to accepted queue. Renderer tests must cover double-send, cancellation, and queued-state rendering.
- The fourth risk is preserving unrelated utility flows. During deletion, only keep non-bot utility code with a concrete callsite and a test. Bot conversation paths must not call legacy prompt adapters.

---

## Self-Review

- AION concrete code references are included and mapped to Mia files.
- Hermes is treated as ACP (`hermes acp`), not HTTP chat.
- Claude Code and Codex bot conversations move to ACP wrapper commands matching AION migrations.
- OpenClaw is folded into the same ACP runtime instead of staying as a separate chat adapter.
- The plan removes old bot conversation paths after replacement tests exist.
- The plan changes busy input from renderer-blocked to accepted queue semantics.
- Each implementation phase has a focused test command.
- Manual verification checks that old prompt/HTTP paths are not exercised at runtime.
