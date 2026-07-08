use std::path::PathBuf;

use mia_core_common::{DATABASE_FILE_NAME, DEFAULT_HOST, DEFAULT_PORT};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub parent_pid: Option<u32>,
    pub language: String,
    pub app_version: String,
}

impl AppConfig {
    pub fn socket_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join(DATABASE_FILE_NAME)
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        let data_dir = PathBuf::from("data");
        Self {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            data_dir: data_dir.clone(),
            workspace_dir: data_dir.join("workspace"),
            parent_pid: None,
            language: "zh".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_loopback_and_mia_core_database_name() {
        let config = AppConfig::default();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 25818);
        assert_eq!(config.database_path(), PathBuf::from("data/mia-core.db"));
    }

    #[test]
    fn socket_addr_uses_current_port() {
        let config = AppConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..Default::default()
        };
        assert_eq!(config.socket_addr(), "127.0.0.1:0");
    }
}
