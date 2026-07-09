use mia_core_db::{init_database, init_database_memory};
use sqlx::Row;

const REQUIRED_TABLES: &[&str] = &[
    "settings",
    "providers",
    "bots",
    "bot_runtime_bindings",
    "conversations",
    "messages",
    "tasks",
    "mcp_servers",
    "mcp_oauth_tokens",
    "cloud_state",
    "event_cursors",
];

#[tokio::test]
async fn initial_migration_creates_backend_owner_tables() {
    let db = init_database_memory().await.unwrap();

    for table in REQUIRED_TABLES {
        let row = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_optional(db.pool())
            .await
            .unwrap();
        assert!(row.is_some(), "{table} table should exist");
    }
}

#[tokio::test]
async fn file_backed_database_uses_foreign_keys_busy_timeout_and_wal() {
    let dir = tempfile::tempdir().unwrap();
    let db = init_database(&dir.path().join("mia-core.db"))
        .await
        .unwrap();

    let foreign_keys: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(foreign_keys.0, 1);

    let busy_timeout: (i64,) = sqlx::query_as("PRAGMA busy_timeout")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(busy_timeout.0, 5000);

    let journal_mode: (String,) = sqlx::query_as("PRAGMA journal_mode")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(journal_mode.0.to_lowercase(), "wal");
}

#[tokio::test]
async fn file_backed_database_reinit_preserves_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mia-core.db");

    let db = init_database(&path).await.unwrap();
    sqlx::query(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('appearance', '{\"theme\":\"dark\"}', 1000)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    db.close().await;

    let db = init_database(&path).await.unwrap();
    let row = sqlx::query("SELECT value_json FROM settings WHERE key = 'appearance'")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("value_json"), "{\"theme\":\"dark\"}");
}
