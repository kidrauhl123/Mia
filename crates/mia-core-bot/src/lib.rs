//! Bot identity, capability, and runtime binding boundary for Mia Rust Core.

use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

use mia_core_api_types::{
    BotCapabilityGroup, BotCapabilityIntent, BotCapabilityOption, BotCapabilityOptionsRequest,
    BotCapabilityOptionsResponse, BotCapabilityPresetInput, BotCapabilitySkillInput,
    BotListResponse, BotResponse, BotRuntimeControlIntent, BotRuntimeControlOption,
    BotRuntimeControlOptionsRequest, BotRuntimeControlOptionsResponse, BotRuntimeModelEntryIntent,
    BotRuntimeResponse, BotRuntimeSyncIntent, BotRuntimeTargetGroup, BotRuntimeTargetIntent,
    BotRuntimeTargetOption, BotRuntimeTargetOptionsRequest, BotRuntimeTargetOptionsResponse,
    BotSummary, CreateBotRequest, EmptyResponse, EnsureBotSessionConversationRequest,
    EnsureBotSessionConversationResponse, SaveBotRuntimeRequest, StarterBotEnsureRequest,
    StarterBotEnsureResponse, StarterBotMutation, UpdateBotRequest,
};
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

pub const EVENT_BOT_UPDATED: &str = "bot.updated";

#[derive(Clone, Debug)]
pub struct BotService {
    pool: SqlitePool,
}

impl BotService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list_bots(&self) -> Result<BotListResponse, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, display_name, identity_json, capability_json FROM bots ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(BotListResponse {
            bots: rows
                .into_iter()
                .map(bot_summary_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    pub async fn create_bot(&self, request: CreateBotRequest) -> Result<BotResponse, sqlx::Error> {
        let id = format!("bot_{}", Uuid::now_v7().simple());
        let now = now_ms();
        sqlx::query(
            "INSERT INTO bots (id, display_name, identity_json, capability_json, avatar_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, '{}', ?, ?)",
        )
        .bind(&id)
        .bind(&request.display_name)
        .bind(request.identity.to_string())
        .bind(request.capabilities.to_string())
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_bot(&id).await
    }

    pub async fn get_bot(&self, bot_id: &str) -> Result<BotResponse, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, display_name, identity_json, capability_json FROM bots WHERE id = ?",
        )
        .bind(bot_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(BotResponse {
            bot: bot_summary_from_row(row)?,
        })
    }

    pub async fn update_bot(
        &self,
        bot_id: &str,
        request: UpdateBotRequest,
    ) -> Result<BotResponse, sqlx::Error> {
        let current = self.get_bot(bot_id).await?.bot;
        let display_name = request.display_name.unwrap_or(current.display_name);
        let identity = request.identity.unwrap_or(current.identity);
        let capabilities = request.capabilities.unwrap_or(current.capabilities);
        sqlx::query(
            "UPDATE bots SET display_name = ?, identity_json = ?, capability_json = ?, updated_at = ? WHERE id = ?",
        )
        .bind(display_name)
        .bind(identity.to_string())
        .bind(capabilities.to_string())
        .bind(now_ms())
        .bind(bot_id)
        .execute(&self.pool)
        .await?;
        self.get_bot(bot_id).await
    }

    pub async fn delete_bot(&self, bot_id: &str) -> Result<EmptyResponse, sqlx::Error> {
        let _ = self.get_bot(bot_id).await?;
        sqlx::query("DELETE FROM bots WHERE id = ?")
            .bind(bot_id)
            .execute(&self.pool)
            .await?;
        Ok(EmptyResponse { ok: true })
    }

    pub async fn ensure_starter_bots(
        &self,
        request: StarterBotEnsureRequest,
    ) -> Result<StarterBotEnsureResponse, sqlx::Error> {
        let runtime = object_from_value(request.runtime);
        if !nested_bool(&runtime, &["cloud"], "enabled") {
            return Ok(StarterBotEnsureResponse {
                skipped: true,
                created: Vec::new(),
                updated: Vec::new(),
                settings: self.read_user_settings().await?,
            });
        }

        let mut settings = self.read_user_settings().await?;
        let marker = starter_marker(&settings);
        let seeded_ids = seeded_starter_engine_ids(&marker);
        let all_specs = starter_bot_specs(&runtime);
        let specs = if starter_marker_seeded(&marker) {
            all_specs
                .iter()
                .filter(|spec| {
                    spec.engine_id == "cloud-claude-code" && !seeded_ids.contains(&spec.engine_id)
                })
                .cloned()
                .collect::<Vec<_>>()
        } else {
            all_specs.clone()
        };
        if all_specs.is_empty() {
            return Ok(StarterBotEnsureResponse {
                skipped: true,
                created: Vec::new(),
                updated: Vec::new(),
                settings,
            });
        }

        let user_id = request
            .user_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| runtime_user_id(&runtime))
            .unwrap_or_else(|| "local".to_string());
        let now = request
            .now
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| now_ms().to_string());
        let device_id = nested_string(&runtime, &["localDevice"], &["id"])
            .or_else(|| nested_string(&runtime, &["cloud"], &["deviceId", "device_id"]))
            .unwrap_or_default();
        let device_name = nested_string(
            &runtime,
            &["localDevice"],
            &["name", "deviceName", "device_name"],
        )
        .or_else(|| nested_string(&runtime, &["cloud"], &["deviceName", "device_name"]))
        .map(|value| compact_device_name(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "当前设备".to_string());

        let mut created = Vec::new();
        let mut updated = Vec::new();
        let mut cloud_tag_assignments = Vec::new();
        let create_engine_ids: HashSet<String> =
            specs.iter().map(|spec| spec.engine_id.clone()).collect();
        for spec in &all_specs {
            let key = starter_bot_key(&user_id, spec.key_suffix());
            if self.bot_exists(&key).await? {
                if !self.starter_bot_needs_repair(&key, spec).await? {
                    continue;
                }
                let bot = self.upsert_starter_bot(&key, spec, now_ms()).await?;
                self.save_runtime(
                    &key,
                    starter_runtime_request(spec, &device_id, &device_name),
                )
                .await?;
                let conversation_id = self.ensure_starter_conversation(&key, spec).await?;
                if !spec.tag_names.is_empty() {
                    cloud_tag_assignments.push((conversation_id.clone(), spec.tag_names.clone()));
                }
                updated.push(StarterBotMutation {
                    engine_id: spec.engine_id.clone(),
                    key,
                    bot,
                    conversation_id,
                });
                continue;
            }
            if !create_engine_ids.contains(&spec.engine_id) {
                continue;
            }
            let bot = self.upsert_starter_bot(&key, spec, now_ms()).await?;
            self.save_runtime(
                &key,
                starter_runtime_request(spec, &device_id, &device_name),
            )
            .await?;
            let conversation_id = self.ensure_starter_conversation(&key, spec).await?;
            if !spec.tag_names.is_empty() {
                cloud_tag_assignments.push((conversation_id.clone(), spec.tag_names.clone()));
            }
            created.push(StarterBotMutation {
                engine_id: spec.engine_id.clone(),
                key,
                bot,
                conversation_id,
            });
        }

        if created.is_empty() && updated.is_empty() {
            return Ok(StarterBotEnsureResponse {
                skipped: true,
                created,
                updated,
                settings,
            });
        }

        let marker = starter_marker_value(&marker, &seeded_ids, &all_specs, &specs, &now);
        set_object_field(&mut settings, "starterEngineBots", marker);
        for (conversation_id, tag_names) in cloud_tag_assignments {
            settings = assign_tag_names(settings, &conversation_id, &tag_names);
        }
        self.write_user_settings(settings.clone()).await?;
        Ok(StarterBotEnsureResponse {
            skipped: false,
            created,
            updated,
            settings,
        })
    }

    pub async fn save_runtime(
        &self,
        bot_id: &str,
        request: SaveBotRuntimeRequest,
    ) -> Result<BotRuntimeResponse, sqlx::Error> {
        let _ = self.get_bot(bot_id).await?;
        let config = if request.target_intent.is_some()
            || request.sync_intent.is_some()
            || request.control_intent.is_some()
        {
            let existing = self
                .existing_runtime_config(bot_id, &request.runtime_kind)
                .await?;
            let mut config = if let Some(intent) = request.target_intent.as_ref() {
                runtime_config_from_target_intent(
                    &request.runtime_kind,
                    existing,
                    &request.config,
                    intent,
                )
            } else {
                merge_config(existing, &request.config)
            };
            if let Some(intent) = request.sync_intent.as_ref() {
                config = runtime_config_from_sync_intent(&request.runtime_kind, config, intent);
            }
            if let Some(intent) = request.control_intent.as_ref() {
                config = runtime_config_from_control_intent(&request.runtime_kind, config, intent);
            }
            config
        } else {
            request.config
        };
        let provider_connection_id = request.provider_connection_id.or_else(|| {
            config_string(&config, &["providerConnectionId", "provider_connection_id"])
        });
        let model_profile_id = request
            .model_profile_id
            .or_else(|| config_string(&config, &["modelProfileId", "model_profile_id"]));
        let model = request.model.or_else(|| config_string(&config, &["model"]));
        let projection = runtime_binding_projection(&request.runtime_kind, &config);
        let binding = json!({
            "runtimeKind": projection.runtime_kind,
            "agentEngine": projection.agent_engine,
            "targetDeviceId": projection.target_device_id,
            "targetDeviceName": projection.target_device_name,
            "runtimeLabel": projection.runtime_label,
            "providerConnectionId": provider_connection_id,
            "modelProfileId": model_profile_id,
            "model": model,
            "config": config,
        });
        sqlx::query(
            "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(bot_id) DO UPDATE SET runtime_kind = excluded.runtime_kind, binding_json = excluded.binding_json, updated_at = excluded.updated_at",
        )
        .bind(bot_id)
        .bind(&request.runtime_kind)
        .bind(binding.to_string())
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(BotRuntimeResponse {
            bot_id: bot_id.to_string(),
            runtime_kind: request.runtime_kind,
            binding,
        })
    }

    pub async fn get_runtime(
        &self,
        bot_id: &str,
        runtime_kind: &str,
    ) -> Result<BotRuntimeResponse, sqlx::Error> {
        let runtime_kind = normalize_runtime_kind(runtime_kind);
        let row = sqlx::query(
            "SELECT runtime_kind, binding_json FROM bot_runtime_bindings WHERE bot_id = ? AND runtime_kind = ?",
        )
        .bind(bot_id)
        .bind(&runtime_kind)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(BotRuntimeResponse {
                bot_id: bot_id.to_string(),
                runtime_kind: runtime_kind.clone(),
                binding: default_runtime_binding(&runtime_kind),
            });
        };
        Ok(BotRuntimeResponse {
            bot_id: bot_id.to_string(),
            runtime_kind: row.get("runtime_kind"),
            binding: parse_json(row.get::<String, _>("binding_json"))?,
        })
    }

    pub fn runtime_target_options(
        &self,
        request: BotRuntimeTargetOptionsRequest,
    ) -> BotRuntimeTargetOptionsResponse {
        runtime_target_options_from_request(request)
    }

    pub fn runtime_control_options(
        &self,
        request: BotRuntimeControlOptionsRequest,
    ) -> BotRuntimeControlOptionsResponse {
        runtime_control_options_from_request(request)
    }

    pub fn capability_options(
        &self,
        request: BotCapabilityOptionsRequest,
    ) -> BotCapabilityOptionsResponse {
        capability_options_from_request(request)
    }

    pub async fn ensure_session_conversation(
        &self,
        bot_id: &str,
        request: EnsureBotSessionConversationRequest,
    ) -> Result<EnsureBotSessionConversationResponse, sqlx::Error> {
        let _ = self.get_bot(bot_id).await?;
        if let Some(existing) = self
            .find_session_conversation(bot_id, &request.session_id)
            .await?
        {
            return Ok(EnsureBotSessionConversationResponse {
                conversation_id: existing,
                created: false,
            });
        }

        let conversation_id = format!("conv_{}", Uuid::now_v7().simple());
        let now = now_ms();
        let mut metadata = match request.metadata {
            Value::Object(object) => Value::Object(object),
            _ => json!({}),
        };
        if let Value::Object(object) = &mut metadata {
            object.insert("sessionId".to_string(), Value::String(request.session_id));
        }
        let runtime = json!({ "runtimeKind": request.runtime_kind });
        sqlx::query(
            "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at) \
             VALUES (?, 'bot_session', ?, ?, ?, ?, ?, ?)",
        )
        .bind(&conversation_id)
        .bind(request.title.unwrap_or_else(|| "Bot Session".to_string()))
        .bind(bot_id)
        .bind(runtime.to_string())
        .bind(metadata.to_string())
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(EnsureBotSessionConversationResponse {
            conversation_id,
            created: true,
        })
    }

    async fn find_session_conversation(
        &self,
        bot_id: &str,
        session_id: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, metadata_json FROM conversations WHERE bot_id = ? AND kind = 'bot_session' ORDER BY created_at ASC",
        )
        .bind(bot_id)
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            let metadata = parse_json(row.get::<String, _>("metadata_json"))?;
            if metadata.get("sessionId").and_then(Value::as_str) == Some(session_id) {
                return Ok(Some(row.get("id")));
            }
        }
        Ok(None)
    }

    async fn existing_runtime_config(
        &self,
        bot_id: &str,
        runtime_kind: &str,
    ) -> Result<Value, sqlx::Error> {
        let row = sqlx::query(
            "SELECT binding_json FROM bot_runtime_bindings WHERE bot_id = ? AND runtime_kind = ?",
        )
        .bind(bot_id)
        .bind(runtime_kind)
        .fetch_optional(&self.pool)
        .await?;
        let binding = row
            .and_then(|row| {
                serde_json::from_str::<Value>(&row.get::<String, _>("binding_json")).ok()
            })
            .unwrap_or_else(|| json!({}));
        Ok(binding
            .get("config")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})))
    }

    async fn bot_exists(&self, bot_id: &str) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(1) FROM bots WHERE id = ?")
            .bind(bot_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(count > 0)
    }

    async fn starter_bot_needs_repair(
        &self,
        bot_id: &str,
        spec: &StarterBotSpec,
    ) -> Result<bool, sqlx::Error> {
        let row = sqlx::query("SELECT identity_json FROM bots WHERE id = ?")
            .bind(bot_id)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let identity = parse_json(row.get::<String, _>("identity_json"))?;
        let identity_agent = identity
            .get("agentEngine")
            .or_else(|| identity.get("agent_engine"))
            .and_then(Value::as_str)
            .map(normalize_agent_engine)
            .unwrap_or_default();
        if identity_agent != spec.agent_engine {
            return Ok(true);
        }
        let identity_runtime = identity
            .get("runtimeKind")
            .or_else(|| identity.get("runtime_kind"))
            .and_then(Value::as_str)
            .map(normalize_runtime_kind)
            .unwrap_or_default();
        if identity_runtime != spec.runtime_kind {
            return Ok(true);
        }

        let binding_row = sqlx::query(
            "SELECT binding_json FROM bot_runtime_bindings WHERE bot_id = ? AND runtime_kind = ?",
        )
        .bind(bot_id)
        .bind(&spec.runtime_kind)
        .fetch_optional(&self.pool)
        .await?;
        let Some(binding_row) = binding_row else {
            return Ok(true);
        };
        let binding = parse_json(binding_row.get::<String, _>("binding_json"))?;
        let config = object_from_value(
            binding
                .get("config")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({})),
        );
        let binding_agent = first_map_string(&config, &["agentEngine", "agent_engine", "engine"])
            .map(|value| normalize_agent_engine(&value))
            .unwrap_or_else(|| default_agent_engine(&spec.runtime_kind).to_string());
        if binding_agent != spec.agent_engine {
            return Ok(true);
        }
        if spec.runtime_kind == "cloud-claude-code" && !runtime_config_is_mia_managed(&config) {
            return Ok(true);
        }
        Ok(false)
    }

    async fn upsert_starter_bot(
        &self,
        bot_id: &str,
        spec: &StarterBotSpec,
        now: i64,
    ) -> Result<BotSummary, sqlx::Error> {
        sqlx::query(
            "INSERT INTO bots (id, display_name, identity_json, capability_json, avatar_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, '{}', ?, ?) \
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, identity_json = excluded.identity_json, capability_json = excluded.capability_json, updated_at = excluded.updated_at",
        )
        .bind(bot_id)
        .bind(&spec.name)
        .bind(starter_identity_json(spec).to_string())
        .bind(json!({ "inheritEngineDefaults": true }).to_string())
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_bot(bot_id).await.map(|response| response.bot)
    }

    async fn ensure_starter_conversation(
        &self,
        bot_id: &str,
        spec: &StarterBotSpec,
    ) -> Result<String, sqlx::Error> {
        let conversation_id = format!("botc_{bot_id}");
        let now = now_ms();
        sqlx::query(
            "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at) \
             VALUES (?, 'bot_session', ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, bot_id = excluded.bot_id, runtime_json = excluded.runtime_json, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at",
        )
        .bind(&conversation_id)
        .bind(&spec.name)
        .bind(bot_id)
        .bind(json!({ "runtimeKind": spec.runtime_kind }).to_string())
        .bind(json!({ "sessionId": bot_id, "starterEngineId": spec.engine_id }).to_string())
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(conversation_id)
    }

    async fn read_user_settings(&self) -> Result<Value, sqlx::Error> {
        let row = sqlx::query("SELECT value_json FROM cloud_state WHERE key = 'user_settings'")
            .fetch_optional(&self.pool)
            .await?;
        let value = row
            .map(|row| parse_json(row.get::<String, _>("value_json")))
            .transpose()?
            .unwrap_or_else(default_user_settings);
        Ok(normalize_user_settings(value))
    }

    async fn write_user_settings(&self, settings: Value) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO cloud_state (key, value_json, updated_at) VALUES ('user_settings', ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .bind(settings.to_string())
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

const CLOUD_MIA_TAG_NAME: &str = "云端";

#[derive(Debug, Clone)]
struct StarterBotSpec {
    engine_id: String,
    runtime_kind: String,
    agent_engine: String,
    name: String,
    color: String,
    avatar_image: String,
    avatar_crop: Value,
    bio: String,
    description: String,
    persona_text: String,
    status_badge: Value,
    tag_names: Vec<String>,
}

impl StarterBotSpec {
    fn key_suffix(&self) -> &str {
        if self.engine_id == "cloud-claude-code" {
            "mia"
        } else {
            &self.engine_id
        }
    }
}

fn starter_runtime_request(
    spec: &StarterBotSpec,
    device_id: &str,
    device_name: &str,
) -> SaveBotRuntimeRequest {
    let runtime_kind = spec.runtime_kind.clone();
    let (target_device_id, target_device_name) = if runtime_kind == "cloud-claude-code" {
        (None, None)
    } else {
        (Some(device_id.to_string()), Some(device_name.to_string()))
    };
    SaveBotRuntimeRequest {
        runtime_kind,
        provider_connection_id: None,
        model_profile_id: None,
        model: None,
        target_intent: Some(BotRuntimeTargetIntent {
            device_id: target_device_id,
            device_name: target_device_name,
            agent_engine: Some(spec.agent_engine.clone()),
        }),
        sync_intent: None,
        control_intent: None,
        config: json!({}),
    }
}

fn starter_bot_specs(runtime: &Map<String, Value>) -> Vec<StarterBotSpec> {
    let mut specs = Vec::new();
    let cloud_runtime = cloud_agent_runtime(runtime);
    if nested_bool(runtime, &["cloud"], "enabled") && cloud_runtime.available {
        let cloud_label = cloud_agent_runtime_label(runtime)
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| engine_label(&cloud_runtime.agent_engine));
        specs.push(StarterBotSpec {
            engine_id: "cloud-claude-code".to_string(),
            runtime_kind: "cloud-claude-code".to_string(),
            agent_engine: cloud_runtime.agent_engine,
            name: "Mia".to_string(),
            color: "#16a34a".to_string(),
            avatar_image: "./assets/mia-logo.png".to_string(),
            avatar_crop: Value::Null,
            bio: format!("云端 {cloud_label}，随时可用，不依赖本机 Agent。"),
            description: format!("Mia 云端助手，默认使用云端 {cloud_label} sandbox。"),
            persona_text: format!(
                "你是 Mia。用云端 {cloud_label} sandbox 简洁、可靠地帮助用户处理日常问题、创作、信息整理和自动化请求。"
            ),
            status_badge: starter_status_badge("cloud-claude-code"),
            tag_names: vec![CLOUD_MIA_TAG_NAME.to_string()],
        });
    }

    for engine in ["hermes", "codex", "claude-code"] {
        if !(inventory_engine_usable(runtime, engine) || legacy_engine_available(runtime, engine)) {
            continue;
        }
        specs.push(local_starter_spec(engine));
    }
    specs
}

