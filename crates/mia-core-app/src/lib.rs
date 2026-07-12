//! Application crate assembling Mia Rust Core services and routes.

pub mod builtin_mcp;
pub mod claude_code_mia_proxy;
pub mod cloud_bridge;
pub mod codex_mia_proxy;
pub mod config;
pub mod cron_middleware;
pub mod cron_turn;
pub mod router;
pub mod runtime;
pub mod scheduler;
pub mod services;
pub mod turn_execution;

pub use config::AppConfig;
pub use router::create_router;
pub use scheduler::TaskScheduler;
pub use services::AppServices;
