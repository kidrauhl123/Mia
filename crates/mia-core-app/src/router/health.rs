use axum::Json;
use serde_json::{Value, json};

use mia_core_api_types::HealthResponse;

use super::state::ModuleStates;

pub async fn health_check(
    axum::extract::State(state): axum::extract::State<ModuleStates>,
) -> Json<HealthResponse> {
    let data_dir = state.data_dir.display().to_string();
    Json(HealthResponse {
        ok: true,
        version: state.app_version,
        pid: std::process::id(),
        data_dir: data_dir.clone(),
        runtime_home: data_dir,
        mode: "daemon".to_string(),
        daemon_target: daemon_target(state.parent_pid),
    })
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn current_exe_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "mia-core".to_string())
}

fn daemon_target(parent_pid: Option<u32>) -> Value {
    json!({
        "kind": env_value("MIA_CORE_TARGET_KIND").unwrap_or_else(|| "rust-core".to_string()),
        "command": env_value("MIA_CORE_TARGET_COMMAND").unwrap_or_else(current_exe_name),
        "usesGuiAppIdentity": env_value("MIA_CORE_USES_GUI_IDENTITY").as_deref() == Some("1"),
        "workingDirectory": env_value("MIA_CORE_WORKING_DIRECTORY").unwrap_or_default(),
        "sourceFingerprint": env_value("MIA_CORE_SOURCE_FINGERPRINT").unwrap_or_default(),
        "parentPid": parent_pid,
    })
}
