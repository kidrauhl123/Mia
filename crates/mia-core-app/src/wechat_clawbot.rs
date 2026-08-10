//! Local-only relay for Tencent's official WeChat ClawBot HTTP protocol.
//!
//! The Cloud stores routing metadata and durable delivery events only.  This
//! module deliberately keeps the WeChat Bot token, getUpdates cursor and the
//! per-message `context_token` in a private Core-owned file on the selected
//! device.  It does not launch OpenClaw or a second Agent process: inbound
//! text enters the existing Mia Cloud conversation -> Core Bot execution path.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use mia_core_api_types::{
    WechatClawbotLinkRequest, WechatClawbotPairingCodeRequest, WechatClawbotStatusResponse,
};
use mia_core_cloud::{CloudBridgeManager, CloudDomainEventHandler, CloudError, CloudService};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tokio::time::sleep;
use uuid::Uuid;

const WECHAT_API_BASE: &str = "https://ilinkai.weixin.qq.com";
const WECHAT_APP_ID: &str = "bot";
const WECHAT_CLIENT_VERSION: &str = "132102"; // Tencent openclaw-weixin 2.4.6 wire version.
const QR_LOGIN_TTL: Duration = Duration::from_secs(5 * 60);
const QR_POLL_TIMEOUT: Duration = Duration::from_secs(40);
const GET_UPDATES_TIMEOUT: Duration = Duration::from_secs(45);
const SEND_TIMEOUT: Duration = Duration::from_secs(20);
const NOTIFY_TIMEOUT: Duration = Duration::from_secs(10);
const CLOUD_RELAY_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_DELIVERY_CONTEXTS: usize = 512;
const MAX_SENT_DELIVERIES: usize = 512;
const MAX_QUEUED_REPLIES: usize = 512;
const MAX_PENDING_ACKS: usize = 512;
const MAX_RETRY_DELIVERIES_PER_CYCLE: usize = 4;

