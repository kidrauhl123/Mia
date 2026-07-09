use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use mia_core_realtime::{EventBus, RealtimeEvent};
use serde_json::json;
use tokio::sync::broadcast;

use super::state::ModuleStates;

pub async fn websocket_events(
    State(states): State<ModuleStates>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, states.realtime))
}

async fn handle_socket(mut socket: WebSocket, realtime: EventBus) {
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

async fn send_event(socket: &mut WebSocket, event: &RealtimeEvent) -> Result<(), axum::Error> {
    let text = serde_json::to_string(event).unwrap_or_else(|_| {
        r#"{"id":"evt_serialize_error","name":"system.statusChanged","createdAt":"1970-01-01T00:00:00Z","data":{"ok":false}}"#.to_string()
    });
    socket.send(Message::Text(text.into())).await
}
