# Agent Runtime Isolation and Slim Packaging Design

Date: 2026-06-03

Status: implemented in the default packaging path as of 2026-06-07. This file is retained as the design record; current operational commands live in `README.md`, `CLAUDE.md`, and `docs/DEPLOYMENT.md`.

## Goal

Mia should be a lightweight desktop app that orchestrates native local agents without bundling a full Hermes runtime into the default installer.

When the user talks to Hermes, Claude Code, Codex, or future supported agents through Mia, Mia owns the Bot identity, session mapping, memory, and app tools for that conversation. When the user uses those official agents outside Mia, their native app or CLI should keep its own sessions, memory, and configuration.

## Product Principles

1. Desktop Mia should prefer local agents. It must not silently route ordinary desktop chat through a cloud Hermes runtime.
2. Mia may reuse native installs and native authentication, but Mia must not silently reuse native sessions, histories, memories, or app-tool configuration.
3. No global native agent configuration should be modified without a direct user action and a clear product reason.
4. If Mia-controlled isolation cannot be created, the turn should fail visibly or run in a restricted no-agent state. It must not fall back to the user's official native home in a way that pollutes native state.
5. The default production installer should not include `vendor/hermes-runtime/*`. A separate explicit fallback build may include Hermes for development, emergency support, or controlled distribution.

## Current Evidence

The default package path is now slim:

- `package.json` keeps `dist:mac` and `dist:win` free of `hermes:runtime:*`.
- `electron-builder.with-hermes.json` owns the explicit bundled-runtime package path.
- `src/check.js` and `tests/packaging-hermes-runtime.test.js` guard that default packages do not include `vendor/hermes-runtime/*`.

Mia has the first runtime-isolation pass in production source:

- Bot identities live under Mia runtime files such as `runtime/bots/<bot>.md`.
- `agent-session-store` maps `(engine, bot, Mia session)` to native session ids.
- Hermes receives Bot headers and a Mia runtime context.
- Codex runs with a Mia-controlled `CODEX_HOME`, excluding native session/history files when linking safe user Codex state.
- `mia-app` MCP exists while scheduler compatibility remains available for adapters that still need it.
- Mia memory is represented as a bounded `## Mia Bot Memory` block with shared and per-bot sections.

The remaining areas are product depth, not migration blockers:

- Hermes installation can keep improving source selection, repair UX, mirror reliability, and checksum reporting.
- Claude Code profile isolation still depends on what the SDK can isolate per run without writing global Claude configuration.
- Mia app MCP should expand gradually after permission behavior is verified for each write tool.

## Recommended Strategy

Use a hybrid strategy:

- Default production packages are slim and do not include Hermes.
- A deliberately named fallback package path can include Hermes, for example `dist:mac:with-hermes` and `dist:win:with-hermes`.
- The default slim package cut happens only after optional install, runtime isolation, memory injection, and app MCP have verification coverage.

This avoids shipping a fragile no-agent experience while still making the final default installer small.

## Target Agent Behavior

### Hermes

Mia can use one of three Hermes sources:

- A user-installed official Hermes command.
- A Mia-installed official Hermes runtime in Mia's private runtime directory.
- A fallback bundled Hermes runtime only in explicit fallback builds.

Mia must launch Hermes with Mia-owned `HERMES_HOME`, `MIA_HOME`, API key, runtime config, MCP config, and Bot context. Mia should not read or write the user's official `~/.hermes` memories or sessions for Mia conversations.

### Codex

Mia should use the user-installed Codex CLI and reuse safe auth/model/cache state. It should keep Mia conversations under a Mia-owned `CODEX_HOME`.

Allowed links from the user's `~/.codex`:

- Authentication and token files.
- Model cache and non-session configuration required for login reuse.

Disallowed links:

- `sessions/`
- `history.jsonl`
- `session_index.jsonl`
- Native memory or future session/history stores.

If Mia cannot create the Mia-owned `CODEX_HOME`, Codex chat through Mia must fail visibly. It must not silently run against the user's default Codex home.

### Claude Code

Mia should use the user-installed `claude` executable and the Claude Agent SDK so user authentication is reused. Mia should inject Bot persona, Mia runtime context, Mia memory, and Mia app MCP per run through SDK options or a Mia-owned local plugin.

Claude Code support must avoid writing Mia MCP, Mia memory, or Mia Bot state into global Claude settings. If the SDK cannot provide a separate home/profile boundary for a given state category, Mia must document the limitation and keep that category per-run only.

### OpenClaw

OpenClaw is no longer detection-only. Latest AionUi treats new OpenClaw conversations as an ACP backend (`agent_type: acp`, `backend: openclaw`) and marks the old `openclaw-gateway` runtime type as deprecated. Mia now launches the user-installed OpenClaw CLI through its ACP bridge (`openclaw acp`) and maps Mia sessions to OpenClaw Gateway sessions with a stable `_meta.sessionKey`. This requires a configured, reachable OpenClaw Gateway; if the gateway is not on the default URL, the bot can pass `openclawGatewayUrl` through the ACP adapter. The legacy `openclaw agent --json` path is only a compatibility fallback when explicitly requested. Mia must not force `--local` by default and must not rewrite the user's global OpenClaw config.

