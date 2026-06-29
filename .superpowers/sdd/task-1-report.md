# Task 1 Report: Official Assistant Template Data And Loader Contract

## Scope

- Branch: `codex/assistant-store-content`
- Worktree: `/Users/jung/GitHub/Mia/.worktrees/assistant-store-content`
- Allowed files only:
  - `resources/official-library/library.json`
  - `src/main/skills-loader.js`
  - `tests/skills-loader-install.test.js`
  - `tests/bot-store-ui.test.js`

## TDD Evidence

### RED

1. Replaced the two task-specified tests first:
   - `tests/skills-loader-install.test.js`
   - `tests/bot-store-ui.test.js`
2. Ran the focused command before production edits:

```bash
node --test tests/skills-loader-install.test.js tests/bot-store-ui.test.js
```

3. Observed expected failure:
   - `official assistant templates are long-lived context contacts, not skill wrappers`
   - `bundled official library exposes context-bearing assistant templates`
4. Failure reason matched the brief:
   - library still exposed `10` presets instead of `6`

### GREEN

1. Replaced the official `botPresets` data with the required six assistant templates.
2. Added loader normalization for:
   - `responsibility`
   - `bestFor`
   - `setupPrompt`
   - `contextBindings`
   - `runtimeRecommendation`
   - `handoffExamples`
   - `setup.fields`
3. Preserved product resolution:
   - `mia-scheduler` remains a valid built-in official skill id
   - tests accept `mia-official:*` ids or exactly `mia-scheduler`
   - skill lookup assertion accepts either `skill.id` or `skill.name`
4. Re-ran the same focused command:

```bash
node --test tests/skills-loader-install.test.js tests/bot-store-ui.test.js
```

5. Result:
   - `18` tests passed
   - `0` failed

## Files Changed

- `resources/official-library/library.json`
- `src/main/skills-loader.js`
- `tests/skills-loader-install.test.js`
- `tests/bot-store-ui.test.js`

## Self-Review

- Confirmed only the four Task 1 files were modified.
- Confirmed the library now contains exactly the six required assistant templates in the required order.
- Confirmed loader output keeps existing compatibility fields (`line`, `desc`, `demo`, `persona`, `capabilities`) while adding the new normalized fields.
- Confirmed `buildEnabledSkillsContext` still resolves bundled preset defaults for an unconfigured official assistant.
- Confirmed the scheduler exception is preserved without inventing a new `commit-craft` skill.

## Concerns

- No blocking concerns for Task 1.
- One adjacent test had to be updated from the retired `论文搭子` preset to the new `课程助教` preset so preset-default coverage still matches the new library content.

## Review Fix: Cold-Load Fallback Sync

### RED

1. Added a focused source-level regression test in `tests/bot-store-ui.test.js` for:
   - stale fallback names absent from `src/renderer/bot/bot-store.js`
   - the six first-release assistant names present in `FALLBACK_PRESETS`
   - `CATEGORY_ORDER` matching `学习 / 项目 / 事务 / 代码 / 推荐`
2. Ran:

```bash
node --test tests/bot-store-ui.test.js
```

3. Observed the expected failure before the fix:
   - stale `CATEGORY_ORDER` still used `办公 / 写作 / 求职 / 娱乐`
   - `FALLBACK_PRESETS` still contained retired cold-load content

### GREEN

1. Updated `src/renderer/bot/bot-store.js`:
   - replaced the stale 10-item fallback with the six context-bearing assistant templates
   - added the new setup/context metadata fields to the fallback entries
   - preserved enabled skill wiring, including `mia-scheduler` where required
   - changed `CATEGORY_ORDER` to `["学习", "项目", "事务", "代码", "推荐"]`
2. Re-ran:

```bash
node --test tests/bot-store-ui.test.js
node --test tests/skills-loader-install.test.js tests/bot-store-ui.test.js
```

3. Result:
   - focused UI source test passed
   - combined regression suite passed with `19` tests passed and `0` failed

### Files Changed

- `src/renderer/bot/bot-store.js`
- `tests/bot-store-ui.test.js`
- `.superpowers/sdd/task-1-report.md`

### Self-Review

- Kept the fix scoped to the requested renderer store, UI test, and task report.
- Confirmed the cold-load fallback now mirrors the six released assistant templates closely enough to avoid retired content on first load.
- Confirmed the category taxonomy now matches the first-release assistant grouping used by the official library.
