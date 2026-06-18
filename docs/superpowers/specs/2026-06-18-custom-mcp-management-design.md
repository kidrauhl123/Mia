# Custom MCP Management Design

Date: 2026-06-18

Status: proposed

## Goal

Mia should provide a product-grade custom MCP management center. A user configures an MCP server once in Mia, then Mia makes that server usable by every supported local Agent engine: Hermes, Claude Code, Codex, and OpenClaw through ACP.

This feature optimizes for practical availability. A working tool is more valuable than strict runtime isolation. When the user explicitly adds or enables an MCP server in Mia, Mia may write the required native Agent CLI configuration, as long as the UI makes the sync target and result visible and can clean it up when the server is deleted or disabled.

## Reference

AionUi provides the closest working pattern:

- `mcp.config` stores user MCP server records.
- The Tools settings page owns add, edit, delete, enable, import, and connection test flows.
- Agent-specific MCP adapters sync servers into native CLI config where needed.
- ACP sessions receive MCP servers during `session/new` or `session/load`, filtered by MCP transport capabilities.
- MCP connection tests use the official MCP SDK and list tools instead of trusting config writes.

Mia should reuse that product shape, adapted to its current Electron main, preload, renderer, and Agent adapter boundaries.

## Product Scope

The finished product includes:

- A Settings section named MCP services.
- Add, edit, delete, enable, disable, duplicate-name replacement, and JSON import.
- Transport support for `stdio`, `http`, `sse`, and `streamable_http`.
- Connection testing through MCP SDK `initialize` and `tools/list`.
- Visible status per server: `connected`, `disconnected`, `unsupported`, `auth_required`.
- Visible sync status per engine: Hermes, Claude Code, Codex, OpenClaw.
- Tool list preview after a successful connection test.
- External CLI sync for Claude Code and Codex.
- Runtime config injection for Hermes.
- ACP session injection for OpenClaw.
- Cleanup from external CLI configs when a server is deleted or disabled.
- Existing Mia permission prompts for MCP tool use, showing `server.tool`, arguments, and allow or deny controls.

No supported local Agent engine should be deliberately left out.

## Data Model

Add a Mia-owned settings file under the runtime home:

```text
mia-mcp-servers.json
```

Each server record:

```json
{
  "id": "mcp_1710000000000",
  "name": "xiaohongshu",
  "description": "Xiaohongshu MCP",
  "enabled": true,
  "status": "connected",
  "tools": [{ "name": "search_notes", "description": "..." }],
  "transport": {
    "type": "http",
    "url": "http://localhost:18060/mcp",
    "headers": {}
  },
  "sync": {
    "hermes": { "status": "synced", "message": "" },
    "claude-code": { "status": "synced", "message": "" },
    "codex": { "status": "synced", "message": "" },
    "openclaw": { "status": "available", "message": "" }
  },
  "createdAt": 1710000000000,
  "updatedAt": 1710000000000,
  "lastCheckedAt": 1710000000000,
  "lastError": "",
  "originalJson": "{...}"
}
```

Transport shapes:

- `stdio`: `command`, `args`, `env`
- `http`: `url`, `headers`, optional `bearerTokenEnvVar`
- `sse`: `url`, `headers`
- `streamable_http`: `url`, `headers`, optional `bearerTokenEnvVar`

Secrets are allowed in env values and headers because many MCP servers need them, but they must be masked in UI summaries and never written to logs.

## Main Process Services

Add a focused main service, for example `src/main/mcp-service.js`, responsible for:

- Normalizing and validating server records.
- Reading and writing `mia-mcp-servers.json`.
- Importing common `mcpServers` JSON formats.
- Testing MCP connections with `@modelcontextprotocol/sdk`.
- Syncing and removing servers from external Agent CLIs.
- Producing engine-specific MCP specs for adapters.

Renderer must not write native Agent config files directly.

## IPC And Preload

Add narrow IPC channels:

- `mcp:list`
- `mcp:save`
- `mcp:delete`
- `mcp:test`
- `mcp:import-json`
- `mcp:sync`
- `mcp:remove-from-agents`

Expose them through `window.mia.mcp`. All return values must be serializable objects with success, data, and error fields.

## Settings UI

The MCP settings UI should be work-focused and dense:

- The primary entry point is the existing settings gear in the left rail, then a top-level settings tab named `MCP 服务`.
- The tab sits after `模型` in the current settings tab list: `账号与同步`, `外观`, `模型`, `MCP 服务`.
- Do not bury MCP under `模型`; MCP servers are shared Agent tools, not model-provider settings.
- Error states and empty states in Agent chat may include a secondary action that opens Settings directly to `MCP 服务`.
- List servers with name, transport badge, enabled toggle, connection status, sync status, and tool count.
- Add server opens a form with a transport segmented control.
- HTTP/SSE form fields: URL, headers, bearer token env var.
- Stdio form fields: command, args, env.
- JSON import accepts Cursor, Claude, Codex, and generic `mcpServers` objects.
- Test button runs connection test and updates status/tools.
- Sync button writes enabled servers to supported native agents.
- Delete asks for confirmation and then cleans up synced native config.

The UI should not require the user to understand engine internals. It should show useful errors such as "Codex does not support custom headers; use bearer token env var" rather than raw CLI output only.

