export type MobileScanErrorCode = "invalid" | "expired" | "denied" | "used" | "network";

export function parseMobileScanQr(raw: string): { apiBase: string; grant: string } {
  const url = new URL(String(raw || "").trim());
  if (!/\/mobile-scan$/.test(url.pathname)) throw new Error("invalid");
  const grant = String(url.searchParams.get("grant") || "").trim();
  if (!grant) throw new Error("invalid");
  return {
    apiBase: url.origin,
    grant,
  };
}

export function mobileScanErrorMessage(code: MobileScanErrorCode): string {
  if (code === "expired") return "二维码已过期，请在电脑上刷新";
  if (code === "denied") return "电脑端已取消本次登录";
  if (code === "used") return "这个二维码已经用过了，请重新生成";
  if (code === "network") return "网络异常，请重试";
  return "这不是 Mia 登录码";
}
