use std::sync::Arc;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use serde_json::json;

use crate::{
    EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STARTED, RuntimeCancellation, RuntimeEventSink,
    RuntimeExecutionResult, RuntimeTurnPlan,
};

#[async_trait]
pub trait NativeAcpBackend: Send + Sync {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult>;
}

#[derive(Clone)]
pub struct NativeAcpSessionManager {
    backend: Arc<dyn NativeAcpBackend>,
}

impl std::fmt::Debug for NativeAcpSessionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeAcpSessionManager")
            .finish_non_exhaustive()
    }
}

impl NativeAcpSessionManager {
    pub fn unavailable() -> Self {
        Self {
            backend: Arc::new(UnavailableNativeAcpBackend),
        }
    }

    pub fn with_backend_for_tests(backend: Arc<dyn NativeAcpBackend>) -> Self {
        Self { backend }
    }

    pub async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        self.backend.send_message(plan, sink, cancellation).await
    }
}

struct UnavailableNativeAcpBackend;

#[async_trait]
impl NativeAcpBackend for UnavailableNativeAcpBackend {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        _cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        sink.emit(
            EVENT_RUNTIME_STARTED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "protocol": "nativeAcp",
            }),
        );
        sink.emit(
            EVENT_RUNTIME_FINISHED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "exitCode": null,
                "cancelled": false,
                "ok": false,
                "error": "native ACP runtime is unavailable",
            }),
        );
        Err(anyhow!("native ACP runtime is unavailable"))
    }
}
