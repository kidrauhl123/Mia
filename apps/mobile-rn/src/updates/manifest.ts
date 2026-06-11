export interface AndroidUpdateManifest {
  channel: string;
  versionName: string;
  versionCode: number;
  runtimeVersion: string;
  minSupportedVersionCode: number;
  apkUrl: string;
  apkSha256: string;
  apkSizeBytes: number;
  mandatory: boolean;
  notes: string[];
}

export interface IosUpdateManifest {
  channel: string;
  versionName: string;
  buildNumber: string;
  runtimeVersion: string;
  storeUrl: string;
  testFlightUrl: string;
}

export interface MobileUpdateManifest {
  schemaVersion: 1;
  generatedAt: string;
  android?: AndroidUpdateManifest;
  ios?: IosUpdateManifest;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string, required = true): string {
  const value = source[key];
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new Error(`Invalid ${key}`);
}

function numberField(source: Record<string, unknown>, key: string, positive = true): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function optionalNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
  return value;
}

function notesField(source: Record<string, unknown>): string[] {
  const value = source.notes;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Invalid notes");
  return value;
}

function parseAndroid(value: unknown): AndroidUpdateManifest | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value, "android");
  const apkUrl = stringField(source, "apkUrl");
  const apkSha256 = stringField(source, "apkSha256").toLowerCase();
  if (!apkUrl.startsWith("https://")) throw new Error("Invalid apkUrl");
  if (!SHA256_RE.test(apkSha256)) throw new Error("Invalid apkSha256");
  return {
    channel: stringField(source, "channel", false),
    versionName: stringField(source, "versionName"),
    versionCode: numberField(source, "versionCode"),
    runtimeVersion: stringField(source, "runtimeVersion", false),
    minSupportedVersionCode: optionalNumber(source, "minSupportedVersionCode"),
    apkUrl,
    apkSha256,
    apkSizeBytes: optionalNumber(source, "apkSizeBytes"),
    mandatory: Boolean(source.mandatory),
    notes: notesField(source),
  };
}

function parseIos(value: unknown): IosUpdateManifest | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value, "ios");
  return {
    channel: stringField(source, "channel", false),
    versionName: stringField(source, "versionName"),
    buildNumber: stringField(source, "buildNumber"),
    runtimeVersion: stringField(source, "runtimeVersion", false),
    storeUrl: stringField(source, "storeUrl", false),
    testFlightUrl: stringField(source, "testFlightUrl", false),
  };
}

export function parseMobileUpdateManifest(value: unknown): MobileUpdateManifest {
  const source = asRecord(value, "manifest");
  if (source.schemaVersion !== 1) throw new Error("Invalid schemaVersion");
  return {
    schemaVersion: 1,
    generatedAt: stringField(source, "generatedAt", false),
    android: parseAndroid(source.android),
    ios: parseIos(source.ios),
  };
}
