# Desktop renderer React migration

## Goal

Mia's desktop renderer must have one owner for each DOM subtree, bounded work on
the input path, and measurable performance budgets. React is the renderer owner;
the existing JavaScript modules remain temporary business-controller adapters
until their state and actions are moved behind typed stores.

This is a strangler migration, not a permanent hybrid renderer. A surface may be
legacy-controlled or React-controlled during cutover, but both must never mutate
the same children in the normal application path.

## Current ownership

React currently owns:

- navigation controls, section tabs, the discover switch, and
  conversation-folder tabs;
- the stable chat header frame, conversation list, message list, and rich
  composer input;
- slash commands, mentions, attachments, reply state, attached-skill chips,
  the add menu, skill picking, and permission prompts;
- model, reasoning-effort, and permission popovers, including the Hermes
  session-only YOLO control;
- keyed reconciliation for conversations and messages;
- visibility-aware rendering and bounded message history.

These input and chat surfaces receive typed snapshots and callbacks. Their
controllers no longer generate HTML, scan the rendered subtree, or rebind row
events after each update.

The existing shell controller still applies route visibility and geometry
attributes synchronously before feature views measure themselves. This preserves
the established CSS layout contract during the multi-root migration. Those
attributes move to React only after the renderer has a single top-level React
root, so React commit timing cannot shift or resize legacy feature surfaces.

## Acceptance checkpoint

The normal chat path is now React-owned from navigation through message
rendering and composer interaction. In particular, typing, slash/mention
suggestions, attachment updates, reply changes, runtime-control menus, and
permission decisions do not pass through the compatibility surface.

The production entry refuses to start if any required React bridge is missing.
Direct DOM fallbacks that remain in feature modules are reachable only by
isolated non-production harnesses that do not load the desktop React entry.

## Explicit legacy islands

The following secondary or low-frequency surfaces still use `LegacySurface`.
They have one React-owned host and a fingerprinted compatibility producer, but
their children are not yet typed React views:

- contact list/detail and the assistant-store catalogue/detail sheet;
- skill/MCP filters and cards;
- task filters, list, preview body, and preview actions;
- settings provider rows, engine install actions, and the mobile QR panel;
- the chat-header conversation switcher and session-history rows;
- profile, bot, group, avatar, and manual-task dialog bodies.

No composer, message-list, conversation-list, or navigation-control surface is
in this list.

## Remaining cutover

1. Replace the contact and assistant-store compatibility producers with typed
   route stores and keyed React cards.
2. Replace skill/MCP and task compatibility producers; keep preview/dialog
   entries lazy.
3. Replace settings compatibility rows and the two chat-header flyout lists.
4. Move low-frequency dialog bodies (profile, bot, group, avatar, manual task)
   into lazy React entries and load non-chat code only on first route entry.
5. Delete `LegacySurface`, remove unit-harness DOM fallbacks, and split the
   remaining `app.js` orchestration into renderer services.

## Non-negotiable performance gates

- The minified startup React bundle must remain at or below 256 KiB. New
  low-frequency UI goes behind a split entry instead of growing startup code.
- Typing must not trigger a whole-app or whole-message-list render.
- Conversation and message rows require stable keys and signatures.
- Hidden/background views must not perform polling, animation, or render work.
- Message DOM must stay bounded regardless of conversation history length.
- With diagnostics enabled (`?perf=1` or
  `localStorage["mia.performanceDiagnostics"]="1"`), compare
  `input.latency`, `react.commit.*`, `main.longTask`, DOM-node count, and heap
  growth against AionUi using the same conversation and machine.

The migration is complete only when the compatibility producers and the legacy
renderer entry are gone; adopting a React dependency or wrapping old markup does
not satisfy completion.
