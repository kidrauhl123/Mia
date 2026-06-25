# Mia Managed MCP Runtime And Multi-Agent Exposure Design

Date: 2026-06-25

Status: ready for user review

## Context

Mia must ship a complete MCP mechanism, not only an MCP registry. The current
Core MCP work already gives Mia a useful base: Core-owned server records,
connection testing, a local SDK client manager, bridge spec generation, and
engine-specific conversion for Hermes, Claude Code, Codex, and OpenClaw. That
base is still incomplete as a product because it does not yet manage connector
processes, guided login, process health, user-facing logs, refresh/restart
semantics, and per-agent exposure state as one coherent lifecycle.

LobsterAI is the reference for a complete local MCP lifecycle. It stores MCP
records, starts enabled servers through the MCP SDK transports, discovers tools,
runs a loopback callback bridge, writes OpenClaw plugin config, and refreshes or
restarts the gateway when the tool manifest changes.

AION is the reference for multi-agent scale. It does not duplicate one bridge
implementation per agent. It uses an Agent catalog and adapter boundary: MCP
records are owned centrally, agent-specific config adapters handle external CLI
detection/sync, and ACP agents receive enabled MCP servers during session
creation after capability filtering.

Mia is different from Lobster because Mia is the GUI for four local Agent
engines, not just OpenClaw. Therefore Mia needs one Core MCP runtime and four
agent exposure adapters, not four unrelated MCP systems.

## Product Decision

Enabled user MCP servers are globally available to Mia's supported local Agent
engines by default: Hermes, Claude Code, Codex, and OpenClaw.

When a conversation/session is created, Mia saves an MCP snapshot for that
conversation. The snapshot records which MCP servers were selected, their names,
transports, and exposure status at creation time. Agent sessions whose MCP
binding happens at session creation must include the Core MCP fingerprint in the
reuse key. If a user disables, deletes, or materially edits an MCP server, stale
sessions must be recreated before the next prompt so the removed tool cannot
remain callable.

Per-conversation MCP customization can come later. The default product behavior
is global enabled MCP plus a session snapshot for correctness and debuggability.

## Goals

- Give Mia a Lobster-grade MCP lifecycle: install or locate, configure, login,
  start, health-check, connect, list tools, route calls, stop, restart, and show
  logs.
- Keep MCP ownership in Mia Core. Renderer, Electron main, and Agent adapters
  call Core; they do not each own MCP state.
- Expose one enabled MCP set to all supported Agent engines through a consistent
  adapter contract.
- Use native Agent MCP support when it is available and safe.
- Use the Mia MCP bridge when an Agent cannot consume a transport, custom
  headers, OAuth state, or managed process directly.
- Make the UI teach the user what is required: install state, login state,
  process state, connection state, tool count, and which Agents can use the MCP.

## Non-Goals

- Team MCP is not part of this design. AION's Team MCP is a collaboration
  server for multi-agent orchestration; this design is ordinary user MCP
  usability.
- Mia does not need to copy Lobster's OpenClaw-only plugin model for every
  Agent. OpenClaw may need an OpenClaw plugin path, but the Core MCP bridge is
  generic.
- This design does not require an immediate SQLite migration. The repository
  API must behave like a durable Core store even if the first implementation
  still uses JSON files.

## Architecture

Mia Core owns five MCP units.

`CoreMcpRegistry` stores user and built-in MCP records, soft deletion, enabled
state, redacted projections, import/export, and fingerprints.

`CoreMcpRuntime` owns active MCP SDK clients. It starts enabled MCP servers or
connects to URL transports, discovers tools with `tools/list`, routes
`callTool`, applies Mia permission prompts, tracks recent logs, and refreshes
when enabled records change.

`ManagedConnectorSupervisor` owns Mia-managed external connector processes such
as Xiaohongshu. It can install or locate runtime assets, run login commands,
start/stop/restart the process, watch ports, capture logs, and publish clear
states: `not_installed`, `login_required`, `stopped`, `starting`, `running`,
`connected`, `error`.

`McpBridgeServer` exposes Core-routed tool calls over a loopback callback with a
secret. It is transport normalization for Agents that need a bridge. It is not
OpenClaw-specific.

`AgentExposureAdapter` converts the Core MCP state into each Agent's usable
shape and reports exposure state. First implementations are `hermes`,
`claude-code`, `codex`, and `openclaw`.

## Data Model

Extend the Core MCP record with managed runtime and exposure metadata:

```js
{
  id: "mcp_...",
  name: "xiaohongshu",
  nativeName: "xiaohongshu-mcp",
  enabled: true,
  source: "marketplace" | "manual" | "import" | "agent-config",
  transport: {
    type: "stdio" | "http" | "sse" | "streamable_http",
    command: "npx",
    args: [],
    env: {},
    url: "http://127.0.0.1:18060/mcp",
    headers: {},
    bearerTokenEnvVar: ""
  },
  managedRuntime: {
    mode: "none" | "managed_process" | "external_process",
    installState: "not_required" | "not_installed" | "installed" | "error",
    authState: "not_required" | "login_required" | "authenticated" | "error",
    processState: "stopped" | "starting" | "running" | "exited" | "error",
    healthState: "unknown" | "healthy" | "unhealthy",
    repo: "",
    package: "",
    workingDirectory: "",
    installCommand: [],
    loginCommand: [],
    startCommand: [],
    healthUrl: "",
    expectedTools: 0,
    lastExitCode: null,
    lastLogTail: ""
  },
  exposure: {
    hermes: { status: "available", path: "native", message: "" },
    "claude-code": { status: "available", path: "native", message: "" },
    codex: { status: "available", path: "bridge", message: "" },
    openclaw: { status: "available", path: "acp", message: "" }
  },
  tools: [],
  lastTestStatus: "unknown" | "connected" | "disconnected" | "auth_required",
  diagnostics: {}
}
```

