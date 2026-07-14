use mia_core_db::{init_database, init_database_memory};
use serde_json::json;
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
    "memory_entries",
    "memory_documents",
    "memory_legacy_migration",
    "memory_migration_state",
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
async fn bounded_memory_documents_enforce_target_identity_and_revision() {
    let db = init_database_memory().await.unwrap();

    sqlx::query(
        "INSERT INTO memory_documents
         (user_id, bot_id, target, text, revision, updated_at, deleted_at)
         VALUES ('u1', '', 'user', 'profile', 1, '2026-07-14T00:00:00Z', '')",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO memory_documents
         (user_id, bot_id, target, text, revision, updated_at, deleted_at)
         VALUES ('u1', 'bot_1', 'memory', 'relationship', 1, '2026-07-14T00:00:00Z', '')",
    )
    .execute(db.pool())
    .await
    .unwrap();

    for (bot_id, target, revision) in [
        ("bot_1", "user", 1_i64),
        ("", "memory", 1_i64),
        ("bot_1", "session", 1_i64),
        ("bot_1", "memory", 0_i64),
    ] {
        let result = sqlx::query(
            "INSERT INTO memory_documents
             (user_id, bot_id, target, text, revision, updated_at, deleted_at)
             VALUES ('u2', ?, ?, 'invalid', ?, '2026-07-14T00:00:00Z', '')",
        )
        .bind(bot_id)
        .bind(target)
        .bind(revision)
        .execute(db.pool())
        .await;
        assert!(
            result.is_err(),
            "invalid identity {target}/{bot_id} should fail"
        );
    }
}

#[tokio::test]
async fn fresh_database_persists_the_canonical_default_memory_mode() {
    let db = init_database_memory().await.unwrap();
    let row = sqlx::query("SELECT value_json, updated_at FROM settings WHERE key = 'client'")
        .fetch_one(db.pool())
        .await
        .unwrap();
    let settings: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("value_json")).unwrap();
    assert_eq!(settings["memory"]["mode"], "mia");
    assert_eq!(settings["memory"]["enabled"], true);
    assert_eq!(row.get::<i64, _>("updated_at"), 0);
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
async fn database_reinit_migrates_memory_mode_once_without_overwriting_existing_modes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mia-core.db");

    let db = init_database(&path).await.unwrap();
    sqlx::query("UPDATE settings SET value_json = ?, updated_at = 1000 WHERE key = 'client'")
        .bind(
            json!({ "theme": "dark", "memory": { "enabled": false, "keep": "value" } }).to_string(),
        )
        .execute(db.pool())
        .await
        .unwrap();
    for (id, metadata) in [
        ("conv_missing", json!({ "sessionId": "s1" })),
        (
            "conv_existing",
            json!({ "memoryMode": "mia", "sessionId": "s2" }),
        ),
        (
            "conv_invalid",
            json!({ "memoryMode": "other", "sessionId": "s3" }),
        ),
    ] {
        sqlx::query(
            "INSERT INTO conversations
             (id, kind, title, runtime_json, metadata_json, created_at, updated_at)
             VALUES (?, 'direct', 'Memory', '{}', ?, 1, 1)",
        )
        .bind(id)
        .bind(metadata.to_string())
        .execute(db.pool())
        .await
        .unwrap();
    }
    db.close().await;

    let db = init_database(&path).await.unwrap();
    let settings: String =
        sqlx::query_scalar("SELECT value_json FROM settings WHERE key = 'client'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["memory"]["mode"], "native");
    assert_eq!(settings["memory"]["enabled"], false);
    assert_eq!(settings["memory"]["keep"], "value");

    let rows = sqlx::query("SELECT id, metadata_json FROM conversations ORDER BY id")
        .fetch_all(db.pool())
        .await
        .unwrap();
    let modes = rows
        .into_iter()
        .map(|row| {
            let metadata: serde_json::Value =
                serde_json::from_str(&row.get::<String, _>("metadata_json")).unwrap();
            (
                row.get::<String, _>("id"),
                metadata["memoryMode"].as_str().unwrap().to_string(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        modes,
        vec![
            ("conv_existing".to_string(), "mia".to_string()),
            ("conv_invalid".to_string(), "native".to_string()),
            ("conv_missing".to_string(), "native".to_string()),
        ]
    );
    db.close().await;

    let db = init_database(&path).await.unwrap();
    let modes_after_second_reinit =
        sqlx::query("SELECT metadata_json FROM conversations ORDER BY id")
            .fetch_all(db.pool())
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("metadata_json"))
            .collect::<Vec<_>>();
    assert_eq!(modes_after_second_reinit.len(), 3);
    assert!(modes_after_second_reinit[0].contains("\"memoryMode\":\"mia\""));
    assert!(modes_after_second_reinit[1].contains("\"memoryMode\":\"native\""));
    assert!(modes_after_second_reinit[2].contains("\"memoryMode\":\"native\""));
}

#[tokio::test]
async fn database_reinit_prefers_canonical_mode_and_repairs_invalid_settings_without_runtime_changes()
 {
    let canonical_dir = tempfile::tempdir().unwrap();
    let canonical_path = canonical_dir.path().join("mia-core.db");
    let db = init_database(&canonical_path).await.unwrap();
    sqlx::query("UPDATE settings SET value_json = ?, updated_at = 41 WHERE key = 'client'")
        .bind(json!({ "memory": { "mode": "native", "enabled": true } }).to_string())
        .execute(db.pool())
        .await
        .unwrap();
    db.close().await;

    let db = init_database(&canonical_path).await.unwrap();
    let canonical: String =
        sqlx::query_scalar("SELECT value_json FROM settings WHERE key = 'client'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    let canonical: serde_json::Value = serde_json::from_str(&canonical).unwrap();
    assert_eq!(canonical["memory"]["mode"], "native");
    assert_eq!(canonical["memory"]["enabled"], false);
    db.close().await;

    let invalid_dir = tempfile::tempdir().unwrap();
    let invalid_path = invalid_dir.path().join("mia-core.db");
    let db = init_database(&invalid_path).await.unwrap();
    sqlx::query(
        "UPDATE settings SET value_json = 'not-json', updated_at = 42 WHERE key = 'client'",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO conversations
         (id, kind, title, runtime_json, metadata_json, created_at, updated_at)
         VALUES ('conv_native', 'direct', 'Memory', ?, ?, 1, 1)",
    )
    .bind(json!({ "sessionId": "native-session", "nativeSessionKey": "keep" }).to_string())
    .bind(json!({ "memoryMode": "native", "sessionId": "metadata-session" }).to_string())
    .execute(db.pool())
    .await
    .unwrap();
    db.close().await;

    let db = init_database(&invalid_path).await.unwrap();
    let repaired: String =
        sqlx::query_scalar("SELECT value_json FROM settings WHERE key = 'client'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    let repaired: serde_json::Value = serde_json::from_str(&repaired).unwrap();
    assert_eq!(repaired["memory"]["mode"], "mia");
    assert_eq!(repaired["memory"]["enabled"], true);

    let conversation = sqlx::query(
        "SELECT runtime_json, metadata_json FROM conversations WHERE id = 'conv_native'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(
        conversation.get::<String, _>("runtime_json"),
        json!({ "sessionId": "native-session", "nativeSessionKey": "keep" }).to_string()
    );
    let metadata: serde_json::Value =
        serde_json::from_str(&conversation.get::<String, _>("metadata_json")).unwrap();
    assert_eq!(metadata["memoryMode"], "native");
    assert_eq!(metadata["sessionId"], "metadata-session");
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
