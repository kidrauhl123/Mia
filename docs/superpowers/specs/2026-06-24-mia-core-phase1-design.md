# Mia Core Phase 1: 独立 daemon 可执行身份设计

Status: approved; implemented per docs/superpowers/plans/2026-06-24-mia-core-phase1.md.

## Goal

Mia needs to stop running the background owner as the same macOS GUI app
identity. Phase 1 keeps the existing daemon Interface and most daemon
Implementation intact, but replaces the launch and packaging seam so the
background process has an independent executable identity.

This is a stability migration, not the final backend split. The design must
make Phase 2 possible: replacing the current Electron-main daemon
Implementation with a real Mia Core process without changing GUI callers,
LaunchAgent ownership, or runtime-home contracts again.

## Current Problem

The 2026-06-12 single-owner daemon ADR is directionally correct: the desktop
needs one local owner for cloud sockets, bot invocation, shared settings,
runtime files, scheduler, and local event fanout.

The current Implementation is not stable enough:

- macOS LaunchAgent starts `/Applications/Mia.app/Contents/MacOS/Mia --daemon`.
- The daemon and the GUI share the same app bundle and app identity.
- The daemon tries to behave like a background process by setting
  `MIA_DAEMON=1`, using an isolated `userData` path, avoiding windows, and
  hiding the Dock icon.
- macOS still sees the daemon as another execution of the GUI app, so Dock,
  LaunchServices, updater, and app replacement semantics leak across the
  seam.
- Auto-update can fail because the target app bundle is still running through
  the daemon.

The one-line diagnosis is: the daemon Module has the right product ownership
Interface, but the process identity Interface is too shallow. Callers and
platform adapters need to know implementation details that should be hidden
behind a deeper Mia Core launch seam.

## Non-Goals

- Do not rewrite the daemon runtime into Rust, Go, Swift, or a pure Node
  backend in Phase 1.
- Do not change the local control server contract unless a narrow version or
  status field is needed for migration safety.
- Do not change Cloud canonical ownership.
- Do not make mobile start local runtimes or register LaunchAgents.
- Do not remove the daemon single-owner model.
- Do not ship a broad renderer or product UI redesign as part of this phase.

## Architecture Direction

Phase 1 introduces a new conceptual Module: **Mia Core executable**.

Its Interface is deliberately small:

- resolve the daemon executable path for the current install and platform;
- provide the daemon launch arguments;
- provide the daemon launch environment;
- report whether the resolved target is the new independent executable or the
  legacy GUI app fallback;
- keep the existing local daemon runtime contract: `MIA_DAEMON=1`, `MIA_HOME`,
  isolated daemon `userData`, daemon token, local HTTP/SSE API, and runtime
  status.

Its initial Implementation can still call into the existing Electron-main
daemon path. The important Phase 1 change is that launchd and detached spawn
no longer construct daemon commands directly from `process.execPath` plus
`--daemon`. They use a shared resolver Module.

That gives the system a real seam:

- **Adapter 1:** macOS LaunchAgent Adapter writes a plist pointing at the Mia
  Core executable.
- **Adapter 2:** non-macOS/dev detached spawn Adapter starts the same resolved
  target where available, with explicit fallback behavior.
- **Future Adapter:** Phase 2 can replace the target with `packages/mia-core`
  or another backend executable without changing callers.

One Adapter would only be a hypothetical seam. Two launch adapters using the
same resolver makes it a real seam.

## Phase 1 Design

### 1. Mia Core Executable Resolver

Add a focused main-process Module, likely under `src/main/daemon/`, responsible
for daemon executable resolution.

Expected responsibilities:

- In packaged macOS builds, prefer an independent bundled executable under the
  app bundle resources or helper location, not
  `Contents/MacOS/Mia`.
- In development, keep using Electron with the app path when no helper exists.
- On non-macOS, keep behavior compatible but still route through the resolver.
- Expose structured metadata for diagnostics and tests:
  `kind`, `command`, `args`, `workingDirectory`, and `usesGuiAppIdentity`.

The resolver should make legacy fallback visible. A status payload or daemon
log line should say when Mia is still using the legacy GUI app target.

### 2. Independent Phase-1 Executable

Add a packaged daemon target with an identity that is not the main GUI app.

The Phase 1 target is a nested helper app or helper executable shipped inside
the packaged Mia app bundle, with its own identity and no Dock presence. The
preferred macOS shape is a nested helper app such as `Mia Core.app`, signed as
part of the main app bundle, with a distinct bundle identifier such as
`ai.mia.core`.

The helper may still load the existing daemon entry path at first. It may also
still use Electron internally if that is the shortest route to reuse the
current daemon Implementation. What it must not do is expose the daemon to
macOS as `Mia.app/Contents/MacOS/Mia`.

Loose shell wrappers are not acceptable for packaged macOS if they ultimately
exec the GUI app executable. That would keep the same shallow process identity
seam and only move the problem into a script.

The key acceptance condition is observable behavior, not the wrapper technique:
the daemon must no longer keep `Mia.app` active as the GUI app.

### 3. LaunchAgent Adapter

Update `src/main/launchd-service.js` so daemon plist generation delegates to
the resolver.

The daemon LaunchAgent should keep:

- label `ai.mia.daemon`;
- `RunAtLoad`;
- `KeepAlive`;
- stdout/stderr paths in Mia logs;
- `MIA_DAEMON=1`;
- `MIA_HOME`;
- isolated `MIA_USER_DATA_DIR`;
- `HERMES_HOME`;
- `HERMES_LANGUAGE`;
- stable `PATH`;
- `PYTHONUNBUFFERED=1`.

It should change:

