use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Merge desktop-safe tool locations into the process PATH before Tokio starts.
///
/// # Safety
///
/// The caller must invoke this before creating worker threads. The function
/// updates the process environment after its short-lived shell reader has been
/// joined.
pub unsafe fn enhance_process_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = process_home_dir();
    let extras = platform_extra_bins(home.as_deref());
    let login = login_shell_path();
    let merged = merge_paths(&extras, &current, login.as_deref());

    if merged != current {
        tracing::info!(
            extra_bin_count = extras.len(),
            login_shell_path = login.is_some(),
            original_len = current.len(),
            merged_len = merged.len(),
            "agent PATH enhanced at startup"
        );
        // SAFETY: the caller guarantees that no other thread exists here.
        unsafe { std::env::set_var("PATH", &merged) };
    }
    merged
}

fn merge_paths(extras: &[PathBuf], current: &str, login: Option<&str>) -> String {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
            paths.push(path);
        }
    };

    for path in extras {
        push(path.clone());
    }
    for path in std::env::split_paths(current) {
        push(path);
    }
    if let Some(login) = login {
        for path in std::env::split_paths(login) {
            push(path);
        }
    }

    std::env::join_paths(paths)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| current.to_string())
}

fn process_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn platform_extra_bins(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut push_if_dir = |path: PathBuf| {
        if path.is_dir() {
            paths.push(path);
        }
    };

    if let Some(home) = home {
        for relative in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            ".deno/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            "Library/pnpm",
            "go/bin",
        ] {
            push_if_dir(home.join(relative));
        }
        for path in nvm_version_bins(home) {
            push_if_dir(path);
        }
    }

    #[cfg(unix)]
    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ] {
        push_if_dir(PathBuf::from(path));
    }

    #[cfg(windows)]
    {
        if let Some(value) = std::env::var_os("APPDATA") {
            push_if_dir(PathBuf::from(value).join("npm"));
        }
        if let Some(value) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(value);
            push_if_dir(root.join("pnpm"));
            push_if_dir(root.join("Microsoft").join("WinGet").join("Links"));
            push_if_dir(root.join("Yarn").join("bin"));
        }
        if let Some(value) = std::env::var_os("ProgramFiles") {
            let root = PathBuf::from(value);
            push_if_dir(root.join("nodejs"));
            push_if_dir(root.join("Git").join("cmd"));
        }
        if let Some(home) = home {
            push_if_dir(home.join("scoop").join("shims"));
        }
    }

    paths
}

fn nvm_version_bins(home: &Path) -> Vec<PathBuf> {
    let root = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin"))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| right.cmp(left));
    paths
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var_os("SHELL").map(PathBuf::from)?;
    if !shell.is_absolute() || !shell.is_file() {
        return None;
    }
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        let mut stdout = stdout;
        stdout.read_to_string(&mut output).ok().map(|_| output)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = reader.join().ok().flatten()?;
    status
        .filter(|status| status.success())
        .and_then(|_| (!output.trim().is_empty()).then(|| output.trim().to_string()))
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_merge_preserves_priority_and_deduplicates() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let current = format!("/current{separator}/shared");
        let login = format!("/shared{separator}/login");
        let merged = merge_paths(&[PathBuf::from("/extra")], &current, Some(&login));
        let values = std::env::split_paths(&merged).collect::<Vec<_>>();
        assert_eq!(
            values,
            vec![
                PathBuf::from("/extra"),
                PathBuf::from("/current"),
                PathBuf::from("/shared"),
                PathBuf::from("/login")
            ]
        );
    }

    #[test]
    fn extra_bins_include_all_installed_nvm_versions() {
        let root = std::env::temp_dir().join(format!("mia-shell-env-{}", uuid::Uuid::now_v7()));
        let home = root.join("home");
        let old = home.join(".nvm/versions/node/v22.0.0/bin");
        let current = home.join(".nvm/versions/node/v24.0.0/bin");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&current).unwrap();

        let paths = platform_extra_bins(Some(&home));
        let nvm = paths
            .into_iter()
            .filter(|path| path.starts_with(home.join(".nvm")))
            .collect::<Vec<_>>();
        assert_eq!(nvm, vec![current, old]);
        let _ = std::fs::remove_dir_all(root);
    }
}
