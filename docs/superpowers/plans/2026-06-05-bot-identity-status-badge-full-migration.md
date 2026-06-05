# Bot Identity and Status Badge Full Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mia's pre-launch `fellow` model with a canonical global `bot` identity model and add shared status badges for users and bots.

**Architecture:** Make `packages/shared/identity.js` the small interface that UI, cloud, desktop, web, and mobile consume. Perform a destructive pre-launch migration: rename schema, routes, IPC, renderer modules, event names, sender kinds, and tests to `bot`, then add a static guard that prevents production `fellow` identifiers from returning.

**Tech Stack:** Electron, Node.js `node:test`, SQLite via existing cloud store, vanilla renderer modules, React Native type definitions.

---

## Scope Check

This plan intentionally covers multiple layers in one migration branch because the spec rejects a dual `fellow`/`bot` compatibility period. The work is still split into independently reviewable tasks, but the final cleanup task is the release gate: do not stop with both names active in production source.

Before execution, inspect the dirty worktree:

```bash
git -C /Users/jung/GitHub/Mia status --short
```

There are known pre-existing renderer edits in:

- `src/renderer/app-state.js`
- `src/renderer/app.js`
- `src/renderer/index.html`
- `src/renderer/styles.css`
- `src/renderer/styles/fellow-store.css`

Do not revert those changes. If implementation touches the same files, read the current file first and edit around the existing work.

## File Structure

Shared identity:

- Create `packages/shared/identity.js`
- Create `packages/shared/identity.d.ts`
- Create `src/shared/identity.js`
- Modify `packages/shared/package.json`
- Modify `packages/shared/index.js`
- Modify `packages/shared/index.d.ts`
- Test `tests/shared-identity.test.js`

Bot identity and shared contracts:

- Rename `packages/shared/fellow-identity.js` to `packages/shared/bot-identity.js`
- Rename `packages/shared/fellow-identity.d.ts` to `packages/shared/bot-identity.d.ts`
- Rename `src/shared/fellow-identity.js` to `src/shared/bot-identity.js`
- Modify `packages/shared/contact.js`
- Modify `packages/shared/contact.d.ts`
- Modify `packages/shared/group-tiles.js`
- Modify `packages/shared/group-tiles.d.ts`
- Modify `packages/shared/send-pipeline.js`
- Modify `packages/shared/send-pipeline.d.ts`
- Modify `packages/shared/session-history.js`
- Modify `packages/shared/session-history.d.ts`
- Modify `src/shared/message-spec.js`
- Modify `src/shared/cloud-events.js`
- Modify `src/shared/fellow-runtime-control.js` by renaming it to `src/shared/bot-runtime-control.js`

Cloud:

- Rename `src/cloud/fellows-store.js` to `src/cloud/bots-store.js`
- Modify `src/cloud/sqlite-store.js`
- Modify `src/cloud/social-store.js`
- Modify `src/cloud/messages-store.js` only if sender validation or helpers exist after inspection
- Modify `scripts/serve-cloud.js`
- Rename `src/cloud-agent/default-fellow.js` to `src/cloud-agent/default-bot.js`
- Modify `src/cloud-agent/dispatcher.js`
- Modify `src/cloud-agent/group-orchestrator.js`
- Modify `src/cloud-agent/runtime-bindings-store.js`
- Modify `src/cloud-agent/cloud-agent-runs-store.js`
- Modify `src/cloud-agent/hermes-runs-client.js`
- Test by renaming/updating `tests/fellows-store.test.js` to `tests/bots-store.test.js`
- Test by renaming/updating `tests/fellows-api.test.js` to `tests/bots-api.test.js`
- Update cloud tests that mention `fellow`

Main process:

- Rename `src/main/fellow-manifest.js` to `src/main/bot-manifest.js`
- Rename `src/main/fellow-registry.js` to `src/main/bot-registry.js`
- Rename `src/main/fellow-service.js` to `src/main/bot-service.js` if present during execution
- Rename `src/main/social/fellow-invocation.js` to `src/main/social/bot-invocation.js`
- Rename `src/main/social/fellow-runtime-dispatcher.js` to `src/main/social/bot-runtime-dispatcher.js`
- Rename `src/main/social/local-fellow-responder.js` to `src/main/social/local-bot-responder.js`
- Modify `src/main.js`
- Modify `src/main/social/social-api.js`
- Modify `src/main/social/social-ipc.js`
- Modify `src/main/cloud/desktop-sync-client.js`
- Modify `src/main/cloud/cloud-events-client.js`
- Modify `src/main/mia-app-mcp-server.js`
- Modify `src/main/mia-app-mcp-bridge.js`
- Modify `src/main/mia-memory-service.js`
- Modify `src/main/scheduler-mcp-bridge.js`
- Modify `src/main/external-agent-command-service.js`
- Modify `src/main/chat-engine-adapters.js`
- Modify `src/main/hermes-chat-adapter.js`
- Modify `src/main/codex-chat-adapter.js`
- Modify `src/main/claude-code-chat-adapter.js`
- Modify `src/shared/ipc-channels.js`
- Modify `src/preload.js`

Renderer, web, mobile:

- Rename `src/renderer/fellow/` to `src/renderer/bot/`
- Rename `src/renderer/message-sources/fellow-session-source.js` to `src/renderer/message-sources/bot-session-source.js`
- Rename `src/renderer/styles/fellow-store.css` to `src/renderer/styles/bot-store.css`
- Create `src/renderer/name-with-badge.js`
- Create `src/renderer/styles/name-with-badge.css`
- Modify `src/renderer/index.html`
- Modify `src/renderer/app.js`
- Modify `src/renderer/app-state.js`
- Modify `src/renderer/message-bubble-renderer.js`
- Modify `src/renderer/sidebar-card-renderer.js`
- Modify `src/renderer/social/social.js`
- Modify `src/renderer/social/social-groups.js`
- Modify `src/renderer/social/contact-card.js`
- Modify `src/renderer/helpers/avatar-helpers.js`
- Modify `src/web/app.js`
- Modify `src/web/app/index.html`
- Modify `src/web/styles.css`
- Modify `apps/mobile-rn/src/api/types.ts`
- Modify `apps/mobile-rn/src/logic/conversationList.ts`
- Modify `apps/mobile-rn/src/components/MessageBubble.tsx`

Cleanup guards:

- Create `tests/no-legacy-fellow-identifiers.test.js`
- Modify `tests/packages-shared-contract.test.js`
- Modify `tests/shared-browser-globals.test.js`
- Run the full `npm test` and `npm run check` gates.

### Task 1: Shared Identity Contract

**Files:**

- Create: `packages/shared/identity.js`
- Create: `packages/shared/identity.d.ts`
- Create: `src/shared/identity.js`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/index.js`
- Modify: `packages/shared/index.d.ts`
- Create: `tests/shared-identity.test.js`

- [ ] **Step 1: Write the failing shared identity test**

Create `tests/shared-identity.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  IdentityKind,
  normalizeIdentity,
  normalizeStatusBadge,
  identityKey
} = require("../src/shared/identity.js");

test("normalizeIdentity returns a clean user identity", () => {
  const identity = normalizeIdentity({
    kind: "user",
    id: "u_1",
    displayName: "Alice",
    ownerUserId: "should_drop",
    avatar: { image: "data:a", crop: null, color: "#111111", text: "A" },
    statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
  });

  assert.equal(identity.kind, IdentityKind.User);
  assert.equal(identity.id, "u_1");
  assert.equal(identity.displayName, "Alice");
  assert.equal(identity.ownerUserId, undefined);
  assert.deepEqual(identity.statusBadge, { kind: "emoji", emoji: "⭐", label: "Premium" });
  assert.equal(identityKey(identity), "user:u_1");
});

test("normalizeIdentity returns a global bot identity with owner metadata", () => {
  const identity = normalizeIdentity({
    kind: "bot",
    id: "bot_abcd",
    ownerUserId: "u_owner",
    displayName: "Mia",
    avatar: { image: "", crop: null, color: "#5e5ce6", text: "Mi" },
    statusBadge: { kind: "lottie", assetId: "sparkle", loop: "limited" }
  });

  assert.equal(identity.kind, IdentityKind.Bot);
  assert.equal(identity.id, "bot_abcd");
  assert.equal(identity.ownerUserId, "u_owner");
  assert.equal(identity.displayName, "Mia");
  assert.deepEqual(identity.statusBadge, { kind: "lottie", assetId: "sparkle", loop: "limited" });
  assert.equal(identityKey(identity), "bot:bot_abcd");
});

test("normalizeIdentity rejects prefixed and legacy fellow ids", () => {
  assert.equal(normalizeIdentity({ kind: "bot", id: "bot:bot_abcd", displayName: "Mia" }), null);
  assert.equal(normalizeIdentity({ kind: "bot", id: "fellow:u:mia", displayName: "Mia" }), null);
  assert.equal(normalizeIdentity({ kind: "user", id: "user:u_1", displayName: "Alice" }), null);
});

