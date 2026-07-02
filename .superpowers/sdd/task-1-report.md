# Task 1 Report

## What Changed

- Updated `src/cloud-agent/hermes-worker-manager.js` to:
  - derive `gatewayWsUrl` from `baseUrl` with `/api/ws?token=...`
  - honor explicit `options.gatewayWsUrl` / `MIA_CLOUD_HERMES_GATEWAY_WS_URL`
  - write `mia-hermes-gateway-server.py` into each user's `hermes-home`
  - return `gatewayWsUrl`, `model`, `modelProvider`, and `modelApiMode` from `ensureWorker()`
  - append `python /data/hermes-home/mia-hermes-gateway-server.py` after the docker image
- Updated `tests/cloud-agent-hermes-client.test.js` to cover:
  - static gateway URL derivation
  - explicit gateway URL override
  - gateway shim creation and expected shim content
  - Mia internal proxy config staying on `provider: "mia"`, `default: "mia-auto"`, `api_mode: "chat_completions"`
  - docker run args including the shim command
  - model alias normalization for the required `mia-auto` fallback cases
- `src/cloud-agent/cloud-hermes-model.js` already satisfied the alias normalization contract from the brief, so no production edit was required there.

## Tests

- `node --test tests/cloud-agent-hermes-client.test.js`
- `npm run check`

## TDD Evidence

1. Added the new focused tests in `tests/cloud-agent-hermes-client.test.js` before changing production code.
2. Ran `node --test tests/cloud-agent-hermes-client.test.js` and got the expected RED failures:
   - missing `worker.gatewayWsUrl` in static mode
   - missing explicit gateway URL handling
   - missing `mia-hermes-gateway-server.py`
   - missing docker shim command
3. Implemented the minimal worker-manager changes.
4. Re-ran `node --test tests/cloud-agent-hermes-client.test.js` until all 14 tests passed.
5. Ran `npm run check` and confirmed the repo check passed.

## Files Changed

- `src/cloud-agent/hermes-worker-manager.js`
- `tests/cloud-agent-hermes-client.test.js`
- `.superpowers/sdd/task-1-report.md`

## Self-Review

- Kept the scope inside the task-owned worker startup/config area and the focused test file.
- Did not touch dispatcher, group orchestrator, IM client files, SQLite store, or runs client.
- Preserved Mia internal proxy config defaults for the managed model route.
- Avoided overwriting unrelated worktree changes.

## Concerns

- The generated Python shim assumes the runtime image has `fastapi` and `tui_gateway` importable at startup. That matches the briefed architecture, but the container image remains the integration point to watch during deployment validation.

## Fix Evidence After Review

### Finding 1: Shim import/call shape

- Root cause: the generated shim used `import tui_gateway` and then dereferenced `tui_gateway.ws.handle_ws`, which relies on Python package submodule loading side effects.
- Test-first change:
  - updated `tests/cloud-agent-hermes-client.test.js` to assert:
    - `from tui_gateway.ws import handle_ws as gateway_handle_ws`
    - `await gateway_handle_ws(websocket)`
    - absence of `tui_gateway.ws.handle_ws`
- RED evidence:
  - `node --test tests/cloud-agent-hermes-client.test.js` failed on the shim-content assertion before production edits.
- GREEN implementation:
  - changed `renderHermesGatewayShim()` in `src/cloud-agent/hermes-worker-manager.js` to import the handler directly with an alias and call the imported symbol.

### Finding 2: Worker-manager model normalization boundary

- Root cause: `createHermesWorkerManager()` accepted `options.model` / `MIA_CLOUD_AGENT_MODEL` verbatim and propagated legacy aliases into rendered config and `worker.model`.
- Test-first change:
  - updated the existing LiteLLM config test to require `mia-auto` normalization
  - added an end-to-end worker-manager test covering `model: "default"` flowing through `ensureUserDirs()` and `ensureWorker()`
- RED evidence:
  - `node --test tests/cloud-agent-hermes-client.test.js` failed with config values still set to `"mia-default"` / `"default"` before the production fix.
- GREEN implementation:
  - imported `normalizeCloudHermesModel()` into `src/cloud-agent/hermes-worker-manager.js`
  - normalized the worker manager’s `model` once at construction time with fallback `"mia-auto"`
  - verified normalized values appear in rendered config and returned `worker.model`

### Verification After Fix

- `node --test tests/cloud-agent-hermes-client.test.js`
- `npm run check`
