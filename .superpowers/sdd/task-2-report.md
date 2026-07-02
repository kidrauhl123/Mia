# Task 2 Report: Hermes Gateway JSON-RPC Client And Event Normalization

## What Changed

- Added `src/cloud-agent/hermes-gateway-client.js` as a CommonJS JSON-RPC WebSocket client using `ws`.
- Added `src/cloud-agent/hermes-gateway-events.js` with `normalizeGatewayEvent(event)`.
- Extended `src/shared/assistant-content-blocks.js` so the collector accepts Hermes-native event names:
  - `reasoning.delta`
  - `thinking.delta`
  - `tool.start`
  - `tool.progress`
  - `tool.complete`
- Added focused tests for:
  - gateway request framing
  - response resolve/reject behavior
  - exact and wildcard event dispatch
  - newline-delimited multi-frame parsing
  - request timeout cleanup
  - close rejecting pending requests
  - event normalization
  - assistant content blocks from Hermes-native event names

## TDD Evidence

### Red

Ran:

```bash
node --test tests/cloud-agent-hermes-gateway-client.test.js tests/cloud-agent-hermes-gateway-events.test.js tests/assistant-content-blocks.test.js
```

Initial failures:

- `Cannot find module '../src/cloud-agent/hermes-gateway-client.js'`
- `Cannot find module '../src/cloud-agent/hermes-gateway-events.js'`
- `collector accepts Hermes gateway event names for thinking and tool blocks` failed with `actual: []`

### Green

Implemented the two new modules and added Hermes-native aliases in the content block collector, then reran:

```bash
node --test tests/cloud-agent-hermes-gateway-client.test.js tests/cloud-agent-hermes-gateway-events.test.js tests/assistant-content-blocks.test.js
```

Result: `21` tests passed, `0` failed.

### Refactor / Fix During Green

- Found a parser bug during green verification: single-frame JSON messages were not parsed unless they contained a newline.
- Simplified the gateway message parser to handle both single-frame messages and newline-delimited frame batches.
- Reran the focused test command and confirmed all tests still passed.

## Tests Run

```bash
node --test tests/cloud-agent-hermes-gateway-client.test.js tests/cloud-agent-hermes-gateway-events.test.js tests/assistant-content-blocks.test.js
npm run check
```

Results:

- Focused test suite passed: `21` passed, `0` failed.
- `npm run check` passed: `Mia project structure OK`

## Files Changed

- `src/cloud-agent/hermes-gateway-client.js`
- `src/cloud-agent/hermes-gateway-events.js`
- `src/shared/assistant-content-blocks.js`
- `tests/cloud-agent-hermes-gateway-client.test.js`
- `tests/cloud-agent-hermes-gateway-events.test.js`
- `tests/assistant-content-blocks.test.js`

## Self-Review

- Scope stayed within the files listed in the brief.
- No worker manager, dispatcher, group orchestrator, SQLite store, IM client, or runs client files were edited.
- The gateway client behavior covered by tests matches the task brief:
  - `connect(wsUrl)`
  - `request(method, params = {}, options = {})`
  - `on(type, handler)`
  - `close()`
  - JSON-RPC request framing
  - pending request resolution/rejection
  - timeout cleanup
  - close cleanup
  - exact and wildcard event dispatch
  - newline-delimited multi-frame parsing
- Normalization preserves `rawGatewayEvent`, `session_id`, and payload fields while mapping the required event names.

## Concerns

- The new gateway client is intentionally low-level and minimal. It does not yet add reconnection, partial-frame buffering across separate WebSocket messages, or listener removal because those were not required by this task brief.

## Review Fix Follow-Up

### Requested fixes

- Added assistant content block coverage for Hermes text events by asserting `collector.collect("message.delta", ...)` records a text block.
- Hardened `normalizeGatewayEvent()` so payload keys cannot overwrite normalized `type`, `session_id`, or `rawGatewayEvent`.

### Red

Ran:

```bash
node --test tests/cloud-agent-hermes-gateway-events.test.js tests/assistant-content-blocks.test.js
```

Observed:

- The new `message.delta` collector test passed immediately, confirming the collector already handled Hermes text events and the missing part was test coverage.
- The new overwrite-safety test failed because `normalizeGatewayEvent()` let payload fields replace normalized top-level fields.

### Green

Changed `normalizeGatewayEvent()` to spread payload first and normalized fields after it, then reran:

```bash
node --test tests/cloud-agent-hermes-gateway-events.test.js tests/assistant-content-blocks.test.js
```

Result: `16` passed, `0` failed.

### Verification

Ran the required commands:

```bash
node --test tests/cloud-agent-hermes-gateway-client.test.js tests/cloud-agent-hermes-gateway-events.test.js tests/assistant-content-blocks.test.js
npm run check
```

Results:

- Focused suite passed: `23` passed, `0` failed.
- `npm run check` passed: `Mia project structure OK`