test("normalizeStatusBadge keeps supported badges and drops invalid badges", () => {
  assert.deepEqual(normalizeStatusBadge({ kind: "gift", assetId: "rose", collectibleId: "nft_1" }), {
    kind: "gift",
    assetId: "rose",
    collectibleId: "nft_1"
  });
  assert.equal(normalizeStatusBadge({ kind: "emoji", emoji: "" }), null);
  assert.equal(normalizeStatusBadge({ kind: "lottie", assetId: "" }), null);
  assert.equal(normalizeStatusBadge({ kind: "unknown", assetId: "x" }), null);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/shared-identity.test.js
```

Expected: FAIL with a module-not-found error for `../src/shared/identity.js`.

- [ ] **Step 3: Add the shared identity implementation**

Create `packages/shared/identity.js`:

```js
"use strict";

const IdentityKind = Object.freeze({
  User: "user",
  Bot: "bot"
});

function clean(value) {
  return String(value || "").trim();
}

function hasIllegalIdentityPrefix(id) {
  return id.startsWith("user:") || id.startsWith("bot:") || id.startsWith("fellow:");
}

function normalizeAvatar(input = {}) {
  const avatar = input && typeof input === "object" ? input : {};
  return {
    image: clean(avatar.image),
    crop: avatar.crop && typeof avatar.crop === "object" ? avatar.crop : null,
    color: clean(avatar.color),
    text: clean(avatar.text)
  };
}

function normalizeStatusBadge(input) {
  if (!input || typeof input !== "object") return null;
  const kind = clean(input.kind);
  const label = clean(input.label);
  if (kind === "emoji") {
    const emoji = clean(input.emoji);
    return emoji ? { kind, emoji, ...(label ? { label } : {}) } : null;
  }
  if (kind === "lottie") {
    const assetId = clean(input.assetId || input.asset_id);
    const loop = clean(input.loop);
    return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(loop ? { loop } : {}) } : null;
  }
  if (kind === "gift") {
    const assetId = clean(input.assetId || input.asset_id);
    const collectibleId = clean(input.collectibleId || input.collectible_id);
    return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(collectibleId ? { collectibleId } : {}) } : null;
  }
  return null;
}

function normalizeIdentity(input = {}) {
  if (!input || typeof input !== "object") return null;
  const kind = clean(input.kind);
  const id = clean(input.id);
  if (!id || hasIllegalIdentityPrefix(id)) return null;
  if (kind !== IdentityKind.User && kind !== IdentityKind.Bot) return null;
  const displayName = clean(input.displayName || input.display_name || input.name || id);
  const out = {
    kind,
    id,
    displayName,
    avatar: normalizeAvatar(input.avatar || input)
  };
  const badge = normalizeStatusBadge(input.statusBadge || input.status_badge);
  if (badge) out.statusBadge = badge;
  if (kind === IdentityKind.Bot) {
    const ownerUserId = clean(input.ownerUserId || input.owner_user_id || input.ownerId || input.owner_id);
    if (ownerUserId) out.ownerUserId = ownerUserId;
  }
  return out;
}

function identityKey(identity) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) return "";
  return `${normalized.kind}:${normalized.id}`;
}

module.exports = {
  IdentityKind,
  normalizeIdentity,
  normalizeStatusBadge,
  identityKey
};
```

Create `src/shared/identity.js`:

```js
module.exports = require("../../packages/shared/identity.js");
```

Create `packages/shared/identity.d.ts`:

```ts
import type { AvatarDescriptor } from "./avatar";

export const IdentityKind: {
  readonly User: "user";
  readonly Bot: "bot";
};

export type IdentityKindT = (typeof IdentityKind)[keyof typeof IdentityKind];

export type StatusBadge =
  | { kind: "emoji"; emoji: string; label?: string }
  | { kind: "lottie"; assetId: string; label?: string; loop?: "limited" | "always" | string }
  | { kind: "gift"; assetId: string; label?: string; collectibleId?: string };

export type Identity = {
  kind: IdentityKindT;
  id: string;
  displayName: string;
  avatar?: AvatarDescriptor;
  statusBadge?: StatusBadge | null;
  ownerUserId?: string;
};

