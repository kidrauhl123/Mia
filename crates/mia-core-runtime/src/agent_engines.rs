use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::HashMap;
use std::env;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mia_core_api_types::RuntimeControl;
use mia_core_common::process::configure_background_command;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::RuntimeCommand;
use crate::hermes_gateway::probe_hermes_gateway_command;
use crate::native_acp::{NativeAcpProbeErrorKind, probe_native_acp_command};

const DEFAULT_AGENT_PROBE_TIMEOUT: Duration = Duration::from_secs(35);
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_MANAGED_ACP_PREPARE_TIMEOUT: Duration = Duration::from_secs(1_800);
const PINNED_CLAUDE_CLI_VERSION: &str = "2.1.211";
const PINNED_CLAUDE_SDK_VERSION: &str = "0.3.211";
const PINNED_CODEX_CLI_VERSION: &str = "0.144.5";
static MANAGED_ACP_PREPARE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static AGENT_RUNTIME_CONTROL_CACHE: OnceLock<RwLock<BTreeMap<String, Vec<RuntimeControl>>>> =
    OnceLock::new();
static AGENT_RUNTIME_SOURCE_CACHE: OnceLock<RwLock<BTreeMap<String, String>>> = OnceLock::new();

pub fn cached_agent_runtime_controls(engine: &str) -> Vec<RuntimeControl> {
    let engine = normalize_agent_engine_id(engine);
    agent_runtime_control_cache()
        .read()
        .unwrap()
        .get(&engine)
        .cloned()
        .unwrap_or_default()
}

fn cache_agent_runtime_controls(engine: &str, controls: Vec<RuntimeControl>) {
    let engine = normalize_agent_engine_id(engine);
    let mut cache = agent_runtime_control_cache().write().unwrap();
    if controls.is_empty() {
        cache.remove(&engine);
    } else {
        cache.insert(engine, controls);
    }
}

fn agent_runtime_control_cache() -> &'static RwLock<BTreeMap<String, Vec<RuntimeControl>>> {
    AGENT_RUNTIME_CONTROL_CACHE.get_or_init(|| RwLock::new(BTreeMap::new()))
}

fn cache_agent_runtime_source(engine: &str, source: &str) {
    let engine = normalize_agent_engine_id(engine);
    let mut cache = agent_runtime_source_cache().write().unwrap();
    if source.trim().is_empty() {
        cache.remove(&engine);
    } else {
        cache.insert(engine, source.to_string());
    }
}

fn cached_agent_runtime_source(engine: &str) -> String {
    agent_runtime_source_cache()
        .read()
        .unwrap()
        .get(&normalize_agent_engine_id(engine))
        .cloned()
        .unwrap_or_default()
}