fn local_starter_spec(engine: &str) -> StarterBotSpec {
    let (name, color, bio, persona_text) = match engine {
        "codex" => (
            "Codex",
            "#111827",
            "连接本机 Codex，适合代码、调试和工程自动化。",
            "你是 Codex。专注代码阅读、修改、调试、测试和工程自动化，先理解上下文再行动。",
        ),
        "claude-code" => (
            "Claude Code",
            "#7c2d12",
            "连接本机 Claude Code，适合代码任务和长上下文协作。",
            "你是 Claude Code。专注代码任务、重构、解释和长上下文协作，保持清晰、稳健和可验证。",
        ),
        _ => (
            "Hermes",
            "#2563eb",
            "连接本机 Hermes，处理日常任务、文件和自动化。",
            "你是 Hermes。优先用本机可用能力推进用户的日常任务、文件处理和自动化请求。",
        ),
    };
    StarterBotSpec {
        engine_id: engine.to_string(),
        runtime_kind: "desktop-local".to_string(),
        agent_engine: engine.to_string(),
        name: name.to_string(),
        color: color.to_string(),
        avatar_image: starter_avatar_image(engine).to_string(),
        avatar_crop: Value::Null,
        bio: bio.to_string(),
        description: bio.to_string(),
        persona_text: persona_text.to_string(),
        status_badge: starter_status_badge(engine),
        tag_names: Vec::new(),
    }
}

fn starter_identity_json(spec: &StarterBotSpec) -> Value {
    json!({
        "name": spec.name,
        "avatarImage": spec.avatar_image,
        "avatarCrop": spec.avatar_crop,
        "color": spec.color,
        "statusBadge": spec.status_badge,
        "bio": spec.bio,
        "description": spec.description,
        "personaText": spec.persona_text,
        "agentEngine": spec.agent_engine,
        "runtimeKind": spec.runtime_kind,
        "targetDeviceId": "",
        "targetDeviceName": if spec.runtime_kind == "cloud-claude-code" { "Mia Cloud" } else { "" }
    })
}

fn starter_status_badge(engine: &str) -> Value {
    let (asset_id, label) = match engine {
        "cloud-claude-code" => ("rainbow-fire", "七彩火焰"),
        "codex" => ("cyan-fire", "青色火焰"),
        "claude-code" => ("red-orange-fire", "红橙火焰"),
        _ => ("blue-fire", "蓝色火焰"),
    };
    json!({ "kind": "lottie", "assetId": asset_id, "label": label, "loop": "always" })
}

fn starter_avatar_image(engine: &str) -> &'static str {
    match engine {
        "cloud-claude-code" => "./assets/mia-logo.png",
        "codex" => "./assets/engine-icons/codex-color.svg",
        "claude-code" => "./assets/engine-icons/claudecode-starter.svg",
        _ => "./assets/engine-icons/hermesagent-starter.svg",
    }
}

fn cloud_agent_runtime_label(runtime: &Map<String, Value>) -> Option<String> {
    runtime
        .get("cloud")
        .and_then(Value::as_object)
        .and_then(|cloud| {
            first_nested_object(
                cloud,
                &[
                    "agentRuntime",
                    "agent_runtime",
                    "cloudAgent",
                    "cloud_agent",
                    "agent",
                ],
            )
        })
        .and_then(|source| first_map_string(source, &["label", "name"]))
}

fn runtime_user_id(runtime: &Map<String, Value>) -> Option<String> {
    nested_string(
        runtime,
        &["cloud"],
        &["userId", "user_id", "accountId", "account_id"],
    )
    .or_else(|| {
        runtime
            .get("cloud")
            .and_then(Value::as_object)
            .and_then(|cloud| first_nested_object(cloud, &["user", "account"]))
            .and_then(|user| first_map_string(user, &["id", "userId", "user_id"]))
    })
}

fn starter_bot_key(user_id: &str, engine_id: &str) -> String {
    format!(
        "starter_{}_{}",
        stable_user_key(user_id),
        stable_user_key(engine_id)
    )
}

fn stable_user_key(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            last_was_separator = false;
        } else if !last_was_separator && !output.is_empty() {
            output.push('_');
            last_was_separator = true;
        }
        if output.len() >= 48 {
            break;
        }
    }
    while output.ends_with('_') {
        output.pop();
    }
    if output.is_empty() {
        "local".to_string()
    } else {
        output
    }
}

