# Desktop renderer React migration

## Goal

Mia's desktop renderer has one owner for every rendered subtree, bounded work on
the input path, and measurable performance budgets. React owns the renderer.
Existing JavaScript modules remain business-controller adapters while state and
I/O are incrementally moved behind typed stores; they do not own alternate
rendered versions of migrated surfaces.

## Completed ownership cutover

The desktop renderer now has one top-level `createRoot`. `RendererApp` places
React views into the established layout hosts with portals, so the visual and
CSS geometry contract is unchanged while ownership remains singular.

React owns:

- navigation, section tabs, discover mode, and conversation-folder tabs;
- the chat header, conversation switcher, session history, conversation list,
  message list, permission prompt, and rich composer;
- slash commands, mentions, attachments, reply state, attached-skill chips,
  skill picking, model/reasoning/permission menus, and Hermes YOLO control;
- contacts and contact detail, the assistant store, Skills and MCP, tasks, and
  settings compatibility rows;
- profile, bot, avatar crop, pet generation, friend, group, task, MCP, skill,
  message, and cloud-login approval dialogs.

The route and dialog entries are typed and lazy. Controllers publish snapshots
and actions through feature stores instead of producing replacement HTML.
Conversation and message rows retain stable keys and signatures.

`LegacySurface`, its store, static dialog bodies, and the production DOM
fallbacks have been deleted. The production entry fails visibly when a required
React bridge is absent instead of silently switching to an alternate renderer.

## Controller-adapter boundary

`app.js` is still the orchestration adapter for shared route state, runtime
controls, and startup I/O. It synchronously applies the existing shell geometry
attributes before feature views measure themselves. This is intentional and
does not create a second React root or a second child owner.

The conversation/session menu, engine detection, cloud mobile-login flow,
profile/bot dialogs, group settings, and pet dialog have been removed from the
monolith into focused controllers. Continue extracting by responsibility when a
controller changes; do not recreate a compatibility-surface renderer.

## Performance gates

- The minified startup React entry must remain at or below 256 KiB.
- Low-frequency routes and dialogs must remain behind split entries.
- Typing must not trigger a whole-app or whole-message-list render.
- Conversation and message rows require stable keys and signatures.
- Hidden/background views must not poll, animate, or render.
- Message DOM must stay bounded regardless of history length.
- A missing typed React bridge is a startup error, never a DOM-render fallback.

With diagnostics enabled (`?perf=1` or
`localStorage["mia.performanceDiagnostics"]="1"`), use
`window.__miaPerformance.snapshot()` to capture `input.latency`,
`react.commit.*`, `main.longTask`, DOM-node count, and heap growth.

## 2026-07-28 same-machine inventory

Run `npm run renderer:compare:aion` to reproduce the architecture and shipped
load inventory against the sibling `AionUi` checkout.

| Metric | Mia | AionUi |
| --- | ---: | ---: |
| Top-level React roots | 1 | 1 |
| Lazy React imports | 6 | 24 |
| Mia minified React startup entry | 232,519 bytes | unavailable without an AionUi build |
| Mia split chunks | 13 / 92,266 bytes | unavailable without an AionUi build |
| Direct classic controller scripts | 86 / 1,273,355 bytes | bundled by electron-vite; local build absent |
| Renderer source inventory | 34 typed React files / 221,212 bytes | 612 files / 3,821,781 bytes |

These numbers are a repeatable load/architecture inventory, not a fabricated
latency comparison. The local AionUi checkout had neither dependencies nor
`out/main/index.js`; its own Playwright startup benchmark therefore could not
run. Runtime latency claims require a built AionUi on the same machine and the
same populated conversation. Mia's remaining startup-weight target is explicit:
reduce or defer the 1.27 MB classic controller graph while keeping controller
behavior out of the React input/commit path.
