# Task 3 Report: Managed Connector Supervisor For Xiaohongshu

## Implementation summary

Implemented the managed connector runtime abstraction for `xiaohongshu` in two source files:

- `src/core/mcp/managed-connectors/xiaohongshu.js`
  - Added `createXiaohongshuManagedConnector(deps)`.
  - Implements `install`, `login`, and `start` actions using injected `childProcess`.
  - Resolves the managed install directory under `runtimePaths().runtime/managed-mcp/xiaohongshu-mcp`.
  - Reports connector status from the local checkout shape without invoking real `git` or `go` during tests.

- `src/core/mcp/managed-connector-supervisor.js`
  - Added `createManagedConnectorSupervisor(deps)`.
  - Exposes `status(record)`, `runAction(record, action, values)`, `ensureRunning(records)`, and `stop(recordId)`.
  - Tracks running child processes in-memory by record id.
  - Merges managed runtime patches back through `normalizeCoreMcpRecord`.
  - Sanitizes surfaced messages with `sanitizeSecretText`.

Also added the focused test file:

- `tests/core-mcp-managed-connector-supervisor.test.js`

## Tests and results

Focused red run:

```text
node --test tests/core-mcp-managed-connector-supervisor.test.js
Error: Cannot find module '../src/core/mcp/managed-connector-supervisor.js'
```

Focused green run after implementation:

```text
node --test tests/core-mcp-managed-connector-supervisor.test.js
4 tests passed, 0 failed
```

Latest verified result:

- Command: `node --test tests/core-mcp-managed-connector-supervisor.test.js`
- Exit code: `0`
- Result: `4` passing tests, `0` failures

## TDD evidence

1. Wrote `tests/core-mcp-managed-connector-supervisor.test.js` first, before adding either production file.
2. Ran the focused test immediately.
3. Confirmed the expected red failure: missing `managed-connector-supervisor.js`.
4. Added the minimal production implementation in the two allowed source files.
5. Re-ran the same focused test and confirmed green.

## Files changed

- `src/core/mcp/managed-connectors/xiaohongshu.js`
- `src/core/mcp/managed-connector-supervisor.js`
- `tests/core-mcp-managed-connector-supervisor.test.js`

Commit:

- `53c1bec` — `feat: supervise managed xiaohongshu mcp`

## Self-review

- Matched the exact interfaces and constant values from the brief.
- Used injected `childProcess` in tests, so no real `git` or `go` execution is required there.
- Kept the implementation scoped to the task-owned files.
- Preserved sanitization at the supervisor boundary for surfaced messages.

## Concerns

- `hasCheckout()` treats `go.mod` as the install sentinel. That matches the brief, but Task 4 integration may need a stronger runtime-health signal later.
- `login` spawns a child but the supervisor intentionally only retains `start` children. That matches the briefed tests, though lifecycle handling for login is currently fire-and-forget.
- `ensureRunning()` starts any enabled managed record with a supported connector id; broader orchestration behavior depends on how Task 4 wires this into `createCoreMcpService`.

## Reviewer fix follow-up

Addressed the post-review gaps in the owned files only:

- `src/core/mcp/managed-connectors/xiaohongshu.js`
  - `login` and `start` now fail before spawn when the managed checkout is missing.
  - `start` now requires a successful `deps.fetch(endpoint)` 2xx health check before returning success, and kills the spawned child if health fails.
  - Added managed action `test`, which probes the endpoint and returns a healthy runtime patch while preserving `endpoint` and `installDir`.
- `src/core/mcp/managed-connector-supervisor.js`
  - Sanitizes connector action failures at the supervisor boundary before surfacing them.
  - `stop()` now returns the canonical stopped runtime patch even when no child is tracked.
- `tests/core-mcp-managed-connector-supervisor.test.js`
  - Added coverage for missing install on `login` and `start`.
  - Added coverage for startup health failure.
  - Added coverage for managed `test`.
  - Added coverage for `stop()` without a tracked child.

Exact commands and results:

```text
$ node --test tests/core-mcp-managed-connector-supervisor.test.js
Result before fixes: 4 passed, 5 failed
Failures:
- login action fails cleanly when the managed checkout is missing
- start action fails cleanly when the managed checkout is missing
- start action fails when endpoint health check does not succeed
- test action uses the managed endpoint and marks the runtime healthy
- stop returns a canonical stopped patch when no child is tracked

$ node --test tests/core-mcp-managed-connector-supervisor.test.js
Result after fixes: 9 passed, 0 failed
Exit code: 0
```
