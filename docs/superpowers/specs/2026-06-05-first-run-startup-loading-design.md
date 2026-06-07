# First-Run Startup Loading Design

Status: implemented as of 2026-06-07. The welcome animation now lives in the repository at `src/renderer/assets/lottie/welcome.json`; this file is retained as the design record.

## Goal

Mia should not drop first-time users into the main chat UI while runtime setup, LaunchAgent registration, and first-run loader work are still competing for resources. On the first install/open path, the app should show a focused loading experience using `src/renderer/assets/lottie/welcome.json`, complete the necessary startup work, then reveal the normal product UI.

## Scope

This change is limited to the desktop Electron first-run path. A first run is the current compact onboarding condition: the Mia runtime directory does not exist before the app starts, or `MIA_FORCE_AGENT_SETUP_WINDOW=1` is set. Existing users should keep the current fast entry behavior.

The startup loading flow covers:

- Runtime initialization through `window.mia.initializeRuntime()`.
- Initial renderer loaders for model catalog, Codex models, engine capabilities, slash commands, and local skills.
- Background daemon startup through a new explicit startup IPC, using the existing `startDaemonService()` path.
- Hermes engine auto-start when Hermes is installed, using the existing `startEngine()` path.

## User Experience

On first run, the main window opens directly into a startup overlay instead of exposing the chat UI. The overlay plays the Lottie JSON animation from `src/renderer/assets/lottie/welcome.json`, shows one concise status line, and advances through the startup tasks.

When required startup work finishes, the overlay shows a welcome state briefly, then fades out and leaves the existing Mia UI ready for use. If a non-critical task fails, the overlay still lets the user continue and the error remains visible in existing runtime logs/status surfaces. If runtime initialization itself fails, the existing fatal initialization error UI remains the fallback.

## Architecture

The renderer owns presentation and task sequencing because the existing app already calls startup IPCs from `src/renderer/app.js`. A small startup overlay module/CSS should be added rather than growing unrelated UI code.

The main process owns privileged/background actions. Add a narrow IPC channel for "startup background services" that schedules or directly runs the same daemon/engine startup logic currently triggered after `did-finish-load`. This avoids duplicating launchd behavior in the renderer.

The existing delayed background startup should be skipped during the first-run overlay, otherwise it would race the explicit startup task sequence.

## Data And State

No new durable state is required for the first implementation. The runtime directory existence is enough to decide whether the full first-run overlay should block entry. The renderer may keep transient status in `state.startupTasks` or a small startup overlay state object.

## Error Handling

Runtime initialization failure is fatal for first-run entry and should show the existing "Mia 初始化失败" message.

Daemon startup and engine auto-start are best-effort. Their errors should not trap the user on the welcome screen, because the existing settings/status UI can surface and repair those states.

Model/command/skill loader failures should keep their current fallbacks.

## Testing

Unit-level checks should cover the new main-process startup IPC behavior with disabled background startup and best-effort failures where practical.

Manual/rendered QA should cover:

- First-run mode opens with the welcome overlay.
- The overlay advances through initialization and disappears.
- Existing-user mode does not block entry.
- The renderer does not show a blank page or console errors.
