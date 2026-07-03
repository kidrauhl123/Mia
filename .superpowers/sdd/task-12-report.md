Status: DONE_WITH_CONCERNS

Summary:
- Removed the remaining direct OpenClaw bot-chat dispatch path from `createChatEngineAdapters()` and from main/Core wiring so bot conversations fail closed and route through `AgentSession`/ACP instead.
- Moved the shared OpenClaw ACP launch handling needed by `AgentSession` into the shared ACP runtime path by adding `spawnAcpEngineProcess()` in `src/main/agent-session/acp-engine-specs.js` and using it from `defaultCreateTransport()` in `src/main/agent-session/acp-agent-session.js`.
- Narrowed `src/main/openclaw-chat-adapter.js` to stateless-only surface (`createOpenClawStatelessAdapter`, `closeOpenClawAcpRuntimes`) and replaced the old large bot `sendChat` test suite with focused stateless/helper coverage plus ACP runtime tests.

Files changed:
- `src/main/agent-session/acp-engine-specs.js`
- `src/main/agent-session/acp-agent-session.js`
- `src/main/chat-engine-adapters.js`
- `src/main/openclaw-chat-adapter.js`
- `src/main.js`
- `src/core/mia-core.js`
- `tests/openclaw-chat-adapter.test.js`
- `tests/acp-agent-session.test.js`
- `tests/acp-engine-specs.test.js`
- `tests/chat-engine-adapters.test.js`
- `tests/bot-execution-core.test.js`

Focused verification:
- `node --test tests/openclaw-chat-adapter.test.js tests/acp-agent-session.test.js tests/acp-engine-specs.test.js` ✅
- `node --test tests/chat-engine-adapters.test.js tests/bot-execution-core.test.js tests/mia-core-engines.test.js tests/project-structure-check.test.js` ✅

`npm test -- ...` note:
- `npm test -- tests/openclaw-chat-adapter.test.js tests/acp-agent-session.test.js tests/acp-engine-specs.test.js tests/chat-engine-adapters.test.js tests/bot-execution-core.test.js tests/mia-core-engines.test.js tests/project-structure-check.test.js`
- The package test script expands to `node --test tests/*.test.js ...`, so it ran the full suite.
- That full-suite run failed on unrelated pre-existing release/audit tests in `tests/cloud-productization-audit.test.js` (missing release handoff/transfer artifacts and packaged app.asar freshness evidence). Task 12 focused tests remained green.

Self-review:
- Confirmed no remaining production path in `createChatEngineAdapters().openclaw.send(...)` can call a direct OpenClaw bot `sendChat`.
- Confirmed `src/main.js` and `src/core/mia-core.js` no longer wire `sendOpenClawChat`.
- Confirmed OpenClaw ACP transport under shared `AgentSession` now uses the shared shim-aware launcher path.

---

Review fix (post-`1c614c7`):

Files changed:
- `src/main/openclaw-chat-adapter.js`
- `tests/openclaw-chat-adapter.test.js`
- `tests/project-structure-check.test.js`
- `.superpowers/sdd/task-12-report.md`

What changed:
- Replaced `src/main/openclaw-chat-adapter.js` with a stateless-only OpenClaw ACP adapter implementation and removed the residual direct bot `sendChat` / durable-session runtime path from that file entirely.
- Added structure assertions that `src/main.js` and `src/core/mia-core.js` do not wire `sendOpenClawChat`, and that `src/main/openclaw-chat-adapter.js` contains no bot `sendChat` implementation or old adapter constructor aliasing.

Tests run:
- `node --test tests/openclaw-chat-adapter.test.js tests/acp-agent-session.test.js tests/acp-engine-specs.test.js`
- `node --test tests/chat-engine-adapters.test.js tests/bot-execution-core.test.js tests/mia-core-engines.test.js tests/project-structure-check.test.js`

Output summary:
- First command: `23` tests passed, `0` failed.
- Second command: `91` tests passed, `0` failed.