Conversation/session snapshots store:

```js
{
  mcpFingerprint: "...",
  mcpServerIds: ["mcp_..."],
  mcpServers: ["xiaohongshu"],
  mcpStatuses: [
    { id: "mcp_...", name: "xiaohongshu", status: "loaded", path: "bridge" }
  ]
}
```

## Runtime Lifecycle

Installing a marketplace template only creates a disabled or guided record
unless the template can be safely started without credentials. Enabling a record
triggers runtime refresh.

For a manual external HTTP server, Core verifies the URL and shows setup
instructions but does not claim to manage the process.

For a managed connector, Core runs the supervisor:

- ensure runtime assets are installed or located;
- run login flow if `authState` requires it;
- start the process with controlled env and working directory;
- wait for health URL or MCP initialize success;
- connect through the SDK manager and list tools;
- update tool manifest, diagnostics, and exposure statuses;
- keep a redacted log tail available in the UI;
- stop or restart on disable/delete/config change.

The Xiaohongshu target should move from "Mia only connects to
`http://localhost:18060/mcp`" to a managed connector template when the connector
is stable enough for Mia to own its lifecycle. Until that is implemented, the UI
must clearly say it is an external process and show the exact login/start steps.

## Agent Exposure

Each `AgentExposureAdapter` receives enabled Core records, bridge facts, and the
Agent's capability report. It returns both runtime specs and user-facing status.

Claude Code gets native `mcpServers` through the SDK turn options. Native CLI
sync remains an explicit user-visible action, not the only runtime path.

Codex gets native stdio or HTTP specs when possible. Codex falls back to
`mia-mcp-bridge` for SSE or HTTP records with arbitrary headers that Codex
cannot express directly.

Hermes gets direct config when it supports the transport. If Hermes cannot
consume URL transports directly, it receives `mia-mcp-bridge`.

OpenClaw gets ACP `mcpServers` during `session/new`, filtered by initialized MCP
capabilities. If OpenClaw lacks a transport capability, Mia provides the bridge
as a stdio MCP server. If an OpenClaw gateway/plugin surface is available, the
OpenClaw adapter may also write the bridge callback URL, secret, and tool
manifest to that plugin config and restart the gateway when the manifest
changes.

## Bridge Policy

The bridge is a compatibility path, not a second source of truth. Core MCP
runtime remains the only component that calls user MCP tools. Bridge consumers
submit `{ server, tool, args }` to Core, and Core applies permission prompts,
timeouts, logging, and redaction.

The bridge binds only to `127.0.0.1`, uses a per-process random secret, and
never exposes raw env, headers, OAuth tokens, or connector secrets.

If bridge startup fails, affected Agent exposure states become `error`. User MCP
records are not deleted.

## UI Requirements

The MCP Services UI must show the complete state machine instead of making the
user infer what is wrong.

Each installed MCP row shows:

- enabled toggle;
- transport badge;
- install/auth/process/connection state;
- tool count and last test result;
- per-Agent exposure path: `native`, `bridge`, `acp`, `unsupported`, or `error`;
- setup guide for external connectors;
- login/start/stop/restart/detect actions when the template supports them;
- redacted log tail and actionable diagnostics.

Marketplace templates must be honest about responsibility. A template can be:

- `managed`: Mia installs or locates it, logs in, starts it, and monitors it.
- `external`: the user starts it outside Mia; Mia only connects.
- `native`: no long-running connector process is needed.

The Xiaohongshu card must not look one-click ready until the managed supervisor
exists. It should say whether Mia is managing the process or only connecting to
an already-running service.

## Refresh And Session Invalidation

Any change to enabled MCP records, transport details, auth state, or managed
runtime state recomputes the Core MCP fingerprint.

Claude Code, Codex, and OpenClaw adapters include that fingerprint in their
session reuse keys. If the fingerprint changes, they do not resume an old Agent
session whose MCP set may be stale.

OpenClaw ACP sessions receive MCP servers at `session/new`; therefore OpenClaw
must recreate the ACP session before the next prompt when the fingerprint
changes.

Codex app-server reuse keys include the MCP fingerprint so a changed MCP set
creates or selects the correct app-server runtime.

## Testing

Unit tests cover record normalization, fingerprint changes, managed runtime
state transitions, bridge spec generation, and per-Agent exposure conversion.

Integration tests cover:

- stdio MCP connection and tool discovery;
- HTTP MCP connection and tool discovery;
- bridge-routed tool call with permission allow and deny;
- disable/delete invalidating the fingerprint;
- Codex requiring bridge for SSE/custom-header HTTP records;
- OpenClaw ACP receiving native MCP servers when capabilities allow them and
  bridge when they do not;
- managed connector supervisor success and failure paths with a fake connector.

Renderer tests cover the MCP row state labels and Xiaohongshu setup guidance.

## Rollout

Phase 1 finishes the Core runtime lifecycle for existing manual/template MCP
records and makes exposure status visible for all four Agents.

Phase 2 adds `ManagedConnectorSupervisor` and converts Xiaohongshu from an
external-only template to a managed connector template.

Phase 3 adds per-conversation MCP selection and more marketplace templates.

## Open Questions

The first managed Xiaohongshu implementation must decide whether Mia vendors a
known connector version, downloads/builds it from source, or asks the user to
select an existing checkout. The UI and security model are different for each.

Mia also needs a durable decision on secret storage. If secure OS keychain
storage is not available in the first implementation, tokens and secrets must
remain in a separate `0600` file and be redacted from every public API response.