export function normalizeStatusBadge(input: unknown): StatusBadge | null;
export function normalizeIdentity(input?: Record<string, unknown>): Identity | null;
export function identityKey(identity?: Record<string, unknown> | null): string;
```

Modify `packages/shared/index.js`:

```js
identity: require("./identity.js"),
```

Modify `packages/shared/index.d.ts`:

```ts
export * as identity from "./identity";
```

Modify `packages/shared/package.json` exports:

```json
"./identity": {
  "types": "./identity.d.ts",
  "default": "./identity.js"
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/shared-identity.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/identity.js packages/shared/identity.d.ts src/shared/identity.js packages/shared/index.js packages/shared/index.d.ts packages/shared/package.json tests/shared-identity.test.js
git commit -m "feat(bot): 增加统一身份契约"
```

### Task 2: Bot Identity Helpers and Shared Contracts

**Files:**

- Rename: `packages/shared/fellow-identity.js` -> `packages/shared/bot-identity.js`
- Rename: `packages/shared/fellow-identity.d.ts` -> `packages/shared/bot-identity.d.ts`
- Rename: `src/shared/fellow-identity.js` -> `src/shared/bot-identity.js`
- Modify: `packages/shared/contact.js`
- Modify: `packages/shared/contact.d.ts`
- Modify: `packages/shared/group-tiles.js`
- Modify: `packages/shared/group-tiles.d.ts`
- Modify: `packages/shared/send-pipeline.js`
- Modify: `packages/shared/send-pipeline.d.ts`
- Modify: `packages/shared/session-history.js`
- Modify: `packages/shared/session-history.d.ts`
- Modify: `src/shared/message-spec.js`
- Modify: `src/shared/cloud-events.js`
- Rename test: `tests/shared-contact.test.js` keeps filename but changes assertions to bot
- Rename test: `tests/shared-session-history.test.js` keeps filename but changes assertions to bot
- Rename test: `tests/shared-send-pipeline.test.js` keeps filename but changes assertions to bot
- Modify test: `tests/shared-message-spec.test.js`
- Modify test: `tests/shared-cloud-events.test.js`

- [ ] **Step 1: Write failing tests for bot contact and message spec**

Update `tests/shared-contact.test.js` imports and core bot tests:

```js
const { resolveContact, IdentityKind, botAvatarIdentityId } = require("../src/shared/contact");

const ctx = {
  self: { id: "user_me", username: "me", displayName: "Boss", avatarImage: "data:me", avatarCrop: { x: 50, y: 50, zoom: 1 }, avatarColor: "#111" },
  bots: [{ id: "bot_codex", ownerUserId: "user_me", displayName: "Codex", avatarImage: "./assets/avatars/02.png", avatarCrop: { x: 57, y: 8, zoom: 1.5 }, color: "#5e5ce6" }],
  friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice", avatarCrop: { x: 50, y: 50, zoom: 1 }, avatarColor: "#34c759" }]
};

test("resolveContact bot by id", () => {
  const c = resolveContact({ kind: "bot", ref: "bot_codex" }, ctx);
  assert.equal(c.kind, IdentityKind.Bot);
  assert.equal(c.id, "bot_codex");
  assert.equal(c.displayName, "Codex");
  assert.equal(c.ownerUserId, "user_me");
});

test("resolveContact bot avatar uses global bot id without owner prefix", () => {
  assert.equal(botAvatarIdentityId("bot_mia", { ownerUserId: "user_me" }), "bot_mia");
});
```

Update `tests/shared-message-spec.test.js`:

```js
test("normalizeSpec preserves authorIdentity and derives badge", () => {
  const s = normalizeSpec({
    source: "cloud-conversation",
    conversationId: "botc_1",
    messageId: "m1",
    role: "assistant",
    authorIdentity: {
      kind: "bot",
      id: "bot_mia",
      displayName: "Mia",
      statusBadge: { kind: "emoji", emoji: "⭐" }
    },
    bodyMd: "hi"
  });

  assert.equal(s.authorIdentity.kind, "bot");
  assert.equal(s.authorIdentity.id, "bot_mia");
  assert.equal(s.authorName, "Mia");
  assert.deepEqual(s.statusBadge, { kind: "emoji", emoji: "⭐" });
});
```

Update `tests/shared-send-pipeline.test.js` so `MemberKind.Bot === "bot"` and all mention expectations use `MemberKind.Bot`.

Update `tests/shared-cloud-events.test.js`:

```js
assert.equal(CloudEvent.ConversationBotInvocationRequested, "conversation.bot_invocation_requested");
assert.equal(CloudEvent.BotUpserted, "bot.upserted");
assert.equal(CloudEvent.BotDeleted, "bot.deleted");
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/shared-contact.test.js tests/shared-message-spec.test.js tests/shared-send-pipeline.test.js tests/shared-cloud-events.test.js
```

Expected: FAIL because shared modules still export `fellow` names and message spec has no `authorIdentity`.

- [ ] **Step 3: Rename shared helper files**

Run:

```bash
cd /Users/jung/GitHub/Mia
git mv packages/shared/fellow-identity.js packages/shared/bot-identity.js
git mv packages/shared/fellow-identity.d.ts packages/shared/bot-identity.d.ts
git mv src/shared/fellow-identity.js src/shared/bot-identity.js
```

In `src/shared/bot-identity.js`, replace the re-export with:

```js
module.exports = require("../../packages/shared/bot-identity.js");
```

- [ ] **Step 4: Rewrite `bot-identity` exports**

In `packages/shared/bot-identity.js`, replace public names:

```js
const DEFAULT_BOT_ID = "bot_mia";

function normalizeBotId(input) {
  return String(input || "").trim();
}

function botConversationId(sessionId) {
  const id = normalizeBotId(sessionId);
  if (!id) throw new Error("botConversationId: sessionId required");
  return id.startsWith("botc_") ? id : `botc_${id}`;
}

function normalizeBotIdentity(input = {}, options = {}) {
  if (!input || typeof input !== "object") return null;
  const id = normalizeBotId(input.id || input.botId || input.bot_id || options.id);
  if (!id || id.startsWith("fellow:") || id.startsWith("bot:")) return null;
  const displayName = firstNonEmpty(input.displayName, input.display_name, input.name, input.username, id);
  return {
    kind: "bot",
    id,
    ownerUserId: firstNonEmpty(input.ownerUserId, input.owner_user_id, options.ownerUserId, options.owner_user_id),
    name: displayName,
    displayName,
    color: normalizeBotColor(firstNonEmpty(input.color, input.avatarColor, input.avatar_color)),
    avatarImage: firstNonEmpty(input.avatarImage, input.avatar_image),
    avatarCrop: normalizeBotAvatarCrop(
      Object.prototype.hasOwnProperty.call(input, "avatarCrop")
        ? input.avatarCrop
        : Object.prototype.hasOwnProperty.call(input, "avatar_crop")
          ? input.avatar_crop
          : input.avatar_crop_json
    ),
    statusBadge: normalizeStatusBadge(input.statusBadge || input.status_badge || parseJsonObject(input.status_badge_json, null)),
    bio: firstNonEmpty(input.bio, input.description),
    capabilities: normalizeBotCapabilities(
      Object.prototype.hasOwnProperty.call(input, "capabilities")
        ? input.capabilities
        : parseJsonObject(input.capabilities_json, {})
    ),
    personaText: firstNonEmpty(input.personaText, input.persona_text),
    createdAt: firstNonEmpty(input.createdAt, input.created_at),
    updatedAt: firstNonEmpty(input.updatedAt, input.updated_at)
  };
}
```

Also rename `normalizeFellowColor`, `normalizeFellowCapabilities`, and related exports to `normalizeBotColor`, `normalizeBotCapabilities`, `defaultCloudBotCapabilities`, using the same implementation body.

- [ ] **Step 5: Update contact, send pipeline, session history, cloud events, and message spec**

Required public shapes:

```js
// packages/shared/contact.js
const IdentityKind = Object.freeze({
  User: "user",
  Bot: "bot"
});
```

```js
function botAvatarIdentityId(id, record = {}) {
  return firstNonEmpty(id, record.id, record.botId, record.bot_id, record.member_ref);
}
```

```js
// packages/shared/send-pipeline.js
const MemberKind = Object.freeze({ Bot: "bot", User: "user" });
```

```js
// packages/shared/session-history.js
function conversationType(conversation, conversationId = "") {
  const id = String(conversationId || conversation?.id || "");
  return conversation?.type
    || (id.startsWith("dm:") ? "dm"
      : id.startsWith("botc_") ? "bot"
      : (id.startsWith("g_") || id.startsWith("g-")) ? "group"
      : "");
}

function botId(conversation) {
  return String(conversation?.decorations?.botId || conversation?.botId || conversation?.bot_id || "");
}

function createBotSessionPayload(conversation, sessionId, options = {}) {
  return {
    botId: botId(conversation),
    title: options.title || "新对话",
    runtimeKind: runtimeKind(conversation, options.runtimeKindFallback || "desktop-local"),
    sessionId
  };
}
```

```js
// src/shared/cloud-events.js
ConversationBotInvocationRequested: "conversation.bot_invocation_requested",
BotUpserted: "bot.upserted",
BotDeleted: "bot.deleted"
```

```js
// src/shared/message-spec.js inside normalizeSpec return
authorIdentity: normalizeIdentity(input.authorIdentity || input.author_identity) || null,
authorName: normalizedIdentity?.displayName || input.authorName || "",
statusBadge: normalizedIdentity?.statusBadge || normalizeStatusBadge(input.statusBadge || input.status_badge),
```

- [ ] **Step 6: Update package exports**

Remove `./fellow-identity` from `packages/shared/package.json` and add:

```json
"./bot-identity": {
  "types": "./bot-identity.d.ts",
  "default": "./bot-identity.js"
}
```

Update `packages/shared/index.js`:

```js
botIdentity: require("./bot-identity.js"),
```

Update `packages/shared/index.d.ts`:

```ts
export * as botIdentity from "./bot-identity";
```

- [ ] **Step 7: Run focused tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/shared-contact.test.js tests/shared-message-spec.test.js tests/shared-send-pipeline.test.js tests/shared-session-history.test.js tests/shared-cloud-events.test.js tests/packages-shared-contract.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared src/shared tests/shared-contact.test.js tests/shared-message-spec.test.js tests/shared-send-pipeline.test.js tests/shared-session-history.test.js tests/shared-cloud-events.test.js tests/packages-shared-contract.test.js
git commit -m "refactor(bot): 收敛共享身份与会话契约"
```

### Task 3: Cloud Schema and Bot Store

**Files:**

- Rename: `src/cloud/fellows-store.js` -> `src/cloud/bots-store.js`
- Modify: `src/cloud/sqlite-store.js`
- Modify: `src/cloud/social-store.js`
- Rename test: `tests/fellows-store.test.js` -> `tests/bots-store.test.js`
- Modify test: `tests/cloud-sqlite-store.test.js`
- Modify test: `tests/cloud-social-store.test.js`

- [ ] **Step 1: Write failing bot store tests**

Rename the old store test:

```bash
cd /Users/jung/GitHub/Mia
git mv tests/fellows-store.test.js tests/bots-store.test.js
```

Replace its core expectations with:

```js
const { createBotsStore } = require("../src/cloud/bots-store");
const { normalizeBotCapabilities } = require("../src/shared/bot-identity.js");

test("upsertBot creates globally unique bot rows", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const owner = makeUser(ctx.store, "u_owner");
    const saved = bots.upsertBot(owner, {
      id: "bot_codex",
      displayName: "Codex",
      color: "#0f766e",
      avatarImage: "/avatar/codex.png",
      avatarCrop: { x: 10, y: 20, w: 100, h: 100 },
      statusBadge: { kind: "emoji", emoji: "⭐" },
      capabilities: ["chat", "tools"],
      personaText: "You are Codex."
    });

    assert.equal(saved.kind, "bot");
    assert.equal(saved.id, "bot_codex");
    assert.equal(saved.ownerUserId, owner);
    assert.equal(saved.displayName, "Codex");
    assert.deepEqual(saved.statusBadge, { kind: "emoji", emoji: "⭐" });
    assert.deepEqual(saved.capabilities, normalizeBotCapabilities(["chat", "tools"]));
  } finally { ctx.cleanup(); }
});

test("bot id is global and cannot be reused by a different owner", () => {
  const ctx = freshStore();
  try {
    const bots = createBotsStore(ctx.store.getDb());
    const a = makeUser(ctx.store, "ua");
    const b = makeUser(ctx.store, "ub");
    bots.upsertBot(a, { id: "bot_same", displayName: "A Bot" });
    assert.throws(
      () => bots.upsertBot(b, { id: "bot_same", displayName: "B Bot" }),
      /bot id already belongs to another owner/
    );
  } finally { ctx.cleanup(); }
});

test("schema has bots and no fellows table in new stores", () => {
  const ctx = freshStore();
  try {
    const db = ctx.store.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("bots"));
    assert.ok(!tables.includes("fellows"));
    assert.ok(tables.includes("bot_runtime_bindings"));
    assert.ok(!tables.includes("fellow_runtime_bindings"));
  } finally { ctx.cleanup(); }
});
```

- [ ] **Step 2: Run store tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bots-store.test.js tests/cloud-sqlite-store.test.js tests/cloud-social-store.test.js
```

Expected: FAIL because `src/cloud/bots-store.js` and `bots` schema do not exist.

- [ ] **Step 3: Rename the cloud store and implement global bot rows**

Run:

```bash
cd /Users/jung/GitHub/Mia
git mv src/cloud/fellows-store.js src/cloud/bots-store.js
```

In `src/cloud/bots-store.js`, expose:

```js
const {
  firstNonEmpty,
  normalizeBotCapabilities,
  normalizeBotIdentity
} = require("../shared/bot-identity.js");

function rowToBot(row) {
  if (!row) return null;
  return normalizeBotIdentity({
    id: row.id,
    owner_user_id: row.owner_user_id,
    display_name: row.display_name,
    color: row.color || "",
    avatar_image: row.avatar_image || "",
    avatar_crop_json: row.avatar_crop_json || "",
    status_badge_json: row.status_badge_json || "",
    bio: row.bio || "",
    capabilities: normalizeBotCapabilities(parseJsonOr(row.capabilities_json, {})),
    persona_text: row.persona_text || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function createBotsStore(db) {
  const upsertStmt = db.prepare(
    "INSERT INTO bots (id, owner_user_id, display_name, color, avatar_image, avatar_crop_json, status_badge_json, bio, capabilities_json, persona_text, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET " +
    "  owner_user_id = excluded.owner_user_id, display_name = excluded.display_name, color = excluded.color, " +
    "  avatar_image = excluded.avatar_image, avatar_crop_json = excluded.avatar_crop_json, " +
    "  status_badge_json = excluded.status_badge_json, bio = excluded.bio, capabilities_json = excluded.capabilities_json, " +
    "  persona_text = excluded.persona_text, updated_at = excluded.updated_at " +
    "RETURNING id, owner_user_id, display_name, color, avatar_image, avatar_crop_json, status_badge_json, bio, capabilities_json, persona_text, created_at, updated_at"
  );
  const selectStmt = db.prepare(
    "SELECT id, owner_user_id, display_name, color, avatar_image, avatar_crop_json, status_badge_json, bio, capabilities_json, persona_text, created_at, updated_at FROM bots WHERE id = ?"
  );
  const listByOwnerStmt = db.prepare(
    "SELECT id, owner_user_id, display_name, color, avatar_image, avatar_crop_json, status_badge_json, bio, capabilities_json, persona_text, created_at, updated_at FROM bots WHERE owner_user_id = ? ORDER BY updated_at DESC"
  );
  const deleteStmt = db.prepare("DELETE FROM bots WHERE id = ? AND owner_user_id = ?");

  function upsertBot(ownerUserId, bot) {
    if (!ownerUserId) throw new Error("upsertBot: ownerUserId required");
    const normalized = normalizeBotIdentity({ ...bot, ownerUserId });
    const explicitName = firstNonEmpty(bot?.displayName, bot?.display_name, bot?.name);
    if (!normalized || !explicitName) throw new Error("upsertBot: bot.id and bot.displayName required");
    const existing = selectStmt.get(normalized.id);
    if (existing && existing.owner_user_id && existing.owner_user_id !== String(ownerUserId)) {
      throw new Error("bot id already belongs to another owner");
    }
    const now = nowIso();
    const row = upsertStmt.get(
      normalized.id,
      String(ownerUserId),
      normalized.displayName,
      normalized.color,
      normalized.avatarImage,
      normalized.avatarCrop ? JSON.stringify(normalized.avatarCrop) : "",
      normalized.statusBadge ? JSON.stringify(normalized.statusBadge) : "",
      normalized.bio,
      JSON.stringify(normalized.capabilities),
      normalized.personaText,
      existing ? existing.created_at : now,
      now
    );
    return rowToBot(row);
  }

  function getBot(botId) {
    return rowToBot(selectStmt.get(String(botId)));
  }

  function listBots(ownerUserId) {
    return listByOwnerStmt.all(String(ownerUserId)).map(rowToBot);
  }

  function deleteBot(ownerUserId, botId) {
    return deleteStmt.run(String(botId), String(ownerUserId)).changes;
  }

  return { upsertBot, getBot, listBots, deleteBot };
}

module.exports = { createBotsStore };
```

- [ ] **Step 4: Change SQLite schema destructively**

In `src/cloud/sqlite-store.js`, replace the `fellows` and `fellow_runtime_bindings` definitions with:

```sql
CREATE TABLE IF NOT EXISTS bots (
  id                 TEXT PRIMARY KEY,
  owner_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  display_name       TEXT NOT NULL,
  color              TEXT NOT NULL DEFAULT '',
  avatar_image       TEXT NOT NULL DEFAULT '',
  avatar_crop_json   TEXT NOT NULL DEFAULT '',
  status_badge_json  TEXT NOT NULL DEFAULT '',
  bio                TEXT NOT NULL DEFAULT '',
  capabilities_json  TEXT NOT NULL DEFAULT '{}',
  persona_text       TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_user_id);

CREATE TABLE IF NOT EXISTS bot_runtime_bindings (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  runtime_kind TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  config_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, bot_id, runtime_kind)
);
```

Add destructive cleanup before creation or in the migration block:

```sql
DROP TABLE IF EXISTS fellow_runtime_bindings;
DROP TABLE IF EXISTS fellows;
UPDATE conversations SET type = 'bot' WHERE type = 'fellow';
DELETE FROM conversations WHERE id LIKE 'fellow:%';
DELETE FROM conversation_members WHERE member_kind = 'fellow';
DELETE FROM messages WHERE sender_kind = 'fellow';
```

Add `users.status_badge_json` if missing using the existing `hasColumn` pattern.

- [ ] **Step 5: Update social store member enrichment**

In `src/cloud/social-store.js`, rename `_attachFellowsStore` to `_attachBotsStore` and use:

```js
if (row.member_kind !== "bot") return row;
const def = _botsStore.getBot(row.member_ref);
if (!def) return row;
return {
  ...row,
  bot_name: def.displayName || "",
  bot_avatar_image: def.avatarImage || "",
  bot_avatar_crop: def.avatarCrop || null,
  bot_color: def.color || "",
  identity: {
    kind: "bot",
    id: def.id,
    ownerUserId: def.ownerUserId || row.owner_id || "",
    displayName: def.displayName || def.id,
    avatar: {
      image: def.avatarImage || "",
      crop: def.avatarCrop || null,
      color: def.color || "",
      text: def.displayName || def.id
    },
    statusBadge: def.statusBadge || null
  }
};
```

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bots-store.test.js tests/cloud-sqlite-store.test.js tests/cloud-social-store.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cloud tests/bots-store.test.js tests/cloud-sqlite-store.test.js tests/cloud-social-store.test.js
git commit -m "refactor(bot): 重建云端 bot 数据模型"
```

### Task 4: Cloud HTTP Routes, Events, and Runtime Bindings

**Files:**

- Modify: `scripts/serve-cloud.js`
- Modify: `src/cloud-agent/runtime-bindings-store.js`
- Modify: `src/cloud-agent/cloud-agent-runs-store.js`
- Rename test: `tests/fellows-api.test.js` -> `tests/bots-api.test.js`
- Modify: `tests/cloud-social-api.test.js`
- Modify: `tests/cloud-agent-stores.test.js`
- Modify: `tests/cloud-agent-hermes-runs-client.test.js`
- Modify: `tests/event-log-store.test.js`

- [ ] **Step 1: Rename API test and update route expectations**

Run:

```bash
cd /Users/jung/GitHub/Mia
git mv tests/fellows-api.test.js tests/bots-api.test.js
```

In `tests/bots-api.test.js`, replace routes:

```js
"/api/me/fellows/codex" -> "/api/me/bots/bot_codex"
"/api/me/fellows" -> "/api/me/bots"
"/api/me/fellows/codex/runtime" -> "/api/me/bots/bot_codex/runtime"
"/api/me/fellow-conversations/sess_1" -> "/api/me/bot-conversations/sess_1"
```

Replace response expectations:

```js
assert.equal(put.body.bot.kind, "bot");
assert.equal(put.body.bot.id, "bot_codex");
assert.equal(put.body.bot.displayName, "Codex");
assert.deepEqual(list.body.bots.map((item) => item.id), ["bot_codex"]);
```

Use event names:

```js
assert.equal(event.kind, "bot.upserted");
assert.equal(event.payload.bot.id, "bot_codex");
```

- [ ] **Step 2: Run route tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bots-api.test.js tests/cloud-social-api.test.js tests/cloud-agent-stores.test.js
```

Expected: FAIL because `scripts/serve-cloud.js` still exposes `/api/me/fellows`.

- [ ] **Step 3: Update `scripts/serve-cloud.js` imports and context**

Replace:

```js
let createFellowsStore = null;
({ createFellowsStore } = require("../src/cloud/fellows-store.js"));
```

With:

```js
let createBotsStore = null;
({ createBotsStore } = require("../src/cloud/bots-store.js"));
```

Replace context fields:

```js
fellowsStore -> botsStore
context.botsStore = createBotsStore(context.cloudStore.getDb());
context.socialStore._attachBotsStore?.(context.botsStore);
```

- [ ] **Step 4: Implement canonical bot routes**

In `scripts/serve-cloud.js`, replace route handlers with these canonical paths and response keys:

```js
// GET /api/me/bots
if (req.method === "GET" && url.pathname === "/api/me/bots") {
  const bots = context.botsStore.listBots(auth.user.id);
  return sendJson(res, 200, { bots });
}

// PUT /api/me/bots/:id
const botMatch = url.pathname.match(/^\/api\/me\/bots\/([A-Za-z0-9_.-]+)$/);
if (req.method === "PUT" && botMatch) {
  const botId = decodeURIComponent(botMatch[1]);
  const body = await readJson(req);
  const bot = context.botsStore.upsertBot(auth.user.id, {
    ...body,
    id: botId,
    displayName: body.displayName || body.display_name || body.name
  });
  context.eventLog.append(auth.user.id, "bot.upserted", { bot });
  return sendJson(res, 200, { bot });
}

// DELETE /api/me/bots/:id
if (req.method === "DELETE" && botMatch) {
  const botId = decodeURIComponent(botMatch[1]);
  const existing = context.botsStore.getBot(botId);
  if (!existing || existing.ownerUserId !== auth.user.id) return sendJson(res, 404, { error: "bot not found" });
  context.botsStore.deleteBot(auth.user.id, botId);
  context.eventLog.append(auth.user.id, "bot.deleted", { botId });
  return sendJson(res, 200, { ok: true });
}
```

Runtime routes:

```js
// GET/PUT /api/me/bots/:id/runtime
const runtimeMatch = url.pathname.match(/^\/api\/me\/bots\/([A-Za-z0-9_.-]+)\/runtime$/);
```

Session route:

```js
// PUT /api/me/bot-conversations/:sessionId
const botConversationMatch = url.pathname.match(/^\/api\/me\/bot-conversations\/([A-Za-z0-9_.:-]+)$/);
```

Do not keep `/api/me/fellows` or `/api/me/fellow-conversations` route handlers.

- [ ] **Step 5: Update runtime binding store column names**

In `src/cloud-agent/runtime-bindings-store.js`, replace SQL table/column names:

```sql
bot_runtime_bindings
bot_id
```

Expose methods with bot terminology:

```js
function upsertBinding({ userId, botId, runtimeKind, enabled = true, config = {} }) { ... }
function getBinding(userId, botId, runtimeKind) { ... }
function getEnabledBinding(userId, botId, runtimeKind) { ... }
```

Update call sites in `scripts/serve-cloud.js`, `src/cloud-agent/dispatcher.js`, and tests.

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bots-api.test.js tests/cloud-social-api.test.js tests/cloud-agent-stores.test.js tests/event-log-store.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/serve-cloud.js src/cloud-agent/runtime-bindings-store.js src/cloud-agent/cloud-agent-runs-store.js tests/bots-api.test.js tests/cloud-social-api.test.js tests/cloud-agent-stores.test.js tests/event-log-store.test.js
git commit -m "refactor(bot): 改造云端 bot API 与运行时绑定"
```

### Task 5: Bot Conversations and Cloud Agent Dispatch

**Files:**

- Rename: `src/cloud-agent/default-fellow.js` -> `src/cloud-agent/default-bot.js`
- Modify: `src/cloud-agent/dispatcher.js`
- Modify: `src/cloud-agent/group-orchestrator.js`
- Modify: `src/cloud-agent/hermes-runs-client.js`
- Modify: `src/cloud-agent/hermes-worker-manager.js`
- Modify: `src/cloud/messages-store.js` if sender helper names need updates
- Rename test: `tests/cloud-agent-default-fellow.test.js` -> `tests/cloud-agent-default-bot.test.js`
- Modify: `tests/cloud-agent-dispatcher.test.js`
- Modify: `tests/cloud-agent-hermes-client.test.js`
- Modify: `tests/cloud-agent-hermes-runs-client.test.js`
- Modify: `tests/main-cloud-conversation-ai-routing.test.js`

- [ ] **Step 1: Rename default cloud bot test and update expectations**

Run:

```bash
cd /Users/jung/GitHub/Mia
git mv src/cloud-agent/default-fellow.js src/cloud-agent/default-bot.js
git mv tests/cloud-agent-default-fellow.test.js tests/cloud-agent-default-bot.test.js
```

Update test imports:

```js
const { createBotsStore } = require("../src/cloud/bots-store.js");
const { ensureDefaultCloudBot } = require("../src/cloud-agent/default-bot.js");
const { normalizeBotCapabilities } = require("../src/shared/bot-identity.js");
```

Required expectations:

```js
assert.equal(out1.bot.id, "bot_mia");
assert.equal(out1.conversation.type, "bot");
assert.match(out1.conversation.id, /^botc_/);
assert.equal(out1.conversation.decorations.botId, "bot_mia");
assert.equal(members.find((m) => m.member_kind === "bot").member_ref, "bot_mia");
```

- [ ] **Step 2: Run focused cloud-agent tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/cloud-agent-default-bot.test.js tests/cloud-agent-dispatcher.test.js tests/cloud-agent-hermes-client.test.js
```

Expected: FAIL because dispatcher and default bot still use fellow names and sender kinds.

- [ ] **Step 3: Implement `ensureDefaultCloudBot`**

In `src/cloud-agent/default-bot.js`, expose:

```js
const DEFAULT_CLOUD_BOT_ID = "bot_mia";

function ensureDefaultCloudBot(context, ownerUserId, botId = DEFAULT_CLOUD_BOT_ID) {
  let bot = context.botsStore.getBot(botId);
  if (!bot) {
    bot = context.botsStore.upsertBot(ownerUserId, {
      id: botId,
      displayName: "Mia",
      bio: "Mia Bot",
      capabilities: defaultCloudBotCapabilities(),
      personaText: "You are Mia."
    });
  }
  const binding = context.runtimeBindingsStore.upsertBinding({
    userId: ownerUserId,
    botId,
    runtimeKind: "cloud-hermes",
    enabled: true,
    config: {}
  });
  const conversation = context.socialStore.createConversation({
    id: `botc_${crypto.randomBytes(8).toString("hex")}`,
    type: "bot",
    name: bot.displayName,
    decorations: { botId, runtimeKind: "cloud-hermes" }
  });
  context.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "user", memberRef: ownerUserId });
  context.socialStore.addConversationMember({ conversationId: conversation.id, memberKind: "bot", memberRef: botId, ownerId: ownerUserId });
  return { bot, binding, conversation };
}

module.exports = { DEFAULT_CLOUD_BOT_ID, ensureDefaultCloudBot };
```

If existing code needs idempotent conversation lookup, implement it by selecting a `type = 'bot'` conversation whose decorations JSON contains `"botId":"bot_mia"` before creating a new one.

- [ ] **Step 4: Update dispatcher vocabulary and sender kinds**

In `src/cloud-agent/dispatcher.js`, replace dependency names:

```js
botsStore: requireDep(deps, "botsStore")
```

Replace invocation payload fields:

```js
botId
bot
senderKind: "bot"
senderRef: bot.id
senderOwnerId: bot.ownerUserId || ownerId
```

Replace cloud event check:

```js
if (message.type === CloudEvent.ConversationBotInvocationRequested) { ... }
```

- [ ] **Step 5: Update Hermes headers without keeping Fellow product naming**

In `src/cloud-agent/hermes-runs-client.js`, use:

```js
"X-Mia-Bot": botId,
"X-Alkaka-Bot": botId
```

Remove `X-Mia-Fellow` and `X-Alkaka-Fellow` unless upstream Hermes requires them. If upstream requires legacy headers, isolate them in one function named `legacyHermesBotHeaders(botId)` and add a comment that this is an upstream protocol adapter, not a Mia product field.

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/cloud-agent-default-bot.test.js tests/cloud-agent-dispatcher.test.js tests/cloud-agent-hermes-client.test.js tests/cloud-agent-hermes-runs-client.test.js tests/main-cloud-conversation-ai-routing.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cloud-agent src/cloud/messages-store.js tests/cloud-agent-default-bot.test.js tests/cloud-agent-dispatcher.test.js tests/cloud-agent-hermes-client.test.js tests/cloud-agent-hermes-runs-client.test.js tests/main-cloud-conversation-ai-routing.test.js
git commit -m "refactor(bot): 改造云端 bot 会话与调度"
```

### Task 6: Main Process Bot Naming, IPC, and Runtime Context

**Files:**

- Rename: `src/main/fellow-manifest.js` -> `src/main/bot-manifest.js`
- Rename: `src/main/fellow-registry.js` -> `src/main/bot-registry.js`
- Rename: `src/main/social/fellow-invocation.js` -> `src/main/social/bot-invocation.js`
- Rename: `src/main/social/fellow-runtime-dispatcher.js` -> `src/main/social/bot-runtime-dispatcher.js`
- Rename: `src/main/social/local-fellow-responder.js` -> `src/main/social/local-bot-responder.js`
- Modify: `src/main.js`
- Modify: `src/main/social/social-api.js`
- Modify: `src/main/social/social-ipc.js`
- Modify: `src/main/cloud/desktop-sync-client.js`
- Modify: `src/main/cloud/cloud-events-client.js`
- Modify: `src/main/mia-app-mcp-server.js`
- Modify: `src/main/mia-app-mcp-bridge.js`
- Modify: `src/main/mia-memory-service.js`
- Modify: `src/main/scheduler-mcp-bridge.js`
- Modify: `src/main/external-agent-command-service.js`
- Modify: `src/main/chat-engine-adapters.js`
- Modify: `src/main/hermes-chat-adapter.js`
- Modify: `src/main/codex-chat-adapter.js`
- Modify: `src/main/claude-code-chat-adapter.js`
- Modify: `src/shared/ipc-channels.js`
- Modify: `src/preload.js`
- Rename/update related tests:
  - `tests/fellow-registry.test.js` -> `tests/bot-registry.test.js`
  - `tests/local-fellow-responder.test.js` -> `tests/local-bot-responder.test.js`
  - `tests/main-fellow-runtime-dispatcher.test.js` -> `tests/main-bot-runtime-dispatcher.test.js`
  - `tests/fellow-service.test.js` -> `tests/bot-service.test.js` if the source file exists

- [ ] **Step 1: Rename files and tests**

Run the renames that exist:

```bash
cd /Users/jung/GitHub/Mia
git mv src/main/fellow-manifest.js src/main/bot-manifest.js
git mv src/main/fellow-registry.js src/main/bot-registry.js
git mv src/main/social/fellow-invocation.js src/main/social/bot-invocation.js
git mv src/main/social/fellow-runtime-dispatcher.js src/main/social/bot-runtime-dispatcher.js
git mv src/main/social/local-fellow-responder.js src/main/social/local-bot-responder.js
git mv tests/fellow-registry.test.js tests/bot-registry.test.js
git mv tests/local-fellow-responder.test.js tests/local-bot-responder.test.js
git mv tests/main-fellow-runtime-dispatcher.test.js tests/main-bot-runtime-dispatcher.test.js
```

If `src/main/fellow-service.js` exists at execution time, run:

```bash
git mv src/main/fellow-service.js src/main/bot-service.js
git mv tests/fellow-service.test.js tests/bot-service.test.js
```

- [ ] **Step 2: Update tests to new API names**

In `tests/main-social-api.test.js`, replace expectations:

```js
assert.equal(seen[0].url, "/api/me/bots/bot_alice");
assert.equal(seen[0].url, "/api/me/bot-conversations/sess_1");
assert.equal(seen[0].url, "/api/me/bots/bot_alice/runtime");
```

In `tests/bot-registry.test.js`, require:

```js
const {
  normalizedBotList,
  requireBot,
  resolveBot
} = require("../src/main/bot-registry.js");
```

In `tests/mia-memory-service.test.js`, require the memory header:

```js
assert.match(block, /^## Mia Bot Memory/);
assert.match(block, /bot: bot_mia/);
```

- [ ] **Step 3: Run focused main tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bot-registry.test.js tests/local-bot-responder.test.js tests/main-bot-runtime-dispatcher.test.js tests/main-social-api.test.js tests/mia-memory-service.test.js tests/mia-app-mcp-server.test.js
```

Expected: FAIL because main modules still export fellow names.

- [ ] **Step 4: Update IPC constants and preload API**

In `src/shared/ipc-channels.js`, replace:

```js
FellowDetails: "bot:details",
FellowSave: "bot:save",
FellowEngineSave: "bot:engine-save",
FellowPin: "bot:pin",
FellowMute: "bot:mute",
FellowDelete: "bot:delete",
SocialListBots: "social:list-bots",
SocialSaveBotIdentity: "social:save-bot-identity",
SocialDeleteBot: "social:delete-bot",
SocialEnsureBotConversation: "social:ensure-bot-conversation",
SocialEnsureBotSessionConversation: "social:ensure-bot-session-conversation",
SocialGetBotRuntime: "social:get-bot-runtime",
SocialSaveBotRuntime: "social:save-bot-runtime"
```

In `src/preload.js`, expose bot methods:

```js
listBots: () => ipcRenderer.invoke(IpcChannel.SocialListBots),
saveBotIdentity: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialSaveBotIdentity, botId, body),
deleteBot: (botId) => ipcRenderer.invoke(IpcChannel.SocialDeleteBot, botId),
ensureBotConversation: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureBotConversation, botId, body),
ensureBotSessionConversation: (sessionId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureBotSessionConversation, sessionId, body),
getBotRuntime: (botId, runtimeKind) => ipcRenderer.invoke(IpcChannel.SocialGetBotRuntime, botId, runtimeKind),
saveBotRuntime: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialSaveBotRuntime, botId, body)
```

- [ ] **Step 5: Update social API and IPC handlers**

In `src/main/social/social-api.js`, expose:

```js
async listBots() {
  return jsonFetch({ ...ctx(), method: "GET", path: "/api/me/bots" });
}
async saveBotIdentity(botId, body = {}) {
  return jsonFetch({ ...ctx(), method: "PUT", path: `/api/me/bots/${encodeURIComponent(botId)}`, body: withOpId(body) });
}
async deleteBot(botId) {
  return jsonFetch({ ...ctx(), method: "DELETE", path: `/api/me/bots/${encodeURIComponent(botId)}` });
}
async ensureBotSessionConversation(sessionId, body = {}) {
  return jsonFetch({ ...ctx(), method: "PUT", path: `/api/me/bot-conversations/${encodeURIComponent(sessionId)}`, body: withOpId(body) });
}
async getBotRuntime(botId, runtimeKind) {
  return jsonFetch({ ...ctx(), method: "GET", path: `/api/me/bots/${encodeURIComponent(botId)}/runtime?kind=${encodeURIComponent(runtimeKind)}` });
}
async saveBotRuntime(botId, body = {}) {
  return jsonFetch({ ...ctx(), method: "PUT", path: `/api/me/bots/${encodeURIComponent(botId)}/runtime`, body: withOpId(body) });
}
```

In `src/main/social/social-ipc.js`, bind the new IPC constants to these methods.

- [ ] **Step 6: Update memory and MCP terminology**

In `src/main/mia-memory-service.js`, replace:

```js
const MIA_MEMORY_HEADER = "## Mia Bot Memory";
```

The memory block should include:

```text
## Mia Bot Memory
source: mia
bot: <bot_id>
conversation: <session_id>

