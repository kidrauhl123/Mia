use mia_core_api_types::{MiaMemoryMutationRequest, MiaMemorySearchRequest};
use mia_core_db::init_database_memory;
use mia_core_memory::MemoryService;
use serde_json::json;

#[tokio::test]
async fn memory_service_stores_searches_updates_and_forgets_visible_scoped_memory() {
    let db = init_database_memory().await.unwrap();
    let service = MemoryService::new(db.pool().clone());
    let context = json!({
        "userId": "u1",
        "botId": "mei",
        "sessionId": "s1",
        "originMessageId": "msg_1",
        "engine": "codex",
    });

    let remembered = service
        .remember(MiaMemoryMutationRequest {
            context: context.clone(),
            text: Some("User prefers Rust Core migrations".into()),
            scope: Some("bot".into()),
            priority: Some(25),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(remembered.status, "ok");
    let memory_id = remembered.memory_id.clone().unwrap();

    let search = service
        .search(MiaMemorySearchRequest {
            context: context.clone(),
            query: Some("rust core".into()),
            scopes: vec!["bot".into()],
            limit: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(search.memories.len(), 1);
    assert_eq!(search.memories[0].id, memory_id);
    assert_eq!(search.memories[0].source_message_ids, vec!["msg_1"]);

    let listed = service
        .list(MiaMemorySearchRequest {
            context: context.clone(),
            query: Some("migrations".into()),
            scopes: vec!["bot".into()],
            limit: Some(500),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(listed.memories.len(), 1);
    assert_eq!(listed.memories[0].id, memory_id);

    let all_owned = service
        .list(MiaMemorySearchRequest {
            context: json!({ "userId": "u1" }),
            query: Some("migrations".into()),
            scopes: vec!["bot".into()],
            limit: Some(500),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(all_owned.memories.len(), 1);
    assert_eq!(all_owned.memories[0].id, memory_id);

    let isolated = service
        .search(MiaMemorySearchRequest {
            context: json!({ "userId": "u1", "botId": "other", "sessionId": "s1" }),
            query: Some("rust core".into()),
            limit: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(isolated.memories.is_empty());

    let updated = service
        .update(MiaMemoryMutationRequest {
            context: context.clone(),
            memory_id: Some(memory_id.clone()),
            text: Some("User wants destructive Rust Core migrations".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(updated.status, "ok");
    assert_eq!(
        updated.memory.unwrap().text,
        "User wants destructive Rust Core migrations"
    );

    let forgotten = service
        .forget(MiaMemoryMutationRequest {
            context,
            memory_id: Some(memory_id),
            reason: Some("obsolete".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(forgotten.status, "deleted");
}

#[tokio::test]
async fn memory_service_deletes_owned_memory_by_id_without_bot_scope_visibility() {
    let db = init_database_memory().await.unwrap();
    let service = MemoryService::new(db.pool().clone());

    let remembered = service
        .remember(MiaMemoryMutationRequest {
            context: json!({ "userId": "u1", "botId": "mei", "sessionId": "s1" }),
            text: Some("Mei should prefer terse memory rows".into()),
            scope: Some("bot".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let memory_id = remembered.memory_id.clone().unwrap();

    let deleted = service
        .delete(MiaMemoryMutationRequest {
            context: json!({ "userId": "u1" }),
            memory_id: Some(memory_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(deleted.status, "deleted");
    assert_eq!(deleted.memory_id.as_deref(), Some(memory_id.as_str()));

    let visible = service
        .list(MiaMemorySearchRequest {
            context: json!({ "userId": "u1", "botId": "mei", "sessionId": "s1" }),
            scopes: vec!["bot".into()],
            limit: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(visible.memories.is_empty());
}

#[tokio::test]
async fn memory_service_rejects_credential_like_memory() {
    let db = init_database_memory().await.unwrap();
    let service = MemoryService::new(db.pool().clone());

    let ignored = service
        .remember(MiaMemoryMutationRequest {
            context: json!({ "userId": "u1", "botId": "mei", "sessionId": "s1" }),
            text: Some("my api key is secret".into()),
            scope: Some("user".into()),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(ignored.status, "ignored");
    assert_eq!(
        ignored.policy_reason.unwrap(),
        "looks like credential material"
    );
}
