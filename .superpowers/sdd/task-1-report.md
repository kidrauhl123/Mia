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
