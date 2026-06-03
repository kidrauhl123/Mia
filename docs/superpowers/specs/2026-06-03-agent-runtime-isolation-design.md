# Agent Runtime Isolation Design

Date: 2026-06-03

## Goal

Mia should become a lightweight desktop app that can orchestrate local native agents without bundling a full Hermes runtime into the installer by default.

When the user talks to Hermes, Claude Code, or Codex through Mia, Mia owns the Fellow identity, session mapping, memory, and app tools. When the user uses those agents outside Mia, their official CLI or desktop app should behave normally with their own memory, sessions, and configuration.

## Current Findings

Mia currently bundles Hermes into the macOS app through `vendor/hermes-runtime/mac-arm64`. Removing that runtime from the built app reduced the DMG by roughly 145 MiB in local measurement.

Mia already has partial isolation:

- Fellow personas live under Mia runtime files such as `runtime/engine-home/fellows/<fellow>.md`.
- Native agent sessions are keyed by engine, Fellow, and Mia session.
- Hermes receives `X-Mia-Fellow` and Mia injects the matching persona through a Python plugin.
- Codex already uses a Mia-controlled `CODEX_HOME` while linking selected user Codex state so auth is reused without sharing sessions/history.
- `mia-scheduler` already exists as a stdio MCP server and is wired into Hermes, Claude Code, and Codex paths.

The missing pieces are:

- A first-class local agent inventory.
- A lightweight Hermes install path.
- A consistent runtime isolation policy for all engines.
- A Mia-owned memory system that does not conflict with native agent memory.
- A broader Mia app MCP surface for scheduler, skill marketplace, and social/group actions.

## Product Behavior

On first launch, Mia should detect local agents and show an inventory:

- Claude Code: installed or missing
- Codex: installed or missing
- Hermes: installed or missing
- OpenClaw: installed or missing

If no usable agent is installed, Mia recommends installing Hermes. The user can skip and still enter Mia in a no-agent-connected state. In the initial release, Mia only offers installation for Hermes. Other agents are detection-only.

Mia should not default to a cloud Hermes runtime for desktop chat. Local agent execution is the primary desktop model.

## Runtime Ownership

Mia should separate three concerns:

- Install/auth: reuse native agent installs and user credentials when possible.
- Runtime/session state: keep Mia-specific state in Mia-owned homes/profiles.
- Memory: use Mia-owned Fellow memory while inside Mia.

Recommended engine behavior:

- Hermes: use the official installed Hermes command or a Mia-installed official Hermes runtime, but launch it with a Mia-owned `HERMES_HOME`.
- Codex: continue using a Mia-owned `CODEX_HOME`, linking only safe user auth/model/cache state and excluding session/history/native memory.
- Claude Code: use the user-installed `claude` executable and SDK options, but inject Mia context per run and avoid writing Mia MCP or Mia memory into global Claude settings.

Mia must not make destructive or silent changes to the user's official `~/.hermes`, `~/.codex`, or Claude Code configuration.

## Memory Policy

Inside Mia, Mia memory is authoritative. Native agent memory is not the Fellow memory source.

Mia should maintain:

- Shared user memory: user-wide preferences that apply across Fellows.
- Per-Fellow memory: long-lived identity, relationship, and facts scoped to one Fellow.
- Project/native context: project rules and native agent configuration, treated as environment context rather than Mia Fellow memory.

Each agent adapter injects a single Mia memory block with stable boundaries, for example:

```text
## Mia Fellow Memory
source: mia
fellow: <fellow_id>

...
```

Native agent memory should be disabled, isolated, or ignored in Mia-controlled runtime homes. In particular, Mia should not share official Hermes `~/.hermes/memories`, Codex sessions/history, or other native memory stores into Mia sessions.

When the user runs Hermes, Claude Code, or Codex outside Mia, Mia does not set the Mia-owned home/profile or inject Mia memory. Native agent memory behaves normally.

## MCP Policy

Mia app capabilities should be exposed through a single app-facing MCP server, evolving from the current `mia-scheduler` server.

Initial tool groups:

