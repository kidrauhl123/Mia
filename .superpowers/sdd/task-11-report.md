Status: DONE_WITH_CONCERNS
Commits created: 3295d0a refactor: retire claude codex prompt bot paths
One-line test summary: `node --test` passed for the focused Task 11 suites; `npm test -- ...` expanded to the full suite and was interrupted after stalling in `tests/bots-api.test.js`.
Concerns, if any: Full-suite `npm test -- tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/acp-engine-specs.test.js tests/bot-execution-core.test.js` expanded to `tests/*.test.js`; I interrupted it after it sat in the expanded run without further progress.
Report file path: `/Users/jung/GitHub/Mia/.worktrees/agent-session-aion-alignment/.superpowers/sdd/task-11-report.md`