## Engine Sync And Injection

### Claude Code

Claude Code supports stdio, SSE, HTTP, and streamable HTTP through the CLI and SDK.

Sync rules:

- Stdio: `claude mcp add-json -s user <name> <json>`
- HTTP/SSE: `claude mcp add -s user --transport <http|sse> <name> <url> --header "..."`
- Remove: try `user`, `local`, and `project` scopes.

Runtime rule:

- Continue passing enabled MCP specs to the Claude Agent SDK `mcpServers` option so changes work in Mia turns without relying only on global CLI state.

### Codex

Codex supports stdio and streamable HTTP through `codex mcp add`.

Sync rules:

- Stdio: `codex mcp add <name> --env KEY=VALUE -- <command> ...args`
- HTTP/streamable HTTP: `codex mcp add <name> --url <url>`
- Bearer auth: `--bearer-token-env-var <ENV_VAR>`
- Remove: `codex mcp remove <name>`

Mia's Codex app-server override must support:

```text
mcp_servers.<name>.command=...
mcp_servers.<name>.args=[...]
mcp_servers.<name>.env.KEY=...
mcp_servers.<name>.url="..."
mcp_servers.<name>.bearer_token_env_var="..."
```

### Hermes

Hermes receives enabled MCP servers in Mia's generated `config.yaml`.

If the installed Hermes supports `url` MCP servers, write HTTP/SSE entries directly. If not, Mia must provide a local stdio bridge that proxies HTTP/SSE/streamable HTTP MCP servers through the MCP SDK. The UI should mark Hermes as `synced` only when the generated config or bridge path is valid.

### OpenClaw / ACP

Mia's OpenClaw adapter currently sends `mcpServers: []` during `client.newSession`. This must become the enabled MCP list.

Conversion rules follow ACP SDK `McpServer`:

- Stdio: `{ name, command, args, env: [{ name, value }] }`
- HTTP: `{ type: "http", name, url, headers: [{ name, value }] }`
- SSE: `{ type: "sse", name, url, headers: [{ name, value }] }`
- `streamable_http` maps to ACP HTTP when the backend capability says HTTP is supported.

OpenClaw/ACP must filter by initialized MCP capabilities when available. When capabilities are missing, default to stdio only unless a stdio bridge is available. If a server is unsupported, show that in the sync status instead of silently omitting it.

Because ACP MCP servers are supplied at session creation time, MCP config changes require a new ACP session. Mia should compute an MCP fingerprint and stop or recreate the OpenClaw ACP session before the next prompt when the fingerprint changes.

## MCP Fingerprint

Every adapter should receive a stable fingerprint of enabled MCP server names and transport settings. When the fingerprint changes:

- New conversations use the new MCP config immediately.
- Existing resumable native sessions should be recreated when the underlying engine binds MCP at session creation.
- The user should not be able to call a deleted or disabled MCP from a stale Agent session.

This is especially important for OpenClaw/ACP and long-running Hermes workers.

## Permissions

MCP tool calls should use the existing Mia permission coordinator.

Prompt details:

- Engine name.
- MCP server name.
- Tool name.
- Short tool description if available.
- JSON argument preview with sensitive fields masked.

Team/internal Mia MCP servers may keep existing special-case approval behavior. User-added MCP servers should not be auto-approved by default.

## Import Behavior

JSON import should accept:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package"],
      "env": {}
    }
  }
}
```

and:

```json
{
  "mcpServers": {
    "server-name": {
      "url": "http://localhost:18060/mcp",
      "type": "http",
      "headers": {}
    }
  }
}
```

Duplicate names replace the existing record after confirmation. Imported servers are enabled only after validation succeeds; a server that cannot be tested may still be saved as disabled.

## Error Handling

Common failures must be visible and actionable:

- CLI not found.
- Unsupported transport for a target engine.
- MCP server cannot connect.
- HTTP server requires auth.
- `npx` or command not found from app-launched PATH.
- Codex cannot accept arbitrary HTTP headers.
- OpenClaw ACP backend did not advertise HTTP or SSE capability.

All sync operations should return per-engine results rather than a single opaque failure.

## Testing

Add focused tests for:

- MCP settings normalization and migration defaults.
- JSON import parser.
- Connection test conversion for stdio, HTTP, SSE, and streamable HTTP.
- Codex CLI args and app-server config override generation.
- Claude CLI command generation.
- Hermes `config.yaml` generation for stdio and URL MCP entries or bridge fallback.
- OpenClaw ACP `mcpServers` conversion and fingerprint-triggered session recreation.
- Renderer CRUD behavior for add, edit, delete, enable, disable, import, and status rendering.
- Permission payload formatting for MCP tool requests.

## Acceptance Criteria

The feature is product-ready when:

- A Xiaohongshu HTTP MCP at `http://localhost:18060/mcp` can be added in Mia, tested, and show tools.
- The same server is available to Codex, Claude Code, Hermes, and OpenClaw where the installed engine supports the transport or Mia provides a bridge.
- Deleting or disabling the server removes it from Codex and Claude Code native configs and prevents stale Mia sessions from calling it.
- Unsupported engines show an explicit status and reason.
- Sensitive env/header values are masked in UI and logs.
- Existing built-in `mia-app` and `mia-scheduler` MCP behavior remains intact.
