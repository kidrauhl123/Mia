# Codebase Cleanup And Shared Convergence Design

Date: 2026-06-01

## Goal

Make Mia easier to change by deleting confirmed dead code and converging duplicated multi-client logic behind shared Modules. The target end state is not a cosmetic cleanup: desktop, web, cloud, and mobile must stop carrying separate implementations for the same domain rules.

## Problems To Solve

1. **Shared logic drift**
   `apps/mobile-rn` had TypeScript ports of logic that already existed under `src/shared` or old mobile WebView code (`avatar`, `contact`, `groupTiles`, `sessionHistory`, `sendPipeline`, cloud-client adjacent logic, approval queue, and optimistic send). Every port was another place that could drift.

2. **Fellow identity split**
   Cloud seeds a default `mia` fellow while local manifest onboarding still treats the default fellow as intentionally empty. Capabilities, persona, color, avatar, and default identity semantics are not represented by one canonical schema.

3. **Browser globals block clean sharing**
   Current desktop and web shared modules are UMD scripts that attach `window.miaXxx`. This keeps them easy to load without a bundler, but it makes typed package consumption awkward.

4. **Dead code and tracked local artifacts**
   Root-level generated chunks, tracked `.superpowers` state, obsolete avatar compatibility exports, and inert fallback branches add noise and make future searches less trustworthy.

5. **Old mobile path still existed**
   `src/mobile`, the Capacitor scripts, root `capacitor.config.json`, and generated `android/` shell were a documented fallback/reference while `apps/mobile-rn` caught up. After the RN app became the only mobile path, keeping those files would make future searches and builds ambiguous.

6. **Old local mobile pairing/relay path still existed**
   The daemon still served a browser `/mobile/` control surface and the desktop settings UI still exposed LAN/relay pairing controls, even after RN became the supported mobile client. That kept a second pairing/control model alive and generated broken links after the old mobile WebView app was retired.

## Migration Strategy

### Phase 1: Safe deletion and noise removal

Delete only code with hard evidence of no runtime entry:

- root generated chunks with no references
- tracked `.superpowers` local state
- uncalled avatar compatibility APIs
- fallback branches that can never produce a value

Verification:

- targeted Node tests for the touched domains
- `npm run check`
- reference search for removed symbols

### Phase 2: Establish `packages/shared`

Create `packages/shared` as the typed Interface for environment-neutral shared logic. The first tracer bullet is avatar/contact/group tile identity resolution, because these already caused multi-client drift and have good tests.

Rules:

- package Interfaces must be typed
- package implementation must not depend on DOM, Electron, React Native, or storage
- RN Modules should become thin re-exports instead of TS ports
- existing `src/shared` browser globals stay available until desktop/web are migrated

### Phase 3: Flip canonical ownership into the package

Move implementation ownership from `src/shared` into `packages/shared` one Module at a time. During the transition, `src/shared/*.js` remains as Node compatibility wrappers for existing `require()` call sites, while desktop loads package UMD files directly and web/mobile keep stable `/shared/*.js` URLs that dev/release builders map to package implementations.

Preferred order:

1. avatar/member-color/avatar-media
2. contact/group-tiles
3. session-history/send-pipeline/unread
4. cloud-client once mobile/web/cloud fetch and WebSocket adapters are separated behind the package Interface

Verification:

- package tests and legacy wrapper tests must assert identical behavior
- RN tests must import through the package-facing wrappers
- browser global tests must keep passing

Current progress:

- `packages/shared/avatar` now owns avatar resolution, member fallback colors, and avatar media/trim helpers in one browser-global implementation.
- `src/shared/avatar-resolve.js`, `src/shared/member-color.js`, and `src/shared/avatar-media.js` are Node compatibility entries only.
- Desktop renderer loads package avatar directly; web keeps stable `/shared/avatar-resolve.js`, `/shared/member-color.js`, and `/shared/avatar-media.js` URLs while dev/release scripts serve the package implementation behind those URLs.
- `packages/shared/session-history` now owns the actual session-history implementation and its browser global.
- `src/shared/session-history.js` is a Node compatibility entry only.
- Desktop renderer loads the package UMD file directly; web keeps the stable `/shared/session-history.js` URL while dev/release serve the package implementation behind it.
- `packages/shared/contact` and `packages/shared/group-tiles` now own their browser-global implementations.
- `src/shared/contact.js` and `src/shared/group-tiles.js` are Node compatibility entries only.
- Desktop renderer loads package UMD files for contact, group tiles, and session history; web keeps stable `/shared/*.js` URLs while dev/release scripts serve the package implementations behind those URLs.
- `packages/shared/send-pipeline`, `packages/shared/cloud-client`, and `packages/shared/unread` now own their browser-global implementations.
- `src/shared/send-pipeline.js`, `src/shared/cloud-client.js`, and `src/shared/unread.js` are Node compatibility entries only.
- Web dev and Cloud release serve/copy package-owned send pipeline, cloud client, and unread modules behind the stable `/shared/*.js` URLs.

### Phase 4: Fellow identity canonical schema

Define one Fellow identity schema covering:

- id/default `mia` semantics
- owner/global identity requirements for shareable fellows
- capabilities shape
- persona source of truth
- avatar fields
- color policy, either removed or intentionally supported

Only after this schema is explicit should public/shareable fellow IDs be changed.

Current progress:

