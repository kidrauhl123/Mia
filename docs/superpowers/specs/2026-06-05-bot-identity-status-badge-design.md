# Bot Identity and Status Badge Full Migration Design

Date: 2026-06-05

## Goal

Mia should replace the legacy `fellow` identity model with a canonical `bot` model and use one shared identity contract for users and bots.

The product is not formally launched, so this migration can be breaking and destructive. The goal is not to preserve pre-release data; the goal is to remove the ambiguous legacy model before it becomes expensive to support.

## Product Decisions

1. The canonical AI participant type is `bot`.
2. `bot` is an identity type, not a limitation on capability. A bot may still run Agent-grade tools, memory, runtime adapters, permissions, and workflows.
3. `bot.id` is globally unique. It is not scoped by owner.
4. `ownerUserId` is a management and permission field. It does not participate in bot identity uniqueness.
5. UI should render names, avatars, and status badges from a single identity object. UI should not care whether the identity is a human user or a bot.
6. `fellow` should be removed from production source naming, protocol fields, routes, IPC channels, schema tables, enum values, CSS feature names, and mobile/web types.

## Identity Contract

The shared identity contract lives in `packages/shared/identity.js` with TypeScript declarations.

```ts
type IdentityKind = "user" | "bot";

type Identity = {
  kind: IdentityKind;
  id: string;
  displayName: string;
  avatar?: AvatarDescriptor;
  statusBadge?: StatusBadge | null;
  ownerUserId?: string;
};
```

Rules:

- `id` is the canonical entity id. It must not contain `user:` or `bot:` prefixes.
- `kind` distinguishes users and bots.
- `ownerUserId` may exist for bots and should be absent for users.
- `identityKey(identity)` returns `${kind}:${id}` for internal Map, cache, DOM, and test keys only.
- UI display code must never show `identityKey`.
- Old `fellow:<owner>:<id>` strings are not a valid new identity id.

## Status Badge Contract

Status badges are part of identity, not message rendering.

```ts
type StatusBadge =
  | { kind: "emoji"; emoji: string; label?: string }
  | { kind: "lottie"; assetId: string; label?: string; loop?: "limited" | "always" }
  | { kind: "gift"; assetId: string; label?: string; collectibleId?: string };
```

Rules:

- Users and bots may both have `statusBadge`.
- The renderer should show the badge next to the display name in message author rows, chat headers, conversation cards, and member lists.
- The renderer should use one `NameWithBadge` module for desktop, with mobile and web consuming the same data shape.
- The first implementation does not need real blockchain ownership checks. `gift.collectibleId` is metadata for future provenance, not an authorization proof.
- Unsupported or missing badge assets degrade to no badge, not broken text.

## Cloud Schema

The cloud schema should be changed to canonical bot names.

### Users

Add:

```sql
status_badge_json TEXT NOT NULL DEFAULT ''
```

### Bots

Replace the `fellows` table with:

```sql
CREATE TABLE bots (
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
CREATE INDEX idx_bots_owner ON bots(owner_user_id);
```

`bots.id` should be generated globally as `bot_<hex>`. A human-readable public handle is out of scope for this migration and must not replace the primary id.

### Conversations

Replace conversation type `fellow` with `bot`.

Bot chat conversations should use generated conversation ids in the form `botc_<hex>`. The conversation id is the chat session id, not the bot id.

The bot identity belongs in conversation data:

```json
{
  "type": "bot",
  "decorations": {
    "botId": "bot_abcd",
    "runtimeKind": "cloud-hermes"
  }
}
```

`conversation_members` should include both the user and bot:

```text
member_kind = "user", member_ref = <user.id>
member_kind = "bot",  member_ref = <bot.id>, owner_id = <bot.ownerUserId?>
```

The primary key remains `(conversation_id, member_kind, member_ref)`.

### Messages

Replace message sender values:

```text
sender_kind = "bot"
sender_ref = <bot.id>
sender_owner_id = <bot.ownerUserId?>  // optional attribution/permission field
```

`sender_owner_id` is not part of identity uniqueness.

### Runtime Tables

Rename:

- `fellow_runtime_bindings` to `bot_runtime_bindings`
- `fellow_id` columns to `bot_id`

`cloud_agent_runs.fellow_id` becomes `bot_id`.

## API and IPC

Canonical routes:

- `GET /api/me/bots`
- `PUT /api/me/bots/:botId`
- `DELETE /api/me/bots/:botId`
- `PUT /api/me/bots/:botId/runtime`
- `PUT /api/me/bot-conversations/:sessionId`

Canonical IPC channels:

- `bot:details`
- `bot:save`
- `bot:engine-save`
- `bot:pin`
- `bot:mute`
- `bot:delete`
- `social:save-bot-identity`
- `social:ensure-bot-session-conversation`

Legacy `fellow` routes and IPC channels should be removed in the same implementation. Because the product is not launched, the app does not need a long-lived dual-route compatibility layer.

## Shared Modules

Add:

- `packages/shared/identity.js`
- `packages/shared/identity.d.ts`
- `src/shared/identity.js` re-export if desktop/web shared paths need it

