# Task 5 Report: External Agent Config Discovery

## Scope

Implemented Core MCP discovery for external agent configs across Claude Code, Codex, OpenClaw, and Hermes. Added parser exports, default service wiring, non-throwing probe failures, and import of discovered servers into the Core registry as disabled `agent-config` records.

## Changed Files

- `src/core/mcp/agent-configs.js`
- `src/core/mcp/service.js`
- `tests/core-mcp-agent-configs.test.js`
- `tests/core-mcp-service.test.js`
- `.superpowers/sdd/task-5-report.md`

## Tests Run

- `node --test tests/core-mcp-agent-configs.test.js tests/core-mcp-service.test.js`
- `node --check src/core/mcp/agent-configs.js src/core/mcp/service.js`

## Concerns

- Discovery depends on external CLI output shapes. Parsers cover the documented Task 5 cases and common object/list variants, but future CLI formatting changes may need parser updates.

## Review Fix: Secret Redaction

Commit: `3b0b8fd` (`fix(core-mcp): redact discovered agent secrets`)

Changed files:
- `src/core/mcp/agent-configs.js`
- `src/core/mcp/service.js`
- `tests/core-mcp-agent-configs.test.js`
- `tests/core-mcp-service.test.js`

Tests run:
- `node --test tests/core-mcp-agent-configs.test.js tests/core-mcp-service.test.js`
- `node --check src/core/mcp/agent-configs.js src/core/mcp/service.js`

Residual concerns:
- Public discovery output is now projected through the same env/header masking used by Core MCP records, while import re-discovers raw config data before saving. Parser coverage still depends on external CLI/config output shapes.

## Review Fix: Disabled Codex Object Entries

Commit: `988423e8cfb11acd4b58eb7db2bd150a6ab01cf2` (`fix(core-mcp): preserve disabled codex entries`)

Changed files:
- `src/core/mcp/agent-configs.js`
- `tests/core-mcp-agent-configs.test.js`
- `tests/core-mcp-service.test.js`

Tests run:
- `node --test tests/core-mcp-agent-configs.test.js tests/core-mcp-service.test.js`
- `node --check src/core/mcp/agent-configs.js src/core/mcp/service.js`

Residual concerns:
- None.

---

# Task 5 Report: Four-Agent MCP Exposure And Fingerprint Verification

## Status

- `DONE`

## Files Changed

- `tests/mcp-engine-sync.test.js`
- `tests/openclaw-chat-adapter.test.js`
- `.superpowers/sdd/task-5-report.md`

## Implementation Summary

- Added engine-sync coverage for managed `xiaohongshu` HTTP exposure to OpenClaw when ACP reports HTTP support.
- Added engine-sync coverage for Hermes bridge fallback when managed HTTP MCP cannot be passed through directly.
- Added engine-sync coverage confirming native stdio built-ins remain executable specs for Codex and Claude without manual command UX in the default flow.
- Added OpenClaw adapter coverage for managed `xiaohongshu` HTTP injection plus MCP-fingerprint-backed session key persistence.
- Existing Claude Code and Codex adapter tests already covered the required managed HTTP MCP merge and fingerprint persistence behavior, so no adapter production patch was necessary.

## Red/Green Evidence

- Red step: added the new assertions and tests first.
- Green step 1: `node --test tests/mcp-engine-sync.test.js` passed with `19` passing tests and `0` failures.
- Green step 2: `node --test tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js` passed with `75` passing tests and `0` failures.
- Final verification: `node --test tests/mcp-engine-sync.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js` passed with `94` passing tests and `0` failures.

## Exact Commands And Results

- `node --test tests/mcp-engine-sync.test.js`
  - Result: exit `0`, `19` passed, `0` failed
- `node --test tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js`
  - Result: exit `0`, `75` passed, `0` failed
- `node --test tests/mcp-engine-sync.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js`
  - Result: exit `0`, `94` passed, `0` failed

## Commit Id(s)

- Code/test commit id: `88cb1ad`

## Self-Review

- Stayed within the task-owned verification surface and did not touch the `/Users/jung/GitHub/Mia` main worktree.
- Did not revert or rewrite unrelated branch changes.
- Confirmed the current implementation already satisfies the managed/native exposure and MCP fingerprint expectations; only missing regression coverage was added.
- Kept the OpenClaw test aligned with existing adapter helpers and engine/session key conventions.

## Concerns

- The report’s exact final commit SHA is added after commit in the task response; the committed verification changes themselves are limited to tests plus this report.

## Review Fix: Managed HTTP xiaohongshu Coverage

Files changed:
- `tests/claude-code-chat-adapter.test.js`
- `tests/codex-chat-adapter.test.js`
- `.superpowers/sdd/task-5-report.md`

Implementation summary:
- Replaced the managed HTTP MCP fixture name from `xhs` to `xiaohongshu` in the Claude Code and Codex adapter coverage.
- Kept the existing session fingerprint assertions in both adapter tests so they still verify `fp1:mcp_fp` for Claude Code and `mcp_fp` persistence for Codex.

Exact command/result:
- `node --test tests/mcp-engine-sync.test.js tests/hermes-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js`
- Result: exit `0`, `94` passed, `0` failed

Commit id(s):
- `c3e9a37`

Concerns:
- None. The runtime already propagated managed HTTP MCP correctly; this fix only tightens regression coverage around the real built-in catalog name.