#[derive(Clone)]
pub struct WechatClawbotService {
    data_dir: Arc<PathBuf>,
    cloud: CloudService,
    cloud_bridge: CloudBridgeManager,
    http: Client,
    runtime: Arc<Mutex<HashMap<String, RelayRuntime>>>,
    channel_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl std::fmt::Debug for WechatClawbotService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Do not derive Debug: the service owns a local store containing the
        // WeChat Bot token and per-message context tokens.
        formatter
            .debug_struct("WechatClawbotService")
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
struct RelayRuntime {
    device_id: String,
    state: String,
    message: String,
    linked: bool,
    qrcode_url: Option<String>,
    active_login: Option<ActiveLogin>,
    monitor_abort: Option<AbortHandle>,
    monitor_running: bool,
}

#[derive(Clone)]
struct ActiveLogin {
    qrcode: String,
    api_base_url: String,
    started_at_ms: u64,
    pending_verify_code: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RelaySession {
    version: u8,
    channel_id: String,
    device_id: String,
    account_id: String,
    // The official QR confirmation identifies the WeChat account that
    // authorized this Bot. Keep it device-local and use it as the default
    // direct-message gate, so setup never asks the user to discover or type
    // an opaque WeChat user ID.
    #[serde(default)]
    owner_user_id: String,
    base_url: String,
    token: String,
    #[serde(default)]
    sync_cursor: String,
    #[serde(default)]
    delivery_contexts: BTreeMap<String, DeliveryContext>,
    #[serde(default)]
    pending_contexts: BTreeMap<String, DeliveryContext>,
    #[serde(default)]
    sent_delivery_ids: Vec<String>,
    // A reply is written here before its first WeChat send attempt.  Cloud
    // event cursors advance independently, so this local queue is what lets a
    // temporary WeChat or Cloud acknowledgement failure recover after an
    // event has already been consumed.
    #[serde(default)]
    queued_replies: BTreeMap<String, QueuedReply>,
    #[serde(default)]
    pending_ack_delivery_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryContext {
    to_user_id: String,
    context_token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedReply {
    text: String,
    #[serde(default)]
    attempts: u32,
    #[serde(default)]
    next_attempt_at_ms: u64,
}

impl WechatClawbotService {
    pub fn new(data_dir: PathBuf, cloud: CloudService, cloud_bridge: CloudBridgeManager) -> Self {
        Self {
            data_dir: Arc::new(data_dir),
            cloud,
            cloud_bridge,
            http: Client::new(),
            runtime: Arc::new(Mutex::new(HashMap::new())),
            channel_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn status(&self, channel_id: &str) -> Result<WechatClawbotStatusResponse> {
        let channel_id = clean_identifier(channel_id, "channelId")?;
        if let Some(runtime) = self.runtime.lock().await.get(&channel_id) {
            return Ok(status_from_runtime(&channel_id, runtime));
        }
        match self.load_session(&channel_id) {
            Ok(session) if session_is_usable(&session) => Ok(WechatClawbotStatusResponse {
                channel_id,
                device_id: session.device_id,
                state: "linked".into(),
                message: "微信 ClawBot 已连接，等待本机桥接启动。".into(),
                linked: true,
                qr_url: None,
            }),
            _ => Ok(WechatClawbotStatusResponse {
                channel_id,
                device_id: String::new(),
                state: "disconnected".into(),
                message: "尚未连接微信 ClawBot。".into(),
                linked: false,
                qr_url: None,
            }),
        }
    }

    pub async fn start_link(
        &self,
        channel_id: &str,
        request: WechatClawbotLinkRequest,
    ) -> Result<WechatClawbotStatusResponse> {
        let channel_id = clean_identifier(channel_id, "channelId")?;
        let device_id = clean_identifier(&request.device_id, "deviceId")?;
        let cloud_status = self.cloud.status(false).await?;
        if !cloud_status.enabled {
            return Err(anyhow!("请先登录 Mia Cloud，再连接微信 ClawBot。"));
        }
        let bridge_status = self.cloud_bridge.status(false).await?;
        let active_device_id = bridge_status.device_id.trim();
        if active_device_id.is_empty() {
            return Err(anyhow!("当前设备桥接尚未就绪，请稍候重试。"));
        }
        if active_device_id != device_id {
            return Err(anyhow!("微信 ClawBot 只能绑定当前 Mia 设备。"));
        }

        if let Some(runtime) = self.runtime.lock().await.get(&channel_id)
            && runtime.linked
            && runtime.device_id == device_id
        {
            return Ok(status_from_runtime(&channel_id, runtime));
        }

        let qr = self.request_qrcode().await?;
        let qrcode =
            value_string(&qr, "qrcode").ok_or_else(|| anyhow!("微信未返回可用二维码。"))?;
        let qrcode_url = value_string(&qr, "qrcode_img_content")
            .ok_or_else(|| anyhow!("微信未返回二维码图片。"))?;
        {
            let mut runtimes = self.runtime.lock().await;
            runtimes.insert(
                channel_id.clone(),
                RelayRuntime {
                    device_id: device_id.clone(),
                    state: "waiting_for_scan".into(),
                    message: "请用手机微信扫描二维码。".into(),
                    linked: false,
                    qrcode_url: Some(qrcode_url),
                    active_login: Some(ActiveLogin {
                        qrcode,
                        api_base_url: WECHAT_API_BASE.into(),
                        started_at_ms: unix_ms(),
                        pending_verify_code: String::new(),
                    }),
                    monitor_abort: None,
                    monitor_running: false,
                },
            );
        }
        let service = self.clone();
        let poll_channel_id = channel_id.clone();
        tokio::spawn(async move {
            service.poll_login(poll_channel_id).await;
        });
        self.status(&channel_id).await
    }

    pub async fn submit_pairing_code(
        &self,
        channel_id: &str,
        request: WechatClawbotPairingCodeRequest,
    ) -> Result<WechatClawbotStatusResponse> {
        let channel_id = clean_identifier(channel_id, "channelId")?;
        let code = request.code.trim();
        if code.is_empty() || code.len() > 32 || !code.chars().all(|ch| ch.is_ascii_digit()) {
            return Err(anyhow!("请输入手机微信显示的数字配对码。"));
        }
        let mut runtimes = self.runtime.lock().await;
        let runtime = runtimes
            .get_mut(&channel_id)
            .ok_or_else(|| anyhow!("当前没有进行中的微信连接。"))?;
        let login = runtime
            .active_login
            .as_mut()
            .ok_or_else(|| anyhow!("当前没有进行中的微信连接。"))?;
        login.pending_verify_code = code.to_string();
        runtime.state = "verifying".into();
        runtime.message = "正在验证配对码。".into();
        Ok(status_from_runtime(&channel_id, runtime))
    }

    pub async fn disconnect(&self, channel_id: &str) -> Result<WechatClawbotStatusResponse> {
        let channel_id = clean_identifier(channel_id, "channelId")?;
        // Keep a clone only long enough to issue the protocol's best-effort
        // stop notification.  The session file is still removed immediately,
        // so neither a QR reconnect nor a future Core start can reuse it.
        let saved_session = self.load_session(&channel_id).ok();
        if let Some(runtime) = self.runtime.lock().await.get_mut(&channel_id) {
            if let Some(abort) = runtime.monitor_abort.take() {
                abort.abort();
            }
            runtime.monitor_running = false;
            runtime.active_login = None;
            runtime.linked = false;
            runtime.qrcode_url = None;
            runtime.state = "disconnected".into();
            runtime.message = "已断开微信 ClawBot，并删除本机连接凭据。".into();
        }
        self.remove_session(&channel_id)?;
        if let Some(session) = saved_session {
            let service = self.clone();
            tokio::spawn(async move {
                let _ = service.notify_session_stop(&session).await;
            });
        }
        self.status(&channel_id).await
    }

    /// Called after a Cloud account connects.  Only sessions already written by
    /// this device are resumed; there is no Cloud copy of WeChat credentials.
    pub async fn resume(&self) -> Result<()> {
        if !self.cloud.status(false).await?.enabled {
            return Ok(());
        }
        let directory = self.session_dir();
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Ok(()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(session) = serde_json::from_slice::<RelaySession>(&bytes) else {
                continue;
            };
            if !session_is_usable(&session)
                || clean_identifier(&session.channel_id, "channelId").is_err()
            {
                continue;
            }
            self.set_linked_runtime(&session).await;
            self.start_monitor(session).await;
        }
        Ok(())
    }

    /// Stop local long polling while Cloud is disconnected, but retain the
    /// private device session so a later Cloud reconnect can resume it.
    pub async fn pause(&self) {
        let mut stopped_channels = Vec::new();
        let mut runtimes = self.runtime.lock().await;
        for (channel_id, runtime) in runtimes.iter_mut() {
            if let Some(abort) = runtime.monitor_abort.take() {
                abort.abort();
            }
            runtime.monitor_running = false;
            if runtime.linked {
                runtime.state = "paused".into();
                runtime.message = "Mia Cloud 未连接，微信桥接已暂停。".into();
                stopped_channels.push(channel_id.clone());
            }
        }
        drop(runtimes);
        // `notifystop` is advisory.  It must never prevent Cloud disconnect
        // or retain a local session, and its authenticated request stays local
        // to Core just like all other protocol calls.
        for channel_id in stopped_channels {
            if let Ok(session) = self.load_session(&channel_id) {
                let service = self.clone();
                tokio::spawn(async move {
                    let _ = service.notify_session_stop(&session).await;
                });
            }
        }
    }

    async fn request_qrcode(&self) -> Result<Value> {
        let url = api_url(WECHAT_API_BASE, "ilink/bot/get_bot_qrcode?bot_type=3")?;
        self.post_wechat_json(
            url,
            json!({ "local_token_list": [] }),
            None,
            Duration::from_secs(20),
        )
        .await
    }

    async fn poll_login(&self, channel_id: String) {
        loop {
            let login = {
                let runtimes = self.runtime.lock().await;
                runtimes
                    .get(&channel_id)
                    .and_then(|runtime| runtime.active_login.clone())
            };
            let Some(login) = login else { return };
            if unix_ms().saturating_sub(login.started_at_ms) > QR_LOGIN_TTL.as_millis() as u64 {
                self.set_login_failure(&channel_id, "二维码已过期，请重新连接。")
                    .await;
                return;
            }
            let result = self.poll_qrcode_status(&login).await;
            match result {
                Ok(value) => {
                    let status = value_string(&value, "status").unwrap_or_else(|| "wait".into());
                    match status.as_str() {
                        "wait" => {}
                        "scaned" => {
                            let mut runtimes = self.runtime.lock().await;
                            if let Some(runtime) = runtimes.get_mut(&channel_id) {
                                if let Some(active) = runtime.active_login.as_mut() {
                                    active.pending_verify_code.clear();
                                }
                                runtime.state = "scanned".into();
                                runtime.message = "已扫码，正在等待微信确认。".into();
                            }
                        }
                        "need_verifycode" => {
                            let mut runtimes = self.runtime.lock().await;
                            if let Some(runtime) = runtimes.get_mut(&channel_id) {
                                runtime.state = "pairing_code_required".into();
                                runtime.message = "请输入手机微信显示的数字配对码。".into();
                            }
                        }
                        "scaned_but_redirect" => {
                            let redirect_host =
                                value_string(&value, "redirect_host").unwrap_or_default();
                            if is_safe_host(&redirect_host) {
                                let mut runtimes = self.runtime.lock().await;
                                if let Some(runtime) = runtimes.get_mut(&channel_id)
                                    && let Some(active) = runtime.active_login.as_mut()
                                {
                                    active.api_base_url = format!("https://{redirect_host}");
                                }
                            }
                        }
                        "expired" | "verify_code_blocked" => match self.request_qrcode().await {
                            Ok(qr) => {
                                let qrcode = value_string(&qr, "qrcode");
                                let qrcode_url = value_string(&qr, "qrcode_img_content");
                                if let (Some(qrcode), Some(qrcode_url)) = (qrcode, qrcode_url) {
                                    let mut runtimes = self.runtime.lock().await;
                                    if let Some(runtime) = runtimes.get_mut(&channel_id) {
                                        runtime.qrcode_url = Some(qrcode_url);
                                        runtime.state = "waiting_for_scan".into();
                                        runtime.message = "二维码已更新，请重新扫描。".into();
                                        if let Some(active) = runtime.active_login.as_mut() {
                                            active.qrcode = qrcode;
                                            active.api_base_url = WECHAT_API_BASE.into();
                                            active.started_at_ms = unix_ms();
                                            active.pending_verify_code.clear();
                                        }
                                    }
                                } else {
                                    self.set_login_failure(&channel_id, "微信未返回新的二维码。")
                                        .await;
                                    return;
                                }
                            }
                            Err(_) => {
                                self.set_login_failure(
                                    &channel_id,
                                    "刷新微信二维码失败，请稍后重试。",
                                )
                                .await;
                                return;
                            }
                        },
                        "binded_redirect" => {
                            match self.load_session(&channel_id) {
                                Ok(session) if session_is_usable(&session) => {
                                    self.set_linked_runtime(&session).await;
                                    self.start_monitor(session).await;
                                }
                                _ => self.set_login_failure(
                                    &channel_id,
                                    "该微信 ClawBot 已绑定到其他本机连接，请在原设备断开后重试。",
                                ).await,
                            }
                            return;
                        }
                        "confirmed" => {
                            let token = value_string(&value, "bot_token");
                            let account_id = value_string(&value, "ilink_bot_id");
                            let owner_user_id = value_string(&value, "ilink_user_id")
                                .and_then(|value| normalize_wechat_user_id(&value));
                            let base_url = value_string(&value, "baseurl")
                                .filter(|value| valid_base_url(value))
                                .unwrap_or_else(|| WECHAT_API_BASE.into());
                            let device_id = {
                                self.runtime
                                    .lock()
                                    .await
                                    .get(&channel_id)
                                    .map(|runtime| runtime.device_id.clone())
                                    .unwrap_or_default()
                            };
                            if let (Some(token), Some(account_id), Some(owner_user_id)) =
                                (token, account_id, owner_user_id)
                                && !device_id.is_empty()
                            {
                                let session = RelaySession {
                                    version: 1,
                                    channel_id: channel_id.clone(),
                                    device_id,
                                    account_id,
                                    owner_user_id,
                                    base_url,
                                    token,
                                    sync_cursor: String::new(),
                                    delivery_contexts: BTreeMap::new(),
                                    pending_contexts: BTreeMap::new(),
                                    sent_delivery_ids: Vec::new(),
                                    queued_replies: BTreeMap::new(),
                                    pending_ack_delivery_ids: Vec::new(),
                                };
                                if self.write_session(&session).is_ok() {
                                    self.set_linked_runtime(&session).await;
                                    self.start_monitor(session).await;
                                } else {
                                    self.set_login_failure(
                                        &channel_id,
                                        "无法安全保存微信连接凭据。",
                                    )
                                    .await;
                                }
                            } else {
                                self.set_login_failure(
                                    &channel_id,
                                    "微信未返回扫码账号信息，请重新连接。",
                                )
                                .await;
                            }
                            return;
                        }
                        _ => {
                            self.set_login_failure(&channel_id, "微信连接状态异常，请重新连接。")
                                .await;
                            return;
                        }
                    }
                }
                Err(_) => {
                    // QR long polling can occasionally be cut by an edge.  Do
                    // not expose its raw response and keep polling within the
                    // short per-request deadline instead of an arbitrary 180s.
                }
            }
            sleep(Duration::from_secs(1)).await;
        }
    }

    async fn poll_qrcode_status(&self, login: &ActiveLogin) -> Result<Value> {
        let mut url = api_url(&login.api_base_url, "ilink/bot/get_qrcode_status")?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("qrcode", &login.qrcode);
            if !login.pending_verify_code.is_empty() {
                query.append_pair("verify_code", &login.pending_verify_code);
            }
        }
        self.get_wechat_json(url, QR_POLL_TIMEOUT).await
    }

    async fn start_monitor(&self, session: RelaySession) {
        if !session_is_usable(&session) {
            return;
        }
        let channel_id = session.channel_id.clone();
        {
            let mut runtimes = self.runtime.lock().await;
            let runtime = runtimes.entry(channel_id.clone()).or_default();
            if runtime.monitor_running {
                return;
            }
            runtime.device_id = session.device_id.clone();
            runtime.linked = true;
            runtime.state = "linked".into();
            runtime.message = "微信 ClawBot 已连接。".into();
            runtime.qrcode_url = None;
            runtime.active_login = None;
            runtime.monitor_running = true;
        }
        let service = self.clone();
        let task_channel_id = channel_id.clone();
        let handle = tokio::spawn(async move {
            service.monitor_session(task_channel_id.clone()).await;
            service.finish_monitor(&task_channel_id).await;
        });
        if let Some(runtime) = self.runtime.lock().await.get_mut(&channel_id) {
            runtime.monitor_abort = Some(handle.abort_handle());
        }
    }

    async fn monitor_session(&self, channel_id: String) {
        if let Ok(session) = self.read_locked_session(&channel_id).await {
            // The official protocol treats this as advisory; do not make an
            // intermittent notification failure prevent long polling.
            let _ = self.notify_session_start(&session).await;
        }
        let mut failures = 0_u8;
        loop {
            if self.retry_queued_replies(&channel_id).await.is_err() {
                self.set_monitor_message(
                    &channel_id,
                    "linked",
                    "微信回复仍在本机队列中，正在重试。",
                    true,
                )
                .await;
            }
            let session = match self.read_locked_session(&channel_id).await {
                Ok(session) if session_is_usable(&session) => session,
                _ => return,
            };
            let response = self
                .post_wechat_json(
                    match api_url(&session.base_url, "ilink/bot/getupdates") {
                        Ok(url) => url,
                        Err(_) => {
                            self.set_monitor_message(
                                &channel_id,
                                "reauth_required",
                                "微信连接地址无效，请重新连接。",
                                false,
                            )
                            .await;
                            return;
                        }
                    },
                    json!({
                        "get_updates_buf": session.sync_cursor,
                        "base_info": wechat_base_info()
                    }),
                    Some(&session.token),
                    GET_UPDATES_TIMEOUT,
                )
                .await;
            let value = match response {
                Ok(value) => value,
                Err(_) => {
                    failures = failures.saturating_add(1);
                    self.set_monitor_message(
                        &channel_id,
                        "reconnecting",
                        "微信连接暂时不可用，正在重试。",
                        true,
                    )
                    .await;
                    sleep(if failures >= 3 {
                        Duration::from_secs(20)
                    } else {
                        Duration::from_secs(2)
                    })
                    .await;
                    if failures >= 3 {
                        failures = 0;
                    }
                    continue;
                }
            };
            let ret = value_i64(&value, "ret").unwrap_or(0);
            let errcode = value_i64(&value, "errcode").unwrap_or(0);
            if errcode == -14 || ret == -14 {
                let _ = self.remove_session(&channel_id);
                self.set_monitor_message(
                    &channel_id,
                    "reauth_required",
                    "微信登录已失效，请重新扫码连接。",
                    false,
                )
                .await;
                return;
            }
            if ret != 0 || errcode != 0 {
                failures = failures.saturating_add(1);
                self.set_monitor_message(
                    &channel_id,
                    "reconnecting",
                    "微信暂时未能读取新消息，正在重试。",
                    true,
                )
                .await;
                sleep(if failures >= 3 {
                    Duration::from_secs(20)
                } else {
                    Duration::from_secs(2)
                })
                .await;
                if failures >= 3 {
                    failures = 0;
                }
                continue;
            }
            failures = 0;
            let messages = value
                .get("msgs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut accepted_all = true;
            for message in messages {
                if self
                    .forward_inbound_message(&channel_id, &message)
                    .await
                    .is_err()
                {
                    accepted_all = false;
                    break;
                }
            }
            if !accepted_all {
                sleep(Duration::from_secs(2)).await;
                continue;
            }
            if let Some(cursor) = value_string(&value, "get_updates_buf") {
                let _ = self.update_sync_cursor(&channel_id, cursor).await;
            }
            self.set_monitor_message(&channel_id, "linked", "微信 ClawBot 已连接。", true)
                .await;
        }
    }

    async fn forward_inbound_message(&self, channel_id: &str, message: &Value) -> Result<()> {
        if value_i64(message, "message_type").unwrap_or(1) != 1 {
            return Ok(());
        }
        if value_string(message, "group_id").is_some_and(|value| !value.is_empty()) {
            // First release is deliberately direct-message only.  Do not make a
            // group delivery look like a direct conversation in Cloud.
            return Ok(());
        }
        let Some(sender_id) = value_string(message, "from_user_id") else {
            return Ok(());
        };
        let Some(context_token) = value_string(message, "context_token") else {
            return Ok(());
        };
        let Some(text) = text_item(message) else {
            return Ok(());
        };
        let event_id = inbound_event_id(message)?;
        let context = DeliveryContext {
            to_user_id: sender_id.clone(),
            context_token,
        };

        let session = {
            let lock = self.channel_lock(channel_id).await;
            let _guard = lock.lock().await;
            let mut session = self.load_session(channel_id)?;
            // Match Lobster/OpenClaw's default pairing behavior: only the
            // WeChat account that completed the QR authorization can enter
            // this Bot. The identifier and comparison both stay in Core;
            // Cloud receives no authorization list or WeChat credentials.
            if !is_authorized_sender(&session, &sender_id) {
                return Ok(());
            }
            if session.pending_contexts.len() >= MAX_DELIVERY_CONTEXTS {
                trim_map(&mut session.pending_contexts, MAX_DELIVERY_CONTEXTS - 1);
            }
            session.pending_contexts.insert(event_id.clone(), context);
            self.write_session(&session)?;
            session
        };
        let path = format!("/api/me/im-channels/{channel_id}/relay/inbound");
        let response = tokio::time::timeout(
            CLOUD_RELAY_TIMEOUT,
            self.cloud.post_authenticated_json(
                &path,
                json!({
                    "deviceId": session.device_id,
                    "eventId": event_id,
                    "senderId": sender_id,
                    "senderLabel": sender_id,
                    "externalChatId": sender_id,
                    "chatType": "p2p",
                    "text": text,
                }),
            ),
        )
        .await
        .map_err(|_| anyhow!("Cloud relay request timed out"))??;
        if response.get("accepted").and_then(Value::as_bool) == Some(false) {
            self.remove_pending_context(channel_id, &event_id).await?;
            return Ok(());
        }
        let delivery_id = value_string(&response, "deliveryId")
            .ok_or_else(|| anyhow!("Cloud relay did not return delivery ID"))?;
        let _ = clean_identifier(&delivery_id, "deliveryId")?;
        self.promote_delivery_context(channel_id, &event_id, &delivery_id)
            .await?;
        self.activate_delivery(channel_id, &session.device_id, &delivery_id)
            .await
    }

    async fn handle_delivery_event(&self, message: Value) -> Result<()> {
        if message.get("type").and_then(Value::as_str) != Some("im_channel.delivery_requested") {
            return Ok(());
        }
        let channel_id = clean_identifier(
            value_string(&message, "channelId")
                .as_deref()
                .unwrap_or_default(),
            "channelId",
        )?;
        let target_device_id = clean_identifier(
            value_string(&message, "targetDeviceId")
                .as_deref()
                .unwrap_or_default(),
            "deviceId",
        )?;
        let delivery_id = clean_identifier(
            value_string(&message, "deliveryId")
                .as_deref()
                .unwrap_or_default(),
            "deliveryId",
        )?;
        let text = value_string(&message, "text").unwrap_or_default();
        if text.is_empty() || text.len() > 12_000 {
            return Err(anyhow!("invalid delivery text"));
        }
        let lock = self.channel_lock(&channel_id).await;
        let _guard = lock.lock().await;
        let mut session = match self.load_session(&channel_id) {
            Ok(session) => session,
            Err(_) => return Ok(()), // The event may target a different device or be replayed before link.
        };
        if !session_is_usable(&session) || session.device_id != target_device_id {
            return Ok(());
        }
        if session
            .sent_delivery_ids
            .iter()
            .any(|id| id == &delivery_id)
        {
            queue_delivery_ack(&mut session, &delivery_id);
            self.write_session(&session)?;
            self.flush_pending_acks(&channel_id, &mut session).await?;
            return Ok(());
        }
        let Some(context) = session.delivery_contexts.get(&delivery_id).cloned() else {
            // We cannot safely reconstruct a WeChat context token from Cloud.
            // Mark this one delivery failed, but keep the rest of the relay
            // alive.  Any provider detail stays out of Cloud/UI logs.
            let _ = self
                .ack_delivery(&channel_id, &session.device_id, &delivery_id, false)
                .await;
            drop(_guard);
            self.set_monitor_message(
                &channel_id,
                "linked",
                "缺少微信回复上下文；该条回复未投递。",
                true,
            )
            .await;
            return Ok(());
        };
        queue_delivery_reply(&mut session, &delivery_id, &text);
        // Persist before making the provider request. If a process or network
        // failure happens after WeChat accepts the message, retrying uses the
        // same client_id and remains deduplicable by the provider.
        self.write_session(&session)?;
        let sent = self
            .send_text_reply(&session, &delivery_id, &context, &text)
            .await;
        if sent.is_err() {
            mark_reply_retry(&mut session, &delivery_id);
            self.write_session(&session)?;
            let _ = self
                .ack_delivery(&channel_id, &session.device_id, &delivery_id, false)
                .await;
            drop(_guard);
            self.set_monitor_message(
                &channel_id,
                "linked",
                "微信回复未投递，已保存在本机队列中并将自动重试。",
                true,
            )
            .await;
            return Ok(());
        }
        mark_delivery_sent(&mut session, &delivery_id);
        self.write_session(&session)?;
        self.flush_pending_acks(&channel_id, &mut session).await
    }

    /// Retry local delivery work that outlives an already-consumed Cloud event.
    /// The lock intentionally serializes sends per channel: each WeChat reply
    /// gets a stable client_id and can never race a replay of the same event.
    async fn retry_queued_replies(&self, channel_id: &str) -> Result<()> {
        let lock = self.channel_lock(channel_id).await;
        let _guard = lock.lock().await;
        let mut session = match self.load_session(channel_id) {
            Ok(session) if session_is_usable(&session) => session,
            _ => return Ok(()),
        };
        self.flush_pending_acks(channel_id, &mut session).await?;
        let now = unix_ms();
        let due_delivery_ids = session
            .queued_replies
            .iter()
            .filter(|(_, reply)| reply.next_attempt_at_ms <= now)
            .map(|(delivery_id, _)| delivery_id.clone())
            .take(MAX_RETRY_DELIVERIES_PER_CYCLE)
            .collect::<Vec<_>>();
        let mut send_failed = false;
        for delivery_id in due_delivery_ids {
            if session
                .sent_delivery_ids
                .iter()
                .any(|id| id == &delivery_id)
            {
                session.queued_replies.remove(&delivery_id);
                queue_delivery_ack(&mut session, &delivery_id);
                self.write_session(&session)?;
                self.flush_pending_acks(channel_id, &mut session).await?;
                continue;
            }
            let Some(context) = session.delivery_contexts.get(&delivery_id).cloned() else {
                session.queued_replies.remove(&delivery_id);
                self.write_session(&session)?;
                let _ = self
                    .ack_delivery(channel_id, &session.device_id, &delivery_id, false)
                    .await;
                continue;
            };
            let Some(text) = session
                .queued_replies
                .get(&delivery_id)
                .map(|reply| reply.text.clone())
            else {
                continue;
            };
            if self
                .send_text_reply(&session, &delivery_id, &context, &text)
                .await
                .is_ok()
            {
                mark_delivery_sent(&mut session, &delivery_id);
                self.write_session(&session)?;
                self.flush_pending_acks(channel_id, &mut session).await?;
            } else {
                mark_reply_retry(&mut session, &delivery_id);
                self.write_session(&session)?;
                let _ = self
                    .ack_delivery(channel_id, &session.device_id, &delivery_id, false)
                    .await;
                send_failed = true;
            }
        }
        if send_failed {
            return Err(anyhow!("WeChat reply retry is pending"));
        }
        Ok(())
    }

    /// Persisted acknowledgements are retried separately from provider sends.
    /// That prevents a successful WeChat send from being sent again merely
    /// because the Cloud acknowledgement request was briefly unavailable.
    async fn flush_pending_acks(&self, channel_id: &str, session: &mut RelaySession) -> Result<()> {
        let pending = session
            .pending_ack_delivery_ids
            .iter()
            .take(MAX_RETRY_DELIVERIES_PER_CYCLE)
            .cloned()
            .collect::<Vec<_>>();
        for delivery_id in pending {
            if self
                .ack_delivery(channel_id, &session.device_id, &delivery_id, true)
                .await
                .is_ok()
            {
                session
                    .pending_ack_delivery_ids
                    .retain(|id| id != &delivery_id);
                self.write_session(session)?;
            }
        }
        Ok(())
    }

    async fn send_text_reply(
        &self,
        session: &RelaySession,
        delivery_id: &str,
        context: &DeliveryContext,
        text: &str,
    ) -> Result<()> {
        let value = self
            .post_wechat_json(
                api_url(&session.base_url, "ilink/bot/sendmessage")?,
                json!({
                    "msg": {
                        "from_user_id": "",
                        "to_user_id": context.to_user_id,
                        "client_id": delivery_id,
                        "message_type": 2,
                        "message_state": 2,
                        "item_list": [{ "type": 1, "text_item": { "text": text } }],
                        "context_token": context.context_token,
                    },
                    "base_info": wechat_base_info()
                }),
                Some(&session.token),
                SEND_TIMEOUT,
            )
            .await?;
        if value_i64(&value, "ret").unwrap_or(0) != 0 {
            return Err(anyhow!("WeChat rejected reply"));
        }
        Ok(())
    }

    async fn notify_session_start(&self, session: &RelaySession) -> Result<()> {
        self.notify_session(session, "ilink/bot/msg/notifystart")
            .await
    }

    async fn notify_session_stop(&self, session: &RelaySession) -> Result<()> {
        self.notify_session(session, "ilink/bot/msg/notifystop")
            .await
    }

    async fn notify_session(&self, session: &RelaySession, route: &str) -> Result<()> {
        let value = self
            .post_wechat_json(
                api_url(&session.base_url, route)?,
                json!({ "base_info": wechat_base_info() }),
                Some(&session.token),
                NOTIFY_TIMEOUT,
            )
            .await?;
        if value_i64(&value, "ret").unwrap_or(0) != 0 {
            return Err(anyhow!("WeChat session notification was rejected"));
        }
        Ok(())
    }

    async fn ack_delivery(
        &self,
        channel_id: &str,
        device_id: &str,
        delivery_id: &str,
        ok: bool,
    ) -> Result<()> {
        let path = format!("/api/me/im-channels/{channel_id}/relay/deliveries/{delivery_id}/ack");
        tokio::time::timeout(
            CLOUD_RELAY_TIMEOUT,
            self.cloud
                .post_authenticated_json(&path, json!({ "deviceId": device_id, "ok": ok })),
        )
        .await
        .map_err(|_| anyhow!("Cloud relay acknowledgement timed out"))??;
        Ok(())
    }

    async fn activate_delivery(
        &self,
        channel_id: &str,
        device_id: &str,
        delivery_id: &str,
    ) -> Result<()> {
        let path =
            format!("/api/me/im-channels/{channel_id}/relay/deliveries/{delivery_id}/activate");
        tokio::time::timeout(
            CLOUD_RELAY_TIMEOUT,
            self.cloud
                .post_authenticated_json(&path, json!({ "deviceId": device_id })),
        )
        .await
        .map_err(|_| anyhow!("Cloud relay activation timed out"))??;
        Ok(())
    }

    async fn promote_delivery_context(
        &self,
        channel_id: &str,
        event_id: &str,
        delivery_id: &str,
    ) -> Result<()> {
        let lock = self.channel_lock(channel_id).await;
        let _guard = lock.lock().await;
        let mut session = self.load_session(channel_id)?;
        if session.delivery_contexts.contains_key(delivery_id) {
            // A Cloud retry may return the same delivery ID after Core already
            // persisted the private reply context. Remove the second staging
            // entry instead of leaking it until the bounded map fills up.
            session.pending_contexts.remove(event_id);
            return self.write_session(&session);
        }
        let context = session
            .pending_contexts
            .remove(event_id)
            .ok_or_else(|| anyhow!("local reply context is missing"))?;
        if session.delivery_contexts.len() >= MAX_DELIVERY_CONTEXTS {
            trim_map(&mut session.delivery_contexts, MAX_DELIVERY_CONTEXTS - 1);
        }
        session
            .delivery_contexts
            .insert(delivery_id.to_string(), context);
        self.write_session(&session)
    }

    async fn remove_pending_context(&self, channel_id: &str, event_id: &str) -> Result<()> {
        let lock = self.channel_lock(channel_id).await;
        let _guard = lock.lock().await;
        let mut session = self.load_session(channel_id)?;
        session.pending_contexts.remove(event_id);
        self.write_session(&session)
    }

    async fn update_sync_cursor(&self, channel_id: &str, cursor: String) -> Result<()> {
        let lock = self.channel_lock(channel_id).await;
        let _guard = lock.lock().await;
        let mut session = self.load_session(channel_id)?;
        session.sync_cursor = cursor;
        self.write_session(&session)
    }

    async fn read_locked_session(&self, channel_id: &str) -> Result<RelaySession> {
        let lock = self.channel_lock(channel_id).await;
        let _guard = lock.lock().await;
        self.load_session(channel_id)
    }

    async fn channel_lock(&self, channel_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.channel_locks.lock().await;
        locks
            .entry(channel_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn set_linked_runtime(&self, session: &RelaySession) {
        let mut runtimes = self.runtime.lock().await;
        let runtime = runtimes.entry(session.channel_id.clone()).or_default();
        runtime.device_id = session.device_id.clone();
        runtime.state = "linked".into();
        runtime.message = "微信 ClawBot 已连接。".into();
        runtime.linked = true;
        runtime.qrcode_url = None;
        runtime.active_login = None;
    }

    async fn set_login_failure(&self, channel_id: &str, message: &str) {
        let mut runtimes = self.runtime.lock().await;
        if let Some(runtime) = runtimes.get_mut(channel_id) {
            runtime.state = "error".into();
            runtime.message = message.into();
            runtime.linked = false;
            runtime.qrcode_url = None;
            runtime.active_login = None;
        }
    }

    async fn set_monitor_message(
        &self,
        channel_id: &str,
        state: &str,
        message: &str,
        linked: bool,
    ) {
        let mut runtimes = self.runtime.lock().await;
        let runtime = runtimes.entry(channel_id.to_string()).or_default();
        runtime.state = state.into();
        runtime.message = message.into();
        runtime.linked = linked;
        runtime.qrcode_url = None;
    }

    async fn finish_monitor(&self, channel_id: &str) {
        if let Some(runtime) = self.runtime.lock().await.get_mut(channel_id) {
            runtime.monitor_running = false;
            runtime.monitor_abort = None;
        }
    }

    async fn post_wechat_json(
        &self,
        url: Url,
        body: Value,
        token: Option<&str>,
        timeout: Duration,
    ) -> Result<Value> {
        let response = tokio::time::timeout(
            timeout,
            self.http
                .post(url)
                .headers(wechat_headers(token)?)
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| anyhow!("WeChat request timed out"))??;
        if !response.status().is_success() {
            return Err(anyhow!("WeChat request was rejected"));
        }
        tokio::time::timeout(Duration::from_secs(10), response.json::<Value>())
            .await
            .map_err(|_| anyhow!("WeChat response timed out"))?
            .map_err(|_| anyhow!("WeChat returned invalid JSON"))
    }

    async fn get_wechat_json(&self, url: Url, timeout: Duration) -> Result<Value> {
        let response = tokio::time::timeout(
            timeout,
            self.http.get(url).headers(wechat_headers(None)?).send(),
        )
        .await
        .map_err(|_| anyhow!("WeChat request timed out"))??;
        if !response.status().is_success() {
            return Err(anyhow!("WeChat request was rejected"));
        }
        tokio::time::timeout(Duration::from_secs(10), response.json::<Value>())
            .await
            .map_err(|_| anyhow!("WeChat response timed out"))?
            .map_err(|_| anyhow!("WeChat returned invalid JSON"))
    }

    fn session_dir(&self) -> PathBuf {
        self.data_dir.join("wechat-clawbot")
    }

    fn session_path(&self, channel_id: &str) -> PathBuf {
        let mut digest = Sha256::new();
        digest.update(channel_id.as_bytes());
        self.session_dir()
            .join(format!("{:x}.json", digest.finalize()))
    }

    fn load_session(&self, channel_id: &str) -> Result<RelaySession> {
        let bytes = fs::read(self.session_path(channel_id))
            .map_err(|_| anyhow!("本机微信连接凭据不可用。"))?;
        let session = serde_json::from_slice::<RelaySession>(&bytes)
            .map_err(|_| anyhow!("本机微信连接凭据损坏。"))?;
        if session.channel_id != channel_id || !session_is_usable(&session) {
            return Err(anyhow!("本机微信连接凭据不匹配。"));
        }
        Ok(session)
    }

    fn write_session(&self, session: &RelaySession) -> Result<()> {
        if !session_is_usable(session) {
            return Err(anyhow!("invalid local WeChat session"));
        }
        let directory = self.session_dir();
        fs::create_dir_all(&directory)?;
        set_private_directory(&directory)?;
        let target = self.session_path(&session.channel_id);
        let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
        let encoded = serde_json::to_vec(session)?;
        fs::write(&temporary, encoded)?;
        set_private_file(&temporary)?;
        if fs::rename(&temporary, &target).is_err() {
            let _ = fs::remove_file(&target);
            fs::rename(&temporary, &target)?;
        }
        set_private_file(&target)?;
        Ok(())
    }

    fn remove_session(&self, channel_id: &str) -> Result<()> {
        let target = self.session_path(channel_id);
        match fs::remove_file(target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(anyhow!("无法删除本机微信连接凭据。")),
        }
    }
}

#[async_trait]
impl CloudDomainEventHandler for WechatClawbotService {
    async fn handle_cloud_domain_event(&self, message: Value) -> Result<(), CloudError> {
        self.handle_delivery_event(message)
            .await
            .map_err(|_| CloudError::Runtime("WeChat ClawBot relay delivery failed".into()))
    }
}

fn wechat_base_info() -> Value {
    json!({ "channel_version": "mia-core", "bot_agent": "Mia/0.1" })
}

fn queue_delivery_reply(session: &mut RelaySession, delivery_id: &str, text: &str) {
    if !session.queued_replies.contains_key(delivery_id)
        && session.queued_replies.len() >= MAX_QUEUED_REPLIES
    {
        trim_reply_map(&mut session.queued_replies, MAX_QUEUED_REPLIES - 1);
    }
    session
        .queued_replies
        .entry(delivery_id.to_string())
        .and_modify(|reply| {
            // A replay must retain the original safe outbound text; Cloud
            // emits a stable delivery ID for the same Bot reply.
            if reply.text.is_empty() {
                reply.text = text.to_string();
            }
        })
        .or_insert_with(|| QueuedReply {
            text: text.to_string(),
            attempts: 0,
            next_attempt_at_ms: 0,
        });
}

fn mark_reply_retry(session: &mut RelaySession, delivery_id: &str) {
    let Some(reply) = session.queued_replies.get_mut(delivery_id) else {
        return;
    };
    reply.attempts = reply.attempts.saturating_add(1);
    // Exponential backoff from 2s to 60s.  The monitor still receives new
    // inbound messages while a prior reply waits for its next retry.
    let exponent = reply.attempts.saturating_sub(1).min(5);
    let delay_ms = 2_000_u64.saturating_mul(1_u64 << exponent).min(60_000);
    reply.next_attempt_at_ms = unix_ms().saturating_add(delay_ms);
}

fn mark_delivery_sent(session: &mut RelaySession, delivery_id: &str) {
    session.delivery_contexts.remove(delivery_id);
    session.queued_replies.remove(delivery_id);
    push_bounded_unique(
        &mut session.sent_delivery_ids,
        delivery_id,
        MAX_SENT_DELIVERIES,
    );
    queue_delivery_ack(session, delivery_id);
}

fn queue_delivery_ack(session: &mut RelaySession, delivery_id: &str) {
    push_bounded_unique(
        &mut session.pending_ack_delivery_ids,
        delivery_id,
        MAX_PENDING_ACKS,
    );
}

fn push_bounded_unique(values: &mut Vec<String>, value: &str, max: usize) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
    if values.len() > max {
        values.drain(0..values.len() - max);
    }
}

fn status_from_runtime(channel_id: &str, runtime: &RelayRuntime) -> WechatClawbotStatusResponse {
    WechatClawbotStatusResponse {
        channel_id: channel_id.into(),
        device_id: runtime.device_id.clone(),
        state: if runtime.state.is_empty() {
            "disconnected".into()
        } else {
            runtime.state.clone()
        },
        message: if runtime.message.is_empty() {
            "尚未连接微信 ClawBot。".into()
        } else {
            runtime.message.clone()
        },
        linked: runtime.linked,
        qr_url: runtime.qrcode_url.clone(),
    }
}

fn clean_identifier(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
    {
        return Err(anyhow!("{label} is invalid"));
    }
    Ok(value.to_string())
}

fn valid_base_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn api_url(base_url: &str, route: &str) -> Result<Url> {
    if !valid_base_url(base_url) {
        return Err(anyhow!("invalid WeChat API base URL"));
    }
    let base = format!("{}/", base_url.trim_end_matches('/'));
    Url::parse(&base)
        .and_then(|url| url.join(route))
        .map_err(|_| anyhow!("invalid WeChat API route"))
}

fn is_safe_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
}

fn wechat_headers(token: Option<&str>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("authorizationtype"),
        HeaderValue::from_static("ilink_bot_token"),
    );
    headers.insert(
        HeaderName::from_static("ilink-app-id"),
        HeaderValue::from_static(WECHAT_APP_ID),
    );
    headers.insert(
        HeaderName::from_static("ilink-app-clientversion"),
        HeaderValue::from_static(WECHAT_CLIENT_VERSION),
    );
    let uin = random_wechat_uin();
    headers.insert(
        HeaderName::from_static("x-wechat-uin"),
        HeaderValue::from_str(&uin).map_err(|_| anyhow!("invalid WeChat request header"))?,
    );
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| anyhow!("invalid WeChat authorization token"))?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    Ok(headers)
}

fn random_wechat_uin() -> String {
    let bytes = Uuid::new_v4().into_bytes();
    let value = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    STANDARD.encode(value.to_string())
}

fn session_is_usable(session: &RelaySession) -> bool {
    session.version == 1
        && clean_identifier(&session.channel_id, "channelId").is_ok()
        && clean_identifier(&session.device_id, "deviceId").is_ok()
        && !session.account_id.trim().is_empty()
        && normalize_wechat_user_id(&session.owner_user_id).is_some()
        && !session.token.trim().is_empty()
        && valid_base_url(&session.base_url)
}

fn normalize_wechat_user_id(value: &str) -> Option<String> {
    let user_id = value.trim();
    (!user_id.is_empty() && user_id.len() <= 512 && !user_id.chars().any(char::is_control))
        .then(|| user_id.to_string())
}

fn is_authorized_sender(session: &RelaySession, sender_id: &str) -> bool {
    normalize_wechat_user_id(sender_id).is_some_and(|sender_id| sender_id == session.owner_user_id)
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn value_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
    })
}

fn text_item(message: &Value) -> Option<String> {
    message
        .get("item_list")?
        .as_array()?
        .iter()
        .find_map(|item| {
            (value_i64(item, "type") == Some(1))
                .then(|| value_string(item.get("text_item").unwrap_or(&Value::Null), "text"))
                .flatten()
                .filter(|value| value.len() <= 12_000)
        })
}

fn inbound_event_id(message: &Value) -> Result<String> {
    for key in ["message_id", "client_id", "seq"] {
        if let Some(value) = message.get(key) {
            let raw = value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|value| value.to_string()));
            if let Some(raw) = raw {
                let digest = Sha256::digest(raw.as_bytes());
                return Ok(format!("wx_{:x}", digest));
            }
        }
    }
    let encoded = serde_json::to_vec(message)?;
    Ok(format!("wx_{:x}", Sha256::digest(encoded)))
}

