//! Shared child-process policy for Mia Core.

/// Configure a child process that is owned by Mia Core rather than shown to
/// the user as an interactive terminal.
pub fn configure_background_command(command: &mut std::process::Command) {
    hide_windows_console(command);
}

#[cfg(windows)]
fn hide_windows_console(command: &mut std::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_windows_console(_command: &mut std::process::Command) {}
