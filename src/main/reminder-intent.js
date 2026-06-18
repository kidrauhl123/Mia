"use strict";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

const CHINESE_DIGITS = new Map([
  ["零", 0],
  ["〇", 0],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["俩", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9]
]);

function parseChineseInteger(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (CHINESE_DIGITS.has(value)) return CHINESE_DIGITS.get(value);
  if (value === "十") return 10;
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const left = value.slice(0, tenIndex);
    const right = value.slice(tenIndex + 1);
    const tens = left ? CHINESE_DIGITS.get(left) : 1;
    const ones = right ? CHINESE_DIGITS.get(right) : 0;
    if (!Number.isFinite(tens) || !Number.isFinite(ones)) return null;
    return tens * 10 + ones;
  }
  return null;
}

function parseAmount(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === "半") return 0.5;
  return parseChineseInteger(raw);
}

function unitMs(unit) {
  const text = String(unit || "");
  if (/秒/.test(text)) return 1000;
  if (/分钟|分/.test(text)) return 60 * 1000;
  if (/小时|鐘頭|钟头/.test(text)) return 60 * 60 * 1000;
  if (/天|日/.test(text)) return 24 * 60 * 60 * 1000;
  return 0;
}

function cleanReminderContent(text) {
  let content = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  content = content
    .replace(/^(请|麻烦|帮我|帮忙|可以)?\s*(到时候|到点|时间到了)?\s*/u, "")
    .replace(/^(提醒|叫|喊|通知)(我|俺|一下我)?\s*/u, "")
    .replace(/^(我)?\s*(吃|睡|喝|去|做|看|拿|买|发|回|打|给)/u, "$1$2")
    .replace(/[，。！？,.!?；;：:]+$/u, "")
    .trim();
  return content || "该处理提醒了";
}

function shortTitle(content) {
  const text = String(content || "").trim() || "该处理提醒了";
  return text.length > 24 ? `${text.slice(0, 24).trimEnd()}…` : text;
}

function formatDelay(amount, unit) {
  const unitText = /秒/.test(unit)
    ? "秒"
    : (/小时|鐘頭|钟头/.test(unit) ? "小时" : (/天|日/.test(unit) ? "天" : "分钟"));
  return `${Number.isInteger(amount) ? amount : amount.toString()} ${unitText}`;
}

function formatLocalTime(ms, timezone = DEFAULT_TIMEZONE) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function parseRelativeReminderIntent(text, opts = {}) {
  const source = String(text || "").trim();
  if (!source) return null;
  if (!/(提醒|叫我|喊我|通知我|闹钟|鬧鐘|定时|定時)/u.test(source)) return null;

  const match = source.match(/(?<amount>\d+(?:\.\d+)?|半|[零〇一二两俩三四五六七八九十]{1,4})\s*(?<unit>秒钟?|秒|分钟|分鐘|分|个?小时|小時|鐘頭|钟头|天|日)\s*(?:后|後|以后|以後|之后|之後)?/u);
  if (!match?.groups) return null;

  const amount = parseAmount(match.groups.amount);
  const msPerUnit = unitMs(match.groups.unit);
  if (!Number.isFinite(amount) || amount <= 0 || !msPerUnit) return null;
  const delayMs = amount * msPerUnit;
  if (!Number.isFinite(delayMs) || delayMs < 1000 || delayMs > 366 * 24 * 60 * 60 * 1000) return null;

  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const timezone = String(opts.timezone || DEFAULT_TIMEZONE);
  const content = cleanReminderContent(source.replace(match[0], " "));
  const fireAtMs = nowMs + delayMs;
  const delayText = formatDelay(amount, match.groups.unit);
  const localTime = formatLocalTime(fireAtMs, timezone);
  return {
    type: "relative-reminder",
    title: `提醒：${shortTitle(content)}`,
    content,
    prompt: `请在 Mia 会话里提醒用户：${content}`,
    trigger: {
      type: "oneshot",
      at: new Date(fireAtMs).toISOString()
    },
    timezone,
    delayMs,
    delayText,
    localTime
  };
}

function confirmationForReminder(intent = {}) {
  const content = String(intent.content || "该处理提醒了").trim();
  const delayText = String(intent.delayText || "").trim();
  const localTime = String(intent.localTime || "").trim();
  const when = [delayText ? `${delayText}后` : "", localTime ? `（${localTime}）` : ""].join("");
  return `好的，${when || "到时候"}我会提醒你：${content}`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  confirmationForReminder,
  parseRelativeReminderIntent
};
