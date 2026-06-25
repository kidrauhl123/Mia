# Task 5 Report

## Summary

Extracted the pure turn-runtime helpers from `src/main.js` into `src/main/mia-core/runtime-service.js` and updated `src/main.js` to call the new service for turn bot snapshots and runtime-config overlay behavior.

## Files Changed

- Created `src/main/mia-core/runtime-service.js`
- Created `tests/mia-core-runtime-service.test.js`
- Modified `src/main.js`
- Modified `tests/main-bot-runtime-dispatcher.test.js`

## What Changed

### `src/main/mia-core/runtime-service.js`

- Added `createMiaCoreRuntimeService(deps)`.
- Moved the pure helper logic for:
  - `botWithRuntimeConfig(bot, runtimeConfig, options)`
  - `cloudBotSnapshotForTurn(snapshot, key, runtimeConfig)`
- Kept the extraction narrow and did not introduce process-control wrappers.

### `src/main.js`

- Imported `createMiaCoreRuntimeService`.
- Instantiated `miaCoreRuntime` with:
  - `normalizeAgentEngine`
  - `enginePermissionStoreTarget`
- Replaced turn helper call sites to use:
  - `miaCoreRuntime.cloudBotSnapshotForTurn(...)`
  - `miaCoreRuntime.botWithRuntimeConfig(...)`
- Removed the old local helper implementations after call sites were migrated.

### Tests

- Added `tests/mia-core-runtime-service.test.js` covering:
  - Core-profile runtime config overlay
  - runtime-selected engine normalization for cloud bot snapshots
- Updated `tests/main-bot-runtime-dispatcher.test.js` so the dispatcher path asserts Core-shaped runtime config fields (`providerConnectionId`, `modelProfileId`, `model`) instead of relying only on device routing.

## Test Runs

### Required red step

- `node --test tests/mia-core-runtime-service.test.js`
- Result: failed as expected before implementation because `src/main/mia-core/runtime-service.js` did not exist.

### Required focused green step

- `node --test tests/mia-core-runtime-service.test.js tests/main-bot-runtime-dispatcher.test.js tests/runtime-config-normalizer.test.js`
- Result: PASS

## Additional Verification

- Ran `node --test tests/project-structure-check.test.js`
- Result: FAIL
- Cause: an existing assertion still expects the permission-mode pruning logic to appear in `src/main.js`. After this extraction, that logic now lives in `src/main/mia-core/runtime-service.js`.

## Follow-up Fix

- Updated `tests/project-structure-check.test.js` so the cloud bridge structure assertion reads `src/main/mia-core/runtime-service.js` for the permission-mode pruning logic:
  - `enginePermissionStoreTarget(agentEngine) !== "root-mode"`
  - `delete configForEngine.permissionMode`
- Kept the rest of the cloud bridge structure assertions anchored to `src/main.js` and `src/main/cloud/cloud-bridge-client.js`.

## Final Test Evidence

- Ran `node --test tests/mia-core-runtime-service.test.js tests/main-bot-runtime-dispatcher.test.js tests/runtime-config-normalizer.test.js tests/project-structure-check.test.js`
- Result: PASS

## Final Commit

- `test: align structure check with mia core runtime service extraction`

## Commit

- `feat: introduce mia core turn runtime service`

## Review Fix: Core Runtime Boundary

- Updated `tests/main-bot-runtime-dispatcher.test.js` to treat `baseUrl`, `apiKeyEnv`, and `apiMode` as regression input only, not valid responder output.
- The dispatcher test now asserts the responder receives Core-shaped runtime config only:
  - routing and engine fields: `deviceId`, `agentEngine`
  - Core model reference fields: `providerConnectionId`, `modelProfileId`, `model`
  - negative checks: `baseUrl`, `apiKeyEnv`, and `apiMode` are absent
- Updated `src/main/social/bot-invocation.js` to normalize incoming invocation runtime config through `normalizeTurnRuntimeConfig()` before passing it to the responder, preserving the existing bot-engine override behavior while stripping renderer-native fields.

## Review Fix Test Evidence

- Red step:
  - `node --test tests/main-bot-runtime-dispatcher.test.js`
  - Result before code change: FAIL because `calls.responder[0].runtimeConfig` still had `baseUrl`
- Green step:
  - `node --test tests/main-bot-runtime-dispatcher.test.js`
  - Result after code change: PASS
- Covering suite:
  - `node --test tests/mia-core-runtime-service.test.js tests/main-bot-runtime-dispatcher.test.js tests/runtime-config-normalizer.test.js tests/project-structure-check.test.js`
  - Result: PASS

## Review Fix Commit

- `fix: normalize bot invocation runtime config`

## Concerns

- None.