- `ProgramArguments` no longer hard-codes `execPath(), appPath(), "--daemon"`;
- `WorkingDirectory` comes from the resolver and must be a real directory;
- plist tests assert that packaged macOS does not point at
  `Contents/MacOS/Mia` for daemon mode.

### 4. Detached Spawn Adapter

Update `src/main/daemon/process-launcher.js` to use the same resolver.

This keeps non-macOS and development behavior from becoming a second daemon
launch model. The resolver can still choose the legacy Electron command in dev,
but the decision lives in one Module.

### 5. Updater Interaction

Keep the first-layer update guard already landed: the GUI stops the daemon
before `quitAndInstall`.

Phase 1 should make that guard less fragile by removing the shared GUI app
identity, but it should not delete the guard. Stopping the daemon before app
replacement is still the right operational sequence because the daemon owns
runtime files and cloud sockets.

The updater acceptance case is:

1. An old daemon is running.
2. A new update is downloaded.
3. GUI prepares to install.
4. GUI stops the daemon.
5. `quitAndInstall` proceeds without `App Still Running Error`.
6. On next launch, `startDaemonService()` rewrites the plist and starts the
   daemon for the new app version.

### 6. Version Replacement

Keep `daemonNeedsReplacement()` semantics.

The GUI must still replace an old-version daemon after app update. The
resolver should not hide version mismatch. The status path should continue to
report daemon `mode` and `version`, and `startDaemonService()` should continue
to require a daemon answering with the current app version.

### 7. Diagnostics

Add enough diagnostics to tell which daemon target is active.

`daemon status` or local logs should include:

- resolver kind, for example `packaged-helper`, `bundled-cli`,
  `electron-dev`, or `legacy-gui`;
- resolved command basename or sanitized path;
- whether the daemon target uses GUI app identity;
- LaunchAgent plist path;
- runtime home.

The goal is not verbose logging. It is to make the next support diagnosis
answerable without guessing.

## Path To Phase 2

Phase 2 is the real Mia Core split.

Phase 1 prepares for it by concentrating launch complexity behind one Module
and keeping GUI callers on the existing daemon Interface. In Phase 2, the
Implementation behind the Mia Core executable can become:

- `packages/mia-core` as a Node process with Electron removed from daemon
  runtime;
- a native Swift/Go/Rust daemon if packaging and operational needs justify it;
- a Cloud/Bridge-compatible backend process shared by desktop and server
  surfaces.

The stable Interface that should survive Phase 2:

- local daemon control API;
- event fanout channel;
- runtime home ownership;
- cloud socket ownership;
- scheduler ownership;
- launch/start/stop/status semantics;
- mobile remains Cloud/Bridge client only.

Phase 2 should not require renderer code to learn how the daemon is packaged.

## Error Handling

The GUI should treat daemon launch failures as product-level unavailable
states on macOS, consistent with the single-owner direction.

Expected behaviors:

- If the resolver cannot find a packaged helper, packaged macOS must fail
  clearly and must not start a legacy GUI-identity daemon. Development builds
  may use a visible legacy fallback because they are not the update path being
  fixed.
- If launchd bootstrap fails, the existing error path remains: startup reports
  daemon unavailable instead of silently starting a second owner in the GUI.
- If the daemon starts but reports an old version, the GUI replaces it and
  waits for the current version.
- If the daemon stops for update install, the GUI proceeds only after stop
  succeeds; otherwise it reports the update error and does not call
  `quitAndInstall`.

## Testing

Phase 1 should be test-driven around the new seam.

Required automated coverage:

- resolver unit tests for packaged macOS, dev Electron, missing helper, and
  non-macOS fallback;
- launchd plist tests proving daemon `ProgramArguments` come from the resolver;
- launchd plist tests proving packaged daemon mode does not point at the GUI
  executable;
- detached spawn tests proving `daemon/process-launcher.js` uses the same
  resolver result;
- updater tests stay green for `prepareForUpdateInstall`;
- `npm run check`.

Manual or packaging verification:

- build a macOS dir/zip package in a controlled environment;
- inspect the generated app bundle for the daemon executable;
- inspect the generated LaunchAgent plist after app launch;
- verify Dock does not show Mia as running when only daemon is alive;
- verify app update/install path does not fail because the daemon is running;
- verify closing the window leaves daemon functionality online;
- verify relaunch replaces an old daemon after version change.

## Acceptance Criteria

Phase 1 is complete only when:

- `ai.mia.daemon.plist` no longer points at `Mia.app/Contents/MacOS/Mia` in
  packaged macOS daemon mode.
- A daemon-only running state does not keep the Mia GUI app active in Dock or
  LaunchServices.
- The updater guard remains and update install no longer fails because the
  daemon shares the GUI app identity.
- `startDaemonService()` and `stopDaemonService()` still work through launchd
  on macOS.
- Old-version daemon replacement still works.
- Non-macOS/dev daemon spawn paths still work or fail with explicit diagnostics.
- The code contains a clear Mia Core executable seam that Phase 2 can replace.
- Documentation points from this spec and the single-owner ADR to the Phase 2
  Mia Core split target.

## Implementation Plan Preview

The implementation plan should be written separately after this spec is
reviewed. It should likely sequence work as:

1. Add resolver tests and the resolver Module.
2. Refactor launchd daemon command generation to use the resolver.
3. Refactor detached spawn to use the resolver.
4. Add packaging hook/resource for the nested Mia Core helper app or executable.
5. Add diagnostics and status fields.
6. Run targeted tests and `npm run check`.
7. Perform macOS packaged verification when release credentials/environment are
   available.

No implementation should start until this spec is reviewed and approved.
