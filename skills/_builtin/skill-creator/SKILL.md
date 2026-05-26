---
name: skill-creator
description: Create a new Mia skill (a SKILL.md package that extends an agent with specialized knowledge, workflows, or tools). Use when the user wants to build, author, or scaffold a custom skill — then save it into the user's Mia skills directory so it appears under 我的技能 and can be published to the 技能市场.
---

# Skill Creator

Help the user turn a repeatable workflow or piece of domain knowledge into a Mia skill.

## What a skill is

A skill is a self-contained folder whose `SKILL.md` gives an agent procedural knowledge it
doesn't already have. Keep it focused on one job.

```
<skill-name>/
├── SKILL.md          (required: YAML frontmatter + markdown body)
├── scripts/          (optional: deterministic code the agent runs)
├── references/       (optional: docs loaded into context only when needed)
└── assets/           (optional: templates/files used in the output)
```

## Principles

- **Concise.** The context window is shared. Assume the agent is already smart — add only what
  it doesn't know. Every paragraph must earn its tokens. Prefer short examples over explanations.
- **Right degrees of freedom.** Many valid approaches → text guidance. A fragile, must-be-exact
  sequence → a script with few parameters.
- **One source of truth.** Detailed schemas/specs go in `references/`, not duplicated in SKILL.md.
- **No filler files.** Do NOT add README.md / INSTALLATION.md / CHANGELOG.md etc.

## Frontmatter (most important)

`name` and `description` are the ONLY fields the agent reads to decide when to use the skill, so
make `description` specific: say what the skill does AND when to use it (trigger conditions).

```yaml
---
name: weather-cn
description: Look up current weather and a what-to-wear hint for a Chinese city. Use when the user asks about today's weather or what to wear in a mainland China city.
---
```

## Workflow

1. **Clarify** what the skill does and the exact situations that should trigger it.
2. **Draft `SKILL.md`** — tight frontmatter, then a short body with the procedure. Add `scripts/`
   only if deterministic reliability is needed; `references/` for bulky docs.
3. **Save it** as a new folder `<skill-name>/` inside the user's **Mia skills directory** (the
   local "我的技能" source). If unsure of the path, ask the user to open it via 我的技能 →
   右键任意技能 → 打开目录, and create the new folder alongside.
4. **Tell the user** it now shows under 我的技能, and that they can right-click it →
   「发布到市场」to share it on the 技能市场.

Keep the finished skill minimal: a strong `description`, a lean body, and only the bundled
resources it actually needs.