fn agent_runtime_source_cache() -> &'static RwLock<BTreeMap<String, String>> {
    AGENT_RUNTIME_SOURCE_CACHE.get_or_init(|| RwLock::new(BTreeMap::new()))
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentResourcePrepareReport {
    pub generated_at: u64,
    pub resources: Vec<ManagedAgentResourcePrepareStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentResourcePrepareStatus {
    pub engine_id: String,
    pub label: String,
    pub tool_id: String,
    pub package: String,
    pub version: String,
    pub ready: bool,
    pub path: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentEngineScanOptions {
    pub env: BTreeMap<String, String>,
    pub home_dir: Option<PathBuf>,
    pub workspace_dir: PathBuf,
    pub generated_at: u64,
    pub probe_timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentManagedRuntimePlan {
    pub command: RuntimeCommand,
    pub environment: BTreeMap<String, String>,
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
    prober: Arc<dyn AgentRuntimeCommandProber>,
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
            prober: Arc::new(RealAgentRuntimeCommandProber),
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
            .await
            .or_else(|| resolve_mia_stable_primary(definition, options));
        let Some(primary) = primary else {
            cache_agent_runtime_source(definition.id, "");
            return missing_primary_status(definition);
        };
        let version = if primary.version.trim().is_empty() {
            self.resolver.version(&primary.path, options).await
        } else {
            primary.version.clone()
        };

        let mut managed = resolve_managed_acp_runtime(definition, options);
        if managed.runtime.is_none() && definition.require_managed_acp {
            let previous_diagnostics = managed.diagnostics;
            let mut diagnostics = prepare_managed_acp_runtime(definition, options)
                .await
                .diagnostics;
            diagnostics.extend(previous_diagnostics);
            managed = resolve_managed_acp_runtime(definition, options)
                .with_previous_diagnostics(diagnostics);
        }
        let mut runtime_launcher = if definition.id == "hermes" && primary.source == "mia-managed" {
            let Some(runtime) = resolve_mia_stable_hermes_gateway_runtime(options) else {
                return blocked_status(
                    definition,
                    primary,
                    version,
                    None,
                    "managed_hermes_missing",
                    "Mia 稳定版 Hermes 运行组件不完整",
                    "请重新安装 Mia 后再启用 Hermes。",
                    format!("install-{}", definition.id),
                );
            };
            runtime
        } else if let Some(runtime) = managed.runtime {
            runtime
        } else if definition.require_managed_acp {
            let detail = managed_missing_detail(definition, &managed.diagnostics);
            cache_agent_runtime_source(definition.id, "");
            return blocked_status(
                definition,
                primary,
                version,
                None,
                "managed_acp_missing",
                &format!("{} ACP 运行组件未准备好", definition.label),
                &detail,
                String::new(),
            );
        } else {
            let runtime_launcher = self.resolver.resolve(definition.acp_command, options).await;
            let Some(runtime_launcher) = runtime_launcher else {
                cache_agent_runtime_source(definition.id, "");
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
                    String::new(),
                );
            };
            ResolvedAgentRuntime::system(runtime_launcher, definition.acp_args)
        };
        if definition.id == "hermes" {
            runtime_launcher = as_hermes_gateway_runtime(runtime_launcher);
        }

        let outcome = self
            .prober
            .probe(AgentRuntimeProbeRequest {
                engine_id: definition.acp_engine_id.to_string(),
                command: RuntimeCommand {
                    program: runtime_launcher.path.clone(),
                    args: runtime_launcher.args.clone(),
                },
                display: runtime_launcher.display(),
                env: runtime_probe_environment(definition, options, &primary, &runtime_launcher),
                workspace_dir: options.workspace_dir.clone(),
                timeout: options.probe_timeout,
            })
            .await;

        match outcome {
            AgentRuntimeProbeOutcome::Ready {
                detail, controls, ..
            } => {
                cache_agent_runtime_controls(definition.id, controls);
                cache_agent_runtime_source(definition.id, &primary.source);
                ready_status(
                    definition,
                    primary,
                    version,
                    runtime_launcher,
                    detail
                        .as_deref()
                        .unwrap_or_else(|| default_probe_success_detail(definition)),
                )
            }
            AgentRuntimeProbeOutcome::Failed {
                error_code, detail, ..
            } => {
                cache_agent_runtime_controls(definition.id, Vec::new());
                if error_code != "auth_required" && primary.source == "system" {
                    if let Some(fallback_primary) = resolve_mia_stable_primary(definition, options)
                    {
                        let fallback_version = if fallback_primary.version.trim().is_empty() {
                            self.resolver.version(&fallback_primary.path, options).await
                        } else {
                            fallback_primary.version.clone()
                        };
                        let fallback_runtime = if definition.id == "hermes" {
                            resolve_mia_stable_hermes_gateway_runtime(options)
                        } else {
                            Some(runtime_launcher.clone())
                        };
                        if let Some(fallback_runtime) = fallback_runtime {
                            let fallback_outcome = self
                                .prober
                                .probe(AgentRuntimeProbeRequest {
                                    engine_id: definition.acp_engine_id.to_string(),
                                    command: RuntimeCommand {
                                        program: fallback_runtime.path.clone(),
                                        args: fallback_runtime.args.clone(),
                                    },
                                    display: fallback_runtime.display(),
                                    env: runtime_probe_environment(
                                        definition,
                                        options,
                                        &fallback_primary,
                                        &fallback_runtime,
                                    ),
                                    workspace_dir: options.workspace_dir.clone(),
                                    timeout: options.probe_timeout,
                                })
                                .await;
                            if let AgentRuntimeProbeOutcome::Ready {
                                detail, controls, ..
                            } = fallback_outcome
                            {
                                cache_agent_runtime_controls(definition.id, controls);
                                cache_agent_runtime_source(definition.id, &fallback_primary.source);
                                return ready_status(
                                    definition,
                                    fallback_primary,
                                    fallback_version,
                                    fallback_runtime,
                                    detail.as_deref().unwrap_or_else(|| {
                                        default_probe_success_detail(definition)
                                    }),
                                );
                            }
                        }
                    }
                    cache_agent_runtime_source(definition.id, "");
                    return repairable_status(
                        definition,
                        primary,
                        version,
                        runtime_launcher,
                        &error_code,
                        &format!("{} 本机版本自检失败", definition.label),
                        &detail,
                    );
                }
                cache_agent_runtime_source(definition.id, &primary.source);
                degraded_status(
                    definition,
                    primary,
                    version,
                    runtime_launcher,
                    &error_code,
                    &format!("{} ACP 可用性待确认", definition.label),
                    &detail,
                )
            }
        }
    }

    #[cfg(test)]
    fn fake_for_tests<C, P>(commands: C, probes: P) -> Self
    where
        C: IntoIterator<Item = (&'static str, &'static str)>,
        P: IntoIterator<Item = (&'static str, AgentRuntimeProbeOutcome)>,
    {
        Self {
            resolver: Arc::new(FakeAgentCommandResolver {
                commands: commands
                    .into_iter()
                    .map(|(command, path)| (command.to_string(), path.to_string()))
                    .collect(),
            }),
            prober: Arc::new(FakeAgentRuntimeCommandProber {
                probes: probes
                    .into_iter()
                    .map(|(engine, outcome)| (engine.to_string(), outcome))
                    .collect(),
            }),
        }
    }
}

pub async fn prepare_managed_agent_resources(
    mut options: AgentEngineScanOptions,
) -> ManagedAgentResourcePrepareReport {
    options
        .env
        .insert("MIA_MANAGED_AGENT_PREPARE".into(), "1".into());
    let generated_at = options.generated_at;
    let mut resources = Vec::new();
    for definition in agent_definitions()
        .into_iter()
        .filter(|definition| definition.require_managed_acp)
    {
        let mut diagnostics = prepare_managed_acp_runtime(definition, &options)
            .await
            .diagnostics;
        let resolved = resolve_managed_acp_runtime(definition, &options);
        diagnostics.extend(resolved.diagnostics);
        let (mut ready, path) = match resolved.runtime {
            Some(runtime) => (true, runtime.path),
            None => (false, String::new()),
        };
        if ready {
            if let Err(error) = prune_stale_managed_acp_versions(definition, &options) {
                ready = false;
                diagnostics.push(error);
            }
        }
        resources.push(ManagedAgentResourcePrepareStatus {
            engine_id: definition.id.into(),
            label: definition.label.into(),
            tool_id: definition.managed_tool_id.unwrap_or_default().into(),
            package: definition.managed_package.unwrap_or_default().into(),
            version: definition
                .managed_package_version
                .unwrap_or_default()
                .into(),
            ready,
            path,
            diagnostics,
        });
    }
    ManagedAgentResourcePrepareReport {
        generated_at,
        resources,
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
    acp_tool_ids: &'static [&'static str],
    acp_protocols: &'static [&'static str],
    require_managed_acp: bool,
    managed_tool_id: Option<&'static str>,
    managed_package: Option<&'static str>,
    managed_package_version: Option<&'static str>,
    managed_protocol: Option<&'static str>,
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
            acp_tool_ids: &["hermes", "hermes-agent"],
            acp_protocols: &["acp", "cli", "hermes-agent"],
            require_managed_acp: false,
            managed_tool_id: None,
            managed_package: None,
            managed_package_version: None,
            managed_protocol: None,
            installable: true,
            detection_only: false,
        },
        AgentEngineDefinition {
            id: "claude-code",
            acp_engine_id: "claude",
            label: "Claude Code",
            primary_command: "claude",
            commands: &["claude"],
            acp_command: "",
            acp_args: &[],
            acp_tool_ids: &["claude-agent-acp", "claude-code", "claude-acp", "claude"],
            acp_protocols: &["acp", "cli", "claude-code-cli"],
            require_managed_acp: true,
            managed_tool_id: Some("claude-agent-acp"),
            managed_package: Some("@agentclientprotocol/claude-agent-acp"),
            managed_package_version: Some("0.59.0"),
            managed_protocol: Some("claude-code-cli"),
            installable: true,
            detection_only: false,
        },
        AgentEngineDefinition {
            id: "codex",
            acp_engine_id: "codex",
            label: "Codex",
            primary_command: "codex",
            commands: &["codex"],
            acp_command: "",
            acp_args: &[],
            acp_tool_ids: &["codex-acp", "codex"],
            acp_protocols: &["acp", "cli", "codex-cli", "codex-app-server"],
            require_managed_acp: true,
            managed_tool_id: Some("codex-acp"),
            managed_package: Some("@agentclientprotocol/codex-acp"),
            managed_package_version: Some("1.1.4"),
            managed_protocol: Some("codex-app-server"),
            installable: true,
            detection_only: false,
        },
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedCommand {
    command: String,
    path: String,
    source: String,
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedAgentRuntime {
    command: String,
    path: String,
    args: Vec<String>,
    source: String,
    managed: bool,
    version: String,
    protocol: String,
    env: BTreeMap<String, String>,
    path_entries: Vec<String>,
    root_dir: String,
}

impl ResolvedAgentRuntime {
    fn system(command: ResolvedCommand, args: &[&str]) -> Self {
        Self {
            command: command.command,
            path: command.path,
            args: args.iter().map(|item| (*item).into()).collect(),
            source: "system".into(),
            managed: false,
            version: String::new(),
            protocol: "acp".into(),
            env: BTreeMap::new(),
            path_entries: Vec::new(),
            root_dir: String::new(),
        }
    }

    fn display(&self) -> String {
        [self.path.as_str()]
            .into_iter()
            .chain(self.args.iter().map(String::as_str))
            .filter(|item| !item.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn as_hermes_gateway_runtime(mut runtime: ResolvedAgentRuntime) -> ResolvedAgentRuntime {
    runtime.args = crate::hermes_gateway_args(&runtime.args);
    runtime.protocol = "tui-gateway".into();
    runtime
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
            source: "system".into(),
            version: String::new(),
        })
    }

    async fn version(&self, path: &str, options: &AgentEngineScanOptions) -> String {
        let path = path.trim();
        if path.is_empty() {
            return String::new();
        }
        let mut command = Command::new(path);
        configure_background_command(command.as_std_mut());
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
struct AgentRuntimeProbeRequest {
    #[cfg_attr(not(test), allow(dead_code))]
    engine_id: String,
    command: RuntimeCommand,
    display: String,
    env: BTreeMap<String, String>,
    workspace_dir: PathBuf,
    timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentRuntimeProbeOutcome {
    Ready {
        detail: Option<String>,
        latency_ms: u64,
        controls: Vec<RuntimeControl>,
    },
    Failed {
        error_code: String,
        detail: String,
        latency_ms: u64,
    },
}

impl AgentRuntimeProbeOutcome {
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
trait AgentRuntimeCommandProber: Send + Sync {
    async fn probe(&self, request: AgentRuntimeProbeRequest) -> AgentRuntimeProbeOutcome;
}

#[derive(Debug, Default)]
struct RealAgentRuntimeCommandProber;

#[async_trait]
impl AgentRuntimeCommandProber for RealAgentRuntimeCommandProber {
    async fn probe(&self, request: AgentRuntimeProbeRequest) -> AgentRuntimeProbeOutcome {
        let started = Instant::now();
        if request.engine_id == "hermes" {
            return match probe_hermes_gateway_command(
                request.command,
                request.env,
                request.workspace_dir,
                request.timeout,
            )
            .await
            {
                Ok(snapshot) => AgentRuntimeProbeOutcome::Ready {
                    detail: Some("Hermes Gateway ready + session.create ok".into()),
                    latency_ms: elapsed_ms(started),
                    controls: snapshot.controls,
                },
                Err(error) => {
                    let detail = compact_one_line(error.to_string());
                    let lower = detail.to_lowercase();
                    let error_code = if lower.contains("timed out") {
                        "gateway_timeout"
                    } else if lower.contains("auth") || lower.contains("api key") {
                        "auth_required"
                    } else {
                        "gateway_probe_failed"
                    };
                    AgentRuntimeProbeOutcome::Failed {
                        error_code: error_code.into(),
                        detail,
                        latency_ms: elapsed_ms(started),
                    }
                }
            };
        }
        match probe_native_acp_command(
            request.command,
            request.env,
            request.workspace_dir,
            request.timeout,
        )
        .await
        {
            Ok(snapshot) => AgentRuntimeProbeOutcome::Ready {
                detail: Some(format!("{}: initialize + session/new ok", request.display)),
                latency_ms: elapsed_ms(started),
                controls: snapshot.controls,
            },
            Err(error) => {
                let detail = compact_one_line(format!(
                    "{}: {} {}",
                    request.display, error.message, error.stderr
                ));
                AgentRuntimeProbeOutcome::Failed {
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
    runtime: ResolvedAgentRuntime,
    detail: &str,
) -> AgentEngineStatus {
    let integration = if definition.id == "hermes" {
        "Gateway"
    } else {
        "ACP"
    };
    let readiness = readiness(
        "ready",
        &format!("{} {integration} 自检通过", definition.label),
        detail,
        "",
        None,
    );
    status_from_parts(
        definition,
        Some(primary),
        version,
        Some(runtime),
        true,
        true,
        "system",
        "ready",
        String::new(),
        readiness,
    )
}

fn default_probe_success_detail(definition: AgentEngineDefinition) -> &'static str {
    if definition.id == "hermes" {
        "Hermes Gateway ready + session.create ok"
    } else {
        "ACP initialize + session/new ok"
    }
}

fn blocked_status(
    definition: AgentEngineDefinition,
    primary: ResolvedCommand,
    version: String,
    runtime: Option<ResolvedAgentRuntime>,
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
        runtime,
        true,
        false,
        "system",
        "blocked",
        install_action,
        readiness,
    )
}

fn degraded_status(
    definition: AgentEngineDefinition,
    primary: ResolvedCommand,
    version: String,
    runtime: ResolvedAgentRuntime,
    error_code: &str,
    summary: &str,
    detail: &str,
) -> AgentEngineStatus {
    let readiness = readiness("warning", summary, detail, "", Some(error_code));
    status_from_parts(
        definition,
        Some(primary),
        version,
        Some(runtime),
        true,
        true,
        "system",
        "ready",
        String::new(),
        readiness,
    )
}

fn repairable_status(
    definition: AgentEngineDefinition,
    primary: ResolvedCommand,
    version: String,
    runtime: ResolvedAgentRuntime,
    error_code: &str,
    summary: &str,
    detail: &str,
) -> AgentEngineStatus {
    let install_action = format!("install-{}", definition.id);
    let readiness = readiness(
        "repairable",
        summary,
        detail,
        &install_action,
        Some(error_code),
    );
    status_from_parts(
        definition,
        Some(primary),
        version,
        Some(runtime),
        true,
        false,
        "system",
        "broken",
        install_action,
        readiness,
    )
}

fn status_from_parts(
    definition: AgentEngineDefinition,
    primary: Option<ResolvedCommand>,
    version: String,
    runtime: Option<ResolvedAgentRuntime>,
    installed: bool,
    usable_in_mia: bool,
    source: &str,
    health: &str,
    install_action: String,
    readiness: AgentEngineReadiness,
) -> AgentEngineStatus {
    let resolved_source = primary
        .as_ref()
        .map(|item| item.source.as_str())
        .unwrap_or(source)
        .to_string();
    let primary_path = primary
        .as_ref()
        .map(|item| item.path.clone())
        .unwrap_or_default();
    let command = primary
        .as_ref()
        .map(|item| item.command.clone())
        .unwrap_or_else(|| definition.primary_command.into());
    let runtime_path = runtime
        .as_ref()
        .map(|item| item.path.clone())
        .unwrap_or_default();
    let runtime_source = runtime
        .as_ref()
        .map(|item| item.source.clone())
        .unwrap_or_else(|| "missing".into());
    let runtime_managed = runtime.as_ref().map(|item| item.managed).unwrap_or(false);
    let runtime_version = runtime
        .as_ref()
        .map(|item| item.version.clone())
        .unwrap_or_default();
    let runtime_protocol = runtime
        .as_ref()
        .map(|item| item.protocol.clone())
        .filter(|item| !item.trim().is_empty())
        .unwrap_or_else(|| "acp".into());
    let runtime_command = runtime
        .as_ref()
        .map(|item| item.command.clone())
        .unwrap_or_else(|| definition.acp_command.into());
    let runtime_args = runtime
        .as_ref()
        .map(|item| item.args.clone())
        .unwrap_or_else(|| {
            definition
                .acp_args
                .iter()
                .map(|item| (*item).into())
                .collect()
        });
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
        source: resolved_source.clone(),
        health: health.into(),
        readiness,
        system: AgentEngineSystemStatus {
            available: installed && resolved_source == "system",
            path: if resolved_source == "system" {
                primary_path
            } else {
                String::new()
            },
            version: if resolved_source == "system" {
                version
            } else {
                String::new()
            },
        },
        runtime: AgentEngineRuntimeStatus {
            source: runtime_source,
            managed: runtime_managed,
            supported: runtime.is_some(),
            path: runtime_path,
            version: runtime_version,
            protocol: runtime_protocol,
            command: runtime_command,
            args: runtime_args,
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

fn runtime_probe_environment(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
    primary: &ResolvedCommand,
    runtime: &ResolvedAgentRuntime,
) -> BTreeMap<String, String> {
    let mut env = options.env.clone();
    env.extend(runtime.env.clone());
    prepend_path_entries(&mut env, runtime_path_entries(runtime));
    apply_primary_cli_environment(definition, &mut env, primary.path.clone());
    env
}

fn apply_primary_cli_environment(
    definition: AgentEngineDefinition,
    env: &mut BTreeMap<String, String>,
    primary_path: String,
) {
    let Some(key) = primary_cli_environment_key(definition) else {
        return;
    };
    if !env.contains_key(key) {
        env.insert(key.into(), primary_path);
    }
    if let Some(path) = env.get(key).cloned() {
        prepend_executable_parent_to_path(env, &path);
    }
}

fn primary_cli_environment_key(definition: AgentEngineDefinition) -> Option<&'static str> {
    match definition.id {
        "claude-code" => Some("CLAUDE_CODE_EXECUTABLE"),
        "codex" => Some("CODEX_PATH"),
        _ => None,
    }
}

#[derive(Debug, Default)]
struct ManagedAcpSearchResult {
    runtime: Option<ResolvedAgentRuntime>,
    diagnostics: Vec<String>,
}

impl ManagedAcpSearchResult {
    fn with_previous_diagnostics(mut self, previous: Vec<String>) -> Self {
        let mut diagnostics = previous;
        diagnostics.extend(self.diagnostics);
        self.diagnostics = diagnostics;
        self
    }
}

#[derive(Debug, Clone)]
struct ManagedManifestLocation {
    group: String,
    tool_id: String,
    version: String,
    manifest_path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct ManagedRuntimeManifest {
    entrypoint: Option<String>,
    command: Option<String>,
    args: Option<Vec<Value>>,
    env: Option<BTreeMap<String, Value>>,
    protocol: Option<String>,
    version: Option<String>,
    #[serde(default)]
    path_entries: Vec<Value>,
    #[serde(default, rename = "pathEntries")]
    path_entries_camel: Vec<Value>,
}

#[derive(Debug, Default)]
struct ManagedAcpPrepareResult {
    diagnostics: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct InstalledManagedPackageJson {
    name: String,
    #[serde(default)]
    bin: Value,
}

fn resolve_managed_acp_runtime(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
) -> ManagedAcpSearchResult {
    if definition.acp_tool_ids.is_empty() {
        return ManagedAcpSearchResult::default();
    }

    let runtime_key = managed_runtime_key(options);
    let roots = managed_resource_roots(options, &runtime_key);
    let mut diagnostics = Vec::new();
    if roots.is_empty() {
        diagnostics.push("未找到托管 ACP 资源目录。".into());
    }

    for root in &roots {
        for tool_id in definition.acp_tool_ids {
            for location in managed_manifest_locations(root, definition.id, tool_id, &runtime_key) {
                if definition
                    .managed_package_version
                    .is_some_and(|version| location.version != version)
                {
                    continue;
                }
                match runtime_from_managed_manifest(&location, options) {
                    Ok(Some(runtime))
                        if protocol_allowed(&runtime.protocol, definition.acp_protocols) =>
                    {
                        return ManagedAcpSearchResult {
                            runtime: Some(runtime),
                            diagnostics,
                        };
                    }
                    Ok(Some(runtime)) => diagnostics.push(format!(
                        "{} ({}) 协议 {} 不在当前引擎允许列表内。",
                        location.manifest_path.display(),
                        location.tool_id,
                        runtime.protocol
                    )),
                    Ok(None) => {}
                    Err(message) => diagnostics.push(message),
                }
            }
        }
    }

    if diagnostics.is_empty() {
        diagnostics.push(format!(
            "未在 {} 下找到 {} 的托管 ACP manifest。",
            roots
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            definition.label
        ));
    }
    ManagedAcpSearchResult {
        runtime: None,
        diagnostics,
    }
}

async fn prepare_managed_acp_runtime(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
) -> ManagedAcpPrepareResult {
    if !managed_prepare_enabled(options) {
        return ManagedAcpPrepareResult {
            diagnostics: vec!["托管 ACP 自动准备未显式开启。".into()],
        };
    }
    let Some(tool_id) = definition.managed_tool_id else {
        return ManagedAcpPrepareResult::default();
    };
    let Some(package_name) = definition.managed_package else {
        return ManagedAcpPrepareResult::default();
    };
    let Some(package_version) = definition.managed_package_version else {
        return ManagedAcpPrepareResult::default();
    };
    let Some(protocol) = definition.managed_protocol else {
        return ManagedAcpPrepareResult::default();
    };

    let Some(resource_root) = local_managed_resource_root(options) else {
        return ManagedAcpPrepareResult {
            diagnostics: vec!["未找到可写托管 ACP 资源目录。".into()],
        };
    };
    let runtime_key = managed_runtime_key(options);
    let target_dir = resource_root
        .join("acp")
        .join(tool_id)
        .join(package_version)
        .join(&runtime_key);

    // A packaged Mia Core may already see the read-only ACP resources shipped
    // beside the binary. Do not download a second copy into the user's data
    // directory just because startup preparation was requested.
    if resolve_managed_acp_runtime(definition, options)
        .runtime
        .is_some()
    {
        return ManagedAcpPrepareResult::default();
    }

    let lock = MANAGED_ACP_PREPARE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    let location = ManagedManifestLocation {
        group: "acp".into(),
        tool_id: tool_id.into(),
        version: package_version.into(),
        manifest_path: target_dir.join("manifest.json"),
    };
    if matches!(
        runtime_from_managed_manifest(&location, options),
        Ok(Some(_))
    ) {
        return ManagedAcpPrepareResult::default();
    }

    let Some(npm_path) = managed_npm_path(options) else {
        return ManagedAcpPrepareResult {
            diagnostics: vec![format!(
                "准备 {} 托管 ACP 失败: npm 未检测到。",
                definition.label
            )],
        };
    };

    match prepare_managed_npm_package(
        definition,
        options,
        &npm_path,
        &resource_root,
        &target_dir,
        package_name,
        package_version,
        protocol,
    )
    .await
    {
        Ok(()) => ManagedAcpPrepareResult::default(),
        Err(message) => ManagedAcpPrepareResult {
            diagnostics: vec![format!(
                "准备 {} 托管 ACP 失败: {}",
                definition.label, message
            )],
        },
    }
}

async fn prepare_managed_npm_package(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
    npm_path: &str,
    resource_root: &Path,
    target_dir: &Path,
    package_name: &str,
    package_version: &str,
    protocol: &str,
) -> Result<(), String> {
    let staging_dir = resource_root.join(".staging").join(format!(
        "{}-{}-{}-{}",
        definition.id,
        package_version,
        std::process::id(),
        current_time_ms()
    ));
    let project_dir = staging_dir.join("project");
    let npm_cache_dir = staging_dir.join("npm-cache");
    std::fs::create_dir_all(&project_dir)
        .map_err(|error| format!("创建 staging project 失败: {error}"))?;
    std::fs::create_dir_all(&npm_cache_dir)
        .map_err(|error| format!("创建 npm cache 失败: {error}"))?;

    let result = async {
        write_managed_dev_package_json(&project_dir)?;
        let package_spec = format!("{package_name}@{package_version}");
        let optional_dependency_arg = managed_npm_optional_dependency_arg(package_name);
        let mut install_args = vec![
            "install",
            "--ignore-scripts",
            optional_dependency_arg,
            "--fund=false",
            "--audit=false",
            "--save-exact",
            "--omit=dev",
            "--os",
            platform_npm_os(),
            "--cpu",
            platform_npm_cpu(),
        ];
        let pinned_primary = managed_pinned_primary_package_spec(definition);
        if let Some(primary) = pinned_primary.as_deref() {
            install_args.push(primary);
        }
        let pinned_platform = managed_pinned_platform_package_spec(definition, options);
        if let Some(platform) = pinned_platform.as_deref() {
            install_args.push(platform);
        }
        install_args.push(package_spec.as_str());
        run_managed_npm(
            npm_path,
            options,
            &project_dir,
            &npm_cache_dir,
            &install_args,
            "安装托管 ACP 组件",
        )
        .await?;

        let entrypoint = managed_package_entrypoint(&project_dir, package_name)?;
        let entrypoint_path = project_dir.join(&entrypoint);
        if executable_path(&entrypoint_path).is_none() && !entrypoint_path.is_file() {
            return Err(format!(
                "托管 ACP entrypoint 不存在: {}",
                entrypoint_path.display()
            ));
        }

        let manifest = json!({
            "entrypoint": path_to_string(&entrypoint),
            "version": package_version,
            "protocol": protocol,
            "args": [],
            "pathEntries": ["node_modules/.bin"],
            "package": package_name
        });
        std::fs::write(
            project_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("序列化 manifest 失败: {error}"))?,
        )
        .map_err(|error| format!("写入 manifest 失败: {error}"))?;

        let manifest_location = ManagedManifestLocation {
            group: "acp".into(),
            tool_id: definition
                .managed_tool_id
                .unwrap_or(definition.id)
                .to_string(),
            version: package_version.into(),
            manifest_path: project_dir.join("manifest.json"),
        };
        runtime_from_managed_manifest(&manifest_location, options)
            .map_err(|message| format!("校验 prepared manifest 失败: {message}"))?
            .ok_or_else(|| "prepared manifest 未生成 runtime".to_string())?;

        if let Some(parent) = target_dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建托管 ACP 目录失败: {error}"))?;
        }
        if target_dir.exists() {
            std::fs::remove_dir_all(target_dir)
                .map_err(|error| format!("清理旧托管 ACP 目录失败: {error}"))?;
        }
        std::fs::rename(&project_dir, target_dir)
            .map_err(|error| format!("激活托管 ACP 目录失败: {error}"))?;

        let target_location = ManagedManifestLocation {
            group: "acp".into(),
            tool_id: definition
                .managed_tool_id
                .unwrap_or(definition.id)
                .to_string(),
            version: package_version.into(),
            manifest_path: target_dir.join("manifest.json"),
        };
        runtime_from_managed_manifest(&target_location, options)
            .map_err(|message| format!("校验托管 ACP 目录失败: {message}"))?
            .ok_or_else(|| "托管 ACP manifest 未生成 runtime".to_string())?;
        Ok(())
    }
    .await;

    if let Err(error) = std::fs::remove_dir_all(&staging_dir)
        && error.kind() != std::io::ErrorKind::NotFound
        && result.is_ok()
    {
        return Err(format!("清理 staging 目录失败: {error}"));
    }

    result
}

fn managed_prepare_enabled(options: &AgentEngineScanOptions) -> bool {
    options
        .env
        .get("MIA_MANAGED_AGENT_PREPARE")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn local_managed_resource_root(options: &AgentEngineScanOptions) -> Option<PathBuf> {
    for key in ["MIA_LOCAL_MANAGED_AGENT_RESOURCES"] {
        if let Some(value) = options.env.get(key).filter(|item| !item.trim().is_empty()) {
            return Some(PathBuf::from(value));
        }
    }
    for key in ["MIA_CORE_HOME", "MIA_HOME"] {
        if let Some(value) = options.env.get(key).filter(|item| !item.trim().is_empty()) {
            return Some(Path::new(value).join("managed-resources"));
        }
    }
    options
        .home_dir
        .as_ref()
        .map(|home| home.join(".mia").join("managed-resources"))
}

fn prune_stale_managed_acp_versions(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
) -> Result<(), String> {
    let Some(resource_root) = local_managed_resource_root(options) else {
        return Ok(());
    };
    let Some(tool_id) = definition.managed_tool_id else {
        return Ok(());
    };
    let Some(keep_version) = definition.managed_package_version else {
        return Ok(());
    };
    let tool_root = resource_root.join("acp").join(tool_id);
    let entries = match std::fs::read_dir(&tool_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "读取 {} 托管版本目录失败: {error}",
                definition.label
            ));
        }
    };
    for entry in entries.filter_map(Result::ok) {
        let is_directory = entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        if !is_directory || entry.file_name().to_string_lossy() == keep_version {
            continue;
        }
        std::fs::remove_dir_all(entry.path()).map_err(|error| {
            format!(
                "清理 {} 旧托管版本 {} 失败: {error}",
                definition.label,
                entry.path().display()
            )
        })?;
    }
    Ok(())
}

fn managed_npm_path(options: &AgentEngineScanOptions) -> Option<String> {
    options
        .env
        .get("MIA_MANAGED_AGENT_NPM")
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| executable_path(value))
        .or_else(|| resolve_command_path("npm", options))
}

fn managed_npm_optional_dependency_arg(_package_name: &str) -> &'static str {
    // Platform binaries are installed below as exact, direct dependencies. This
    // avoids pulling a second binary through an ACP adapter's older SDK pin.
    "--omit=optional"
}

fn managed_pinned_primary_package_spec(definition: AgentEngineDefinition) -> Option<String> {
    match definition.id {
        "claude-code" => Some(format!(
            "@anthropic-ai/claude-agent-sdk@{PINNED_CLAUDE_SDK_VERSION}"
        )),
        "codex" => Some(format!("@openai/codex@{PINNED_CODEX_CLI_VERSION}")),
        _ => None,
    }
}

fn managed_pinned_platform_package_spec(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
) -> Option<String> {
    let runtime_key = managed_runtime_key(options);
    if !matches!(
        runtime_key.as_str(),
        "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-arm64" | "win32-x64"
    ) {
        return None;
    }
    match definition.id {
        "claude-code" => Some(format!(
            "@anthropic-ai/claude-agent-sdk-{runtime_key}@{PINNED_CLAUDE_SDK_VERSION}"
        )),
        "codex" => Some(format!(
            "@openai/codex-{runtime_key}@npm:@openai/codex@{PINNED_CODEX_CLI_VERSION}-{runtime_key}"
        )),
        _ => None,
    }
}

fn managed_npm_cache_dir(options: &AgentEngineScanOptions, fallback: &Path) -> Option<String> {
    if let Some(value) = options
        .env
        .get("MIA_MANAGED_AGENT_NPM_CACHE")
        .filter(|value| !value.trim().is_empty())
    {
        return Some(value.trim().to_string());
    }
    if options
        .env
        .get("MIA_MANAGED_AGENT_ISOLATED_NPM_CACHE")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        return Some(path_to_string(fallback));
    }
    None
}

fn write_managed_dev_package_json(project_dir: &Path) -> Result<(), String> {
    let package_json = json!({
        "name": "mia-managed-acp-runtime",
        "private": true
    });
    std::fs::write(
        project_dir.join("package.json"),
        serde_json::to_vec_pretty(&package_json)
            .map_err(|error| format!("序列化 package.json 失败: {error}"))?,
    )
    .map_err(|error| format!("写入 package.json 失败: {error}"))
}

async fn run_managed_npm(
    npm_path: &str,
    options: &AgentEngineScanOptions,
    project_dir: &Path,
    npm_cache_dir: &Path,
    args: &[&str],
    label: &str,
) -> Result<(), String> {
    let prepare_timeout = managed_acp_prepare_timeout(options);
    let mut command = Command::new(npm_path);
    configure_background_command(command.as_std_mut());
    command
        .args(args)
        .current_dir(project_dir)
        .env_clear()
        .envs(options.env.iter())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cache_dir) = managed_npm_cache_dir(options, npm_cache_dir) {
        command.env("npm_config_cache", cache_dir);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("{label} 启动失败: {error}"))?;
    let stdout_task = child
        .stdout
        .take()
        .map(|stdout| tokio::spawn(read_child_output(stdout)));
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(read_child_output(stderr)));
    let status = tokio::select! {
        status = child.wait() => {
            status.map_err(|error| format!("{label} 等待失败: {error}"))?
        }
        _ = tokio::time::sleep(prepare_timeout) => {
            terminate_child_process_tree(&mut child).await;
            return Err(format!("{label} 超时（{}s）", prepare_timeout.as_secs()));
        }
    };
    let stdout = join_child_output(stdout_task).await;
    let stderr = join_child_output(stderr_task).await;
    if status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stderr}; stdout: {stdout}")
    };
    Err(compact_one_line(format!(
        "{label} 失败，退出码 {:?}: {detail}",
        status.code()
    )))
}

