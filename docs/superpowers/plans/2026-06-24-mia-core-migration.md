# Mia Core Migration — Core-first vertical slices

> Supersedes the Phase-1 Electron-helper-wrapper plan
> (`2026-06-24-mia-core-phase1.md`). After two independent reviews (codex +
> external) returned NO-SHIP on the nested-`.app` helper — it omitted
> `Contents/Frameworks` + `app.asar` and would crash, and could not be verified
> without a signed packaged build — the direction changed to building the real
> Mia Core backend as a standalone process, delivered in vertical slices.

**Goal:** `Electron GUI → Mia Core backend process → Cloud / agents / scheduler / runtime files`. The GUI becomes a client; the backend is the product core (the AION-style split). Not `GUI App --daemon`, and not a `.app` wrapper around the GUI daemon.

**Why this is feasible now:** the daemon path is already ~85% pure-node (dependency-injected factories). Verified coupling map:

| Module | Electron coupling |
|---|---|
| `src/main/daemon/control-server.js` | **none** — `http`/`os` only |
| `src/main/settings-store.js` | none (factory; daemon methods use `readJson`+`runtimePaths` only — `settings-store.js:370-402`) |
| daemon token, `cloud-events-client.js`, `cloud-bridge-client.js`, `tasks-routes.js`, scheduler | pure-node (injected `WebSocket`/callbacks) |
| `src/main/runtime-paths.js` | only `app.getPath("userData"\|"home")` (`:23-24`); bypassed by `MIA_HOME`, else trivial node shim |
| `app.getVersion()` | replace with `package.json` version |
| `sendChat()` | optional `webContents`; daemon already passes `null`/`background=true` |

**Single-owner safety rule (non-negotiable):** there must never be two live owners of the cloud sockets / `mia-cloud.json` / scheduler at once (`src/main/AGENTS.md` “单 owner”). The node Core only becomes the **live** launchd target once it is at parity for every responsibility it owns. Until a slice reaches parity, the node Core runs for verification on a throwaway `MIA_HOME`/port — never as the live owner alongside the Electron daemon.

---

## Slice 1 — Mia Core process shell ✅ DONE

- `src/core/mia-core.js`: pure-node `createMiaCore({env, version})` reusing the real `runtime-paths` + `settings-store` + `control-server` factories. Owns runtime home, daemon token, daemon settings; serves the control HTTP/SSE API (`/health`, `/status`, control routes). Cloud/scheduler/bot wired as inert stubs.
- **Verified:** `node src/core/mia-core.js` runs with process identity `node` (no Dock, no GUI bundle); `curl /health` → `{mode:"daemon", daemonTarget:{kind:"node-core", usesGuiAppIdentity:false}}`; token + settings persisted under `MIA_HOME`. Tests: `tests/mia-core.test.js`.
- Also landed: behaviour-preserving `executable-resolver.js` seam + `control-server` `daemonTarget` diagnostics (reusable by the launcher slice).
- Pre-work LOW gaps from slice-1 review — **DONE**: settings-store `env` injection (`settings-store.js` now reads injected `env.MIA_DAEMON_HOST`), and real port probing in `createMiaCore` (reuses `engine-health-service` `choosePort`). Tests in `tests/mia-core.test.js`.

> **Ordering correction:** the launcher flip + deletion of the Electron daemon
> is the **LAST** slice, not an early one. Pointing launchd at the node Core
> before it owns cloud/scheduler/bot would drop those capabilities — a
> regression. Capabilities migrate into Core first (slices 2–4), Core reaches
> parity, then the launcher flips and the old daemon code is deleted (slice 5).
> Until parity+flip, the node Core runs only for verification (throwaway
> `MIA_HOME`/port), never as a live owner alongside the Electron daemon.

## Slice 2 — Migrate cloud sockets into Core

- Wire `cloud-events-client` + `cloud-bridge-client` (both pure-node, already shared modules) into `createMiaCore`, using the SAME modules `src/main.js` wires (no fork). The bot-invocation dispatcher they call is stubbed until slice 4.
- Single-owner rule: do NOT connect cloud from the verification Core unless cloud creds exist on its throwaway home — keep it inert until the launcher flip.

## Slice 3 — Migrate scheduler into Core

- Wire `initSchedulerSubsystem` (tasks store/event bus, fire runner, cron — pure-node) into Core. Resolve `sendChat()` with `background=true` + an injected emit (no `webContents`).

## Slice 4 — Migrate bot execution / agent adapters (keystone)

Extract the `runRemoteChatRequest`/`sendChat` background path so bot invocations execute in the backend. Extraction map (from a full coupling audit):

