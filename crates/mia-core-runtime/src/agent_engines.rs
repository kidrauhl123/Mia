use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::RuntimeCommand;
use crate::native_acp::{NativeAcpProbeErrorKind, probe_native_acp_command};

const DEFAULT_AGENT_PROBE_TIMEOUT: Duration = Duration::from_secs(35);
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineInventory {
    pub generated_at: u64,
    pub agents: Vec<AgentEngineStatus>,
    pub summary: AgentEngineInventorySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineInventorySummary {
    pub installed_count: usize,
    pub usable_count: usize,
    pub missing_count: usize,
    pub has_usable_agent: bool,
    pub recommended_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineStatus {
    pub id: String,
    pub label: String,
    pub commands: Vec<String>,
    pub command: String,
    pub installed: bool,
    pub usable_in_mia: bool,
    pub installable: bool,
    pub install_action: String,
    pub detection_only: bool,
    pub path: String,
    pub version: String,
    pub source: String,
    pub health: String,
    pub readiness: AgentEngineReadiness,
    pub system: AgentEngineSystemStatus,
    pub runtime: AgentEngineRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineReadiness {
    pub status: String,
    pub checked: bool,
    pub summary: String,
    pub detail: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineSystemStatus {
    pub available: bool,
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineRuntimeStatus {
    pub source: String,
    pub managed: bool,
    pub supported: bool,
    pub path: String,
    pub version: String,
    pub protocol: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentEngineScanOptions {
    pub env: BTreeMap<String, String>,
    pub home_dir: Option<PathBuf>,
    pub workspace_dir: PathBuf,
    pub generated_at: u64,
    pub probe_timeout: Duration,
}

impl AgentEngineScanOptions {
    pub fn current(workspace_dir: impl Into<PathBuf>) -> Self {
        let env = env::vars().collect::<BTreeMap<_, _>>();
        Self {
            home_dir: current_home_dir(&env),
            env,
            workspace_dir: workspace_dir.into(),
            generated_at: current_time_ms(),
            probe_timeout: DEFAULT_AGENT_PROBE_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn for_tests() -> Self {
        Self {
            env: BTreeMap::new(),
            home_dir: None,
            workspace_dir: PathBuf::from("/tmp/mia-agent-probe"),
            generated_at: 1,
            probe_timeout: Duration::from_millis(50),
        }
    }
}

#[derive(Clone)]
pub struct AgentEngineScanner {
    resolver: Arc<dyn AgentCommandResolver>,
    prober: Arc<dyn AcpCommandProber>,
}

impl std::fmt::Debug for AgentEngineScanner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentEngineScanner")
            .finish_non_exhaustive()
    }
}

impl Default for AgentEngineScanner {
    fn default() -> Self {
        Self::real()
    }
}

impl AgentEngineScanner {
    pub fn real() -> Self {
        Self {
            resolver: Arc::new(RealAgentCommandResolver),
            prober: Arc::new(RealAcpCommandProber),
        }
    }

    pub async fn scan(&self, options: AgentEngineScanOptions) -> AgentEngineInventory {
        let mut agents = Vec::new();
        for definition in agent_definitions() {
            agents.push(self.scan_definition(definition, &options).await);
        }
        build_inventory(agents, options.generated_at)
    }

    async fn scan_definition(
        &self,
        definition: AgentEngineDefinition,
        options: &AgentEngineScanOptions,
    ) -> AgentEngineStatus {
        let primary = self
            .resolver
            .resolve(definition.primary_command, options)
            .await;
        let Some(primary) = primary else {
            return missing_primary_status(definition);
        };
        let version = self.resolver.version(&primary.path, options).await;

        let acp_launcher = self.resolver.resolve(definition.acp_command, options).await;
        let Some(acp_launcher) = acp_launcher else {
            return blocked_status(
                definition,
                primary,
                version,
                None,
                "acp_command_missing",
                &format!(
                    "{} ACP launcher 未检测到: {}",
                    definition.label,
                    definition.acp_display()
                ),
                "",
                acp_failure_action(definition),
            );
        };

        let outcome = self
            .prober
            .probe(AcpProbeRequest {
                engine_id: definition.acp_engine_id.to_string(),
                command: RuntimeCommand {
                    program: acp_launcher.path.clone(),
                    args: definition
                        .acp_args
                        .iter()
                        .map(|item| (*item).into())
                        .collect(),
                },
                display: definition.acp_display_with(&acp_launcher.path),
                env: acp_probe_environment(definition, options, &primary),
                workspace_dir: options.workspace_dir.clone(),
                timeout: options.probe_timeout,
            })
            .await;

        match outcome {
            AcpProbeOutcome::Ready { detail, .. } => ready_status(
                definition,
                primary,
                version,
                acp_launcher,
                detail
                    .as_deref()
                    .unwrap_or("ACP initialize + session/new + prompt ok"),
            ),
            AcpProbeOutcome::Failed {
                error_code, detail, ..
            } => blocked_status(
                definition,
                primary,
                version,
                Some(acp_launcher),
                &error_code,
                &format!("{} ACP 启动自检失败", definition.label),
                &detail,
                acp_failure_action(definition),
            ),
        }
    }

    #[cfg(test)]
    fn fake_for_tests<C, P>(commands: C, probes: P) -> Self
    where
        C: IntoIterator<Item = (&'static str, &'static str)>,
        P: IntoIterator<Item = (&'static str, AcpProbeOutcome)>,
    {
        Self {
            resolver: Arc::new(FakeAgentCommandResolver {
                commands: commands
                    .into_iter()
                    .map(|(command, path)| (command.to_string(), path.to_string()))
                    .collect(),
            }),
            prober: Arc::new(FakeAcpCommandProber {
                probes: probes
                    .into_iter()
                    .map(|(engine, outcome)| (engine.to_string(), outcome))
                    .collect(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct AgentEngineDefinition {
    id: &'static str,
    acp_engine_id: &'static str,
    label: &'static str,
    primary_command: &'static str,
    commands: &'static [&'static str],
    acp_command: &'static str,
    acp_args: &'static [&'static str],
    installable: bool,
    detection_only: bool,
}

impl AgentEngineDefinition {
    fn acp_display(&self) -> String {
        self.acp_display_with(self.acp_command)
    }

    fn acp_display_with(&self, command: &str) -> String {
        [command]
            .into_iter()
            .chain(self.acp_args.iter().copied())
            .filter(|item| !item.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn agent_definitions() -> Vec<AgentEngineDefinition> {
    vec![
        AgentEngineDefinition {
            id: "hermes",
            acp_engine_id: "hermes",
            label: "Hermes",
            primary_command: "hermes",
            commands: &["hermes"],
            acp_command: "hermes",
            acp_args: &["acp"],
            installable: true,
            detection_only: false,
        },
        AgentEngineDefinition {
            id: "claude-code",
            acp_engine_id: "claude",
            label: "Claude Code",
            primary_command: "claude",
            commands: &["claude"],
            acp_command: "npx",
            acp_args: &["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"],
            installable: true,
            detection_only: false,
        },
        AgentEngineDefinition {
            id: "codex",
            acp_engine_id: "codex",
            label: "Codex",
            primary_command: "codex",
            commands: &["codex"],
            acp_command: "npx",
            acp_args: &["-y", "@agentclientprotocol/codex-acp@1.1.0"],
            installable: true,
            detection_only: false,
        },
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedCommand {
    command: String,
    path: String,
}

#[async_trait]
trait AgentCommandResolver: Send + Sync {
    async fn resolve(
        &self,
        command: &str,
        options: &AgentEngineScanOptions,
    ) -> Option<ResolvedCommand>;

    async fn version(&self, path: &str, options: &AgentEngineScanOptions) -> String;
}

#[derive(Debug, Default)]
struct RealAgentCommandResolver;

#[async_trait]
impl AgentCommandResolver for RealAgentCommandResolver {
    async fn resolve(
        &self,
        command: &str,
        options: &AgentEngineScanOptions,
    ) -> Option<ResolvedCommand> {
        resolve_command_path(command, options).map(|path| ResolvedCommand {
            command: command.trim().to_string(),
            path,
        })
    }

    async fn version(&self, path: &str, options: &AgentEngineScanOptions) -> String {
        let path = path.trim();
        if path.is_empty() {
            return String::new();
        }
        let mut command = Command::new(path);
        command
            .arg("--version")
            .env_clear()
            .envs(options.env.iter());
        match tokio::time::timeout(VERSION_TIMEOUT, command.output()).await {
            Ok(Ok(output)) => first_output_line(&output.stdout, &output.stderr),
            _ => String::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct AcpProbeRequest {
    #[cfg_attr(not(test), allow(dead_code))]
    engine_id: String,
    command: RuntimeCommand,
    display: String,
    env: BTreeMap<String, String>,
    workspace_dir: PathBuf,
    timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AcpProbeOutcome {
    Ready {
        detail: Option<String>,
        latency_ms: u64,
    },
    Failed {
        error_code: String,
        detail: String,
        latency_ms: u64,
    },
}

impl AcpProbeOutcome {
    #[cfg(test)]
    fn failed(error_code: &str, detail: &str) -> Self {
        Self::Failed {
            error_code: error_code.into(),
            detail: detail.into(),
            latency_ms: 1,
        }
    }
}

#[async_trait]
trait AcpCommandProber: Send + Sync {
    async fn probe(&self, request: AcpProbeRequest) -> AcpProbeOutcome;
}

#[derive(Debug, Default)]
struct RealAcpCommandProber;

#[async_trait]
impl AcpCommandProber for RealAcpCommandProber {
    async fn probe(&self, request: AcpProbeRequest) -> AcpProbeOutcome {
        let started = Instant::now();
        match probe_native_acp_command(
            request.command,
            request.env,
            request.workspace_dir,
            request.timeout,
        )
        .await
        {
            Ok(()) => AcpProbeOutcome::Ready {
                detail: Some(format!(
                    "{}: initialize + session/new + prompt ok",
                    request.display
                )),
                latency_ms: elapsed_ms(started),
            },
            Err(error) => {
                let detail = compact_one_line(format!(
                    "{}: {} {}",
                    request.display, error.message, error.stderr
                ));
                AcpProbeOutcome::Failed {
                    error_code: classify_acp_probe_error(error.kind, &detail),
                    detail,
                    latency_ms: elapsed_ms(started),
                }
            }
        }
    }
}

fn missing_primary_status(definition: AgentEngineDefinition) -> AgentEngineStatus {
    let install_action = if definition.installable {
        format!("install-{}", definition.id)
    } else {
        String::new()
    };
    let readiness = readiness(
        "missing",
        &format!("{} CLI 未检测到", definition.label),
        definition.primary_command,
        &install_action,
        Some("command_not_found"),
    );
    status_from_parts(
        definition,
        None,
        String::new(),
        None,
        false,
        false,
        "missing",
        "missing",
        install_action,
        readiness,
    )
}

fn ready_status(
    definition: AgentEngineDefinition,
    primary: ResolvedCommand,
    version: String,
    acp: ResolvedCommand,
    detail: &str,
) -> AgentEngineStatus {
    let readiness = readiness(
        "ready",
        &format!("{} ACP 启动自检通过", definition.label),
        detail,
        "",
        None,
    );
    status_from_parts(
        definition,
        Some(primary),
        version,
        Some(acp),
        true,
        true,
        "system",
        "ready",
        String::new(),
        readiness,
    )
}

fn blocked_status(
    definition: AgentEngineDefinition,
    primary: ResolvedCommand,
    version: String,
    acp: Option<ResolvedCommand>,
    error_code: &str,
    summary: &str,
    detail: &str,
    install_action: String,
) -> AgentEngineStatus {
    let readiness = readiness(
        "blocked",
        summary,
        detail,
        &install_action,
        Some(error_code),
    );
    status_from_parts(
        definition,
        Some(primary),
        version,
        acp,
        true,
        false,
        "system",
        "blocked",
        install_action,
        readiness,
    )
}

fn status_from_parts(
    definition: AgentEngineDefinition,
    primary: Option<ResolvedCommand>,
    version: String,
    acp: Option<ResolvedCommand>,
    installed: bool,
    usable_in_mia: bool,
    source: &str,
    health: &str,
    install_action: String,
    readiness: AgentEngineReadiness,
) -> AgentEngineStatus {
    let primary_path = primary
        .as_ref()
        .map(|item| item.path.clone())
        .unwrap_or_default();
    let command = primary
        .as_ref()
        .map(|item| item.command.clone())
        .unwrap_or_else(|| definition.primary_command.into());
    let acp_path = acp
        .as_ref()
        .map(|item| item.path.clone())
        .unwrap_or_default();
    AgentEngineStatus {
        id: definition.id.into(),
        label: definition.label.into(),
        commands: definition
            .commands
            .iter()
            .map(|item| (*item).into())
            .collect(),
        command,
        installed,
        usable_in_mia,
        installable: definition.installable,
        install_action,
        detection_only: definition.detection_only,
        path: primary_path.clone(),
        version: version.clone(),
        source: source.into(),
        health: health.into(),
        readiness,
        system: AgentEngineSystemStatus {
            available: installed,
            path: primary_path,
            version,
        },
        runtime: AgentEngineRuntimeStatus {
            source: if acp.is_some() { "system" } else { "missing" }.into(),
            managed: false,
            supported: acp.is_some(),
            path: acp_path,
            version: String::new(),
            protocol: "acp".into(),
            command: definition.acp_command.into(),
            args: definition
                .acp_args
                .iter()
                .map(|item| (*item).into())
                .collect(),
        },
    }
}

fn readiness(
    status: &str,
    summary: &str,
    detail: &str,
    action: &str,
    error_code: Option<&str>,
) -> AgentEngineReadiness {
    AgentEngineReadiness {
        status: status.into(),
        checked: true,
        summary: summary.into(),
        detail: detail.into(),
        action: action.into(),
        error_code: error_code.map(str::to_string),
    }
}

fn acp_failure_action(definition: AgentEngineDefinition) -> String {
    if definition.id == "hermes" {
        "repair-hermes".into()
    } else {
        String::new()
    }
}

fn acp_probe_environment(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
    primary: &ResolvedCommand,
) -> BTreeMap<String, String> {
    let mut env = options.env.clone();
    if definition.id == "codex" && !env.contains_key("CODEX_PATH") {
        env.insert("CODEX_PATH".into(), primary.path.clone());
    }
    env
}

fn build_inventory(agents: Vec<AgentEngineStatus>, generated_at: u64) -> AgentEngineInventory {
    let installed_count = agents.iter().filter(|agent| agent.installed).count();
    let usable_count = agents.iter().filter(|agent| agent.usable_in_mia).count();
    let repairable = agents
        .iter()
        .find(|agent| !agent.usable_in_mia && !agent.install_action.is_empty());
    let recommended_action = if usable_count > 0 {
        "continue".into()
    } else if let Some(agent) = repairable {
        agent.install_action.clone()
    } else {
        "scan".into()
    };
    AgentEngineInventory {
        generated_at,
        summary: AgentEngineInventorySummary {
            installed_count,
            usable_count,
            missing_count: agents.len().saturating_sub(installed_count),
            has_usable_agent: usable_count > 0,
            recommended_action,
        },
        agents,
    }
}

fn classify_acp_probe_error(kind: NativeAcpProbeErrorKind, detail: &str) -> String {
    let lower = detail.to_lowercase();
    if lower.contains("not logged in")
        || lower.contains("login")
        || lower.contains("auth")
        || lower.contains("api key")
        || lower.contains("unauthorized")
    {
        return "auth_required".into();
    }
    match kind {
        NativeAcpProbeErrorKind::Spawn => "acp_spawn_failed",
        NativeAcpProbeErrorKind::Initialize => "acp_init_failed",
        NativeAcpProbeErrorKind::NewSession => "acp_session_failed",
        NativeAcpProbeErrorKind::Prompt => "acp_prompt_failed",
        NativeAcpProbeErrorKind::Timeout => "acp_probe_timeout",
    }
    .into()
}

fn command_search_dirs(options: &AgentEngineScanOptions) -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(home) = &options.home_dir {
        dirs.extend(default_user_path_segments(home, &options.env));
    }
    dirs.extend(default_system_path_segments());
    dirs.extend(path_env_segments(&options.env));
    dedupe_non_empty(dirs)
}

pub(crate) fn resolve_agent_command_path(
    command: &str,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    let options = AgentEngineScanOptions {
        env: env.clone(),
        home_dir: current_home_dir(env),
        workspace_dir: PathBuf::new(),
        generated_at: 0,
        probe_timeout: DEFAULT_AGENT_PROBE_TIMEOUT,
    };
    resolve_command_path(command, &options)
}

fn resolve_command_path(command: &str, options: &AgentEngineScanOptions) -> Option<String> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    if command.contains('/') || command.contains('\\') {
        return executable_path(command);
    }
    for dir in command_search_dirs(options) {
        for file_name in command_file_names(command, options) {
            let candidate = Path::new(&dir).join(file_name);
            if let Some(path) = executable_path(candidate) {
                return Some(path);
            }
        }
    }
    None
}

fn default_user_path_segments(home: &Path, env: &BTreeMap<String, String>) -> Vec<String> {
    let mut dirs = vec![
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".deno/bin"),
        home.join(".cargo/bin"),
        home.join("Library/pnpm"),
    ]
    .into_iter()
    .map(path_to_string)
    .collect::<Vec<_>>();
    for key in ["NVM_BIN", "PNPM_HOME", "VOLTA_HOME"] {
        if let Some(value) = env.get(key) {
            dirs.push(value.clone());
        }
    }
    if let Some(value) = env.get("BUN_INSTALL") {
        dirs.push(path_to_string(Path::new(value).join("bin")));
    }
    dirs.push(path_to_string(home.join(".volta/bin")));
    dirs.push(path_to_string(home.join(".asdf/shims")));
    dirs.push(path_to_string(home.join(".local/share/mise/shims")));
    dirs.push(path_to_string(home.join(".local/share/rtx/shims")));
    dirs
}

fn default_system_path_segments() -> Vec<String> {
    if cfg!(windows) {
        Vec::new()
    } else {
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .iter()
        .map(|item| (*item).into())
        .collect()
    }
}

fn path_env_segments(env: &BTreeMap<String, String>) -> Vec<String> {
    let value = env
        .get("PATH")
        .or_else(|| env.get("Path"))
        .cloned()
        .unwrap_or_default();
    env::split_paths(&value).map(path_to_string).collect()
}

fn command_file_names(command: &str, options: &AgentEngineScanOptions) -> Vec<String> {
    if !cfg!(windows) {
        return vec![command.into()];
    }
    if Path::new(command).extension().is_some() {
        return vec![command.into()];
    }
    let pathext = options
        .env
        .get("PATHEXT")
        .map(String::as_str)
        .unwrap_or(".EXE;.CMD;.BAT;.COM");
    pathext
        .split(';')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|ext| format!("{command}{ext}"))
        .collect()
}

fn executable_path(path: impl AsRef<Path>) -> Option<String> {
    let path = path.as_ref();
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path_to_string(path))
}

fn first_output_line(stdout: &[u8], stderr: &[u8]) -> String {
    let output = if stdout.is_empty() { stderr } else { stdout };
    String::from_utf8_lossy(output)
        .lines()
        .next()
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn compact_one_line(value: impl AsRef<str>) -> String {
    let text = value
        .as_ref()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.chars().count() > 240 {
        format!("{}...", text.chars().take(240).collect::<String>())
    } else {
        text
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn current_home_dir(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env.get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn path_to_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().to_string()
}

fn dedupe_non_empty(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || seen.iter().any(|item| item == value) {
            continue;
        }
        seen.push(value.into());
    }
    seen
}

#[cfg(test)]
#[derive(Debug)]
struct FakeAgentCommandResolver {
    commands: HashMap<String, String>,
}

#[cfg(test)]
#[async_trait]
impl AgentCommandResolver for FakeAgentCommandResolver {
    async fn resolve(
        &self,
        command: &str,
        _options: &AgentEngineScanOptions,
    ) -> Option<ResolvedCommand> {
        self.commands.get(command).map(|path| ResolvedCommand {
            command: command.into(),
            path: path.clone(),
        })
    }

    async fn version(&self, path: &str, _options: &AgentEngineScanOptions) -> String {
        format!(
            "{} 1.0.0",
            Path::new(path).file_name().unwrap().to_string_lossy()
        )
    }
}

#[cfg(test)]
#[derive(Debug)]
struct FakeAcpCommandProber {
    probes: HashMap<String, AcpProbeOutcome>,
}

#[cfg(test)]
#[async_trait]
impl AcpCommandProber for FakeAcpCommandProber {
    async fn probe(&self, request: AcpProbeRequest) -> AcpProbeOutcome {
        self.probes
            .get(&request.engine_id)
            .cloned()
            .unwrap_or(AcpProbeOutcome::Ready {
                detail: Some(format!("{} ok", request.display)),
                latency_ms: 1,
            })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Debug)]
    struct RecordingAcpCommandProber {
        requests: Arc<Mutex<Vec<AcpProbeRequest>>>,
    }

    #[async_trait]
    impl AcpCommandProber for RecordingAcpCommandProber {
        async fn probe(&self, request: AcpProbeRequest) -> AcpProbeOutcome {
            self.requests.lock().unwrap().push(request);
            AcpProbeOutcome::Ready {
                detail: Some("ok".into()),
                latency_ms: 1,
            }
        }
    }

    #[tokio::test]
    async fn codex_primary_cli_installed_but_acp_probe_failed_does_not_offer_reinstall() {
        let scanner = AgentEngineScanner::fake_for_tests(
            [
                ("codex", "/usr/local/bin/codex"),
                ("npx", "/usr/local/bin/npx"),
            ],
            [("codex", AcpProbeOutcome::failed("acp_init_failed", "boom"))],
        );

        let inventory = scanner.scan(AgentEngineScanOptions::for_tests()).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(codex.installed);
        assert!(!codex.usable_in_mia);
        assert_eq!(codex.health, "blocked");
        assert_eq!(codex.install_action, "");
        assert_eq!(codex.readiness.status, "blocked");
        assert_eq!(
            codex.readiness.error_code.as_deref(),
            Some("acp_init_failed")
        );
    }

    #[tokio::test]
    async fn codex_acp_probe_uses_resolved_system_codex_cli() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let scanner = AgentEngineScanner {
            resolver: Arc::new(FakeAgentCommandResolver {
                commands: [
                    ("codex".to_string(), "/opt/homebrew/bin/codex".to_string()),
                    ("npx".to_string(), "/opt/homebrew/bin/npx".to_string()),
                ]
                .into_iter()
                .collect(),
            }),
            prober: Arc::new(RecordingAcpCommandProber {
                requests: requests.clone(),
            }),
        };

        scanner.scan(AgentEngineScanOptions::for_tests()).await;
        let requests = requests.lock().unwrap();
        let request = requests
            .iter()
            .find(|request| request.engine_id == "codex")
            .expect("codex probe request");

        assert_eq!(
            request.env.get("CODEX_PATH").map(String::as_str),
            Some("/opt/homebrew/bin/codex")
        );
    }

    #[tokio::test]
    async fn missing_codex_primary_cli_offers_codex_install() {
        let scanner = AgentEngineScanner::fake_for_tests([], []);

        let inventory = scanner.scan(AgentEngineScanOptions::for_tests()).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(!codex.installed);
        assert_eq!(codex.health, "missing");
        assert_eq!(codex.install_action, "install-codex");
        assert_eq!(
            codex.readiness.error_code.as_deref(),
            Some("command_not_found")
        );
    }

    #[tokio::test]
    async fn ready_codex_requires_primary_cli_and_acp_session_probe() {
        let scanner = AgentEngineScanner::fake_for_tests(
            [
                ("codex", "/usr/local/bin/codex"),
                ("npx", "/usr/local/bin/npx"),
            ],
            [],
        );

        let inventory = scanner.scan(AgentEngineScanOptions::for_tests()).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(codex.installed);
        assert!(codex.usable_in_mia);
        assert_eq!(codex.health, "ready");
        assert_eq!(codex.install_action, "");
        assert_eq!(codex.runtime.protocol, "acp");
        assert_eq!(codex.runtime.command, "npx");
    }
}