fn managed_acp_prepare_timeout(options: &AgentEngineScanOptions) -> Duration {
    options
        .env
        .get("MIA_MANAGED_RESOURCES_PREPARE_TIMEOUT_MS")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|milliseconds| *milliseconds >= 1_000)
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_MANAGED_ACP_PREPARE_TIMEOUT)
}

async fn read_child_output<R>(mut reader: R) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let _ = reader.read_to_end(&mut output).await;
    output
}

async fn join_child_output(task: Option<tokio::task::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    match task {
        Some(task) => task.await.unwrap_or_default(),
        None => Vec::new(),
    }
}

async fn terminate_child_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        terminate_process_tree(pid).await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(windows)]
async fn terminate_process_tree(pid: u32) {
    let mut command = Command::new("taskkill");
    configure_background_command(command.as_std_mut());
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), command.status()).await;
}

#[cfg(not(windows))]
async fn terminate_process_tree(_pid: u32) {}

fn managed_package_entrypoint(project_dir: &Path, package_name: &str) -> Result<PathBuf, String> {
    let package_json_path = package_json_path(project_dir, package_name);
    let contents = std::fs::read_to_string(&package_json_path)
        .map_err(|error| format!("读取 {} 失败: {error}", package_json_path.display()))?;
    let package_json = serde_json::from_str::<InstalledManagedPackageJson>(&contents)
        .map_err(|error| format!("解析 {} 失败: {error}", package_json_path.display()))?;
    let bin_entry = resolve_package_bin_entry(&package_json.name, &package_json.bin)?;
    let mut entrypoint = PathBuf::from("node_modules");
    for segment in package_path_segments(package_name) {
        entrypoint.push(segment);
    }
    entrypoint.push(bin_entry);
    Ok(entrypoint)
}