fn starter_marker(settings: &Value) -> Map<String, Value> {
    settings
        .get("starterEngineBots")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn starter_marker_seeded(marker: &Map<String, Value>) -> bool {
    marker
        .get("seededAt")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn seeded_starter_engine_ids(marker: &Map<String, Value>) -> Vec<String> {
    marker
        .get("engineIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(normalize_agent_or_cloud_engine)
        .filter(|value| !value.is_empty())
        .fold(Vec::new(), |mut ids, id| {
            if !ids.iter().any(|existing| existing == &id) {
                ids.push(id);
            }
            ids
        })
}

fn normalize_agent_or_cloud_engine(value: &str) -> String {
    let id = value.trim().to_ascii_lowercase().replace('_', "-");
    if matches!(id.as_str(), "cloud-claude-code" | "mia-cloud" | "miacloud") {
        "cloud-claude-code".to_string()
    } else {
        normalize_agent_engine(&id)
    }
}

fn starter_marker_value(
    existing_marker: &Map<String, Value>,
    seeded_ids: &[String],
    all_specs: &[StarterBotSpec],
    created_specs: &[StarterBotSpec],
    now: &str,
) -> Value {
    let mut engine_ids = seeded_ids.to_vec();
    let source = if starter_marker_seeded(existing_marker) {
        created_specs
    } else {
        all_specs
    };
    for spec in source {
        if !engine_ids.iter().any(|id| id == &spec.engine_id) {
            engine_ids.push(spec.engine_id.clone());
        }
    }
    json!({
        "seededAt": existing_marker
            .get("seededAt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(now),
        "engineIds": engine_ids
    })
}

fn default_user_settings() -> Value {
    json!({
        "pins": [],
        "readMarks": {},
        "appearance": {},
        "mutedConversations": [],
        "unreadOverrides": {},
        "tags": { "items": [], "assignments": {} },
        "starterEngineBots": {},
        "version": 1
    })
}

fn normalize_user_settings(value: Value) -> Value {
    let mut object = object_from_value(value);
    let defaults = object_from_value(default_user_settings());
    for (key, value) in defaults {
        object.entry(key).or_insert(value);
    }
    Value::Object(object)
}

fn assign_tag_names(mut settings: Value, conversation_id: &str, tag_names: &[String]) -> Value {
    let target = conversation_id.trim();
    if target.is_empty() || tag_names.is_empty() {
        return settings;
    }
    let mut tags = settings
        .get("tags")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut items = tags
        .remove("items")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut assignments = tags
        .remove("assignments")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut assigned_ids = Vec::new();
    for name in tag_names {
        let clean = name.trim();
        if clean.is_empty() {
            continue;
        }
        let existing_id = items.iter().find_map(|item| {
            let object = item.as_object()?;
            (first_map_string(object, &["name"])?.eq_ignore_ascii_case(clean))
                .then(|| first_map_string(object, &["id"]))
                .flatten()
        });
        let id = existing_id.unwrap_or_else(|| format!("tag_{}", stable_user_key(clean)));
        if !items.iter().any(|item| {
            item.as_object()
                .and_then(|object| first_map_string(object, &["id"]))
                .as_deref()
                == Some(id.as_str())
        }) {
            items.push(json!({ "id": id, "name": clean, "color": "#2563eb" }));
        }
        if !assigned_ids.iter().any(|existing| existing == &id) {
            assigned_ids.push(id);
        }
    }
    assignments.insert(target.to_string(), json!(assigned_ids));
    set_object_field(
        &mut settings,
        "tags",
        json!({ "items": items, "assignments": assignments }),
    );
    settings
}

fn set_object_field(value: &mut Value, key: &str, field_value: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Value::Object(object) = value {
        object.insert(key.to_string(), field_value);
    }
}

fn runtime_config_from_target_intent(
    runtime_kind: &str,
    existing: Value,
    patch: &Value,
    intent: &BotRuntimeTargetIntent,
) -> Value {
    let mut config = object_from_value(existing);
    merge_object_patch(&mut config, patch);
    let kind = normalize_runtime_kind(runtime_kind);
    let engine = clean_optional(&intent.agent_engine)
        .or_else(|| map_string(&config, "agentEngine"))
        .or_else(|| map_string(&config, "agent_engine"))
        .unwrap_or_else(|| default_agent_engine(&kind).to_string());
    config.insert(
        "agentEngine".to_string(),
        json!(normalize_agent_engine(&engine)),
    );
    config.remove("agent_engine");
    if kind == "cloud-claude-code" {
        if !has_non_empty(&config, "model") {
            config.insert("model".to_string(), json!("mia-auto"));
        }
        if !has_non_empty(&config, "effortLevel") {
            config.insert("effortLevel".to_string(), json!("medium"));
        }
        if !has_non_empty(&config, "permissionMode") {
            config.insert("permissionMode".to_string(), json!("bypassPermissions"));
        }
        return sanitize_runtime_config(Value::Object(config));
    }
    if let Some(device_id) = clean_optional(&intent.device_id) {
        config.insert("deviceId".to_string(), json!(device_id));
    }
    if let Some(device_name) = clean_optional(&intent.device_name) {
        config.insert(
            "deviceName".to_string(),
            json!(compact_device_name(&device_name)),
        );
    }
    config.remove("device_id");
    config.remove("device_name");
    Value::Object(config)
}

fn runtime_config_from_control_intent(
    _runtime_kind: &str,
    existing: Value,
    intent: &BotRuntimeControlIntent,
) -> Value {
    let mut config = object_from_value(existing);
    match normalized_control_field(&intent.field).as_str() {
        "model" => apply_model_control(&mut config, intent),
        "effortLevel" => {
            config.insert("effortLevel".to_string(), json!(intent.value.trim()));
        }
        "permissionMode" => {
            config.insert("permissionMode".to_string(), json!(intent.value.trim()));
        }
        _ => {}
    }
    sanitize_runtime_config(Value::Object(config))
}

fn runtime_config_from_sync_intent(
    runtime_kind: &str,
    existing: Value,
    intent: &BotRuntimeSyncIntent,
) -> Value {
    let existing = object_from_value(sanitize_runtime_config(existing));
    let kind = normalize_runtime_kind(runtime_kind);
    let engine = clean_optional(&intent.agent_engine)
        .or_else(|| map_string(&existing, "agentEngine"))
        .or_else(|| map_string(&existing, "agent_engine"))
        .unwrap_or_else(|| default_agent_engine(&kind).to_string());
    let engine = normalize_agent_engine(&engine);
    let mut config = Map::new();
    config.insert("agentEngine".to_string(), json!(engine.clone()));
    if let Some(device_id) = clean_optional(&intent.device_id) {
        config.insert("deviceId".to_string(), json!(device_id));
    }
    if let Some(device_name) = clean_optional(&intent.device_name) {
        config.insert(
            "deviceName".to_string(),
            json!(compact_device_name(&device_name)),
        );
    }

    let model_entries = sync_model_entries(&intent.model_entries, existing.get("modelEntries"));
    let is_external = engine != "hermes";
    if is_external {
        apply_sync_model_control(
            &mut config,
            clean_optional(&intent.model),
            &model_entries,
            true,
        );
        if let Some(effort_level) = clean_optional(&intent.effort_level) {
            config.insert("effortLevel".to_string(), json!(effort_level));
        }
    } else {
        let has_saved_selection = has_non_empty(&existing, "model")
            || has_non_empty(&existing, "providerConnectionId")
            || has_non_empty(&existing, "modelProfileId");
        if has_saved_selection {
            apply_existing_model_selection(&mut config, &existing);
        } else {
            apply_sync_model_control(
                &mut config,
                clean_optional(&intent.model),
                &model_entries,
                true,
            );
        }
        let effort_level = map_string(&existing, "effortLevel")
            .or_else(|| clean_optional(&intent.effort_level))
            .unwrap_or_else(|| "medium".to_string());
        let permission_mode = map_string(&existing, "permissionMode")
            .or_else(|| clean_optional(&intent.permission_mode))
            .unwrap_or_else(|| "ask".to_string());
        config.insert("effortLevel".to_string(), json!(effort_level));
        config.insert("permissionMode".to_string(), json!(permission_mode));
    }
    if !model_entries.is_empty() {
        config.insert("modelEntries".to_string(), Value::Array(model_entries));
    }
    sanitize_runtime_config(Value::Object(config))
}

fn apply_model_control(config: &mut Map<String, Value>, intent: &BotRuntimeControlIntent) {
    let value = intent.value.trim();
    let entry = model_entry_for_value(&intent.model_entries, value);
    let model = entry
        .and_then(|entry| clean_optional(&entry.model))
        .unwrap_or_else(|| value.to_string());
    let model = canonical_mia_model_id(&model);
    config.insert("model".to_string(), json!(model));

    let provider = entry
        .and_then(|entry| clean_optional(&entry.provider))
        .unwrap_or_default();
    let profile_id = entry
        .and_then(model_profile_id_from_entry)
        .or_else(|| {
            if provider.is_empty() || model.is_empty() {
                None
            } else {
                Some(format!("{provider}:{model}"))
            }
        })
        .map(|profile| canonical_mia_profile_id(&profile, &model));

    if !provider.is_empty() {
        config.insert("providerConnectionId".to_string(), json!(provider));
    }
    if let Some(profile_id) = profile_id.filter(|value| !value.is_empty()) {
        config.insert("modelProfileId".to_string(), json!(profile_id));
    }
}

fn apply_sync_model_control(
    config: &mut Map<String, Value>,
    model: Option<String>,
    entries: &[Value],
    fallback_to_first: bool,
) {
    let value = model.unwrap_or_default();
    let entry = sync_model_entry_for_value(entries, &value).or_else(|| {
        if fallback_to_first {
            entries.first()
        } else {
            None
        }
    });
    if let Some(entry) = entry.and_then(Value::as_object) {
        let model = sync_model_from_entry(entry, &value);
        let model = canonical_mia_model_id(&model);
        config.insert("model".to_string(), json!(model.clone()));
        if let Some(provider) = map_string(entry, "provider") {
            config.insert("providerConnectionId".to_string(), json!(provider.clone()));
            let profile_id = first_map_string(entry, &["modelProfileId", "profileId"])
                .or_else(|| {
                    if model.is_empty() {
                        None
                    } else {
                        Some(format!("{provider}:{model}"))
                    }
                })
                .map(|profile| canonical_mia_profile_id(&profile, &model));
            if let Some(profile_id) = profile_id.filter(|profile| !profile.is_empty()) {
                config.insert("modelProfileId".to_string(), json!(profile_id));
            }
        }
        return;
    }
    let model = canonical_mia_model_id(&value);
    config.insert("model".to_string(), json!(model));
}

fn apply_existing_model_selection(config: &mut Map<String, Value>, existing: &Map<String, Value>) {
    let model = map_string(existing, "model").unwrap_or_default();
    let model = canonical_mia_model_id(&model);
    config.insert("model".to_string(), json!(model.clone()));
    if let Some(provider) = map_string(existing, "providerConnectionId") {
        config.insert("providerConnectionId".to_string(), json!(provider.clone()));
        let profile_id = map_string(existing, "modelProfileId")
            .or_else(|| {
                if model.is_empty() {
                    None
                } else {
                    Some(format!("{provider}:{model}"))
                }
            })
            .map(|profile| canonical_mia_profile_id(&profile, &model));
        if let Some(profile_id) = profile_id.filter(|profile| !profile.is_empty()) {
            config.insert("modelProfileId".to_string(), json!(profile_id));
        }
    } else if let Some(profile_id) = map_string(existing, "modelProfileId") {
        config.insert(
            "modelProfileId".to_string(),
            json!(canonical_mia_profile_id(&profile_id, &model)),
        );
    }
}

fn sanitize_runtime_config(config: Value) -> Value {
    let mut object = object_from_value(config);
    if let Some(Value::Array(entries)) = object.remove("modelEntries") {
        let entries = entries
            .into_iter()
            .filter_map(sanitize_runtime_model_entry)
            .collect::<Vec<_>>();
        if !entries.is_empty() {
            object.insert("modelEntries".to_string(), Value::Array(entries));
        }
    }
    if let Some(model) = map_string(&object, "model").map(|value| canonical_mia_model_id(&value)) {
        object.insert("model".to_string(), json!(model));
    }
    let model = map_string(&object, "model").unwrap_or_default();
    let profile_id = map_string(&object, "modelProfileId")
        .or_else(|| map_string(&object, "model_profile_id"))
        .map(|value| canonical_mia_profile_id(&value, &model))
        .unwrap_or_default();
    let legacy_provider = map_string(&object, "provider")
        .or_else(|| map_string(&object, "modelProvider"))
        .or_else(|| map_string(&object, "model_provider"))
        .unwrap_or_default();
    let auth_type = map_string(&object, "authType")
        .or_else(|| map_string(&object, "auth_type"))
        .unwrap_or_default();
    if legacy_provider == "mia"
        || auth_type == "mia_account"
        || profile_id.starts_with("mia:")
        || model == "mia-auto"
        || model == "mia-default"
    {
        object.insert("providerConnectionId".to_string(), json!("mia"));
        let model = canonical_mia_model_id(&model);
        if !model.is_empty() {
            object.insert("model".to_string(), json!(model.clone()));
            object.insert("modelProfileId".to_string(), json!(format!("mia:{model}")));
        } else if !profile_id.is_empty() {
            object.insert("modelProfileId".to_string(), json!(profile_id));
        }
    }
    for key in [
        "provider",
        "modelProvider",
        "providerLabel",
        "authType",
        "apiKeyEnv",
        "baseUrl",
        "apiMode",
        "provider_label",
        "model_provider",
        "model_profile_id",
        "auth_type",
        "api_key_env",
        "base_url",
        "api_mode",
    ] {
        object.remove(key);
    }
    Value::Object(object)
}

fn runtime_config_is_mia_managed(config: &Map<String, Value>) -> bool {
    let sanitized = object_from_value(sanitize_runtime_config(Value::Object(config.clone())));
    map_string(&sanitized, "providerConnectionId").as_deref() == Some("mia")
        && map_string(&sanitized, "modelProfileId")
            .as_deref()
            .is_some_and(|value| value.starts_with("mia:"))
        && map_string(&sanitized, "model")
            .as_deref()
            .is_some_and(|value| !value.is_empty())
}

fn sync_model_entries(
    entries: &[BotRuntimeModelEntryIntent],
    existing: Option<&Value>,
) -> Vec<Value> {
    let mut entries = entries
        .iter()
        .filter_map(sanitize_runtime_model_entry_intent)
        .collect::<Vec<_>>();
    if let Some(Value::Array(existing_entries)) = existing {
        entries.extend(
            existing_entries
                .iter()
                .cloned()
                .filter_map(sanitize_runtime_model_entry),
        );
    }
    dedupe_model_entry_values(entries)
}

fn sanitize_runtime_model_entry_intent(entry: &BotRuntimeModelEntryIntent) -> Option<Value> {
    let mut output = Map::new();
    if let Some(id) = clean_optional(&entry.id) {
        output.insert("id".to_string(), json!(canonical_mia_model_id(&id)));
    }
    if let Some(value) = clean_optional(&entry.value) {
        output.insert("value".to_string(), json!(canonical_mia_model_id(&value)));
    }
    if let Some(label) = clean_optional(&entry.label) {
        output.insert("label".to_string(), json!(label));
    }
    if let Some(model) = entry.model.as_deref() {
        output.insert("model".to_string(), json!(canonical_mia_model_id(model)));
    }
    if let Some(provider) = clean_optional(&entry.provider) {
        output.insert("provider".to_string(), json!(provider));
    }
    if let Some(provider_label) = clean_optional(&entry.provider_label) {
        output.insert("providerLabel".to_string(), json!(provider_label));
    }
    if let Some(auth_type) = clean_optional(&entry.auth_type) {
        output.insert("authType".to_string(), json!(auth_type));
    }
    if let Some(profile_id) = model_profile_id_from_entry(entry) {
        let model = map_string(&output, "model")
            .or_else(|| map_string(&output, "value"))
            .or_else(|| map_string(&output, "id"))
            .unwrap_or_default();
        output.insert(
            "modelProfileId".to_string(),
            json!(canonical_mia_profile_id(&profile_id, &model)),
        );
    }
    if output.contains_key("id") || output.contains_key("value") || output.contains_key("model") {
        Some(Value::Object(output))
    } else {
        None
    }
}

fn sanitize_runtime_model_entry(entry: Value) -> Option<Value> {
    let source = object_from_value(entry);
    let mut output = Map::new();
    if let Some(id) = map_string(&source, "id") {
        output.insert("id".to_string(), json!(canonical_mia_model_id(&id)));
    }
    if let Some(value) = map_string(&source, "value") {
        output.insert("value".to_string(), json!(canonical_mia_model_id(&value)));
    }
    if let Some(label) = map_string(&source, "label") {
        output.insert("label".to_string(), json!(label));
    }
    if let Some(model) = source.get("model").and_then(Value::as_str) {
        output.insert("model".to_string(), json!(canonical_mia_model_id(model)));
    }
    if let Some(provider) = first_map_string(
        &source,
        &[
            "provider",
            "providerConnectionId",
            "provider_connection_id",
            "modelProvider",
            "model_provider",
        ],
    ) {
        output.insert("provider".to_string(), json!(provider));
    }
    if let Some(provider_label) = first_map_string(&source, &["providerLabel", "provider_label"]) {
        output.insert("providerLabel".to_string(), json!(provider_label));
    }
    if let Some(auth_type) = first_map_string(&source, &["authType", "auth_type"]) {
        output.insert("authType".to_string(), json!(auth_type));
    }
    if let Some(profile_id) = first_map_string(
        &source,
        &[
            "modelProfileId",
            "model_profile_id",
            "profileId",
            "profile_id",
        ],
    ) {
        let model = map_string(&output, "model")
            .or_else(|| map_string(&output, "value"))
            .or_else(|| map_string(&output, "id"))
            .unwrap_or_default();
        output.insert(
            "modelProfileId".to_string(),
            json!(canonical_mia_profile_id(&profile_id, &model)),
        );
    }
    if output.contains_key("id") || output.contains_key("value") || output.contains_key("model") {
        Some(Value::Object(output))
    } else {
        None
    }
}

fn dedupe_model_entry_values(entries: Vec<Value>) -> Vec<Value> {
    let mut output = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let identity = first_map_string(
            object,
            &[
                "provider",
                "providerConnectionId",
                "provider_connection_id",
                "modelProvider",
                "model_provider",
            ],
        )
        .unwrap_or_default()
            + ":"
            + &first_map_string(object, &["model", "value", "id"]).unwrap_or_default();
        if seen.insert(identity) {
            output.push(entry);
        }
    }
    output
}

fn sync_model_entry_for_value<'a>(entries: &'a [Value], value: &str) -> Option<&'a Value> {
    let wanted = value.trim();
    entries.iter().find(|entry| {
        let Some(object) = entry.as_object() else {
            return false;
        };
        ["id", "value", "model"].iter().any(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                == wanted
        })
    })
}