## Session Policy

Mia's session key remains:

```text
<engine>:<bot_key>:<mia_session_id>
```

Each adapter may store the native session id returned by the native engine, but the native session id is only an implementation detail. Mia UI, cloud sync, conversation routing, permissions, and memory are keyed by Mia's conversation/session identity.

Rules:

- A Bot using Claude Code, Codex, or Hermes should resume only the native session mapped to the current Mia session.
- Different Bots must not share native sessions by default.
- Different Mia conversations for the same Bot must not share native sessions unless Mia explicitly implements a user-visible "continue same native thread" action.
- Native sessions created outside Mia must not be imported into active Mia conversations by default.
- Listing native history for discovery is allowed only as a read-only import/browse feature; it must not become the default resume path.

## Memory Policy

Inside Mia, Mia memory is authoritative. Native agent memory is not the Bot memory source.

Mia should maintain:

- Shared user memory: stable user-wide preferences and facts that may apply across Bots.
- Per-Bot memory: long-lived identity, relationship, and facts scoped to one Bot.
- Project/native context: project rules and native agent configuration, treated as environment context, not Mia Bot memory.

Mia memory should be injected as one bounded block:

```text
## Mia Bot Memory
source: mia
bot: <bot_key>
conversation: <mia_session_id>

### Shared User Memory
...

### Bot Memory
...
```

Rules:

- The memory block is generated by Mia, not by reading native agent memory stores.
- The memory block is injected once per turn through the adapter's most authoritative instruction channel.
- If an adapter must place memory into the user prompt because the native SDK lacks system instruction support, the block must retain stable delimiters and tests must verify it is not duplicated.
- Mia should not copy native memory into Mia memory in the first implementation.
- When users run Hermes, Claude Code, or Codex outside Mia, Mia does not set Mia-owned homes and does not inject Mia memory.

## MCP Policy

Mia app capabilities should be exposed through a unified app-facing MCP server named `mia-app`.

Scheduler behavior should remain compatible while adapters converge on `mia-app`.

Initial tool groups:

- Scheduler: `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`, `schedule_pause`, `schedule_resume`.
- Skills: search marketplace, inspect skill detail, install a skill for the current user.
- Social/group: list conversations, create a group, add members, remove members, post a message where appropriate.
- Bots: list Bots and read basic identity/runtime metadata.

Permission model:

- Read-only tools can run automatically.
- Write tools that change tasks, install skills, create groups, invite members, remove members, or post messages require Mia permission confirmation unless a prior scoped allow rule covers the exact operation.
- Agent processes receive only a short-lived local daemon token or scoped app token. They must not receive Mia cloud account credentials.
- Tool descriptions must accurately state product constraints and should not advertise unavailable app features.

Failure behavior:

- If MCP setup fails, chat may continue, but Mia should tell the agent and user that Mia app tools are unavailable for that turn.
- A failed write tool should return an explicit failure result and should not be retried blindly by Mia.

## Hermes Optional Installer

Hermes installation is user-triggered from inventory or settings.

The installer should support:

- Detect installed user Hermes command.
- Install official Hermes into Mia's private runtime directory when missing.
- Repair or reinstall Mia's private Hermes runtime when broken.
- Show progress, logs, selected source, version, checksum, and install path.
- Use official source artifacts first.
- Support a Mia mirror for network reliability, while preserving upstream version metadata and checksum verification.
- Leave official user-level Hermes usable outside Mia.

Installer metadata should be written under Mia's runtime directory. It should include source kind, source URL, upstream version/ref, checksum, installed time, and installer version.

## Packaging Policy

Default production packages:

- `dist:mac` must not run `hermes:runtime:*`.
- `dist:win` must not run `hermes:runtime:*`.
- Default electron-builder resources must not include `vendor/hermes-runtime/*`.
- Packaged app resources must not contain `hermes-runtime`.

Explicit fallback packages:

- `dist:mac:with-hermes` may build and include `vendor/hermes-runtime/mac-arm64`.
- `dist:win:with-hermes` may build and include `vendor/hermes-runtime/win-x64`.
- Fallback package names or metadata must make the bundled runtime explicit.

Verification:

- Static tests should fail if default packaging scripts run `hermes:runtime:*`.
- Static tests should fail if default `extraResources` include `vendor/hermes-runtime/*`.
- Packaged audit should fail if default package resources contain `hermes-runtime`.
- Fallback package tests should prove the fallback path is explicit and separate.

## Phased Implementation

### Phase 1: Agent Inventory and UI

Build a normalized local agent inventory for Hermes, Claude Code, Codex, and OpenClaw. Show installed/missing/usable states in onboarding and settings. Allow no-agent users to continue. Offer official install actions for missing installable engines.