fn trim_map(map: &mut BTreeMap<String, DeliveryContext>, target_len: usize) {
    while map.len() > target_len {
        let Some(first) = map.keys().next().cloned() else {
            break;
        };
        map.remove(&first);
    }
}

fn trim_reply_map(map: &mut BTreeMap<String, QueuedReply>, target_len: usize) {
    while map.len() > target_len {
        let Some(first) = map.keys().next().cloned() else {
            break;
        };
        map.remove(&first);
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_session_ids_are_hashed_and_not_the_channel_name() {
        let mut digest = Sha256::new();
        digest.update(b"imc_channel_name");
        let file_name = format!("{:x}.json", digest.finalize());
        assert_ne!(file_name, "imc_channel_name.json");
        assert!(file_name.ends_with(".json"));
    }

    #[test]
    fn direct_text_extraction_rejects_non_text_items() {
        assert_eq!(text_item(&json!({ "item_list": [{ "type": 2 }] })), None);
        assert_eq!(
            text_item(&json!({ "item_list": [{ "type": 1, "text_item": { "text": "hi" } }] })),
            Some("hi".into())
        );
    }

    #[test]
    fn queued_reply_survives_retry_and_ack_recovery() {
        let mut session = RelaySession {
            version: 1,
            channel_id: "imc_channel".into(),
            device_id: "device_local".into(),
            account_id: "account".into(),
            owner_user_id: "wx_owner".into(),
            base_url: "https://ilinkai.weixin.qq.com".into(),
            token: "test-token".into(),
            sync_cursor: String::new(),
            delivery_contexts: BTreeMap::from([(
                "imd_reply".into(),
                DeliveryContext {
                    to_user_id: "wx_user".into(),
                    context_token: "reply-context".into(),
                },
            )]),
            pending_contexts: BTreeMap::new(),
            sent_delivery_ids: Vec::new(),
            queued_replies: BTreeMap::new(),
            pending_ack_delivery_ids: Vec::new(),
        };

        queue_delivery_reply(&mut session, "imd_reply", "回复内容");
        mark_reply_retry(&mut session, "imd_reply");
        let restored: RelaySession =
            serde_json::from_slice(&serde_json::to_vec(&session).unwrap()).unwrap();
        assert_eq!(restored.queued_replies["imd_reply"].text, "回复内容");
        assert_eq!(restored.queued_replies["imd_reply"].attempts, 1);
        assert!(restored.queued_replies["imd_reply"].next_attempt_at_ms > 0);

        mark_delivery_sent(&mut session, "imd_reply");
        assert!(!session.delivery_contexts.contains_key("imd_reply"));
        assert!(!session.queued_replies.contains_key("imd_reply"));
        assert_eq!(session.sent_delivery_ids, vec!["imd_reply"]);
        assert_eq!(session.pending_ack_delivery_ids, vec!["imd_reply"]);
    }

    #[test]
    fn only_the_qr_authorizing_wechat_account_is_accepted() {
        let session = RelaySession {
            version: 1,
            channel_id: "imc_channel".into(),
            device_id: "device_local".into(),
            account_id: "account".into(),
            owner_user_id: "wx_owner".into(),
            base_url: "https://ilinkai.weixin.qq.com".into(),
            token: "test-token".into(),
            ..RelaySession::default()
        };
        assert!(session_is_usable(&session));
        assert!(is_authorized_sender(&session, "wx_owner"));
        assert!(!is_authorized_sender(&session, "wx_other"));
    }
}
