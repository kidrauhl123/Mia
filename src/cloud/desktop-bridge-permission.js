const { normalizePermissionMode } = require("../permission-modes.js");
const fs = require("node:fs");
const path = require("node:path");

const dialogAttentionState = new WeakMap();

function appendPermissionDialogAudit(auditFile, event = {}) {
  const file = String(auditFile || "").trim();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      ...event
    }) + "\n", { mode: 0o600 });
  } catch {
    // Permission confirmation must not fail just because optional audit logging failed.
  }
}

function cloudBridgeRunDialogOptions(message = {}) {
  const prompt = String(message.text || "").trim();
  const preview = prompt.length > 600 ? `${prompt.slice(0, 600)}...` : prompt;
  const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  const detail = [
    "来源：Mia Cloud",
    `会话：${String(message.conversationId || "default")}`,
    attachmentCount ? `附件：${attachmentCount} 个` : "",
    preview ? `\n请求内容：\n${preview}` : ""
  ].filter(Boolean).join("\n");
  return {
    type: "question",
    title: "允许远程运行本机 Agent？",
    message: "Mia Cloud 请求使用这台电脑的本机 Agent。",
    detail,
    buttons: ["允许本次运行", "拒绝"],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
}

function cloudBridgeRunNotificationOptions(message = {}) {
  const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  const conversationId = String(message.conversationId || "default");
  return {
    title: "Mia Cloud 请求本机 Agent",
    body: [
      `会话：${conversationId}`,
      attachmentCount ? `附件：${attachmentCount} 个` : "",
      "请回到 Mia，在权限弹窗中选择允许或拒绝。"
    ].filter(Boolean).join("\n"),
    silent: false
  };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cloudBridgeRunPromptHtml(options = {}) {
  const buttons = Array.isArray(options.buttons) && options.buttons.length
    ? options.buttons
    : ["允许本次运行", "拒绝"];
  const allowLabel = buttons[0] || "允许本次运行";
  const rejectLabel = buttons[1] || "拒绝";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
  <title>${escapeHtml(options.title || "允许远程运行本机 Agent？")}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: stretch; background: Canvas; color: CanvasText; }
    main { box-sizing: border-box; width: 100%; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
    h1 { margin: 0; font-size: 20px; line-height: 1.35; font-weight: 700; letter-spacing: 0; }
    p { margin: 0; font-size: 14px; line-height: 1.55; color: color-mix(in srgb, CanvasText 82%, transparent); }
    pre { flex: 1; min-height: 120px; max-height: 210px; margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; background: color-mix(in srgb, CanvasText 5%, Canvas); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; }
    button { min-width: 112px; height: 36px; padding: 0 16px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; font: inherit; background: ButtonFace; color: ButtonText; }
    button.primary { background: #2f63d6; color: white; border-color: #2f63d6; }
    button:focus-visible { outline: 3px solid color-mix(in srgb, #2f63d6 45%, transparent); outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(options.title || "允许远程运行本机 Agent？")}</h1>
    <p>${escapeHtml(options.message || "Mia Cloud 请求使用这台电脑的本机 Agent。")}</p>
    <pre>${escapeHtml(options.detail || "")}</pre>
    <div class="actions">
      <button data-response="0">${escapeHtml(allowLabel)}</button>
      <button class="primary" data-response="1" autofocus>${escapeHtml(rejectLabel)}</button>
    </div>
  </main>
  <script>
    for (const button of document.querySelectorAll("button[data-response]")) {
      button.addEventListener("click", () => {
        window.location.href = "mia-permission://response/" + encodeURIComponent(button.dataset.response);
      });
    }
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") window.location.href = "mia-permission://response/1";
    });
  </script>
</body>
</html>`;
}

function focusPermissionDialogWindow({
  getFocusedWindow,
  getAllWindows,
  focusApp,
  requestUserAttention,
  cancelUserAttention
} = {}) {
  const isUsableWindow = (win) => win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
  const focused = typeof getFocusedWindow === "function" ? getFocusedWindow() : null;
  const windows = typeof getAllWindows === "function" ? getAllWindows() : [];
  const target = isUsableWindow(focused)
    ? focused
    : (Array.isArray(windows) ? windows.find(isUsableWindow) : null);
  if (!target) return null;
  if (typeof target.isMinimized === "function" && target.isMinimized() && typeof target.restore === "function") {
    target.restore();
  }
  if (typeof target.show === "function") target.show();
  if (typeof focusApp === "function") focusApp();
  if (typeof target.focus === "function") target.focus();
  holdPermissionDialogWindowAttention(target, { requestUserAttention, cancelUserAttention });
  return target;
}

function holdPermissionDialogWindowAttention(target, { requestUserAttention, cancelUserAttention } = {}) {
  if (!target || typeof target.setAlwaysOnTop !== "function") return false;
  if (dialogAttentionState.has(target)) return true;
  const wasAlwaysOnTop = typeof target.isAlwaysOnTop === "function" ? target.isAlwaysOnTop() : false;
  let attentionRequestId = null;
  if (typeof requestUserAttention === "function") {
    attentionRequestId = requestUserAttention();
  }
  dialogAttentionState.set(target, { wasAlwaysOnTop, attentionRequestId, cancelUserAttention });
  if (!wasAlwaysOnTop) target.setAlwaysOnTop(true, "modal-panel");
  if (typeof target.moveTop === "function") target.moveTop();
  if (typeof target.flashFrame === "function") target.flashFrame(true);
  return true;
}

function releasePermissionDialogWindowAttention(target) {
  if (!target || typeof target.setAlwaysOnTop !== "function") return false;
  const state = dialogAttentionState.get(target);
  if (!state) return false;
  dialogAttentionState.delete(target);
  if (typeof target.flashFrame === "function") target.flashFrame(false);
  if (!state.wasAlwaysOnTop) target.setAlwaysOnTop(false);
  if (state.attentionRequestId !== null && typeof state.cancelUserAttention === "function") {
    state.cancelUserAttention(state.attentionRequestId);
  }
  return true;
}

async function confirmCloudBridgeRunPermission({ mode = "ask", message = {}, showMessageBox, auditFile = "" }) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "yolo") return true;
  if (normalized === "deny") throw new Error("本机权限模式为 Deny，已拒绝远程 Agent 运行。");
  if (typeof showMessageBox !== "function") throw new Error("缺少远程运行权限确认 UI。");
  const options = cloudBridgeRunDialogOptions(message);
  appendPermissionDialogAudit(auditFile, { event: "show", mode: normalized, options });
  const result = await showMessageBox(options);
  appendPermissionDialogAudit(auditFile, { event: "result", mode: normalized, response: result?.response });
  if (result?.response !== 0) throw new Error("本机已拒绝远程 Agent 运行。");
  return true;
}

module.exports = {
  appendPermissionDialogAudit,
  cloudBridgeRunDialogOptions,
  cloudBridgeRunNotificationOptions,
  cloudBridgeRunPromptHtml,
  confirmCloudBridgeRunPermission,
  escapeHtml,
  focusPermissionDialogWindow,
  holdPermissionDialogWindowAttention,
  releasePermissionDialogWindowAttention
};
