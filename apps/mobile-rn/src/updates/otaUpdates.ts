declare const require: any;

function updatesModule() {
  return require("expo-updates");
}

export async function checkForOtaUpdate(): Promise<boolean> {
  const Updates = updatesModule();
  if (!Updates.isEnabled) return false;
  const result = await Updates.checkForUpdateAsync();
  return Boolean(result.isAvailable);
}

export async function fetchOtaUpdate(): Promise<void> {
  await updatesModule().fetchUpdateAsync();
}

export async function reloadIntoOtaUpdate(): Promise<void> {
  await updatesModule().reloadAsync();
}