fn package_json_path(project_dir: &Path, package_name: &str) -> PathBuf {
    let mut path = project_dir.join("node_modules");
    for segment in package_path_segments(package_name) {
        path.push(segment);
    }
    path.join("package.json")
}

fn package_path_segments(package_name: &str) -> Vec<&str> {
    package_name
        .split('/')
        .filter(|item| !item.is_empty())
        .collect()
}

fn resolve_package_bin_entry(package_name: &str, bin: &Value) -> Result<PathBuf, String> {
    match bin {
        Value::String(value) if !value.trim().is_empty() => Ok(PathBuf::from(value.trim())),
        Value::Object(map) => {
            let unscoped = package_name.rsplit('/').next().unwrap_or(package_name);
            for key in [unscoped, package_name] {
                if let Some(Value::String(value)) = map.get(key)
                    && !value.trim().is_empty()
                {
                    return Ok(PathBuf::from(value.trim()));
                }
            }
            let mut entries = map
                .values()
                .filter_map(|value| match value {
                    Value::String(text) if !text.trim().is_empty() => {
                        Some(PathBuf::from(text.trim()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            entries.sort();
            entries
                .into_iter()
                .next()
                .ok_or_else(|| format!("{package_name} package.json bin 为空"))
        }
        _ => Err(format!("{package_name} package.json 缺少 bin")),
    }
}

fn platform_npm_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        env::consts::OS
    }
}

fn platform_npm_cpu() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        env::consts::ARCH
    }
}

fn managed_missing_detail(definition: AgentEngineDefinition, diagnostics: &[String]) -> String {
    let mut parts = vec![format!(
        "{} 需要托管 ACP 运行组件；未使用系统包管理器或写死包名兜底。",
        definition.label
    )];
    parts.extend(diagnostics.iter().take(3).cloned());
    compact_one_line(parts.join(" "))
}

fn managed_manifest_locations(
    root: &Path,
    engine: &str,
    tool_id: &str,
    runtime_key: &str,
) -> Vec<ManagedManifestLocation> {
    let mut locations = Vec::new();
    let engine_root = root.join("agents").join(engine);
    for version in version_dirs(&engine_root) {
        locations.push(ManagedManifestLocation {
            group: "agents".into(),
            tool_id: engine.into(),
            manifest_path: engine_root
                .join(&version)
                .join(runtime_key)
                .join("manifest.json"),
            version,
        });
    }

    for group in ["acp", "cli"] {
        let tool_root = root.join(group).join(tool_id);
        for version in version_dirs(&tool_root) {
            locations.push(ManagedManifestLocation {
                group: group.into(),
                tool_id: tool_id.into(),
                manifest_path: tool_root
                    .join(&version)
                    .join(runtime_key)
                    .join("manifest.json"),
                version,
            });
        }
    }

    let flat_root = root.join(tool_id);
    for version in version_dirs(&flat_root) {
        locations.push(ManagedManifestLocation {
            group: String::new(),
            tool_id: tool_id.into(),
            manifest_path: flat_root
                .join(&version)
                .join(runtime_key)
                .join("manifest.json"),
            version,
        });
    }

    locations
}

fn runtime_from_managed_manifest(
    location: &ManagedManifestLocation,
    options: &AgentEngineScanOptions,
) -> Result<Option<ResolvedAgentRuntime>, String> {
    if !location.manifest_path.is_file() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&location.manifest_path)
        .map_err(|error| format!("{} 读取失败: {}", location.manifest_path.display(), error))?;
    let manifest = serde_json::from_str::<ManagedRuntimeManifest>(&content)
        .map_err(|error| format!("{} JSON 无效: {}", location.manifest_path.display(), error))?;
    let base_dir = location
        .manifest_path
        .parent()
        .ok_or_else(|| format!("{} 缺少运行目录。", location.manifest_path.display()))?;
    let entrypoint = manifest
        .entrypoint
        .or(manifest.command)
        .unwrap_or_default()
        .trim()
        .to_string();
    if entrypoint.is_empty() {
        return Err(format!(
            "{} 缺少 entrypoint。",
            location.manifest_path.display()
        ));
    }
    let entrypoint_path = resolve_manifest_child_path(base_dir, &entrypoint).map_err(|reason| {
        format!(
            "{} entrypoint 无效: {}",
            location.manifest_path.display(),
            reason
        )
    })?;
    let entrypoint_is_node_script = managed_entrypoint_is_node_script(&entrypoint_path);
    if (entrypoint_is_node_script && !entrypoint_path.is_file())
        || (!entrypoint_is_node_script && executable_path(&entrypoint_path).is_none())
    {
        return Err(format!(
            "{} entrypoint 不存在或不可执行: {}",
            location.manifest_path.display(),
            entrypoint_path.display()
        ));
    }

    validate_managed_platform_binary(location, base_dir, options)?;

    let mut path_entry_values = manifest.path_entries;
    path_entry_values.extend(manifest.path_entries_camel);
    let mut args = json_values_to_strings(&manifest.args.unwrap_or_default());
    let mut env = json_object_to_string_map(manifest.env.unwrap_or_default());
    let (command_path, runtime_args) = if entrypoint_is_node_script {
        let Some(node) = managed_node_runner(options) else {
            return Err(format!(
                "{} JavaScript entrypoint requires a Node runtime: {}",
                location.manifest_path.display(),
                entrypoint_path.display()
            ));
        };
        env.extend(managed_node_environment(options));
        let mut node_args = vec![path_to_string(&entrypoint_path)];
        node_args.append(&mut args);
        (node, node_args)
    } else {
        (
            executable_path(&entrypoint_path).unwrap_or_else(|| path_to_string(&entrypoint_path)),
            args,
        )
    };
    Ok(Some(ResolvedAgentRuntime {
        command: command_path.clone(),
        path: command_path,
        args: runtime_args,
        source: "managed".into(),
        managed: true,
        version: manifest
            .version
            .unwrap_or_else(|| location.version.clone())
            .trim()
            .to_string(),
        protocol: manifest
            .protocol
            .unwrap_or_else(|| {
                if location.group.is_empty() {
                    "cli".into()
                } else {
                    location.group.clone()
                }
            })
            .trim()
            .to_string(),
        env,
        path_entries: normalize_manifest_path_entries(base_dir, &path_entry_values),
        root_dir: path_to_string(base_dir),
    }))
}

fn mia_stable_fallback_enabled(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
) -> bool {
    if let Some(raw) = options
        .env
        .get("MIA_ENGINE_FALLBACKS_JSON")
        .filter(|value| !value.trim().is_empty())
        && let Ok(value) = serde_json::from_str::<Value>(raw)
    {
        return fallback_enabled_in_value(&value, definition.id);
    }

    let explicit = options
        .env
        .get("MIA_ENGINE_FALLBACKS_PATH")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let state_path = explicit.or_else(|| {
        options
            .env
            .get("MIA_CORE_HOME")
            .or_else(|| options.env.get("MIA_HOME"))
            .filter(|value| !value.trim().is_empty())
            .map(|home| Path::new(home).join("mia-engine-fallbacks.json"))
    });
    let Some(state_path) = state_path else {
        return false;
    };
    let Ok(contents) = std::fs::read_to_string(state_path) else {
        return false;
    };
    serde_json::from_str::<Value>(&contents)
        .ok()
        .is_some_and(|value| fallback_enabled_in_value(&value, definition.id))
}