### Shared User Memory
...

### Bot Memory
...
```

In `src/main/mia-app-mcp-server.js`, rename tool:

```js
{ name: "bot_list", description: "List Mia bots and basic runtime metadata.", inputSchema: { type: "object" } }
```

In MCP context bridges, replace `{ fellowId, sessionId }` with `{ botId, sessionId }`.

- [ ] **Step 7: Update chat adapters**

For Hermes, Codex, and Claude Code adapters, rename context fields:

```js
sendChat({ bot, sessionId, messages, group, signal, emit, ... })
writeMiaAppMcpContext({ botId: bot.id, sessionId, originMessageId })
memoryBlock({ botId: bot.id, sessionId })
getAgentSessionId(engine, bot.id, sessionId)
setAgentSessionId(engine, bot.id, sessionId, capturedSessionId)
```

The adapter can still pass a variable named `persona` to an upstream SDK if the upstream interface uses that term, but Mia-owned function parameters should be `bot`.

- [ ] **Step 8: Run focused main tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bot-registry.test.js tests/local-bot-responder.test.js tests/main-bot-runtime-dispatcher.test.js tests/main-social-api.test.js tests/mia-memory-service.test.js tests/mia-app-mcp-server.test.js tests/mia-app-mcp-bridge.test.js tests/scheduler-mcp-bridge.test.js tests/hermes-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/preload-sandbox.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main src/shared/ipc-channels.js src/preload.js tests/bot-registry.test.js tests/local-bot-responder.test.js tests/main-bot-runtime-dispatcher.test.js tests/main-social-api.test.js tests/mia-memory-service.test.js tests/mia-app-mcp-server.test.js tests/mia-app-mcp-bridge.test.js tests/scheduler-mcp-bridge.test.js tests/hermes-chat-adapter.test.js tests/codex-chat-adapter.test.js tests/claude-code-chat-adapter.test.js tests/preload-sandbox.test.js
git commit -m "refactor(bot): 统一主进程 bot 运行时命名"
```

