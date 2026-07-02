### Task 15 Report

Final cleanup removed the retired Claude Code and Codex bot conversation prompt adapters.

Changes:
- Deleted `src/main/claude-code-chat-adapter.js` and `src/main/codex-chat-adapter.js`.
- Added stateless-only utilities:
  - `src/main/claude-code-stateless-adapter.js`
  - `src/main/codex-stateless-adapter.js`
- Updated `src/main.js` so Claude/Codex prompt-shaped helpers are only constructed for explicit stateless calls.
- Removed Claude/Codex direct prompt adapter construction and `runCodexAppServerTurn` injection from `src/core/mia-core.js`.
- Updated `src/check.js`, `src/main/AGENTS.md`, `src/main/skills-loader.js`, and project structure tests for the new stateless-only names.
- Replaced old Claude/Codex adapter tests with:
  - `tests/claude-code-stateless-adapter.test.js`
  - `tests/codex-stateless-adapter.test.js`

Structure search:

```text
$ rg "hermes-run-service|hermes-chat-adapter|runCodexAppServerTurn|query\\(\\{|promptWithGroup|codexPrompt|includedHistoryChars" src tests
src/main/agent-context-budget.js:  const includedHistoryChars = numeric(input.includedHistoryChars);
src/main/agent-context-budget.js:    || systemChars + personaChars + currentUserChars + includedHistoryChars + groupChars;
src/main/agent-context-budget.js:    ["includedHistoryChars", includedHistoryChars],
src/main/claude-code-stateless-adapter.js:    const stream = query({ prompt: fullPrompt, options });
tests/codex-app-server-runner.test.js:  runCodexAppServerTurn,
tests/codex-app-server-runner.test.js:... runner coverage ...
tests/project-structure-check.test.js:... forbidden Hermes path assertions ...
tests/agent-context-budget.test.js:    includedHistoryChars: 0,
tests/agent-context-budget.test.js:    "includedHistoryChars=0",
tests/codex-stateless-adapter.test.js:    runCodexAppServerTurn: async (args) => {
src/main/codex-stateless-adapter.js:  const runCodexAppServerTurn = requireDependency(deps, "runCodexAppServerTurn");
src/main/codex-stateless-adapter.js:    const turn = await runCodexAppServerTurn({
src/main.js:  runCodexAppServerTurn
src/main.js:    runCodexAppServerTurn,
src/main/codex-app-server-runner.js:async function runCodexAppServerTurn({
src/main/codex-app-server-runner.js:  runCodexAppServerTurn,
src/main/agent-command-provider.js:      queryResult = sdk.query({
```

Remaining hits are expected:
- `query({ prompt })` remains only in explicit Claude stateless utility and agent command provider utility paths.
- `runCodexAppServerTurn` remains in Codex stateless utility, its runner, and runner tests. It is no longer injected into Mia Core bot execution.
- `includedHistoryChars` remains in the generic context-budget formatter and tests.
- `hermes-run-service` / `hermes-chat-adapter` hits are structure-test assertions that the files stay deleted.
- No `promptWithGroup` or `codexPrompt` production bot prompt assembly remains.

Verification:

```text
$ node --test tests/chat-engine-adapters.test.js tests/bot-execution-core.test.js tests/mia-core-engines.test.js tests/project-structure-check.test.js
tests 94
pass 94
fail 0
```

```text
$ node --test tests/claude-code-stateless-adapter.test.js tests/codex-stateless-adapter.test.js tests/codex-app-server-runner.test.js
tests 28
pass 28
fail 0
```

Stale test check:

```text
$ ls tests/*chat-adapter.test.js tests/*stateless-adapter.test.js 2>/dev/null
tests/claude-code-stateless-adapter.test.js
tests/codex-stateless-adapter.test.js
tests/openclaw-chat-adapter.test.js
```
