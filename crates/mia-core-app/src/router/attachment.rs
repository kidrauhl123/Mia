use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use base64::Engine;
use mia_core_api_types::{AttachmentResponse, FetchFileAttachmentRequest, SaveAttachmentRequest};
use serde_json::json;
use uuid::Uuid;

use super::state::ModuleStates;

const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_DATA_URL_CHARS: usize = 35 * 1024 * 1024;

type AttachmentResult = Result<Json<AttachmentResponse>, (StatusCode, Json<serde_json::Value>)>;

pub async fn save_attachment(
    State(states): State<ModuleStates>,
    Json(request): Json<SaveAttachmentRequest>,
) -> AttachmentResult {
    let data = data_url_to_buffer(&request.data_url).map_err(bad_request)?;
    if data.bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(bad_request("附件超过 25MB，暂时不能内嵌保存。"));
    }

    let attachments_dir = states.data_dir.join("attachments");
    tokio::fs::create_dir_all(&attachments_dir)
        .await
        .map_err(internal_error)?;

    let requested_name = request
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("attachment");
    let name = sanitize_attachment_name(requested_name, "attachment");
    let ext = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .filter(|value| !value.is_empty())
        .or_else(|| mime_to_extension(&data.mime).map(str::to_owned))
        .unwrap_or_default();
    let base = Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| sanitize_attachment_name(value, "attachment"))
        .unwrap_or_else(|| "attachment".to_owned());
    let file_name = format!("{}-{}-{}{}", now_millis(), short_uuid(), base, ext);
    let target = attachments_dir.join(file_name);
    tokio::fs::write(&target, &data.bytes)
        .await
        .map_err(internal_error)?;
    let mime = request.mime.unwrap_or_else(|| data.mime.clone());

    Ok(Json(AttachmentResponse {
        id: Uuid::now_v7().to_string(),
        name: name.clone(),
        path: target.to_string_lossy().into_owned(),
        url: request
            .url
            .filter(|url| is_cloud_file_url(url) || is_http_url(url)),
        mime: mime.clone(),
        size: data.bytes.len() as u64,
        kind: attachment_kind(&name, &mime),
        thumbnail_data_url: normalize_attachment_thumbnail(
            request
                .thumbnail_data_url
                .or(request.thumbnail)
                .or(request.preview_data_url)
                .as_deref(),
        ),
        data_url: None,
    }))
}

pub async fn fetch_file_attachment(
    Json(request): Json<FetchFileAttachmentRequest>,
) -> AttachmentResult {
    let raw_path = request
        .path
        .or(request.file_path)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if raw_path.is_empty() {
        return Err(bad_request("File path is required."));
    }
    let file_path = normalize_local_path(&raw_path).map_err(bad_request)?;
    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|_| bad_request("File not found."))?;
    if !metadata.is_file() {
        return Err(bad_request("File not found."));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(bad_request("文件超过 25MB，暂时不能通过手机传回。"));
    }

    let bytes = tokio::fs::read(&file_path).await.map_err(internal_error)?;
    let mime = mime_for_path(&file_path);
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| sanitize_attachment_name(value, "attachment"))
        .unwrap_or_else(|| "attachment".to_owned());
    let kind = attachment_kind(&name, &mime);
    Ok(Json(AttachmentResponse {
        id: request.id.unwrap_or_else(|| Uuid::now_v7().to_string()),
        name,
        path: file_path.to_string_lossy().into_owned(),
        url: None,
        mime: mime.clone(),
        size: metadata.len(),
        kind,
        thumbnail_data_url: if mime.starts_with("image/") {
            Some(data_url.clone())
        } else {
            None
        },
        data_url: Some(data_url),
    }))
}

struct DecodedDataUrl {
    bytes: Vec<u8>,
    mime: String,
}

fn data_url_to_buffer(value: &str) -> Result<DecodedDataUrl, String> {
    let raw = value.trim();
    if raw.is_empty() || raw.len() > MAX_DATA_URL_CHARS {
        return Err("Attachment data is invalid.".to_owned());
    }
    let body_start = raw
        .find(',')
        .ok_or_else(|| "Attachment data is invalid.".to_owned())?;
    let metadata = raw
        .get(5..body_start)
        .filter(|_| raw.starts_with("data:"))
        .ok_or_else(|| "Attachment data is invalid.".to_owned())?;
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return Err("Attachment data is invalid.".to_owned());
    }
    let mime = metadata
        .split(';')
        .next()
        .filter(|part| !part.trim().is_empty())
        .unwrap_or("image/png")
        .to_owned();
    let payload = raw[body_start + 1..].split_whitespace().collect::<String>();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| "Attachment data is invalid.".to_owned())?;
    Ok(DecodedDataUrl { bytes, mime })
}

