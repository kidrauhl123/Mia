# Task 6 Report: Core MCP IPC Surface

## Scope

- Added Core AION MCP IPC channel constants for tool discovery, agent config discovery/import, and OAuth status/login/logout.
- Registered main-process MCP IPC handlers that delegate to the injected MCP service.
- Exposed the new methods under `window.mia.mcp`.
- Switched Mia Core to construct `createCoreMcpService` directly from `src/core/mcp/service.js` while preserving the existing manager, bridge, OAuth token/service, PATH env, fetch, and no-op external opener injections.
- Added source-level assertions for the IPC/preload surface and Core MCP factory wiring.

## Changed Files

- `src/shared/ipc-channels.js`
- `src/main/ipc/mcp-ipc.js`
- `src/preload.js`
- `src/core/mia-core.js`
- `tests/mcp-ipc-preload.test.js`
- `tests/mia-core-engines.test.js`
- `.superpowers/sdd/task-6-report.md`

## Tests Run

- `node --test tests/mcp-ipc-preload.test.js tests/mia-core-engines.test.js`
- `node --check src/core/mia-core.js src/shared/ipc-channels.js src/main/ipc/mcp-ipc.js src/preload.js`
- `node --check src/core/mia-core.js`
- `node --check src/shared/ipc-channels.js`
- `node --check src/main/ipc/mcp-ipc.js`
- `node --check src/preload.js`

All verification commands exited with status 0.

## Concerns

- `localAgentEngineService` does not expose a safe generic `runCommand`, so `agentConfigRunner` was intentionally omitted and the Core MCP agent config service will use its default runner.