Rename or replace:

- `packages/shared/fellow-identity.js` -> `packages/shared/bot-identity.js`
- `src/shared/fellow-identity.js` -> `src/shared/bot-identity.js`
- `src/main/fellow-*` -> `src/main/bot-*`
- `src/renderer/fellow/` -> `src/renderer/bot/`
- `src/renderer/styles/fellow-store.css` -> `src/renderer/styles/bot-store.css`

`ContactKind` should become:

```js
const IdentityKind = Object.freeze({
  User: "user",
  Bot: "bot"
});
```

`Self` should not be a separate identity kind. Self is a user identity where `id === currentUser.id`.

## Message Spec and Rendering

`message-spec` should add `authorIdentity`:

```ts
type MessageSpec = {
  authorIdentity: Identity | null;
  authorName: string;
  avatar: AvatarDescriptor;
  statusBadge?: StatusBadge | null;
};
```

Rules:

- `authorIdentity` is canonical for new rendering.
- `authorName`, `avatar`, and `statusBadge` are derived compatibility fields during the renderer migration.
- Message bubbles, social group messages, DM messages, conversation cards, and active chat headers should all render names through the same `NameWithBadge` module.
- No renderer module should independently reconstruct bot display names from `member_ref`, `bot_name`, `decorations`, or local bot lists.

## Desktop, Web, and Mobile Types

Replace:

- `SenderKind = "user" | "fellow" | "system"`

With:

- `SenderKind = "user" | "bot" | "system"`

Replace member fields:

- `fellow_id` -> `bot_id`
- `fellowKey` -> `botId`
- `fellow_name` -> `bot_name`
- `fellow_avatar_image` -> `bot_avatar_image`
- `fellow_avatar_crop` -> `bot_avatar_crop`

Prefer `identity` over parallel name/avatar fields when API responses already contain an identity object.

## Destructive Migration Policy

This is a pre-launch breaking migration.

Allowed:

- Dropping `fellows`, `fellow_runtime_bindings`, and old dev-only cloud data.
- Recreating local/cloud development databases.
- Renaming routes, files, modules, CSS classes, IPC channels, and enum values in one implementation.
- Invalidating cached local conversation ids that start with `fellow:`.

Not allowed:

- Keeping `fellow` as a long-term alias in production source.
- Adding new `fellow` fields to responses for compatibility.
- Continuing to generate `fellow:<owner>:<id>` identifiers.
- Making UI render badges from ad hoc fields outside `Identity`.

The implementation may include a one-time cleanup migration that drops old tables and creates new tables. It does not need to preserve rows from old pre-launch databases.

## Implementation Shape

Use one implementation plan with these phases inside the same migration branch:

1. Add shared `identity` and `bot-identity` contracts and tests.
2. Rename cloud schema, stores, routes, and message/member sender kinds to `bot`.
3. Rename main-process bot registry, runtime binding, chat adapter context fields, MCP context fields, and permission labels.
4. Rename renderer bot modules, CSS, conversation helpers, contact cards, message sources, and app wiring.
5. Update web and mobile API types and rendering data adapters.
6. Add `statusBadge` storage and normalization for users and bots.
7. Add `NameWithBadge` rendering and use it in all visible name surfaces.
8. Run static cleanup checks for legacy `fellow` references in production source.

## Acceptance Criteria

Data model:

- `bots.id` is globally unique and is the only bot identity key.
- `ownerUserId` is present only as bot ownership metadata.
- No new source writes `fellow:<owner>:<id>`.
- `conversation_members.member_kind` and `messages.sender_kind` use `bot`, not `fellow`.

Rendering:

- User and bot names render through the same identity path.
- A user badge and a bot badge render in the same position next to the display name.
- Missing badge assets do not break layout.
- Names, avatars, and badges do not depend on whether the author is human or bot.

Cleanup:

- Production source under `src/`, `packages/`, and `apps/mobile-rn/src/` has no canonical `fellow` identifiers after migration.
- Any remaining `fellow` text must be limited to historical docs, deleted-code migration notes, or explicit test fixtures proving old data is rejected or cleaned.
- The project does not expose `/api/me/fellows` or `fellow:*` IPC channels.

Tests:

- Shared identity tests cover user identity, bot identity, badge normalization, and `identityKey`.
- Cloud store tests cover bot CRUD, bot message sender rows, bot conversation members, and destructive cleanup.
- Renderer tests cover `NameWithBadge` for user and bot authors.
- Mobile/web type checks compile with `bot` sender kinds.

## Alternatives Considered

### Full destructive bot migration

Recommended.

It matches the current product stage. It removes ambiguous naming before formal launch and avoids paying for a dual-model compatibility layer.

### Dual-read transition from fellow to bot

Rejected.

This would reduce short-term churn but would keep the confusing model alive in schema, routes, renderer code, and mobile types. Since Mia is not launched and data preservation is not required, the compatibility cost is not justified.

### Badge-only implementation

Rejected.

Adding status badges on top of the existing scattered `fellow` identity handling would make the current data mess worse. The badge feature should be the forcing function that cleans identity rendering.
