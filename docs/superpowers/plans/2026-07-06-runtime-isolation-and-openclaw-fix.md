# Runtime Isolation And OpenClaw Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop bot/runtime model drift, stop cloud/runtime kind misclassification, and make OpenClaw sessions start reliably again.

**Architecture:** Keep fixes narrow and source-of-truth driven. Desktop-local Hermes bots keep their own saved runtime binding after first seed, bot conversation runtime kind prefers persisted bot runtime metadata over stale conversation defaults, and OpenClaw stops receiving unsupported per-session MCP servers.

**Tech Stack:** Electron renderer, Node main process, Node test runner

## Global Constraints

- Use TDD for each behavior change.
- Preserve existing external-engine behavior unless directly related to the bug.
- Do not change unrelated packaging, signing, or release logic.

---

### Task 1: Lock Failing Tests

**Files:**
- Modify: `tests/bot-commands.test.js`
- Modify: `tests/shared-session-history.test.js`
- Modify: `tests/agent-session-runtime-preparer.test.js`

**Interfaces:**
- Consumes: `syncDesktopLocalBotRuntimeBinding(...)`, `runtimeKind(...)`, `prepare(...)`
- Produces: failing regression coverage for runtime preservation and OpenClaw ACP preparation

- [ ] **Step 1: Add a failing desktop-local Hermes regression**

Test that an existing desktop-local Hermes binding with `mia-auto` is preserved even when device-global runtime now says `openai-codex/gpt-5.5`.

- [ ] **Step 2: Add a failing runtime-kind regression**

Test that bot session runtime kind prefers explicit root/runtime metadata before falling back to `desktop-local`.

- [ ] **Step 3: Add a failing OpenClaw ACP regression**

Test that OpenClaw managed runtime preparation does not return `mcpServers` while still returning profile/gateway env.

- [ ] **Step 4: Run targeted red tests**

Run:

```bash
node --test tests/bot-commands.test.js tests/shared-session-history.test.js tests/agent-session-runtime-preparer.test.js
```

Expected: new assertions fail before implementation.

### Task 2: Preserve Desktop-Local Hermes Runtime Bindings

**Files:**
- Modify: `src/renderer/bot/bot-commands.js`
- Modify: `tests/bot-commands.test.js`

**Interfaces:**
- Consumes: existing bot runtime binding from `api.social.getBotRuntime(...)`
- Produces: stable Hermes desktop-local `config.model`, `config.effortLevel`, `config.permissionMode`

- [ ] **Step 1: Implement binding-aware Hermes config merging**

Only seed from `state.runtime` when the desktop-local Hermes binding has no saved runtime fields; otherwise preserve the saved binding’s runtime choice and merge it with current model entries.

- [ ] **Step 2: Keep external engines unchanged**

Do not alter current Codex / Claude Code / OpenClaw desktop-local config generation.

- [ ] **Step 3: Run the focused green tests**

Run:

```bash
node --test tests/bot-commands.test.js
```

Expected: desktop-local runtime regression tests pass.

### Task 3: Fix Bot Conversation Runtime Kind Resolution

**Files:**
- Modify: `packages/shared/session-history.js`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/social/social.js`
- Modify: `tests/shared-session-history.test.js`

**Interfaces:**
- Consumes: bot conversation records plus owned-bot runtime metadata
- Produces: correct `cloud-claude-code` vs `desktop-local` selection for composer/runtime controls and new cloud sessions

- [ ] **Step 1: Broaden runtime-kind resolution**

Make shared/runtime helpers honor explicit `conversation.runtimeKind`, `conversation.runtime_config.runtimeKind`, and bot-derived runtime metadata before the `desktop-local` fallback.

- [ ] **Step 2: Stop re-seeding cloud sessions as desktop-local**

Use the active bot runtime target when creating or re-ensuring bot sessions instead of hard-coding `desktop-local`.

- [ ] **Step 3: Run focused green tests**

Run:

```bash
node --test tests/shared-session-history.test.js tests/bot-commands.test.js
```

Expected: runtime-kind regressions pass.

### Task 4: Remove Unsupported Per-Session MCP From OpenClaw ACP Sessions

**Files:**
- Modify: `src/main/agent-session-runtime-preparer.js`
- Modify: `tests/agent-session-runtime-preparer.test.js`

**Interfaces:**
- Consumes: managed OpenClaw runtime from `resolveManagedModelRuntime(...)`
- Produces: OpenClaw runtime env/profile setup without per-session `mcpServers`

- [ ] **Step 1: Implement OpenClaw-specific MCP stripping**

Return OpenClaw gateway/profile runtime env without `mcpServers` and `mcpFingerprint`, while keeping other engines unchanged.

- [ ] **Step 2: Run focused green tests**

Run:

```bash
node --test tests/agent-session-runtime-preparer.test.js
```

Expected: OpenClaw preparation tests pass.

### Task 5: Regression Verification

**Files:**
- Modify: none

**Interfaces:**
- Consumes: all changed code
- Produces: verified bugfix set

- [ ] **Step 1: Run the touched suite**

Run:

```bash
node --test tests/bot-commands.test.js tests/shared-session-history.test.js tests/agent-session-runtime-preparer.test.js tests/local-bot-responder.test.js tests/bot-execution-core.test.js
```

Expected: all pass.

- [ ] **Step 2: Run the repo default test entry**

Run:

```bash
npm test
```

Expected: no regressions in the default Node test suite.
