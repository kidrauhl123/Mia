# Task 3 Report: Assistant Store Cards And Details Use Template Semantics

## Scope

- Updated `src/renderer/bot/bot-store.js`
- Updated `src/renderer/styles/bot-store.css`
- Appended tests in `tests/bot-store-ui.test.js`
- Appended tests in `tests/renderer-styles.test.js`

## RED

Appended the required source tests first, then ran:

```bash
node --test tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Observed expected failure state:

- `discover bot store presents assistant templates as context contacts` failed because `bot-store.js` still rendered `f.line`, the plain `添加` button, and did not reference `window.miaAssistantTemplate`.
- `assistant store cards keep responsibility, setup, and skill metadata distinct` failed because `bot-store.css` did not yet define `.bot-store-card-responsibility`, `.bot-store-card-setup`, `.bot-store-card-skills`, or `.bot-store-skill-chip`.

## GREEN

Implemented Task 3 production changes and re-ran:

```bash
node --test tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Observed passing result:

- `39` tests passed
- `0` tests failed
- exit code `0`

## What Changed

### `src/renderer/bot/bot-store.js`

- Added template helper accessors that read from `window.miaAssistantTemplate`:
  - `assistantTemplates()`
  - `assistantResponsibility(f)`
  - `assistantSetupRequirement(f)`
  - `assistantHandoffExamples(f)`
- Added `skillChipHtml(f)` for up to three skill chips plus overflow count.
- Changed store cards to render:
  - fixed `长期联系人` tag
  - `长期负责：...`
  - `第一次需要：...`
  - default skill chips
- Changed detail sheet to render:
  - responsibility as the primary description
  - setup/skill metadata block
  - handoff examples when available, otherwise fallback demo text
  - primary CTA text `添加并设置`
- Preserved existing `CATEGORY_ORDER`, fallback preset coverage, and masonry-related behavior.

### `src/renderer/styles/bot-store.css`

- Replaced the old line-copy card treatment with:
  - `.bot-store-card-responsibility`
  - `.bot-store-card-setup`
  - `.bot-store-card-skills`
  - `.bot-store-skill-chip`
- Added detail metadata styles:
  - `.bot-store-template-meta`
  - `.bot-store-template-meta > div`
  - `.bot-store-template-meta span`
  - `.bot-store-template-meta strong`
- Added paragraph spacing rules for multi-example `.bot-store-demo` content.
- Kept `.bot-store-card-foot` class present on the skill chip container to satisfy existing source-test expectations outside Task 3.

## Self-Review

- Scope stayed limited to the four Task 3 files named in the brief.
- The red step was verified before any production edit.
- Existing Task 1/2 behaviors remained intact, including fallback taxonomy assertions and `CATEGORY_ORDER`.
- I retained compatibility with an older source assertion by leaving `bot-store-card-foot` as a secondary class on the skills container rather than editing unrelated prior tests.

## Concerns

- Focused source/CSS tests pass, but I did not run broader renderer/integration suites beyond the command required by the brief.
