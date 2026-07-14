//! Deterministic one-time import from retired entry-based memory stores.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use mia_core_api_types::MiaMemoryTarget;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqliteConnection, SqlitePool};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::document::{
    BoundedMemoryError, count_chars, serialize_entries, target_limit, target_str,
};
use crate::write_policy::validate_memory_write;

const MIGRATION_KEY: &str = "bounded-memory-v1";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyImportResult {
    pub already_completed: bool,
    pub imported: usize,
    pub duplicate: usize,
    pub overflow: usize,
    pub deleted: usize,
    pub session: usize,
}

#[derive(Debug, Clone)]
struct LegacyRow {
    source_kind: String,
    source_id: String,
    user_id: String,
    bot_id: String,
    scope: String,
    text: String,
    updated_at: String,
    deleted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct GroupKey {
    user_id: String,
    bot_id: String,
    target: String,
}

impl GroupKey {
    fn memory_target(&self) -> MiaMemoryTarget {
        if self.target == "user" {
            MiaMemoryTarget::User
        } else {
            MiaMemoryTarget::Memory
        }
    }
}

pub async fn import_legacy_sources(
    core_pool: &SqlitePool,
    legacy_node_path: Option<&Path>,
) -> Result<LegacyImportResult, BoundedMemoryError> {
    if migration_completed(core_pool).await? {
        return Ok(LegacyImportResult {
            already_completed: true,
            ..Default::default()
        });
    }

    let mut rows = read_legacy_rows(core_pool, "core").await?;
    if let Some(path) = legacy_node_path.filter(|path| path.is_file()) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .foreign_keys(false);
        let legacy_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        if table_exists(&legacy_pool, "memory_entries").await? {
            rows.extend(read_legacy_rows(&legacy_pool, "node").await?);
        }
        legacy_pool.close().await;
    }

    rows.sort_by(|a, b| {
        a.source_kind
            .cmp(&b.source_kind)
            .then_with(|| a.source_id.cmp(&b.source_id))
    });

    let mut transaction = core_pool.begin_with("BEGIN IMMEDIATE").await?;
    let result = import_locked(&mut transaction, rows).await;
    match result {
        Ok(summary) => {
            transaction.commit().await?;
            Ok(summary)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

async fn import_locked(
    connection: &mut SqliteConnection,
    rows: Vec<LegacyRow>,
) -> Result<LegacyImportResult, BoundedMemoryError> {
    if migration_completed_on(connection).await? {
        return Ok(LegacyImportResult {
            already_completed: true,
            ..Default::default()
        });
    }

    let mut summary = LegacyImportResult::default();
    let mut groups: BTreeMap<GroupKey, Vec<LegacyRow>> = BTreeMap::new();
    for row in rows {
        if !row.deleted_at.is_empty() {
            record_outcome(connection, &row, "deleted").await?;
            summary.deleted += 1;
            continue;
        }
        if row.user_id.is_empty() {
            record_outcome(connection, &row, "overflow").await?;
            summary.overflow += 1;
            continue;
        }
        let target = match row.scope.as_str() {
            "user" => MiaMemoryTarget::User,
            "bot" if !row.bot_id.trim().is_empty() => MiaMemoryTarget::Memory,
            _ => {
                record_outcome(connection, &row, "session").await?;
                summary.session += 1;
                continue;
            }
        };
        let key = GroupKey {
            user_id: row.user_id.clone(),
            bot_id: match target {
                MiaMemoryTarget::User => String::new(),
                MiaMemoryTarget::Memory => row.bot_id.clone(),
            },
            target: target_str(target).to_string(),
        };
        groups.entry(key).or_default().push(row);
    }

    for (key, mut candidates) in groups {
        let existing = sqlx::query_scalar::<_, String>(
            "SELECT text FROM memory_documents
             WHERE user_id = ? AND bot_id = ? AND target = ?",
        )
        .bind(&key.user_id)
        .bind(&key.bot_id)
        .bind(&key.target)
        .fetch_optional(&mut *connection)
        .await?;
        if let Some(existing) = existing {
            let existing_entries = crate::deserialize_entries(&existing)?;
            for row in candidates {
                let outcome = if existing_entries.contains(&normalize_legacy_text(&row.text)) {
                    summary.duplicate += 1;
                    "duplicate"
                } else {
                    summary.overflow += 1;
                    "overflow"
                };
                record_outcome(connection, &row, outcome).await?;
            }
            continue;
        }

        candidates.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.source_kind.cmp(&b.source_kind))
                .then_with(|| a.source_id.cmp(&b.source_id))
        });
        let limit = target_limit(key.memory_target());
        let mut selected = Vec::<LegacyRow>::new();
        let mut selected_text = Vec::<String>::new();
        let mut seen = HashSet::<String>::new();
        for row in candidates {
            let text = normalize_legacy_text(&row.text);
            if text.is_empty() || validate_memory_write(&text).is_err() {
                record_outcome(connection, &row, "overflow").await?;
                summary.overflow += 1;
                continue;
            }
            if !seen.insert(text.clone()) {
                record_outcome(connection, &row, "duplicate").await?;
                summary.duplicate += 1;
                continue;
            }
            let mut proposed = selected_text.clone();
            proposed.push(text.clone());
            let serialized = serialize_entries(&proposed)?;
            if count_chars(&serialized) > limit {
                record_outcome(connection, &row, "overflow").await?;
                summary.overflow += 1;
                continue;
            }
            selected_text.push(text);
            selected.push(row);
        }

        selected.sort_by(|a, b| {
            a.updated_at
                .cmp(&b.updated_at)
                .then_with(|| a.source_kind.cmp(&b.source_kind))
                .then_with(|| a.source_id.cmp(&b.source_id))
        });
        let entries: Vec<String> = selected
            .iter()
            .map(|row| normalize_legacy_text(&row.text))
            .collect();
        if !entries.is_empty() {
            let timestamp = now_iso();
            sqlx::query(
                "INSERT INTO memory_documents
                     (user_id, bot_id, target, text, revision, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, 1, ?, '')
                 ON CONFLICT(user_id, bot_id, target) DO NOTHING",
            )
            .bind(&key.user_id)
            .bind(&key.bot_id)
            .bind(&key.target)
            .bind(serialize_entries(&entries)?)
            .bind(timestamp)
            .execute(&mut *connection)
            .await?;
        }
        for row in selected {
            record_outcome(connection, &row, "imported").await?;
            summary.imported += 1;
        }
    }

