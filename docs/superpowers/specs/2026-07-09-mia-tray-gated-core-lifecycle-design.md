# Mia Tray-Gated Core Lifecycle Design

Status: ready for user review.

## Context

Mia needs a clearer desktop background model. The user-facing rule should be
simple:

- tray/menu bar icon present means Mia Core is running;
- tray/menu bar icon absent means Mia Core has been fully stopped;
- closing the window is not the same as quitting Mia.

This differs from a silent daemon model. Mia should not let the desktop Core
continue running invisibly after the user has removed the system tray or menu
bar entry.

AION provides a useful reference shape: it has an opt-in close-to-tray setting,
intercepts window close when enabled, and uses the tray as a restore and quit
surface. Mia should adopt the user-facing clarity, but make the invariant
stronger: the tray/menu bar icon is the visible anchor for Core ownership.

## Goals

- Make desktop background activity visible through a system tray/menu bar icon.
- Define one clear difference between closing the window and quitting Mia.
- Ensure explicit tray quit stops Mia Core and removes the icon.
- Prompt the user the first time they close the main window.
- Persist the user's close-window choice only when they choose "Remember my
  choice".
- Hide the macOS Dock icon when Mia is closed to the menu bar, so the menu bar
  icon is the background anchor.
- Keep this scoped to desktop app lifecycle. Direct developer or test launches
  of `mia-core` are outside this product invariant.

## Non-Goals

- Redesign logout or local data retention behavior.
- Change Core's HTTP, SSE, cloud, memory, or agent runtime contracts.
- Introduce a separate tray/helper process in the first implementation.
- Add a settings-page background activity dashboard.
- Change mobile behavior.

## Decision

Mia will use a **tray-gated Core lifecycle** for the desktop app.

In the first implementation, the Electron main process owns the tray/menu bar
icon and the main window. Closing the window hides the window and leaves the
Electron main process plus Mia Core running. The user can restore the window
from the tray/menu bar icon.

When the user chooses "Quit Mia" from the tray/menu bar menu, Mia performs a
full product quit: stop Mia Core, remove the tray/menu bar icon, and exit the
desktop app.

Mia will not support a normal desktop state where Core keeps running while no
tray/menu bar icon exists. If a future release wants the Electron UI process to
exit while Core keeps running, that must be done with a lightweight helper that
continues owning the visible tray/menu bar icon.

## User Experience

### First Window Close

The first time the user clicks the main window close button, Mia shows a native
confirmation dialog.

Title:

```text
Keep Mia running in the background?
```

Body:

```text
After closing the window, Mia will stay in the menu bar/system tray and Mia Core
will keep running for background tasks and local services. You can reopen Mia
from the menu bar/system tray, or choose "Quit Mia" there to fully stop it.
```

Buttons:

- `Close to Tray`
- `Quit Mia`

Checkbox:

- `Remember my choice`

If the user chooses `Close to Tray`, Mia hides the main window and keeps Core
running. If the checkbox is selected, future window closes go directly to tray
without prompting.

If the user chooses `Quit Mia`, Mia stops Core and exits. If the checkbox is
selected, future window closes fully quit Mia without prompting.

If the checkbox is not selected, Mia applies the current choice only once and
shows the dialog again on the next window close.

### Tray/Menu Bar Behavior

The tray/menu bar icon is created when Mia Core is running under the desktop
app lifecycle. It remains visible whether the main window is open or hidden.

The minimum menu contains:

- `Open Mia`
- Core status, such as `Mia Core: Running`
- Current background activity count, when available
- `Quit Mia`

Additional actions such as pause/resume background work, restart Core, or open
recent conversations can be added later, but they are not required for the
first implementation.

Selecting `Quit Mia` from the tray/menu bar menu never shows the close-window
confirmation dialog. It is already an explicit quit action from the visible
background anchor.

### macOS

When the user closes Mia to the menu bar, the main window is hidden and the Dock
icon should be hidden. The menu bar icon remains visible and becomes the user's
only background entry point.

When the user opens Mia from the menu bar icon, the Dock icon is shown again,
the main window is restored, and the window is focused.

### Windows

Mia uses the Windows notification area/system tray. The taskbar represents the
visible window, not background Core ownership.

When the user closes Mia to tray, the taskbar entry disappears with the hidden
window. The tray icon remains visible while Core is running.

## Architecture

### Tray Lifecycle Service

