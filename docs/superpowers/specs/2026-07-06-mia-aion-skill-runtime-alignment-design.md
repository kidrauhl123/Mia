# Mia AION Skill Runtime Alignment Design

Status: ready for user review.

## Context

Mia's current local skill delivery path is not one architecture. It is a mix of
global Hermes skill directories, Claude-specific bridge plugin materialization,
turn-level prompt skill injection, and MCP-based skill lookup helpers. The
result is a shallow interface: understanding one Bot skill change requires
following logic across `src/main/skills-loader.js`,
`src/main/bot-execution-core.js`,
`src/main/agent-session-runtime-preparer.js`,
`src/main/engine-runtime-config-service.js`, and
`src/main/claude-bridge-plugin-service.js`.

The target is AION's approach, but copied accurately rather than cosmetically.
AION does not make every engine identical. Instead, it defines one skill seam:
the product owns skill selection, backend metadata declares whether a runtime
supports native workspace skill discovery, and one runtime module chooses either
workspace linking or prompt fallback. That is the shape Mia should adopt.

The user decision for this work is:

- remove `cloud-hermes` completely rather than preserving compatibility paths;
- cover all four local engines without special product behavior;
- keep the AION principle that the product owns skill selection;
- do not model Mia Cloud after AION's deprecated remote-agent path.

## Goals

- Make Bot skill selection product-owned and runtime-agnostic.
- Replace Mia's multiple skill delivery paths with one Skill Runtime Owner seam.
- Align local skill delivery with AION's metadata-driven model.
- Remove `cloud-hermes` logic, data compatibility aliases, and dead runtime
  branches.
- Ensure skill changes on a Bot invalidate stale native sessions deterministically.

## Non-Goals

- Redesign the skill marketplace or installation UX.
- Change Bot capability semantics or move skill ownership into the engines.
- Introduce a server-side remote-agent model based on AION's deprecated remote
  runtime.
- Guarantee that every engine uses native workspace skill directories on day
  one. Engines without proven support will use prompt fallback through the same
  seam.

## Decision

Mia will adopt one deep module named `Skill Runtime Owner`.

The Bot Skill Control Plane remains the only source of truth for skill
selection. The runtime does not decide which skills are enabled. It consumes a
resolved Bot skill snapshot and chooses one of two delivery modes based on
engine metadata:

- `native-link` for engines with workspace-native skill discovery;
- `prompt-fallback` for engines without that capability.

This mirrors AION's real architecture:

- product-owned `enabled_skills` and defaults;
- backend metadata that advertises native skill directories when supported;
- workspace link provisioning for native-support engines;
- first-message skill injection with `[LOAD_SKILL: ...]` only for fallback
  engines.

## Architecture

### Skill Runtime Owner

Add a new Mia Core module at `src/main/mia-core/skill-runtime-owner.js`.

Its interface owns:

- resolving the final enabled skill names for a Bot;
- resolving those names to stable on-disk skill source directories;
- looking up engine skill capability metadata;
- choosing `native-link` or `prompt-fallback`;
- reconciling workspace skill links for native-support engines;
- producing a stable `skillFingerprint` for session invalidation;
- preparing prompt fallback payloads for engines without native skill dirs.

This module is the only public seam for local Bot skill delivery.

### Engine Metadata

Extend `src/shared/agent-engine-policy.js` with skill capability metadata.

The first implementation should declare:

- `claude-code`: `nativeSkillsDirs = [".claude/skills"]`
- `codex`: `nativeSkillsDirs = [".codex/skills"]`
- `hermes`: `nativeSkillsDirs = null`
- `openclaw`: `nativeSkillsDirs = null`

This is intentionally metadata-driven. The architecture must not hardcode
per-engine skill behavior inside adapters or runtime preparers.

### Two Delivery Modes

#### Native Link

For engines that advertise `nativeSkillsDirs`, Mia resolves the Bot's enabled
skills and links them into workspace-native skill directories. Claude Code and
Codex use this mode in phase one.

The first message should only include persona and assistant rules. It must not
inject full skill index text or skill bodies in normal operation.

#### Prompt Fallback

For engines without `nativeSkillsDirs`, Mia uses one shared fallback path. It
injects a first-message skill index and preserves the `[LOAD_SKILL: ...]`
protocol for on-demand skill body loading.

Hermes and OpenClaw use this mode in phase one. This still matches AION's real
architecture because the unifying seam is metadata plus delivery choice, not
forced identical runtime behavior.

## Control Plane Ownership

Bot skill selection remains product-owned.

The resolved skill set comes from:

- Bot `enabledSkills`;
- preset default skills;
- preset or Bot-level exclusions;
- explicit per-turn user skill selections only when Mia deliberately treats them
  as runtime-visible skill state rather than prompt-local hints.

The runtime must not infer an independent skill set from engine state, global
user homes, or engine-native config directories.

## Session And Invalidation Semantics

Mia needs one addition beyond AION's current behavior because Mia allows Bot
skill changes while a local session may still exist.

Add `skillFingerprint` to the AgentSession descriptor and session key.

The fingerprint must be derived from:

- resolved session-level skill names after defaults and exclusions;
- the selected delivery mode.

The first implementation should treat Bot-level enabled skills as
session-visible state. Ephemeral per-turn skill picks should remain outside the
fingerprint unless a future product requirement explicitly promotes them into
workspace-linked runtime state.

