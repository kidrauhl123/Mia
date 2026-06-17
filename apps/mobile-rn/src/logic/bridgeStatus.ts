export type BridgeStatusTone = "online" | "idle" | "running" | "success" | "danger";

const STATUS_LABELS: Record<string, string> = {
  online: "在线",
  connected: "在线",
  open: "在线",
  active: "在线",
  offline: "离线",
  disconnected: "离线",
  closed: "离线",
  unknown: "未知",
  pending: "排队中",
  queued: "排队中",
  running: "运行中",
  in_progress: "运行中",
  started: "运行中",
  completed: "已完成",
  succeeded: "已完成",
  success: "已完成",
  ok: "已完成",
  failed: "失败",
  error: "失败",
  cancelled: "已取消",
  canceled: "已取消",
};

export function bridgeStatusKey(value: unknown): string {
  if (value === true) return "online";
  if (value === false) return "offline";
  return String(value || "unknown").trim().toLowerCase() || "unknown";
}

export function bridgeStatusText(value: unknown): string {
  const key = bridgeStatusKey(value);
  return STATUS_LABELS[key] || String(value || "未知");
}

export function bridgeStatusTone(value: unknown): BridgeStatusTone {
  const key = bridgeStatusKey(value);
  if (["online", "connected", "open", "active"].includes(key)) return "online";
  if (["running", "in_progress", "started"].includes(key)) return "running";
  if (["completed", "succeeded", "success", "ok"].includes(key)) return "success";
  if (["failed", "error"].includes(key)) return "danger";
  return "idle";
}

export function formatBridgeTime(value: string | number | Date | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
