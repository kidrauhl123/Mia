# Mia Core MCP AION Alignment Design

Status: ready for user review.

## Context

Mia now has a standalone Node-based Mia Core direction, but the MCP subsystem is
still shaped like the earlier Electron-main feature: renderer IPC calls a
`src/main/mcp` service, records live in a local JSON registry, and the Core
entry imports those modules mostly as-is.

That is not enough for the new target. The target is AION-style MCP ownership:
the backend owns MCP configuration, connection testing, OAuth state, external
agent config discovery, and session injection. Electron is a client. Agent
adapters consume Core contracts; they do not assemble MCP runtime state from UI
state or duplicated local files.

This spec supersedes the operational target in
`docs/superpowers/specs/2026-06-18-custom-mcp-management-design.md`. That older
design remains useful for product UI and basic bridge behavior, but its "local
JSON + main-process feature" architecture is no longer the standard for
shipping MCP.

## Scope

First phase scope is A+B+C from the user decision:

- A. Basic usability: add/import MCP, test connection, list tools, enable it,
  then Hermes, Claude Code, Codex, and OpenClaw can actually use it in a turn.
- B. AION-style configuration and diagnostics: Core-owned records, soft delete
  semantics, detailed connection test result codes, external Agent config
  discovery, and deterministic engine injection.
- C. OAuth/auth_required: OAuth discovery, PKCE login, callback, token storage,
  refresh, logout, and authenticated status.

Team MCP is explicitly out of scope. In AION, Team MCP is a session-scoped
multi-agent collaboration server for team agents. Mia's immediate problem is
ordinary user MCP usability, not team-agent orchestration.

## Architecture

Mia Core owns a new MCP domain boundary under `src/core/mcp/` or the nearest
equivalent package boundary chosen during implementation. The boundary contains
four units:

- `registry`: persistent server records, import, update, soft delete, enable,
  and public redacted projections.
- `connection-test`: one-shot MCP initialize/initialized/tools-list checks for
  stdio, streamable HTTP, and SSE with structured error codes.
- `oauth`: OAuth 2.0 / PKCE lifecycle for HTTP MCP servers that return
  authentication challenges.
- `agent-configs`: read-only discovery of existing MCP configuration in
  supported external Agent CLIs, plus explicit import into Mia Core records.

The existing `src/main/mcp` bridge/client code may be reused where it is correct,
but Core owns the public interface and lifecycle. If a module remains physically
under `src/main/mcp` during the first implementation pass, it must be
node-constructible and must be called only through the Core MCP service from new
code.

## Data Model

The Core MCP server record uses an AION-compatible shape adapted to JavaScript:

```js
{
  id: "mcp_...",
  name: "playwright",
  displayName: "Playwright",
  description: "",
  enabled: true,
  builtin: false,
  deletedAt: null,
  transport: {
    type: "stdio" | "http" | "sse",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env: {},
    url: "",
    headers: {},
    bearerTokenEnvVar: ""
  },
  tools: [],
  lastTestStatus: "unknown" | "connected" | "disconnected" | "auth_required",
  lastConnectedAt: null,
  lastError: null,
  oauth: {
    authenticated: false,
    tokenRef: null,
    authServerUrl: null,
    scopes: []
  },
  sync: {
    hermes: { status: "pending", message: "" },
    "claude-code": { status: "pending", message: "" },
    codex: { status: "pending", message: "" },
    openclaw: { status: "pending", message: "" }
  },
  source: "manual" | "import" | "template" | "agent-config",
  sourceAgent: null,
  originalJson: {},
  createdAt: "...",
  updatedAt: "..."
}
```

The implementation may keep the first phase in `mia-mcp-servers.json` to avoid a
database migration, but the service API must behave like a repository: list
excludes soft-deleted records by default, get-by-id can resolve deleted records
for cleanup, and mutation APIs never expose raw secrets. A later SQLite move
must not change the Core public contract.

## Core API

Electron, future mobile/remote clients, and tests consume the same Core-facing
commands:

- `mcp.list({ includeDeleted?: boolean })`
- `mcp.create(input)`
- `mcp.update(id, patch)`
- `mcp.delete(id)` soft-deletes and disables a record.
- `mcp.setEnabled(id, enabled)`
- `mcp.importJson({ text, enabled, replaceExisting })`
- `mcp.testConnection(inputOrId, { persistResult })`
- `mcp.listTools(id)`
- `mcp.getAgentConfigs()`
- `mcp.importAgentConfig({ sourceAgent, serverName })`
- `mcp.oauth.checkStatus({ serverId | serverUrl })`
- `mcp.oauth.login({ serverId | serverUrl })`
- `mcp.oauth.logout({ serverId | serverUrl })`
- `mcp.getEngineSpecs(engineId, capabilities?)`
- `mcp.fingerprint()`

The existing Electron IPC names may remain as compatibility wrappers, but their
implementation calls Core. New code must not add renderer-to-main MCP behavior
that bypasses Core.

## Connection Test And Diagnostics

Connection tests return structured results instead of a generic error string:

