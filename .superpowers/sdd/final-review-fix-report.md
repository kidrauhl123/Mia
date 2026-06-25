## 2026-06-25 Final Whole-Branch Review Fix

Files changed:
- `src/main/cloud/cloud-bridge-client.js`
- `src/main/model-settings-service.js`
- `tests/main-cloud-bridge-client.test.js`
- `tests/model-settings-service.test.js`

Tests run:
- `node --test tests/main-cloud-bridge-client.test.js tests/model-settings-service.test.js`
- `node --test tests/main-cloud-bridge-client.test.js tests/model-settings-service.test.js tests/mia-core-model-runtime-resolver.test.js tests/runtime-config-normalizer.test.js tests/engine-runtime-config-service.test.js`

Results:
- Added a cloud bridge regression test that proves direct bridge runs keep Core reference fields and strip transport credentials and provider metadata from `runtimeConfig`.
- Added a compact Mia save regression test that proves `saveModelSelection()` writes only Core-shaped Mia references, skips provider connection persistence, avoids `OPENAI_API_KEY` fallback, and returns `getRuntimeStatus()`.
- Focused test suite passed: 32 tests, 0 failures.
