# Mia Context

## Migration Branch Warning

The `从node技术迁移到rust` branch is a destructive AION-style backend migration
branch. Its architecture docs and compatibility choices must not be copied back
to `main` unless a separate `main` ADR accepts them.

## Mia Rust Core

Mia Rust Core is the backend owner for the migration branch. It owns durable
state, typed HTTP/WebSocket contracts, SQLite persistence, runtime/provider
resolution, task scheduling, MCP records, bot runtime binding, conversation
orchestration, cloud-triggered execution, and realtime event fanout.

The Core service is the long-running local Rust process launched by the
desktop shell. It follows the AION Core shape: a composition crate constructs
services, domain crates own behavior, and UI surfaces call Core through typed
contracts.

## UI Adapter

Electron main, preload, and renderer are UI adapters. They may launch the Core
service, display state, collect user intent, and translate old renderer method
names into HTTP/WebSocket calls. They must not assemble engine-native provider
configuration, cron semantics, MCP runtime command records, agent task options,
or conversation runtime snapshots.

## Bot Skill Control Plane

The product-owned source of truth for which skills a Bot should expose. In Mia
this is owned by Mia Rust Core's Bot capability layer: `enabledSkills`, preset
default skills, and their exclusions. Runtimes consume a resolved snapshot; they
do not own skill selection.

## Skill Runtime Owner

The Mia Rust Core service that resolves the final Bot skill set for a turn or
session and decides how those skills reach the target Agent engine.

Its interface owns:

- resolving the Bot's final enabled skill names;
- resolving each skill to an on-disk source directory;
- choosing skill delivery mode from engine metadata;
- preparing workspace links or prompt fallback payloads;
- producing a stable skill fingerprint for session invalidation.

## Native Link

Skill delivery mode for engines that support workspace-native skill discovery.
Mia links resolved skill directories into engine-native skill directories inside
the session workspace, such as `.claude/skills` or `.codex/skills`.

## Prompt Fallback

Skill delivery mode for engines that do not support workspace-native skill
discovery. Mia injects a first-message skill index and uses the existing
`[LOAD_SKILL: ...]` protocol to materialize full skill bodies only on demand.
