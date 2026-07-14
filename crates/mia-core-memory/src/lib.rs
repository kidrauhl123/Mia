//! Scoped Mia memory ownership for Rust Core.

mod document;
mod legacy_import;
mod write_policy;

pub use document::{
    BOT_MEMORY_LIMIT, BoundedMemoryError, BoundedMemoryService, BoundedMemorySnapshot,
    ENTRY_SEPARATOR, USER_MEMORY_LIMIT, count_chars, deserialize_entries, render_runtime_snapshot,
    serialize_entries, target_limit, target_str,
};
pub use legacy_import::{LegacyImportResult, import_legacy_sources};
pub use write_policy::{
    POLICY_CREDENTIAL_MATERIAL, POLICY_INVALID_SEPARATOR, POLICY_INVISIBLE_UNICODE,
    POLICY_PERSISTENT_COMMAND, POLICY_PROMPT_OVERRIDE, POLICY_SSH_BACKDOOR, validate_memory_write,
};

use std::time::{SystemTime, UNIX_EPOCH};

use mia_core_api_types::{
    MiaMemoryEntry, MiaMemoryMutationRequest, MiaMemoryMutationResponse, MiaMemorySearchRequest,
    MiaMemorySearchResponse,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const VALID_SCOPES: &[&str] = &["user", "bot", "session"];

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("invalid memory input: {0}")]
    InvalidInput(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct MemoryService {
    pool: SqlitePool,
}

#[derive(Debug, Clone, Default)]
pub struct MemorySyncApplyResult {
    pub applied: Vec<MiaMemoryEntry>,
    pub conflicts: Vec<MiaMemoryEntry>,
    pub errors: Vec<Value>,
}

enum SyncedMemoryOutcome {
    Applied(MiaMemoryEntry),
    Conflict(MiaMemoryEntry),
    Skipped(String),
}

impl MemoryService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn search(
        &self,
        request: MiaMemorySearchRequest,
    ) -> Result<MiaMemorySearchResponse, MemoryError> {
        let context = MemoryContext::from_value(&request.context);
        let query = clean_text(request.query.or(request.q).unwrap_or_default());
        let rows = self
            .visible_entries(
                &context,
                request.scopes,
                request.limit.unwrap_or(20),
                query.as_str(),
            )
            .await?;
        if !rows.is_empty() {
            let at = now_iso();
            for row in &rows {
                sqlx::query("UPDATE memory_entries SET last_used_at = ? WHERE id = ?")
                    .bind(&at)
                    .bind(&row.id)
                    .execute(&self.pool)
                    .await?;
                self.record_event(
                    &row.id,
                    "retrieve",
                    "agent",
                    json!({}),
                    json!({
                        "queryChars": query.len(),
                        "resultCount": rows.len(),
                        "botId": context.bot_id.clone(),
                        "sessionId": context.session_id.clone(),
                    }),
                )
                .await?;
            }
        }
        Ok(MiaMemorySearchResponse {
            memories: rows,
            disabled: None,
            reason: None,
        })
    }

    pub async fn list(
        &self,
        request: MiaMemorySearchRequest,
    ) -> Result<MiaMemorySearchResponse, MemoryError> {
        let bot_filter = first_string(&request.context, &["botId", "bot_id", "botKey", "bot_key"]);
        let session_filter = first_string(&request.context, &["sessionId", "session_id"]);
        let context = MemoryContext::from_value(&request.context);
        let query = clean_text(request.query.or(request.q).unwrap_or_default());
        let rows = self
            .owned_entries(OwnedMemoryQuery {
                context: &context,
                bot_filter: bot_filter.as_deref(),
                session_filter: session_filter.as_deref(),
                scopes: request.scopes,
                limit: request.limit.unwrap_or(250),
                query: query.as_str(),
                include_deleted: request.include_deleted.unwrap_or(false),
            })
            .await?;
        Ok(MiaMemorySearchResponse {
            memories: rows,
            disabled: None,
            reason: None,
        })
    }

    pub async fn remember(
        &self,
        request: MiaMemoryMutationRequest,
    ) -> Result<MiaMemoryMutationResponse, MemoryError> {
        let context = MemoryContext::from_value(&request.context);
        let text = clean_text(
            request
                .text
                .clone()
                .or(request.content.clone())
                .unwrap_or_default(),
        );
        let scope = normalize_scope(request.scope.as_deref(), "bot");
        let policy = policy_for(&text, &scope);
        if policy.decision != "store" {
            self.record_event("", "ignore", "system", json!({}), policy.to_json())
                .await?;
            return Ok(MiaMemoryMutationResponse {
                status: "ignored".to_string(),
                disabled: None,
                reason: None,
                error: None,
                effective_scope: Some(scope),
                policy_reason: Some(policy.reason),
                memory_id: Some(String::new()),
                memory: None,
                matches: Vec::new(),
            });
        }

        if let Some(duplicate) = self.find_exact_duplicate(&context, &scope, &text).await? {
            return Ok(MiaMemoryMutationResponse {
                status: "ok".to_string(),
                disabled: None,
                reason: None,
                error: None,
                effective_scope: Some(duplicate.scope.clone()),
                policy_reason: Some("duplicate memory".to_string()),
                memory_id: Some(duplicate.id.clone()),
                memory: Some(duplicate),
                matches: Vec::new(),
            });
        }

        let entry = self
            .insert_entry(&context, &request, &scope, &text, &policy)
            .await?;
        Ok(MiaMemoryMutationResponse {
            status: "ok".to_string(),
            disabled: None,
            reason: None,
            error: None,
            effective_scope: Some(entry.scope.clone()),
            policy_reason: Some(policy.reason),
            memory_id: Some(entry.id.clone()),
            memory: Some(entry),
            matches: Vec::new(),
        })
    }

    pub async fn update(
        &self,
        request: MiaMemoryMutationRequest,
    ) -> Result<MiaMemoryMutationResponse, MemoryError> {
        let context = MemoryContext::from_value(&request.context);
        let Some(target) = self.find_mutable_memory(&context, &request).await? else {
            return Ok(not_found_response(
                "No visible active memory matched the requested target.",
            ));
        };
        let text = clean_text(
            request
                .text
                .clone()
                .or(request.content.clone())
                .or(request.new_text.clone())
                .unwrap_or_default(),
        );
        if text.is_empty() {
            return Ok(MiaMemoryMutationResponse {
                status: "ignored".to_string(),
                disabled: None,
                reason: None,
                error: Some("text is required".to_string()),
                effective_scope: None,
                policy_reason: None,
                memory_id: None,
                memory: None,
                matches: Vec::new(),
            });
        }
        let policy = policy_for(&text, &target.scope);
        if policy.decision != "store" {
            self.record_event(
                &target.id,
                "ignore",
                "system",
                serde_json::to_value(&target).unwrap_or_else(|_| json!({})),
                policy.to_json(),
            )
            .await?;
            return Ok(MiaMemoryMutationResponse {
                status: "ignored".to_string(),
                disabled: None,
                reason: None,
                error: None,
                effective_scope: Some(target.scope),
                policy_reason: Some(policy.reason),
                memory_id: Some(String::new()),
                memory: None,
                matches: Vec::new(),
            });
        }

        let before = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
        let timestamp = now_iso();
        let normalized = normalize_text(&text);
        let hash = memory_hash(&target.scope, &normalized);
        let confidence = request.confidence.unwrap_or(target.confidence);
        let priority = normalize_priority(request.priority, target.priority);
        let metadata = object_or_empty(&request.metadata);
        sqlx::query(
            "UPDATE memory_entries \
             SET text = ?, text_normalized = ?, hash = ?, confidence = ?, source = ?, \
                 origin_engine = ?, origin_native_session_id = ?, source_message_ids_json = ?, \
                 linked_memory_ids_json = ?, policy_result_json = ?, priority = ?, metadata_json = ?, \
                 updated_at = ?, revision = revision + 1 \
             WHERE id = ?",
        )
        .bind(&text)
        .bind(&normalized)
        .bind(&hash)
        .bind(confidence)
        .bind("agent_tool")
        .bind(&context.origin_engine)
        .bind(&context.origin_native_session_id)
        .bind(json_array(&request.source_message_ids))
        .bind(json_array(&request.linked_memory_ids))
        .bind(policy.to_json().to_string())
        .bind(priority)
        .bind(metadata.to_string())
        .bind(&timestamp)
        .bind(&target.id)
        .execute(&self.pool)
        .await?;
        let entry = self
            .get_entry(&target.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        self.record_event(
            &entry.id,
            "replace",
            "agent",
            before,
            json!({ "memory": entry.clone(), "policy": policy.to_json() }),
        )
        .await?;
        Ok(MiaMemoryMutationResponse {
            status: "ok".to_string(),
            disabled: None,
            reason: None,
            error: None,
            effective_scope: Some(entry.scope.clone()),
            policy_reason: Some(policy.reason),
            memory_id: Some(entry.id.clone()),
            memory: Some(entry),
            matches: Vec::new(),
        })
    }

    pub async fn forget(
        &self,
        request: MiaMemoryMutationRequest,
    ) -> Result<MiaMemoryMutationResponse, MemoryError> {
        let context = MemoryContext::from_value(&request.context);
        let Some(target) = self.find_mutable_memory(&context, &request).await? else {
            return Ok(not_found_response(
                "No visible active memory matched the requested target.",
            ));
        };
        let before = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
        let timestamp = now_iso();
        sqlx::query(
            "UPDATE memory_entries \
             SET text = '', text_normalized = '', hash = '', deleted_at = ?, updated_at = ?, revision = revision + 1 \
             WHERE id = ?",
        )
        .bind(&timestamp)
        .bind(&timestamp)
        .bind(&target.id)
        .execute(&self.pool)
        .await?;
        let entry = self
            .get_entry(&target.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        self.record_event(
            &entry.id,
            "delete",
            "agent",
            before,
            json!({ "reason": request.reason.unwrap_or_default(), "memory": entry.clone() }),
        )
        .await?;
        Ok(MiaMemoryMutationResponse {
            status: "deleted".to_string(),
            disabled: None,
            reason: None,
            error: None,
            effective_scope: Some(target.scope),
            policy_reason: None,
            memory_id: Some(entry.id.clone()),
            memory: Some(entry),
            matches: Vec::new(),
        })
    }

    pub async fn delete(
        &self,
        request: MiaMemoryMutationRequest,
    ) -> Result<MiaMemoryMutationResponse, MemoryError> {
        let context = MemoryContext::from_value(&request.context);
        let memory_id = clean_text(
            request
                .memory_id
                .clone()
                .or(request.id.clone())
                .unwrap_or_default(),
        );
        if memory_id.is_empty() {
            return Ok(not_found_response("memoryId is required."));
        }
        let Some(target) = self.get_entry(&memory_id).await? else {
            return Ok(not_found_response("No memory matched the requested id."));
        };
        if target.user_id != context.user_id || !target.deleted_at.is_empty() {
            return Ok(not_found_response("No memory matched the requested id."));
        }

        let before = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
        let timestamp = now_iso();
        sqlx::query(
            "UPDATE memory_entries \
             SET text = '', text_normalized = '', hash = '', deleted_at = ?, updated_at = ?, revision = revision + 1 \
             WHERE id = ? AND user_id = ?",
        )
        .bind(&timestamp)
        .bind(&timestamp)
        .bind(&target.id)
        .bind(&target.user_id)
        .execute(&self.pool)
        .await?;
        let entry = self
            .get_entry(&target.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        self.record_event(
            &entry.id,
            "delete",
            "user",
            before,
            json!({ "hardDelete": true, "memory": entry.clone() }),
        )
        .await?;
        Ok(MiaMemoryMutationResponse {
            status: "deleted".to_string(),
            disabled: None,
            reason: None,
            error: None,
            effective_scope: Some(target.scope),
            policy_reason: None,
            memory_id: Some(entry.id.clone()),
            memory: Some(entry),
            matches: Vec::new(),
        })
    }

    pub async fn list_sync_memories(
        &self,
        user_id: &str,
        since: &str,
        include_deleted: bool,
        limit: u32,
    ) -> Result<Vec<MiaMemoryEntry>, MemoryError> {
        let user_id = clean_text(user_id);
        if user_id.is_empty() {
            return Ok(Vec::new());
        }
        let since = clean_text(since);
        let safe_limit = limit.clamp(1, 5000);
        let rows = if since.is_empty() {
            sqlx::query(
                "SELECT * FROM memory_entries \
                 WHERE user_id = ? AND (? = 1 OR deleted_at = '') \
                 ORDER BY updated_at ASC, id ASC \
                 LIMIT ?",
            )
            .bind(&user_id)
            .bind(if include_deleted { 1_i64 } else { 0_i64 })
            .bind(i64::from(safe_limit))
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM memory_entries \
                 WHERE user_id = ? AND updated_at > ? AND (? = 1 OR deleted_at = '') \
                 ORDER BY updated_at ASC, id ASC \
                 LIMIT ?",
            )
            .bind(&user_id)
            .bind(&since)
            .bind(if include_deleted { 1_i64 } else { 0_i64 })
            .bind(i64::from(safe_limit))
            .fetch_all(&self.pool)
            .await?
        };
        rows.into_iter()
            .map(entry_from_row)
            .collect::<Result<Vec<_>, _>>()
            .map_err(MemoryError::from)
    }

    pub async fn apply_synced_memories(
        &self,
        user_id: &str,
        entries: &[Value],
        force: bool,
    ) -> Result<MemorySyncApplyResult, MemoryError> {
        let mut result = MemorySyncApplyResult::default();
        for input in entries {
            match self.apply_synced_memory(user_id, input, force).await {
                Ok(SyncedMemoryOutcome::Applied(memory)) => result.applied.push(memory),
                Ok(SyncedMemoryOutcome::Conflict(memory)) => result.conflicts.push(memory),
                Ok(SyncedMemoryOutcome::Skipped(error)) => {
                    result
                        .errors
                        .push(json!({ "id": sync_entry_id(input), "error": error }));
                }
                Err(error) => {
                    result.errors.push(json!({
                        "id": sync_entry_id(input),
                        "error": error.to_string()
                    }));
                }
            }
        }
        Ok(result)
    }

    async fn insert_entry(
        &self,
        context: &MemoryContext,
        request: &MiaMemoryMutationRequest,
        scope: &str,
        text: &str,
        policy: &MemoryPolicy,
    ) -> Result<MiaMemoryEntry, MemoryError> {
        let id = format!("mem_{}", Uuid::now_v7().simple());
        let timestamp = now_iso();
        let normalized = normalize_text(text);
        let entry = MiaMemoryEntry {
            id,
            user_id: context.user_id.clone(),
            bot_id: context.bot_id.clone(),
            session_id: context.session_id.clone(),
            scope: scope.to_string(),
            text: text.to_string(),
            confidence: request.confidence.unwrap_or(1.0),
            source: "agent_tool".to_string(),
            origin_engine: context.origin_engine.clone(),
            origin_native_session_id: context.origin_native_session_id.clone(),
            source_message_ids: if request.source_message_ids.is_empty()
                && !context.origin_message_id.is_empty()
            {
                vec![context.origin_message_id.clone()]
            } else {
                request.source_message_ids.clone()
            },
            linked_memory_ids: request.linked_memory_ids.clone(),
            policy_result: policy.to_json(),
            priority: normalize_priority(request.priority, 0),
            pinned: false,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            last_used_at: String::new(),
            expires_at: String::new(),
            metadata: object_or_empty(&request.metadata),
            deleted_at: String::new(),
            revision: 1,
        };
        sqlx::query(
            "INSERT INTO memory_entries \
             (id, user_id, bot_id, session_id, scope, text, confidence, source, \
              origin_engine, origin_native_session_id, source_message_ids_json, linked_memory_ids_json, \
              policy_result_json, hash, text_normalized, priority, pinned, created_at, updated_at, \
              last_used_at, expires_at, metadata_json, deleted_at, revision) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&entry.id)
        .bind(&entry.user_id)
        .bind(&entry.bot_id)
        .bind(&entry.session_id)
        .bind(&entry.scope)
        .bind(&entry.text)
        .bind(entry.confidence)
        .bind(&entry.source)
        .bind(&entry.origin_engine)
        .bind(&entry.origin_native_session_id)
        .bind(json_array(&entry.source_message_ids))
        .bind(json_array(&entry.linked_memory_ids))
        .bind(entry.policy_result.to_string())
        .bind(memory_hash(&entry.scope, &normalized))
        .bind(normalized)
        .bind(entry.priority)
        .bind(if entry.pinned { 1 } else { 0 })
        .bind(&entry.created_at)
        .bind(&entry.updated_at)
        .bind(&entry.last_used_at)
        .bind(&entry.expires_at)
        .bind(entry.metadata.to_string())
        .bind(&entry.deleted_at)
        .bind(entry.revision)
        .execute(&self.pool)
        .await?;
        self.record_event(
            &entry.id,
            "remember",
            "agent",
            json!({}),
            json!({ "memory": entry.clone(), "policy": policy.to_json() }),
        )
        .await?;
        Ok(entry)
    }

    async fn apply_synced_memory(
        &self,
        user_id: &str,
        input: &Value,
        force: bool,
    ) -> Result<SyncedMemoryOutcome, MemoryError> {
        let Some(entry) = normalize_sync_entry(user_id, input) else {
            return Ok(SyncedMemoryOutcome::Skipped(
                "empty memory text".to_string(),
            ));
        };
        let existing = self.get_owned_entry(&entry.user_id, &entry.id).await?;
        if let Some(existing) = existing.as_ref()
            && !force
        {
            let local_newer = !existing.updated_at.is_empty()
                && !entry.updated_at.is_empty()
                && existing.updated_at > entry.updated_at;
            let local_revision = existing.revision;
            if local_newer
                || (existing.updated_at == entry.updated_at && local_revision > entry.revision)
            {
                return Ok(SyncedMemoryOutcome::Conflict(existing.clone()));
            }
        }

        if let Some(existing) = existing {
            let before = serde_json::to_value(&existing).unwrap_or_else(|_| json!({}));
            let revision = existing.revision.max(entry.revision);
            sqlx::query(
                "UPDATE memory_entries SET \
                 bot_id = ?, session_id = ?, scope = ?, text = ?, confidence = ?, source = ?, \
                 origin_engine = ?, origin_native_session_id = ?, source_message_ids_json = ?, \
                 linked_memory_ids_json = ?, policy_result_json = ?, hash = ?, text_normalized = ?, \
                 priority = ?, pinned = ?, created_at = ?, updated_at = ?, last_used_at = ?, \
                 expires_at = ?, metadata_json = ?, deleted_at = ?, revision = ? \
                 WHERE id = ? AND user_id = ?",
            )
            .bind(&entry.bot_id)
            .bind(&entry.session_id)
            .bind(&entry.scope)
            .bind(&entry.text)
            .bind(entry.confidence)
            .bind(&entry.source)
            .bind(&entry.origin_engine)
            .bind(&entry.origin_native_session_id)
            .bind(json_array(&entry.source_message_ids))
            .bind(json_array(&entry.linked_memory_ids))
            .bind(entry.policy_result.to_string())
            .bind(memory_hash(&entry.scope, &normalize_text(&entry.text)))
            .bind(normalize_text(&entry.text))
            .bind(entry.priority)
            .bind(if entry.pinned { 1 } else { 0 })
            .bind(&entry.created_at)
            .bind(&entry.updated_at)
            .bind(&entry.last_used_at)
            .bind(&entry.expires_at)
            .bind(entry.metadata.to_string())
            .bind(&entry.deleted_at)
            .bind(revision)
            .bind(&entry.id)
            .bind(&entry.user_id)
            .execute(&self.pool)
            .await?;
            let memory = self
                .get_owned_entry(&entry.user_id, &entry.id)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;
            self.record_event(
                &memory.id,
                if memory.deleted_at.is_empty() {
                    "sync_update"
                } else {
                    "sync_delete"
                },
                "cloud",
                before,
                json!({ "memory": memory.clone() }),
            )
            .await?;
            return Ok(SyncedMemoryOutcome::Applied(memory));
        }

        sqlx::query(
            "INSERT INTO memory_entries \
             (id, user_id, bot_id, session_id, scope, text, confidence, source, \
              origin_engine, origin_native_session_id, source_message_ids_json, linked_memory_ids_json, \
              policy_result_json, hash, text_normalized, priority, pinned, created_at, updated_at, \
              last_used_at, expires_at, metadata_json, deleted_at, revision) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&entry.id)
        .bind(&entry.user_id)
        .bind(&entry.bot_id)
        .bind(&entry.session_id)
        .bind(&entry.scope)
        .bind(&entry.text)
        .bind(entry.confidence)
        .bind(&entry.source)
        .bind(&entry.origin_engine)
        .bind(&entry.origin_native_session_id)
        .bind(json_array(&entry.source_message_ids))
        .bind(json_array(&entry.linked_memory_ids))
        .bind(entry.policy_result.to_string())
        .bind(memory_hash(&entry.scope, &normalize_text(&entry.text)))
        .bind(normalize_text(&entry.text))
        .bind(entry.priority)
        .bind(if entry.pinned { 1 } else { 0 })
        .bind(&entry.created_at)
        .bind(&entry.updated_at)
        .bind(&entry.last_used_at)
        .bind(&entry.expires_at)
        .bind(entry.metadata.to_string())
        .bind(&entry.deleted_at)
        .bind(entry.revision)
        .execute(&self.pool)
        .await?;
        let memory = self
            .get_owned_entry(&entry.user_id, &entry.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        self.record_event(
            &memory.id,
            if memory.deleted_at.is_empty() {
                "sync_insert"
            } else {
                "sync_delete"
            },
            "cloud",
            json!({}),
            serde_json::to_value(&memory).unwrap_or_else(|_| json!({})),
        )
        .await?;
        Ok(SyncedMemoryOutcome::Applied(memory))
    }

    async fn visible_entries(
        &self,
        context: &MemoryContext,
        scopes: Vec<String>,
        limit: u32,
        query: &str,
    ) -> Result<Vec<MiaMemoryEntry>, sqlx::Error> {
        let wanted_scopes = normalize_scopes(scopes);
        let safe_limit = limit.clamp(1, 100);
        let rows = sqlx::query(
            "SELECT * FROM memory_entries \
             WHERE deleted_at = '' AND user_id = ? AND \
               (scope = 'user' OR (scope = 'bot' AND bot_id = ?) OR (scope = 'session' AND bot_id = ? AND session_id = ?)) \
             ORDER BY pinned DESC, priority DESC, updated_at DESC \
             LIMIT ?",
        )
        .bind(&context.user_id)
        .bind(&context.bot_id)
        .bind(&context.bot_id)
        .bind(&context.session_id)
        .bind(i64::from(safe_limit.max(if query.is_empty() { 1 } else { 100 })))
        .fetch_all(&self.pool)
        .await?;
        let needle = normalize_text(query);
        let entries = rows
            .into_iter()
            .map(entry_from_row)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|entry| wanted_scopes.is_empty() || wanted_scopes.contains(&entry.scope))
            .filter(|entry| needle.is_empty() || normalize_text(&entry.text).contains(&needle))
            .take(safe_limit as usize)
            .collect();
        Ok(entries)
    }

    async fn owned_entries(
        &self,
        request: OwnedMemoryQuery<'_>,
    ) -> Result<Vec<MiaMemoryEntry>, sqlx::Error> {
        let wanted_scopes = normalize_scopes(request.scopes);
        let safe_limit = request.limit.clamp(1, 5000);
        let fetch_limit = if request.query.is_empty() {
            safe_limit
        } else {
            5000
        };
        let rows = sqlx::query(
            "SELECT * FROM memory_entries \
             WHERE user_id = ? AND (? = 1 OR deleted_at = '') \
             ORDER BY pinned DESC, priority DESC, updated_at DESC \
             LIMIT ?",
        )
        .bind(&request.context.user_id)
        .bind(if request.include_deleted {
            1_i64
        } else {
            0_i64
        })
        .bind(i64::from(fetch_limit))
        .fetch_all(&self.pool)
        .await?;
        let needle = normalize_text(request.query);
        let entries = rows
            .into_iter()
            .map(entry_from_row)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|entry| wanted_scopes.is_empty() || wanted_scopes.contains(&entry.scope))
            .filter(|entry| match request.bot_filter {
                Some(bot_id) => entry.scope == "user" || entry.bot_id == bot_id,
                None => true,
            })
            .filter(|entry| match request.session_filter {
                Some(session_id) => entry.scope != "session" || entry.session_id == session_id,
                None => true,
            })
            .filter(|entry| needle.is_empty() || normalize_text(&entry.text).contains(&needle))
            .take(safe_limit as usize)
            .collect();
        Ok(entries)
    }

    async fn find_exact_duplicate(
        &self,
        context: &MemoryContext,
        scope: &str,
        text: &str,
    ) -> Result<Option<MiaMemoryEntry>, sqlx::Error> {
        let normalized = normalize_text(text);
        let entries = self
            .visible_entries(context, vec![scope.to_string()], 100, "")
            .await?;
        Ok(entries
            .into_iter()
            .find(|entry| normalize_text(&entry.text) == normalized))
    }

    async fn find_mutable_memory(
        &self,
        context: &MemoryContext,
        request: &MiaMemoryMutationRequest,
    ) -> Result<Option<MiaMemoryEntry>, MemoryError> {
        let memory_id = clean_text(
            request
                .memory_id
                .clone()
                .or(request.id.clone())
                .unwrap_or_default(),
        );
        if !memory_id.is_empty() {
            let entry = self.get_entry(&memory_id).await?;
            return Ok(entry.filter(|entry| {
                entry.deleted_at.is_empty() && is_visible_to_context(entry, context)
            }));
        }
        let old_text = normalize_text(request.old_text.as_deref().unwrap_or_default());
        if old_text.is_empty() {
            return Err(MemoryError::InvalidInput(
                "memoryId or oldText is required".to_string(),
            ));
        }
        let scopes = request
            .scope
            .clone()
            .map(|scope| vec![scope])
            .unwrap_or_default();
        let matches = self.visible_entries(context, scopes, 100, "").await?;
        let mut matched = matches
            .into_iter()
            .filter(|entry| normalize_text(&entry.text).contains(&old_text))
            .collect::<Vec<_>>();
        if matched.len() > 1 {
            return Err(MemoryError::InvalidInput(
                "Multiple visible memories matched oldText. Use memoryId or a more specific oldText."
                    .to_string(),
            ));
        }
        Ok(matched.pop())
    }

    async fn get_entry(&self, id: &str) -> Result<Option<MiaMemoryEntry>, sqlx::Error> {
        sqlx::query("SELECT * FROM memory_entries WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(entry_from_row)
            .transpose()
    }

    async fn get_owned_entry(
        &self,
        user_id: &str,
        id: &str,
    ) -> Result<Option<MiaMemoryEntry>, sqlx::Error> {
        sqlx::query("SELECT * FROM memory_entries WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await?
            .map(entry_from_row)
            .transpose()
    }

    async fn record_event(
        &self,
        memory_id: &str,
        event: &str,
        actor: &str,
        before: Value,
        after: Value,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO memory_events (id, memory_id, event, actor, before_json, after_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(format!("evt_{}", Uuid::now_v7().simple()))
        .bind(memory_id)
        .bind(event)
        .bind(actor)
        .bind(before.to_string())
        .bind(after.to_string())
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct MemoryContext {
    user_id: String,
    bot_id: String,
    session_id: String,
    origin_message_id: String,
    origin_engine: String,
    origin_native_session_id: String,
}

struct OwnedMemoryQuery<'a> {
    context: &'a MemoryContext,
    bot_filter: Option<&'a str>,
    session_filter: Option<&'a str>,
    scopes: Vec<String>,
    limit: u32,
    query: &'a str,
    include_deleted: bool,
}

impl MemoryContext {
    fn from_value(value: &Value) -> Self {
        Self {
            user_id: first_string(value, &["userId", "user_id"])
                .unwrap_or_else(|| "local".to_string()),
            bot_id: first_string(value, &["botId", "bot_id", "botKey", "bot_key"])
                .unwrap_or_else(|| "mia".to_string()),
            session_id: first_string(value, &["sessionId", "session_id"])
                .unwrap_or_else(|| "default".to_string()),
            origin_message_id: first_string(value, &["originMessageId", "origin_message_id"])
                .unwrap_or_default(),
            origin_engine: first_string(value, &["engine", "originEngine", "origin_engine"])
                .unwrap_or_default(),
            origin_native_session_id: first_string(
                value,
                &[
                    "nativeSessionId",
                    "originNativeSessionId",
                    "origin_native_session_id",
                ],
            )
            .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone)]
struct MemoryPolicy {
    decision: String,
    effective_scope: String,
    reason: String,
    sensitivity: Value,
}

impl MemoryPolicy {
    fn to_json(&self) -> Value {
        json!({
            "decision": self.decision,
            "effectiveScope": self.effective_scope,
            "reason": self.reason,
            "sensitivity": self.sensitivity,
        })
    }
}

fn policy_for(text: &str, scope: &str) -> MemoryPolicy {
    if text.trim().is_empty() {
        return MemoryPolicy {
            decision: "ignore".to_string(),
            effective_scope: scope.to_string(),
            reason: "empty memory text".to_string(),
            sensitivity: json!({ "sensitive": false, "severity": "", "reason": "" }),
        };
    }
    let lower = text.to_lowercase();
    let credential_like = [
        "api key",
        "apikey",
        "secret",
        "token",
        "bearer ",
        "password",
        "passwd",
        "private key",
        "密码",
        "口令",
        "私钥",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if credential_like {
        return MemoryPolicy {
            decision: "ignore".to_string(),
            effective_scope: scope.to_string(),
            reason: "looks like credential material".to_string(),
            sensitivity: json!({ "sensitive": true, "severity": "credential", "reason": "looks like credential material" }),
        };
    }
    MemoryPolicy {
        decision: "store".to_string(),
        effective_scope: scope.to_string(),
        reason: "safe scoped memory".to_string(),
        sensitivity: json!({ "sensitive": false, "severity": "", "reason": "" }),
    }
}

fn entry_from_row(row: sqlx::sqlite::SqliteRow) -> Result<MiaMemoryEntry, sqlx::Error> {
    Ok(MiaMemoryEntry {
        id: row.get("id"),
        user_id: row.get("user_id"),
        bot_id: row.get("bot_id"),
        session_id: row.get("session_id"),
        scope: row.get("scope"),
        text: row.get("text"),
        confidence: row.get("confidence"),
        source: row.get("source"),
        origin_engine: row.get("origin_engine"),
        origin_native_session_id: row.get("origin_native_session_id"),
        source_message_ids: parse_string_vec(row.get::<String, _>("source_message_ids_json"))?,
        linked_memory_ids: parse_string_vec(row.get::<String, _>("linked_memory_ids_json"))?,
        policy_result: parse_json(row.get::<String, _>("policy_result_json"))?,
        priority: row.get("priority"),
        pinned: row.get::<i64, _>("pinned") != 0,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_used_at: row.get("last_used_at"),
        expires_at: row.get("expires_at"),
        metadata: parse_json(row.get::<String, _>("metadata_json"))?,
        deleted_at: row.get("deleted_at"),
        revision: row.get("revision"),
    })
}

fn parse_json(raw: String) -> Result<Value, sqlx::Error> {
    serde_json::from_str(&raw).map_err(|error| sqlx::Error::Decode(Box::new(error)))
}

fn parse_string_vec(raw: String) -> Result<Vec<String>, sqlx::Error> {
    let value = parse_json(raw)?;
    Ok(value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

fn json_array(values: &[String]) -> String {
    Value::Array(values.iter().cloned().map(Value::String).collect()).to_string()
}

fn value_string_vec(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn object_or_empty(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}

fn normalize_scopes(scopes: Vec<String>) -> Vec<String> {
    scopes
        .into_iter()
        .map(|scope| normalize_scope(Some(&scope), ""))
        .filter(|scope| !scope.is_empty())
        .collect()
}

fn normalize_scope(value: Option<&str>, fallback: &str) -> String {
    let scope = value.unwrap_or_default().trim().to_lowercase();
    if VALID_SCOPES.contains(&scope.as_str()) {
        scope
    } else {
        fallback.to_string()
    }
}

fn normalize_priority(value: Option<i64>, fallback: i64) -> i64 {
    value.unwrap_or(fallback).clamp(-100, 100)
}

fn clean_text(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace("## Mia Bot Memory", "Mia Bot Memory")
        .replace('\r', "")
        .trim()
        .to_string()
}

fn normalize_text(value: &str) -> String {
    clean_text(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn memory_hash(scope: &str, normalized_text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{scope}\n{normalized_text}"));
    format!("{:x}", hasher.finalize())
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn first_number(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
}

fn first_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_i64))
}

fn first_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
}

fn sync_entry_id(value: &Value) -> String {
    first_string(value, &["id", "memoryId", "memory_id"]).unwrap_or_default()
}

fn normalize_sync_entry(user_id: &str, input: &Value) -> Option<MiaMemoryEntry> {
    let deleted_at = first_string(input, &["deletedAt", "deleted_at"]).unwrap_or_default();
    let text = if deleted_at.is_empty() {
        clean_text(first_string(input, &["text"]).unwrap_or_default())
    } else {
        String::new()
    };
    if deleted_at.is_empty() && text.is_empty() {
        return None;
    }
    let timestamp = now_iso();
    let updated_at =
        first_string(input, &["updatedAt", "updated_at"]).unwrap_or_else(|| timestamp.clone());
    let created_at =
        first_string(input, &["createdAt", "created_at"]).unwrap_or_else(|| updated_at.clone());
    let scope = normalize_scope(first_string(input, &["scope"]).as_deref(), "bot");
    let id = sync_entry_id(input);
    Some(MiaMemoryEntry {
        id: if id.is_empty() {
            format!("mem_{}", Uuid::now_v7().simple())
        } else {
            id
        },
        user_id: clean_text(user_id),
        bot_id: first_string(input, &["botId", "bot_id"]).unwrap_or_default(),
        session_id: first_string(input, &["sessionId", "session_id"]).unwrap_or_default(),
        scope,
        text,
        confidence: first_number(input, &["confidence"]).unwrap_or(1.0),
        source: first_string(input, &["source"]).unwrap_or_else(|| "cloud_sync".to_string()),
        origin_engine: first_string(input, &["originEngine", "origin_engine"]).unwrap_or_default(),
        origin_native_session_id: first_string(
            input,
            &["originNativeSessionId", "origin_native_session_id"],
        )
        .unwrap_or_default(),
        source_message_ids: value_string_vec(
            input
                .get("sourceMessageIds")
                .or_else(|| input.get("source_message_ids")),
        ),
        linked_memory_ids: value_string_vec(
            input
                .get("linkedMemoryIds")
                .or_else(|| input.get("linked_memory_ids")),
        ),
        policy_result: object_or_empty(
            input
                .get("policyResult")
                .or_else(|| input.get("policy_result"))
                .unwrap_or(&Value::Null),
        ),
        priority: normalize_priority(first_i64(input, &["priority"]), 0),
        pinned: first_bool(input, &["pinned"]).unwrap_or(false),
        created_at,
        updated_at,
        last_used_at: first_string(input, &["lastUsedAt", "last_used_at"]).unwrap_or_default(),
        expires_at: first_string(input, &["expiresAt", "expires_at"]).unwrap_or_default(),
        metadata: object_or_empty(input.get("metadata").unwrap_or(&Value::Null)),
        deleted_at,
        revision: first_i64(input, &["revision"]).unwrap_or(1).max(1),
    })
}

fn is_visible_to_context(entry: &MiaMemoryEntry, context: &MemoryContext) -> bool {
    if entry.user_id != context.user_id {
        return false;
    }
    match entry.scope.as_str() {
        "user" => true,
        "bot" => entry.bot_id == context.bot_id,
        "session" => entry.bot_id == context.bot_id && entry.session_id == context.session_id,
        _ => false,
    }
}

fn not_found_response(message: &str) -> MiaMemoryMutationResponse {
    MiaMemoryMutationResponse {
        status: "not_found".to_string(),
        disabled: None,
        reason: None,
        error: Some(message.to_string()),
        effective_scope: None,
        policy_reason: None,
        memory_id: None,
        memory: None,
        matches: Vec::new(),
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| now_ms().to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub fn disabled_search_response() -> MiaMemorySearchResponse {
    MiaMemorySearchResponse {
        memories: Vec::new(),
        disabled: Some(true),
        reason: Some("mia_memory_disabled".to_string()),
    }
}

pub fn disabled_mutation_response() -> MiaMemoryMutationResponse {
    MiaMemoryMutationResponse {
        status: "disabled".to_string(),
        disabled: Some(true),
        reason: Some("mia_memory_disabled".to_string()),
        error: Some("Mia memory is disabled.".to_string()),
        effective_scope: None,
        policy_reason: None,
        memory_id: None,
        memory: None,
        matches: Vec::new(),
    }
}
