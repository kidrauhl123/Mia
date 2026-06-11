export function approvalQueueLabel(count: number): string {
  return count > 1 ? `请求权限 · 1/${count}` : "请求权限";
}

export function approvalDecisionErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error || "").trim();
  return text || "提交失败";
}
