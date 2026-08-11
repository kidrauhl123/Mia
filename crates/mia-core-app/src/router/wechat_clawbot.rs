use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    WechatClawbotLinkRequest, WechatClawbotPairingCodeRequest, WechatClawbotStatusResponse,
};
use serde_json::{Value, json};

use super::state::ModuleStates;

type WechatClawbotRouteResult =
    Result<Json<WechatClawbotStatusResponse>, (StatusCode, Json<Value>)>;

fn safe_error(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    // Never return an anyhow/reqwest error here: an upstream URL, response, or
    // provider token must not cross the Core loopback API into the renderer.
    (status, Json(json!({ "error": message })))
}

pub async fn get_wechat_clawbot_status(
    State(states): State<ModuleStates>,
    Path(channel_id): Path<String>,
) -> Result<Json<WechatClawbotStatusResponse>, StatusCode> {
    states
        .wechat_clawbot
        .status(&channel_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::BAD_REQUEST)
}

pub async fn start_wechat_clawbot_link(
    State(states): State<ModuleStates>,
    Path(channel_id): Path<String>,
    Json(request): Json<WechatClawbotLinkRequest>,
) -> WechatClawbotRouteResult {
    states
        .wechat_clawbot
        .start_link(&channel_id, request)
        .await
        .map(Json)
        .map_err(|_| {
            safe_error(
                StatusCode::BAD_GATEWAY,
                "暂时无法开始微信连接。请确认 Mia Cloud 与本机桥接已连接后重试。",
            )
        })
}

pub async fn submit_wechat_clawbot_pairing_code(
    State(states): State<ModuleStates>,
    Path(channel_id): Path<String>,
    Json(request): Json<WechatClawbotPairingCodeRequest>,
) -> WechatClawbotRouteResult {
    states
        .wechat_clawbot
        .submit_pairing_code(&channel_id, request)
        .await
        .map(Json)
        .map_err(|_| safe_error(StatusCode::BAD_REQUEST, "请输入有效的微信配对码后重试。"))
}

pub async fn disconnect_wechat_clawbot(
    State(states): State<ModuleStates>,
    Path(channel_id): Path<String>,
) -> WechatClawbotRouteResult {
    states
        .wechat_clawbot
        .disconnect(&channel_id)
        .await
        .map(Json)
        .map_err(|_| {
            safe_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "无法清除本机微信连接，请重试。",
            )
        })
}

pub async fn shutdown_wechat_clawbot(State(states): State<ModuleStates>) -> StatusCode {
    states.wechat_clawbot.shutdown().await;
    StatusCode::NO_CONTENT
}
