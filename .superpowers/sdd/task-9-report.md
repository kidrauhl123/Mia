Task 9 Report: Replace Social Conversation Queueing And Busy Input Behavior

Status
- DONE

Summary
- Moved AgentSession-backed social turn delivery out of the local responder queue path and into `agentSessionManager.sendUserInput(...)` when a managed engine/workspace is available.
- Removed renderer-side busy send rejection from `sendInActiveConversation(...)` and the chat submit handler, so user messages are still posted, optimistically rendered, and reconciled while a run is `running` or `cancelling`.
- Kept the legacy local responder queue behavior for no-manager / adapter-only tests and paths.

Files Changed
- `src/main/social/local-bot-responder.js`
- `src/renderer/social/social.js`
- `src/renderer/app.js`
- `src/main.js`
- `src/core/mia-core.js`
- `tests/local-bot-responder.test.js`
- `tests/renderer-social.test.js`
- `tests/renderer-shell.test.js`

Behavior Notes
- AgentSession-backed local responder sends now forward only the current user turn payload (`turnId`, `text`, current-turn attachments when present) plus manager descriptor fields (`conversationId`, `engineId`, `workspacePath`).
- Visible conversation history is not replayed into the AgentSession manager payload.
- Renderer busy state is still available for affordances like stop/status, but it no longer blocks message submission.

IPC/Main-Side Busy Guard Check
- Checked `src/main/social/social-ipc.js`.
- No main-side IPC busy block returning `409 CONVERSATION_RUN_IN_PROGRESS` exists there today.
- No IPC test changes were needed.

Verification
- `npm test -- tests/local-bot-responder.test.js tests/renderer-social.test.js tests/renderer-shell.test.js tests/agent-session-manager.test.js`
  - Confirmed this workspace’s npm wrapper expands to `node --test tests/*.test.js ...` and starts the full suite, so it was interrupted.
- `node --test tests/local-bot-responder.test.js tests/renderer-social.test.js tests/renderer-shell.test.js tests/agent-session-manager.test.js`
  - Passed: 287 tests, 0 failures.

Commit
- `Replace social busy queueing with AgentSession routing`

Fix Follow-up (Needs Fixes Review)

Status
- DONE

Fix Summary
- Persisted managed social conversation descriptors inside `local-bot-responder` so `stopActiveConversationRun()` can resolve `(conversationId, engineId, workspacePath)` and route cancellation through `agentSessionManager.cancelActive(...)`.
- Kept that resolution conversation-scoped, so no renderer payload expansion was required for this fix.
- Fixed the managed-input workspace validation path so an error no longer leaves `dedupKey` stuck in `inFlight`.

Focused Tests Added
- `stopActiveConversationRun cancels an AgentSession-backed social run using the stored session descriptor`
- `managed AgentSession workspace validation failure does not poison retries for the same dedupKey`

Verification
- `node --test tests/local-bot-responder.test.js`
  - Passed: 38 tests, 0 failures.
- `node --test tests/local-bot-responder.test.js tests/renderer-social.test.js tests/renderer-shell.test.js tests/agent-session-manager.test.js`
  - Passed: 289 tests, 0 failures.
