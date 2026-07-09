use std::io::{self, Write};
use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use axum::serve;
use clap::{Parser, Subcommand};
use mia_core_api_types::ListeningEvent;
use mia_core_app::{AppConfig, AppServices, TaskScheduler, create_router};
use mia_core_common::{DEFAULT_HOST, DEFAULT_PORT, LISTENING_EVENT_PREFIX};
use tokio::net::TcpListener;

#[derive(Parser, Debug)]
#[command(name = "mia-core", about = "Mia Rust Core backend", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Serve(ServeArgs),
}

#[derive(clap::Args, Debug)]
struct ServeArgs {
    #[arg(long, default_value = DEFAULT_HOST)]
    host: String,
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
    #[arg(long, default_value = "data")]
    data_dir: std::path::PathBuf,
    #[arg(long)]
    workspace_dir: std::path::PathBuf,
    #[arg(long)]
    parent_pid: Option<u32>,
    #[arg(long, default_value = "zh")]
    language: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .init();

    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("MIA_CORE_STARTUP_FAILED {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => run_serve(args).await,
    }
}

async fn run_serve(args: ServeArgs) -> anyhow::Result<()> {
    let mut config = AppConfig {
        host: args.host,
        port: args.port,
        data_dir: args.data_dir,
        workspace_dir: args.workspace_dir,
        parent_pid: args.parent_pid,
        language: args.language,
        app_version: std::env::var("MIA_CORE_APP_VERSION")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
    };

    tokio::fs::create_dir_all(&config.data_dir).await?;
    tokio::fs::create_dir_all(&config.workspace_dir).await?;

    let listener = TcpListener::bind(config.socket_addr()).await?;
    let addr = listener.local_addr()?;
    config.port = addr.port();

    let services = AppServices::from_config(&config).await?;
    emit_listening_event(addr, &config)?;
    let _task_scheduler = TaskScheduler::new(services.clone()).start();
    let router = create_router(&services);
    serve(listener, router)
        .with_graceful_shutdown(shutdown_signal(config.parent_pid))
        .await?;
    Ok(())
}

async fn shutdown_signal(parent_pid: Option<u32>) {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::warn!(%error, "failed to listen for shutdown signal");
        }
    };

    match parent_pid.filter(|pid| *pid > 0) {
        Some(pid) => {
            tokio::select! {
                _ = ctrl_c => {},
                _ = wait_for_parent_exit(pid) => {},
            }
        }
        None => ctrl_c.await,
    }
}

async fn wait_for_parent_exit(parent_pid: u32) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        interval.tick().await;
        if !parent_process_is_alive(parent_pid) {
            tracing::info!(parent_pid, "parent process exited; shutting down Mia Core");
            return;
        }
    }
}

fn parent_process_is_alive(parent_pid: u32) -> bool {
    if parent_pid == 0 {
        return false;
    }
    platform_parent_process_is_alive(parent_pid)
}

#[cfg(unix)]
fn platform_parent_process_is_alive(parent_pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(parent_pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn platform_parent_process_is_alive(parent_pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {parent_pid}"), "/NH"])
        .stderr(std::process::Stdio::null())
        .output()
        .map(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains(&parent_pid.to_string())
        })
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn platform_parent_process_is_alive(_parent_pid: u32) -> bool {
    true
}

fn emit_listening_event(addr: SocketAddr, config: &AppConfig) -> anyhow::Result<()> {
    let event = ListeningEvent {
        host: addr.ip().to_string(),
        port: addr.port(),
        pid: std::process::id(),
        version: config.app_version.clone(),
    };
    println!(
        "{LISTENING_EVENT_PREFIX} {}",
        serde_json::to_string(&event)?
    );
    io::stdout().flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_process_check_detects_current_and_missing_processes() {
        assert!(parent_process_is_alive(std::process::id()));
        assert!(!parent_process_is_alive(u32::MAX));
    }

    #[tokio::test]
    async fn shutdown_signal_returns_when_parent_pid_is_missing() {
        tokio::time::timeout(Duration::from_secs(2), shutdown_signal(Some(u32::MAX)))
            .await
            .expect("missing parent pid should trigger shutdown promptly");
    }
}
