use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use mia_core_realtime::{EventBus, RealtimeEvent};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use super::state::ModuleStates;

#[derive(Debug, Default, Deserialize)]
pub struct RealtimeQuery {
    scope: Option<String>,
}

pub async fn websocket_events(
    State(states): State<ModuleStates>,
    Query(query): Query<RealtimeQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let control_only = query.scope.as_deref() == Some("control");
    ws.on_upgrade(move |socket| handle_socket(socket, states.realtime, control_only))
}

async fn handle_socket(mut socket: WebSocket, realtime: EventBus, control_only: bool) {
    let mut events = realtime.subscribe();
    let ready = RealtimeEvent::new("system.statusChanged", json!({ "ok": true }));
    if send_event(&mut socket, &ready).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if control_only && !is_control_event(&event) {
                            continue;
                        }
                        if send_event(&mut socket, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

fn is_control_event(event: &RealtimeEvent) -> bool {
    event.name.starts_with("system.") || event.name.starts_with("daemon.")
}

async fn send_event(socket: &mut WebSocket, event: &RealtimeEvent) -> Result<(), axum::Error> {
    let text = serde_json::to_string(event).unwrap_or_else(|_| {
        r#"{"id":"evt_serialize_error","name":"system.statusChanged","createdAt":"1970-01-01T00:00:00Z","data":{"ok":false}}"#.to_string()
    });
    socket.send(Message::Text(text.into())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_scope_excludes_conversation_and_task_hot_path_events() {
        assert!(is_control_event(&RealtimeEvent::new(
            "system.statusChanged",
            json!({})
        )));
        assert!(is_control_event(&RealtimeEvent::new(
            "daemon.cloud_runtime_status",
            json!({})
        )));
        assert!(!is_control_event(&RealtimeEvent::new(
            "conversation.runtimeStdout",
            json!({})
        )));
        assert!(!is_control_event(&RealtimeEvent::new(
            "task.updated",
            json!({})
        )));
    }
}
