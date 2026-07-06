# Mia Context

## Bot Skill Control Plane

The product-owned source of truth for which skills a Bot should expose. In Mia
this is the Bot capability layer: `enabledSkills`, preset default skills, and
their exclusions. Runtimes consume a resolved snapshot; they do not own skill
selection.

## Skill Runtime Owner

The Mia Core module that resolves the final Bot skill set for a turn or session
and decides how those skills reach the target Agent engine.

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