fn sanitize_attachment_name(value: &str, fallback: &str) -> String {
    let base_name = Path::new(value)
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or(value);
    let sanitized = base_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric()
                || matches!(ch, '_' | '-' | '.' | '(' | ')' | '[' | ']' | ' ')
                || ('\u{4e00}'..='\u{9fff}').contains(&ch)
            {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_owned();
    if sanitized.is_empty() {
        fallback.to_owned()
    } else {
        sanitized
    }
}

fn mime_to_extension(mime: &str) -> Option<&'static str> {
    let mime = mime.to_ascii_lowercase();
    if mime.contains("jpeg") || mime.contains("jpg") {
        Some(".jpg")
    } else if mime.contains("png") {
        Some(".png")
    } else if mime.contains("webp") {
        Some(".webp")
    } else if mime.contains("gif") {
        Some(".gif")
    } else if mime.contains("pdf") {
        Some(".pdf")
    } else if mime.contains("json") {
        Some(".json")
    } else if mime.contains("markdown") {
        Some(".md")
    } else if mime.starts_with("text/") {
        Some(".txt")
    } else {
        None
    }
}

fn attachment_kind(name: &str, mime: &str) -> String {
    let lower_mime = mime.to_ascii_lowercase();
    let ext = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default();
    let kind = if lower_mime.starts_with("image/")
        || matches!(ext.as_str(), ".png" | ".jpg" | ".jpeg" | ".webp" | ".gif")
    {
        "image"
    } else if lower_mime.starts_with("video/") {
        "video"
    } else if lower_mime.starts_with("audio/") {
        "audio"
    } else if lower_mime.contains("pdf") || ext == ".pdf" {
        "pdf"
    } else if lower_mime.starts_with("text/")
        || matches!(
            ext.as_str(),
            ".txt"
                | ".md"
                | ".json"
                | ".csv"
                | ".log"
                | ".js"
                | ".ts"
                | ".tsx"
                | ".jsx"
                | ".py"
                | ".html"
                | ".css"
        )
    {
        "text"
    } else {
        "file"
    };
    kind.to_owned()
}

fn mime_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("md") | Some("markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("tsv") => "text/tab-separated-values",
        Some("log") => "text/plain",
        Some("js") | Some("jsx") => "text/javascript",
        Some("ts") | Some("tsx") => "text/typescript",
        Some("py") => "text/x-python",
        Some("html") => "text/html",
        Some("css") => "text/css",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xlsm") => "application/vnd.ms-excel.sheet.macroenabled.12",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn normalize_attachment_thumbnail(value: Option<&str>) -> Option<String> {
    let raw = value.unwrap_or_default().trim();
    if raw.is_empty() || raw.len() > 700 * 1024 {
        return None;
    }
    let allowed = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/jpg;base64,",
        "data:image/webp;base64,",
    ];
    if allowed
        .iter()
        .any(|prefix| raw.to_ascii_lowercase().starts_with(prefix))
    {
        Some(raw.split_whitespace().collect())
    } else {
        None
    }
}

fn normalize_local_path(raw_path: &str) -> Result<PathBuf, String> {
    if let Some(rest) = raw_path.strip_prefix("file://") {
        Ok(PathBuf::from(percent_decode(rest)))
    } else {
        Ok(PathBuf::from(raw_path))
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_cloud_file_url(value: &str) -> bool {
    let text = value.trim();
    text.starts_with("/api/files/")
        && text["/api/files/".len()..]
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn is_http_url(value: &str) -> bool {
    let text = value.trim();
    text.starts_with("http://") || text.starts_with("https://")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn short_uuid() -> String {
    Uuid::now_v7()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect()
}

fn bad_request(message: impl ToString) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": message.to_string() })),
    )
}

fn internal_error(error: impl ToString) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": error.to_string() })),
    )
}
