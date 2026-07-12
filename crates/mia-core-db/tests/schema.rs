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
async fn runtime_and_conversation_bot_ids_do_not_require_core_bot_identity_rows() {
    let db = init_database_memory().await.unwrap();

    let runtime_foreign_keys = sqlx::query("PRAGMA foreign_key_list(bot_runtime_bindings)")
        .fetch_all(db.pool())
        .await
        .unwrap();
    assert!(
        runtime_foreign_keys
            .iter()
            .all(|row| row.get::<String, _>("table") != "bots"),
        "runtime bindings must accept cloud-owned bot identity ids"
    );

    let conversation_foreign_keys = sqlx::query("PRAGMA foreign_key_list(conversations)")
        .fetch_all(db.pool())
        .await
        .unwrap();
    assert!(
        conversation_foreign_keys
            .iter()
            .all(|row| row.get::<String, _>("table") != "bots"),
        "conversations must accept cloud-owned bot identity ids"
    );

    let primary_key_columns = sqlx::query("PRAGMA table_info(bot_runtime_bindings)")
        .fetch_all(db.pool())
        .await
        .unwrap()
        .into_iter()
        .filter_map(|row| {
            let position = row.get::<i64, _>("pk");
            (position > 0).then(|| (position, row.get::<String, _>("name")))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        primary_key_columns,
        vec![(1, "bot_id".to_string()), (2, "runtime_kind".to_string())]
    );

    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('cloud_bot_123', 'desktop-local', '{}', 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at)
         VALUES ('conv_cloud_bot', 'bot_session', 'Cloud Bot', 'cloud_bot_123', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
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

#[tokio::test]
async fn database_reinit_removes_only_legacy_task_generated_user_messages() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mia-core.db");

    let db = init_database(&path).await.unwrap();
    sqlx::query(
        "INSERT INTO conversations (id, kind, title, runtime_json, metadata_json, created_at, updated_at)
         VALUES ('conv_task', 'direct', 'Task', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    for (id, role, body, seq) in [
        ("msg_setup", "user", "一分钟后提醒我喝水", 1_i64),
        ("msg_legacy_wake", "user", "提醒用户喝水", 2_i64),
        ("msg_reply", "assistant", "该喝水啦", 3_i64),
    ] {
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, body, content_json, status, seq, created_at, updated_at)
             VALUES (?, 'conv_task', ?, ?, '{}', 'complete', ?, ?, ?)",
        )
        .bind(id)
        .bind(role)
        .bind(body)
        .bind(seq)
        .bind(seq)
        .bind(seq)
        .execute(db.pool())
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO tasks (id, kind, schedule_json, target_json, instructions, status, next_run_at, created_at, updated_at)
         VALUES ('task_legacy', 'agent', '{}', ?, '提醒用户喝水', 'done', NULL, 1, 1)",
    )
    .bind(
        serde_json::json!({
            "conversationId": "conv_task",
            "runs": [{
                "messageId": "msg_legacy_wake",
                "assistantMessageId": "msg_reply"
            }]
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();
    db.close().await;

    let db = init_database(&path).await.unwrap();
    let rows = sqlx::query("SELECT id, role, body FROM messages ORDER BY seq")
        .fetch_all(db.pool())
        .await
        .unwrap();
    let messages = rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("id"),
                row.get::<String, _>("role"),
                row.get::<String, _>("body"),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        messages,
        vec![
            (
                "msg_setup".to_string(),
                "user".to_string(),
                "一分钟后提醒我喝水".to_string()
            ),
            (
                "msg_reply".to_string(),
                "assistant".to_string(),
                "该喝水啦".to_string()
            )
        ]
    );
}
