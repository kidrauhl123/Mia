# Main process split — progress log

> Sibling plan to `docs/superpowers/plans/2026-05-21-code-restructure.md`
> (renderer split). This one tracks the `src/main.js` work — Phase D of
> the original plan, but pulled forward and treated as its own
> implementation pass because the renderer split shipped first.

**Goal:** Break `src/main.js` (originally 7781 lines) into focused
CommonJS modules under `src/main/<feature>.js`. Target per CLAUDE.md
"代码组织": file < 500 lines. Achieving < 500 for `main.js` itself is the
long-term goal; this plan tracks incremental cuts toward that.

**Pattern:** `createXxx({...deps})` factory module (mirrors existing
`src/main/codex-chat-adapter.js` etc.). `main.js` requires the factory,
instantiates it once at boot, destructures every export to top-level
`const` bindings of the same name. Net effect: every existing call site
keeps working unchanged — only the source binding changes from local
function declaration to destructured import. Zero call-site rewrites
during extraction.

**Critical caveats discovered during the work:**

- `engineState` is reassigned (not mutated) on every Hermes restart.
  Factories that read it must take a `getEngineState: () => engineState`
  accessor, not the object reference. Otherwise the captured reference
  goes stale and `fetchHermesSkillsCatalog` / `writeEffortSettings`
  silently use wrong values.
- `cleanYamlScalar` lives outside `createSkillsLoader` so the
  default-export object can include it (the factory closure needs it
  too, but the same function definition serves both).
- The single-file check.js assertion on `defaultModelSettings` had to be
  moved to read from `src/main/settings-store.js`. Future extractions
  that move assertion targets out of `main.js` need the same update.

---

## Status: 5 modules extracted (-13.7%)

`src/main.js`: **7781 → 6717 lines** (still well above target).

| Commit | Module | Δ lines | What it owns |
|---|---|---:|---|
| `fa559e2` | [`src/main/skills-loader.js`](../../src/main/skills-loader.js) | -403 | Local skill discovery (parse SKILL.md, walk plugin roots, enumerate connectors/extensions, merge with Hermes catalog) + CRUD (read / delete / open directory / install) + slash-command expander used by chat adapters |
| `fceb5d8` | [`src/main/settings-store.js`](../../src/main/settings-store.js) | -271 | Defaults + normalization + read + write for: model / user profile / appearance / permission / effort / daemon / relay / cloud + cloud workspace JSON cache |
| `373270f` | [`src/main/runtime-paths.js`](../../src/main/runtime-paths.js) | -74 | `runtimePaths()` (full on-disk layout) + bundled Hermes Python lookup (`bundledHermesRuntimeDir`, `bundledPython`, `bundledSitePackages`, `buildPythonPath`, `venvPythonPath`, `engineMarkerPath`) |
| `3667cc3` | [`src/main/fellow-manifest.js`](../../src/main/fellow-manifest.js) | -184 | Fellow manifest **read-side**: defaults, normalize, load/save manifest, persona body/path/key helpers, avatar crop validator. CRUD write-side stays in main.js. |
| `5e49062` | [`src/main/chat-store.js`](../../src/main/chat-store.js) | -132 | Chat store **read-side**: defaults, normalize, load/save sessions, session title generation, message reply/translation/tool record normalization, merge key for cloud reconciliation. Mutation surface stays in main.js. |

Merge commit: `ce68be4`. Renderer split (already in `main` from earlier):
`docs/superpowers/plans/2026-05-21-code-restructure.md`.

---

## Remaining work (sized + risk-rated)

Roughly grouped by domain. Sizes are estimates from grep + read.

### Low risk (do these first when continuing)

- [ ] **pet generator + remote codex** (`startFellowPetGeneration`,
  `placeFellowPet`, `recallFellowPet`, `notifyFellowPetMessage`,
  `petStatusForFellow`, `findFellowPetPackage`, `resizePetWindow`,
  `styleSettingsForPet`, `petRemoteCodexSettings`, `petGeneratorRoot`,
  `miaSkillsRoot`, `officialLibraryManifestPath`,
  `resolveOfficialLibraryRoot`, `buildFellowPetPrompt`, `filePreview`,
  `petRunProgress`, `petJobSnapshot`, `getPetJobs`, `migrateLegacyPersonas`)
  → `src/main/pet-generator.js` (~370 lines). **Note:** interleaved with
  attachment helpers in the source — extract just the pet-named
  functions, keep attachments separate.

- [ ] **attachment helpers** (`materializePetReference`, `normalizeAttachment*`,
  `attachmentKind`, `attachmentSummaryLine`, `textPreviewForAttachment`,
  `attachmentContext`, `saveChatAttachment`, `mimeForFilePath`,
  `readLocalFileAttachment`, `safeReadLocalFileAttachment`,
  `fetchCloudFileAttachment`, `safeFetchFileAttachment`,
  `dataUrlToBuffer`, `mimeToExtension`, `sanitizeAttachmentName`)
  → `src/main/attachments.js` (~250 lines).

