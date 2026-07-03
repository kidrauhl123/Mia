Status: DONE_WITH_CONCERNS
Commits created: 836d3b8 refactor: retire claude codex prompt bot paths
One-line test summary: `node --test` passed for the focused Task 11 suites; `npm test -- ...` expanded to the full suite and was interrupted after stalling in `tests/bots-api.test.js`.
Concerns, if any: Full-suite `npm test -- tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/acp-engine-specs.test.js tests/bot-execution-core.test.js` expanded to `tests/*.test.js`; I interrupted it after it sat in the expanded run without further progress.
Report file path: `/Users/jung/GitHub/Mia/.worktrees/agent-session-aion-alignment/.superpowers/sdd/task-11-report.md`

---

Fix pass after review on top of `836d3b8`:

- Fixed the production cloud-bridge path so bridge bot turns no longer resolve a chat adapter and call `adapter.sendChat(...)`. `src/main/cloud/cloud-bridge-client.js` now accepts a direct `runBridgeBotTurn(...)` seam and routes bridge Claude/Codex/Hermes/OpenClaw runs through the same `botExecution.sendChat`/AgentSession-managed path used elsewhere.
- Updated `src/main.js` and `src/core/mia-core.js` to pass `botExecution.sendChat`-backed bridge sender functions into `createCloudBridgeClient(...)`.
- Updated bridge and structure tests to assert the direct sender seam rather than the retired bridge adapter contract.
- Carried forward the previously dirty report-file SHA correction as part of this fix pass.

Covering test commands run:

- `node --test tests/main-cloud-bridge-client.test.js tests/project-structure-check.test.js tests/bot-execution-core.test.js tests/chat-engine-adapters.test.js tests/mia-core-cloud-bridge.test.js`
- `node --test tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/acp-engine-specs.test.js tests/bot-execution-core.test.js tests/chat-engine-adapters.test.js tests/mia-core-engines.test.js tests/conversation-title-service.test.js`

Output summary:

- Bridge/structure/core focused suite: 100 tests passed, 0 failed.
- Re-run Task 11 focused suite: 57 tests passed, 0 failed.
- Syntax check: `node --check src/main/cloud/cloud-bridge-client.js src/main.js src/core/mia-core.js` passed.
