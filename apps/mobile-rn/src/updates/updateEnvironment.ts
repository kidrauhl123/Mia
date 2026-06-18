export function shouldDisableProductionUpdateChecks(applicationId: string, appVariant = ""): boolean {
  const normalizedId = String(applicationId || "");
  return appVariant === "development" || normalizedId === "app.mia.mobile.dev" || normalizedId.endsWith(".dev");
}