fn sync_model_from_entry(entry: &Map<String, Value>, fallback: &str) -> String {
    if let Some(model) = entry.get("model").and_then(Value::as_str) {
        return model.trim().to_string();
    }
    first_map_string(entry, &["value", "id"]).unwrap_or_else(|| fallback.trim().to_string())
}

fn merge_config(existing: Value, patch: &Value) -> Value {
    let mut config = object_from_value(existing);
    merge_object_patch(&mut config, patch);
    Value::Object(config)
}

fn object_from_value(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn merge_object_patch(target: &mut Map<String, Value>, patch: &Value) {
    if let Some(object) = patch.as_object() {
        for (key, value) in object {
            if !value.is_null() {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn normalize_runtime_kind(value: &str) -> String {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "cloud-claude-code" | "mia-cloud" | "miacloud" => "cloud-claude-code".to_string(),
        "agent" => "agent".to_string(),
        _ => "desktop-local".to_string(),
    }
}

fn default_agent_engine(runtime_kind: &str) -> &str {
    if runtime_kind == "cloud-claude-code" {
        "claude-code"
    } else {
        "hermes"
    }
}

struct RuntimeBindingProjection {
    runtime_kind: String,
    agent_engine: String,
    target_device_id: String,
    target_device_name: String,
    runtime_label: String,
}

fn runtime_binding_projection(runtime_kind: &str, config: &Value) -> RuntimeBindingProjection {
    let runtime_kind = normalize_runtime_kind(runtime_kind);
    let config = object_from_value(config.clone());
    let agent_engine = first_map_string(&config, &["agentEngine", "agent_engine", "engine"])
        .map(|engine| normalize_agent_engine(&engine))
        .unwrap_or_else(|| default_agent_engine(&runtime_kind).to_string());
    if runtime_kind == "cloud-claude-code" {
        return RuntimeBindingProjection {
            runtime_kind,
            agent_engine,
            target_device_id: String::new(),
            target_device_name: "Mia Cloud".to_string(),
            runtime_label: "Mia Cloud".to_string(),
        };
    }
    let target_device_id =
        first_map_string(&config, &["deviceId", "device_id"]).unwrap_or_default();
    let target_device_name = first_map_string(&config, &["deviceName", "device_name"])
        .map(|name| compact_device_name(&name))
        .unwrap_or_default();
    RuntimeBindingProjection {
        runtime_kind,
        agent_engine,
        target_device_id,
        runtime_label: target_device_name.clone(),
        target_device_name,
    }
}

fn default_runtime_binding(runtime_kind: &str) -> Value {
    let config = json!({});
    let projection = runtime_binding_projection(runtime_kind, &config);
    json!({
        "runtimeKind": projection.runtime_kind,
        "agentEngine": projection.agent_engine,
        "targetDeviceId": projection.target_device_id,
        "targetDeviceName": projection.target_device_name,
        "runtimeLabel": projection.runtime_label,
        "providerConnectionId": null,
        "modelProfileId": null,
        "model": null,
        "config": config,
    })
}

fn normalize_agent_engine(value: &str) -> String {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "claude" | "claude-code" => "claude-code".to_string(),
        "codex" | "openai-codex" => "codex".to_string(),
        "hermes" | "" => "hermes".to_string(),
        other => other.to_string(),
    }
}

fn strict_agent_engine(value: &str) -> String {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "claude" | "claude-code" | "anthropic" => "claude-code".to_string(),
        "codex" | "openai-codex" => "codex".to_string(),
        "hermes" => "hermes".to_string(),
        _ => String::new(),
    }
}

fn supported_agent_engine(value: &str) -> Option<String> {
    match normalize_agent_engine(value).as_str() {
        "hermes" => Some("hermes".to_string()),
        "claude-code" => Some("claude-code".to_string()),
        "codex" => Some("codex".to_string()),
        _ => None,
    }
}

fn runtime_control_options_from_request(
    request: BotRuntimeControlOptionsRequest,
) -> BotRuntimeControlOptionsResponse {
    let BotRuntimeControlOptionsRequest {
        runtime_kind,
        bot,
        runtime,
        binding,
        model_catalog,
        platform_models,
        engine_capabilities,
        codex_models,
    } = request;
    let runtime_value = runtime;
    let bot = object_from_value(bot);
    let runtime = object_from_value(runtime_value.clone());
    let binding = object_from_value(binding);
    let binding_config = first_nested_object(&binding, &["config"])
        .cloned()
        .unwrap_or_default();
    let bot_config = first_nested_object(
        &bot,
        &[
            "engineConfig",
            "engine_config",
            "runtimeConfig",
            "runtime_config",
            "config",
        ],
    )
    .cloned()
    .unwrap_or_default();
    let raw_runtime_kind = runtime_kind
        .as_deref()
        .map(str::to_string)
        .or_else(|| first_map_string(&binding, &["runtimeKind", "runtime_kind"]))
        .or_else(|| first_map_string(&bot, &["runtimeKind", "runtime_kind", "sourceKind"]))
        .unwrap_or_else(|| "desktop-local".to_string());
    let runtime_kind = normalize_runtime_kind(&raw_runtime_kind);
    let agent_engine =
        runtime_control_agent_engine(&runtime_kind, &bot, &runtime, &binding_config, &bot_config);
    let config = runtime_control_config(
        &runtime_kind,
        &agent_engine,
        &runtime,
        &binding_config,
        &bot_config,
    );
    let model_catalog = runtime_control_model_catalog(&model_catalog);
    let platform_models = runtime_control_platform_model_entries(&platform_models);
    let engine_blocked =
        runtime_inventory_engine_state(&runtime_value, &agent_engine).is_some_and(|usable| !usable);
    let model_options = if engine_blocked {
        Vec::new()
    } else {
        runtime_control_model_options(
            &runtime_kind,
            &agent_engine,
            &runtime_value,
            &model_catalog,
            &platform_models,
            &engine_capabilities,
            &codex_models,
        )
    };
    let effort_options =
        runtime_control_effort_options(&agent_engine, &engine_capabilities, &codex_models);
    let permission_options =
        runtime_control_permission_options(&runtime_kind, &agent_engine, &engine_capabilities);
    let selected_model =
        selected_runtime_control_model(&runtime_kind, &agent_engine, &model_options, &config);
    let selected_model_entry =
        selected_runtime_control_model_entry(&model_options, &config, &selected_model);
    let selected_effort = selected_runtime_control_value(
        &effort_options,
        first_map_string(&config, &["effortLevel", "effort_level"]).as_deref(),
        "medium",
    );
    let selected_permission = selected_runtime_control_value(
        &permission_options,
        first_map_string(&config, &["permissionMode", "permission_mode"]).as_deref(),
        if runtime_kind == "cloud-claude-code" {
            "bypassPermissions"
        } else {
            "default"
        },
    );
    BotRuntimeControlOptionsResponse {
        runtime_kind: runtime_kind.clone(),
        agent_engine: agent_engine.clone(),
        status_text: if runtime_kind == "cloud-claude-code" {
            if agent_engine.is_empty() {
                "Mia Cloud · 内核未同步".to_string()
            } else {
                "Mia Cloud".to_string()
            }
        } else {
            engine_label(&agent_engine)
        },
        model_options,
        selected_model,
        selected_model_entry,
        effort_options,
        selected_effort,
        permission_options,
        selected_permission,
    }
}

fn runtime_control_agent_engine(
    runtime_kind: &str,
    bot: &Map<String, Value>,
    runtime: &Map<String, Value>,
    binding_config: &Map<String, Value>,
    bot_config: &Map<String, Value>,
) -> String {
    if runtime_kind == "cloud-claude-code" {
        let cloud_runtime = cloud_agent_runtime(runtime);
        return strict_agent_engine(
            &first_map_string(binding_config, &["agentEngine", "agent_engine", "engine"])
                .or_else(|| first_map_string(bot, &["agentEngine", "agent_engine", "engine"]))
                .or_else(|| {
                    first_map_string(bot_config, &["agentEngine", "agent_engine", "engine"])
                })
                .unwrap_or(cloud_runtime.agent_engine),
        );
    }
    supported_agent_engine(
        &first_map_string(binding_config, &["agentEngine", "agent_engine", "engine"])
            .or_else(|| first_map_string(bot, &["agentEngine", "agent_engine", "engine"]))
            .or_else(|| first_map_string(bot_config, &["agentEngine", "agent_engine", "engine"]))
            .unwrap_or_else(|| default_agent_engine(runtime_kind).to_string()),
    )
    .unwrap_or_else(|| default_agent_engine(runtime_kind).to_string())
}

fn runtime_control_config(
    runtime_kind: &str,
    agent_engine: &str,
    runtime: &Map<String, Value>,
    binding_config: &Map<String, Value>,
    bot_config: &Map<String, Value>,
) -> Map<String, Value> {
    let mut config = bot_config.clone();
    for (key, value) in binding_config {
        config.insert(key.clone(), value.clone());
    }
    if runtime_kind == "cloud-claude-code" {
        return config;
    }
    if is_external_runtime_engine(agent_engine) {
        if !config.contains_key("permissionMode") && !config.contains_key("permission_mode") {
            config.insert(
                "permissionMode".to_string(),
                json!(engine_permission_mode_for_runtime_control(
                    agent_engine,
                    runtime
                )),
            );
        }
        return config;
    }
    if !binding_config.is_empty() || !bot_config.is_empty() {
        return config;
    }

    if let Some(model) = runtime.get("model").and_then(Value::as_object) {
        if let Some(provider) = first_map_string(
            model,
            &["providerConnectionId", "provider_connection_id", "provider"],
        ) {
            config.insert("providerConnectionId".to_string(), json!(provider));
        }
        if let Some(profile_id) = first_map_string(
            model,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        ) {
            config.insert("modelProfileId".to_string(), json!(profile_id));
        }
        if let Some(model_name) = first_map_string(model, &["model", "id", "value"]) {
            config.insert("model".to_string(), json!(model_name));
        }
    }
    if let Some(level) = nested_string(
        runtime,
        &["effort"],
        &["level", "effortLevel", "effort_level"],
    ) {
        config.insert("effortLevel".to_string(), json!(level));
    } else {
        config.insert("effortLevel".to_string(), json!("medium"));
    }
    if let Some(mode) = nested_string(
        runtime,
        &["permissions"],
        &["mode", "permissionMode", "permission_mode"],
    ) {
        config.insert("permissionMode".to_string(), json!(mode));
    } else {
        config.insert("permissionMode".to_string(), json!("ask"));
    }
    config
}

fn is_external_runtime_engine(engine: &str) -> bool {
    !engine.trim().is_empty() && engine != "hermes"
}

fn engine_permission_mode_for_runtime_control(
    engine: &str,
    runtime: &Map<String, Value>,
) -> String {
    if !is_external_runtime_engine(engine) {
        return nested_string(
            runtime,
            &["permissions"],
            &["mode", "permissionMode", "permission_mode"],
        )
        .unwrap_or_else(|| "ask".to_string());
    }
    runtime
        .get("permissions")
        .and_then(Value::as_object)
        .and_then(|permissions| permissions.get("engines").and_then(Value::as_object))
        .and_then(|engines| engines.get(engine).and_then(Value::as_str))
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "default".to_string())
}

fn runtime_control_model_catalog(value: &Value) -> Vec<BotRuntimeControlOption> {
    value_array_or_nested(
        value,
        &["entries", "models", "modelCatalog", "model_catalog"],
    )
    .iter()
    .filter_map(runtime_control_option_from_value)
    .collect()
}

fn runtime_control_platform_model_entries(value: &Value) -> Vec<BotRuntimeControlOption> {
    let entries = value_array_or_nested(value, &["models", "platformModels", "platform_models"])
        .iter()
        .filter_map(|item| {
            let id = first_value_string(
                item,
                &["id", "value", "model_name", "modelName", "model", "slug"],
            )?;
            let label = platform_model_display_label(item, &id);
            Some(BotRuntimeControlOption {
                id: id.clone(),
                value: id.clone(),
                label,
                title: String::new(),
                aliases: vec![],
                model: id.clone(),
                provider: "mia".into(),
                provider_connection_id: "mia".into(),
                provider_label: "Mia".into(),
                auth_type: "mia_account".into(),
                model_profile_id: format!("mia:{id}"),
            })
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        vec![BotRuntimeControlOption {
            id: "mia-auto".into(),
            value: "mia-auto".into(),
            label: "Auto".into(),
            title: String::new(),
            aliases: vec![],
            model: "mia-auto".into(),
            provider: "mia".into(),
            provider_connection_id: "mia".into(),
            provider_label: "Mia".into(),
            auth_type: "mia_account".into(),
            model_profile_id: "mia:mia-auto".into(),
        }]
    } else {
        entries
    }
}

fn platform_model_display_label(entry: &Value, fallback_id: &str) -> String {
    let id = fallback_id.trim();
    let id_lower = id.to_ascii_lowercase();
    if matches!(id_lower.as_str(), "mia-auto" | "mia-default") {
        return "Auto".into();
    }
    first_value_string(entry, &["label", "name", "displayName", "display_name"])
        .unwrap_or_else(|| id.to_string())
        .trim_start_matches("Mia ")
        .trim()
        .to_string()
}

fn runtime_control_model_options(
    runtime_kind: &str,
    agent_engine: &str,
    runtime: &Value,
    model_catalog: &[BotRuntimeControlOption],
    platform_models: &[BotRuntimeControlOption],
    engine_capabilities: &Value,
    codex_models: &Value,
) -> Vec<BotRuntimeControlOption> {
    if runtime_kind == "cloud-claude-code" {
        return platform_models.to_vec();
    }
    if is_external_runtime_engine(agent_engine) {
        return runtime_control_external_model_options(
            agent_engine,
            engine_capabilities,
            codex_models,
            platform_models,
        );
    }
    let connected = connected_provider_ids(runtime);
    let mut entries = model_catalog
        .iter()
        .filter(|entry| connected.contains(entry.provider.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if runtime
        .get("cloud")
        .and_then(|cloud| cloud.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        entries.extend(platform_models.iter().cloned());
    }
    if let Some(current) = current_runtime_model_option(runtime)
        && provider_is_connected(runtime, &current.provider)
        && !entries
            .iter()
            .any(|entry| runtime_control_model_option_matches(entry, &current))
    {
        entries.insert(0, current);
    }
    dedupe_runtime_control_options(entries)
}

fn runtime_control_external_model_options(
    engine: &str,
    engine_capabilities: &Value,
    _codex_models: &Value,
    platform_models: &[BotRuntimeControlOption],
) -> Vec<BotRuntimeControlOption> {
    let capability = runtime_control_engine_capability(engine_capabilities, engine);
    let mut entries = Vec::new();
    if engine == "claude-code" {
        entries.extend(
            value_array_or_nested(&capability, &["models"])
                .iter()
                .enumerate()
                .filter_map(|(index, item)| normalize_external_model_option(engine, item, index)),
        );
    } else if engine == "codex" {
        for item in value_array_or_nested(&capability, &["models"]) {
            if let Some(slug) = first_value_string(&item, &["slug", "id", "model", "value", "name"])
            {
                entries.push(BotRuntimeControlOption {
                    id: slug.clone(),
                    value: slug.clone(),
                    label: first_value_string(
                        &item,
                        &["displayName", "display_name", "label", "name"],
                    )
                    .unwrap_or_else(|| slug.clone()),
                    title: first_value_string(&item, &["description"]).unwrap_or_default(),
                    aliases: vec![],
                    model: slug,
                    provider: "codex".into(),
                    provider_connection_id: "codex".into(),
                    provider_label: "Codex CLI".into(),
                    auth_type: String::new(),
                    model_profile_id: String::new(),
                });
            }
        }
    }
    entries.extend(platform_models.iter().cloned());
    dedupe_runtime_control_options(entries)
}

fn normalize_external_model_option(
    engine: &str,
    item: &Value,
    index: usize,
) -> Option<BotRuntimeControlOption> {
    let id = first_value_string(item, &["id", "key", "value", "model", "name"])
        .unwrap_or_else(|| format!("{engine}-{index}"));
    let model =
        first_value_string(item, &["model", "key", "id", "value", "name"]).unwrap_or_default();
    if id.is_empty() && model.is_empty() {
        return None;
    }
    Some(BotRuntimeControlOption {
        id: if id.is_empty() {
            model.clone()
        } else {
            id.clone()
        },
        value: if id.is_empty() { model.clone() } else { id },
        label: first_value_string(item, &["label", "displayName", "display_name", "name"])
            .unwrap_or_else(|| {
                if model.is_empty() {
                    engine_label(engine)
                } else {
                    model.clone()
                }
            }),
        title: first_value_string(item, &["title", "description"]).unwrap_or_default(),
        aliases: string_array(item.get("aliases")),
        model,
        provider: first_value_string(item, &["provider"]).unwrap_or_else(|| engine.into()),
        provider_connection_id: first_value_string(
            item,
            &["providerConnectionId", "provider_connection_id"],
        )
        .unwrap_or_else(|| engine.into()),
        provider_label: first_value_string(item, &["providerLabel", "provider_label"])
            .unwrap_or_else(|| engine_label(engine)),
        auth_type: first_value_string(item, &["authType", "auth_type"]).unwrap_or_default(),
        model_profile_id: first_value_string(
            item,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        )
        .unwrap_or_default(),
    })
}

fn runtime_control_effort_options(
    engine: &str,
    engine_capabilities: &Value,
    _codex_models: &Value,
) -> Vec<BotRuntimeControlOption> {
    let capability = runtime_control_engine_capability(engine_capabilities, engine);
    let dynamic = value_array_or_nested(&capability, &["effortOptions", "effort_options"]);
    if !dynamic.is_empty() {
        return dynamic
            .iter()
            .filter_map(runtime_control_effort_option_from_value)
            .collect();
    }
    let levels = value_array_or_nested(&capability, &["effortLevels", "effort_levels"]);
    if !levels.is_empty() {
        return levels
            .iter()
            .filter_map(runtime_control_effort_level)
            .collect();
    }
    if engine == "codex" {
        let models = value_array_or_nested(&capability, &["models"]);
        let mut seen = HashSet::new();
        let mut options = Vec::new();
        for model in models {
            for item in value_array_or_nested(
                &model,
                &["supportedReasoningLevels", "supported_reasoning_levels"],
            ) {
                let level =
                    first_value_string(&item, &["effort", "value", "id"]).unwrap_or_default();
                if level.is_empty() || !seen.insert(level.clone()) {
                    continue;
                }
                options.push(BotRuntimeControlOption {
                    id: String::new(),
                    value: level.clone(),
                    label: first_value_string(&item, &["label"])
                        .unwrap_or_else(|| effort_label(&level)),
                    title: first_value_string(&item, &["description", "title"]).unwrap_or_default(),
                    aliases: vec![],
                    model: String::new(),
                    provider: String::new(),
                    provider_connection_id: String::new(),
                    provider_label: String::new(),
                    auth_type: String::new(),
                    model_profile_id: String::new(),
                });
            }
        }
        if !options.is_empty() {
            return options;
        }
    }
    let fallback = if is_external_runtime_engine(engine) {
        vec!["medium".to_string()]
    } else {
        value_array_or_nested(engine_capabilities, &["effortLevels", "effort_levels"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    let levels = if fallback.is_empty() {
        vec!["low".to_string(), "medium".to_string(), "high".to_string()]
    } else {
        fallback
    };
    levels
        .into_iter()
        .map(|level| BotRuntimeControlOption {
            id: String::new(),
            value: level.clone(),
            label: effort_label(&level),
            title: String::new(),
            aliases: vec![],
            model: String::new(),
            provider: String::new(),
            provider_connection_id: String::new(),
            provider_label: String::new(),
            auth_type: String::new(),
            model_profile_id: String::new(),
        })
        .collect()
}

fn runtime_control_effort_option_from_value(item: &Value) -> Option<BotRuntimeControlOption> {
    let level = first_value_string(item, &["value", "effort", "id"])
        .or_else(|| item.as_str().map(str::to_string))?;
    Some(BotRuntimeControlOption {
        id: String::new(),
        value: level.clone(),
        label: first_value_string(item, &["label"]).unwrap_or_else(|| effort_label(&level)),
        title: first_value_string(item, &["title", "description"]).unwrap_or_default(),
        aliases: vec![],
        model: String::new(),
        provider: String::new(),
        provider_connection_id: String::new(),
        provider_label: String::new(),
        auth_type: String::new(),
        model_profile_id: String::new(),
    })
}

fn runtime_control_effort_level(item: &Value) -> Option<BotRuntimeControlOption> {
    let level = item
        .as_str()
        .map(str::to_string)
        .or_else(|| first_value_string(item, &["value", "effort", "id"]))?;
    Some(BotRuntimeControlOption {
        id: String::new(),
        value: level.clone(),
        label: effort_label(&level),
        title: String::new(),
        aliases: vec![],
        model: String::new(),
        provider: String::new(),
        provider_connection_id: String::new(),
        provider_label: String::new(),
        auth_type: String::new(),
        model_profile_id: String::new(),
    })
}

fn runtime_control_permission_options(
    runtime_kind: &str,
    engine: &str,
    engine_capabilities: &Value,
) -> Vec<BotRuntimeControlOption> {
    if runtime_kind == "cloud-claude-code" {
        return vec![runtime_control_permission_option(
            "bypassPermissions",
            "Sandbox",
            "",
        )];
    }
    if is_external_runtime_engine(engine) {
        let capability = runtime_control_engine_capability(engine_capabilities, engine);
        let dynamic =
            value_array_or_nested(&capability, &["permissionOptions", "permission_options"]);
        if !dynamic.is_empty() {
            return dynamic
                .iter()
                .filter_map(runtime_control_permission_option_from_value)
                .collect();
        }
        let modes = value_array_or_nested(&capability, &["permissionModes", "permission_modes"]);
        if !modes.is_empty() {
            return modes
                .iter()
                .filter_map(|item| {
                    let value = item
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| first_value_string(item, &["value", "id"]))?;
                    Some(runtime_control_permission_option(
                        &value,
                        external_permission_label(&value),
                        "",
                    ))
                })
                .collect();
        }
        if engine == "codex" {
            let profiles =
                value_array_or_nested(&capability, &["permissionProfiles", "permission_profiles"]);
            return codex_permission_options_from_profiles(&profiles);
        }
        if engine == "claude-code" {
            return vec![
                runtime_control_permission_option(
                    "default",
                    "Ask Permissions",
                    "Claude Code asks Mia before tool use.",
                ),
                runtime_control_permission_option(
                    "acceptEdits",
                    "Accept Edits",
                    "Claude Code can apply edit tools without asking first.",
                ),
                runtime_control_permission_option(
                    "auto",
                    "Auto",
                    "Claude Code uses its native automatic permission mode.",
                ),
                runtime_control_permission_option(
                    "plan",
                    "Plan Mode",
                    "Claude Code plans without applying changes.",
                ),
                runtime_control_permission_option(
                    "dontAsk",
                    "Don't Ask",
                    "Claude Code uses its native don't-ask mode.",
                ),
                BotRuntimeControlOption {
                    aliases: vec![
                        ":danger-full-access".into(),
                        "danger-full-access".into(),
                        "yolo".into(),
                        "off".into(),
                        "never".into(),
                    ],
                    ..runtime_control_permission_option(
                        "bypassPermissions",
                        "Bypass Permissions",
                        "Claude Code may use tools without Mia asking first.",
                    )
                },
            ];
        }
        return vec![runtime_control_permission_option("default", "Ask", "")];
    }
    let modes = value_array_or_nested(engine_capabilities, &["approvalModes", "approval_modes"]);
    let values = if modes.is_empty() {
        vec!["ask".to_string(), "yolo".to_string(), "deny".to_string()]
    } else {
        modes
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    };
    values
        .iter()
        .map(|value| runtime_control_permission_option(value, approval_label(value), ""))
        .collect()
}

fn codex_permission_options_from_profiles(profiles: &[Value]) -> Vec<BotRuntimeControlOption> {
    if profiles.is_empty() {
        return vec![runtime_control_permission_option(
            "default",
            "Ask",
            "Codex 默认权限。",
        )];
    }
    let mut rows = profiles
        .iter()
        .filter_map(|profile| {
            let id = first_value_string(profile, &["id", "value"])?;
            Some((
                codex_permission_rank(&id),
                id,
                first_value_string(profile, &["description", "title"]).unwrap_or_default(),
            ))
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    rows.into_iter()
        .map(|(_, id, description)| BotRuntimeControlOption {
            aliases: codex_permission_aliases(&id),
            ..runtime_control_permission_option(&id, codex_permission_label(&id), &description)
        })
        .collect()
}

fn runtime_control_permission_option(
    value: &str,
    label: &str,
    title: &str,
) -> BotRuntimeControlOption {
    BotRuntimeControlOption {
        id: String::new(),
        value: value.into(),
        label: label.into(),
        title: title.into(),
        aliases: vec![],
        model: String::new(),
        provider: String::new(),
        provider_connection_id: String::new(),
        provider_label: String::new(),
        auth_type: String::new(),
        model_profile_id: String::new(),
    }
}

fn runtime_control_permission_option_from_value(item: &Value) -> Option<BotRuntimeControlOption> {
    let value = first_value_string(item, &["value", "id"])?;
    Some(BotRuntimeControlOption {
        aliases: string_array(item.get("aliases")),
        ..runtime_control_permission_option(
            &value,
            &first_value_string(item, &["label"])
                .unwrap_or_else(|| external_permission_label(&value).into()),
            &first_value_string(item, &["title", "description"]).unwrap_or_default(),
        )
    })
}

fn runtime_control_option_from_value(value: &Value) -> Option<BotRuntimeControlOption> {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        return Some(BotRuntimeControlOption {
            id: text.into(),
            value: text.into(),
            label: text.into(),
            title: String::new(),
            aliases: vec![],
            model: text.into(),
            provider: String::new(),
            provider_connection_id: String::new(),
            provider_label: String::new(),
            auth_type: String::new(),
            model_profile_id: String::new(),
        });
    }
    let object = value.as_object()?;
    let provider = first_map_string(object, &["provider"]).unwrap_or_default();
    let model = first_map_string(object, &["model", "slug", "name", "value"]).unwrap_or_default();
    let id = first_map_string(
        object,
        &["id", "key", "value", "modelProfileId", "model_profile_id"],
    )
    .unwrap_or_else(|| {
        if provider.is_empty() {
            model.clone()
        } else {
            format!("{provider}::{model}")
        }
    });
    if id.is_empty() && model.is_empty() && provider.is_empty() {
        return None;
    }
    let provider_connection_id = first_map_string(
        object,
        &[
            "providerConnectionId",
            "provider_connection_id",
            "modelProvider",
            "model_provider",
        ],
    )
    .unwrap_or_else(|| provider.clone());
    Some(BotRuntimeControlOption {
        id,
        value: first_map_string(object, &["value"]).unwrap_or_default(),
        label: first_map_string(
            object,
            &["label", "displayName", "display_name", "name", "title"],
        )
        .unwrap_or_else(|| {
            if model.is_empty() {
                provider.clone()
            } else {
                model.clone()
            }
        }),
        title: first_map_string(object, &["title", "description"]).unwrap_or_default(),
        aliases: string_array(object.get("aliases")),
        model,
        provider,
        provider_connection_id,
        provider_label: first_map_string(object, &["providerLabel", "provider_label"])
            .unwrap_or_default(),
        auth_type: first_map_string(object, &["authType", "auth_type"]).unwrap_or_default(),
        model_profile_id: first_map_string(
            object,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        )
        .unwrap_or_default(),
    })
}

fn current_runtime_model_option(runtime: &Value) -> Option<BotRuntimeControlOption> {
    runtime
        .get("model")
        .and_then(current_runtime_model_option_from_value)
}

fn current_runtime_model_option_from_value(value: &Value) -> Option<BotRuntimeControlOption> {
    let provider = first_value_string(value, &["provider"])?;
    let model = first_value_string(value, &["model"]).unwrap_or_default();
    let id = first_value_string(
        value,
        &["modelProfileId", "model_profile_id", "id", "value"],
    )
    .unwrap_or_else(|| format!("{provider}::{model}"));
    Some(BotRuntimeControlOption {
        id,
        value: String::new(),
        label: first_value_string(value, &["label"]).unwrap_or_else(|| {
            if model.is_empty() {
                provider.clone()
            } else {
                model.clone()
            }
        }),
        title: String::new(),
        aliases: vec![],
        model,
        provider: provider.clone(),
        provider_connection_id: first_value_string(
            value,
            &["providerConnectionId", "provider_connection_id"],
        )
        .unwrap_or(provider),
        provider_label: first_value_string(value, &["providerLabel", "provider_label"])
            .unwrap_or_default(),
        auth_type: first_value_string(value, &["authType", "auth_type"]).unwrap_or_default(),
        model_profile_id: first_value_string(value, &["modelProfileId", "model_profile_id"])
            .unwrap_or_default(),
    })
}

fn runtime_control_engine_capability(engine_capabilities: &Value, engine: &str) -> Value {
    engine_capabilities
        .get("engines")
        .and_then(|engines| {
            engines
                .get(engine)
                .or_else(|| engines.get(engine.replace('-', "_")))
                .or_else(|| {
                    if engine == "claude-code" {
                        engines.get("claudeCode")
                    } else {
                        None
                    }
                })
        })
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn connected_provider_ids(runtime: &Value) -> HashSet<String> {
    runtime
        .get("connectedProviders")
        .or_else(|| runtime.get("connected_providers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("hasApiKey")
                .or_else(|| entry.get("has_api_key"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| first_value_string(entry, &["provider"]))
        .collect()
}

fn provider_is_connected(runtime: &Value, provider: &str) -> bool {
    if provider == "mia" {
        return runtime
            .get("cloud")
            .and_then(|cloud| cloud.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    connected_provider_ids(runtime).contains(provider)
}

fn runtime_control_model_option_matches(
    left: &BotRuntimeControlOption,
    right: &BotRuntimeControlOption,
) -> bool {
    (!left.id.is_empty() && left.id == right.id)
        || (!left.model_profile_id.is_empty() && left.model_profile_id == right.model_profile_id)
        || (left.provider == right.provider && left.model == right.model)
}

fn dedupe_runtime_control_options(
    entries: Vec<BotRuntimeControlOption>,
) -> Vec<BotRuntimeControlOption> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| {
            let model_or_value = if entry.model.is_empty() {
                entry.value.as_str()
            } else {
                entry.model.as_str()
            };
            let key = format!("{}:{}:{}", entry.provider, entry.id, model_or_value);
            !key.trim_matches(':').is_empty() && seen.insert(key)
        })
        .collect()
}

fn value_array_or_nested(value: &Value, keys: &[&str]) -> Vec<Value> {
    if let Some(values) = value.as_array() {
        return values.clone();
    }
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn first_value_string(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn effort_label(value: &str) -> String {
    match value {
        "off" => "Off",
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra high",
        "adaptive" => "Adaptive",
        "max" => "Max",
        _ => value,
    }
    .into()
}

fn approval_label(value: &str) -> &'static str {
    match value {
        "ask" | "manual" => "Ask",
        "yolo" | "off" => "YOLO",
        "deny" | "dontAsk" => "Deny",
        _ => "Ask",
    }
}

fn external_permission_label(value: &str) -> &'static str {
    match value {
        "default" => "Ask",
        "acceptEdits" => "Accept Edits",
        "auto" => "Auto",
        "bypassPermissions" => "Bypass Permissions",
        "dontAsk" => "Don't Ask",
        "plan" => "Plan Mode",
        "readOnly" => "Read",
        "yolo" => "YOLO",
        _ => "Ask",
    }
}

fn codex_permission_label(value: &str) -> &'static str {
    match value {
        ":workspace" => "Workspace",
        ":read-only" => "Read Only",
        ":danger-full-access" => "Full Access",
        _ => "Ask",
    }
}

fn codex_permission_aliases(value: &str) -> Vec<String> {
    match value {
        ":workspace" => vec!["default".into(), "acceptEdits".into(), "workspace".into()],
        ":read-only" => vec!["readOnly".into(), "read-only".into()],
        ":danger-full-access" => vec![
            "bypassPermissions".into(),
            "yolo".into(),
            "off".into(),
            "never".into(),
            "danger-full-access".into(),
        ],
        _ => vec![],
    }
}

fn codex_permission_rank(value: &str) -> i32 {
    match value {
        ":workspace" => 0,
        ":read-only" => 1,
        ":danger-full-access" => 2,
        _ => 50,
    }
}

fn selected_runtime_control_model(
    runtime_kind: &str,
    agent_engine: &str,
    entries: &[BotRuntimeControlOption],
    config: &Map<String, Value>,
) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let model = runtime_control_model_name(config);
    if let Some(entry) = saved_runtime_control_model_entry(entries, config) {
        return runtime_control_option_value(entry, &model);
    }
    if runtime_kind == "cloud-claude-code" {
        return if model.is_empty() {
            entries
                .first()
                .map(|entry| runtime_control_option_value(entry, "mia-auto"))
                .unwrap_or_else(|| "mia-auto".to_string())
        } else {
            model
        };
    }
    if is_external_runtime_engine(agent_engine) {
        if model.is_empty() {
            return String::new();
        }
        return entries
            .iter()
            .find(|entry| runtime_control_option_matches_model(entry, "", &model))
            .map(|entry| runtime_control_option_value(entry, &model))
            .unwrap_or_default();
    }
    if !model.is_empty() {
        return entries
            .iter()
            .find(|entry| runtime_control_option_matches_model(entry, "", &model))
            .map(|entry| runtime_control_option_value(entry, &model))
            .unwrap_or(model);
    }
    entries
        .first()
        .map(|entry| runtime_control_option_value(entry, ""))
        .unwrap_or_default()
}

fn runtime_inventory_engine_state(runtime: &Value, engine: &str) -> Option<bool> {
    let agents = runtime
        .get("agentInventory")
        .and_then(Value::as_object)
        .and_then(|inventory| inventory.get("agents"))
        .and_then(Value::as_array)?;
    for agent in agents {
        let Some(agent) = agent.as_object() else {
            continue;
        };
        let Some(agent_id) =
            first_map_string(agent, &["id"]).and_then(|value| supported_agent_engine(&value))
        else {
            continue;
        };
        if agent_id == engine {
            return Some(
                agent
                    .get("usableInMia")
                    .or_else(|| agent.get("usable_in_mia"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
        }
    }
    None
}

fn selected_runtime_control_model_entry(
    entries: &[BotRuntimeControlOption],
    config: &Map<String, Value>,
    selected_model: &str,
) -> Option<BotRuntimeControlOption> {
    entries
        .iter()
        .find(|entry| runtime_control_option_value(entry, "") == selected_model)
        .or_else(|| saved_runtime_control_model_entry(entries, config))
        .or_else(|| {
            let model = runtime_control_model_name(config);
            entries
                .iter()
                .find(|entry| runtime_control_option_matches_model(entry, "", &model))
        })
        .cloned()
}

fn selected_runtime_control_value(
    entries: &[BotRuntimeControlOption],
    configured: Option<&str>,
    default_value: &str,
) -> String {
    if let Some(value) = configured.map(str::trim).filter(|value| !value.is_empty()) {
        return value.to_string();
    }
    entries
        .iter()
        .find(|entry| runtime_control_option_value(entry, "") == default_value)
        .or_else(|| entries.first())
        .map(|entry| runtime_control_option_value(entry, default_value))
        .unwrap_or_else(|| default_value.to_string())
}

fn saved_runtime_control_model_entry<'a>(
    entries: &'a [BotRuntimeControlOption],
    config: &Map<String, Value>,
) -> Option<&'a BotRuntimeControlOption> {
    let provider = runtime_control_model_provider(config);
    let model = runtime_control_model_name(config);
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    entries
        .iter()
        .find(|entry| runtime_control_option_matches_model(entry, &provider, &model))
}

fn runtime_control_model_profile_id(config: &Map<String, Value>) -> String {
    first_map_string(
        config,
        &[
            "modelProfileId",
            "model_profile_id",
            "profileId",
            "profile_id",
        ],
    )
    .unwrap_or_default()
}

fn runtime_control_model_provider(config: &Map<String, Value>) -> String {
    first_map_string(
        config,
        &[
            "providerConnectionId",
            "provider_connection_id",
            "provider",
            "modelProvider",
            "model_provider",
        ],
    )
    .unwrap_or_else(|| {
        runtime_control_model_profile_id(config)
            .split_once(':')
            .map(|(provider, _)| provider.trim().to_string())
            .unwrap_or_default()
    })
}

fn runtime_control_model_name(config: &Map<String, Value>) -> String {
    first_map_string(config, &["model"]).unwrap_or_else(|| {
        runtime_control_model_profile_id(config)
            .split_once(':')
            .map(|(_, model)| model.trim().to_string())
            .unwrap_or_default()
    })
}

fn runtime_control_option_matches_model(
    entry: &BotRuntimeControlOption,
    provider: &str,
    model: &str,
) -> bool {
    let model = model.trim();
    if model.is_empty() {
        return false;
    }
    let entry_provider = if entry.provider.is_empty() {
        entry.provider_connection_id.as_str()
    } else {
        entry.provider.as_str()
    };
    (provider.is_empty() || entry_provider == provider)
        && [
            entry.model.as_str(),
            entry.id.as_str(),
            entry.value.as_str(),
        ]
        .into_iter()
        .any(|candidate| candidate == model)
}

fn runtime_control_option_value(entry: &BotRuntimeControlOption, fallback: &str) -> String {
    if !entry.id.is_empty() {
        entry.id.clone()
    } else if !entry.value.is_empty() {
        entry.value.clone()
    } else if !entry.model.is_empty() {
        entry.model.clone()
    } else {
        fallback.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BotCapabilityState {
    inherit_engine_defaults: bool,
    enabled_plugins: Vec<String>,
    disabled_plugins: Vec<String>,
    enabled_skills: Vec<String>,
    disabled_skills: Vec<String>,
    enabled_connectors: Vec<String>,
    legacy_capabilities: Vec<String>,
}

impl BotCapabilityState {
    fn default() -> Self {
        Self {
            inherit_engine_defaults: true,
            enabled_plugins: Vec::new(),
            disabled_plugins: Vec::new(),
            enabled_skills: Vec::new(),
            disabled_skills: Vec::new(),
            enabled_connectors: Vec::new(),
            legacy_capabilities: Vec::new(),
        }
    }

    fn into_value(self) -> Value {
        json!({
            "inheritEngineDefaults": self.inherit_engine_defaults,
            "enabledPlugins": self.enabled_plugins,
            "disabledPlugins": self.disabled_plugins,
            "enabledSkills": self.enabled_skills,
            "disabledSkills": self.disabled_skills,
            "enabledConnectors": self.enabled_connectors,
            "legacyCapabilities": self.legacy_capabilities,
        })
    }
}

fn capability_options_from_request(
    request: BotCapabilityOptionsRequest,
) -> BotCapabilityOptionsResponse {
    let mut capabilities =
        bot_capabilities_with_preset_defaults(&request.bot, &request.bot_presets);
    if let Some(intent) = request.intent.as_ref() {
        capabilities = apply_capability_intent(capabilities, intent);
    }

    let bot_object = request.bot.as_object().cloned().unwrap_or_default();
    let engine = first_map_string(&bot_object, &["agentEngine", "agent_engine"])
        .map(|value| normalize_agent_engine(&value))
        .unwrap_or_else(|| "hermes".to_string());
    let available_skills = request
        .available_skills
        .into_iter()
        .filter(|skill| capability_skill_for_engine(skill, &engine))
        .collect::<Vec<_>>();
    let disabled = capabilities.disabled_skills.clone();
    let enabled_ids = capabilities
        .enabled_skills
        .iter()
        .filter(|id| !disabled.iter().any(|disabled_id| disabled_id == *id))
        .cloned()
        .collect::<Vec<_>>();
    let mut enabled_keys = Vec::new();
    let mut enabled_options = Vec::new();

    for id in enabled_ids {
        push_unique_many(&mut enabled_keys, skill_id_lookup_keys(&id));
        if let Some(skill) = skill_for_capability_id(&id, &available_skills) {
            push_unique_many(&mut enabled_keys, skill_input_lookup_keys(skill));
            enabled_options.push(capability_option_from_skill(skill, &id, true));
        } else {
            enabled_options.push(BotCapabilityOption {
                id: id.clone(),
                capability_id: id.clone(),
                label: id.trim_start_matches("mia-official:").to_string(),
                source: String::new(),
                checked: true,
                missing: true,
            });
        }
    }

    let addable_options = available_skills
        .iter()
        .filter(|skill| {
            !skill_input_lookup_keys(skill)
                .iter()
                .any(|key| enabled_keys.iter().any(|enabled_key| enabled_key == key))
        })
        .map(|skill| capability_option_from_skill(skill, &skill.id, false))
        .collect::<Vec<_>>();
    let summary = if enabled_options.is_empty() {
        "未设置默认技能".to_string()
    } else {
        format!("{} 个默认技能", enabled_options.len())
    };

    BotCapabilityOptionsResponse {
        capabilities: capabilities.into_value(),
        summary,
        groups: vec![
            BotCapabilityGroup {
                id: "enabled-skills".to_string(),
                label: "已启用技能".to_string(),
                kind: "skill".to_string(),
                options: enabled_options,
            },
            BotCapabilityGroup {
                id: "addable-skills".to_string(),
                label: "添加技能".to_string(),
                kind: "skill".to_string(),
                options: addable_options,
            },
        ],
    }
}

fn apply_capability_intent(
    mut capabilities: BotCapabilityState,
    intent: &BotCapabilityIntent,
) -> BotCapabilityState {
    if intent.capability_type.trim() != "skill" {
        return capabilities;
    }
    let id = intent.capability_id.trim();
    if id.is_empty() {
        return capabilities;
    }
    capabilities.inherit_engine_defaults = false;
    if intent.checked {
        push_unique(&mut capabilities.enabled_skills, id.to_string());
    } else {
        capabilities.enabled_skills.retain(|item| item != id);
    }
    capabilities.disabled_skills.retain(|item| item != id);
    capabilities
}

fn bot_capabilities_with_preset_defaults(
    bot: &Value,
    presets: &[BotCapabilityPresetInput],
) -> BotCapabilityState {
    let bot_object = bot.as_object().cloned().unwrap_or_default();
    let raw = bot_object
        .get("capabilities")
        .or_else(|| bot_object.get("capabilities_json"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut capabilities = normalize_bot_capabilities(raw);
    if !capabilities.inherit_engine_defaults {
        return capabilities;
    }
    let preset_capabilities = presets
        .iter()
        .find(|preset| bot_identity_matches_preset(&bot_object, preset))
        .map(|preset| preset.capabilities.clone())
        .or_else(|| legacy_preset_capabilities(&bot_object));
    let Some(preset_value) = preset_capabilities else {
        return capabilities;
    };
    let mut preset = normalize_bot_capabilities(preset_value);
    preset.inherit_engine_defaults = false;
    if preset.enabled_skills.is_empty() && preset.disabled_skills.is_empty() {
        return capabilities;
    }
    for id in preset.disabled_skills {
        push_unique(&mut capabilities.disabled_skills, id);
    }
    for id in preset.enabled_skills {
        if !capabilities
            .disabled_skills
            .iter()
            .any(|disabled_id| disabled_id == &id)
        {
            push_unique(&mut capabilities.enabled_skills, id);
        }
    }
    capabilities.inherit_engine_defaults = false;
    capabilities
}

fn normalize_bot_capabilities(input: Value) -> BotCapabilityState {
    if let Value::Array(_) = input {
        let mut capabilities = BotCapabilityState::default();
        capabilities.legacy_capabilities = normalize_capability_ids_value(Some(&input));
        return capabilities;
    }

    let object = input.as_object().cloned().unwrap_or_default();
    let mut legacy = normalize_capability_ids_value(
        object
            .get("legacyCapabilities")
            .or_else(|| object.get("legacy_capabilities")),
    );
    for (key, value) in &object {
        if !is_canonical_capability_key(key) && value.as_bool() == Some(true) {
            push_unique(&mut legacy, key.to_string());
        }
    }
    BotCapabilityState {
        inherit_engine_defaults: object
            .get("inheritEngineDefaults")
            .or_else(|| object.get("inherit_engine_defaults"))
            .and_then(Value::as_bool)
            != Some(false),
        enabled_plugins: normalize_capability_ids_value(
            object
                .get("enabledPlugins")
                .or_else(|| object.get("enabled_plugins")),
        ),
        disabled_plugins: normalize_capability_ids_value(
            object
                .get("disabledPlugins")
                .or_else(|| object.get("disabled_plugins")),
        ),
        enabled_skills: normalize_capability_ids_value(
            object
                .get("enabledSkills")
                .or_else(|| object.get("enabled_skills")),
        ),
        disabled_skills: normalize_capability_ids_value(
            object
                .get("disabledSkills")
                .or_else(|| object.get("disabled_skills")),
        ),
        enabled_connectors: normalize_capability_ids_value(
            object
                .get("enabledConnectors")
                .or_else(|| object.get("enabled_connectors")),
        ),
        legacy_capabilities: legacy,
    }
}

fn normalize_capability_ids_value(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            let mut ids = Vec::new();
            for item in items {
                if let Some(id) = capability_id_string(item) {
                    push_unique(&mut ids, id);
                    if ids.len() >= 500 {
                        break;
                    }
                }
            }
            ids
        })
        .unwrap_or_default()
}

fn capability_id_string(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(_) | Value::Bool(_) => value.to_string(),
        _ => String::new(),
    };
    if text.is_empty() { None } else { Some(text) }
}

fn is_canonical_capability_key(key: &str) -> bool {
    matches!(
        key,
        "inheritEngineDefaults"
            | "inherit_engine_defaults"
            | "enabledPlugins"
            | "enabled_plugins"
            | "disabledPlugins"
            | "disabled_plugins"
            | "enabledSkills"
            | "enabled_skills"
            | "disabledSkills"
            | "disabled_skills"
            | "enabledConnectors"
            | "enabled_connectors"
            | "legacyCapabilities"
            | "legacy_capabilities"
    )
}

fn bot_identity_matches_preset(
    bot: &Map<String, Value>,
    preset: &BotCapabilityPresetInput,
) -> bool {
    let bot_keys = strings_from_map(bot, &["key", "id", "account_id", "accountId"]);
    let preset_keys = [preset.key.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if bot_keys
        .iter()
        .any(|key| preset_keys.iter().any(|preset_key| preset_key == key))
    {
        return true;
    }
    let bot_names = strings_from_map(bot, &["name", "displayName", "display_name", "username"]);
    let preset_names = [preset.name.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    bot_names
        .iter()
        .any(|name| preset_names.iter().any(|preset_name| preset_name == name))
}

fn legacy_preset_capabilities(bot: &Map<String, Value>) -> Option<Value> {
    let presets = [
        (
            "old-paper",
            "论文搭子",
            &["mia-official:paper-research"][..],
        ),
        (
            "paper-buddy",
            "论文搭子",
            &["mia-official:paper-research"][..],
        ),
        ("lab-data", "实验数据助手", &["mia-official:lab-report"][..]),
        ("exam-buddy", "复习搭子", &["mia-official:study-review"][..]),
        (
            "qa-helper",
            "答疑助手",
            &["mia-official:problem-explainer"][..],
        ),
        (
            "spreadsheet-organizer",
            "表格整理师",
            &["mia-official:spreadsheet-organizer", "mia-official:xlsx"][..],
        ),
        (
            "presentation-designer",
            "汇报设计师",
            &["mia-official:presentation-designer"][..],
        ),
        (
            "meeting-notes",
            "会议纪要官",
            &["mia-official:meeting-notes"][..],
        ),
        (
            "document-editor",
            "文档编辑",
            &["mia-official:document-editor"][..],
        ),
        (
            "career-coach",
            "简历面试官",
            &["mia-official:resume-interview"][..],
        ),
        ("story-host", "剧情主持", &["mia-official:story-host"][..]),
    ];
    for (key, name, enabled_skills) in presets {
        let preset = BotCapabilityPresetInput {
            key: key.to_string(),
            name: name.to_string(),
            capabilities: json!({ "enabledSkills": enabled_skills }),
        };
        if bot_identity_matches_preset(bot, &preset) {
            return Some(preset.capabilities);
        }
    }
    None
}

fn capability_skill_for_engine(skill: &BotCapabilitySkillInput, engine: &str) -> bool {
    let item_engine = first_non_empty_string(&[&skill.engine, &skill.provider]);
    item_engine.is_empty()
        || item_engine == "mia"
        || normalize_agent_engine(&item_engine) == engine
        || (engine == "hermes" && skill.source.trim() == "hermes")
}

fn skill_for_capability_id<'a>(
    id: &str,
    skills: &'a [BotCapabilitySkillInput],
) -> Option<&'a BotCapabilitySkillInput> {
    let target = id.trim();
    if target.is_empty() {
        return None;
    }
    skills
        .iter()
        .find(|skill| skill.id.trim() == target)
        .or_else(|| {
            skills
                .iter()
                .find(|skill| skill_matches_capability_id(skill, target))
        })
}

fn skill_matches_capability_id(skill: &BotCapabilitySkillInput, id: &str) -> bool {
    let targets = skill_id_lookup_keys(id);
    skill_input_lookup_keys(skill)
        .iter()
        .any(|key| targets.iter().any(|target| target == key))
}

fn skill_id_lookup_keys(id: &str) -> Vec<String> {
    let value = id.trim();
    let suffix = value
        .rsplit_once(':')
        .map(|(_, suffix)| suffix)
        .unwrap_or("");
    unique_strings([value, suffix])
}

fn skill_input_lookup_keys(skill: &BotCapabilitySkillInput) -> Vec<String> {
    let id_base = skill
        .id
        .rsplit_once(':')
        .map(|(_, suffix)| suffix)
        .unwrap_or("");
    let rel_base = skill
        .rel_path
        .split(['/', '\\'])
        .rfind(|part| !part.is_empty())
        .unwrap_or("");
    let source_name = if skill.source.trim().is_empty() || skill.name.trim().is_empty() {
        String::new()
    } else {
        format!("{}:{}", skill.source.trim(), skill.name.trim())
    };
    let source_rel = if skill.source.trim().is_empty() || skill.rel_path.trim().is_empty() {
        String::new()
    } else {
        format!("{}:{}", skill.source.trim(), skill.rel_path.trim())
    };
    unique_strings([
        skill.id.as_str(),
        id_base,
        skill.name.as_str(),
        skill.rel_path.as_str(),
        rel_base,
        skill.market_id.as_str(),
        source_name.as_str(),
        source_rel.as_str(),
    ])
}

fn capability_option_from_skill(
    skill: &BotCapabilitySkillInput,
    capability_id: &str,
    checked: bool,
) -> BotCapabilityOption {
    let id = if capability_id.trim().is_empty() {
        skill.id.trim()
    } else {
        capability_id.trim()
    };
    BotCapabilityOption {
        id: id.to_string(),
        capability_id: id.to_string(),
        label: capability_title(skill),
        source: skill.source.trim().to_string(),
        checked,
        missing: false,
    }
}

fn capability_title(skill: &BotCapabilitySkillInput) -> String {
    first_non_empty_string(&[
        &skill.market_name_zh,
        &skill.name_zh,
        &skill.title,
        &skill.name,
        &skill.label,
        &skill.id,
    ])
}

fn strings_from_map(object: &Map<String, Value>, keys: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    for key in keys {
        if let Some(value) = object.get(*key).and_then(Value::as_str) {
            let next = value.trim();
            if !next.is_empty() {
                values.push(next.to_string());
            }
        }
    }
    values
}

fn first_non_empty_string(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

fn unique_strings<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let next = value.trim().to_ascii_lowercase();
        if !next.is_empty() && !output.iter().any(|item| item == &next) {
            output.push(next);
        }
    }
    output
}

fn push_unique(target: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !target.iter().any(|item| item == &value) {
        target.push(value);
    }
}

fn push_unique_many(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        push_unique(target, value);
    }
}

fn engine_label(engine: &str) -> String {
    match engine {
        "claude-code" => "Claude Code".to_string(),
        "codex" => "Codex".to_string(),
        "hermes" => "Hermes".to_string(),
        "" => "未同步".to_string(),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeTarget {
    runtime_kind: String,
    device_id: String,
    device_name: String,
    agent_engine: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CloudRuntimeTarget {
    agent_engine: String,
    available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceTarget {
    id: String,
    display_name: String,
    status_label: String,
    engines: Vec<String>,
}

fn runtime_target_options_from_request(
    request: BotRuntimeTargetOptionsRequest,
) -> BotRuntimeTargetOptionsResponse {
    let bot = object_from_value(request.bot);
    let runtime = object_from_value(request.runtime);
    let engine_capabilities = object_from_value(request.engine_capabilities);
    let cloud_runtime = cloud_agent_runtime(&runtime);
    let active = active_runtime_target(&bot, &runtime, &cloud_runtime);
    let mut groups = Vec::new();

    if nested_bool(&runtime, &["cloud"], "enabled") {
        let disabled = !cloud_runtime.available;
        let cloud_option = runtime_target_option(RuntimeTargetOptionInput {
            runtime_kind: "cloud-claude-code",
            device_id: "",
            device_name: "Mia Cloud",
            agent_engine: &cloud_runtime.agent_engine,
            selected: active.runtime_kind == "cloud-claude-code",
            disabled,
            disabled_reason: disabled.then(|| "Mia Cloud 运行内核未同步".to_string()),
        });
        groups.push(BotRuntimeTargetGroup {
            id: "cloud-claude-code".to_string(),
            label: "Mia Cloud".to_string(),
            status_label: if disabled { "未同步" } else { "在线" }.to_string(),
            runtime_kind: "cloud-claude-code".to_string(),
            options: vec![cloud_option],
        });
    }

    let local = local_device_target(
        &runtime,
        &engine_capabilities,
        request.preferred_agent_engine.as_deref(),
    );
    groups.push(BotRuntimeTargetGroup {
        id: local.id.clone(),
        label: local.display_name.clone(),
        status_label: local.status_label.clone(),
        runtime_kind: "desktop-local".to_string(),
        options: local
            .engines
            .iter()
            .map(|engine| {
                runtime_target_option(RuntimeTargetOptionInput {
                    runtime_kind: "desktop-local",
                    device_id: &local.id,
                    device_name: &local.display_name,
                    agent_engine: engine,
                    selected: active.runtime_kind == "desktop-local"
                        && active.device_id == local.id
                        && active.agent_engine == *engine,
                    disabled: false,
                    disabled_reason: None,
                })
            })
            .collect(),
    });

    BotRuntimeTargetOptionsResponse {
        active_target: runtime_target_option(RuntimeTargetOptionInput {
            runtime_kind: &active.runtime_kind,
            device_id: &active.device_id,
            device_name: &active.device_name,
            agent_engine: &active.agent_engine,
            selected: true,
            disabled: false,
            disabled_reason: None,
        }),
        runtime_label: runtime_target_label(&active, &bot, &runtime),
        runs_on_other_device: runtime_target_runs_on_other_device(&active, &runtime),
        groups,
    }
}

struct RuntimeTargetOptionInput<'a> {
    runtime_kind: &'a str,
    device_id: &'a str,
    device_name: &'a str,
    agent_engine: &'a str,
    selected: bool,
    disabled: bool,
    disabled_reason: Option<String>,
}

fn runtime_target_option(input: RuntimeTargetOptionInput<'_>) -> BotRuntimeTargetOption {
    let engine = if input.runtime_kind == "cloud-claude-code" {
        strict_agent_engine(input.agent_engine)
    } else {
        supported_agent_engine(input.agent_engine).unwrap_or_else(|| "hermes".to_string())
    };
    let engine_label = engine_label(&engine);
    let id = if input.runtime_kind == "cloud-claude-code" {
        format!("cloud-claude-code:{engine}")
    } else {
        format!("desktop-local:{}:{engine}", input.device_id)
    };
    let label = engine_label.clone();
    let title = if input.runtime_kind == "cloud-claude-code" {
        format!(
            "Mia Cloud · {}",
            if engine.is_empty() {
                "内核未同步".to_string()
            } else {
                engine_label.clone()
            }
        )
    } else {
        format!("{} · {}", input.device_name, engine_label)
    };
    BotRuntimeTargetOption {
        id,
        runtime_kind: input.runtime_kind.to_string(),
        device_id: input.device_id.to_string(),
        device_name: input.device_name.to_string(),
        agent_engine: engine.clone(),
        label,
        engine_label,
        title,
        icon_kind: if engine.is_empty() {
            "unknown".to_string()
        } else {
            engine
        },
        selected: input.selected,
        disabled: input.disabled,
        disabled_reason: input.disabled_reason,
    }
}

fn runtime_target_label(
    active: &RuntimeTarget,
    bot: &Map<String, Value>,
    runtime: &Map<String, Value>,
) -> String {
    if active.runtime_kind == "cloud-claude-code" {
        return "Mia Cloud".to_string();
    }
    if active.device_id.trim().is_empty() || !bot_has_explicit_runtime_device(bot) {
        return "运行设备未配置".to_string();
    }
    if runtime_target_runs_on_other_device(active, runtime) {
        if let Some(device) = runtime_device_by_id(runtime, &active.device_id) {
            let name = compact_device_name(
                &first_map_string(
                    device,
                    &[
                        "deviceName",
                        "device_name",
                        "name",
                        "targetDeviceName",
                        "target_device_name",
                    ],
                )
                .unwrap_or_else(|| active.device_name.clone()),
            );
            let status = device_status_text(device);
            return if status.is_empty() {
                first_non_empty_string(&[&name, "远程设备"])
            } else {
                format!(
                    "{} · {}",
                    first_non_empty_string(&[&name, "远程设备"]),
                    status
                )
            };
        }
        if matches!(
            first_map_string(bot, &["runtimeStatus", "runtime_status"]).as_deref(),
            Some("stale_device")
        ) {
            return "运行设备已失效".to_string();
        }
        return first_non_empty_string(&[
            &compact_device_name(&active.device_name),
            &first_map_string(bot, &["runtimeLabel", "runtime_label"]).unwrap_or_default(),
            "当前设备",
        ]);
    }
    "本机运行".to_string()
}

fn runtime_target_runs_on_other_device(
    active: &RuntimeTarget,
    runtime: &Map<String, Value>,
) -> bool {
    if active.runtime_kind != "desktop-local" {
        return false;
    }
    let current_device_id = current_runtime_device_id(runtime);
    !current_device_id.is_empty()
        && !active.device_id.trim().is_empty()
        && active.device_id != current_device_id
}

fn current_runtime_device_id(runtime: &Map<String, Value>) -> String {
    nested_string(runtime, &["localDevice"], &["id"])
        .or_else(|| nested_string(runtime, &["cloud"], &["deviceId", "device_id"]))
        .unwrap_or_default()
}

fn bot_has_explicit_runtime_device(bot: &Map<String, Value>) -> bool {
    if first_nested_object(
        bot,
        &[
            "targetIntent",
            "target_intent",
            "runtimeTarget",
            "runtime_target",
        ],
    )
    .is_some_and(|intent| first_map_string(intent, &["deviceId", "device_id"]).is_some())
    {
        return true;
    }
    if first_map_string(
        bot,
        &[
            "targetDeviceId",
            "target_device_id",
            "deviceId",
            "device_id",
        ],
    )
    .is_some()
    {
        return true;
    }
    first_nested_object(bot, &["runtimeConfig", "runtime_config", "config"])
        .is_some_and(|config| first_map_string(config, &["deviceId", "device_id"]).is_some())
}

fn runtime_device_by_id<'a>(
    runtime: &'a Map<String, Value>,
    device_id: &str,
) -> Option<&'a Map<String, Value>> {
    let wanted = device_id.trim();
    if wanted.is_empty() {
        return None;
    }
    ["devices", "bridgeDevices", "bridge_devices"]
        .into_iter()
        .flat_map(|key| {
            runtime
                .get("cloud")
                .and_then(Value::as_object)
                .and_then(|cloud| cloud.get(key))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_object)
        .find(|device| {
            first_map_string(device, &["id", "deviceId", "device_id"]).as_deref() == Some(wanted)
        })
}

fn device_status_text(device: &Map<String, Value>) -> String {
    match first_map_string(device, &["status"]).as_deref() {
        Some("online") => "在线".to_string(),
        Some("offline") => "离线".to_string(),
        Some("local") => "本机".to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn active_runtime_target(
    bot: &Map<String, Value>,
    runtime: &Map<String, Value>,
    cloud_runtime: &CloudRuntimeTarget,
) -> RuntimeTarget {
    let target_intent = first_nested_object(
        bot,
        &[
            "targetIntent",
            "target_intent",
            "runtimeTarget",
            "runtime_target",
        ],
    )
    .cloned()
    .unwrap_or_default();
    let config = first_nested_object(bot, &["runtimeConfig", "runtime_config", "config"])
        .cloned()
        .unwrap_or_default();
    let runtime_kind = normalize_runtime_kind(
        &first_map_string(
            bot,
            &["runtimeKind", "runtime_kind", "runtime_kind", "sourceKind"],
        )
        .or_else(|| first_map_string(&target_intent, &["runtimeKind", "runtime_kind"]))
        .or_else(|| first_map_string(&config, &["runtimeKind", "runtime_kind"]))
        .unwrap_or_else(|| "desktop-local".to_string()),
    );
    if runtime_kind == "cloud-claude-code" {
        let agent_engine = strict_agent_engine(
            &first_map_string(&target_intent, &["agentEngine", "agent_engine", "engine"])
                .or_else(|| first_map_string(bot, &["agentEngine", "agent_engine", "engine"]))
                .or_else(|| first_map_string(&config, &["agentEngine", "agent_engine", "engine"]))
                .unwrap_or_else(|| cloud_runtime.agent_engine.clone()),
        );
        return RuntimeTarget {
            runtime_kind,
            device_id: String::new(),
            device_name: "Mia Cloud".to_string(),
            agent_engine,
        };
    }
    let device_id = first_map_string(&target_intent, &["deviceId", "device_id"])
        .or_else(|| {
            first_map_string(
                bot,
                &[
                    "targetDeviceId",
                    "target_device_id",
                    "deviceId",
                    "device_id",
                ],
            )
        })
        .or_else(|| first_map_string(&config, &["deviceId", "device_id"]))
        .or_else(|| nested_string(runtime, &["localDevice"], &["id"]))
        .or_else(|| nested_string(runtime, &["cloud"], &["deviceId", "device_id"]))
        .unwrap_or_else(|| "current-device".to_string());
    let device_name = first_map_string(&target_intent, &["deviceName", "device_name"])
        .or_else(|| {
            first_map_string(
                bot,
                &[
                    "targetDeviceName",
                    "target_device_name",
                    "deviceName",
                    "device_name",
                ],
            )
        })
        .or_else(|| first_map_string(&config, &["deviceName", "device_name"]))
        .or_else(|| {
            nested_string(
                runtime,
                &["localDevice"],
                &["name", "deviceName", "device_name"],
            )
        })
        .or_else(|| nested_string(runtime, &["cloud"], &["deviceName", "device_name"]))
        .map(|value| compact_device_name(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "当前设备".to_string());
    let agent_engine = supported_agent_engine(
        &first_map_string(&target_intent, &["agentEngine", "agent_engine", "engine"])
            .or_else(|| first_map_string(bot, &["agentEngine", "agent_engine", "engine"]))
            .or_else(|| first_map_string(&config, &["agentEngine", "agent_engine", "engine"]))
            .unwrap_or_else(|| "hermes".to_string()),
    )
    .unwrap_or_else(|| "hermes".to_string());
    RuntimeTarget {
        runtime_kind,
        device_id,
        device_name,
        agent_engine,
    }
}

fn cloud_agent_runtime(runtime: &Map<String, Value>) -> CloudRuntimeTarget {
    let cloud = runtime.get("cloud").and_then(Value::as_object);
    let source = cloud
        .and_then(|object| {
            first_nested_object(
                object,
                &[
                    "agentRuntime",
                    "agent_runtime",
                    "cloudAgent",
                    "cloud_agent",
                    "agent",
                ],
            )
        })
        .cloned()
        .unwrap_or_default();
    let runtime_kind = normalize_runtime_kind(
        &first_map_string(&source, &["runtimeKind", "runtime_kind", "kind"]).unwrap_or_default(),
    );
    let agent_engine = strict_agent_engine(
        &first_map_string(
            &source,
            &[
                "agentEngine",
                "agent_engine",
                "engine",
                "defaultAgentEngine",
                "default_agent_engine",
            ],
        )
        .unwrap_or_default(),
    );
    let available = !matches!(source.get("available"), Some(Value::Bool(false)))
        && runtime_kind == "cloud-claude-code"
        && !agent_engine.is_empty();
    CloudRuntimeTarget {
        agent_engine,
        available,
    }
}

fn local_device_target(
    runtime: &Map<String, Value>,
    engine_capabilities: &Map<String, Value>,
    preferred_agent_engine: Option<&str>,
) -> DeviceTarget {
    let id = nested_string(runtime, &["localDevice"], &["id"])
        .or_else(|| nested_string(runtime, &["cloud"], &["deviceId", "device_id"]))
        .unwrap_or_else(|| "current-device".to_string());
    let mut engines = local_runtime_engine_ids(runtime, engine_capabilities);
    if engines.is_empty() {
        let fallback = preferred_agent_engine
            .and_then(supported_agent_engine)
            .unwrap_or_else(|| "hermes".to_string());
        engines.push(fallback);
    }
    DeviceTarget {
        id,
        display_name: "本机".to_string(),
        status_label: "本机".to_string(),
        engines,
    }
}

fn local_runtime_engine_ids(
    runtime: &Map<String, Value>,
    engine_capabilities: &Map<String, Value>,
) -> Vec<String> {
    ["hermes", "claude-code", "codex"]
        .into_iter()
        .filter(|engine| {
            inventory_engine_usable(runtime, engine)
                || legacy_engine_available(runtime, engine)
                || capability_engine_available(engine_capabilities, engine)
        })
        .map(str::to_string)
        .collect()
}

fn inventory_engine_usable(runtime: &Map<String, Value>, engine: &str) -> bool {
    let Some(inventory) = runtime.get("agentInventory").and_then(Value::as_object) else {
        return false;
    };
    let scan_in_progress = inventory
        .get("summary")
        .and_then(Value::as_object)
        .and_then(|summary| summary.get("scanning"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    inventory
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .any(|agent| {
            first_map_string(agent, &["id"])
                .and_then(|value| supported_agent_engine(&value))
                .as_deref()
                == Some(engine)
                && (agent
                    .get("usableInMia")
                    .or_else(|| agent.get("usable_in_mia"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || (scan_in_progress
                        && matches!(
                            first_map_string(agent, &["health", "source"]).as_deref(),
                            Some("checking")
                        )))
        })
}

fn legacy_engine_available(runtime: &Map<String, Value>, engine: &str) -> bool {
    let status = engine_status(runtime, engine);
    status
        .as_ref()
        .is_some_and(|object| bool_field(object, "available") || bool_field(object, "installed"))
        || (engine == "hermes"
            && (bool_field(runtime, "engineInstalled") || bool_field(runtime, "engineRunning")))
}

fn engine_status<'a>(
    runtime: &'a Map<String, Value>,
    engine: &str,
) -> Option<&'a Map<String, Value>> {
    let engines = runtime.get("agentEngines").and_then(Value::as_object)?;
    if engine == "claude-code" {
        engines
            .get("claudeCode")
            .or_else(|| engines.get("claude-code"))
            .and_then(Value::as_object)
    } else {
        engines.get(engine).and_then(Value::as_object)
    }
}

fn capability_engine_available(engine_capabilities: &Map<String, Value>, engine: &str) -> bool {
    let Some(cap) = engine_capabilities
        .get("engines")
        .and_then(Value::as_object)
        .and_then(|engines| engines.get(engine))
        .and_then(Value::as_object)
    else {
        return false;
    };
    if matches!(cap.get("available"), Some(Value::Bool(false))) {
        return false;
    }
    bool_field(cap, "available")
        || non_empty_array_field(cap, "models")
        || non_empty_array_field(cap, "permissionOptions")
        || non_empty_array_field(cap, "permissionProfiles")
        || non_empty_array_field(cap, "permissionModes")
        || non_empty_array_field(cap, "effortLevels")
}

fn first_nested_object<'a>(
    object: &'a Map<String, Value>,
    keys: &[&str],
) -> Option<&'a Map<String, Value>> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_object))
}

fn nested_string(
    object: &Map<String, Value>,
    object_keys: &[&str],
    value_keys: &[&str],
) -> Option<String> {
    object_keys
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_object))
        .and_then(|nested| first_map_string(nested, value_keys))
}

fn nested_bool(object: &Map<String, Value>, object_keys: &[&str], bool_key: &str) -> bool {
    object_keys
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_object))
        .is_some_and(|nested| bool_field(nested, bool_key))
}

fn bool_field(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn non_empty_array_field(object: &Map<String, Value>, key: &str) -> bool {
    object
        .get(key)
        .and_then(Value::as_array)
        .is_some_and(|array| !array.is_empty())
}

fn normalized_control_field(value: &str) -> String {
    match value.trim() {
        "effort" => "effortLevel".to_string(),
        "permission" => "permissionMode".to_string(),
        other => other.to_string(),
    }
}

fn clean_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn model_entry_for_value<'a>(
    entries: &'a [BotRuntimeModelEntryIntent],
    value: &str,
) -> Option<&'a BotRuntimeModelEntryIntent> {
    entries.iter().find(|entry| {
        [
            entry.id.as_ref(),
            entry.value.as_ref(),
            entry.model.as_ref(),
        ]
        .into_iter()
        .flatten()
        .any(|candidate| candidate.trim() == value)
    })
}

fn model_profile_id_from_entry(entry: &BotRuntimeModelEntryIntent) -> Option<String> {
    clean_optional(&entry.model_profile_id).or_else(|| clean_optional(&entry.profile_id))
}

fn canonical_mia_model_id(model: &str) -> String {
    let value = model.trim();
    if value == "mia-default" {
        "mia-auto".to_string()
    } else {
        value.to_string()
    }
}

fn canonical_mia_profile_id(profile_id: &str, model: &str) -> String {
    let raw = profile_id.trim();
    if !raw.starts_with("mia:") {
        return raw.to_string();
    }
    let model_id = canonical_mia_model_id(raw.trim_start_matches("mia:"));
    if model_id.is_empty() {
        let fallback = canonical_mia_model_id(model);
        if fallback.is_empty() {
            raw.to_string()
        } else {
            format!("mia:{fallback}")
        }
    } else {
        format!("mia:{model_id}")
    }
}

fn map_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_map_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| map_string(object, key))
}

fn config_string(config: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| config.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn has_non_empty(object: &Map<String, Value>, key: &str) -> bool {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn compact_device_name(value: &str) -> String {
    let mut text = value.replace(".local", "");
    for marker in ["Mia Desktop", "Mia Bridge"] {
        text = text.replace(marker, "");
    }
    let mut compacted = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for suffix in ["· 本机", "· 在线", "· 离线", "- 本机", "- 在线", "- 离线"] {
        if let Some(stripped) = compacted.strip_suffix(suffix) {
            compacted = stripped.trim().to_string();
        }
    }
    compacted.trim().trim_matches(['·', '-']).trim().to_string()
}

fn bot_summary_from_row(row: sqlx::sqlite::SqliteRow) -> Result<BotSummary, sqlx::Error> {
    Ok(BotSummary {
        id: row.get("id"),
        display_name: row.get("display_name"),
        identity: parse_json(row.get::<String, _>("identity_json"))?,
        capabilities: parse_json(row.get::<String, _>("capability_json"))?,
    })
}

fn parse_json(raw: String) -> Result<Value, sqlx::Error> {
    serde_json::from_str(&raw).map_err(|error| sqlx::Error::Decode(Box::new(error)))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