- `packages/shared/fellow-identity` owns the first canonical identity slice: default fellow id, normalized capabilities, and normalized identity fields shared by cloud rows, local manifest records, and renderer directory records.
- Legacy string-array capabilities are normalized into object shape and retained as `legacyCapabilities` instead of being silently dropped by desktop.
- Cloud default fellows, cloud fellow storage, local fellow manifests, desktop sync, renderer directory color handling, and renderer capability editing now use the same normalizers.
- Fellow `color` is intentionally supported as an identity field: desktop saves it, sync pushes it, cloud roundtrips it, and renderer contact lists use it with a stable hash fallback for invalid or missing values.
- Desktop renderer, web, and RN code must resolve fellow conversation keys through the shared session helper instead of `split(":")[2]`, so future owner-scoped/global Fellow IDs are not truncated.
- Runtime code must compose fellow conversation ids through `sessionHistory.fellowConversationId(ownerUserId, fellowKeyOrSessionId)` instead of hand-writing ``fellow:${owner}:${id}``. The current string format is unchanged, but the future global-id migration now has one seam.
- `sessionHistory` implementation ownership has been moved into `packages/shared`; `src/shared` no longer owns that Module's behavior.
- Fellow identities now expose `globalId = fellow:<ownerUserId>:<localFellowId>` while preserving the local editable alias (`id/key`, e.g. `mia`). The storage primary key remains `(owner_user_id, id)`, but API lists, compact fellow payloads, events, and conversation member identities now carry the shareable global id.
- Local Fellow persona text now lives in the normalized manifest record as `personaText`. `fellows/<id>.md` is still written for Hermes/Codex runtime injection and legacy fallback, but desktop sync pushes `personaText` from the manifest first.

### Phase 5: Retire old mobile path

Retire `src/mobile`, Capacitor scripts, root `capacitor.config.json`, Capacitor npm dependencies, and generated `android` once RN is the only supported mobile path. Keep the historical specs/plans as records, but do not keep runnable code or npm scripts for the old WebView app.

### Phase 6: Retire old local pairing/relay path

Retire the daemon `/mobile/` static surface, relay server/client modules, relay settings, QR helper, IPC/preload channels, and desktop settings controls. RN authenticates against the cloud API directly, so keeping the old local browser-control relay would preserve a dead product path and confuse future ownership.

## Current Slice

This slice starts Phase 1 and Phase 2:

- delete confirmed dead tracked artifacts
- remove unused avatar compatibility exports
- add `packages/shared`
- replace RN `avatar`, `contact`, `groupTiles`, `sessionHistory`, `sendPipeline`, and cloud client/event ports with thin re-exports
- keep package and legacy shared entry behavior locked together with contract tests
- add `packages/shared/fellow-identity` and use it for Fellow capabilities across cloud, local manifest, desktop sync, and renderer commands
- extend `packages/shared/fellow-identity` to normalize Fellow identity fields (`id/key`, `name/displayName`, `ownerUserId`, `color`, `avatar`, `bio`, `capabilities`, `personaText`, timestamps)
- preserve Fellow `color` through local save, desktop sync, cloud API storage, and renderer directory display
- replace direct `fellow:<owner>:<id>` string indexing with `sessionHistory.fellowKey()` and add a structure guard against reintroducing `split(":")[2]`
- add `sessionHistory.fellowConversationId()` and replace runtime hand-composition in cloud default fellow creation, cloud fellow conversation APIs, desktop background task replies, and optimistic desktop session creation
- flip `session-history` implementation ownership into `packages/shared`, keep `src/shared/session-history.js` as a compatibility entry, and serve/copy the package implementation for web and cloud release
- flip `contact` and `group-tiles` implementation ownership into `packages/shared`, keep their `src/shared` files as compatibility entries, and serve/copy the package implementations for desktop, web, and Cloud release
- flip `send-pipeline`, `cloud-client`, and `unread` implementation ownership into `packages/shared`, keep their `src/shared` files as compatibility entries, and serve/copy the package implementations for desktop, web, and Cloud release
- flip approval queue and optimistic send into `packages/shared`, with RN adapters reduced to typed re-exports
- retire the old Capacitor/WebView app by deleting `src/mobile`, `scripts/build-mobile-www.js`, `scripts/serve-mobile.js`, `capacitor.config.json`, generated `android/`, Capacitor package dependencies, and old mobile-only tests
- retire the old local mobile pairing/relay stack by deleting `src/relay/server.js`, `src/main/relay/relay-client.js`, daemon `/mobile` serving and `/api/relay/*` endpoints, relay IPC/preload APIs, renderer settings controls, QR generation, the `qrcode` dependency, relay runtime settings, and relay-only tests
- expose shareable Fellow `globalId` from the shared identity normalizer, cloud fellows store, HTTP API, WebSocket events, and conversation member identity payloads
- make local Fellow `personaText` manifest-owned, with `.md` files treated as runtime materialization and legacy fallback
- guard the RN adapters with structure tests so these shared logic ports cannot silently grow local implementations again
- include `packages/shared` in the project structure check and packaged desktop file list
- declare `apps/mobile-rn` and `packages/shared` as root workspaces, make RN depend on `@mia/shared`, and import the package by name instead of physical relative paths
- remove the nested RN package lock so the workspace has one dependency lock source
- align the promo web landing tests and Cloud release required-file list with the current `promo2` asset set
- filter `.DS_Store` from Cloud release directory copies and release manifests
- update the scheduler MCP Codex-home test to protect the current session-isolation policy instead of expecting user session symlinks

The old mobile WebView path and old local mobile pairing/relay path are retired; `apps/mobile-rn` is the only mobile app entry. Fellow storage ids remain local aliases, but every cloud identity now exposes a shareable `globalId`.

## Verification Notes

- `npm run check` passes and now treats `packages/shared` as required project structure.
- RN `npm test -- --runInBand` and `npm run typecheck` pass.
- Targeted shared/fellow/social/root structure tests pass for the refactor slice, including the retired Capacitor/WebView and local pairing/relay guards.
- Full root `npm test` passes: 1037 tests, 0 failures.
