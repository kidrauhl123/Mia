use std::path::PathBuf;
use std::sync::Arc;

use crate::cloud_bridge::AppCloudBridgeRunner;
use crate::config::AppConfig;
use crate::runtime::RuntimeRegistry;
use mia_core_bot::BotService;
use mia_core_cloud::{CloudBridgeManager, CloudEventsManager, CloudService};
use mia_core_conversation::{ConversationService, CurrentSkillService};
use mia_core_db::{
    Database, SqliteProviderRepository, SqliteSettingsRepository, init_database,
    init_database_memory,
};
use mia_core_mcp::McpService;
use mia_core_memory::MemoryService;
use mia_core_realtime::EventBus;
use mia_core_system::{AgentPermissionService, SystemService};
use mia_core_tasks::TaskService;

#[derive(Debug, Clone)]
pub struct AppServices {
    pub data_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub app_version: String,
    pub parent_pid: Option<u32>,
    pub database: Database,
    pub system: SystemService,
    pub agent_permissions: AgentPermissionService,
    pub bot: BotService,
    pub conversation: ConversationService,
    pub current_skills: CurrentSkillService,
    pub memory: MemoryService,
    pub tasks: TaskService,
    pub mcp: McpService,
    pub cloud: CloudService,
    pub cloud_bridge: CloudBridgeManager,
    pub cloud_events: CloudEventsManager,
    pub realtime: EventBus,
    pub runtime: RuntimeRegistry,
}

impl AppServices {
    pub async fn from_config(config: &AppConfig) -> anyhow::Result<Self> {
        let database = init_database(&config.database_path()).await?;
        Ok(Self::from_database(config, database))
    }

    pub async fn from_config_memory(config: &AppConfig) -> anyhow::Result<Self> {
        let database = init_database_memory().await?;
        Ok(Self::from_database(config, database))
    }

    pub fn from_database(config: &AppConfig, database: Database) -> Self {
        let settings = SqliteSettingsRepository::new(database.pool().clone());
        let providers = SqliteProviderRepository::new(database.pool().clone());
        let system = SystemService::new(config.app_version.clone(), settings, providers);
        let agent_permissions =
            AgentPermissionService::new(SqliteSettingsRepository::new(database.pool().clone()));
        let bot = BotService::new(database.pool().clone());
        let conversation = ConversationService::new(database.pool().clone());
        let current_skills = CurrentSkillService::new(config.data_dir.clone());
        let memory = MemoryService::new(database.pool().clone());
        let tasks = TaskService::new(database.pool().clone());
        let mcp = McpService::new(database.pool().clone());
        let cloud = CloudService::new(database.pool().clone());
        let realtime = EventBus::default();
        let runtime = RuntimeRegistry::default();
        let cloud_bridge_runner = Arc::new(AppCloudBridgeRunner::new(
            cloud.clone(),
            conversation.clone(),
            realtime.clone(),
            runtime.clone(),
        ));
        let cloud_bridge = CloudBridgeManager::new(cloud.clone(), cloud_bridge_runner.clone());
        let cloud_events_realtime = realtime.clone();
        let cloud_events = CloudEventsManager::new_with_desktop_runner(
            cloud.clone(),
            Arc::new(move |name, data| {
                cloud_events_realtime.emit(name, data);
            }),
            cloud_bridge_runner.clone(),
        );
        Self {
            data_dir: config.data_dir.clone(),
            workspace_dir: config.workspace_dir.clone(),
            app_version: config.app_version.clone(),
            parent_pid: config.parent_pid,
            database,
            system,
            agent_permissions,
            bot,
            conversation,
            current_skills,
            memory,
            tasks,
            mcp,
            cloud,
            cloud_bridge,
            cloud_events,
            realtime,
            runtime,
        }
    }
}
