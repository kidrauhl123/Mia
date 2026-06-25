# Task 4 Report: OAuth Token Lifecycle

## Scope

Implemented Core MCP OAuth token storage and explicit-endpoint PKCE login support. OAuth token material is stored in a dedicated runtime token file outside the public MCP registry, and public status surfaces only redacted authentication metadata.

OAuth authorization headers now flow through connection testing and SDK manager HTTP/SSE transport construction. Expired access tokens refresh when a refresh token and token endpoint are available.

## Changed Files

- `src/core/mcp/oauth-token-store.js`
- `src/core/mcp/oauth-service.js`
- `src/core/mcp/service.js`
- `src/main/mcp/mcp-sdk-client.js`
- `tests/core-mcp-oauth-service.test.js`
- `tests/core-mcp-connection-test.test.js`
- `tests/core-mcp-service.test.js`
- `tests/mcp-sdk-client.test.js`

## Tests Run

- `node --test tests/core-mcp-oauth-service.test.js`
- `node --test tests/core-mcp-oauth-service.test.js tests/core-mcp-connection-test.test.js tests/core-mcp-service.test.js tests/mcp-sdk-client.test.js`
- `node --check src/core/mcp/oauth-token-store.js`
- `node --check src/core/mcp/oauth-service.js`
- `node --check src/core/mcp/service.js`
- Additional adjacent regression: `node --test tests/mcp-service.test.js`

## Concerns

- OAuth login is intentionally limited to explicit `authorizationEndpoint` and `tokenEndpoint` inputs. `.well-known` discovery and callback token exchange remain future work.
- Existing production construction paths that inject a prebuilt manager need to pass the same OAuth service into that manager to use stored OAuth tokens during refresh/connect. The service default path wires this automatically when it owns manager construction.
