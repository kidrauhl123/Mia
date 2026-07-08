# ADR 2026-07-07: AION-Style Rust Core Owns Mia Backend

## Status

Accepted for branch `从node技术迁移到rust`.

## Migration Branch Warning

This ADR is intentionally scoped to the destructive migration worktree at
`/Users/jung/GitHub/Mia/.worktrees/node-to-rust`. Do not port compatibility
code from this branch back to `main` unless a separate `main` ADR accepts it.

## Context

Mia's June 2026 Core migration moved backend ownership away from the Electron
GUI identity, but the resulting Core is still a Node process launched through
Electron packaging seams. That architecture improved process ownership but
kept runtime decisions, scheduling, MCP, conversation orchestration, and cloud
bridge behavior in JavaScript modules.

The AION reference architecture splits the product into an Electron/TypeScript
UI shell and a Rust Core backend. AION Core owns typed HTTP/WebSocket APIs,
SQLite persistence, service construction, domain modules, scheduler behavior,
MCP records, agent factories, and subprocess runtime preparation. AION UI is a
client of those contracts.

This branch is an experimental, destructive migration with no production user
compatibility burden. The target is therefore not another incremental Node Core
wrapper. The target is a Rust Core backend aligned with AION's ownership model.

## Decision

The 2026-06 Node Core plans are superseded on branch
`从node技术迁移到rust`.

Mia Rust Core is the backend owner. Electron main, preload, and renderer are UI
clients and lifecycle adapters.

The Core service owns:

- settings and provider/model resolution;
- bot identity, runtime binding, capability, and session conversation state;
- conversations, message persistence, and agent turn orchestration;
- task scheduling and task execution;
- MCP catalog, user records, OAuth/token state, connection tests, and agent
  exposure;
- cloud bridge backend state and cloud-triggered local execution;
- runtime subprocess preparation for Hermes, Codex, Claude Code, OpenClaw, and
  managed ACP-style tools;
- SQLite persistence and WebSocket event fanout.

The UI adapter may expose stable renderer-facing method names, but it must call
Rust Core HTTP/WebSocket contracts. It must not assemble engine-native provider
configuration, cron semantics, MCP command records, task execution options, or
conversation runtime snapshots.

Node is no longer allowed to own Mia backend behavior after this branch's
cutover. The allowed Node/Bun exceptions are:

- Electron itself and renderer/preload code required for the desktop UI shell;
- JavaScript build, packaging, and smoke-test scripts;
- managed external tool subprocess runtimes when the external agent ecosystem
  requires them, matching AION Core's `aionui-runtime` pattern.

## Consequences

- The new Rust workspace becomes the source of truth for backend DTOs, event
  names, persistence schema, and service ownership.
- `src/core/mia-core.js`, `src/core/mcp/*.js`, Node Core process-control seams,
  `resources/mia-node`, and `scripts/stage-core-node.js` become deletion
  targets after Rust parity lands.
- Existing local data layouts may be replaced by a new SQLite schema. A
  best-effort import path can exist, but old data compatibility is not a gate.
- Renderer and preload cleanup is not cosmetic; any remaining backend decision
  logic outside Rust Core is a migration defect.
- Future architecture docs should use `Mia Rust Core`, `Core service`, and `UI
  adapter` vocabulary for this branch.
