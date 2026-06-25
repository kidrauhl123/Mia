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