### Task 7: Renderer NameWithBadge

**Files:**

- Create: `src/renderer/name-with-badge.js`
- Create: `src/renderer/styles/name-with-badge.css`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/message-bubble-renderer.js`
- Modify: `src/renderer/sidebar-card-renderer.js`
- Modify: `src/renderer/social/social.js`
- Modify: `tests/message-bubble-renderer.test.js`
- Modify: `tests/sidebar-card-renderer.test.js`
- Create: `tests/name-with-badge-renderer.test.js`

- [ ] **Step 1: Write failing renderer tests**

Create `tests/name-with-badge-renderer.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function mockEl(tagName = "SPAN") {
  return {
    tagName,
    className: "",
    attrs: {},
    children: [],
    _text: "",
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attrs[k] = v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; }
  };
}

function loadModule() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "name-with-badge.js"), "utf8");
  const window = {};
  const document = { createElement: (tag) => mockEl(String(tag || "span").toUpperCase()) };
  const ctx = vm.createContext({ window, globalThis: window, document, console });
  vm.runInContext(src, ctx);
  return window.miaNameWithBadge;
}

test("renderNameWithBadge renders display name and emoji badge", () => {
  const api = loadModule();
  const el = api.renderNameWithBadge({
    identity: { kind: "bot", id: "bot_mia", displayName: "Mia", statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" } }
  });
  assert.equal(el.className, "name-with-badge");
  assert.equal(el.children[0].textContent, "Mia");
  assert.equal(el.children[1].textContent, "⭐");
  assert.equal(el.children[1].attrs.title, "Premium");
});

test("renderNameWithBadge omits invalid badge without changing name", () => {
  const api = loadModule();
  const el = api.renderNameWithBadge({
    identity: { kind: "user", id: "u1", displayName: "Alice", statusBadge: { kind: "lottie", assetId: "" } }
  });
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].textContent, "Alice");
});
```

Update `tests/message-bubble-renderer.test.js` with:

```js
window.miaNameWithBadge = {
  renderNameWithBadge: ({ identity, fallbackName }) => {
    const el = mockEl();
    el.className = "name-with-badge";
    el.textContent = identity?.displayName || fallbackName || "";
    return el;
  }
};
```

And assert assistant author gets `name-with-badge` in the sender row.

- [ ] **Step 2: Run focused renderer tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/name-with-badge-renderer.test.js tests/message-bubble-renderer.test.js tests/sidebar-card-renderer.test.js
```

