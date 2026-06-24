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
- Also landed: behaviour-preserving `executable-resolver.js` seam + `control-server` `daemonTarget` diagnostics (reusable by slice 2).

## Slice 2 — Launcher integration + identity guard

Make the node Core the **launch target** (resolves NO-SHIP #2/#3).

- Resolver gains a `node-core` target: `command = <node binary>`, `args = [coreEntry, "--daemon"]`. Dev: a resolved `node`. Packaged: a standalone node bundled via `extraResources` (own executable identity — no Dock/LaunchServices GUI semantics).
- `launchd-service.js` + `daemon/process-launcher.js` already delegate to the resolver → they spawn the node Core unchanged.
- Re-enable `assertLaunchable()` in `startDaemonService()` once `node-core` is the resolved target (so packaged macOS fails closed instead of running the GUI identity).
- **Reuse/replacement (NO-SHIP #3):** `ping()` must return the answering daemon’s `daemonTarget`; `startDaemonService()` rejects reuse when `daemonTarget` is missing or `usesGuiAppIdentity === true`, so an old `Mia.app --daemon` is migrated, not kept.
- **Self-report (NO-SHIP #2):** the daemon reads its target metadata from an injected env var (`MIA_DAEMON_TARGET_KIND`) set by the launcher, instead of re-resolving `process.resourcesPath` inside the daemon process.
- Verify: packaged-`dir` build, inspect `ai.mia.daemon.plist` points at the node Core; Dock shows nothing daemon-only; `/health` reports `node-core`.

## Slice 3 — Migrate cloud sockets into Core

- Move `startCloudRuntimeSockets` (cloud-events-client + cloud-bridge-client, both pure-node) into `createMiaCore`. Flip ownership: the node Core connects cloud; the Electron GUI stops connecting in daemon mode.
- Apply the single-owner flip rule: cut over atomically; the GUI window remains the documented fallback only when the daemon is unreachable.

## Slice 4 — Migrate scheduler into Core

- Move `initSchedulerSubsystem` (tasks store/event bus, fire runner, cron) into Core. Resolve the `sendChat()` execution path with `background=true` + an injected emit (no `webContents`).

## Slice 5 — Migrate bot execution / agent adapters

- Move `runRemoteChatRequest`/`sendChat` background path + chat-adapter wiring into Core so bot invocations execute in the backend.

## Slice 6 — GUI becomes a pure client

- Electron retains window, updater, preload/IPC, renderer only. Delete the `IS_DAEMON_PROCESS` branch from `src/main.js`. LaunchAgent points at the node Core from install. `src/core` graduates toward `packages/mia-core`.

---

## Stable interface preserved across all slices

Local daemon control API; event fanout channel; runtime-home ownership; cloud socket ownership; scheduler ownership; launch/start/stop/status semantics; mobile stays a Cloud/Bridge client. The GUI never learns how the backend is packaged.