- Scheduler: create, list, update, delete, pause, resume scheduled tasks.
- Skill marketplace: search, inspect, install.
- Social/group: create group, list conversations, add/remove members, post messages where appropriate.
- Fellows: list available Fellows and basic identity metadata.

The MCP server calls Mia daemon or cloud APIs server-side. Agent processes receive a short-lived local daemon token, not Mia cloud credentials.

Permission model:

- Read-only tools can run automatically.
- Write tools that change user state, install skills, create groups, invite members, or post messages require Mia permission confirmation unless a prior scoped rule allows it.
- Tool descriptions must state real product constraints and avoid advertising features Mia does not support.

## Hermes Installation

Mia should stop bundling Hermes runtime by default after the replacement path is stable.

Hermes installation should be user-triggered from the agent inventory. The installer should use official Hermes artifacts or official package commands. A Mia mirror may be added for network reliability, but it must preserve version metadata and checksum verification.

The installer should support:

- Detect existing Hermes.
- Install Hermes when missing.
- Repair or reinstall when broken.
- Show progress and logs.
- Leave official user-level Hermes usable outside Mia.

## Phased Implementation

### Phase 1: Agent Inventory and UI

Create a local agent inventory service that detects `claude`, `codex`, `hermes`, and OpenClaw. It should report path, version, installed state, and basic health. Add onboarding/settings UI that presents these states and allows continuing without an agent.

### Phase 2: Optional Hermes Install

Refactor the existing Hermes install flow so Hermes is installed only when the user chooses it. Keep current bundled runtime support during the transition as a fallback. Do not remove the bundled runtime until inventory and install flows are verified.

### Phase 3: Runtime Isolation

Introduce explicit engine home/profile builders:

- `mia-hermes-home`
- `mia-codex-home`
- Claude Code run options

Each builder defines which user state may be linked or copied. Sessions, histories, and native memories are excluded by default.

### Phase 4: Mia Memory Injection

Add a Mia memory service with shared user memory and per-Fellow memory. Update Hermes, Claude Code, and Codex adapters so they inject Mia memory once per turn/session using a stable block. Add tests that native memory files are not read from official homes in Mia mode.

### Phase 5: Unified Mia App MCP

Replace or extend `mia-scheduler` into `mia-app`. Keep scheduler tools compatible. Add skill marketplace and social/group tools with permission checks and idempotent operations.

### Phase 6: Remove Default Bundled Hermes

Once install, detection, runtime isolation, memory injection, and MCP routing are stable, remove Hermes runtime from default app packaging. Keep a development or emergency fallback path if needed.

## Error Handling

If no agent is installed, Mia enters a no-agent state and prompts the user to install Hermes or configure another agent.

If a native agent is installed but unusable, Mia should show the failing command and version probe result, then offer repair guidance.

If Mia-controlled runtime home creation fails, Mia should not fall back silently to the user's official native home. It should fail visibly to avoid memory/session pollution.

If MCP setup fails, chat can continue, but Mia must tell the agent/user that Mia app tools are unavailable for that turn.

## Testing

Add focused tests for:

- Agent detection parsing and missing-command behavior.
- Hermes installer state transitions.
- Runtime home builders excluding sessions/history/native memory.
- Mia memory block generation and adapter injection.
- No duplicate memory injection.
- MCP tool schemas and daemon payloads.
- Permission checks for write tools.
- Packaging config that excludes bundled Hermes only after the fallback is removed.

Manual verification:

- Fresh machine with no agents.
- Machine with only Claude Code.
- Machine with only Codex.
- Machine with official Hermes already configured.
- User runs official Hermes/Codex/Claude outside Mia after using Mia and sees normal native behavior.

## Open Decisions

The first implementation should use Mia-owned runtime homes and Mia-owned memory. It should not attempt to merge native agent memories into Mia memory.

Hermes mirror support can be added after the official install path works. The first install implementation may use the official source only if checksum/version reporting is still captured.

The first `mia-app` MCP should start with scheduler plus one low-risk additional domain before exposing every Mia app action.