Add a main-process service responsible for:

- creating the tray/menu bar icon when Core is running;
- destroying the tray/menu bar icon after Core has stopped;
- rebuilding the tray menu when Core status or activity count changes;
- opening and focusing the main window;
- routing `Quit Mia` to the full quit path.

This service is the only module that owns platform tray objects.

### Window Close Policy

Add a focused close-window policy in the main process.

Inputs:

- current Core state;
- current remembered close preference, if any;
- whether the close event came from a real app quit path;
- whether the user selected "Remember my choice" in the prompt.

Outputs:

- hide window to tray;
- perform full quit;
- keep the window open if Mia cannot safely close to tray.

The policy should be testable as a small decision module rather than being
embedded directly in a large `BrowserWindow` event handler.

### Close Preference Storage

Store only the remembered close-window behavior.

Suggested shape:

```json
{
  "windowCloseBehavior": "ask" | "close-to-tray" | "quit"
}
```

The default is `ask`.

Choosing an action without selecting "Remember my choice" does not mutate this
setting.

### Full Quit Path

All explicit product quit actions must share one full quit path:

- tray/menu bar `Quit Mia`;
- remembered window close behavior of `quit`;
- app-level quit commands that are intended to fully stop Mia.

The path must:

- mark the app as explicitly quitting so the window close handler does not
  intercept the quit;
- stop Mia Core;
- destroy the tray/menu bar icon after Core is stopped;
- then quit the Electron app.

## Data Flow

### Startup

1. Electron app starts.
2. Mia Core starts through the existing desktop lifecycle.
3. Once Core is running, the tray/menu bar icon is created.
4. The main window opens normally unless a separate launch-at-login hidden
   behavior is later specified.

### Close Window

1. User clicks the main window close button.
2. Main process consults `windowCloseBehavior`.
3. If the value is `ask`, show the first-close dialog.
4. If the result is `close-to-tray`, prevent the close event and hide the
   window.
5. If the result is `quit`, route to the full quit path.

### Open From Tray

1. User clicks `Open Mia` or double-clicks the tray icon where supported.
2. Main process restores or creates the main window.
3. On macOS, the Dock icon is shown again.

### Quit From Tray

1. User selects `Quit Mia`.
2. Main process routes to the full quit path.
3. Core stops.
4. Tray/menu bar icon is destroyed.
5. App exits.

## Error Handling

- If Core fails to start, Mia must not present a tray/menu bar icon that implies
  Core is running.
- If the user closes the window while Core is not running, Mia should not close
  to tray. It should either keep the window open with the existing Core failure
  UI or perform a full quit.
- If Core stops unexpectedly while the window is hidden, Mia should bring back
  a visible error surface before removing the tray/menu bar icon, or show a
  native notification and restore the Dock/taskbar entry where platform rules
  require it.
- If tray creation fails, Mia should keep the main window visible and avoid a
  hidden background state.
- If Core stop during full quit fails or times out, Mia should log the failure
  and continue with the best existing shutdown behavior, but it must not leave
  a misleading tray/menu bar icon behind.

## Testing

Unit tests should cover the close-window policy:

- default `ask` prompts;
- unremembered `Close to Tray` does not mutate settings;
- remembered `Close to Tray` skips future prompts;
- unremembered `Quit Mia` does not mutate settings;
- remembered `Quit Mia` skips future prompts;
- explicit app quit is not intercepted by close-to-tray logic;
- close-to-tray is rejected when Core is not running.

Main-process tests should cover:

- tray is created after Core enters the running desktop state;
- tray `Quit Mia` routes through the full quit path;
- full quit destroys the tray after stopping Core;
- macOS close-to-tray hides the Dock icon and restore shows it again.

Manual QA should cover macOS and Windows:

- close button first prompt;
- "Remember my choice" persistence;
- restore from menu bar/system tray;
- tray quit fully stops Core;
- relaunch after remembered choices;
- Core startup failure does not create a misleading background icon.

## Acceptance Criteria

- A desktop user can always infer Core ownership from the tray/menu bar icon.
- Closing the window never silently leaves Core running without a visible
  tray/menu bar icon.
- Tray/menu bar `Quit Mia` fully stops Core and exits the desktop app.
- The first close prompt appears until the user checks "Remember my choice".
- macOS uses the menu bar icon, not the Dock icon, as the background anchor.
- Windows uses the system tray, not the taskbar, as the background anchor.
