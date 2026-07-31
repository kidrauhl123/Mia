//! Shared child-process policy for Mia Core.

/// Configure a child process that is owned by Mia Core rather than shown to
/// the user as an interactive terminal.
pub fn configure_background_command(command: &mut std::process::Command) {
    hide_windows_console(command);
}

/// Terminate a Windows child and every process descended from it.
///
/// `kill_on_drop` only stops the direct ACP bridge process. Agent CLIs can own
/// MCP and model-provider children, so eviction must close the complete tree.
#[cfg(windows)]
pub fn terminate_process_tree(process_id: u32) -> std::io::Result<()> {
    let mut command = std::process::Command::new("taskkill.exe");
    configure_background_command(&mut command);
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let _ = command.status()?;
    Ok(())
}

#[cfg(windows)]
fn hide_windows_console(command: &mut std::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_windows_console(_command: &mut std::process::Command) {}
