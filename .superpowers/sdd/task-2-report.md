# Task 2 Report: Core MCP Service Boundary And Soft Delete Compatibility

## Scope

Implemented Task 2 in `/Users/jung/GitHub/Mia-mia-core` using only the files named in the brief:

- Created `src/core/mcp/service.js`
- Replaced `src/main/mcp/mcp-service.js` with a Core compatibility wrapper
- Created `tests/core-mcp-service.test.js`
- Updated `tests/mcp-service.test.js`
- Verified `tests/startup-mcp-initializer.test.js` still passes unchanged

## TDD Sequence

### 1. Added failing tests first

Added the exact new boundary coverage required by the brief in:

- `tests/core-mcp-service.test.js`

Updated compatibility expectations in:

- `tests/mcp-service.test.js`

### 2. Verified RED

Ran the exact command from the brief:

```bash
node --test tests/core-mcp-service.test.js
```

Observed the expected failure:

- `Cannot find module '../src/core/mcp/service.js'`

This confirmed the new boundary test was genuinely red before implementation.

## Implementation Details

### `src/core/mcp/service.js`

Migrated the service body from `src/main/mcp/mcp-service.js` into Core and renamed the factory to:

- `createCoreMcpService(deps)`

Applied the Task 2 refactor exactly where required:

- switched record helpers from `src/main/mcp/mcp-records.js` aliases to Core imports from `src/core/mcp/records.js`
- introduced `createCoreMcpFileRegistry()` as the persistence boundary
- replaced inline file persistence with registry-backed:
  - `loadRecords(options = {})`
  - `saveRecords(records)`
- preserved the existing service logic for marketplace, bridge refresh, initialization, sync, runtime application, save, enable/disable, import, install, engine spec generation, and removal from native agents

### Soft delete behavior

Changed delete from physical removal to registry-backed soft delete:

- `registry.softDelete(id)`
- hidden from default `list()`
- persisted with:
  - `deletedAt`
  - `enabled: false`

Delete now applies runtime/native sync against visible survivors while persisting the full record set, including soft-deleted records.

### Failed test behavior

Changed `testServer()` so failed connection tests no longer auto-disable the record and no longer trigger runtime cleanup.

For existing saved records, the service now persists diagnostic fields directly:

- `status`
- `lastTestStatus`
- `lastTestCode`
- `diagnostics`
- `tools`
- `lastCheckedAt`
- `lastError`
- `oauth.authenticated`

This keeps the saved record enabled while preserving the most recent connection outcome.

### New service methods

Added the new boundary methods required by the brief:

- `create`
- `update`
- `testConnection`
- `listTools()`
- `getAgentConfigs()`
- `importAgentConfig(input)`
- `oauth.checkStatus(input)`
- `oauth.login(input)`
- `oauth.logout(input)`

Compatibility methods remain available unchanged:

- `list`
- `save`
- `delete`
- `setEnabled`
- `test`
- `importJson`
- `fetchMarketplace`
- `installTemplate`
- `sync`
- `refreshBridge`
- `removeFromAgents`
- `getEngineSpecs`
- `fingerprint`
- `awaitInitialization`
- `initialize`

### Compatibility wrapper

Replaced `src/main/mcp/mcp-service.js` with the exact wrapper required by the brief:

```js
"use strict";

const { createCoreMcpService } = require("../../core/mcp/service.js");

module.exports = {
  createMcpService: createCoreMcpService
};
```

## Test Updates

Adjusted compatibility tests in `tests/mcp-service.test.js` for the new contract:

- delete assertions now expect soft-delete persistence instead of an empty file
- added the required regression test for failed test diagnostics without disable
- updated older compatibility expectations that previously assumed:
  - failed tests disable servers
  - failed tests trigger native cleanup
  - delete physically removes the stored record

Also verified the startup initializer contract remains green through:

- `tests/startup-mcp-initializer.test.js`

## Focused Verification

Ran the exact required focused test command:

```bash
node --test tests/core-mcp-service.test.js tests/mcp-service.test.js tests/startup-mcp-initializer.test.js
```

Result:

- 28 tests passed
- 0 failed

Ran the exact required syntax checks:

```bash
node --check src/core/mcp/service.js
node --check src/main/mcp/mcp-service.js
```

Result:

- both commands exited successfully

## Self-Review

Checked the final diff against the Task 2 brief and verified:

- the new Core service owns the behavior formerly implemented in main
- compatibility now routes through Core
- delete is soft-delete only
- list hides deleted records by default
- failed tests persist diagnostics without auto-disable
- visible delete responses now reflect the runtime-updated surviving records
- only brief-scoped files were edited

## Commit

Created commit with message:

- `feat(core-mcp): move mcp service ownership into core`

## Concerns

None.
