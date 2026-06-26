// 设计系统:对齐桌面端 / web(src/renderer/styles.css :root)。
// 柔和浅色 Apple 风:系统字体、靛蓝强调色、浅灰/靛蓝气泡、圆形头像、柔和阴影。

export const color = {
  bg: "#FFFFFF", // 列表/设置等白底
  chatBg: "#F0F0F3", // 聊天区背景(--chat-background)
  surface: "#FFFFFF",
  surfaceSoft: "rgba(255,255,255,0.86)", // --surface-soft
  surfaceMuted: "#F5F5F8", // --surface-muted
  field: "rgba(0,0,0,0.06)", // --field
  ink: "rgba(0,0,0,0.92)", // --text
  inkMuted: "rgba(0,0,0,0.60)", // --muted
  inkFaint: "rgba(0,0,0,0.36)", // --faint
  floorFaint: "rgba(0,0,0,0.48)", // --floor-faint
  line: "rgba(0,0,0,0.08)", // --line
  lineStrong: "rgba(0,0,0,0.14)", // --line-strong
  accent: "#5E5CE6", // --accent
  accentSoft: "rgba(94,92,230,0.16)", // --active
  accentText: "#FFFFFF",
  accent2: "#30D158", // --accent-2
  bubbleOther: "rgba(0,0,0,0.055)", // 对方气泡浅灰
  userBubble: "#EEFFDE", // --user-bubble, Electron 桌面默认
  userBubbleText: "rgba(0,0,0,0.90)",
  danger: "#D14343",
  warn: "#9A5A00",
  warnBg: "#FFF6DF",
  codeBg: "#22242D",
  codeText: "#EEF0F6",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 14, bubble: 18, pill: 999 };
export const hairlineWidth = 1;

// 柔和阴影(--shadow)。RN 用对象形式。
export const shadow = {
  shadowColor: "#141828",
  shadowOpacity: 0.08,
  shadowRadius: 17,
  shadowOffset: { width: 0, height: 14 },
  elevation: 4,
};

export const TELEGRAM_DEFAULT_FONT_SIZE = 16;
export const TELEGRAM_FONT_SIZE_OPTIONS = [
  { label: "小", value: 14 },
  { label: "标准", value: 16 },
  { label: "大", value: 18 },
] as const;

export type TelegramFontSize = typeof TELEGRAM_FONT_SIZE_OPTIONS[number]["value"];

export function normalizeTelegramFontSize(value: unknown): TelegramFontSize {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return TELEGRAM_DEFAULT_FONT_SIZE;
  return TELEGRAM_FONT_SIZE_OPTIONS.reduce<TelegramFontSize>((best, option) => (
    Math.abs(option.value - parsed) < Math.abs(best - parsed) ? option.value : best
  ), TELEGRAM_DEFAULT_FONT_SIZE);
}

function lineHeight(size: number, ratio = 1.32): number {
  return Math.round(size * ratio);
}

export function createTelegramTypography(value: unknown = TELEGRAM_DEFAULT_FONT_SIZE) {
  const chatBase = normalizeTelegramFontSize(value);
  const chatSmall = Math.round((2 * chatBase + 10) / 3);
  const chatAction = Math.max(16, chatBase) - 2;
  const code = Math.max(10, Math.min(chatBase - 1, chatBase - 2));

  return {
    fontSize: chatBase,
    type: {
      brand: { fontSize: 20, lineHeight: 24, fontWeight: "500" as const, color: color.ink },
      title: { fontSize: 20, lineHeight: 24, fontWeight: "500" as const, color: color.ink },
      body: { fontSize: 16, lineHeight: 22, fontWeight: "400" as const, color: color.ink },
      bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: "400" as const, color: color.ink },
      sub: { fontSize: 14, lineHeight: 19, fontWeight: "400" as const, color: color.inkMuted },
      label: { fontSize: 13, lineHeight: 17, fontWeight: "400" as const, color: color.inkMuted },
      caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const, color: color.inkFaint },
      button: { fontSize: 15, lineHeight: 19, fontWeight: "500" as const },
      input: { fontSize: 17, lineHeight: 22, fontWeight: "400" as const, color: color.ink },
      composerInput: { fontSize: 18, lineHeight: 24, fontWeight: "400" as const, color: color.ink },
      action: { fontSize: 15, lineHeight: 19, fontWeight: "500" as const },
      nav: { fontSize: 11, lineHeight: 14, fontWeight: "500" as const },
      chatMessage: { fontSize: chatBase, lineHeight: lineHeight(chatBase), fontWeight: "400" as const },
      code: { fontFamily: "monospace" as const, fontSize: code, lineHeight: lineHeight(code, 1.25), fontWeight: "400" as const },
      messageName: { fontSize: chatSmall, lineHeight: lineHeight(chatSmall, 1.25), fontWeight: "500" as const },
      messageReplyText: { fontSize: chatSmall, lineHeight: lineHeight(chatSmall, 1.25), fontWeight: "400" as const },
      messageMeta: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const },
      system: { fontSize: chatAction, lineHeight: lineHeight(chatAction, 1.3), fontWeight: "400" as const },
      listTitle: { fontSize: 16, lineHeight: 20, fontWeight: "500" as const },
      listSubtitle: { fontSize: 15, lineHeight: 19, fontWeight: "400" as const },
      listTime: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const },
      listTag: { fontSize: 10, lineHeight: 13, fontWeight: "500" as const },
      search: { fontSize: 18, lineHeight: 32, fontWeight: "400" as const },
      badge: { fontSize: 13, lineHeight: 18, fontWeight: "500" as const },
      settingHeader: { fontSize: 15, lineHeight: 20, fontWeight: "500" as const, color: color.inkMuted },
      settingTitle: { fontSize: 16, lineHeight: 22, fontWeight: "400" as const, color: color.ink },
      settingDetail: { fontSize: 13, lineHeight: 17, fontWeight: "400" as const, color: color.inkMuted },
      info: { fontSize: 14, lineHeight: 19, fontWeight: "400" as const, color: color.inkMuted },
      attachmentTitle: { fontSize: 15, lineHeight: 19, fontWeight: "500" as const, color: color.ink },
      attachmentSubtitle: { fontSize: 13, lineHeight: 17, fontWeight: "400" as const, color: color.inkMuted },
      avatarInitial: { fontSize: 18, lineHeight: 22, fontWeight: "500" as const, color: "#fff" },
    },
  };
}

// 字体:对齐 Telegram 手机端的系统字体策略。中文依赖系统中文字体
// (iOS PingFang SC, Android Noto Sans CJK/设备系统字体),不硬绑英文字体。
// 默认聊天字号 16; 字号设置只影响 TG 里会跟随设置的聊天文本,普通 UI 使用 TG 固定默认值。
export const type = createTelegramTypography().type;

// 向后兼容旧 theme.* 键
export const theme = {
  bg: color.bg,
  card: color.surface,
  accent: color.accent,
  line: color.line,
  muted: color.inkMuted,
  danger: color.danger,
  warn: color.warn,
  warnBg: color.warnBg,
  text: color.ink,
};