Expected: FAIL because `src/renderer/name-with-badge.js` does not exist.

- [ ] **Step 3: Add `NameWithBadge` renderer module**

Create `src/renderer/name-with-badge.js`:

```js
(function attachNameWithBadge(root, factory) {
  const api = factory(root);
  if (root) root.miaNameWithBadge = api;
})(typeof window !== "undefined" ? window : globalThis, function buildNameWithBadge(root) {
  "use strict";

  function clean(value) {
    return String(value || "").trim();
  }

  function badgeFrom(identity, explicitBadge) {
    const badge = explicitBadge || identity?.statusBadge || null;
    if (!badge || typeof badge !== "object") return null;
    const kind = clean(badge.kind);
    if (kind === "emoji" && clean(badge.emoji)) return { kind, emoji: clean(badge.emoji), label: clean(badge.label) };
    if (kind === "lottie" && clean(badge.assetId)) return { kind, assetId: clean(badge.assetId), label: clean(badge.label), loop: clean(badge.loop) };
    if (kind === "gift" && clean(badge.assetId)) return { kind, assetId: clean(badge.assetId), label: clean(badge.label), collectibleId: clean(badge.collectibleId) };
    return null;
  }

  function renderBadge(badge) {
    const el = document.createElement("span");
    el.className = `name-status-badge ${badge.kind}`;
    if (badge.label) el.setAttribute("title", badge.label);
    if (badge.kind === "emoji") {
      el.textContent = badge.emoji;
      return el;
    }
    el.setAttribute("data-asset-id", badge.assetId);
    if (badge.collectibleId) el.setAttribute("data-collectible-id", badge.collectibleId);
    el.textContent = "";
    return el;
  }

  function renderNameWithBadge({ identity = null, fallbackName = "", statusBadge = null } = {}) {
    const wrap = document.createElement("span");
    wrap.className = "name-with-badge";
    const name = document.createElement("span");
    name.className = "name-with-badge-text";
    name.textContent = clean(identity?.displayName) || clean(fallbackName) || "未知";
    wrap.appendChild(name);
    const badge = badgeFrom(identity, statusBadge);
    if (badge) wrap.appendChild(renderBadge(badge));
    return wrap;
  }

  return { renderNameWithBadge };
});
```