Acceptance evidence:

- Unit tests cover inventory shape, missing command behavior, source semantics, OpenClaw ACP-backend compatibility usability, and cache reset.
- Renderer tests cover no-agent onboarding, Hermes install action, skip path, and legacy runtime status fallback.
- Runtime status exposes `agentInventory`.

### Phase 2: Optional Hermes Installer

Make Hermes installation a first-class optional flow while the fallback bundled runtime still exists for explicit fallback builds.

Acceptance evidence:

- Installer tests cover official install, mirror install, checksum mismatch, repair/reinstall, install cancellation, and cache invalidation.
- UI tests cover progress logs, failure state, retry, repair, and skip.
- Runtime status distinguishes system Hermes detection, Mia-installed Hermes, fallback bundled Hermes, and missing Hermes.

### Phase 3: Runtime and Session Isolation

Introduce explicit runtime profile builders for Hermes, Codex, and Claude Code.

Acceptance evidence:

- Tests prove Codex uses Mia-owned `CODEX_HOME` and does not link session/history files.
- Tests prove Codex does not fall back to user `~/.codex` when Mia home setup fails.
- Tests prove Hermes runs with Mia-owned `HERMES_HOME` and does not read official `~/.hermes` memory/session paths.
- Tests prove Claude Code uses per-run Mia context/plugin/MCP without writing Mia config into global Claude settings.
- Adapter tests prove `(engine, bot, Mia session)` maps to separate native sessions.

### Phase 4: Mia Memory System

Add Mia-owned shared user memory and per-Bot memory, then inject it consistently across Hermes, Claude Code, and Codex.

Acceptance evidence:

- Memory service tests cover shared memory, per-Bot memory, bounds, escaping, persistence, and update timestamps.
- Adapter tests prove each engine receives exactly one `## Mia Bot Memory` block.
- Tests prove native memory files are not read from official homes in Mia mode.
- Tests prove user prompt content cannot spoof or break the memory block boundary.

### Phase 5: Unified Mia App MCP

Expose app tools through `mia-app` for scheduler, skills, social/group, and Bot metadata.

Acceptance evidence:

- MCP schema tests cover every tool name, input schema, output shape, and permission class.
- Daemon/API tests cover scheduler, skill search/install, group creation, member changes, and Bot listing.
- Permission coordinator tests cover write-tool allow, deny, and scoped always-allow behavior.
- Adapter tests prove Hermes, Claude Code, and Codex receive the same `mia-app` MCP spec.
- Backward compatibility tests prove existing scheduler tools still work during migration.

### Phase 6: Default Slim Packaging

Remove Hermes from default packages and keep only explicit fallback packages with bundled Hermes.

Acceptance evidence:

- Static package tests prove default `dist:mac` and `dist:win` do not build Hermes runtime.
- Static package tests prove default electron-builder resources do not include `vendor/hermes-runtime/*`.
- Packaged audit proves default app resources do not contain `hermes-runtime`.
- Fallback package tests prove `dist:*:with-hermes` remains explicit and functional.
- Manual smoke verifies three machines: no agent, only Claude Code, only Codex or Hermes.

## Manual Verification Matrix

Before marking the overall goal complete, verify:

1. Fresh machine with no agents: Mia starts, shows no-agent state, allows skip, and can install Hermes on demand.
2. Machine with only Claude Code: Mia detects Claude Code, runs a Bot through Claude, and official Claude outside Mia keeps normal history/config.
3. Machine with only Codex: Mia detects Codex, runs a Bot through Codex, and official Codex outside Mia keeps normal history/config.
4. Machine with official Hermes: Mia detects Hermes, runs it with Mia-owned home, and official Hermes outside Mia keeps normal memory/session behavior.
5. Machine with OpenClaw: Mia detects OpenClaw, offers it as a runnable engine, and sends chat through the OpenClaw ACP-backend compatibility entrypoint without forcing embedded-only local mode.
6. Default packaged app: no `hermes-runtime` resource is present.
7. Fallback packaged app: bundled Hermes is present only when using the explicit fallback build command.

## Non-Goals for the First Complete Pass

- Do not merge native agent memories into Mia memory.
- Do not silently modify global Claude, Codex, Hermes, or OpenClaw configuration.
- Do not expose every possible Mia app action through MCP in the first MCP pass.

## Open Implementation Notes

Claude Code's exact home/profile isolation depends on SDK-supported options. The implementation plan must verify current SDK behavior from primary docs or local SDK types before choosing a durable boundary. If no separate home/profile option is available, Claude Code isolation must rely on per-run options, Mia-owned plugin materialization, no global writes, and native session mapping.

Hermes mirror support can use a Mia-hosted artifact only if the installer records upstream identity and verifies checksum before activation.

The first `mia-app` MCP should start with scheduler plus skills read/install and one social/group write flow, then expand after permission behavior is verified.
