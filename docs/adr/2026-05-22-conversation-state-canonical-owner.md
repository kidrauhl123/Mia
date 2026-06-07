# ADR: Conversation state canonical owner

**Date:** 2026-05-22
**Status:** Accepted

## Context

mia has multiple stores for conversation state: desktop chatStore (local
sessions), desktop groupStore (local groups), cloud workspace (cross-device
mirror), social moduleState (renderer cache). Each was added at a different
time for a different purpose. Without a written authority, contributors keep
adding fifth/sixth stores when new features arrive.

## Decision

When the user is logged into Mia Cloud, **cloud is the write authority**
for every conversation state mutation. The desktop chatStore is treated as
an offline cache + write-through mirror; the renderer's social moduleState
is a read-only view onto cloud, derived from REST + WS.

When the user is logged out, the desktop chatStore is the local-only
authority for bot sessions and local groups. Cloud writes do not exist.
At login, the existing `syncMiaCloudWorkspace()` pipeline merges in
both directions.

## Consequences

- New conversation-level state (unread cursor, pin flag, custom name, etc.)
  must be added to the cloud schema and exposed through `/api/workspace/sync`
  or a similar endpoint. It is NOT acceptable to add a fifth store.
- Renderer code reads from the cache for snappy UI but writes always go to
  cloud first (with the response merged back).
- Multi-device unread / read-cursor sync belongs in the cloud authority path,
  using durable per-member read state rather than a renderer-only unread map.

## Alternatives considered

- "Local-first with periodic sync" — rejected because mia's multi-device
  use case (which prompted Cloud) means we'd be designing for conflict
  resolution rather than freshness.
- "Each store keeps its own authority for its data type" — rejected; this
  is the current state and it's what causes "real human friend = different
  rendering" bugs.