Create `src/renderer/styles/name-with-badge.css`:

```css
.name-with-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;
}

.name-with-badge-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name-status-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 13px;
  line-height: 1;
}
```

Add both files to `src/renderer/index.html` in the existing shared renderer script/style section:

```html
<link rel="stylesheet" href="./styles/name-with-badge.css">
<script src="./name-with-badge.js"></script>
```

- [ ] **Step 4: Use `NameWithBadge` in message bubbles and sidebar cards**

In `src/renderer/message-bubble-renderer.js`, replace direct sender text creation with:

```js
const sender = document.createElement("span");
sender.className = "bubble-sender";
const nameEl = root.miaNameWithBadge?.renderNameWithBadge?.({
  identity: spec.authorIdentity,
  fallbackName: spec.authorName,
  statusBadge: spec.statusBadge
});
if (nameEl) sender.appendChild(nameEl);
else sender.textContent = spec.authorName || "";
```

Apply the same pattern in `src/renderer/sidebar-card-renderer.js` for conversation title names that have `spec.identity` or `spec.statusBadge`.

- [ ] **Step 5: Run focused renderer tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/name-with-badge-renderer.test.js tests/message-bubble-renderer.test.js tests/sidebar-card-renderer.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/name-with-badge.js src/renderer/styles/name-with-badge.css src/renderer/index.html src/renderer/message-bubble-renderer.js src/renderer/sidebar-card-renderer.js tests/name-with-badge-renderer.test.js tests/message-bubble-renderer.test.js tests/sidebar-card-renderer.test.js
git commit -m "feat(bot): 增加统一昵称徽章渲染"
```

### Task 8: Renderer Bot Modules and Message Sources

**Files:**

- Rename: `src/renderer/fellow/` -> `src/renderer/bot/`
- Rename: `src/renderer/message-sources/fellow-session-source.js` -> `src/renderer/message-sources/bot-session-source.js`
- Rename: `src/renderer/styles/fellow-store.css` -> `src/renderer/styles/bot-store.css`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/app-state.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/social/social.js`
- Modify: `src/renderer/social/social-groups.js`
- Modify: `src/renderer/social/contact-card.js`
- Modify: `src/renderer/helpers/avatar-helpers.js`
- Modify: `src/renderer/contact-avatar.js`
- Rename/update tests:
  - `tests/fellow-session-source.test.js` -> `tests/bot-session-source.test.js`
  - `tests/fellow-directory.test.js` -> `tests/bot-directory.test.js`
  - `tests/fellow-commands.test.js` -> `tests/bot-commands.test.js`
  - `tests/contact-card-ownership.test.js`
  - `tests/cloud-conversation-source.test.js`
  - `tests/renderer-social.test.js`

- [ ] **Step 1: Rename renderer files**

Run:

```bash
cd /Users/jung/GitHub/Mia
mkdir -p src/renderer/bot
git mv src/renderer/fellow/fellow-commands.js src/renderer/bot/bot-commands.js
git mv src/renderer/fellow/fellow-dialog.js src/renderer/bot/bot-dialog.js
git mv src/renderer/fellow/fellow-directory.js src/renderer/bot/bot-directory.js
git mv src/renderer/fellow/fellow-manager.js src/renderer/bot/bot-manager.js
git mv src/renderer/fellow/fellow-store.js src/renderer/bot/bot-store.js
rmdir src/renderer/fellow
git mv src/renderer/message-sources/fellow-session-source.js src/renderer/message-sources/bot-session-source.js
git mv src/renderer/styles/fellow-store.css src/renderer/styles/bot-store.css
git mv tests/fellow-session-source.test.js tests/bot-session-source.test.js
git mv tests/fellow-directory.test.js tests/bot-directory.test.js
git mv tests/fellow-commands.test.js tests/bot-commands.test.js
```

- [ ] **Step 2: Update renderer tests to assert bot vocabulary**

In `tests/bot-session-source.test.js`, require `window.miaBotSessionSource` and assert:

```js
assert.equal(spec.authorIdentity.kind, "bot");
assert.equal(spec.authorIdentity.id, "bot_codex");
assert.equal(spec.authorName, "Codex");
```

In `tests/renderer-social.test.js`, replace group member setup:

```js
memberBots: [{ botId: "bot_codex", runtimeKind: "cloud-hermes" }]
```

In `tests/contact-card-ownership.test.js`, replace expected identity id:

```js
assert.equal(card.identity.id, "bot_mia");
assert.equal(card.identity.ownerUserId, "user_me");
```

- [ ] **Step 3: Run focused renderer tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bot-session-source.test.js tests/bot-directory.test.js tests/bot-commands.test.js tests/contact-card-ownership.test.js tests/cloud-conversation-source.test.js tests/renderer-social.test.js
```

Expected: FAIL until module globals, HTML script paths, and API calls are renamed.

- [ ] **Step 4: Update browser globals and HTML**

In `src/renderer/index.html`, replace script/style paths:

```html
<link rel="stylesheet" href="./styles/bot-store.css">
<script src="./bot/bot-manager.js"></script>
<script src="./bot/bot-directory.js"></script>
<script src="./bot/bot-dialog.js"></script>
<script src="./bot/bot-commands.js"></script>
<script src="./bot/bot-store.js"></script>
<script src="./message-sources/bot-session-source.js"></script>
```

In renamed renderer modules, expose globals:

```js
window.miaBotCommands
window.miaBotDirectory
window.miaBotDialog
window.miaBotManager
window.miaBotStore
window.miaBotSessionSource
```

- [ ] **Step 5: Update app and social data fields**

Replace renderer state fields:

```js
state.fellows -> state.bots
defaultFellow -> defaultBot
fellowKey -> botId
fellow -> bot
memberFellows -> memberBots
fellow_name -> bot_name
fellow_avatar_image -> bot_avatar_image
fellow_avatar_crop -> bot_avatar_crop
```

For bot author specs, build:

```js
authorIdentity: {
  kind: "bot",
  id: bot.id,
  ownerUserId: bot.ownerUserId || bot.owner_user_id || "",
  displayName: bot.displayName || bot.name || bot.id,
  avatar,
  statusBadge: bot.statusBadge || null
}
```

Use `NameWithBadge` for sender names in `src/renderer/social/social.js` and `src/renderer/social/social-groups.js`.

- [ ] **Step 6: Run focused renderer tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/bot-session-source.test.js tests/bot-directory.test.js tests/bot-commands.test.js tests/contact-card-ownership.test.js tests/cloud-conversation-source.test.js tests/renderer-social.test.js tests/name-with-badge-renderer.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer tests/bot-session-source.test.js tests/bot-directory.test.js tests/bot-commands.test.js tests/contact-card-ownership.test.js tests/cloud-conversation-source.test.js tests/renderer-social.test.js
git commit -m "refactor(bot): 重命名渲染端 bot 模块"
```

### Task 9: Web and Mobile Bot Types

**Files:**

- Modify: `src/web/app.js`
- Modify: `src/web/app/index.html`
- Modify: `src/web/styles.css`
- Modify: `apps/mobile-rn/src/api/types.ts`
- Modify: `apps/mobile-rn/src/logic/conversationList.ts`
- Modify: `apps/mobile-rn/src/components/MessageBubble.tsx`
- Modify: `tests/web-unread-routing.test.js`
- Modify: `tests/mobile-cloud-client.test.js`
- Modify: `tests/web-cloud-conversation-source-routing.test.js`

- [ ] **Step 1: Update tests to bot API and type names**

In `tests/web-unread-routing.test.js`, replace route expectations:

```js
/api/me/bots
/api/me/bot-conversations/${encodeURIComponent(payload.sessionId)}
```

Replace DOM ids:

```js
convMenuNewBot
webCreateBotForm
webBotAvatarPreview
```

In `tests/mobile-cloud-client.test.js`, use:

```ts
sender_kind: "bot"
bot_id: "bot_mia"
```

- [ ] **Step 2: Run focused web/mobile tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/web-unread-routing.test.js tests/mobile-cloud-client.test.js tests/web-cloud-conversation-source-routing.test.js
```

Expected: FAIL until web/mobile code uses bot names.

- [ ] **Step 3: Update mobile TypeScript types**

In `apps/mobile-rn/src/api/types.ts`, replace:

```ts
export type SenderKind = "user" | "bot" | "system";

export interface Conversation {
  id: string;
  type?: "dm" | "group" | "bot" | string;
  bot_id?: string;
  botId?: string;
  decorations?: { botId?: string; botName?: string; runtimeKind?: string };
  identity?: { avatar?: AvatarDescriptor; statusBadge?: StatusBadge | null };
}