    sqlx::query(
        "INSERT INTO memory_migration_state (key, completed_at) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING",
    )
    .bind(MIGRATION_KEY)
    .bind(now_iso())
    .execute(&mut *connection)
    .await?;
    Ok(summary)
}

async fn read_legacy_rows(
    pool: &SqlitePool,
    source_kind: &str,
) -> Result<Vec<LegacyRow>, BoundedMemoryError> {
    let columns: HashSet<String> = sqlx::query("PRAGMA table_info(memory_entries)")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();
    let deleted_at = if columns.contains("deleted_at") {
        "deleted_at"
    } else {
        "'' AS deleted_at"
    };
    let query = format!(
        "SELECT id, user_id, bot_id, scope, text, updated_at, {deleted_at} FROM memory_entries"
    );
    let rows = sqlx::query(&query).fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok(LegacyRow {
                source_kind: source_kind.to_string(),
                source_id: row.try_get("id")?,
                user_id: row.try_get::<String, _>("user_id")?.trim().to_string(),
                bot_id: row.try_get::<String, _>("bot_id")?.trim().to_string(),
                scope: row.try_get::<String, _>("scope")?.trim().to_lowercase(),
                text: row.try_get("text")?,
                updated_at: row.try_get("updated_at")?,
                deleted_at: row.try_get("deleted_at")?,
            })
        })
        .collect()
}

async fn migration_completed(pool: &SqlitePool) -> Result<bool, BoundedMemoryError> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memory_migration_state WHERE key = ?")
            .bind(MIGRATION_KEY)
            .fetch_one(pool)
            .await?
            > 0,
    )
}

async fn migration_completed_on(
    connection: &mut SqliteConnection,
) -> Result<bool, BoundedMemoryError> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memory_migration_state WHERE key = ?")
            .bind(MIGRATION_KEY)
            .fetch_one(&mut *connection)
            .await?
            > 0,
    )
}

async fn table_exists(pool: &SqlitePool, table: &str) -> Result<bool, BoundedMemoryError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .bind(table)
    .fetch_one(pool)
    .await?
        > 0)
}

async fn record_outcome(
    connection: &mut SqliteConnection,
    row: &LegacyRow,
    outcome: &str,
) -> Result<(), BoundedMemoryError> {
    sqlx::query(
        "INSERT INTO memory_legacy_migration
             (source_kind, source_id, outcome, migrated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_kind, source_id) DO NOTHING",
    )
    .bind(&row.source_kind)
    .bind(&row.source_id)
    .bind(outcome)
    .bind(now_iso())
    .execute(&mut *connection)
    .await?;
    Ok(())
}

fn normalize_legacy_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