fn fallback_enabled_in_value(value: &Value, engine: &str) -> bool {
    value
        .get("engines")
        .and_then(|engines| engines.get(engine))
        .and_then(|engine| engine.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
struct MiaStableHermesRuntime {
    root: PathBuf,
    python: PathBuf,
    site_packages: PathBuf,
    version: String,
}

fn mia_stable_hermes_runtime(options: &AgentEngineScanOptions) -> Option<MiaStableHermesRuntime> {
    let root = options
        .env
        .get("MIA_BUNDLED_HERMES_RUNTIME_DIR")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)?;
    let python = if cfg!(windows) {
        root.join("python").join("python.exe")
    } else {
        root.join("python").join("bin").join("python3")
    };
    let site_packages = root.join("site-packages");
    if !python.is_file() || !site_packages.is_dir() {
        return None;
    }
    let build_info = std::fs::read_to_string(root.join("runtime-build-info.json"))
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())?;
    let version = build_info
        .get("hermesVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    Some(MiaStableHermesRuntime {
        root,
        python,
        site_packages,
        version,
    })
}

fn managed_primary_path(
    definition: AgentEngineDefinition,
    runtime: &ResolvedAgentRuntime,
    options: &AgentEngineScanOptions,
) -> Option<PathBuf> {
    let root = Path::new(&runtime.root_dir);
    let runtime_key = managed_runtime_key(options);
    if definition.id == "claude-code" {
        let mut path = root
            .join("node_modules")
            .join(format!("@anthropic-ai/claude-agent-sdk-{runtime_key}"))
            .join("claude");
        if runtime_key.starts_with("win32-") {
            path.set_extension("exe");
        }
        return path.is_file().then_some(path);
    }
    if definition.id != "codex" {
        return None;
    }
    let (package_name, triple) = codex_platform_target(&runtime_key)?;
    let binary_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let package_root = package_name
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(root.join("node_modules"), |path, part| path.join(part));
    let bundled_root = root.join("node_modules").join("@openai").join("codex");
    [package_root, bundled_root]
        .into_iter()
        .map(|root| {
            root.join("vendor")
                .join(triple)
                .join("bin")
                .join(binary_name)
        })
        .find(|path| path.is_file())
}

fn codex_platform_target(runtime_key: &str) -> Option<(&'static str, &'static str)> {
    match runtime_key {
        "darwin-arm64" => Some(("@openai/codex-darwin-arm64", "aarch64-apple-darwin")),
        "darwin-x64" => Some(("@openai/codex-darwin-x64", "x86_64-apple-darwin")),
        "linux-arm64" => Some(("@openai/codex-linux-arm64", "aarch64-unknown-linux-musl")),
        "linux-x64" => Some(("@openai/codex-linux-x64", "x86_64-unknown-linux-musl")),
        "win32-arm64" => Some(("@openai/codex-win32-arm64", "aarch64-pc-windows-msvc")),
        "win32-x64" => Some(("@openai/codex-win32-x64", "x86_64-pc-windows-msvc")),
        _ => None,
    }
}

fn managed_primary_version(
    definition: AgentEngineDefinition,
    runtime: &ResolvedAgentRuntime,
) -> String {
    let root = Path::new(&runtime.root_dir);
    let package_json = match definition.id {
        "claude-code" => root
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk")
            .join("manifest.json"),
        "codex" => root
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("package.json"),
        _ => return runtime.version.clone(),
    };
    std::fs::read_to_string(package_json)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| runtime.version.clone())
}

fn resolve_mia_stable_primary(
    definition: AgentEngineDefinition,
    options: &AgentEngineScanOptions,
) -> Option<ResolvedCommand> {
    if !mia_stable_fallback_enabled(definition, options) {
        return None;
    }
    if definition.id == "hermes" {
        let runtime = mia_stable_hermes_runtime(options)?;
        return Some(ResolvedCommand {
            command: definition.primary_command.into(),
            path: path_to_string(runtime.python),
            source: "mia-managed".into(),
            version: runtime.version,
        });
    }
    let runtime = resolve_managed_acp_runtime(definition, options).runtime?;
    let path = managed_primary_path(definition, &runtime, options)?;
    let version = managed_primary_version(definition, &runtime);
    let expected_version = match definition.id {
        "claude-code" => PINNED_CLAUDE_CLI_VERSION,
        "codex" => PINNED_CODEX_CLI_VERSION,
        _ => "",
    };
    if !expected_version.is_empty() && version != expected_version {
        return None;
    }
    Some(ResolvedCommand {
        command: definition.primary_command.into(),
        path: path_to_string(path),
        source: "mia-managed".into(),
        version,
    })
}

/// Resolves the bundled Hermes runtime as its actual Gateway transport. Older
/// manifests still store the historical `acp` entrypoint, so the legacy value
/// is normalized here and never escapes into runtime planning.
fn resolve_mia_stable_hermes_gateway_runtime(
    options: &AgentEngineScanOptions,
) -> Option<ResolvedAgentRuntime> {
    let definition = agent_definitions()
        .into_iter()
        .find(|definition| definition.id == "hermes")?;
    if !mia_stable_fallback_enabled(definition, options) {
        return None;
    }
    let runtime = mia_stable_hermes_runtime(options)?;
    let mut env = BTreeMap::new();
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let mut python_path = vec![path_to_string(&runtime.site_packages)];
    if let Some(existing) = options
        .env
        .get("PYTHONPATH")
        .filter(|value| !value.trim().is_empty())
    {
        python_path.push(existing.clone());
    }
    env.insert("PYTHONPATH".into(), python_path.join(delimiter));
    Some(as_hermes_gateway_runtime(ResolvedAgentRuntime {
        command: path_to_string(&runtime.python),
        path: path_to_string(&runtime.python),
        args: vec!["-m".into(), "hermes_cli.main".into(), "acp".into()],
        source: "managed".into(),
        managed: true,
        version: runtime.version,
        protocol: "acp".into(),
        env,
        path_entries: Vec::new(),
        root_dir: path_to_string(runtime.root),
    }))
}

fn validate_managed_platform_binary(
    location: &ManagedManifestLocation,
    base_dir: &Path,
    options: &AgentEngineScanOptions,
) -> Result<(), String> {
    if location.tool_id == "codex-acp" {
        let runtime_key = managed_runtime_key(options);
        let Some((package_name, triple)) = codex_platform_target(&runtime_key) else {
            return Ok(());
        };
        let binary_name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let platform_root = package_name
            .split('/')
            .filter(|part| !part.is_empty())
            .fold(base_dir.join("node_modules"), |path, part| path.join(part));
        let candidates = [
            platform_root
                .join("vendor")
                .join(triple)
                .join("bin")
                .join(binary_name),
            base_dir
                .join("node_modules")
                .join("@openai")
                .join("codex")
                .join("vendor")
                .join(triple)
                .join("bin")
                .join(binary_name),
        ];
        if candidates.iter().any(|path| path.is_file()) {
            return Ok(());
        }
        return Err(format!(
            "expected managed codex-acp platform binary missing: {}",
            candidates[0].display()
        ));
    }
    let Some(expected) = expected_managed_platform_binary(location, base_dir, options) else {
        return Ok(());
    };
    if expected.is_file() {
        return Ok(());
    }
    Err(format!(
        "expected managed {} platform binary missing: {}",
        location.tool_id,
        expected.display()
    ))
}

fn expected_managed_platform_binary(
    location: &ManagedManifestLocation,
    base_dir: &Path,
    options: &AgentEngineScanOptions,
) -> Option<PathBuf> {
    if location.tool_id != "claude-agent-acp" {
        return None;
    }
    let runtime_key = managed_runtime_key(options);
    let mut path = base_dir
        .join("node_modules")
        .join(format!("@anthropic-ai/claude-agent-sdk-{runtime_key}"))
        .join("claude");
    if runtime_key.starts_with("win32-") {
        path.set_extension("exe");
    }
    Some(path)
}

fn managed_entrypoint_is_node_script(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "js" | "mjs" | "cjs"
            )
        })
        .unwrap_or(false)
}

fn managed_node_runner(options: &AgentEngineScanOptions) -> Option<String> {
    options
        .env
        .get("MIA_MANAGED_AGENT_NODE")
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| executable_path(value))
        .or_else(|| resolve_command_path("node", options))
}

fn managed_node_environment(options: &AgentEngineScanOptions) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if options
        .env
        .get("MIA_MANAGED_AGENT_NODE_ELECTRON")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
    }
    env
}

fn resolve_manifest_child_path(base_dir: &Path, value: &str) -> Result<PathBuf, String> {
    let raw = Path::new(value);
    if raw
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("路径不能包含 ..".into());
    }
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        base_dir.join(raw)
    };
    if !path.starts_with(base_dir) {
        return Err("路径必须位于 manifest 运行目录内".into());
    }
    Ok(path)
}

fn normalize_manifest_path_entries(base_dir: &Path, values: &[Value]) -> Vec<String> {
    values
        .iter()
        .map(json_value_to_string)
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .map(|item| {
            let path = Path::new(&item);
            if path.is_absolute() {
                item
            } else {
                path_to_string(base_dir.join(path))
            }
        })
        .collect()
}

fn json_values_to_strings(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .map(json_value_to_string)
        .filter(|item| !item.is_empty())
        .collect()
}

fn json_object_to_string_map(values: BTreeMap<String, Value>) -> BTreeMap<String, String> {
    values
        .into_iter()
        .map(|(key, value)| (key, json_value_to_string(&value)))
        .collect()
}

fn json_value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn protocol_allowed(protocol: &str, allowed: &[&str]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let protocol = protocol.trim().to_ascii_lowercase();
    allowed
        .iter()
        .any(|item| item.trim().eq_ignore_ascii_case(&protocol))
}

fn version_dirs(root: &Path) -> Vec<String> {
    let mut values = std::fs::read_dir(root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.file_name().to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    values.sort();
    values.reverse();
    values
}

fn managed_resource_roots(options: &AgentEngineScanOptions, runtime_key: &str) -> Vec<PathBuf> {
    let mut roots = Vec::<String>::new();
    for key in [
        "MIA_LOCAL_MANAGED_AGENT_RESOURCES",
        "MIA_MANAGED_AGENT_RESOURCES",
        "MIA_BUNDLED_MANAGED_RESOURCES",
    ] {
        if let Some(value) = options.env.get(key) {
            roots.extend(env::split_paths(value).map(path_to_string));
        }
    }
    let explicit_only = options
        .env
        .get("MIA_MANAGED_AGENT_RESOURCES_ONLY")
        .map(|value| value == "1")
        .unwrap_or(false);
    if explicit_only {
        return dedupe_non_empty(roots)
            .into_iter()
            .map(PathBuf::from)
            .collect();
    }
    for key in ["MIA_CORE_HOME", "MIA_HOME"] {
        if let Some(value) = options.env.get(key).filter(|item| !item.trim().is_empty()) {
            roots.push(path_to_string(Path::new(value).join("managed-resources")));
        }
    }
    if let Some(home) = &options.home_dir {
        roots.push(path_to_string(home.join(".mia").join("managed-resources")));
    }
    for key in [
        "MIA_RESOURCES_PATH",
        "MIA_APP_RESOURCES_PATH",
        "MIA_CORE_RESOURCES_PATH",
    ] {
        if let Some(value) = options.env.get(key).filter(|item| !item.trim().is_empty()) {
            roots.push(path_to_string(Path::new(value).join("managed-resources")));
            roots.push(path_to_string(
                Path::new(value)
                    .join("bundled-mia-core")
                    .join(runtime_key)
                    .join("managed-resources"),
            ));
        }
    }
    if let Ok(current_exe) = env::current_exe() {
        for ancestor in current_exe.ancestors().take(6) {
            roots.push(path_to_string(ancestor.join("managed-resources")));
            roots.push(path_to_string(
                ancestor.join("resources").join("managed-resources"),
            ));
            roots.push(path_to_string(
                ancestor
                    .join("bundled-mia-core")
                    .join(runtime_key)
                    .join("managed-resources"),
            ));
        }
    }
    dedupe_non_empty(roots)
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

fn managed_runtime_key(options: &AgentEngineScanOptions) -> String {
    for key in ["MIA_MANAGED_AGENT_RUNTIME_KEY", "MIA_RUNTIME_KEY"] {
        if let Some(value) = options.env.get(key).filter(|item| !item.trim().is_empty()) {
            return value.trim().into();
        }
    }
    format!("{}-{}", runtime_platform(), runtime_arch())
}

fn runtime_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        env::consts::OS
    }
}