```js
{
  ok: false,
  status: "disconnected",
  code: "command_not_found" | "permission_denied" | "start_failed" |
    "connection_failed" | "http_error" | "timeout" | "rpc_error" |
    "protocol_error" | "auth_required",
  message: "...",
  details: {
    command: "npx",
    exitCode: null,
    httpStatus: 401,
    wwwAuthenticate: "Bearer ...",
    stderrTail: "...",
    durationMs: 1532
  },
  tools: [],
  auth: {
    needsAuth: true,
    method: "oauth",
    serverUrl: "https://..."
  }
}
```

Stdio tests must resolve commands through the same PATH/managed-resource
environment used by Core turns. They must enforce a timeout and clean up the
child process tree. HTTP and SSE tests must perform MCP initialize, send the
initialized notification, then call tools/list. A 401 with an OAuth-compatible
challenge returns `auth_required` and does not mark the record as permanently
broken.

## OAuth

OAuth is Core-owned. The renderer only opens the browser/login URL and reflects
status. Core handles:

- protected-resource / authorization-server discovery where available;
- PKCE verifier/challenge generation;
- localhost callback listener on `127.0.0.1:0`;
- token exchange and secure persistence;
- refresh before expiry;
- logout/token deletion;
- adding Authorization headers to HTTP/SSE MCP transports at test and runtime.

Token persistence should use the strongest existing Mia secret storage available
in the codebase. If no secure store is available in the first implementation
pass, tokens must be stored separately from the public MCP registry, file mode
`0600`, redacted from every API response, and called out as a follow-up risk.

## External Agent Config Discovery

Core includes read-only adapters that discover existing MCP configurations from
installed Agent CLIs/config files. First phase adapters:

- Claude Code
- Codex
- OpenClaw
- Hermes

Detection is read-only and serialized per agent to avoid concurrent CLI/config
scans. Results include source agent, server name, transport, whether Mia can
import it, and a reason when import is unsafe. Importing a discovered server
creates or updates a Mia Core record only after an explicit user action.

This is intentionally different from native sync. Discovery answers "what is
already configured outside Mia?" Native sync answers "what should Mia write for
this engine?" Both are Core-owned, but they are separate flows.

## Engine Injection

Core is the only component that produces MCP specs for engines.

- Hermes receives enabled MCP servers through Core-owned runtime config. If
  Hermes cannot consume a transport directly, Core provides the local stdio
  bridge.
- Claude Code receives Core MCP specs through SDK turn options, with native CLI
  sync only as an explicit user-visible action.
- Codex receives direct stdio/HTTP specs when supported and bridge specs when
  required by transport/header limitations.
- OpenClaw/ACP receives session MCP servers filtered by initialized
  capabilities. Missing capabilities default to stdio-only unless the Core
  bridge makes a server safely available.

Every adapter must include `mcp.fingerprint()` in the session reuse key when the
engine binds MCP at session creation. A disabled/deleted MCP server must not
remain callable from a stale native session.

## Built-In Servers

`mia-app` and `mia-scheduler` remain reserved built-ins. User records cannot
override them. Core owns their specs and per-turn context writes. Built-in MCP
permission behavior can remain specialized, but user-added MCP servers go
through the normal permission prompt by default.

## UI Impact

The current "能力库 -> MCP 服务" product entry can stay. Its data must come from
Core. It needs three visible upgrades:

- connection diagnostics show the structured code and actionable message;
- OAuth-required servers show login/logout/authenticated state;
- external Agent config discovery appears as an import source, not as automatic
mutation.

No Team MCP UI is introduced in this phase.

## Error Handling

MCP setup failure should not crash Core startup or block unrelated chat turns.
However, a turn that depends on an enabled MCP server must surface a clear
unavailable-tool message instead of silently omitting the server.

Bridge startup failure marks affected engine sync states as `error`. It must not
delete user records. OAuth failure leaves the server enabled but
`auth_required`, with the old token removed only when logout or token invalidity
is confirmed.

## Testing

The implementation plan must include tests for:

- record normalization, soft delete, redaction, and import merge behavior;
- connection test result mapping for stdio command-not-found, timeout, HTTP 401
  auth_required, HTTP protocol error, SSE protocol error, and successful tools;
- OAuth PKCE callback/token/refresh/logout using fake HTTP servers;
- external agent config discovery adapters using temp homes/config files;
- engine spec conversion for Hermes, Claude Code, Codex, and OpenClaw;
- fingerprint invalidation for session-bound engines;
- Core entry wiring that proves Electron IPC calls Core MCP instead of direct
  main-process MCP state;
- renderer MCP UI states for diagnostics, OAuth login/logout, and discovered
  agent configs.

Manual smoke for the first working slice:

1. Start Mia Core with a temp `MIA_HOME`.
2. Add Playwright MCP from a template.
3. Test connection and verify tools are listed.
4. Enable it and run one Hermes or Claude Code turn that can see the tool.
5. Disable it and verify the next turn cannot call it from a stale session.

## Success Criteria

- A user can configure one MCP server once in Mia and use it through every
  supported local engine path that advertises compatible MCP support.
- A broken MCP server gives a specific diagnostic code and recommended fix.
- An OAuth-protected HTTP MCP can be authenticated, refreshed, used, and logged
  out without exposing tokens to the renderer.
- Mia can show existing Claude/Codex/OpenClaw/Hermes MCP configs and import
  supported entries on explicit user action.
- Core is the owner of MCP lifecycle. Electron is only a client.
