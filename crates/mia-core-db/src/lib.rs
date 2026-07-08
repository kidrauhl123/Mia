//! SQLite persistence boundary for Mia Rust Core.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use async_trait::async_trait;
use mia_core_common::DATABASE_FILE_NAME;
use serde_json::Value;
use sqlx::migrate::Migrator;
use sqlx::pool::PoolOptions;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{Row, Sqlite, SqlitePool};

const MAX_CONNECTIONS: u32 = 5;
const BUSY_TIMEOUT_MS: u64 = 5000;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

pub fn database_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DATABASE_FILE_NAME)
}

pub async fn init_database(path: &Path) -> Result<Database, sqlx::Error> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS));

    let pool = PoolOptions::<Sqlite>::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options)
        .await?;
    run_migrations(&pool).await?;
    Ok(Database { pool })
}

pub async fn init_database_memory() -> Result<Database, sqlx::Error> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?
        .foreign_keys(true)
        .busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS));

    let pool = PoolOptions::<Sqlite>::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    run_migrations(&pool).await?;
    Ok(Database { pool })
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

#[async_trait]
pub trait ISettingsRepository: Send + Sync {
    async fn set_json(&self, key: &str, value: Value, now_ms: i64) -> Result<(), sqlx::Error>;
    async fn get_json(&self, key: &str) -> Result<Option<Value>, sqlx::Error>;
}

#[derive(Clone, Debug)]
pub struct SqliteSettingsRepository {
    pool: SqlitePool,
}

impl SqliteSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ISettingsRepository for SqliteSettingsRepository {
    async fn set_json(&self, key: &str, value: Value, now_ms: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value.to_string())
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn get_json(&self, key: &str) -> Result<Option<Value>, sqlx::Error> {
        let row = sqlx::query("SELECT value_json FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| parse_json(row.get::<String, _>("value_json")))
            .transpose()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRecord {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub base_url: Option<String>,
    pub api_key_env: Option<String>,
    pub encrypted_api_key: Option<String>,
    pub api_mode: Option<String>,
    pub auth_type: String,
    pub models_json: Value,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct CreateProviderParams<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub display_name: &'a str,
    pub base_url: Option<&'a str>,
    pub api_key_env: Option<&'a str>,
    pub encrypted_api_key: Option<&'a str>,
    pub api_mode: Option<&'a str>,
    pub auth_type: Option<&'a str>,
    pub models_json: Value,
    pub enabled: bool,
    pub now_ms: i64,
}

#[async_trait]
pub trait IProviderRepository: Send + Sync {
    async fn create(&self, params: CreateProviderParams<'_>)
    -> Result<ProviderRecord, sqlx::Error>;
    async fn list(&self) -> Result<Vec<ProviderRecord>, sqlx::Error>;
    async fn find_by_id(&self, id: &str) -> Result<Option<ProviderRecord>, sqlx::Error>;
}

#[derive(Clone, Debug)]
pub struct SqliteProviderRepository {
    pool: SqlitePool,
}

impl SqliteProviderRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl IProviderRepository for SqliteProviderRepository {
    async fn create(
        &self,
        params: CreateProviderParams<'_>,
    ) -> Result<ProviderRecord, sqlx::Error> {
        sqlx::query(
            "INSERT INTO providers \
             (id, kind, display_name, base_url, api_key_env, encrypted_api_key, api_mode, auth_type, models_json, enabled, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
                kind = excluded.kind, \
                display_name = excluded.display_name, \
                base_url = excluded.base_url, \
                api_key_env = excluded.api_key_env, \
                encrypted_api_key = CASE \
                    WHEN excluded.encrypted_api_key IS NULL THEN providers.encrypted_api_key \
                    ELSE excluded.encrypted_api_key \
                END, \
                api_mode = excluded.api_mode, \
                auth_type = excluded.auth_type, \
                models_json = excluded.models_json, \
                enabled = excluded.enabled, \
                updated_at = excluded.updated_at",
        )
        .bind(params.id)
        .bind(params.kind)
        .bind(params.display_name)
        .bind(params.base_url)
        .bind(params.api_key_env)
        .bind(params.encrypted_api_key)
        .bind(params.api_mode)
        .bind(params.auth_type.unwrap_or("api_key"))
        .bind(params.models_json.to_string())
        .bind(params.enabled)
        .bind(params.now_ms)
        .bind(params.now_ms)
        .execute(&self.pool)
        .await?;

        self.find_by_id(params.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    async fn list(&self) -> Result<Vec<ProviderRecord>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, kind, display_name, base_url, api_key_env, encrypted_api_key, api_mode, auth_type, models_json, enabled, created_at, updated_at \
             FROM providers ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(provider_from_row).collect()
    }

    async fn find_by_id(&self, id: &str) -> Result<Option<ProviderRecord>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, kind, display_name, base_url, api_key_env, encrypted_api_key, api_mode, auth_type, models_json, enabled, created_at, updated_at \
             FROM providers WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(provider_from_row).transpose()
    }
}

fn provider_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ProviderRecord, sqlx::Error> {
    Ok(ProviderRecord {
        id: row.get("id"),
        kind: row.get("kind"),
        display_name: row.get("display_name"),
        base_url: row.get("base_url"),
        api_key_env: row.get("api_key_env"),
        encrypted_api_key: row.get("encrypted_api_key"),
        api_mode: row.get("api_mode"),
        auth_type: row.get("auth_type"),
        models_json: parse_json(row.get::<String, _>("models_json"))?,
        enabled: row.get("enabled"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn parse_json(raw: String) -> Result<Value, sqlx::Error> {
    serde_json::from_str(&raw).map_err(|error| sqlx::Error::Decode(Box::new(error)))
}