- [ ] **agent session tracker** (`agentSessionKey`, `getAgentSessionId`,
  `setAgentSessionId`, `getAgentSessionEntry`, `setAgentSessionEntry`,
  `writeSchedulerMcpContext`, `processEnvStrings`, plus the
  `agentSessions` JSON read/write) → `src/main/agent-sessions.js`
  (~120 lines).

### Medium risk

- [ ] **relay client** (`relayClientState`, `startRelayClient`,
  `stopRelayClient`, `relayPairingLink`, `handleRelayMessage`,
  `dispatchRelayPing`, WebSocket lifecycle) → `src/main/relay-client.js`
  (~350 lines). Touches `mainWindow.webContents` for status updates.

- [ ] **daemon HTTP server + IPC bridge** (`startDaemonService`,
  `stopDaemonService`, `daemonRoutes`, `forwardToDaemon`,
  `callDaemonTasks`, daemon auth, daemon log buffering)
  → `src/main/daemon-service.js` (~800 lines). High blast radius —
  every IPC call routed through here.

- [ ] **cloud bridge** (`startCloudOauth`, OAuth callback handlers,
  `pushCloudMessage`, `pullCloudWorkspace`, `mergeCloudWorkspaceIntoChatStore`,
  cloud reconciliation) → `src/main/cloud-bridge.js` (~700 lines).
  Cross-cuts with chat-store mutation surface (deferred from this round).

- [ ] **fellow CRUD write-side** (`saveFellow`, `saveFellowEngineConfig`,
  `setFellowPinned`, `deleteFellow`) → fold into `fellow-manifest.js`
  or new `src/main/fellow-crud.js` (~130 lines). Blocked on:
  needs to call `initializeRuntime()`, `getRuntimeStatus()`,
  `ensureClaudeBridgePlugin()` — all of which still live in main.js,
  so the dep injection list gets large.

- [ ] **chat store mutation write-side** (`saveChatSession`,
  `deleteChatSession`, `pushCloudMessage`, session pinning) → fold into
  `chat-store.js` or new `src/main/chat-mutations.js` (~250 lines).
  Same blocker as fellow CRUD: needs runtime-status and Claude bridge
  dependencies that are still in main.js.

### High risk (leave for last)

- [ ] **engine lifecycle** (`startEngine`, `stopEngine`, `installEngine`,
  `isEngineInstalled`, `selectOfficialEnginePython`, `pythonVersion`,
  `officialEngineUrl`, `officialEngineRequirement`, plus the spawn /
  process tree management) → `src/main/engine-lifecycle.js` (~900 lines).
  Multi-platform spawning. Touches `engineState` mutation directly.

- [ ] **runtime initialization + Claude bridge** (`initializeRuntime`,
  `initializeRuntimeCore`, `ensureClaudeBridgePlugin`, `refreshSystemHermes*`,
  `getRuntimeStatus`) — central wiring that everything else depends on.
  Extracting this changes the boot order of many factories.

### Untouched files

These are separate from main.js but might benefit from the same treatment
later (not part of the current plan):

- `src/mobile/app.js` (~2129 lines) — phone WebUI
- `src/web/app.js` (~1024 lines) — desktop web entry
- `src/relay/server.js` — relay reference impl

---

## Done so far across the whole codebase

| File | Start | Now | Δ |
|---|---:|---:|---:|
| `src/renderer/app.js` | 8055 | 3816 | **-52.6%** (22 modules, in main since merge `5e3f251`) |
| `src/main.js` | 7781 | 6717 | **-13.7%** (5 modules, in main since merge `ce68be4`) |

**Combined: -5303 lines from the two monoliths.** Both targets (<800
for renderer, <500 for main) still remain in front; expect another
2-3 rounds of similar size to close.

## Process notes for next session

1. **Always read CLAUDE.md → "代码组织"** before starting another cut.
   The 3 hard-rule questions (能放新文件 / 是不是 YAGNI / 顺手改能不能拆开)
   apply per extraction.
2. **Per-commit verify**: `node --check src/main/<new>.js && node --check src/main.js && node src/check.js && npm test`.
   All four must pass before commit.
3. **Per-commit smoke**: `MIA_USER_DATA_DIR=/tmp/mia-refactor-smoke-<name> ELECTRON_ENABLE_LOGGING=1 npm run open`.
   Grep stderr for `TypeError|ReferenceError|Uncaught|pingfang`. The
   harmless `tasks:list fetch failed` is expected in isolated smoke.
4. **Before push**: per memory `feedback_codex_review_before_push`, run
   codex adversarial-review. The renderer split round caught 3 no-ship
   issues this way (duplicate namespace + stale bare guards).
5. **Branch hygiene**: create a fresh `refactor/main-process-split-<N>`
   per extraction wave so each is mergeable independently. Don't pile 10+
   commits on one branch — review fatigue + revert pain.
