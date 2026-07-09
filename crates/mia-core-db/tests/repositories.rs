use mia_core_db::{
    CreateProviderParams, IProviderRepository, ISettingsRepository, SqliteProviderRepository,
    SqliteSettingsRepository, init_database_memory,
};
use serde_json::json;

#[tokio::test]
async fn settings_repository_round_trips_json_values() {
    let db = init_database_memory().await.unwrap();
    let repo = SqliteSettingsRepository::new(db.pool().clone());

    repo.set_json("appearance", json!({ "theme": "dark" }), 1000)
        .await
        .unwrap();
    let saved = repo.get_json("appearance").await.unwrap();

    assert_eq!(saved, Some(json!({ "theme": "dark" })));
}

#[tokio::test]
async fn provider_repository_creates_and_lists_providers() {
    let db = init_database_memory().await.unwrap();
    let repo = SqliteProviderRepository::new(db.pool().clone());

    let created = repo
        .create(CreateProviderParams {
            id: "provider_1",
            kind: "openai",
            display_name: "OpenAI",
            base_url: Some("https://api.openai.com/v1"),
            api_key_env: Some("OPENAI_API_KEY"),
            encrypted_api_key: Some("encrypted"),
            api_mode: Some("responses"),
            auth_type: Some("api_key"),
            models_json: json!(["gpt-5"]),
            enabled: true,
            now_ms: 1000,
        })
        .await
        .unwrap();

    assert_eq!(created.id, "provider_1");
    assert_eq!(created.kind, "openai");
    assert_eq!(created.api_key_env.as_deref(), Some("OPENAI_API_KEY"));
    assert_eq!(created.api_mode.as_deref(), Some("responses"));
    assert_eq!(created.models_json, json!(["gpt-5"]));

    let providers = repo.list().await.unwrap();
    assert_eq!(providers, vec![created]);
    let found = repo.find_by_id("provider_1").await.unwrap().unwrap();
    assert_eq!(found.display_name, "OpenAI");
}
