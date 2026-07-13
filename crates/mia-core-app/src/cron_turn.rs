use std::sync::{Arc, Mutex};

use mia_core_conversation::cron_protocol::{detect_cron_commands, strip_cron_commands};
use mia_core_runtime::{
    EVENT_RUNTIME_STDOUT, RuntimeCancellation, RuntimeEventSink, RuntimeExecutionResult,
    RuntimeProcessEvent, RuntimeSessionManager, RuntimeTurnPlan,
};
use mia_core_tasks::TaskService;
use uuid::Uuid;

use crate::cron_middleware::process_cron_command_outcomes;

pub const MAX_CRON_CONTINUATIONS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronTurnResult {
    pub visible_text: String,
    pub continuation: Option<String>,
    pub next_count: usize,
    pub trace_events: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct CronRuntimeResult {
    pub plan: RuntimeTurnPlan,
    pub execution: RuntimeExecutionResult,
    pub visible_text: String,
    pub continuation_count: usize,
}

pub async fn execute_runtime_with_cron<F>(
    sessions: &RuntimeSessionManager,
    tasks: &TaskService,
    initial_plan: RuntimeTurnPlan,
    mut sink_for_plan: F,
    cancellation: Option<RuntimeCancellation>,
) -> anyhow::Result<CronRuntimeResult>
where
    F: FnMut(&RuntimeTurnPlan) -> RuntimeEventSink,
{
    let bot_id = initial_plan
        .bot_id
        .clone()
        .unwrap_or_else(|| "mia".to_string());
    let conversation_id = initial_plan.conversation_id.clone();
    let mut plan = initial_plan;
    let mut continuation_count = 0;

    loop {
        let destination = sink_for_plan(&plan);
        let event_gate = CronEventGate::new(destination);
        let buffered_sink = event_gate.sink();
        let execution = sessions
            .send_message(plan.clone(), buffered_sink, cancellation.clone())
            .await?;
        let decision = process_completed_cron_turn(
            tasks,
            &bot_id,
            &conversation_id,
            &execution.stdout,
            continuation_count,
        )
        .await;
        continuation_count = decision.next_count;
        let Some(continuation) = decision.continuation else {
            event_gate.finish(true);
            event_gate.emit_trace_events(&plan, &decision.trace_events);
            return Ok(CronRuntimeResult {
                plan,
                execution,
                visible_text: decision.visible_text,
                continuation_count,
            });
        };
        event_gate.finish(false);
        event_gate.emit_trace_events(&plan, &decision.trace_events);
        plan = continuation_plan(&plan, continuation);
    }
}

const CRON_PROTOCOL_PREFIXES: [&str; 4] = [
    "[CRON_LIST]",
    "[CRON_CREATE]",
    "[CRON_UPDATE:",
    "[CRON_DELETE:",
];

struct CronEventGateState {
    protocol_candidate: bool,
    held_suffix: String,
    held_event: Option<RuntimeProcessEvent>,
    buffered: Vec<RuntimeProcessEvent>,
}

struct CronEventGate {
    destination: RuntimeEventSink,
    state: Arc<Mutex<CronEventGateState>>,
}

impl CronEventGate {
    fn new(destination: RuntimeEventSink) -> Self {
        Self {
            destination,
            state: Arc::new(Mutex::new(CronEventGateState {
                protocol_candidate: false,
                held_suffix: String::new(),
                held_event: None,
                buffered: Vec::new(),
            })),
        }
    }

    fn sink(&self) -> RuntimeEventSink {
        let destination = self.destination.clone();
        let state = self.state.clone();
        RuntimeEventSink::new(move |event| {
            let mut direct = Vec::new();
            {
                let mut gate = state.lock().unwrap();
                if event.name != EVENT_RUNTIME_STDOUT {
                    direct.push(event);
                } else if is_non_text_structured_runtime_event(&event) {
                    direct.push(event);
                } else if gate.protocol_candidate {
                    gate.buffered.push(event);
                } else if let Some(text) = event.data.get("text").and_then(|value| value.as_str()) {
                    let combined = format!("{}{}", gate.held_suffix, text);
                    gate.held_suffix.clear();
                    gate.held_event = None;

                    if CRON_PROTOCOL_PREFIXES
                        .iter()
                        .any(|prefix| combined.contains(prefix))
                    {
                        gate.protocol_candidate = true;
                        gate.buffered.push(with_stdout_text(event, combined));
                    } else {
                        let suffix_len = longest_protocol_prefix_suffix(&combined);
                        let safe_len = combined.len() - suffix_len;
                        if safe_len > 0 {
                            direct
                                .push(with_stdout_text(event.clone(), combined[..safe_len].into()));
                        }
                        if suffix_len > 0 {
                            gate.held_suffix = combined[safe_len..].into();
                            gate.held_event = Some(event);
                        }
                    }
                } else {
                    direct.push(event);
                }
            }
            for event in direct {
                destination.emit(event.name, event.data);
            }
        })
    }

    fn finish(&self, replay_if_pending: bool) {
        let events = {
            let mut state = self.state.lock().unwrap();
            let mut events = Vec::new();
            if replay_if_pending {
                events.append(&mut state.buffered);
                if !state.held_suffix.is_empty()
                    && let Some(event) = state.held_event.take()
                {
                    events.push(with_stdout_text(
                        event,
                        std::mem::take(&mut state.held_suffix),
                    ));
                }
            }
            state.buffered.clear();
            state.held_suffix.clear();
            events
        };
        for event in events {
            self.destination.emit(event.name, event.data);
        }
    }

    fn emit_trace_events(&self, plan: &RuntimeTurnPlan, events: &[serde_json::Value]) {
        for event in events {
            self.destination.emit(
                EVENT_RUNTIME_STDOUT,
                serde_json::json!({
                    "turnId": plan.turn_id,
                    "conversationId": plan.conversation_id,
                    "engine": plan.engine,
                    "event": event,
                }),
            );
        }
    }
}

fn is_non_text_structured_runtime_event(event: &RuntimeProcessEvent) -> bool {
    let Some(event_type) = event
        .data
        .get("event")
        .and_then(|event| event.get("type"))
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    !matches!(event_type, "message.delta" | "text_delta")
}

fn longest_protocol_prefix_suffix(text: &str) -> usize {
    CRON_PROTOCOL_PREFIXES
        .iter()
        .flat_map(|prefix| 1..prefix.len())
        .filter(|length| *length <= text.len())
        .filter(|length| text.is_char_boundary(text.len() - length))
        .filter(|length| {
            CRON_PROTOCOL_PREFIXES
                .iter()
                .any(|prefix| prefix.starts_with(&text[text.len() - length..]))
        })
        .max()
        .unwrap_or(0)
}

fn with_stdout_text(mut event: RuntimeProcessEvent, text: String) -> RuntimeProcessEvent {
    event.data["text"] = serde_json::Value::String(text);
    event
}

pub async fn process_completed_cron_turn(
    tasks: &TaskService,
    bot_id: &str,
    conversation_id: &str,
    assistant_text: &str,
    continuation_count: usize,
) -> CronTurnResult {
    let commands = detect_cron_commands(assistant_text);
    if commands.is_empty() {
        return CronTurnResult {
            visible_text: assistant_text.to_string(),
            continuation: None,
            next_count: continuation_count,
            trace_events: Vec::new(),
        };
    }

    let visible_text = strip_cron_commands(assistant_text).trim().to_string();
    if continuation_count >= MAX_CRON_CONTINUATIONS {
        return CronTurnResult {
            visible_text,
            continuation: None,
            next_count: continuation_count,
            trace_events: Vec::new(),
        };
    }

    let outcomes = process_cron_command_outcomes(tasks, bot_id, conversation_id, &commands).await;
    let system_responses = outcomes
        .iter()
        .map(|outcome| outcome.system_response.clone())
        .collect::<Vec<_>>();
    let trace_events = outcomes
        .into_iter()
        .flat_map(|outcome| {
            let id = format!("mia_cron_{}", Uuid::now_v7().simple());
            let started = serde_json::json!({
                "type": "tool.started",
                "id": id,
                "name": outcome.trace_name,
                "status": "running",
            });
            let completed = serde_json::json!({
                "type": "tool.completed",
                "id": id,
                "name": outcome.trace_name,
                "status": if outcome.successful { "completed" } else { "failed" },
                "error": !outcome.successful,
                "preview": outcome.trace_preview,
            });
            [started, completed]
        })
        .collect();
    CronTurnResult {
        visible_text,
        continuation: (!system_responses.is_empty()).then(|| system_responses.join("\n")),
        next_count: continuation_count + 1,
        trace_events,
    }
}

fn continuation_plan(previous: &RuntimeTurnPlan, content: String) -> RuntimeTurnPlan {
    let mut plan = previous.clone();
    let suffix = Uuid::now_v7().simple().to_string();
    plan.send_message.msg_id = format!("msg_cron_{suffix}");
    plan.send_message.turn_id = Some(plan.turn_id.clone());
    plan.send_message.content = content;
    plan.send_message.files.clear();
    plan.send_message.inject_skills.clear();
    plan.selected_skill_ids.clear();
    plan.mock_response = None;
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cron_event_gate_preserves_structured_runtime_events_with_empty_text() {
        let captured = Arc::new(Mutex::new(Vec::<RuntimeProcessEvent>::new()));
        let captured_for_sink = captured.clone();
        let destination = RuntimeEventSink::new(move |event| {
            captured_for_sink.lock().unwrap().push(event);
        });
        let gate = CronEventGate::new(destination);
        let sink = gate.sink();

        sink.emit(
            EVENT_RUNTIME_STDOUT,
            json!({
                "turnId": "turn_1",
                "conversationId": "conversation_1",
                "engine": "claude-code",
                "text": "",
                "event": {
                    "type": "tool.started",
                    "id": "tool_1",
                    "name": "Bash",
                    "status": "running"
                }
            }),
        );

        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data["event"]["type"], "tool.started");
        assert_eq!(events[0].data["event"]["name"], "Bash");
    }
}
