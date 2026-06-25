### Task 7 Report: Engine Injection And Stale Session Protection

**Scope**
- Updated core MCP engine sync filtering so soft-deleted records are ignored by spec and planner helpers that use the shared enabled predicate.
- Added regression coverage for soft-deleted records and Codex bridge-required status for HTTP headers without a bridge.
- Reviewed `getEngineSpecs()` status collector handling. It now passes a local collector array when the caller does not provide one, and it does not write sync state or mutate files during spec generation.
- Verified existing adapter/runtime tests still cover MCP fingerprints in session reuse keys and safe merging of reserved built-in MCP servers.

**Changed files**
- `src/core/mcp/engine-sync.js`
- `src/core/mcp/service.js`
- `tests/mcp-engine-sync.test.js`

**Tests run**
- `node --test tests/mcp-engine-sync.test.js`
- `node --test tests/claude-code-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/openclaw-chat-adapter.test.js tests/engine-runtime-config-service.test.js`
- `node --check src/core/mcp/engine-sync.js src/main/mcp/mcp-engine-sync.js src/core/mcp/service.js`

**Concerns**
- None.