- **Already pure-node, reuse as-is** (no electron): all four chat adapters (`hermes`/`codex`/`claude-code`/`openclaw`-chat-adapter.js — they take an `emit` callback, not `webContents`), `chat-engine-adapters.js`, `social/local-bot-responder.js`, `social/bot-runtime-dispatcher.js`, `social/social-api.js` (pure HTTP), `skills-loader` bot-capabilities, `chat-response.js`, `bot-registry.js`, `task-reply-delivery.js`.
- **Hard electron blocker — DONE:** `chat-events.js` `createChatEventEmitter` hard-wired to `webContents.send`. Refactored to accept an injected `emitImpl(channel, envelope)` sink (commit `refactor(chat): chat-event emitter accepts non-electron sink`).
- **Remaining (DI re-wiring, no hard blockers):**
  - `botPetService.notifyMessage` (`src/main.js:2307`) — already guarded by `!utility` + non-`title:` session; background/daemon turns skip it. Inject a no-op `notifyMessage` for Core.
  - `emitCloudEvent`/`broadcastRendererEvent` (`src/main.js:2820-2828`) — already has the `IS_DAEMON_PROCESS → publishLocalEvent` branch; Core injects a control-server event publisher.
  - **DONE — `sendChat`/`stopChat` extracted** into `src/main/bot-execution-core.js` (`createBotExecutionCore` factory, pure-node, no fork). main.js delegates to it; bodies byte-identical; single-flight abort state is factory-internal; late-bound deps injected as accessors. Verified node-only via `tests/bot-execution-core.test.js`.
  - **DONE — Core builds the real adapter graph.** `cloudBotSnapshotForTurn`/`botWithRuntimeConfig` extracted to shared `bot-turn-helpers.js` (byte-identical). `createCoreBotExecution` (src/core/mia-core.js) constructs the genuine `createChatEngineAdapters → sendWithChatEngineAdapter → adapter.send` graph with real `hermesRunService` + `hermesAdapter`. Hermes-only; non-Hermes engines throw `"engine not available in Mia Core yet"`. Proven node-only via `tests/mia-core-bot-execution.test.js`. Exposed lazily, NOT auto-started (no dual-owner).
  - **Remaining in slice 4:** replace the marked `// TODO(mia-core slice)` stubs (memory block, scheduler/app MCP context, managed model runtime, full skills directive, attachments, real localBotResponder) with the real collaborators as Core gains ownership of those subsystems; read the Hermes engine baseUrl/apiKey from the runtime config the engine writes.
  - **Non-Hermes engines (Codex/ClaudeCode/OpenClaw)** are deeply Electron-coupled (claudeAgentSdk, workspace dirs, MCP bridges, agent permissions). Un-coupling them for the backend is its own large effort — tracked as a separate workstream, not blocking Hermes-path parity.
## STATUS (live)

Core now has **STRUCTURAL parity** with the Electron daemon — every subsystem is wired and verified node-only:
- ✅ Slice 1 — control server / runtime-home / settings / token
- ✅ Slice 4 keystone — `sendChat`/`stopChat` extracted; Core builds the real Hermes adapter graph
- ✅ Slice 2a — cloud bot-invocation routing (dispatcher → responder → sendChat → socialApi)
- ✅ Slice 2b — cloud EVENTS websocket connect (gated on cloud enabled+token)
- ✅ Slice 2c — cloud BRIDGE websocket connect (remote runs → botExecution)
- ✅ Slice 3 — scheduler subsystem (fired tasks → botExecution background)

**Not yet FUNCTIONAL parity** — `createCoreBotExecution` still has slice-4 TODO stubs: memory block, scheduler/app **MCP context**, managed-model runtime, full **skills directive**, **attachments**. A Hermes turn run via Core today lacks memory/skills/MCP. These must be replaced with real Core-owned collaborators BEFORE the launcher flip, or live daemon turns would regress vs the Electron daemon.

### Gate before Slice 5 (flip + delete)
1. **Functional parity** — replace the slice-4 stubs above with real implementations (Core owns memory store, MCP bridges, skills loader, attachment store, or reads them from the shared runtime home).
2. **Packaged node binary** — slice 5 needs a bundled `node` (the node-core launchd target). This CANNOT be verified in this dev worktree; it requires a real packaged build — a manual gate (same lesson as the abandoned helper-wrapper: do NOT delete the Electron daemon before the replacement is proven in a package).

Only after 1+2 is it safe to flip launchd → node Core and DELETE the Electron `IS_DAEMON_PROCESS` branch.

## Slice 5 — Flip launcher + DELETE the Electron daemon (the cleanup the goal asks for)

- Resolver gains a `node-core` target: `command = <node binary>`, `args = [coreEntry, "--daemon"]`. Dev: a resolved `node`. Packaged: a standalone node bundled via `extraResources` (own executable identity — no Dock/LaunchServices GUI semantics).
- `launchd-service.js` + `daemon/process-launcher.js` already delegate to the resolver → spawn the node Core unchanged.
- Re-enable `assertLaunchable()` in `startDaemonService()` (packaged macOS fails closed instead of running GUI identity).
- **Reuse/replacement (NO-SHIP #3):** `ping()` returns the answering daemon’s `daemonTarget`; `startDaemonService()` rejects reuse when `daemonTarget` missing or `usesGuiAppIdentity === true`, so an old `Mia.app --daemon` is migrated, not kept.
- **Self-report (NO-SHIP #2):** the daemon reads target metadata from an injected env var (`MIA_DAEMON_TARGET_KIND`) set by the launcher, not by re-resolving `process.resourcesPath`.
- **DELETE:** the `IS_DAEMON_PROCESS` daemon-boot branch in `src/main.js`, the `legacy-gui` resolver path, and any GUI-app `--daemon` wiring. This is the "彻底摒弃旧的不稳定代码" step — done only once Core is at parity.
- Verify: packaged-`dir` build, `ai.mia.daemon.plist` points at the node Core; Dock shows nothing daemon-only; `/health` reports `node-core`.

## Slice 6 — GUI becomes a pure client

- Electron retains window, updater, preload/IPC, renderer only. `src/core` graduates toward `packages/mia-core`. LaunchAgent points at the node Core from install.

---

## Stable interface preserved across all slices

Local daemon control API; event fanout channel; runtime-home ownership; cloud socket ownership; scheduler ownership; launch/start/stop/status semantics; mobile stays a Cloud/Bridge client. The GUI never learns how the backend is packaged.