fn runtime_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        env::consts::ARCH
    }
}

fn runtime_path_entries(runtime: &ResolvedAgentRuntime) -> Vec<String> {
    let mut entries = runtime.path_entries.clone();
    if let Some(parent) = Path::new(&runtime.path).parent() {
        entries.insert(0, path_to_string(parent));
    }
    dedupe_non_empty(entries)
}

fn prepend_path_entries(env: &mut BTreeMap<String, String>, entries: Vec<String>) {
    if entries.is_empty() {
        return;
    }
    let path_key = if env.contains_key("Path") && !env.contains_key("PATH") {
        "Path"
    } else {
        "PATH"
    };
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let current = env.get(path_key).cloned().unwrap_or_default();
    let mut next = entries;
    next.extend(
        current
            .split(delimiter)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string),
    );
    env.insert(path_key.into(), dedupe_non_empty(next).join(delimiter));
}

pub(crate) fn prepend_executable_parent_to_path(
    env: &mut BTreeMap<String, String>,
    executable: &str,
) {
    if let Some(parent) = Path::new(executable).parent() {
        prepend_path_entries(env, vec![path_to_string(parent)]);
    }
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

pub(crate) fn resolve_managed_agent_runtime_plan(
    engine: &str,
    env: &BTreeMap<String, String>,
) -> Option<AgentManagedRuntimePlan> {
    let engine_id = normalize_agent_engine_id(engine);
    let definition = agent_definitions()
        .into_iter()
        .find(|definition| definition.id == engine_id)?;
    let mut base_env = env.clone();
    let initial_options = AgentEngineScanOptions {
        env: base_env.clone(),
        home_dir: current_home_dir(&base_env),
        workspace_dir: PathBuf::new(),
        generated_at: 0,
        probe_timeout: DEFAULT_AGENT_PROBE_TIMEOUT,
    };
    let prefer_managed = cached_agent_runtime_source(definition.id) == "mia-managed";
    if definition.id == "hermes" {
        if !prefer_managed && resolve_agent_command_path(definition.primary_command, env).is_some()
        {
            return None;
        }
        let runtime = resolve_mia_stable_hermes_gateway_runtime(&initial_options)?;
        let mut environment = base_env;
        environment.extend(runtime.env.clone());
        return Some(AgentManagedRuntimePlan {
            command: RuntimeCommand {
                program: runtime.path,
                args: runtime.args,
            },
            environment,
        });
    }
    if !definition.require_managed_acp {
        return None;
    }
    let system_primary = || {
        resolve_agent_command_path(definition.primary_command, env).map(|path| ResolvedCommand {
            command: definition.primary_command.into(),
            path,
            source: "system".into(),
            version: String::new(),
        })
    };
    let primary = if prefer_managed {
        resolve_mia_stable_primary(definition, &initial_options).or_else(system_primary)
    } else {
        system_primary().or_else(|| resolve_mia_stable_primary(definition, &initial_options))
    }?;
    apply_primary_cli_environment(definition, &mut base_env, primary.path);
    let options = AgentEngineScanOptions {
        env: base_env.clone(),
        home_dir: current_home_dir(&base_env),
        workspace_dir: PathBuf::new(),
        generated_at: 0,
        probe_timeout: DEFAULT_AGENT_PROBE_TIMEOUT,
    };
    let runtime = resolve_managed_acp_runtime(definition, &options).runtime?;
    let mut environment = base_env;
    environment.extend(runtime.env.clone());
    prepend_path_entries(&mut environment, runtime_path_entries(&runtime));
    Some(AgentManagedRuntimePlan {
        command: RuntimeCommand {
            program: runtime.path,
            args: runtime.args,
        },
        environment,
    })
}

fn normalize_agent_engine_id(value: &str) -> String {
    let id = value.trim().to_ascii_lowercase().replace('_', "-");
    match id.as_str() {
        "anthropic" | "claude" | "claude-code-agent" => "claude-code".into(),
        "openai-codex" | "codex-cli" => "codex".into(),
        "hermes-cli" => "hermes".into(),
        _ => id,
    }
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
    dirs.push(path_to_string(home.join(".nvm/current/bin")));
    dirs.extend(nvm_version_bin_segments(home));
    if let Some(value) = env.get("BUN_INSTALL") {
        dirs.push(path_to_string(Path::new(value).join("bin")));
    }
    if cfg!(windows) {
        let app_data = env
            .get("APPDATA")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        let local_app_data = env
            .get("LOCALAPPDATA")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        let hermes_home = env
            .get("HERMES_HOME")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let codex_home = env
            .get("CODEX_HOME")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        if let Some(root) = hermes_home {
            dirs.push(path_to_string(
                root.join("hermes-agent").join("venv").join("Scripts"),
            ));
        }
        dirs.extend(
            [
                local_app_data
                    .join("hermes")
                    .join("hermes-agent")
                    .join("venv")
                    .join("Scripts"),
                app_data.join("npm"),
                home.join(".claude").join("local"),
                home.join(".claude").join("local").join("bin"),
                home.join(".claude").join("bin"),
                local_app_data.join("Programs").join("Claude").join("bin"),
                local_app_data
                    .join("Programs")
                    .join("Claude Code")
                    .join("bin"),
                local_app_data
                    .join("Programs")
                    .join("OpenAI")
                    .join("Codex")
                    .join("bin"),
                codex_home
                    .join("packages")
                    .join("standalone")
                    .join("current")
                    .join("bin"),
                codex_home
                    .join("packages")
                    .join("standalone")
                    .join("current"),
                home.join("scoop").join("shims"),
            ]
            .into_iter()
            .map(path_to_string),
        );
        for version in ["Python314", "Python313", "Python312", "Python311"] {
            dirs.push(path_to_string(
                app_data.join("Python").join(version).join("Scripts"),
            ));
        }
    }
    dirs.push(path_to_string(home.join(".volta/bin")));
    dirs.push(path_to_string(home.join(".asdf/shims")));
    dirs.push(path_to_string(home.join(".local/share/mise/shims")));
    dirs.push(path_to_string(home.join(".local/share/rtx/shims")));
    dirs
}

fn nvm_version_bin_segments(home: &Path) -> Vec<String> {
    let versions_dir = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return Vec::new();
    };
    let mut bins = entries
        .flatten()
        .map(|entry| entry.path().join("bin"))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    bins.sort_by(|left, right| right.cmp(left));
    bins.into_iter().map(path_to_string).collect()
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
            source: "system".into(),
            version: String::new(),
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
struct FakeAgentRuntimeCommandProber {
    probes: HashMap<String, AgentRuntimeProbeOutcome>,
}

#[cfg(test)]
#[async_trait]
impl AgentRuntimeCommandProber for FakeAgentRuntimeCommandProber {
    async fn probe(&self, request: AgentRuntimeProbeRequest) -> AgentRuntimeProbeOutcome {
        self.probes
            .get(&request.engine_id)
            .cloned()
            .unwrap_or(AgentRuntimeProbeOutcome::Ready {
                detail: Some(format!("{} ok", request.display)),
                latency_ms: 1,
                controls: Vec::new(),
            })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn managed_fallback_pins_primary_engine_packages() {
        let definitions = agent_definitions();
        let claude = definitions
            .iter()
            .copied()
            .find(|definition| definition.id == "claude-code")
            .expect("claude definition");
        let codex = definitions
            .iter()
            .copied()
            .find(|definition| definition.id == "codex")
            .expect("codex definition");

        assert_eq!(claude.managed_package_version, Some("0.59.0"));
        assert_eq!(codex.managed_package_version, Some("1.1.4"));
        assert_eq!(
            managed_pinned_primary_package_spec(claude).as_deref(),
            Some("@anthropic-ai/claude-agent-sdk@0.3.211")
        );
        assert_eq!(
            managed_pinned_primary_package_spec(codex).as_deref(),
            Some("@openai/codex@0.144.5")
        );
        let mut options = AgentEngineScanOptions::for_tests();
        options
            .env
            .insert("MIA_MANAGED_AGENT_RUNTIME_KEY".into(), "win32-x64".into());
        assert_eq!(
            managed_pinned_platform_package_spec(claude, &options).as_deref(),
            Some("@anthropic-ai/claude-agent-sdk-win32-x64@0.3.211")
        );
        assert_eq!(
            managed_pinned_platform_package_spec(codex, &options).as_deref(),
            Some("@openai/codex-win32-x64@npm:@openai/codex@0.144.5-win32-x64")
        );
    }

    #[test]
    fn managed_resource_prepare_timeout_is_configurable_for_large_platform_packages() {
        let mut options = AgentEngineScanOptions::for_tests();
        assert_eq!(
            managed_acp_prepare_timeout(&options),
            DEFAULT_MANAGED_ACP_PREPARE_TIMEOUT
        );

        options.env.insert(
            "MIA_MANAGED_RESOURCES_PREPARE_TIMEOUT_MS".into(),
            "2400000".into(),
        );
        assert_eq!(
            managed_acp_prepare_timeout(&options),
            Duration::from_secs(2_400)
        );
    }

    #[test]
    fn managed_resource_prepare_prunes_stale_versions_only() {
        let root = managed_fixture_root("prune-stale-managed-versions");
        let tool_root = root.join("acp").join("claude-agent-acp");
        std::fs::create_dir_all(tool_root.join("0.39.0").join("win32-x64")).unwrap();
        std::fs::create_dir_all(tool_root.join("0.59.0").join("win32-x64")).unwrap();
        let mut options = AgentEngineScanOptions::for_tests();
        options.env.insert(
            "MIA_LOCAL_MANAGED_AGENT_RESOURCES".into(),
            path_to_string(&root),
        );
        let claude = agent_definitions()
            .into_iter()
            .find(|definition| definition.id == "claude-code")
            .expect("claude definition");

        prune_stale_managed_acp_versions(claude, &options).expect("prune stale versions");

        assert!(!tool_root.join("0.39.0").exists());
        assert!(tool_root.join("0.59.0").join("win32-x64").is_dir());
    }

    #[derive(Debug)]
    struct RecordingAgentRuntimeCommandProber {
        requests: Arc<Mutex<Vec<AgentRuntimeProbeRequest>>>,
    }

    #[async_trait]
    impl AgentRuntimeCommandProber for RecordingAgentRuntimeCommandProber {
        async fn probe(&self, request: AgentRuntimeProbeRequest) -> AgentRuntimeProbeOutcome {
            self.requests.lock().unwrap().push(request);
            AgentRuntimeProbeOutcome::Ready {
                detail: Some("ok".into()),
                latency_ms: 1,
                controls: Vec::new(),
            }
        }
    }

    #[derive(Debug)]
    struct SystemFailsStableReadyProber {
        requests: Arc<Mutex<Vec<AgentRuntimeProbeRequest>>>,
        system_path: String,
    }

    #[async_trait]
    impl AgentRuntimeCommandProber for SystemFailsStableReadyProber {
        async fn probe(&self, request: AgentRuntimeProbeRequest) -> AgentRuntimeProbeOutcome {
            let uses_system = request
                .env
                .get("CLAUDE_CODE_EXECUTABLE")
                .is_some_and(|path| path == &self.system_path);
            self.requests.lock().unwrap().push(request);
            if uses_system {
                AgentRuntimeProbeOutcome::failed("acp_init_failed", "system cli failed")
            } else {
                AgentRuntimeProbeOutcome::Ready {
                    detail: Some("stable fallback ok".into()),
                    latency_ms: 1,
                    controls: Vec::new(),
                }
            }
        }
    }

    fn managed_fixture_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "mia-agent-engine-{name}-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn managed_test_options(root: &Path) -> AgentEngineScanOptions {
        let mut options = AgentEngineScanOptions::for_tests();
        options
            .env
            .insert("MIA_MANAGED_AGENT_RESOURCES".into(), path_to_string(root));
        options
            .env
            .insert("MIA_MANAGED_AGENT_RESOURCES_ONLY".into(), "1".into());
        options.env.insert(
            "MIA_MANAGED_AGENT_RUNTIME_KEY".into(),
            "test-runtime".into(),
        );
        options
            .env
            .insert("MIA_MANAGED_AGENT_PREPARE".into(), "0".into());
        options
    }

    #[test]
    fn managed_acp_prepare_requires_explicit_opt_in() {
        let mut options = AgentEngineScanOptions::for_tests();
        assert!(!managed_prepare_enabled(&options));

        options
            .env
            .insert("MIA_MANAGED_AGENT_PREPARE".into(), "0".into());
        assert!(!managed_prepare_enabled(&options));

        options
            .env
            .insert("MIA_MANAGED_AGENT_PREPARE".into(), "1".into());
        assert!(managed_prepare_enabled(&options));
    }

    #[test]
    fn managed_acp_prepare_omits_transitive_optional_platform_packages() {
        assert_eq!(
            managed_npm_optional_dependency_arg("@agentclientprotocol/codex-acp"),
            "--omit=optional"
        );
        assert_eq!(
            managed_npm_optional_dependency_arg("@agentclientprotocol/claude-agent-acp"),
            "--omit=optional"
        );
    }

    #[test]
    fn managed_acp_prepare_reuses_user_npm_cache_by_default() {
        let mut options = AgentEngineScanOptions::for_tests();
        let fallback = Path::new("/tmp/mia-npm-cache");
        assert_eq!(managed_npm_cache_dir(&options, fallback), None);

        options.env.insert(
            "MIA_MANAGED_AGENT_NPM_CACHE".into(),
            "/tmp/shared-cache".into(),
        );
        assert_eq!(
            managed_npm_cache_dir(&options, fallback).as_deref(),
            Some("/tmp/shared-cache")
        );

        options.env.remove("MIA_MANAGED_AGENT_NPM_CACHE");
        options
            .env
            .insert("MIA_MANAGED_AGENT_ISOLATED_NPM_CACHE".into(), "1".into());
        let expected = path_to_string(fallback);
        assert_eq!(
            managed_npm_cache_dir(&options, fallback).as_deref(),
            Some(expected.as_str())
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_default_user_path_segments_include_known_engine_install_dirs() {
        let home = PathBuf::from(r"C:\Users\mia");
        let mut env = BTreeMap::new();
        env.insert("LOCALAPPDATA".into(), r"C:\Users\mia\AppData\Local".into());
        env.insert("APPDATA".into(), r"C:\Users\mia\AppData\Roaming".into());
        env.insert("CODEX_HOME".into(), r"C:\Users\mia\.codex".into());
        env.insert(
            "HERMES_HOME".into(),
            r"C:\Users\mia\AppData\Local\hermes".into(),
        );

        let dirs = default_user_path_segments(&home, &env);

        assert!(
            dirs.iter()
                .any(|item| item.ends_with(r"AppData\Local\hermes\hermes-agent\venv\Scripts"))
        );
        assert!(
            dirs.iter()
                .any(|item| item.ends_with(r"AppData\Roaming\npm"))
        );
        assert!(
            dirs.iter()
                .any(|item| item.ends_with(r"AppData\Local\Programs\Claude Code\bin"))
        );
        assert!(
            dirs.iter()
                .any(|item| item.ends_with(r".codex\packages\standalone\current\bin"))
        );
    }

    #[test]
    fn resolves_cli_from_nvm_version_bin_without_shell_path() {
        let root = managed_fixture_root("nvm-version-bin");
        let home = root.join("home");
        let older_bin = home
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v22.22.0")
            .join("bin");
        let newer_bin = home
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v24.15.0")
            .join("bin");
        let command_name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let older_codex = older_bin.join(command_name);
        let newer_codex = newer_bin.join(command_name);
        write_test_executable(&older_codex);
        write_test_executable(&newer_codex);

        let env = BTreeMap::from([
            ("HOME".into(), path_to_string(&home)),
            (
                "PATH".into(),
                if cfg!(windows) {
                    r"C:\Windows\System32".into()
                } else {
                    "/usr/bin:/bin".into()
                },
            ),
        ]);

        assert_eq!(
            resolve_agent_command_path("codex", &env).as_deref(),
            Some(newer_codex.to_string_lossy().as_ref())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn primary_cli_environment_selects_the_resolved_claude_binary() {
        let claude = agent_definitions()
            .into_iter()
            .find(|definition| definition.id == "claude-code")
            .unwrap();
        let mut env = BTreeMap::new();

        apply_primary_cli_environment(claude, &mut env, "/usr/local/bin/claude".into());

        assert_eq!(
            env.get("CLAUDE_CODE_EXECUTABLE").map(String::as_str),
            Some("/usr/local/bin/claude")
        );
    }

    fn write_codex_managed_acp(root: &Path) -> PathBuf {
        write_codex_managed_acp_version(root, "1.1.4")
    }

    fn write_codex_managed_acp_version(root: &Path, version: &str) -> PathBuf {
        let runtime_dir = root
            .join("acp")
            .join("codex-acp")
            .join(version)
            .join("test-runtime");
        std::fs::create_dir_all(runtime_dir.join("bin")).unwrap();
        let entrypoint = runtime_dir.join("codex-acp");
        std::fs::write(&entrypoint, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&entrypoint, permissions).unwrap();
        }
        let manifest = serde_json::json!({
            "entrypoint": "codex-acp",
            "version": version,
            "protocol": "codex-app-server",
            "args": ["--stdio"],
            "env": { "MIA_MANAGED_FIXTURE": "1" },
            "pathEntries": ["bin"]
        });
        std::fs::write(
            runtime_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        entrypoint
    }

    fn write_test_executable(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    fn write_claude_managed_acp(root: &Path, with_platform_binary: bool) -> PathBuf {
        let runtime_dir = root
            .join("acp")
            .join("claude-agent-acp")
            .join("0.59.0")
            .join("test-runtime");
        let entrypoint = runtime_dir
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
        std::fs::write(&entrypoint, "process.exit(0)\n").unwrap();
        if with_platform_binary {
            let binary = runtime_dir
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-agent-sdk-test-runtime")
                .join("claude");
            write_test_executable(&binary);
            let sdk_manifest = runtime_dir
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-agent-sdk")
                .join("manifest.json");
            std::fs::create_dir_all(sdk_manifest.parent().unwrap()).unwrap();
            std::fs::write(
                sdk_manifest,
                serde_json::to_vec_pretty(&json!({ "version": PINNED_CLAUDE_CLI_VERSION }))
                    .unwrap(),
            )
            .unwrap();
        }
        let manifest = serde_json::json!({
            "entrypoint": "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
            "version": "0.59.0",
            "protocol": "claude-code-cli",
            "args": [],
            "pathEntries": ["node_modules/.bin"]
        });
        std::fs::write(
            runtime_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        entrypoint
    }

    #[test]
    fn managed_claude_acp_requires_packaged_platform_binary() {
        let root = managed_fixture_root("claude-missing-platform-binary");
        write_claude_managed_acp(&root, false);
        let claude = agent_definitions()
            .into_iter()
            .find(|definition| definition.id == "claude-code")
            .unwrap();

        let result = resolve_managed_acp_runtime(claude, &managed_test_options(&root));

        assert!(result.runtime.is_none());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item
                    .contains("expected managed claude-agent-acp platform binary missing")),
            "{:?}",
            result.diagnostics
        );
    }

    #[tokio::test]
    async fn missing_system_claude_uses_enabled_mia_stable_cli() {
        let root = managed_fixture_root("claude-stable-fallback");
        write_claude_managed_acp(&root, true);
        let node = root
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        write_test_executable(&node);
        let mut options = managed_test_options(&root);
        options.env.insert(
            "MIA_ENGINE_FALLBACKS_JSON".into(),
            r#"{"engines":{"claude-code":{"enabled":true}}}"#.into(),
        );
        options
            .env
            .insert("MIA_MANAGED_AGENT_NODE".into(), path_to_string(&node));
        let definition = agent_definitions()
            .into_iter()
            .find(|definition| definition.id == "claude-code")
            .unwrap();
        let managed = resolve_managed_acp_runtime(definition, &options);
        assert!(managed.runtime.is_some(), "{:?}", managed.diagnostics);
        assert!(
            resolve_mia_stable_primary(definition, &options).is_some(),
            "enabled fallback did not resolve a primary CLI"
        );
        let scanner = AgentEngineScanner::fake_for_tests([], []);

        let inventory = scanner.scan(options).await;
        let claude = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "claude-code")
            .expect("claude status");

        assert!(claude.installed);
        assert!(claude.usable_in_mia);
        assert_eq!(claude.source, "mia-managed");
        assert!(!claude.system.available);
        assert!(claude.path.ends_with("claude"));
        assert!(claude.runtime.managed);
    }

    #[tokio::test]
    async fn broken_system_claude_retries_with_enabled_mia_stable_cli() {
        let root = managed_fixture_root("claude-broken-system-fallback");
        write_claude_managed_acp(&root, true);
        let node = root
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        write_test_executable(&node);
        let mut options = managed_test_options(&root);
        options.env.insert(
            "MIA_ENGINE_FALLBACKS_JSON".into(),
            r#"{"engines":{"claude-code":{"enabled":true}}}"#.into(),
        );
        options
            .env
            .insert("MIA_MANAGED_AGENT_NODE".into(), path_to_string(&node));
        let system_path = "/usr/local/bin/claude".to_string();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let scanner = AgentEngineScanner {
            resolver: Arc::new(FakeAgentCommandResolver {
                commands: [("claude".into(), system_path.clone())]
                    .into_iter()
                    .collect(),
            }),
            prober: Arc::new(SystemFailsStableReadyProber {
                requests: requests.clone(),
                system_path,
            }),
        };
        let runtime_env = options.env.clone();

        let inventory = scanner.scan(options).await;
        let claude = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "claude-code")
            .expect("claude status");

        assert!(claude.usable_in_mia);
        assert_eq!(claude.source, "mia-managed");
        assert!(!claude.system.available);
        assert_eq!(requests.lock().unwrap().len(), 2);
        let plan = resolve_managed_agent_runtime_plan("claude-code", &runtime_env)
            .expect("managed turn plan");
        assert_ne!(
            plan.environment
                .get("CLAUDE_CODE_EXECUTABLE")
                .map(String::as_str),
            Some("/usr/local/bin/claude")
        );
    }

    #[tokio::test]
    async fn missing_system_hermes_uses_enabled_bundled_python_runtime() {
        let root = managed_fixture_root("hermes-stable-fallback");
        let python = root.join("python").join(if cfg!(windows) {
            "python.exe"
        } else {
            "bin/python3"
        });
        write_test_executable(&python);
        std::fs::create_dir_all(root.join("site-packages")).unwrap();
        std::fs::write(
            root.join("runtime-build-info.json"),
            serde_json::to_vec_pretty(&json!({ "hermesVersion": "2026.7.7.2" })).unwrap(),
        )
        .unwrap();
        let mut options = AgentEngineScanOptions::for_tests();
        options.env.insert(
            "MIA_ENGINE_FALLBACKS_JSON".into(),
            r#"{"engines":{"hermes":{"enabled":true}}}"#.into(),
        );
        options.env.insert(
            "MIA_BUNDLED_HERMES_RUNTIME_DIR".into(),
            path_to_string(&root),
        );
        let scanner = AgentEngineScanner::fake_for_tests([], []);

        let inventory = scanner.scan(options).await;
        let hermes = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "hermes")
            .expect("hermes status");

        assert!(hermes.installed);
        assert!(hermes.usable_in_mia);
        assert_eq!(hermes.source, "mia-managed");
        assert_eq!(hermes.version, "2026.7.7.2");
        assert_eq!(hermes.path, path_to_string(&python));
        assert_eq!(
            hermes.runtime.args,
            [
                "-m",
                "hermes_cli.main",
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0"
            ]
        );
        assert_eq!(hermes.runtime.protocol, "tui-gateway");
        assert!(hermes.runtime.managed);
    }

    #[test]
    fn managed_js_entrypoint_runs_through_node_runner() {
        let root = managed_fixture_root("codex-js-entrypoint");
        let runtime_dir = root
            .join("acp")
            .join("codex-acp")
            .join("1.1.4")
            .join("test-runtime");
        let entrypoint = runtime_dir
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("codex-acp")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
        std::fs::write(&entrypoint, "process.exit(0)\n").unwrap();
        let manifest = serde_json::json!({
            "entrypoint": "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
            "version": "1.1.4",
            "protocol": "codex-app-server",
            "args": ["--stdio"],
            "env": { "MIA_MANAGED_FIXTURE": "1" },
            "pathEntries": ["node_modules/.bin"]
        });
        std::fs::write(
            runtime_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let node = root
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        write_test_executable(&node);

        let mut options = managed_test_options(&root);
        options
            .env
            .insert("MIA_MANAGED_AGENT_NODE".into(), path_to_string(&node));
        options
            .env
            .insert("MIA_MANAGED_AGENT_NODE_ELECTRON".into(), "1".into());
        let codex = agent_definitions()
            .into_iter()
            .find(|definition| definition.id == "codex")
            .unwrap();
        let runtime = resolve_managed_acp_runtime(codex, &options)
            .runtime
            .expect("managed runtime");

        assert_eq!(runtime.command, path_to_string(&node));
        assert_eq!(runtime.path, path_to_string(&node));
        assert_eq!(Path::new(&runtime.args[0]), entrypoint.as_path());
        assert_eq!(runtime.args[1], "--stdio");
        assert_eq!(
            runtime.env.get("MIA_MANAGED_FIXTURE").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            runtime.env.get("ELECTRON_RUN_AS_NODE").map(String::as_str),
            Some("1")
        );
    }

    #[tokio::test]
    async fn codex_primary_cli_with_failed_probe_offers_mia_stable_fallback() {
        let root = managed_fixture_root("codex-warning");
        let entrypoint = write_codex_managed_acp(&root);
        let scanner = AgentEngineScanner::fake_for_tests(
            [("codex", "/usr/local/bin/codex")],
            [(
                "codex",
                AgentRuntimeProbeOutcome::failed("acp_init_failed", "boom"),
            )],
        );

        let inventory = scanner.scan(managed_test_options(&root)).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(codex.installed);
        assert!(!codex.usable_in_mia);
        assert_eq!(codex.health, "broken");
        assert_eq!(codex.install_action, "install-codex");
        assert!(codex.runtime.managed);
        assert_eq!(codex.runtime.command, path_to_string(entrypoint));
        assert_eq!(codex.readiness.status, "repairable");
        assert_eq!(codex.readiness.summary, "Codex 本机版本自检失败");
        assert_eq!(
            codex.readiness.error_code.as_deref(),
            Some("acp_init_failed")
        );
    }

    #[test]
    fn current_scan_options_allow_complete_acp_handshake() {
        let options = AgentEngineScanOptions::current("/tmp/mia-agent-probe");

        assert_eq!(options.probe_timeout, Duration::from_secs(35));
    }

    #[tokio::test]
    async fn hermes_primary_cli_with_failed_probe_offers_mia_stable_fallback() {
        let scanner = AgentEngineScanner::fake_for_tests(
            [("hermes", "/usr/local/bin/hermes")],
            [(
                "hermes",
                AgentRuntimeProbeOutcome::failed("acp_session_failed", "model must be non-empty"),
            )],
        );

        let inventory = scanner.scan(AgentEngineScanOptions::for_tests()).await;
        let hermes = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "hermes")
            .expect("hermes status");

        assert!(hermes.installed);
        assert!(!hermes.usable_in_mia);
        assert_eq!(hermes.health, "broken");
        assert_eq!(hermes.install_action, "install-hermes");
        assert_eq!(hermes.readiness.status, "repairable");
        assert_eq!(hermes.readiness.summary, "Hermes 本机版本自检失败");
        assert_eq!(hermes.readiness.action, "install-hermes");
        assert_eq!(
            hermes.readiness.error_code.as_deref(),
            Some("acp_session_failed")
        );
    }

    #[tokio::test]
    async fn codex_acp_probe_uses_managed_acp_runtime_and_resolved_system_codex_cli() {
        let root = managed_fixture_root("codex-probe");
        let entrypoint = write_codex_managed_acp(&root);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let scanner = AgentEngineScanner {
            resolver: Arc::new(FakeAgentCommandResolver {
                commands: [("codex".to_string(), "/opt/homebrew/bin/codex".to_string())]
                    .into_iter()
                    .collect(),
            }),
            prober: Arc::new(RecordingAgentRuntimeCommandProber {
                requests: requests.clone(),
            }),
        };

        scanner.scan(managed_test_options(&root)).await;
        let requests = requests.lock().unwrap();
        let request = requests
            .iter()
            .find(|request| request.engine_id == "codex")
            .expect("codex probe request");

        assert_eq!(
            request.env.get("CODEX_PATH").map(String::as_str),
            Some("/opt/homebrew/bin/codex")
        );
        assert_eq!(request.command.program, path_to_string(&entrypoint));
        assert_eq!(request.command.args, vec!["--stdio".to_string()]);
        assert_eq!(
            request.env.get("MIA_MANAGED_FIXTURE").map(String::as_str),
            Some("1")
        );
        let path_env = request.env.get("PATH").cloned().unwrap_or_default();
        assert!(
            env::split_paths(&path_env)
                .any(|entry| entry.ends_with(Path::new("test-runtime").join("bin")))
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
        let root = managed_fixture_root("codex-ready");
        let entrypoint = write_codex_managed_acp(&root);
        let scanner = AgentEngineScanner::fake_for_tests([("codex", "/usr/local/bin/codex")], []);

        let inventory = scanner.scan(managed_test_options(&root)).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(codex.installed);
        assert!(codex.usable_in_mia);
        assert_eq!(codex.health, "ready");
        assert_eq!(codex.install_action, "");
        assert!(codex.runtime.managed);
        assert_eq!(codex.runtime.source, "managed");
        assert_eq!(codex.runtime.protocol, "codex-app-server");
        assert_eq!(codex.runtime.command, path_to_string(entrypoint));
        assert_eq!(codex.runtime.args, vec!["--stdio".to_string()]);
    }

    #[tokio::test]
    async fn codex_with_primary_cli_but_no_managed_acp_is_blocked_without_npx_fallback() {
        let root = managed_fixture_root("codex-missing-managed");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let scanner = AgentEngineScanner {
            resolver: Arc::new(FakeAgentCommandResolver {
                commands: [
                    ("codex".to_string(), "/usr/local/bin/codex".to_string()),
                    ("npx".to_string(), "/usr/local/bin/npx".to_string()),
                ]
                .into_iter()
                .collect(),
            }),
            prober: Arc::new(RecordingAgentRuntimeCommandProber {
                requests: requests.clone(),
            }),
        };

        let inventory = scanner.scan(managed_test_options(&root)).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(codex.installed);
        assert!(!codex.usable_in_mia);
        assert_eq!(codex.health, "blocked");
        assert_eq!(codex.install_action, "");
        assert_eq!(codex.runtime.source, "missing");
        assert_eq!(codex.runtime.command, "");
        assert_eq!(codex.runtime.args, Vec::<String>::new());
        assert_eq!(
            codex.readiness.error_code.as_deref(),
            Some("managed_acp_missing")
        );
        assert!(codex.readiness.detail.contains("未使用系统包管理器"));
        assert!(
            requests
                .lock()
                .unwrap()
                .iter()
                .all(|request| request.engine_id != "codex")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_missing_managed_acp_is_prepared_from_pinned_package() {
        use std::os::unix::fs::PermissionsExt;

        let root = managed_fixture_root("codex-prepare-managed");
        write_codex_managed_acp_version(&root, "0.16.0");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let npm = bin_dir.join("npm");
        std::fs::write(
            &npm,
            r#"#!/bin/sh
set -eu
mkdir -p node_modules/@agentclientprotocol/codex-acp/dist
cat > node_modules/@agentclientprotocol/codex-acp/package.json <<'JSON'
{"name":"@agentclientprotocol/codex-acp","bin":{"codex-acp":"dist/index.js"}}
JSON
cat > node_modules/@agentclientprotocol/codex-acp/dist/index.js <<'JS'
#!/usr/bin/env node
process.exit(0)
JS
chmod +x node_modules/@agentclientprotocol/codex-acp/dist/index.js
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o755)).unwrap();
        let node = bin_dir.join("node");
        write_test_executable(&node);

        let mut options = AgentEngineScanOptions::for_tests();
        options.env.insert(
            "MIA_LOCAL_MANAGED_AGENT_RESOURCES".into(),
            path_to_string(&root),
        );
        options
            .env
            .insert("MIA_MANAGED_AGENT_RESOURCES_ONLY".into(), "1".into());
        options.env.insert(
            "MIA_MANAGED_AGENT_RUNTIME_KEY".into(),
            "test-runtime".into(),
        );
        options
            .env
            .insert("MIA_MANAGED_AGENT_NPM".into(), path_to_string(&npm));
        options
            .env
            .insert("MIA_MANAGED_AGENT_NODE".into(), path_to_string(&node));
        options
            .env
            .insert("MIA_MANAGED_AGENT_PREPARE".into(), "1".into());
        let scanner = AgentEngineScanner::fake_for_tests([("codex", "/usr/local/bin/codex")], []);

        let inventory = scanner.scan(options).await;
        let codex = inventory
            .agents
            .iter()
            .find(|agent| agent.id == "codex")
            .expect("codex status");

        assert!(codex.installed);
        assert!(codex.usable_in_mia);
        assert_eq!(codex.health, "ready");
        assert!(codex.runtime.managed);
        assert_eq!(codex.runtime.version, "1.1.4");
        assert_eq!(codex.runtime.protocol, "codex-app-server");
        assert_eq!(codex.runtime.command, path_to_string(&node));
        assert!(
            codex
                .runtime
                .args
                .first()
                .unwrap_or(&String::new())
                .contains("node_modules/@agentclientprotocol/codex-acp/dist/index.js")
        );
        assert!(!codex.runtime.command.contains("npx"));
    }
}
