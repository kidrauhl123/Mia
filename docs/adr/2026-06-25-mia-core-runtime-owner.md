# ADR 2026-06-25: Mia Core Owns Local Runtime

## Status

Accepted.

## Context

Mia currently has two runtime paths:

- global settings and native engine configuration;
- bot runtime bindings and per-turn cloud/desktop invocation configuration.

This split caused Hermes to receive `model=mia-auto` without the matching Mia provider identity, and caused OpenClaw to use ACP Gateway transport when Mia-managed local transport was the available path.

The previous Mia Core Phase 1 direction kept the daemon single-owner model as the primary runtime abstraction. That is no longer the target architecture.

This decision follows the AION-style provider/model ownership pattern already reflected in the Mia Core runtime cutover plan: bindings store compact references, and Core resolves provider/model identity at execution time.

## Decision

Mia Core is the single local runtime owner.

Renderer, cloud bridge, scheduler, and bot runtime binding code must call Mia Core contracts. They must not assemble engine-native provider configuration directly.

`daemon` remains only as a legacy process-control implementation detail while packaging and launch behavior migrate. New domain APIs, docs, and runtime contracts use Mia Core naming.

## Consequences

- Provider/model resolution moves into `src/main/mia-core/model-runtime-resolver.js`.
- Bot runtime bindings store references: `providerConnectionId`, `modelProfileId`, `model`, `agentEngine`, `effortLevel`, `permissionMode`, and device routing fields.
- Hermes, OpenClaw, and Codex all receive resolved model runtime profiles from Mia Core.
- Existing saved bindings with `model: "mia-auto"` continue to work through compatibility inference.
- Existing env aliases such as `MIA_DAEMON` continue to work until process packaging is renamed.
