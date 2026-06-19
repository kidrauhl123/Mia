# Task 1 Report: Shared Contract And Registry Normalization

## Implementation Summary
- Added `src/shared/mcp-contracts.js` with shared MCP transport and status constants, plus browser/global attachment for Node and renderer reuse.
- Added `src/main/mcp/mcp-records.js` with record normalization, registry normalization, import parsing, secret masking, enabled-record filtering, and fingerprinting.
- Extended `src/main/runtime-paths.js` with the persisted MCP registry path: `mia-mcp-servers.json`.
- Added focused tests for MCP record behavior and runtime path coverage.
- Added `@modelcontextprotocol/sdk` to direct dependencies.

## Tests / Results
- Red step verification:
  - `node --test tests/mcp-records.test.js tests/runtime-paths.test.js`
  - Result: failed as expected before implementation because `src/main/mcp/mcp-records.js` did not exist and `paths.mcpServers` was still undefined.
- Green step verification:
  - `node --test tests/mcp-records.test.js tests/runtime-paths.test.js`
  - Result: pass.

## TDD Evidence
- Wrote the failing tests first:
  - `tests/mcp-records.test.js`
  - `tests/runtime-paths.test.js`
- Confirmed the first run failed for the expected missing module / missing path reasons.
- Implemented the minimum code needed to satisfy those behaviors, then reran the same focused command until it passed.

## Files Changed
- `src/shared/mcp-contracts.js`
- `src/main/mcp/mcp-records.js`
- `src/main/runtime-paths.js`
- `tests/mcp-records.test.js`
- `tests/runtime-paths.test.js`
- `package.json`
- `package-lock.json`

## Self-Review
- The implementation keeps transport support to the four allowed values: `stdio`, `http`, `sse`, and `streamable_http`.
- Secret-bearing values in env and header maps are masked in `maskMcpRecord` using the shared sensitive-key pattern.
- The registry normalizer preserves valid records, drops invalid ones, and de-duplicates by record name.
- The fingerprint only reflects enabled records and their transport config, which matches the brief.
- The runtime-paths test uses the existing fake app harness and never touches a real user home.

## Concerns
- `package-lock.json` only needed the root dependency declaration update because the SDK was already present transitively in the workspace; no broader lockfile churn was required.
