use std::path::PathBuf;

use crate::runtime::RuntimeRegistry;
use crate::services::AppServices;
use mia_core_bot::BotService;
use mia_core_cloud::{CloudBridgeManager, CloudEventsManager, CloudService};
use mia_core_conversation::{ConversationService, CurrentSkillService};
use mia_core_mcp::McpService;
use mia_core_memory::MemoryService;
use mia_core_realtime::EventBus;
use mia_core_system::{AgentPermissionService, SystemService};
use mia_core_tasks::TaskService;

#[derive(Debug, Clone)]
pub struct ModuleStates {
    pub data_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub app_version: String,
    pub parent_pid: Option<u32>,
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

pub fn build_module_states(services: &AppServices) -> ModuleStates {
    ModuleStates {
        data_dir: services.data_dir.clone(),
        workspace_dir: services.workspace_dir.clone(),
        app_version: services.app_version.clone(),
        parent_pid: services.parent_pid,
        system: services.system.clone(),
        agent_permissions: services.agent_permissions.clone(),
        bot: services.bot.clone(),
        conversation: services.conversation.clone(),
        current_skills: services.current_skills.clone(),
        memory: services.memory.clone(),
        tasks: services.tasks.clone(),
        mcp: services.mcp.clone(),
        cloud: services.cloud.clone(),
        cloud_bridge: services.cloud_bridge.clone(),
        cloud_events: services.cloud_events.clone(),
        realtime: services.realtime.clone(),
        runtime: services.runtime.clone(),
    }
}
