//! Realtime event contracts and fanout boundary for Mia Rust Core.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeEvent {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub data: Value,
}

impl RealtimeEvent {
    pub fn new(name: impl Into<String>, data: Value) -> Self {
        Self {
            id: format!("evt_{}", Uuid::now_v7().simple()),
            name: name.into(),
            created_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
            data,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<RealtimeEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RealtimeEvent> {
        self.sender.subscribe()
    }

    pub fn emit(&self, name: impl Into<String>, data: Value) -> RealtimeEvent {
        let event = RealtimeEvent::new(name, data);
        let _ = self.sender.send(event.clone());
        event
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(256)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn realtime_event_uses_contract_shape() {
        let event = RealtimeEvent::new("system.statusChanged", json!({ "ok": true }));

        assert!(event.id.starts_with("evt_"));
        assert_eq!(event.name, "system.statusChanged");
        assert_eq!(event.data["ok"], true);
        assert!(event.created_at.ends_with('Z'));
    }

    #[tokio::test]
    async fn event_bus_fans_out_events_to_subscribers() {
        let bus = EventBus::default();
        let mut subscriber = bus.subscribe();

        let sent = bus.emit("task.created", json!({ "jobId": "task_123" }));
        let received = subscriber.recv().await.unwrap();

        assert_eq!(received, sent);
        assert_eq!(received.name, "task.created");
        assert_eq!(received.data["jobId"], "task_123");
    }
}