When the fingerprint changes, the next local turn must create a new session
rather than reusing the old one. This prevents Claude or Codex native sessions
from continuing with stale workspace skill state after a Bot capability change.

## Workspace Reconcile Semantics

Native skill delivery must support both creation and cleanup.

Mia should maintain a small managed manifest under the workspace for links it
creates through `native-link`. On every reconcile:

- create missing links for the current resolved skill set;
- remove stale links recorded in Mia's managed manifest that are no longer part
  of the resolved skill set;
- never delete user-created directories or links that were not recorded as
  Mia-managed.

This is stricter than AION's current first-write-wins linking behavior and is
appropriate for Mia because Bot skill sets are mutable product state.

## Module Responsibilities

### Keep

- Bot skill capability storage and preset logic.
- Skill marketplace installation and local skill source management.
- Skill read APIs used by UI or debugging.
- `workspacePath` as the runtime seam for local Agent sessions.

### Replace

Replace the current mixed delivery logic with the Skill Runtime Owner seam:

- Hermes global `external_dirs` skill configuration;
- Claude global bridge plugin skill exposure;
- universal turn-level prompt skill materialization as the default path;
- MCP skill lookup as the main local Bot skill transport.

### Delete

- `cloud-hermes` runtime kind, aliases, and dispatcher branches.
- Claude bridge plugin materialization used as a global skill transport.
- Hermes global skill directory injection through runtime config.
- unused native file skill bridge path based on `IDENTITY.md` and `TOOLS.md`.

## Cloud Runtime Decision

`cloud-hermes` is obsolete and will be removed rather than normalized.

This means:

- delete `cloud-hermes` and `cloud_hermes` compatibility mapping;
- remove legacy constants and branches in cloud runtime dispatch;
- delete legacy worker and IM client paths that exist only for
  `cloud-hermes`;
- treat persisted `cloud-hermes` runtime bindings as invalid and clean them
  directly rather than remapping them to `cloud-claude-code`.

The supported cloud runtime after this work is `cloud-claude-code`.

## Migration Plan

### Phase 1: Introduce The Seam

- Add `Skill Runtime Owner`.
- Add engine skill capability metadata to `agent-engine-policy`.
- Add `skillFingerprint` to AgentSession descriptor and key.

### Phase 2: Native-Link Engines

- Switch Claude Code to `native-link` through workspace `.claude/skills`.
- Switch Codex to `native-link` through workspace `.codex/skills`.
- Ensure first-message skill injection is disabled for these native-support
  paths.

### Phase 3: Shared Prompt Fallback

- Route Hermes through the shared fallback path.
- Route OpenClaw through the same shared fallback path.
- Remove Hermes-specific global skill directory behavior.

### Phase 4: Legacy Removal

- Delete Claude bridge plugin skill transport.
- Delete unused native context file skill transport.
- Delete `cloud-hermes` runtime logic and obsolete docs/specs tied to that
  runtime.

## Existing Modules After The Change

### `skills-loader`

Keep directory scanning, installation, and skill record resolution. Remove its
ownership of runtime delivery decisions. It becomes a source module used by the
Skill Runtime Owner.

### `bot-execution-core`

Stop treating turn-level prompt skill materialization as the universal default.
Only call prompt materialization when the Skill Runtime Owner selects
`prompt-fallback`.

### `agent-session-runtime-preparer`

Stop deciding skill delivery independently. It should consume the Skill Runtime
Owner result and only apply the returned runtime preparation outcome.

### `mia-app` MCP skill tools

Keep `skill_list_current` and `skill_read_current`, but narrow their role to UI
support, debugging, and auxiliary inspection. They are no longer the primary
skill delivery path for local Bot runtime behavior.

## Testing

### Unit

- engine metadata skill capability resolution;
- stable `skillFingerprint` generation;
- workspace reconcile creation and deletion rules;
- guarantee that only Mia-managed links are deleted;
- `cloud-hermes` runtime records are rejected or cleaned rather than silently
  normalized.

### Integration

- Claude local session populates `.claude/skills` with resolved Bot skills;
- Codex local session populates `.codex/skills` with resolved Bot skills;
- Hermes local session uses prompt fallback and does not configure global
  Hermes skill directories;
- OpenClaw local session uses the same fallback path as Hermes;
- Bot skill changes force a new local session on the next turn through
  `skillFingerprint`.

### Regression

- no Claude bridge plugin is materialized for skill delivery;
- no Hermes `external_dirs` skill config is written for Bot runtime delivery;
- UI skill read helpers continue to function;
- cloud runtime selection no longer accepts `cloud-hermes`.

## Risks And Mitigations

- Unknown native skill directory support for Hermes or OpenClaw.
  Mitigation: model support in metadata and keep them on prompt fallback until
  proven otherwise.
- Workspace cleanup may accidentally remove user-owned directories.
  Mitigation: delete only paths recorded in Mia's managed manifest.
- Session churn could increase after Bot skill edits.
  Mitigation: limit invalidation to `skillFingerprint` changes and keep the
  fingerprint deterministic.

## Open Implementation Rule

If future runtime research proves that Hermes or OpenClaw support workspace
native skill discovery, that must be enabled by changing engine metadata and
native-link tests, not by introducing a new special-case skill delivery path.