export interface Member {
  member_kind?: "user" | "bot" | string;
  member_ref?: string;
  owner_id?: string;
  owner_user_id?: string;
  bot_name?: string;
  bot_avatar_image?: string;
  bot_avatar_crop?: Record<string, unknown> | null;
  identity?: Identity;
}
```

Add local `StatusBadge` and `Identity` types in the same file or import them from `packages/shared` if the mobile workspace already consumes shared declarations.

- [ ] **Step 4: Update web app routes and state**

In `src/web/app.js`, replace:

```js
state.fellows -> state.bots
api("/api/me/fellows?compact=1") -> api("/api/me/bots?compact=1")
api(`/api/me/fellow-conversations/${encodeURIComponent(payload.sessionId)}`) -> api(`/api/me/bot-conversations/${encodeURIComponent(payload.sessionId)}`)
memberFellows -> memberBots
```

Render status badges by using the same identity shape:

```js
const identity = {
  kind: "bot",
  id: bot.id,
  displayName: bot.displayName || bot.name || bot.id,
  avatar: bot.avatar,
  statusBadge: bot.statusBadge || null
};
```

- [ ] **Step 5: Run focused web/mobile tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/web-unread-routing.test.js tests/mobile-cloud-client.test.js tests/web-cloud-conversation-source-routing.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web apps/mobile-rn/src tests/web-unread-routing.test.js tests/mobile-cloud-client.test.js tests/web-cloud-conversation-source-routing.test.js
git commit -m "refactor(bot): 更新 Web 与移动端 bot 类型"
```

### Task 10: Status Badge Storage and API Roundtrip

**Files:**

- Modify: `src/cloud/sqlite-store.js`
- Modify: `src/cloud/bots-store.js`
- Modify: `scripts/serve-cloud.js`
- Modify: `src/shared/message-spec.js`
- Modify: `src/renderer/name-with-badge.js`
- Modify: `tests/shared-identity.test.js`
- Modify: `tests/bots-store.test.js`
- Modify: `tests/bots-api.test.js`
- Modify: `tests/name-with-badge-renderer.test.js`

- [ ] **Step 1: Add failing roundtrip assertions**

In `tests/bots-api.test.js`, add:

```js
test("PUT and GET /api/me/bots roundtrip statusBadge", async () => {
  const ctx = await startTestServer();
  try {
    const A = await signup(ctx.port, "badge-a");
    const put = await api(ctx.port, "PUT", "/api/me/bots/bot_badge", {
      token: A.token,
      body: {
        displayName: "Badge Bot",
        statusBadge: { kind: "gift", assetId: "rose", collectibleId: "nft_rose_1" }
      }
    });
    assert.deepEqual(put.body.bot.statusBadge, { kind: "gift", assetId: "rose", collectibleId: "nft_rose_1" });
    const list = await api(ctx.port, "GET", "/api/me/bots", { token: A.token });
    assert.deepEqual(list.body.bots[0].statusBadge, { kind: "gift", assetId: "rose", collectibleId: "nft_rose_1" });
  } finally {
    await ctx.close();
  }
});
```

In `tests/shared-message-spec.test.js`, assert user badge also derives:

```js
assert.deepEqual(s.statusBadge, { kind: "emoji", emoji: "✅" });
```

- [ ] **Step 2: Run badge tests and verify they fail**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/shared-identity.test.js tests/bots-store.test.js tests/bots-api.test.js tests/shared-message-spec.test.js tests/name-with-badge-renderer.test.js
```

Expected: FAIL if any storage/API path drops `statusBadge`.

- [ ] **Step 3: Persist badge JSON for users and bots**

In `src/cloud/sqlite-store.js`, ensure:

```js
if (!hasColumn(db, "users", "status_badge_json")) {
  db.exec("ALTER TABLE users ADD COLUMN status_badge_json TEXT NOT NULL DEFAULT ''");
}
```

In `src/cloud/bots-store.js`, parse and serialize:

```js
status_badge_json: normalized.statusBadge ? JSON.stringify(normalized.statusBadge) : ""
```

In `scripts/serve-cloud.js`, accept both camel and snake body fields:

```js
statusBadge: body.statusBadge || body.status_badge || null
```

- [ ] **Step 4: Run badge tests and verify they pass**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/shared-identity.test.js tests/bots-store.test.js tests/bots-api.test.js tests/shared-message-spec.test.js tests/name-with-badge-renderer.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/sqlite-store.js src/cloud/bots-store.js scripts/serve-cloud.js src/shared/message-spec.js src/renderer/name-with-badge.js tests/shared-identity.test.js tests/bots-store.test.js tests/bots-api.test.js tests/shared-message-spec.test.js tests/name-with-badge-renderer.test.js
git commit -m "feat(bot): 持久化身份状态徽章"
```

### Task 11: Legacy Fellow Cleanup Guard

**Files:**

- Create: `tests/no-legacy-fellow-identifiers.test.js`
- Modify: `tests/project-structure-check.test.js` only if it duplicates the same concern
- Modify production files found by this task's `rg` command

- [ ] **Step 1: Add failing static guard**

Create `tests/no-legacy-fellow-identifiers.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["src", "packages", "apps/mobile-rn/src", "scripts"];
const ALLOWED = new Set([
  "docs/superpowers/specs/2026-06-05-bot-identity-status-badge-design.md",
  "docs/superpowers/plans/2026-06-05-bot-identity-status-badge-full-migration.md"
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|ts|tsx|css|html|json|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("production source has no legacy fellow identifiers", () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/\bfellow\b|Fellow|fellows|fellow_/.test(text)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run the guard and verify it fails**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/no-legacy-fellow-identifiers.test.js
```

Expected: FAIL with the remaining production files that still contain legacy identifiers.

- [ ] **Step 3: Remove remaining production `fellow` identifiers**

Use:

```bash
cd /Users/jung/GitHub/Mia
rg -n "\\bfellow\\b|Fellow|fellows|fellow_" src packages apps/mobile-rn/src scripts
```

For each remaining production hit, choose one of these concrete replacements:

```text
fellow -> bot
Fellow -> Bot
fellows -> bots
fellow_id -> bot_id
fellowId -> botId
fellowKey -> botId
fellow_name -> bot_name
fellow_avatar_image -> bot_avatar_image
fellow_avatar_crop -> bot_avatar_crop
ConversationFellowInvocationRequested -> ConversationBotInvocationRequested
conversation.fellow_invocation_requested -> conversation.bot_invocation_requested
```

If a remaining hit is an upstream protocol compatibility shim, move it into one function named `legacyHermesBotHeaders` and add the file path to the test allowlist only for that exact function. Do not allow generic app code to keep `fellow`.

- [ ] **Step 4: Run guard and focused renamed test set**

Run:

```bash
cd /Users/jung/GitHub/Mia
node --test tests/no-legacy-fellow-identifiers.test.js
node --test tests/shared-identity.test.js tests/bots-store.test.js tests/bots-api.test.js tests/bot-registry.test.js tests/bot-session-source.test.js tests/name-with-badge-renderer.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/no-legacy-fellow-identifiers.test.js src packages apps/mobile-rn/src scripts tests
git commit -m "test(bot): 阻止 fellow 命名回流"
```

### Task 12: Full Verification and Final Fixes

**Files:**

- Modify only files required to fix failures from the full test/check pass.

- [ ] **Step 1: Run full test suite**

Run:

```bash
cd /Users/jung/GitHub/Mia
npm test
```

Expected: PASS.

If it fails, fix the failing test's production code or update stale test vocabulary only when the production behavior is already correct. Do not delete tests to make the suite pass.

- [ ] **Step 2: Run project check**

Run:

```bash
cd /Users/jung/GitHub/Mia
npm run check
```

Expected: PASS.

- [ ] **Step 3: Run final static search**

Run:

```bash
cd /Users/jung/GitHub/Mia
rg -n "\\bfellow\\b|Fellow|fellows|fellow_" src packages apps/mobile-rn/src scripts
```

Expected: no output, except for an explicitly reviewed upstream compatibility shim named `legacyHermesBotHeaders`.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
cd /Users/jung/GitHub/Mia
git status --short
git diff --stat HEAD
```

Expected: only intentional bot migration files are modified. There should be no accidental deletes outside `fellow` to `bot` renames and planned status badge files.

- [ ] **Step 5: Commit final fixes if needed**

If Step 1 or Step 2 required fixes:

```bash
git add <fixed-files>
git commit -m "fix(bot): 补齐全量迁移验证问题"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

Spec coverage:

- Global `bot.id`: Task 1 identity contract, Task 3 bots table, Task 4 routes.
- `ownerUserId` as metadata only: Task 1 identity normalization, Task 3 store, Task 5 members/senders.
- No long-lived `fellow` compatibility: Task 11 static guard.
- Destructive migration: Task 3 schema cleanup.
- Unified user/bot statusBadge: Task 1, Task 7, Task 10.
- Desktop/web/mobile rendering contracts: Task 7, Task 8, Task 9.
- API and IPC rename: Task 4 and Task 6.

Placeholder scan:

- The plan avoids deferred placeholder work and vague "fill this in" instructions.
- Every code-producing task includes the concrete file paths, commands, expected failure/pass result, and commit command.

Type consistency:

- Identity kind is always `"bot"` / `"user"`.
- Bot id field is always `id` or `botId` in request/context objects.
- Database column is always `bot_id` where a foreign/reference column is needed.
- Status badge field is `statusBadge` in JS and `status_badge_json` in SQLite.
