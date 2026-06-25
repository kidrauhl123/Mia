# Task 2 Report: Native Marketplace Connect Flow

## Implementation summary

- Replaced the inline marketplace template list in `src/core/mcp/service.js` with the built-in catalog from `src/core/mcp/catalog.js`.
- Updated marketplace default hydration to preserve catalog-backed metadata used by Task 2: `managementMode`, `requiredInputs`, `connectionWizard`, `managedRuntime`, `expectedToolCount`, `homepage`, and `nativeName`.
- Changed `fetchMarketplace()` to return the catalog-backed built-in templates.
- Reworked `installTemplate(templateId, values)` to:
  - materialize a built-in record through `materializeBuiltinMcpRecord(...)`
  - save the initial record disabled
  - return early, still disabled, when required inputs are missing
  - leave managed templates saved but not auto-tested
  - test native templates through the existing service test path
  - enable only when the connection test returns `status === "connected"`
  - keep command-based native transport specs intact in stored/public records
  - persist failure diagnostics and a `test_failed` connection wizard state when tests do not connect

## Tests and results

Red phase:

- Added `fetchMarketplace exposes only supported native and managed templates` to `tests/core-mcp-service.test.js`
- Added `tests/core-mcp-managed-service.test.js` covering:
  - native template with no required fields tests and enables
  - native template requiring a secret saves disabled until field is supplied
  - native template stays disabled when connection test fails

Observed failing verification before implementation:

- `node --test tests/core-mcp-managed-service.test.js`
  - failed because install flow did not persist the catalog-backed native records and did not follow the connect/test/enable behavior
- `node --test tests/core-mcp-service.test.js`
  - failed because `fetchMarketplace()` still returned the old inline marketplace IDs

Green/final verification:

- `node --test tests/core-mcp-managed-service.test.js`
  - passed
- `node --test tests/core-mcp-service.test.js`
  - passed
- `node --test tests/core-mcp-catalog.test.js tests/core-mcp-managed-service.test.js tests/core-mcp-service.test.js`
  - passed, 20 tests, 0 failures

## TDD evidence

1. Wrote marketplace and native-install flow tests first.
2. Ran the new focused suites and confirmed red failures:
   - wrong marketplace IDs from the legacy inline template list
   - missing persisted records / wrong native install behavior
3. Implemented the minimal service changes in `src/core/mcp/service.js`.
4. Re-ran the focused suites to reach green.
5. Re-ran the brief’s full focused verification command before commit.

## Files changed

- `src/core/mcp/service.js`
- `tests/core-mcp-service.test.js`
- `tests/core-mcp-managed-service.test.js`
- `.superpowers/sdd/task-2-report.md`

## Self-review

- The change is scoped to catalog wiring and native install flow; existing save/test/import behavior outside marketplace templates was left alone.
- Native command specs (`transport.command` / `args`) remain present in both stored and public records, matching the clarified product rule.
- Managed templates currently return after the initial disabled save; this matches the task brief’s distinction between managed and native behavior inside `installTemplate`.
- Failure handling for native template tests keeps the record disabled and stores diagnostics via the existing `testServer(...)` path.

## Concerns

- `installTemplate(...)` now uses `tested.data.status === "connected"` as the enable gate, which matches the brief and tests, but broader managed-flow integration still depends on later tasks.
- I only ran the focused test command from the brief, not the repository’s entire test suite.
